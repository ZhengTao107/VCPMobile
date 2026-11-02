<script setup lang="ts">
import { computed, ref, onUnmounted, watch } from "vue";
import type { SettingsSaveResult } from "../editing/useSettingsEditSession";
import { isIOS } from "../../../core/utils/platform";
import { cancelFileOperation } from "../../../core/utils/nativeFilePicker";
import { useSettingsStore } from "../../../core/stores/settings";
import SettingsActionWithStatus from "../../../components/settings/SettingsActionWithStatus.vue";
import SettingsActionButton from "../../../components/settings/SettingsActionButton.vue";
import VcpConfirm from "../../../components/ui/VcpConfirm.vue";
import { vGuide } from "../../guide/directives/vGuide";
import {
  exportConfigBackup,
  captureBackupDomains,
  captureBackupGroupPreferences,
  captureBackupAgentPreferences,
  captureBackupStandaloneData,
  pickConfigBackup,
  configBackupScopes,
  type BackupImportResult,
  type ParsedConfigBackup,
} from "../useConfigBackup";
import {
  buildConfigString,
  connectionSettingsView,
  maskPreview,
  parseConfigString,
  toSettingsPatch,
  type ImportedConfig,
} from "../../../core/config/configImport";

const props = defineProps<{
  active: boolean;
  disabled?: boolean;
  commit: () => Promise<SettingsSaveResult>;
  applyImport: (backup: ParsedConfigBackup) => Promise<BackupImportResult>;
}>();

// fork ptp4g#7/#16：vcpm1 配置串直接读写设置 store。
const settingsStore = useSettingsStore();

type Status = { type: "success" | "error" | "loading" | "info" | null; message: string };

const exportStatus = ref<Status>({ type: null, message: "" });
const importStatus = ref<Status>({ type: null, message: "" });

let disposed = false;
const importOperationId = ref<string | null>(null);
let exportOperationId: string | null = null;

// ------------------------------------------------------------------
// 导出
// ------------------------------------------------------------------
const onExport = async () => {
  if (disposed || !props.active || props.disabled || importOperationId.value || importing.value || showImportConfirm.value || exportStatus.value.type === "loading") return;
  exportStatus.value = { type: "loading", message: "正在生成备份文件..." };
  try {
    const saved = await props.commit();
    if (disposed || !props.active) return;
    if (!saved.ok) throw new Error(saved.error);
    const [domains, groupPreferences, agentPreferences, standaloneData] = await Promise.all([
      captureBackupDomains(),
      captureBackupGroupPreferences(),
      captureBackupAgentPreferences(),
      captureBackupStandaloneData(),
    ]);
    if (disposed || !props.active) return;
    exportOperationId = `config_export_${crypto.randomUUID()}`;
    const result = await exportConfigBackup(domains, exportOperationId, groupPreferences, agentPreferences, standaloneData);
    if (disposed || !props.active) return;
    exportStatus.value = {
      type: "success",
      message: `${isIOS ? '已保存到配置备份目录' : '已导出到 下载/VCPMobile'}：${result.displayName}\n文件包含明文密钥，请妥善保管`,
    };
  } catch (e: any) {
    if (disposed) return;
    if (String(e).toLowerCase().includes("cancel")) {
      exportStatus.value = { type: null, message: "" };
      return;
    }
    exportStatus.value = { type: "error", message: `导出失败: ${e}` };
  } finally {
    exportOperationId = null;
  }
};

// ------------------------------------------------------------------
// 导入
// ------------------------------------------------------------------
const pendingImport = ref<ParsedConfigBackup | null>(null);
const showImportConfirm = ref(false);
const importing = ref(false);
const importConfirmation = computed(() => {
  const backup = pendingImport.value;
  if (!backup) return '';
  return `将覆盖备份中包含的配置：${configBackupScopes(backup).join('、')}。未包含的设置保持当前值。`
    + `\n\n备份导出时间：${backup.exportedAt || '未知'}\n\n确定继续吗？`;
});

const triggerImport = async () => {
  if (disposed || !props.active || props.disabled || exportStatus.value.type === "loading" || importOperationId.value || importing.value || showImportConfirm.value) return;
  const operationId = `config_${crypto.randomUUID()}`;
  importOperationId.value = operationId;
  importStatus.value = { type: "loading", message: "正在选取并解析备份文件..." };
  try {
    const parsed = await pickConfigBackup(operationId);
    if (disposed || importOperationId.value !== operationId) return;
    if (!configBackupScopes(parsed).length) throw new Error('备份未包含可恢复的配置');
    pendingImport.value = parsed;
    showImportConfirm.value = true;
    importStatus.value = { type: null, message: "" };
  } catch (e: any) {
    if (disposed || importOperationId.value !== operationId) return;
    if (String(e).toLowerCase().includes("cancel")) {
      importStatus.value = { type: null, message: "" };
      return;
    }
    importStatus.value = { type: "error", message: `导入失败: ${e?.message ?? e}` };
  } finally {
    if (importOperationId.value === operationId) importOperationId.value = null;
  }
};

watch(showImportConfirm, (open) => {
  if (!open) pendingImport.value = null;
});

const deactivate = () => {
  disposed = true;
  showImportConfirm.value = false;
  pendingImport.value = null;
  if (exportOperationId) {
    const operationId = exportOperationId;
    exportOperationId = null;
    void cancelFileOperation(operationId).catch(console.warn);
  }
  if (importOperationId.value) {
    const operationId = importOperationId.value;
    importOperationId.value = null;
    void cancelFileOperation(operationId).catch(console.warn);
  }
};
watch(() => props.active, (active) => { if (!active) deactivate(); }, { flush: 'sync' });
onUnmounted(deactivate);

const confirmImport = async () => {
  if (disposed || !props.active || props.disabled || importing.value) return;
  const backup = pendingImport.value;
  pendingImport.value = null;
  showImportConfirm.value = false;
  if (!backup) return;

  importing.value = true;
  importStatus.value = { type: "loading", message: "正在应用配置..." };
  try {
    const result = await props.applyImport(backup);
    if (disposed || !props.active) return;
    const summary = result.failed.length
      ? (result.applied.length ? '配置部分导入，部分项目保存失败' : '配置导入未完成')
      : result.skipped.length ? '配置导入完成，部分项目已跳过' : '配置导入成功';
    importStatus.value = {
      type: result.failed.length ? 'error' : result.skipped.length ? 'info' : 'success',
      message: [
        summary,
        ...(result.applied.length ? [`已恢复：${result.applied.join('、')}`] : []),
        ...result.skipped.map(message => `已跳过：${message}`),
        ...result.failed.map(failure => `未恢复：${failure.scope}：${failure.message}`),
      ].join('\n'),
    };
  } catch (e: any) {
    if (disposed || !props.active) return;
    importStatus.value = { type: "error", message: `导入失败: ${e}` };
  } finally {
    if (!disposed) importing.value = false;
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
    const result = await settingsStore.updateFields(patch);
    if (result.status === "rejected") throw new Error(result.issues.map(issue => issue.message).join("；"));
    if (result.status === "conflict") throw new Error("配置已被其他操作修改，请重试");
    stringStatus.value = {
      type: "success",
      message: `已导入 ${Object.keys(patch).length} 项连接配置`,
    };
    pasteOpen.value = false;
    resetPaste();
  } catch (e: any) {
    stringStatus.value = { type: "error", message: `导入失败: ${e?.message ?? e}` };
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
  const current = settingsStore.settings;
  if (!current) {
    copyStatus.value = { type: "error", message: "设置尚未加载" };
    return;
  }
  const text = buildConfigString(connectionSettingsView(current));
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
  <div v-guide="'settings-config-backup-section'" class="space-y-5 px-1">
    <SettingsActionWithStatus
      title="导出配置"
      description="备份身份、连接、语音、JEV、助手与群聊设置、主题与聊天偏好"
      button-variant="primary"
      button-label="导出"
      :button-loading="exportStatus.type === 'loading'"
      :button-disabled="disabled || !!importOperationId || importing || showImportConfirm"
      :status-type="exportStatus.type"
      :status-message="exportStatus.message"
      status-multiline
      @action-click="onExport"
    />

    <p v-if="isIOS" class="text-xs text-[var(--secondary-text)] px-1 leading-relaxed">
      首次导出时选择保存目录；后续导入与导出会优先使用该位置。
    </p>

    <div class="border-t border-black/5 dark:border-white/5 pt-2"></div>

    <SettingsActionWithStatus
      v-guide="'settings-config-import-action'"
      title="导入配置"
      description="恢复 .vcpcfg.json 配置备份，未包含的选项保持当前值"
      button-variant="secondary"
      button-label="导入"
      :button-loading="importStatus.type === 'loading' || importing"
      :button-disabled="disabled || exportStatus.type === 'loading'"
      :status-type="importStatus.type"
      :status-message="importStatus.message"
      status-multiline
      @action-click="triggerImport"
    />

    <p class="text-[10px] opacity-40 px-1 italic">
      * 备份文件为明文 JSON，包含 API Key 与密码，请勿分享给他人
    </p>
    <p class="text-xs text-[var(--secondary-text)] px-1 leading-relaxed">
      复刻音频文件不包含在备份中；更换设备后需重新导入参考音频。
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
    v-if="active"
    v-model:is-open="showImportConfirm"
    title="导入配置备份"
    :message="importConfirmation"
    is-danger
    @confirm="confirmImport"
  />
</template>
