<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Ellipsis, FileText, Loader2, Plus, X } from "lucide-vue-next";
import VcpAvatar from "../../../components/ui/VcpAvatar.vue";
import OpenTabsPanel from "./OpenTabsPanel.vue";
import { buildTabMenuActions } from "./openTabsMenu";
import {
  canvasTabKey,
  isCanvasTarget,
  openTabKey,
  useOpenTabsStore,
  type CanvasOpenTab,
  type CanvasTabRef,
  type OpenTab,
  type OpenTabRef,
} from "../../../core/stores/openTabsStore";
import { useChatStreamStore } from "../../../core/stores/chatStreamStore";
import { useChatSessionStore } from "../../../core/stores/chatSessionStore";
import { useOverlayStore } from "../../../core/stores/overlay";
import { useNotificationStore } from "../../../core/stores/notification";
import { useOpenTabsRemote } from "../../../core/sync/openTabsRemote";

const router = useRouter();
const tabsStore = useOpenTabsStore();
const streamStore = useChatStreamStore();
const sessionStore = useChatSessionStore();
const overlayStore = useOverlayStore();
const notificationStore = useNotificationStore();
const scrollerRef = ref<HTMLElement | null>(null);
const creating = ref(false);
const panelOpen = ref(false);
// 三端互看：标签栏在时上报本机标签（只含聊天标签），并供「⋯」面板读取其他设备。
const { remote, release } = useOpenTabsRemote();
onUnmounted(release);

const currentOwner = computed(() => {
  const item = sessionStore.currentSelectedItem;
  return item && (item.type === "agent" || item.type === "group")
    ? { ownerId: item.id, ownerType: item.type }
    : null;
});

/** 对应 VCPChat openItemChatTab：为当前 owner 新建话题并在新标签打开。 */
const openNewTab = async () => {
  const owner = currentOwner.value;
  if (!owner || creating.value) return;
  creating.value = true;
  try {
    await tabsStore.openNewEmptyTab(owner.ownerType, owner.ownerId);
  } finally {
    creating.value = false;
  }
};

const labelOf = (tab: OpenTab) =>
  tab.ownerName ? `${tab.ownerName} · ${tab.title}` : tab.title;

type BarItem =
  | { kind: "chat"; tab: OpenTab; key: string; active: boolean; streaming: boolean; unread: boolean; label: string }
  | { kind: "canvas"; tab: CanvasOpenTab; key: string; active: boolean; streaming: false; unread: false; label: string };

const items = computed<BarItem[]>(() => [
  ...tabsStore.tabs.map((tab): BarItem => {
    const key = openTabKey(tab);
    const active = key === tabsStore.activeKey;
    return {
      kind: "chat",
      tab,
      key,
      active,
      streaming: streamStore.isConversationStreaming(tab),
      unread: !active && tab.unread,
      label: labelOf(tab),
    };
  }),
  ...tabsStore.canvasTabs.map((tab): BarItem => {
    const key = canvasTabKey(tab.path);
    return {
      kind: "canvas",
      tab,
      key,
      active: key === tabsStore.activeKey,
      streaming: false,
      unread: false,
      label: `Canvas · ${tab.name}`,
    };
  }),
]);

const avatarTarget = (tab: OpenTab) => ({
  id: tab.ownerId,
  type: tab.ownerType,
  name: tab.ownerName,
  avatarCalculatedColor: tab.avatarColor,
});

/** Canvas 标签激活后由 /canvas 页显示；聊天标签激活后 Canvas 页自行回到 /chat。 */
const activate = (item: BarItem) => {
  if (item.kind === "canvas") {
    if (tabsStore.activateCanvasTab(item.tab.path)) void router?.push("/canvas");
    return;
  }
  void tabsStore.activateTab(item.tab);
};

const closeAny = (target: OpenTabRef | CanvasTabRef) =>
  isCanvasTarget(target) ? tabsStore.closeCanvasTab(target) : tabsStore.closeTab(target);

/** 长按标签：对齐 VCPChat 标签右键菜单。 */
const showTabMenu = (item: BarItem) => {
  overlayStore.openContextMenu(
    buildTabMenuActions(item.tab, {
      tabCount: tabsStore.tabs.length + tabsStore.canvasTabs.length,
      closeTab: closeAny,
      closeOtherTabs: tabsStore.closeOtherTabs,
      closeAllTabs: tabsStore.closeAllTabs,
      renameTab: tabsStore.renameTab,
      openPrompt: overlayStore.openPrompt,
      copyText: (text) => navigator.clipboard.writeText(text),
      notify: (type, title, message) =>
        notificationStore.addNotification({ type, title, message, toastOnly: true }),
    }),
    item.label,
  );
};

// 当前标签切换后滚入可视区。
watch(
  () => tabsStore.activeKey,
  async (key) => {
    if (!key) return;
    await nextTick();
    const chip = Array.from(
      scrollerRef.value?.querySelectorAll<HTMLElement>("[data-tab-key]") ?? [],
    ).find((el) => el.dataset.tabKey === key);
    chip?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  },
);
</script>

<template>
  <nav v-if="items.length > 0" class="open-tabs-bar shrink-0 border-b border-white/5 flex items-center"
    aria-label="已打开的话题">
    <div ref="scrollerRef" role="tablist"
      class="open-tabs-scroller flex-1 min-w-0 overflow-x-auto no-swipe flex items-center gap-2 pl-3 pr-1 py-1.5">
      <div v-for="item in items" :key="item.key" :data-tab-key="item.key" :data-tab-kind="item.kind"
        v-longpress.suppress-click="() => showTabMenu(item)"
        class="open-tab-chip shrink-0 flex items-center max-w-[11rem] rounded-full border transition-colors"
        :class="item.active
          ? 'bg-primary/15 border-primary/40 text-primary-text'
          : 'bg-black/5 dark:bg-white/5 border-black/5 dark:border-white/10 opacity-80'">
        <button type="button" role="tab" :aria-selected="item.active" :title="item.label"
          class="flex items-center gap-1.5 min-w-0 pl-1 pr-1 py-1 active:scale-95 transition-transform"
          @click="activate(item)">
          <span v-if="item.kind === 'canvas'"
            class="shrink-0 w-5 h-5 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10">
            <FileText :size="12" aria-hidden="true" />
          </span>
          <span v-else class="relative shrink-0">
            <VcpAvatar :target="avatarTarget(item.tab)" size="w-5 h-5" rounded="rounded-full" />
            <span v-if="item.unread"
              class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-white dark:border-gray-900"
              style="background: #ff6b6b"></span>
          </span>
          <span class="text-xs font-semibold truncate">{{ item.kind === "canvas" ? item.tab.name : item.tab.title }}</span>
          <Loader2 v-if="item.streaming" :size="12" class="shrink-0 animate-spin opacity-70"
            aria-hidden="true" />
          <span v-if="item.streaming" class="sr-only">生成中</span>
          <span v-if="item.unread" class="sr-only">有未读消息</span>
        </button>
        <button type="button" :aria-label="`关闭 ${item.label}`"
          class="shrink-0 w-6 h-6 mr-0.5 flex items-center justify-center rounded-full opacity-60 active:scale-90"
          @click.stop="closeAny(item.tab)">
          <X :size="12" />
        </button>
      </div>
    </div>
    <div class="shrink-0 flex items-center gap-1.5 pl-1 pr-3 py-1.5">
      <button type="button" aria-label="新建话题标签" title="新建话题标签"
        class="open-tab-add shrink-0 w-7 h-7 flex items-center justify-center rounded-full border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 opacity-80 active:scale-90 transition-transform disabled:opacity-40"
        :disabled="!currentOwner || creating" @click="openNewTab">
        <Loader2 v-if="creating" :size="14" class="animate-spin" aria-hidden="true" />
        <Plus v-else :size="14" />
      </button>
      <button type="button" aria-label="标签页与其他设备" title="标签页与其他设备"
        class="open-tab-more shrink-0 w-7 h-7 flex items-center justify-center rounded-full border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 opacity-80 active:scale-90 transition-transform"
        @click="panelOpen = true">
        <Ellipsis :size="14" />
      </button>
    </div>
  </nav>
  <OpenTabsPanel v-model="panelOpen" :remote="remote" />
</template>

<style scoped>
.open-tabs-bar {
  background-color: var(--vcp-panel-bg-97, var(--secondary-bg));
}

.open-tabs-scroller {
  scrollbar-width: none;
  -ms-overflow-style: none;
  overscroll-behavior-x: contain;
}

.open-tabs-scroller::-webkit-scrollbar {
  display: none;
}
</style>
