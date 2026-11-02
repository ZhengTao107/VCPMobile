<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Loader2, Plus, X } from "lucide-vue-next";
import VcpAvatar from "../../../components/ui/VcpAvatar.vue";
import {
  openTabKey,
  useOpenTabsStore,
  type OpenTab,
} from "../../../core/stores/openTabsStore";
import { useChatStreamStore } from "../../../core/stores/chatStreamStore";
import { useChatSessionStore } from "../../../core/stores/chatSessionStore";

const tabsStore = useOpenTabsStore();
const streamStore = useChatStreamStore();
const sessionStore = useChatSessionStore();
const scrollerRef = ref<HTMLElement | null>(null);
const creating = ref(false);

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

const items = computed(() =>
  tabsStore.tabs.map((tab) => {
    const key = openTabKey(tab);
    const active = key === tabsStore.activeKey;
    return {
      tab,
      key,
      active,
      streaming: streamStore.isConversationStreaming(tab),
      unread: !active && tab.unread,
    };
  }),
);

const labelOf = (tab: OpenTab) =>
  tab.ownerName ? `${tab.ownerName} · ${tab.title}` : tab.title;

const avatarTarget = (tab: OpenTab) => ({
  id: tab.ownerId,
  type: tab.ownerType,
  name: tab.ownerName,
  avatarCalculatedColor: tab.avatarColor,
});

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
  <nav v-if="items.length > 1" class="open-tabs-bar shrink-0 border-b border-white/5"
    aria-label="已打开的话题">
    <div ref="scrollerRef" role="tablist"
      class="open-tabs-scroller overflow-x-auto no-swipe flex items-center gap-2 px-3 py-1.5">
      <div v-for="item in items" :key="item.key" :data-tab-key="item.key"
        class="open-tab-chip shrink-0 flex items-center max-w-[11rem] rounded-full border transition-colors"
        :class="item.active
          ? 'bg-primary/15 border-primary/40 text-primary-text'
          : 'bg-black/5 dark:bg-white/5 border-black/5 dark:border-white/10 opacity-80'">
        <button type="button" role="tab" :aria-selected="item.active" :title="labelOf(item.tab)"
          class="flex items-center gap-1.5 min-w-0 pl-1 pr-1 py-1 active:scale-95 transition-transform"
          @click="tabsStore.activateTab(item.tab)">
          <span class="relative shrink-0">
            <VcpAvatar :target="avatarTarget(item.tab)" size="w-5 h-5" rounded="rounded-full" />
            <span v-if="item.unread"
              class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-white dark:border-gray-900"
              style="background: #ff6b6b"></span>
          </span>
          <span class="text-xs font-semibold truncate">{{ item.tab.title }}</span>
          <Loader2 v-if="item.streaming" :size="12" class="shrink-0 animate-spin opacity-70"
            aria-hidden="true" />
          <span v-if="item.streaming" class="sr-only">生成中</span>
          <span v-if="item.unread" class="sr-only">有未读消息</span>
        </button>
        <button type="button" :aria-label="`关闭 ${labelOf(item.tab)}`"
          class="shrink-0 w-6 h-6 mr-0.5 flex items-center justify-center rounded-full opacity-60 active:scale-90"
          @click.stop="tabsStore.closeTab(item.tab)">
          <X :size="12" />
        </button>
      </div>
      <button type="button" aria-label="新建话题标签" title="新建话题标签"
        class="open-tab-add shrink-0 w-7 h-7 flex items-center justify-center rounded-full border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 opacity-80 active:scale-90 transition-transform disabled:opacity-40"
        :disabled="!currentOwner || creating" @click="openNewTab">
        <Loader2 v-if="creating" :size="14" class="animate-spin" aria-hidden="true" />
        <Plus v-else :size="14" />
      </button>
    </div>
  </nav>
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
