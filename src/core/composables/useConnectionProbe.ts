import { onMounted, onUnmounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppLifecycleStore } from "../stores/appLifecycle";
import { useNotificationStore } from "../stores/notification";
import { useSettingsStore } from "../stores/settings";

export const CONNECTION_FALLBACK_EVENT = "vcp-connection-fallback";
export const CONNECTION_FALLBACK_MESSAGE = "本机不可达，已临时使用服务器";

/**
 * auto 档的探测触发方：启动 / 档案变更 / 回前台 / 联网时请求 Rust 刷新探测。
 * Rust 侧带 30s 缓存与 2.5s 超时，重复触发不会让请求等待探测；
 * 回退提示只在 Rust emit 的状态转换事件上弹一次。
 */
export function useConnectionProbe() {
  const lifecycleStore = useAppLifecycleStore();
  const settingsStore = useSettingsStore();
  const notificationStore = useNotificationStore();
  const unlisteners: UnlistenFn[] = [];
  let disposed = false;

  const refresh = (source: string) => {
    if (disposed || settingsStore.settings?.connectionProfileMode !== "auto") return;
    invoke("refresh_connection_probe").catch((error) => {
      console.warn(`[ConnectionProbe] Refresh failed (${source}):`, error);
    });
  };

  const track = (pending: Promise<UnlistenFn>) => {
    pending
      .then((stop) => {
        if (disposed) stop();
        else unlisteners.push(stop);
      })
      .catch((error) => console.error("[ConnectionProbe] Failed to listen:", error));
  };

  watch(
    () => [
      settingsStore.settings?.connectionProfileMode,
      JSON.stringify(settingsStore.settings?.connectionProfiles ?? null),
    ],
    () => refresh("Profiles changed"),
    { immediate: true },
  );

  watch(
    () => lifecycleStore.lifecycleSnapshot?.phase,
    (phase, previous) => {
      if (phase === "active" && previous !== "active") refresh("App foreground");
    },
  );

  const handleOnline = () => refresh("Device online");

  onMounted(() => {
    if (typeof window !== "undefined") window.addEventListener("online", handleOnline);
    track(listen<{ connected: boolean }>("vcp-network-changed", (event) => {
      if (event.payload?.connected === true) refresh("Native network online");
    }));
    track(listen(CONNECTION_FALLBACK_EVENT, () => {
      notificationStore.addNotification({
        type: "warning",
        title: "连接档案",
        message: CONNECTION_FALLBACK_MESSAGE,
        toastOnly: true,
      });
    }));
  });

  onUnmounted(() => {
    disposed = true;
    if (typeof window !== "undefined") window.removeEventListener("online", handleOnline);
    unlisteners.splice(0).forEach((stop) => stop());
  });
}
