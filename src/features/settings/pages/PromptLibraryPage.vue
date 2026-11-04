<script setup lang="ts">
import { computed, ref } from 'vue';
import SettingsSection from '../../../components/settings/SettingsSection.vue';
import { promptLibrary } from '../../../core/sync/libraryRemote';
import { useChatSessionStore } from '../../../core/stores/chatSessionStore';
import { useNotificationStore } from '../../../core/stores/notification';
import { patchAgentConfig, quickSwitchAgentId } from '../../agent/agentConfigPatch';
import type { SettingsPageProps } from '../contracts';

const props = defineProps<SettingsPageProps>();
const session = useChatSessionStore();
const notification = useNotificationStore();
const agentId = computed(() => quickSwitchAgentId(session.currentSelectedItem));
const expanded = ref<string | null>(null);
const applying = ref(false);

const firstLine = (text: string) => text.trim().split('\n')[0].slice(0, 40);
const presets = computed(() => promptLibrary.value.presets.map(item => ({
  key: item.path, title: item.name, content: item.content, disabled: false,
})));
const blocks = computed(() => promptLibrary.value.warehouse.map(item => ({
  key: `warehouse:${item.id}`, title: firstLine(item.content), content: item.content, disabled: item.disabled,
})));
const sections = computed(() => [
  { title: '系统提示词预设', items: presets.value },
  { title: '全局提示词仓库', items: blocks.value },
]);

const toggle = (key: string) => {
  expanded.value = expanded.value === key ? null : key;
};
const apply = async (content: string) => {
  const id = agentId.value;
  if (!id || applying.value || !props.active) return;
  applying.value = true;
  try {
    await patchAgentConfig(id, { mobileSystemPrompt: content });
  } catch (error) {
    notification.addNotification({ type: 'error', title: '选用失败', message: String(error), toastOnly: true });
  } finally {
    applying.value = false;
  }
};
</script>

<template>
  <div class="flex flex-col gap-6" :inert="!active">
    <p class="text-xs opacity-60 leading-relaxed">
      内容来自电脑端（只读，以电脑端为准）。「选用」会把内容写入当前助手的移动端提示词{{ agentId ? '' : '，请先打开一个单人助手会话' }}。
    </p>
    <SettingsSection v-for="section in sections" :key="section.title" :title="section.title">
      <p v-if="section.items.length === 0" class="text-sm opacity-60 px-1 py-2">暂无内容，连接电脑端后自动同步。</p>
      <div v-for="item in section.items" :key="item.key" class="prompt-library-item py-2 border-b border-black/5 dark:border-white/5 last:border-0">
        <div class="flex items-center gap-2">
          <button type="button" class="flex-1 min-w-0 text-left text-sm truncate" :class="{ 'opacity-50': item.disabled }"
            :aria-expanded="expanded === item.key" @click="toggle(item.key)">
            {{ item.title || '（无标题）' }}
          </button>
          <button type="button" class="shrink-0 text-xs px-2 py-1 rounded-md bg-blue-500/10 text-blue-500 disabled:opacity-40"
            :disabled="!agentId || applying" :aria-label="`选用 ${item.title}`" @click="apply(item.content)">选用</button>
        </div>
        <pre v-if="expanded === item.key"
          class="mt-2 text-xs whitespace-pre-wrap break-words opacity-80 max-h-64 overflow-auto">{{ item.content }}</pre>
      </div>
    </SettingsSection>
  </div>
</template>
