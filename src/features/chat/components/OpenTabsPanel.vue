<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, History, Laptop, Monitor, Smartphone } from "lucide-vue-next";
import { useModalHistory } from "../../../core/composables/useModalHistory";
import { openTabKey, useOpenTabsStore, type OpenTabRef } from "../../../core/stores/openTabsStore";
import { useAssistantStore } from "../../../core/stores/assistant";
import { useNotificationStore } from "../../../core/stores/notification";
import {
  createTopicTitleResolver,
  formatDeviceFreshness,
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

/** 设备分组默认折叠。 */
const expanded = reactive(new Set<string>());
const now = ref(Date.now());

const close = () => emit("update:modelValue", false);

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

const toggleDevice = (deviceId: string) => {
  if (expanded.has(deviceId)) expanded.delete(deviceId);
  else expanded.add(deviceId);
};

const openHere = async (target: OpenTabRef, title?: string | null) => {
  const opened = await tabsStore.openInNewTab({
    ownerId: target.ownerId,
    ownerType: target.ownerType,
    topicId: target.topicId,
    ...(title ? { title } : {}),
  });
  if (opened) {
    close();
  } else {
    notificationStore.addNotification({
      type: "error",
      title: "无法打开",
      message: "本机没有找到这个话题",
      toastOnly: true,
    });
  }
};
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
        <div class="overflow-y-auto min-h-0 flex flex-col gap-4 px-1 text-sm">
          <section>
            <h3 class="panel-heading">本机已打开</h3>
            <button v-for="tab in tabsStore.tabs" :key="openTabKey(tab)" type="button"
              class="panel-row" :class="openTabKey(tab) === tabsStore.activeKey ? 'text-primary-text font-bold' : ''"
              @click="tabsStore.activateTab(tab).then(close)">
              <span class="truncate">{{ tab.ownerName ? `${tab.ownerName} · ${tab.title}` : tab.title }}</span>
            </button>
            <p v-if="tabsStore.tabs.length === 0" class="panel-empty">没有打开的标签</p>
          </section>

          <section>
            <h3 class="panel-heading">💻 其他设备打开的</h3>
            <p v-if="remoteHint" class="panel-empty">{{ remoteHint }}</p>
            <div v-for="device in remote.state.devices" :key="device.deviceId" class="mb-1">
              <button type="button" class="panel-row" :aria-expanded="expanded.has(device.deviceId)"
                @click="toggleDevice(device.deviceId)">
                <component :is="expanded.has(device.deviceId) ? ChevronDown : ChevronRight" :size="14" class="shrink-0 opacity-60" />
                <component :is="deviceIcon(device)" :size="14" class="shrink-0 opacity-70" />
                <span class="truncate font-semibold">{{ device.deviceName }}</span>
                <span class="ml-auto shrink-0 text-xs opacity-60">
                  {{ device.tabs.length }} · {{ formatDeviceFreshness(device.updatedAt, now) }}
                </span>
              </button>
              <template v-if="expanded.has(device.deviceId)">
                <button v-for="tab in device.tabs" :key="openTabKey(tab)" type="button"
                  class="panel-row pl-8" :disabled="remoteTitle(tab) === null"
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
            <button v-for="entry in tabsStore.recentlyClosed" :key="openTabKey(entry)" type="button"
              class="panel-row" @click="openHere(entry, entry.title)">
              <span class="truncate">{{ entry.ownerName ? `${entry.ownerName} · ${entry.title}` : entry.title }}</span>
            </button>
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
