<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ArrowLeft, RefreshCw } from "lucide-vue-next";
import CanvasDocPane from "./CanvasDocPane.vue";
import CanvasChatPane from "./CanvasChatPane.vue";
import { useCanvasStore, createChatSwitcher, bindingToTab } from "../../core/stores/canvasStore";
import { useOpenTabsStore, openTabKey } from "../../core/stores/openTabsStore";
import { useChatSessionStore } from "../../core/stores/chatSessionStore";

type Segment = "doc" | "chat";

const router = useRouter();
const canvas = useCanvasStore();
const tabsStore = useOpenTabsStore();
const sessionStore = useChatSessionStore();

const selected = ref<string | null>(null);
const segment = ref<Segment>("doc");

const switcher = createChatSwitcher({
  current: () => sessionStore.currentConversationKey,
  open: (tab) => tabsStore.openInNewTab(tab),
  activate: (tab) => tabsStore.activateTab(tab),
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

const enterChat = async () => {
  if (binding.value) await switcher.enter(bindingToTab(binding.value));
};

const setSegment = async (next: Segment) => {
  if (segment.value === next) return;
  segment.value = next;
  if (next === "chat") await enterChat();
  else await switcher.leave();
};

// 在[对话]里新建立绑定后立即切过去。
watch(binding, (value, old) => {
  if (segment.value === "chat" && value && !old) void enterChat();
});

const openDoc = (name: string) => {
  selected.value = name;
  segment.value = "doc";
};

const closeDoc = async () => {
  await switcher.leave();
  selected.value = null;
  segment.value = "doc";
};

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
  canvas.stop();
  void switcher.leave();
});
</script>

<template>
  <div class="canvas-view flex flex-col h-full w-full min-w-0 bg-[var(--primary-bg)]">
    <header class="flex items-center gap-2 px-3 py-2 border-b border-black/5 dark:border-white/10">
      <button
        type="button"
        class="w-9 h-9 rounded-full flex items-center justify-center text-[var(--primary-text)]"
        :aria-label="current ? '返回文稿列表' : '返回聊天'"
        @click="current ? closeDoc() : router.push('/chat')"
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
      <li v-for="doc in docs" :key="doc.name">
        <button
          type="button"
          class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-[var(--secondary-bg)] text-[var(--primary-text)]"
          @click="openDoc(doc.name)"
        >
          <span class="block truncate text-[14px]">{{ doc.name }}</span>
          <span class="block text-[11px] opacity-50">
            {{ formatTime(doc.mtime) }}<template v-if="doc.localOnly"> · 仅手机</template>
            <template v-else-if="doc.baseSha !== doc.sha256"> · 未同步</template>
          </span>
        </button>
      </li>
    </ul>

    <div v-else class="flex-1 min-h-0" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
      <CanvasDocPane v-show="segment === 'doc'" :doc="current" :read="canvas.readDoc" :save="canvas.saveDoc" />
      <CanvasChatPane
        v-if="segment === 'chat'"
        :name="current.name"
        :binding="binding"
        :active="chatActive"
        :bind="bind"
      />
    </div>
  </div>
</template>
