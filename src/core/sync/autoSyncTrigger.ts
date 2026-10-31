import { watch } from "vue";
import { useSettingsStore, type AppSettings } from "../stores/settings";

/**
 * 自动同步触发器（主人自用 fork）：消息完成 / 回到前台 / 联网后，
 * 尾随防抖合并为一次同步；同步进行中的新请求只记一个 pending，结束后补跑一次。
 * 未配置同步地址或 Token、或 settings.autoSync === false 时零行为。
 */
export const AUTO_SYNC_DEBOUNCE_MS = 1500;
const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export const isAutoSyncReady = (
  settings: AppSettings | null | undefined,
): boolean => {
  // 缺省视为开启；只有显式 false 才关闭。
  if (!settings || settings.autoSync === false) return false;
  const url = settings.syncServerUrl;
  const token = settings.syncToken;
  return (
    typeof url === "string" &&
    url.trim().length > 0 &&
    typeof token === "string" &&
    token.trim().length > 0
  );
};

/** 等待响应式条件成立；超时返回 false。 */
export const waitUntil = (
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    if (predicate()) {
      resolve(true);
      return;
    }
    let settled = false;
    let stop: ReturnType<typeof watch> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    stop = watch(predicate, (ok) => {
      if (ok) finish(true);
    }, { flush: "sync" });
  });

export interface AutoSyncTriggerOptions {
  isReady: () => boolean;
  run: (reason: string) => Promise<unknown>;
  delayMs?: number;
}

export interface AutoSyncTrigger {
  request: (reason: string) => void;
  dispose: () => void;
}

export function createAutoSyncTrigger(
  options: AutoSyncTriggerOptions,
): AutoSyncTrigger {
  const delayMs = options.delayMs ?? AUTO_SYNC_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pendingReason: string | null = null;
  let lastReason = "";
  let disposed = false;

  const fire = async () => {
    timer = null;
    if (disposed || !options.isReady()) return;
    running = true;
    try {
      await options.run(lastReason);
    } catch (error) {
      console.warn(`[AutoSync] ${lastReason} run failed:`, error);
    } finally {
      running = false;
      const replay = pendingReason;
      pendingReason = null;
      if (replay !== null) request(replay);
    }
  };

  const request = (reason: string) => {
    if (disposed || !options.isReady()) return;
    if (running) {
      pendingReason = reason;
      return;
    }
    lastReason = reason;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fire(), delayMs);
  };

  const dispose = () => {
    disposed = true;
    pendingReason = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return { request, dispose };
}

// 默认实例的重依赖按需动态加载：chatStreamStore 静态引用本模块，避免循环导入。
const runDefaultAutoSync = async (reason: string) => {
  const [{ useAppLifecycleStore }, { useSyncSessionStore }, { useChatStreamStore }] =
    await Promise.all([
      import("../stores/appLifecycle"),
      import("../stores/syncSession"),
      import("../stores/chatStreamStore"),
    ]);
  const phase = useAppLifecycleStore().lifecycleSnapshot?.phase;
  // 后台不发起；回到前台时会重新触发。
  if ((phase && phase !== "active") || (typeof document !== "undefined" && document.hidden)) {
    return;
  }
  const stream = useChatStreamStore();
  await useSyncSessionStore().runAutoSync(reason, {
    // 收尾会 performFullReload 当前话题，避开正在流式输出的消息。
    beforeClose: () =>
      waitUntil(
        () => Object.keys(stream.sessionActiveStreams).length === 0,
        STREAM_IDLE_TIMEOUT_MS,
      ),
  });
};

let sharedTrigger: AutoSyncTrigger | null = null;

export function requestAutoSync(reason: string): void {
  try {
    sharedTrigger ??= createAutoSyncTrigger({
      isReady: () => isAutoSyncReady(useSettingsStore().settings),
      run: runDefaultAutoSync,
    });
    sharedTrigger.request(reason);
  } catch (error) {
    console.warn(`[AutoSync] ${reason} request ignored:`, error);
  }
}
