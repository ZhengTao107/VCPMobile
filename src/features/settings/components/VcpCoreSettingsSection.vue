<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { ChatEndpointMode } from '../../../core/stores/settings';
import type { ConnectionFields } from '../editing/fieldSets';
import type { SettingsSaveResult } from '../editing/useSettingsEditSession';
import {
  CONNECTION_PROFILE_FIELDS,
  CONNECTION_PROFILE_PATHS,
  connectionProfileFieldValues,
  newConnectionProfileId,
  parseConnectionProfiles,
  serializeConnectionProfiles,
  type ConnectionProfile,
} from '../../../core/config/connectionProfiles';
import SettingsTextField from '../../../components/settings/SettingsTextField.vue';
import SettingsActionWithStatus from '../../../components/settings/SettingsActionWithStatus.vue';

const props = defineProps<{
  settings: Readonly<ConnectionFields>;
  active: boolean;
  disabled?: boolean;
  commit: () => Promise<SettingsSaveResult>;
}>();

const emit = defineEmits<{
  (e: 'edit', patch: Partial<ConnectionFields>): void;
  (e: 'blur'): void;
}>();

const vcpPingStatus = ref<{ type: 'success' | 'error' | 'loading' | 'info' | null; message: string }>({ type: null, message: '' });

const endpointModes: ReadonlyArray<{
  value: ChatEndpointMode;
  title: string;
  description: string;
}> = [
  { value: 'standard', title: '标准 Chat', description: '兼容 VCPToolBox 标准路由与 NewAPI / OpenAI 上游' },
  { value: 'vcpTools', title: 'VCP 增强 Chat', description: '使用 ChatVCP 路由，显示 VCP 工具执行过程' },
  { value: 'raw', title: '原始 URL', description: '完整端点原样请求，不补全或替换路径' },
];

interface ChatEndpointPreview {
  finalUrl: string;
  modelDiscoveryUrl: string | null;
}

const endpointPreview = ref<ChatEndpointPreview | null>(null);
const endpointPreviewError = ref('');
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewGeneration = 0;
let testGeneration = 0;
let disposed = false;

const scheduleEndpointPreview = () => {
  if (previewTimer) clearTimeout(previewTimer);
  const generation = ++previewGeneration;
  const vcpUrl = props.settings['server.url'];
  const chatEndpointMode = props.settings['server.endpointMode'];
  if (!props.active || disposed) return;
  endpointPreviewError.value = '';
  if (!vcpUrl) {
    endpointPreview.value = null;
    return;
  }

  previewTimer = setTimeout(async () => {
    try {
      const preview = await invoke<ChatEndpointPreview>('preview_chat_endpoint', {
        vcpUrl,
        chatEndpointMode,
      });
      if (generation !== previewGeneration) return;
      endpointPreview.value = preview;
    } catch (error) {
      if (generation !== previewGeneration) return;
      endpointPreview.value = null;
      endpointPreviewError.value = String(error);
    }
  }, 120);
};

watch(
  [() => props.settings['server.url'], () => props.settings['server.endpointMode'], () => props.active],
  scheduleEndpointPreview,
  { immediate: true },
);

onUnmounted(() => {
  disposed = true;
  if (previewTimer) clearTimeout(previewTimer);
  previewGeneration += 1;
  testGeneration += 1;
});

// ── fork ptp4g#24 连接档案：只是填字段的快捷预设（VCPChat 同一范式），不参与任何请求解析 ──
// 选用 = 把档案的非空字段写进下面那组正在用的字段并提交；存为 = 把当前字段拷成档案。
const profiles = computed<ConnectionProfile[]>(() =>
  parseConnectionProfiles(props.settings['server.connectionProfiles']),
);
const selectedProfileId = ref<string | null>(null);
const selectedProfile = computed(
  () => profiles.value.find((profile) => profile.id === selectedProfileId.value) ?? null,
);
const newProfileName = ref('');
const profileStatus = ref('');

const commitFields = (values: Record<string, string>) => {
  emit('edit', values as Partial<ConnectionFields>);
  emit('blur');
};

const applyProfile = () => {
  const profile = selectedProfile.value;
  if (!profile) return;
  commitFields(connectionProfileFieldValues(profile));
  profileStatus.value = `已选用「${profile.name}」`;
};

// 同名即覆盖该档案（保留 id），否则新增
const saveAsProfile = () => {
  const name = newProfileName.value.trim();
  if (!name) {
    profileStatus.value = '请先填写档案名称';
    return;
  }
  const existing = profiles.value.find((profile) => profile.name === name);
  const created = { id: existing?.id ?? newConnectionProfileId(), name } as ConnectionProfile;
  for (const field of CONNECTION_PROFILE_FIELDS) {
    const value = props.settings[CONNECTION_PROFILE_PATHS[field]];
    created[field] = typeof value === 'string' ? value : '';
  }
  const next = existing
    ? profiles.value.map((profile) => (profile.id === existing.id ? created : profile))
    : [...profiles.value, created];
  commitFields({ 'server.connectionProfiles': serializeConnectionProfiles(next) });
  selectedProfileId.value = created.id;
  newProfileName.value = '';
  profileStatus.value = existing ? `已更新档案「${name}」` : `已存为档案「${name}」`;
};

const deleteProfile = () => {
  const profile = selectedProfile.value;
  if (!profile) return;
  commitFields({
    'server.connectionProfiles': serializeConnectionProfiles(profiles.value.filter((item) => item.id !== profile.id)),
  });
  selectedProfileId.value = null;
  profileStatus.value = `已删除档案「${profile.name}」`;
};

watch(
  [() => props.settings['server.url'], () => props.settings['server.apiKey'], () => props.settings['server.endpointMode'], () => props.active],
  () => {
    testGeneration += 1;
    vcpPingStatus.value = { type: null, message: '' };
  },
  { flush: 'sync' },
);

interface VcpConnectionTestResult {
  success: boolean;
  status: number;
  modelCount: number;
  models: unknown;
  modelDiscoveryAvailable: boolean;
}

const testVcpConnection = async () => {
  if (disposed || !props.active || props.disabled || vcpPingStatus.value.type === 'loading') return;
  const generation = ++testGeneration;
  vcpPingStatus.value = { type: 'loading', message: '正在检查模型列表...' };
  try {
    const saved = await props.commit();
    if (disposed || !props.active || generation !== testGeneration) return;
    if (!saved.ok) throw new Error(saved.error);
    const snapshot = saved.snapshot;
    if (!snapshot.server.url) throw new Error('请先输入 Chat 服务器 URL');
    const res = await invoke<VcpConnectionTestResult>('test_vcp_connection', {
      vcpUrl: snapshot.server.url,
      vcpApiKey: snapshot.server.apiKey,
      chatEndpointMode: snapshot.server.endpointMode,
    });

    if (disposed || !props.active || generation !== testGeneration) return;
    if (!res.modelDiscoveryAvailable) {
      vcpPingStatus.value = {
        type: 'info',
        message: '原始 URL 无法安全推导模型列表；已跳过模型发现，主聊天仍会使用原地址。',
      };
    } else if (res.success) {
      vcpPingStatus.value = { type: 'success', message: `连接成功！拉取到 ${res.modelCount} 个可用模型` };
    } else {
      vcpPingStatus.value = { type: 'error', message: `验证失败, HTTP 状态码: ${res.status}` };
    }
  } catch (e: any) {
    if (disposed || !props.active || generation !== testGeneration) return;
    vcpPingStatus.value = { type: 'error', message: `${e}` };
  }
};
</script>

<template>
  <div class="space-y-5 px-1">
    <fieldset>
      <legend class="text-[11px] font-black uppercase tracking-[0.12em] opacity-50 px-0">档案</legend>
      <div v-if="profiles.length" class="mt-2 divide-y divide-black/5 dark:divide-white/5" role="radiogroup" aria-label="连接档案">
        <button
          v-for="profile in profiles"
          :key="profile.id"
          type="button"
          role="radio"
          :aria-checked="selectedProfileId === profile.id"
          class="relative w-full py-3 pl-3 pr-2 text-left transition-colors active:bg-black/5 dark:active:bg-white/5"
          @click="selectedProfileId = profile.id"
        >
          <span class="absolute left-0 top-2 bottom-2 w-0.5 bg-blue-500 transition-opacity"
            :class="selectedProfileId === profile.id ? 'opacity-100' : 'opacity-0'"></span>
          <span class="block text-sm font-semibold">{{ profile.name }}</span>
          <span class="mt-0.5 block break-all text-[11px] leading-4 opacity-50">{{ profile.vcpServerUrl || '未填写 Chat URL' }}</span>
        </button>
      </div>
      <p v-else class="mt-2 text-[11px] leading-4 opacity-45">还没有档案。填好下面的连接字段后，可以存为档案以便快速切换。</p>
      <div class="mt-2 flex gap-2">
        <button type="button" data-profile-action="apply" :disabled="!selectedProfile || disabled"
          class="flex-1 rounded-lg bg-blue-500 py-2 text-sm font-semibold text-white disabled:opacity-35"
          @click="applyProfile">选用</button>
        <button type="button" data-profile-action="delete" :disabled="!selectedProfile || disabled"
          class="rounded-lg border border-black/10 px-4 py-2 text-sm font-semibold text-red-500 disabled:opacity-35 dark:border-white/10"
          @click="deleteProfile">删除</button>
      </div>
      <div class="mt-3 flex items-end gap-2">
        <div class="min-w-0 flex-1">
          <SettingsTextField v-model="newProfileName" label="档案名称" placeholder="如：家里 / 公司 / 服务器" />
        </div>
        <button type="button" data-profile-action="save" :disabled="disabled"
          class="shrink-0 rounded-lg border border-black/10 px-3 py-2 text-sm font-semibold disabled:opacity-35 dark:border-white/10"
          @click="saveAsProfile">存为档案</button>
      </div>
      <p v-if="profileStatus" class="mt-2 text-[11px] leading-4 opacity-60" data-profile-status>{{ profileStatus }}</p>
      <p class="mt-2 text-[10px] leading-4 opacity-45">
        档案只是预设：选用会把档案里非空的字段填进下面正在用的设置并保存，之后所有请求只看下面这组字段。
      </p>
    </fieldset>

    <div class="border-t border-black/5 dark:border-white/5 pt-2"></div>

    <SettingsTextField :model-value="settings['server.url']" :disabled="disabled"
      @update:model-value="emit('edit', { 'server.url': $event })" label="Chat 服务器 URL (HTTP/HTTPS)"
      @blur="emit('blur')"
      placeholder="https://vcp-endpoint.com" />

    <fieldset class="border-t border-black/5 dark:border-white/5 pt-3">
      <legend class="text-[11px] font-black uppercase tracking-[0.12em] opacity-50 px-0">Chat 请求入口</legend>
      <div class="mt-2 divide-y divide-black/5 dark:divide-white/5" role="radiogroup" aria-label="Chat 请求入口">
        <button
          v-for="option in endpointModes"
          :key="option.value"
          type="button"
          role="radio"
          :disabled="disabled"
          :aria-checked="settings['server.endpointMode'] === option.value"
          class="relative w-full py-3 pl-3 pr-2 text-left transition-colors active:bg-black/5 dark:active:bg-white/5"
          @click="emit('edit', { 'server.endpointMode': option.value })"
          @blur="emit('blur')"
        >
          <span class="absolute left-0 top-2 bottom-2 w-0.5 bg-blue-500 transition-opacity"
            :class="settings['server.endpointMode'] === option.value ? 'opacity-100' : 'opacity-0'"></span>
          <span class="flex items-center justify-between gap-3">
            <span class="min-w-0">
              <span class="block text-sm font-semibold">{{ option.title }}</span>
              <span class="mt-0.5 block text-[11px] leading-4 opacity-50">{{ option.description }}</span>
            </span>
            <span class="h-3.5 w-3.5 shrink-0 rounded-full border"
              :class="settings['server.endpointMode'] === option.value
                ? 'border-blue-500 bg-blue-500'
                : 'border-black/20 dark:border-white/25'"></span>
          </span>
        </button>
      </div>
    </fieldset>

    <div class="border-l-2 border-blue-500/70 bg-black/[0.025] dark:bg-white/[0.025] px-3 py-2.5">
      <div class="text-[10px] font-black uppercase tracking-[0.12em] opacity-45">最终请求 URL</div>
      <code v-if="endpointPreview" class="mt-1 block break-all text-[11px] leading-4 opacity-80">
        {{ endpointPreview.finalUrl }}
      </code>
      <p v-else-if="endpointPreviewError" class="mt-1 break-all text-[11px] leading-4 text-red-500">
        {{ endpointPreviewError }}
      </p>
      <p v-else class="mt-1 text-[11px] opacity-35">输入服务器地址后由 Rust 解析并显示</p>
      <p v-if="endpointPreview && !endpointPreview.modelDiscoveryUrl" class="mt-1 text-[10px] leading-4 opacity-45">
        此原始地址不提供可安全推导的模型发现端点
      </p>
    </div>

    <SettingsTextField :model-value="settings['server.apiKey']" :disabled="disabled"
      @blur="emit('blur')"
      @update:model-value="emit('edit', { 'server.apiKey': $event })" is-secure label="API Key" placeholder="输入 API Key" />

    <div class="border-t border-black/5 dark:border-white/5 pt-2"></div>

    <div class="space-y-1.5">
      <SettingsTextField :model-value="settings['log.url']" :disabled="disabled"
        @blur="emit('blur')"
        @update:model-value="emit('edit', { 'log.url': $event })" label="VCP WebSocket 服务器 URL" placeholder="ws://localhost:6005"
        mono />
      <p class="px-1 text-[11px] leading-4 opacity-60">使用 ws:// 或 wss:// 服务器基础地址，鉴权 Key 在下方单独填写。</p>
    </div>
    <div class="space-y-1.5">
      <SettingsTextField :model-value="settings['log.key']" :disabled="disabled"
        @blur="emit('blur')"
        @update:model-value="emit('edit', { 'log.key': $event })" is-secure label="VCP WebSocket 鉴权 Key"
        placeholder="输入 WebSocket Key" mono />
      <p class="px-1 text-[11px] leading-4 opacity-60">Key 使用无空白的可打印 ASCII 字符；不支持会改变地址含义的特殊符号。</p>
    </div>

    <SettingsActionWithStatus
      button-variant="primary"
      button-label="检查模型发现"
      :button-loading="vcpPingStatus.type === 'loading'"
      :button-disabled="disabled"
      :status-type="vcpPingStatus.type"
      :status-message="vcpPingStatus.message"
      status-multiline
      @action-click="testVcpConnection"
    />
  </div>
</template>
