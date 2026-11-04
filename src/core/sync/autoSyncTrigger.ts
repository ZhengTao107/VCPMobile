import { watch } from "vue";
import { useSettingsStore, type AppSettings } from "../stores/settings";
import type { ConversationKey } from "../stores/chatSessionStore";

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
  if (!settings || settings.sync.autoSync === false) return false;
  const url = settings.sync.serverUrl;
  const token = settings.sync.token;
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

type ConversationRef = Pick<ConversationKey, "ownerId" | "ownerType" | "topicId">;

/**
 * 只等当前打开的会话停止流式输出。收尾若需重载，performFullReload 会清 AST 缓存、重拉
 * agents/groups 与头像、作废全部话题缓存，并重建当前 owner 话题列表与当前话题历史（先清空再载入）；
 * 本轮确认无写入时 syncSession 跳过重载。后台话题的流对象留在 chatStreamStore 池里，不受重载影响。
 * 当前会话在等待期间切换时谓词会重新求值。
 */
export const waitForCurrentConversationIdle = (
  stream: { isConversationStreaming: (key: ConversationRef | null | undefined) => boolean },
  session: { currentConversationKey: ConversationRef | null },
  timeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): Promise<boolean> =>
  waitUntil(() => !stream.isConversationStreaming(session.currentConversationKey), timeoutMs);

/** 电脑端变化提示触发的同步：静默窗口合并，且两轮之间至少间隔这么久。 */
export const REMOTE_HINT_QUIET_MS = 3000;
export const REMOTE_HINT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_THROTTLED_REASONS: ReadonlySet<string> = new Set(["remote-hint"]);

export interface AutoSyncTriggerOptions {
  isReady: () => boolean;
  run: (reason: string) => Promise<unknown>;
  delayMs?: number;
  /** 走节流的来源（默认只有 remote-hint）；其余来源保持原防抖。 */
  throttledReasons?: ReadonlySet<string>;
  throttleQuietMs?: number;
  throttleMinIntervalMs?: number;
  now?: () => number;
}

export interface AutoSyncTrigger {
  request: (reason: string) => void;
  dispose: () => void;
}

export function createAutoSyncTrigger(
  options: AutoSyncTriggerOptions,
): AutoSyncTrigger {
  const delayMs = options.delayMs ?? AUTO_SYNC_DEBOUNCE_MS;
  const throttled = options.throttledReasons ?? DEFAULT_THROTTLED_REASONS;
  const quietMs = options.throttleQuietMs ?? REMOTE_HINT_QUIET_MS;
  const minIntervalMs = options.throttleMinIntervalMs ?? REMOTE_HINT_MIN_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerThrottled = false;
  let running = false;
  let pendingReason: string | null = null;
  let lastReason = "";
  let lastRunAt = Number.NEGATIVE_INFINITY;
  // 本批节流提示的最迟触发时刻：持续有变化时也保证到点跑一轮。
  let throttleCapAt: number | null = null;
  let disposed = false;

  const isThrottled = (reason: string) => throttled.has(reason);

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const fire = async () => {
    timer = null;
    timerThrottled = false;
    throttleCapAt = null;
    if (disposed || !options.isReady()) return;
    running = true;
    lastRunAt = now();
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
      // 非节流来源（消息完成、回前台）优先保留，不被提示覆盖。
            if (!isThrottled(reason) || pendingReason === null || isThrottled(pendingReason)) {
        pendingReason = reason;
      }
      return;
    }
    if (!isThrottled(reason)) {
      lastReason = reason;
      clearTimer();
      timerThrottled = false;
      throttleCapAt = null;
      timer = setTimeout(() => void fire(), delayMs);
      return;
    }
    // 已排了一次立即同步，它会一并覆盖这次提示。
    if (timer && !timerThrottled) return;
    const t = now();
    throttleCapAt ??= Math.max(t, lastRunAt) + minIntervalMs;
    const dueAt = Math.min(throttleCapAt, Math.max(t + quietMs, lastRunAt + minIntervalMs));
    lastReason = reason;
    clearTimer();
    timerThrottled = true;
    timer = setTimeout(() => void fire(), Math.max(0, dueAt - t));
  };

  const dispose = () => {
    disposed = true;
    pendingReason = null;
    throttleCapAt = null;
    clearTimer();
  };

  return { request, dispose };
}

// 默认实例的重依赖按需动态加载：chatStreamStore 静态引用本模块，避免循环导入。
const runDefaultAutoSync = async (reason: string) => {
  const [
    { useAppLifecycleStore },
    { useSyncSessionStore },
    { useChatStreamStore },
    { useChatSessionStore },
  ] = await Promise.all([
    import("../stores/appLifecycle"),
    import("../stores/syncSession"),
    import("../stores/chatStreamStore"),
    import("../stores/chatSessionStore"),
  ]);
  const phase = useAppLifecycleStore().lifecycleSnapshot?.phase;
  // 后台不发起；回到前台时会重新触发。
  if ((phase && phase !== "active") || (typeof document !== "undefined" && document.hidden)) {
    return;
  }
  const stream = useChatStreamStore();
  const session = useChatSessionStore();
  await useSyncSessionStore().runAutoSync(reason, {
    // 收尾可能 performFullReload 当前话题：只避开当前会话的流，后台话题生成不阻塞。
    // 注意：start_manual_sync 的 Rust 预检仍在任一 active_generations 存在时拒绝启动。
    beforeClose: () => waitForCurrentConversationIdle(stream, session),
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
