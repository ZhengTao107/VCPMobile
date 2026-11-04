<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ArrowLeft, RefreshCw } from "@lucide/vue";
import CanvasDocPane from "./CanvasDocPane.vue";
import CanvasChatPane from "./CanvasChatPane.vue";
import OpenTabsBar from "../chat/components/OpenTabsBar.vue";
import {
  useCanvasStore,
  createChatSwitcher,
  bindingToTab,
  CHAT_SWITCH_TIMEOUT_MS,
  type ChatSwitchState,
} from "../../core/stores/canvasStore";
import { useOpenTabsStore, openTabKey, canvasNameOf, type OpenTabRef } from "../../core/stores/openTabsStore";
import { useChatSessionStore } from "../../core/stores/chatSessionStore";
import { useAssistantStore } from "../../core/stores/assistant";

type Segment = "doc" | "chat";

const router = useRouter();
const canvas = useCanvasStore();
const tabsStore = useOpenTabsStore();
const sessionStore = useChatSessionStore();
const assistantStore = useAssistantStore();

/** 当前文稿由激活的 Canvas 标签决定；listMode 时只看列表，不关闭标签。 */
const listMode = ref(false);
const selected = computed(() =>
  !listMode.value && tabsStore.activeCanvasPath ? canvasNameOf(tabsStore.activeCanvasPath) : null,
);
const segment = ref<Segment>("doc");

/** [对话] 只把全局会话切到绑定话题，不新开、不切换聊天标签（Canvas 标签激活时 upsertCurrent 跳过）。 */
const selectConversation = async (tab: OpenTabRef) => {
  const status = await sessionStore.selectTopicById(tab.ownerId, tab.ownerType, tab.topicId);
  return status === "accepted";
};
const switcher = createChatSwitcher({
  current: () => sessionStore.currentConversationKey,
  open: selectConversation,
  activate: selectConversation,
});

const docs = computed(() => canvas.state.docs);
const current = computed(() => docs.value.find((doc) => doc.name === selected.value) ?? null);
const binding = computed(() => (selected.value ? canvas.bindingFor(selected.value) : null));
const chatActive = computed(() => {
  const key = sessionStore.currentConversationKey;
  return !!binding.value && !!key && openTabKey(key) === openTabKey(bindingToTab(binding.value));
});

const statusText = computed(() => {
  switch (canvas.state.status) {
    case "disabled":
      return "未开启自动同步或缺少同步地址/Token，仅显示手机上的副本";
    case "unavailable":
      return "电脑端未启用";
    case "syncing":
      return "同步中…";
    case "error":
      return `同步出错，稍后重试：${canvas.state.error ?? ""}`;
    default:
      return canvas.state.error ? `部分文件未同步：${canvas.state.error}` : "";
  }
});

const chatSwitch = ref<ChatSwitchState>({ state: "idle", reason: null });
let switchTimer: ReturnType<typeof setTimeout> | null = null;
const clearSwitchTimer = () => {
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = null;
};

const ownerKnown = (tab: OpenTabRef) =>
  tab.ownerType === "group"
    ? assistantStore.groups.some((g) => g.id === tab.ownerId)
    : assistantStore.agents.some((a) => a.id === tab.ownerId);

const failureReason = (tab: OpenTabRef, error: unknown) => {
  if (!ownerKnown(tab)) {
    return `手机上没有${tab.ownerType === "group" ? "群" : " Agent "}「${tab.ownerId}」，请先同步或改选话题`;
  }
  if (error) return `打开话题出错：${error instanceof Error ? error.message : String(error)}`;
  return `无法打开话题「${tab.topicId}」`;
};

const enterChat = async () => {
  if (!binding.value) return;
  const target = bindingToTab(binding.value);
  clearSwitchTimer();
  chatSwitch.value = { state: "switching", reason: null };
  switchTimer = setTimeout(() => {
    switchTimer = null;
    if (segment.value === "chat" && !chatActive.value && chatSwitch.value.state === "switching") {
      chatSwitch.value = {
        state: "failed",
        reason: `${CHAT_SWITCH_TIMEOUT_MS / 1000} 秒内没有切到对应话题`,
      };
    }
  }, CHAT_SWITCH_TIMEOUT_MS);
  let opened = false;
  let error: unknown = null;
  try {
    opened = await switcher.enter(target);
  } catch (e) {
    error = e;
  }
  if (segment.value !== "chat") return;
  if (opened && chatActive.value) {
    clearSwitchTimer();
    chatSwitch.value = { state: "idle", reason: null };
  } else if (!opened) {
    clearSwitchTimer();
    chatSwitch.value = { state: "failed", reason: failureReason(target, error) };
  }
};

// 切换成功（含超时后迟到的激活）即清除失败状态。
watch(chatActive, (active) => {
  if (!active) return;
  clearSwitchTimer();
  chatSwitch.value = { state: "idle", reason: null };
});

const setSegment = async (next: Segment) => {
  if (segment.value === next) return;
  segment.value = next;
  if (next === "chat") {
    await enterChat();
  } else {
    clearSwitchTimer();
    chatSwitch.value = { state: "idle", reason: null };
    await switcher.leave();
  }
};

// 在[对话]里新建立或改选绑定后立即切过去。
watch(binding, (value, old) => {
  const changed = !!value && (!old || openTabKey(bindingToTab(value)) !== openTabKey(bindingToTab(old)));
  if (segment.value === "chat" && changed) void enterChat();
});

const openDoc = (name: string) => {
  listMode.value = false;
  segment.value = "doc";
  tabsStore.openCanvasTab(name);
};

/** 删除文稿：三端一起删（离线时下次同步补推）。 */
const removeDoc = async (name: string) => {
  if (!window.confirm(`删除「${name}」？电脑和 Mac 上也会一起删除。`)) return;
  await canvas.deleteDoc(name);
};

/** 返回：文稿 → 列表（标签保留）；列表 → 离开 Canvas 回聊天。 */
const goBack = async () => {
  if (current.value) {
    clearSwitchTimer();
    await switcher.leave();
    segment.value = "doc";
    listMode.value = true;
    return;
  }
  await tabsStore.leaveCanvas();
  void router?.push("/chat");
};

// 标签切换：换到另一个 Canvas 标签时回 [文稿] 并恢复进入前会话；切到聊天标签（含关闭当前 Canvas 标签后回退）时回 /chat。
watch(
  () => tabsStore.activeCanvasPath,
  async (path, old) => {
    clearSwitchTimer();
    chatSwitch.value = { state: "idle", reason: null };
    segment.value = "doc";
    if (path) {
      listMode.value = false;
      if (old) await switcher.leave();
      return;
    }
    switcher.reset();
    if (old) void router?.push("/chat");
  },
);

const bind = (value: { agentId: string; topicId: string; itemType: string | null }) =>
  selected.value ? canvas.bind(selected.value, value) : Promise.resolve();

// 左右滑切换分段：水平位移 > 60px 且大于垂直位移。
let touchX = 0;
let touchY = 0;
const onTouchStart = (event: TouchEvent) => {
  touchX = event.touches[0]?.clientX ?? 0;
  touchY = event.touches[0]?.clientY ?? 0;
};
const onTouchEnd = (event: TouchEvent) => {
  const touch = event.changedTouches[0];
  if (!touch) return;
  const dx = touch.clientX - touchX;
  const dy = touch.clientY - touchY;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
  void setSegment(dx < 0 ? "chat" : "doc");
};

const formatTime = (ms: number) => (ms ? new Date(ms).toLocaleString() : "");

onMounted(() => void canvas.start());
onBeforeUnmount(() => {
  clearSwitchTimer();
  canvas.stop();
  switcher.reset();
});
</script>

<template>
  <div class="canvas-view flex flex-col h-full w-full min-w-0 bg-[var(--primary-bg)]">
    <header class="canvas-header shrink-0 flex items-center gap-2 px-3 border-b border-black/5 dark:border-white/10">
      <button
        type="button"
        class="w-9 h-9 rounded-full flex items-center justify-center text-[var(--primary-text)]"
        :aria-label="current ? '返回文稿列表' : '返回聊天'"
        @click="goBack"
      >
        <ArrowLeft :size="18" />
      </button>
      <div v-if="current" class="flex-1 flex justify-center">
        <div class="inline-flex p-0.5 rounded-full bg-[var(--secondary-bg)]" role="tablist">
          <button
            v-for="item in [{ id: 'doc', label: '文稿' }, { id: 'chat', label: '对话' }] as const"
            :key="item.id"
            type="button"
            role="tab"
            :aria-selected="segment === item.id"
            class="px-4 min-h-8 rounded-full text-[12px] font-bold transition-colors"
            :class="segment === item.id ? 'text-white' : 'text-[var(--primary-text)] opacity-70'"
            :style="segment === item.id ? 'background-color: var(--highlight-text)' : ''"
            @click="setSegment(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
      <strong v-else class="flex-1 text-[14px] text-[var(--primary-text)]">Canvas</strong>
      <button
        v-if="!current"
        type="button"
        class="w-9 h-9 rounded-full flex items-center justify-center text-[var(--primary-text)]"
        aria-label="立即同步"
        @click="canvas.start()"
      >
        <RefreshCw :size="16" :class="{ 'animate-spin': canvas.state.status === 'syncing' }" />
      </button>
    </header>
    <OpenTabsBar />

    <p v-if="statusText" class="px-3 py-1.5 text-[11px] opacity-70 text-[var(--primary-text)] bg-[var(--secondary-bg)]">
      {{ statusText }}
    </p>
    <div
      v-for="(notice, index) in canvas.state.notices"
      :key="index"
      class="mx-3 mt-2 px-3 py-2 rounded-xl text-[12px] bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100 flex gap-2"
      role="status"
    >
      <span class="flex-1">{{ notice }}</span>
      <button type="button" aria-label="关闭提示" @click="canvas.dismissNotice(index)">×</button>
    </div>

    <ul v-if="!current" class="flex-1 min-h-0 overflow-y-auto p-2">
      <li v-if="!docs.length" class="p-4 text-[13px] opacity-60 text-[var(--primary-text)]">还没有文稿</li>
      <li v-for="doc in docs" :key="doc.name" class="flex items-center gap-1">
        <button
          type="button"
          class="flex-1 min-w-0 text-left px-3 py-2.5 rounded-xl hover:bg-[var(--secondary-bg)] text-[var(--primary-text)]"
          @click="openDoc(doc.name)"
        >
          <span class="block truncate text-[14px]">{{ doc.name }}</span>
          <span class="block text-[11px] opacity-50">
            {{ formatTime(doc.mtime) }}<template v-if="doc.localOnly"> · 仅手机</template>
            <template v-else-if="doc.baseSha !== doc.sha256"> · 未同步</template>
          </span>
        </button>
        <button
          type="button"
          class="shrink-0 px-2 py-2 rounded-lg text-[12px] opacity-60 hover:opacity-100 text-[var(--primary-text)]"
          :aria-label="`删除 ${doc.name}`"
          @click="removeDoc(doc.name)"
        >
          删除
        </button>
      </li>
    </ul>

    <div v-else class="flex-1 min-h-0" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
      <CanvasDocPane
        v-show="segment === 'doc'"
        :doc="current"
        :read="canvas.readDoc"
        :save="canvas.saveDoc"
        :revisions="canvas.loadRevisions"
      />
      <CanvasChatPane
        v-if="segment === 'chat'"
        :name="current.name"
        :binding="binding"
        :active="chatActive"
        :switch-state="chatSwitch"
        :bind="bind"
        :retry="enterChat"
      />
    </div>
  </div>
</template>

<style scoped>
/* 同 ChatView .vcp-header-fixed：避开刘海/状态栏。 */
.canvas-header {
  padding-top: calc(var(--vcp-safe-top, 24px));
  padding-bottom: 8px;
  background-color: var(--vcp-panel-bg-97, var(--secondary-bg));
}
</style>
