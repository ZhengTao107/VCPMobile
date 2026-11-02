<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, History, Laptop, Monitor, Smartphone } from "lucide-vue-next";
import { useModalHistory } from "../../../core/composables/useModalHistory";
import {
  openTabKey,
  useOpenTabsStore,
  type OpenTabRef,
  type RecentlyClosedEntry,
} from "../../../core/stores/openTabsStore";
import { useAssistantStore } from "../../../core/stores/assistant";
import { useNotificationStore } from "../../../core/stores/notification";
import {
  computerRestoreState,
  createTopicTitleResolver,
  formatDeviceFreshness,
  formatOpenAllSummary,
  openDeviceTabs,
  UNSYNCED_TOPIC_TITLE,
  type OpenTabsRemoteApi,
  type RemoteDevice,
} from "../../../core/sync/openTabsRemote";

const props = defineProps<{ modelValue: boolean; remote: OpenTabsRemoteApi }>();
const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void }>();

const tabsStore = useOpenTabsStore();
const assistantStore = useAssistantStore();
const notificationStore = useNotificationStore();
const { registerModal, unregisterModal } = useModalHistory();
const modalId = "OpenTabsPanel";

const resolver = createTopicTitleResolver({
  known: (target) => tabsStore.knownTitle(target),
  fetchTopics: (ownerType, ownerId) =>
    invoke<Array<{ id: string; name?: string | null }>>("get_topics", { ownerId, ownerType }),
});

/** 设备分组默认展开；这里记手动折叠的。 */
const collapsed = reactive(new Set<string>());
/** 最近关闭的批次默认折叠；这里记展开的。 */
const expandedBatches = reactive(new Set<string>());
const busy = ref(false);
const now = ref(Date.now());

const close = () => emit("update:modelValue", false);
const toast = (type: "info" | "error", title: string, message: string) =>
  notificationStore.addNotification({ type, title, message, toastOnly: true });

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      resolver.reset();
      now.value = Date.now();
      registerModal(modalId, close);
      props.remote.startPolling();
    } else {
      unregisterModal(modalId);
      props.remote.stopPolling();
    }
  },
  { immediate: true },
);
watch(
  () => props.remote.state.fetchedAt,
  () => {
    now.value = Date.now();
  },
);
watch(
  () => props.remote.state.devices,
  (devices) => resolver.prefetch(devices.flatMap((device) => device.tabs)),
  { immediate: true },
);
onUnmounted(() => {
  props.remote.stopPolling();
  unregisterModal(modalId);
});

const ownerNameOf = (target: OpenTabRef) => {
  const list = target.ownerType === "agent" ? assistantStore.agents : assistantStore.groups;
  return (list as Array<{ id: string; name?: string }>).find((o) => o.id === target.ownerId)
    ?.name ?? "";
};

const labelOf = (tab: { ownerName: string; title: string }) =>
  tab.ownerName ? `${tab.ownerName} · ${tab.title}` : tab.title;

/** undefined=加载中，null=本机没有。 */
const remoteTitle = (target: OpenTabRef) => resolver.resolve(target);
const remoteLabel = (target: OpenTabRef) => {
  const title = remoteTitle(target);
  return title === undefined ? "加载中…" : title ?? UNSYNCED_TOPIC_TITLE;
};

const deviceIcon = (device: RemoteDevice) =>
  device.kind === "android" || device.kind === "ios" ? Smartphone : device.kind === "mac" ? Laptop : Monitor;

const remoteHint = computed(() => {
  if (!props.remote.enabled()) return "未开启自动同步或未配置同步地址";
  const { status, devices } = props.remote.state;
  if (status === "unavailable") return "电脑端未启用";
  if (devices.length > 0) return status === "error" ? "刷新失败，显示的是上次结果" : null;
  if (status === "loading" || status === "idle") return "加载中…";
  if (status === "error") return "获取失败，稍后重试";
  return "没有其他设备";
});

const computer = computed(() =>
  computerRestoreState(props.remote.enabled(), props.remote.state),
);

const toggle = (set: Set<string>, id: string) => {
  if (set.has(id)) set.delete(id);
  else set.add(id);
};

const isOpenHere = (target: OpenTabRef) => {
  const key = openTabKey(target);
  return tabsStore.tabs.some((tab) => openTabKey(tab) === key);
};

const runExclusive = async (task: () => Promise<void>) => {
  if (busy.value) return;
  busy.value = true;
  try {
    await task();
  } catch (error) {
    console.warn("[OpenTabsPanel] action failed:", error);
    toast("error", "操作失败", "打开标签时出错");
  } finally {
    busy.value = false;
  }
};

const openAll = (device: RemoteDevice) =>
  runExclusive(async () => {
    const result = await openDeviceTabs(device, {
      isOpen: isOpenHere,
      resolveTitle: (target) => resolver.resolveAsync(target),
      openTabsInBackground: (items) => tabsStore.openTabsInBackground(items),
      activateTab: (target) => tabsStore.activateTab(target),
    });
    toast("info", device.deviceName, formatOpenAllSummary(result.opened, result.skipped));
    if (result.activated) close();
  });

const restoreComputer = () => {
  const device = computer.value.device;
  if (device) void openAll(device);
};

const openHere = (target: OpenTabRef, title?: string | null) =>
  runExclusive(async () => {
    const opened = await tabsStore.openInNewTab({
      ownerId: target.ownerId,
      ownerType: target.ownerType,
      topicId: target.topicId,
      ...(title ? { title } : {}),
    });
    if (opened) close();
    else toast("error", "无法打开", "本机没有找到这个话题");
  });

const restoreEntry = (entry: RecentlyClosedEntry) =>
  runExclusive(async () => {
    if (entry.kind === "batch") {
      const result = await tabsStore.restoreClosedBatch(entry.id);
      if (result.skipped > 0) {
        toast("info", "恢复标签", `已恢复 ${result.opened}，跳过 ${result.skipped}（本机没有）`);
      }
      if (result.activated) close();
      return;
    }
    if (await tabsStore.restoreClosed(entry)) close();
    else toast("error", "无法打开", "本机没有找到这个话题");
  });

const restoreChild = (batchId: string, target: OpenTabRef) =>
  runExclusive(async () => {
    if (await tabsStore.restoreClosedBatchChild(batchId, target)) close();
    else toast("error", "无法打开", "本机没有找到这个话题");
  });
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="modelValue" class="fixed inset-0 bg-black/50 z-sheet" @click="close" @touchmove.prevent></div>
    </Transition>
    <Transition name="slide-up">
      <div v-if="modelValue" role="dialog" aria-label="标签页与其他设备"
        class="open-tabs-panel fixed bottom-0 left-0 right-0 z-sheet bg-white/90 dark:bg-gray-900/90 rounded-t-[2rem] shadow-2xl p-4 flex flex-col border-t border-white/20 dark:border-white/5"
        style="max-height: 80vh; padding-right: calc(var(--vcp-safe-right, 0px) + 16px); padding-bottom: calc(var(--vcp-safe-bottom, 48px) + 16px); padding-left: calc(var(--vcp-safe-left, 0px) + 16px);">
        <div class="w-12 h-1.5 bg-black/10 dark:bg-white/20 rounded-full mx-auto mb-3 shrink-0"></div>
        <div class="shrink-0 px-1 mb-3">
          <button type="button" class="restore-computer" :disabled="!computer.device || busy"
            @click="restoreComputer">
            <Monitor :size="16" class="shrink-0" />
            <span>恢复电脑的标签</span>
          </button>
          <p v-if="computer.reason" class="panel-empty text-center">{{ computer.reason }}</p>
        </div>
        <div class="overflow-y-auto min-h-0 flex flex-col gap-4 px-1 text-sm">
          <section>
            <h3 class="panel-heading">本机已打开</h3>
            <button v-for="tab in tabsStore.tabs" :key="openTabKey(tab)" type="button"
              class="panel-row" :class="openTabKey(tab) === tabsStore.activeKey ? 'text-primary-text font-bold' : ''"
              @click="tabsStore.activateTab(tab).then(close)">
              <span class="truncate">{{ labelOf(tab) }}</span>
            </button>
            <p v-if="tabsStore.tabs.length === 0" class="panel-empty">没有打开的标签</p>
          </section>

          <section>
            <h3 class="panel-heading">💻 其他设备打开的</h3>
            <p v-if="remoteHint" class="panel-empty">{{ remoteHint }}</p>
            <div v-for="device in remote.state.devices" :key="device.deviceId" class="mb-1">
              <div class="panel-row">
                <button type="button" class="flex items-center gap-2 min-w-0 flex-1 text-left"
                  :aria-expanded="!collapsed.has(device.deviceId)" @click="toggle(collapsed, device.deviceId)">
                  <component :is="collapsed.has(device.deviceId) ? ChevronRight : ChevronDown" :size="14" class="shrink-0 opacity-60" />
                  <component :is="deviceIcon(device)" :size="14" class="shrink-0 opacity-70" />
                  <span class="truncate font-semibold">{{ device.deviceName }}</span>
                  <span class="ml-auto shrink-0 text-xs opacity-60">
                    {{ device.tabs.length }} · {{ formatDeviceFreshness(device.updatedAt, now) }}
                  </span>
                </button>
                <button type="button" class="panel-chip" :disabled="busy || device.tabs.length === 0"
                  @click="openAll(device)">全部打开</button>
              </div>
              <template v-if="!collapsed.has(device.deviceId)">
                <button v-for="tab in device.tabs" :key="openTabKey(tab)" type="button"
                  class="panel-row pl-8" :disabled="busy || remoteTitle(tab) === null"
                  @click="openHere(tab, remoteTitle(tab))">
                  <span class="truncate" :class="remoteTitle(tab) === null ? 'opacity-50' : ''">
                    {{ ownerNameOf(tab) ? `${ownerNameOf(tab)} · ` : "" }}{{ remoteLabel(tab) }}
                  </span>
                </button>
                <p v-if="device.tabs.length === 0" class="panel-empty pl-8">没有打开的标签</p>
              </template>
            </div>
          </section>

          <section>
            <h3 class="panel-heading flex items-center gap-1"><History :size="14" /> 最近关闭</h3>
            <template v-for="entry in tabsStore.recentlyClosed"
              :key="entry.kind === 'batch' ? entry.id : openTabKey(entry)">
              <div v-if="entry.kind === 'batch'" class="mb-1">
                <div class="panel-row">
                  <button type="button" class="flex items-center gap-2 min-w-0 flex-1 text-left"
                    :aria-expanded="expandedBatches.has(entry.id)" @click="toggle(expandedBatches, entry.id)">
                    <component :is="expandedBatches.has(entry.id) ? ChevronDown : ChevronRight" :size="14" class="shrink-0 opacity-60" />
                    <span class="truncate font-semibold">{{ entry.title }}</span>
                  </button>
                  <button type="button" class="panel-chip" :disabled="busy" @click="restoreEntry(entry)">全部恢复</button>
                </div>
                <template v-if="expandedBatches.has(entry.id)">
                  <button v-for="tab in entry.tabs" :key="openTabKey(tab)" type="button"
                    class="panel-row pl-8" :disabled="busy" @click="restoreChild(entry.id, tab)">
                    <span class="truncate">{{ labelOf(tab) }}</span>
                  </button>
                </template>
              </div>
              <button v-else type="button" class="panel-row" :disabled="busy" @click="restoreEntry(entry)">
                <span class="truncate">{{ labelOf(entry) }}</span>
              </button>
            </template>
            <p v-if="tabsStore.recentlyClosed.length === 0" class="panel-empty">没有最近关闭的标签</p>
          </section>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.panel-heading {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  opacity: 0.55;
  margin-bottom: 0.375rem;
}

.panel-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.625rem 0.75rem;
  border-radius: 0.875rem;
  text-align: left;
  background: rgb(0 0 0 / 0.04);
  margin-bottom: 0.25rem;
}

:global(.dark) .panel-row {
  background: rgb(255 255 255 / 0.05);
}

.panel-row:disabled {
  cursor: not-allowed;
}

.panel-chip {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 9999px;
  background: rgb(0 0 0 / 0.06);
}

:global(.dark) .panel-chip {
  background: rgb(255 255 255 / 0.08);
}

.panel-chip:disabled {
  opacity: 0.4;
}

.restore-computer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem;
  border-radius: 1rem;
  font-size: 14px;
  font-weight: 700;
  background: rgb(0 0 0 / 0.06);
}

:global(.dark) .restore-computer {
  background: rgb(255 255 255 / 0.08);
}

.restore-computer:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.panel-empty {
  font-size: 12px;
  opacity: 0.5;
  padding: 0.25rem 0.75rem;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
