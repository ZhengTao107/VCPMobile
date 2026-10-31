<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AppSettings } from "../../../core/stores/settings";
import { useSettingsStore } from "../../../core/stores/settings";
import { isAndroid } from "../../../core/utils/platform";
import SettingsActionWithStatus from "../../../components/settings/SettingsActionWithStatus.vue";
import SettingsActionButton from "../../../components/settings/SettingsActionButton.vue";
import VcpConfirm from "../../../components/ui/VcpConfirm.vue";
import {
  exportConfigBackup,
  readConfigBackupFile,
  type ParsedConfigBackup,
} from "../useConfigBackup";
import {
  buildConfigString,
  maskPreview,
  parseConfigString,
  toSettingsPatch,
  type ImportedConfig,
} from "../../../core/config/configImport";

const props = defineProps<{
  settings: AppSettings;
}>();

const emit = defineEmits<{
  (e: "save-request"): void;
  (e: "config-imported"): void;
}>();

type Status = { type: "success" | "error" | "loading" | null; message: string };

const exportStatus = ref<Status>({ type: null, message: "" });
const importStatus = ref<Status>({ type: null, message: "" });

const settingsStore = useSettingsStore();

// ------------------------------------------------------------------
// 导出
// ------------------------------------------------------------------
const onExport = async () => {
  // 先把页面上未保存的修改落盘，保证导出内容与用户所见一致
  emit("save-request");

  exportStatus.value = { type: "loading", message: "正在生成备份文件..." };
  try {
    const result = await exportConfigBackup(props.settings);
    exportStatus.value = {
      type: "success",
      message: `已导出到 下载/VCPMobile/${result.displayName}\n文件包含明文密钥，请妥善保管`,
    };
  } catch (e: any) {
    exportStatus.value = { type: "error", message: `导出失败: ${e}` };
  }
};

// ------------------------------------------------------------------
// 导入
// ------------------------------------------------------------------
const fileInput = ref<HTMLInputElement | null>(null);
const pendingImport = ref<ParsedConfigBackup | null>(null);
const showImportConfirm = ref(false);
const importing = ref(false);

const triggerImport = () => {
  fileInput.value?.click();
};

const onFileChange = async (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 允许重复选择同一文件
  if (!file) return;

  importStatus.value = { type: "loading", message: "正在解析备份文件..." };
  try {
    pendingImport.value = await readConfigBackupFile(file);
    showImportConfirm.value = true;
    importStatus.value = { type: null, message: "" };
  } catch (e: any) {
    importStatus.value = { type: "error", message: `导入失败: ${e?.message ?? e}` };
  }
};

const confirmImport = async () => {
  const backup = pendingImport.value;
  pendingImport.value = null;
  if (!backup) return;

  importing.value = true;
  importStatus.value = { type: "loading", message: "正在应用配置..." };
  try {
    await settingsStore.updateSettings(backup.settings);
    emit("config-imported");
    importStatus.value = { type: "success", message: "配置导入成功" };
  } catch (e: any) {
    importStatus.value = { type: "error", message: `导入失败: ${e}` };
  } finally {
    importing.value = false;
  }
};

// ------------------------------------------------------------------
// 配置串（vcpm1:）导入：粘贴 → 解析 → 脱敏预览 → 应用
// 预览就地展开而非二次弹窗：useModalHistory 关闭时异步 history.back()，
// 紧接着再开弹窗会与之竞态。
// ------------------------------------------------------------------
const pasteOpen = ref(false);
const pasteText = ref("");
const pendingString = ref<ImportedConfig | null>(null);
const applyingString = ref(false);
const stringStatus = ref<Status>({ type: null, message: "" });
const preview = computed(() => (pendingString.value ? maskPreview(pendingString.value) : []));

// 文本变动后旧预览失效，必须重新解析
watch(pasteText, () => {
  pendingString.value = null;
});

const resetPaste = () => {
  pasteText.value = "";
  pendingString.value = null;
};

const togglePaste = () => {
  pasteOpen.value = !pasteOpen.value;
  stringStatus.value = { type: null, message: "" };
  if (!pasteOpen.value) resetPaste();
};

const previewString = () => {
  const result = parseConfigString(pasteText.value);
  if (!result.ok) {
    pendingString.value = null;
    stringStatus.value = { type: "error", message: result.error };
    return;
  }
  pendingString.value = result.config;
  stringStatus.value = { type: null, message: "" };
};

const applyString = async () => {
  const config = pendingString.value;
  if (!config) return;
  const patch = toSettingsPatch(config);
  applyingString.value = true;
  stringStatus.value = { type: "loading", message: "正在应用配置..." };
  try {
    await settingsStore.updateSettings(patch);
    emit("config-imported");
    stringStatus.value = {
      type: "success",
      message: `已导入 ${Object.keys(patch).length} 项连接配置`,
    };
    pasteOpen.value = false;
    resetPaste();
  } catch (e: any) {
    stringStatus.value = { type: "error", message: `导入失败: ${e}` };
  } finally {
    applyingString.value = false;
  }
};

// ------------------------------------------------------------------
// 复制当前配置串（基于页面所见的草稿值）
// ------------------------------------------------------------------
const copyStatus = ref<Status | { type: "info"; message: string }>({ type: null, message: "" });
const copyFallbackText = ref("");

const copyConfigString = async () => {
  copyFallbackText.value = "";
  const text = buildConfigString(props.settings);
  // 用解析器自检：当前设置为空或协议非法时不导出坏串
  const check = parseConfigString(text);
  if (!check.ok) {
    copyStatus.value = { type: "error", message: `无法生成配置串：${check.error}` };
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    copyStatus.value = {
      type: "success",
      message: "已复制到剪贴板\n配置串包含明文密钥，只发给信任的设备",
    };
  } catch {
    copyFallbackText.value = text;
    copyStatus.value = { type: "info", message: "无法写入剪贴板，请长按下方文本手动复制" };
  }
};

const selectAll = (e: Event) => {
  (e.target as HTMLTextAreaElement).select();
};
</script>

<template>
  <div class="space-y-5 px-1">
    <SettingsActionWithStatus
      v-if="isAndroid"
      title="导出配置"
      description="用户身份与应用连接配置，保存到系统下载目录"
      button-variant="primary"
      button-label="导出"
      :button-loading="exportStatus.type === 'loading'"
      :status-type="exportStatus.type"
      :status-message="exportStatus.message"
      status-multiline
      @action-click="onExport"
    />

    <div v-if="isAndroid" class="border-t border-black/5 dark:border-white/5 pt-2"></div>

    <SettingsActionWithStatus
      title="导入配置"
      description="从 .vcpcfg 备份文件一键恢复全部连接配置"
      button-variant="secondary"
      button-label="导入"
      :button-loading="importStatus.type === 'loading' || importing"
      :status-type="importStatus.type"
      :status-message="importStatus.message"
      status-multiline
      @action-click="triggerImport"
    />

    <p class="text-[10px] opacity-40 px-1 italic">
      * 备份文件为明文 JSON（.vcpcfg 后缀），包含 API Key 与密码，请勿分享给他人
    </p>

    <div class="border-t border-black/5 dark:border-white/5 pt-2"></div>

    <SettingsActionWithStatus
      title="粘贴配置串"
      description="粘贴 vcpm1: 开头的配置串，仅覆盖其中包含的连接项"
      button-variant="secondary"
      :button-label="pasteOpen ? '收起' : '粘贴'"
      :button-loading="applyingString"
      :status-type="stringStatus.type"
      :status-message="stringStatus.message"
      status-multiline
      @action-click="togglePaste"
    />

    <div v-if="pasteOpen" class="space-y-3 px-1">
      <textarea
        v-model="pasteText"
        rows="3"
        placeholder="vcpm1:..."
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        class="w-full bg-black/5 dark:bg-black/20 text-primary-text px-3 py-2.5 rounded-xl border border-black/10 dark:border-white/10 outline-none focus:border-blue-500/50 font-mono text-[11px] break-all resize-none"
      ></textarea>

      <template v-if="pendingString">
        <ul class="space-y-1.5 text-[11px]">
          <li v-if="pendingString.label" class="flex justify-between gap-3">
            <span class="opacity-50 shrink-0">来源</span>
            <span class="break-all text-right">{{ pendingString.label }}</span>
          </li>
          <li v-for="item in preview" :key="item.field" class="flex justify-between gap-3">
            <span class="opacity-50 shrink-0">{{ item.label }}</span>
            <span class="font-mono break-all text-right">{{ item.value }}</span>
          </li>
        </ul>
        <div class="flex justify-end gap-2">
          <SettingsActionButton variant="ghost" size="sm" @click="resetPaste">取消</SettingsActionButton>
          <SettingsActionButton
            variant="primary"
            size="sm"
            :loading="applyingString"
            @click="applyString"
          >
            应用
          </SettingsActionButton>
        </div>
      </template>
      <div v-else class="flex justify-end">
        <SettingsActionButton
          variant="primary"
          size="sm"
          :disabled="!pasteText.trim()"
          @click="previewString"
        >
          解析
        </SettingsActionButton>
      </div>
    </div>

    <SettingsActionWithStatus
      title="复制当前配置串"
      description="把服务器与同步连接打包成一行，发给其他设备导入"
      button-variant="secondary"
      button-label="复制"
      :status-type="copyStatus.type"
      :status-message="copyStatus.message"
      status-multiline
      @action-click="copyConfigString"
    />

    <textarea
      v-if="copyFallbackText"
      :value="copyFallbackText"
      readonly
      rows="3"
      class="w-full bg-black/5 dark:bg-black/20 text-primary-text px-3 py-2.5 rounded-xl border border-black/10 dark:border-white/10 outline-none font-mono text-[11px] break-all resize-none"
      @focus="selectAll"
    ></textarea>

    <input
      type="file"
      ref="fileInput"
      class="hidden"
      accept=".vcpcfg,application/json"
      @change="onFileChange"
    />
  </div>

  <VcpConfirm
    v-model:is-open="showImportConfirm"
    title="导入配置备份"
    :message="`将覆盖「用户身份」与「应用连接」的现有配置。\n\n备份导出时间：${pendingImport?.exportedAt || '未知'}\n\n确定继续吗？`"
    is-danger
    @confirm="confirmImport"
  />
</template>
