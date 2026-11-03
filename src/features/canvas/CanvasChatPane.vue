<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import ChatView from "../chat/ChatView.vue";
import { useAssistantStore } from "../../core/stores/assistant";
import { useChatSessionStore } from "../../core/stores/chatSessionStore";
import type { CanvasBinding, ChatSwitchState } from "../../core/stores/canvasStore";
import type { ConversationOwnerType } from "../../core/stores/chatSessionStore";

const props = defineProps<{
  name: string;
  binding: CanvasBinding | null;
  /** 绑定话题已在当前会话激活。 */
  active: boolean;
  switchState: ChatSwitchState;
  bind: (binding: { agentId: string; topicId: string; itemType: string | null }) => Promise<void>;
  retry: () => unknown;
}>();

const assistantStore = useAssistantStore();
const sessionStore = useChatSessionStore();
const ownerKey = ref("");
const topicId = ref("");
const topics = ref<Array<{ id: string; name?: string | null }>>([]);
const busy = ref(false);
const error = ref<string | null>(null);
/** 预选的话题：话题列表加载完成后再落到下拉框。 */
let pendingTopic: string | null = null;

const owners = computed(() => [
  ...assistantStore.agents.map((a) => ({ key: `agent:${a.id}`, label: a.name || a.id })),
  ...assistantStore.groups.map((g) => ({ key: `group:${g.id}`, label: `群 · ${g.name || g.id}` })),
]);

const failed = computed(() => !!props.binding && !props.active && props.switchState.state === "failed");
const showPicker = computed(() => !props.binding || failed.value);

const splitOwner = (key: string) => {
  const index = key.indexOf(":");
  return { ownerType: key.slice(0, index) as ConversationOwnerType, ownerId: key.slice(index + 1) };
};

watch(ownerKey, async (key) => {
  topicId.value = "";
  topics.value = [];
  if (!key) return;
  const { ownerType, ownerId } = splitOwner(key);
  try {
    const list = await invoke<Array<{ id: string; name?: string | null }>>("get_topics", { ownerId, ownerType });
    if (ownerKey.value !== key) return;
    topics.value = Array.isArray(list) ? list : [];
    if (pendingTopic && topics.value.some((t) => t.id === pendingTopic)) topicId.value = pendingTopic;
  } catch (e) {
    error.value = `读取话题失败：${String(e)}`;
  } finally {
    pendingTopic = null;
  }
});

// 无绑定时默认预选当前会话的 owner 与话题（进入 Canvas 前所在的对话）。
const current = sessionStore.currentConversationKey;
if (!props.binding && current) {
  pendingTopic = current.topicId;
  ownerKey.value = `${current.ownerType}:${current.ownerId}`;
}

const confirm = async () => {
  if (!ownerKey.value || !topicId.value || busy.value) return;
  const { ownerType, ownerId } = splitOwner(ownerKey.value);
  busy.value = true;
  error.value = null;
  try {
    await props.bind({ agentId: ownerId, topicId: topicId.value, itemType: ownerType });
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <section class="canvas-chat h-full min-h-0 flex flex-col">
    <ChatView v-if="binding && active" />
    <p v-else-if="binding && !failed" class="p-4 text-[13px] opacity-60 text-[var(--primary-text)]">正在切换到对应话题…</p>
    <div v-if="showPicker" class="p-4 flex flex-col gap-3 text-[13px] text-[var(--primary-text)]">
      <div v-if="failed" class="flex items-center gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-900/30" role="alert">
        <span class="flex-1 text-red-600 dark:text-red-300">切换失败：{{ switchState.reason }}</span>
        <button
          type="button"
          class="px-3 min-h-8 rounded-full text-[12px] font-bold text-white"
          style="background-color: var(--highlight-text)"
          @click="retry()"
        >
          重试
        </button>
      </div>
      <p class="opacity-70">
        {{ failed ? "也可以改选一个话题关联：" : `「${name}」还没有关联对话。选一个话题关联后，电脑端也会记住。` }}
      </p>
      <select v-model="ownerKey" class="min-h-10 px-3 rounded-xl bg-[var(--secondary-bg)]" aria-label="选择 Agent 或群">
        <option value="">选择 Agent / 群</option>
        <option v-for="owner in owners" :key="owner.key" :value="owner.key">{{ owner.label }}</option>
      </select>
      <select
        v-model="topicId"
        class="min-h-10 px-3 rounded-xl bg-[var(--secondary-bg)]"
        :disabled="!topics.length"
        aria-label="选择话题"
      >
        <option value="">选择话题</option>
        <option v-for="topic in topics" :key="topic.id" :value="topic.id">{{ topic.name || topic.id }}</option>
      </select>
      <button
        type="button"
        class="min-h-10 rounded-full font-bold text-white disabled:opacity-50"
        style="background-color: var(--highlight-text)"
        :disabled="!topicId || busy"
        @click="confirm"
      >
        {{ busy ? "关联中" : "关联并打开" }}
      </button>
      <p v-if="error" class="text-red-500 text-[12px]">{{ error }}</p>
    </div>
  </section>
</template>
