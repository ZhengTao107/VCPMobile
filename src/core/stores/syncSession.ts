import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDataReload } from "../composables/useDataReload";
import { waitUntil } from "../sync/autoSyncTrigger";
import { useNotificationStore } from "./notification";
import { isAndroid, isIOS } from "../utils/platform";
import type { BatteryStatusDto } from "../types/native";
import { createSyncForegroundNotice, formatSyncBatchNoticeLabel, formatSyncNoticeLabel } from "../sync/syncForegroundNotice";
import { readSyncTopicSets, type SyncTopicSets } from "../sync/incrementalReload";

type SyncStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "completed"
  | "completed_with_warnings";

interface SyncSummary {
  successfulTopics: number;
  totalTopics: number;
  failedTopics: number;
  legacyAttachmentWarnings: number;
  failedTopicIds: string[];
  /** 完成事件携带的话题集合；旧版本不带或解析失败时为 null，收尾退回全量重载 */
  topicSets?: SyncTopicSets | null;
}

interface DesktopSyncInfo {
  packageVersion: string;
  backendMode: "legacy" | "cds";
}

interface SyncTerminalError {
  code: string;
  category:
    | "device"
    | "configuration"
    | "connection"
    | "compatibility"
    | "protocol"
    | "data"
    | "storage"
    | "internal";
  origin:
    | "mobile_ui"
    | "mobile_native"
    | "mobile_sync"
    | "desktop_plugin"
    | "desktop_cds";
  stage:
    | "preflight"
    | "startup"
    | "connect"
    | "handshake"
    | "owner_metadata"
    | "topic_metadata"
    | "topic_validation"
    | "messages"
    | "finalize"
    | "shutdown"
    | "history";
  retryAction: "automatic" | "after_user_action" | "manual" | "never";
  message: string;
  guidance: string;
  failedTopicIds: string[];
  logFile: string | null;
}

type BufferedSessionEvent = {
  kind: "status" | "progress" | "completed" | "log";
  payload: Record<string, unknown>;
};

const MAX_BUFFERED_SESSION_EVENTS = 32;
const AUTO_SYNC_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;
const ERROR_CATEGORIES = new Set<SyncTerminalError["category"]>([
  "device",
  "configuration",
  "connection",
  "compatibility",
  "protocol",
  "data",
  "storage",
  "internal",
]);
const ERROR_ORIGINS = new Set<SyncTerminalError["origin"]>([
  "mobile_ui",
  "mobile_native",
  "mobile_sync",
  "desktop_plugin",
  "desktop_cds",
]);
const ERROR_STAGES = new Set<SyncTerminalError["stage"]>([
  "preflight",
  "startup",
  "connect",
  "handshake",
  "owner_metadata",
  "topic_metadata",
  "topic_validation",
  "messages",
  "finalize",
  "shutdown",
  "history",
]);
const RETRY_ACTIONS = new Set<SyncTerminalError["retryAction"]>([
  "automatic",
  "after_user_action",
  "manual",
  "never",
]);

const LOCAL_ERROR_COPY: Record<
  string,
  Pick<
    SyncTerminalError,
    | "category"
    | "origin"
    | "stage"
    | "retryAction"
    | "message"
    | "guidance"
  >
> = {
  POWER_SAVE_MODE: {
    category: "device",
    origin: "mobile_native",
    stage: "preflight",
    retryAction: "after_user_action",
    message: "系统省电模式已阻止本次同步",
    guidance: "关闭系统省电模式后再试。",
  },
  BATTERY_TOO_LOW: {
    category: "device",
    origin: "mobile_native",
    stage: "preflight",
    retryAction: "after_user_action",
    message: "当前电量不足，已暂停同步",
    guidance: "电量达到 30% 后再试。",
  },
  LISTENER_SETUP_FAILED: {
    category: "internal",
    origin: "mobile_ui",
    stage: "startup",
    retryAction: "manual",
    message: "同步面板未能正常接收进度",
    guidance: "关闭并重新打开同步面板后再试。",
  },
  INVALID_COMPLETION_EVENT: {
    category: "protocol",
    origin: "mobile_ui",
    stage: "finalize",
    retryAction: "after_user_action",
    message: "同步响应不符合 Wire 1.5 规范，已安全停止",
    guidance: "确认两端版本一致并重启电脑端同步插件；若仍出现，请保留最新日志。",
  },
  START_SYNC_FAILED: {
    category: "internal",
    origin: "mobile_ui",
    stage: "startup",
    retryAction: "manual",
    message: "同步组件未能正常启动",
    guidance: "重启应用后再试；若仍失败，请保留最新同步日志。",
  },
  STOP_SYNC_FAILED: {
    category: "internal",
    origin: "mobile_ui",
    stage: "shutdown",
    retryAction: "manual",
    message: "上一同步任务未能正常结束",
    guidance: "重启应用后再试；若仍失败，请保留最新同步日志。",
  },
  WIRE_VERSION_MISMATCH: {
    category: "compatibility",
    origin: "mobile_sync",
    stage: "handshake",
    retryAction: "after_user_action",
    message: "手机端与电脑端 Wire 同步协议不兼容",
    guidance: "请更新 VChat 以同步最新插件；若两端版本差异较大，请同时更新 Mobile 与 VChat，并在电脑端运行 node rust_chat_data_service/build-runtime.js 重新编译 CDS，重启 VChat 后再试。",
  },
  CDS_BINARY_NOT_FOUND: {
    category: "configuration",
    origin: "desktop_cds",
    stage: "startup",
    retryAction: "after_user_action",
    message: "电脑端 CDS Rust 可执行文件不存在",
    guidance: "请更新 VChat 桌面端以同步插件代码，并在 VCPChat 根目录执行 node rust_chat_data_service/build-runtime.js 重新编译 CDS，重启电脑端后再试。",
  },
  CDS_PROTOCOL_MISMATCH: {
    category: "compatibility",
    origin: "desktop_cds",
    stage: "startup",
    retryAction: "after_user_action",
    message: "电脑端 CDS 数据服务协议版本不匹配",
    guidance: "请更新 VChat 桌面端以同步插件代码，并在 VCPChat 根目录执行 node rust_chat_data_service/build-runtime.js 重新编译 CDS，重启电脑端后再试。",
  },
  CDS_SCHEMA_MISMATCH: {
    category: "compatibility",
    origin: "desktop_cds",
    stage: "startup",
    retryAction: "after_user_action",
    message: "电脑端 CDS 数据库 Schema 版本不匹配",
    guidance: "请更新 VChat 桌面端以同步插件代码，并在 VCPChat 根目录执行 node rust_chat_data_service/build-runtime.js 重新编译 CDS，重启电脑端后再试。",
  },
  CDS_UNAVAILABLE: {
    category: "configuration",
    origin: "desktop_cds",
    stage: "startup",
    retryAction: "after_user_action",
    message: "电脑端 CDS 数据服务不可用或未就绪",
    guidance: "请更新 VChat 以同步插件，并在电脑端运行 node rust_chat_data_service/build-runtime.js 重新编译 CDS 后重启 VChat，以真正使用最新的 CDS 模式。",
  },
  CDS_STARTUP_FAILED: {
    category: "internal",
    origin: "desktop_cds",
    stage: "startup",
    retryAction: "manual",
    message: "电脑端 CDS 数据服务未能启动",
    guidance: "请更新 VChat 并确保依赖完整，在电脑端运行 node rust_chat_data_service/build-runtime.js 重新编译 CDS 后重启 VChat；若仍失败请查看电脑端同步日志。",
  },
  CONNECTION_REFUSED: {
    category: "connection",
    origin: "mobile_sync",
    stage: "connect",
    retryAction: "manual",
    message: "端口未开放：未能连接到电脑端同步服务",
    guidance: "确认电脑端 VChat 已启动且 VCPMobileSync 插件已运行；若启用了 CDS 模式，请确保已运行 node rust_chat_data_service/build-runtime.js 编译并启动。",
  },
  SYNC_ATTEMPT_FAILED: {
    category: "internal",
    origin: "mobile_ui",
    stage: "startup",
    retryAction: "manual",
    message: "同步未能完成",
    guidance: "可重试一次；若仍失败，请保留最新同步日志。",
  },
};

const diagnosticText = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value ?? "");
};

const localTerminalError = (code: string, detail?: unknown): SyncTerminalError => {
  const copy = LOCAL_ERROR_COPY[code] ?? LOCAL_ERROR_COPY.SYNC_ATTEMPT_FAILED;
  const rawMessage = detail === undefined ? "" : diagnosticText(detail).trim();
  return {
    code,
    ...copy,
    message: rawMessage || copy.message,
    failedTopicIds: [],
    logFile: null,
  };
};

const readSyncError = (value: unknown): SyncTerminalError | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(source.code) ||
    typeof source.category !== "string" ||
    !ERROR_CATEGORIES.has(source.category as SyncTerminalError["category"]) ||
    typeof source.origin !== "string" ||
    !ERROR_ORIGINS.has(source.origin as SyncTerminalError["origin"]) ||
    typeof source.stage !== "string" ||
    !ERROR_STAGES.has(source.stage as SyncTerminalError["stage"]) ||
    typeof source.retryAction !== "string" ||
    !RETRY_ACTIONS.has(
      source.retryAction as SyncTerminalError["retryAction"],
    ) ||
    typeof source.message !== "string" ||
    source.message.trim().length === 0 ||
    typeof source.guidance !== "string" ||
    source.guidance.trim().length === 0
  ) {
    return null;
  }
  const failedTopicIds = Array.isArray(source.failedTopicIds)
    ? source.failedTopicIds
        .filter(
          (id): id is string =>
            typeof id === "string" && id.length > 0 && id.length <= 512,
        )
    : [];
  const logFile =
    typeof source.logFile === "string" &&
    source.logFile.length > 0
      ? source.logFile
      : null;
  return {
    code: source.code,
    category: source.category as SyncTerminalError["category"],
    origin: source.origin as SyncTerminalError["origin"],
    stage: source.stage as SyncTerminalError["stage"],
    retryAction: source.retryAction as SyncTerminalError["retryAction"],
    message: source.message.trim(),
    guidance: source.guidance.trim(),
    failedTopicIds,
    logFile,
  };
};

const parseCommandError = (
  error: unknown,
  fallbackCode: string,
): SyncTerminalError => {
  const raw = error instanceof Error ? error.message : String(error);
  const marker = "SYNC_ERROR:";
  const markerIndex = raw.indexOf(marker);
  if (markerIndex >= 0) {
    try {
      const parsed = readSyncError(
        JSON.parse(raw.slice(markerIndex + marker.length)),
      );
      if (parsed) return parsed;
    } catch {}
  }
  return localTerminalError(fallbackCode, raw);
};

const PHASE_LABELS: Record<string, string> = {
  initialization: "初始化",
  owner_metadata: "元数据比对",
  topic_metadata: "会话主题同步",
  topic_validation: "会话校验",
  messages: "历史消息同步",
  finalize: "数据收尾",
};
const INDETERMINATE_PHASES = new Set([
  "initialization",
  "owner_metadata",
  "topic_validation",
  "finalize",
]);
// 这些阶段的 progress 只要 total>0，就说明本轮存在非 SKIP 写入操作（Rust 只为实际操作累加 total）。
const CHANGE_SIGNAL_PHASES = new Set([
  "owner_metadata",
  "topic_metadata",
  "messages",
]);

const emptySummary = (): SyncSummary => ({
  successfulTopics: 0,
  totalTopics: 0,
  failedTopics: 0,
  legacyAttachmentWarnings: 0,
  failedTopicIds: [],
});

export const useSyncSessionStore = defineStore("syncSession", () => {
  // --- 视图状态 ---
  const isOpen = ref(false);
  const canDismiss = ref(true);

  // --- 连接状态机 ---
  const status = ref<SyncStatus>("idle");
  const activeSessionId = ref<number | null>(null);
  const summary = ref<SyncSummary>(emptySummary());
  const terminalError = ref<SyncTerminalError | null>(null);
  const desktopInfo = ref<DesktopSyncInfo | null>(null);
  const retryInFlight = ref(false);

  // --- 面板视图 ---
  const activeTab = ref<"live" | "history">("live");

  // --- 同步进入写入阶段后需刷新标志（once-set，失败也可能已有部分提交） ---
  const needsReload = ref(false);

  // --- 日志与进度 ---
  const logs = ref<
    { id: string; level: string; message: string; time: string }[]
  >([]);
  const progressData = ref({
    phase: "initialization",
    total: 0,
    completed: 0,
  });

  // --- 监听器引用 ---
  let unlistenFns: UnlistenFn[] = [];
  let listenerSetup: Promise<void> | null = null;
  let settlement: Promise<void> | null = null;
  let shutdownPending = false;
  let viewGeneration = 0;
  let startAttempt = 0;
  let awaitingSessionId = false;
  let bufferedSessionEvents: BufferedSessionEvent[] = [];
  let lastLoggedPhase = "";
  let lastConnectionStatus = "";
  // 活进度行：阶段内原地刷新的单条日志，避免刷屏又保留进度感知
  let progressLineId: string | null = null;
  // 自动同步的无面板会话；用户打开面板时由 open() 接管并清除。
  const quiet = ref(false);
  // 手动同步运行中被收起的会话：面板已出栈，会话、监听器与进度照常推进；终态后自动收尾。
  const backgrounded = ref(false);
  // 自动同步收尾的跳过依据。前端拿不到 Rust 的 modified 话题集合，只能确认“本轮完全无写入”；
  // 任何写入信号（元数据/消息阶段 total>0、会话事件缓冲溢出）都保守视为有变化。
  let changeSignalSeen = false;
  let noChangeConfirmed = false;
  // 元数据阶段（owner/topic）有实际写入：话题集合只覆盖消息，此时增量刷新会漏掉列表变化，收尾必须全量。
  let metadataChangeSeen = false;
  // Rust 每批开始时下发的结构化批次进度（phase=message_batch），供通知栏显示「第 x/y 批」。
  const batchProgress = ref<{ index: number; total: number } | null>(null);

  const isCurrentView = (generation: number) =>
    isOpen.value && generation === viewGeneration;

  const isCurrentAttempt = (generation: number, attempt: number) =>
    isCurrentView(generation) && attempt === startAttempt;

  const isTerminal = () =>
    status.value === "error" ||
    status.value === "completed" ||
    status.value === "completed_with_warnings";

  const open = () => {
    if (isOpen.value && (quiet.value || backgrounded.value)) {
      // 后台会话进行中（自动同步或被收起的手动同步）：面板接管当前会话继续展示，不重置状态。
      quiet.value = false;
      backgrounded.value = false;
      return;
    }
    const generation = ++viewGeneration;
    startAttempt += 1;
    cleanupListeners();
    isOpen.value = true;
    canDismiss.value = true;
    status.value = "idle";
    activeSessionId.value = null;
    summary.value = emptySummary();
    terminalError.value = null;
    desktopInfo.value = null;
    retryInFlight.value = false;
    awaitingSessionId = false;
    bufferedSessionEvents = [];
    lastLoggedPhase = "";
    lastConnectionStatus = "";
    progressLineId = null;
    changeSignalSeen = false;
    noChangeConfirmed = false;
    metadataChangeSeen = false;
    batchProgress.value = null;
    activeTab.value = "live";
    logs.value = [];
    progressData.value = {
      phase: "initialization",
      total: 0,
      completed: 0,
    };
    listenerSetup = registerListeners(generation);
  };

  const setTerminalError = (error: SyncTerminalError) => {
    terminalError.value = error;
    status.value = "error";
    canDismiss.value = true;
  };

  const setLocalError = (code: string, detail?: unknown) => {
    setTerminalError(localTerminalError(code, detail));
  };

  const stopAndReload = (quietRun = false, skipUnchanged = quietRun): Promise<void> => {
    if (settlement) return settlement;
    shutdownPending = true;
    const work = (async () => {
      await invoke("stop_sync");
      shutdownPending = false;
      // STOP_PENDING is a rejection above: accepted writes are still draining.
      // Keep this flag across close/reopen until a real stop receipt is available.
      if (needsReload.value) {
        if (skipUnchanged && noChangeConfirmed) {
          // 无人值守的同步（自动或被收起）已确认本轮无任何写入：跳过整页重载，避免当前话题历史清空重建导致闪烁与滚动跳动。
          needsReload.value = false;
          noChangeConfirmed = false;
          return;
        }
        try {
          const reload = useDataReload();
          const incremental =
            skipUnchanged &&
            (await reload.performIncrementalReload(
              summary.value.topicSets ?? null,
              metadataChangeSeen,
            ));
          if (!incremental) await reload.performFullReload();
          needsReload.value = false;
        } catch (error) {
          console.error("[SyncSession] Failed to reload synchronized data:", error);
          if (!quietRun) useNotificationStore().addNotification({
            id: "sync_data_reload_failed",
            type: "error",
            title: "同步数据刷新失败",
            message: "界面未能重新加载同步后的数据。请重新打开同步面板重试。",
            toastOnly: false,
          });
        }
      }
    })();
    const completion: Promise<void> = work.finally(() => {
      if (settlement === completion) settlement = null;
    });
    settlement = completion;
    return completion;
  };

  const beginSync = async (preserveLogs: boolean, quietRun = false) => {
    if (status.value !== "idle") return;
    const generation = viewGeneration;
    const attempt = ++startAttempt;

    if (!preserveLogs) logs.value = [];
    progressData.value = {
      phase: "initialization",
      total: 0,
      completed: 0,
    };
    lastLoggedPhase = "";
    progressLineId = null;

    // 启动命令一旦进入异步链路，后端就可能在任意 await 后建立会话。
    // 必须在第一个 await 前锁定页面，避免系统返回卸载视图后留下隐形同步。
    status.value = "connecting";
    canDismiss.value = false;

    if (settlement || shutdownPending || needsReload.value) {
      try {
        await stopAndReload(quietRun);
      } catch (error) {
        if (isCurrentAttempt(generation, attempt)) {
          const terminal = parseCommandError(error, "STOP_SYNC_FAILED");
          pushLog("error", terminal.message);
          setTerminalError(terminal);
        }
        return;
      }
      if (!isCurrentAttempt(generation, attempt)) return;
    }

    try {
      await listenerSetup;
    } catch (error: unknown) {
      if (isCurrentAttempt(generation, attempt)) {
        console.error("[SyncSession] Failed to register sync listeners:", error);
        const terminal = localTerminalError("LISTENER_SETUP_FAILED", error);
        pushLog("error", terminal.message);
        setTerminalError(terminal);
      }
      return;
    }
    if (!isCurrentAttempt(generation, attempt)) return;

    // Native observations may omit the battery level, for example on an iPad
    // without an available reading. Unknown is not a successful high-battery check.
    if (isAndroid || isIOS) {
      try {
        const battery = await invoke<BatteryStatusDto>(
          "plugin:vcp-mobile|get_battery_status",
        );
        if (!isCurrentAttempt(generation, attempt)) return;
        if (battery) {
          if (battery.isPowerSaveMode) {
            const terminal = localTerminalError("POWER_SAVE_MODE");
            pushLog("error", terminal.message);
            setTerminalError(terminal);

            return;
          }
          const level = battery.level;
          const levelKnown = typeof level === "number" && Number.isFinite(level) && level >= 0 && level <= 100;
          if (levelKnown && level < 30) {
            const terminal = localTerminalError("BATTERY_TOO_LOW");
            pushLog("error", terminal.message);
            setTerminalError(terminal);

            return;
          }
          if (!quietRun) pushLog(levelKnown ? "success" : "warning", levelKnown
            ? "设备状态检查完成"
            : "无法确认当前电量，将继续同步");
        } else if (!quietRun) {
          pushLog("warning", "无法确认设备状态，将继续同步");
        }
      } catch (error: unknown) {
        if (!isCurrentAttempt(generation, attempt)) return;
        if (!quietRun) pushLog("warning", "无法确认设备状态，将继续同步");
        console.warn("Get battery status failed, continuing sync:", error);
      }
    } else if (!quietRun) {
      pushLog("warning", "无法确认设备状态，将继续同步");
    }

    if (!isCurrentAttempt(generation, attempt)) return;
    changeSignalSeen = false;
    noChangeConfirmed = false;
    metadataChangeSeen = false;
    batchProgress.value = null;
    awaitingSessionId = true;
    bufferedSessionEvents = [];
    try {
      const sessionId = await invoke<number>("start_manual_sync");
      if (!isCurrentAttempt(generation, attempt)) return;
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        throw new Error("start_manual_sync 未返回有效 session ID");
      }
      activeSessionId.value = sessionId;
      awaitingSessionId = false;
      const pending = bufferedSessionEvents;
      bufferedSessionEvents = [];
      for (const event of pending) {
        if (event.payload.sessionId === sessionId) {
          applySessionEvent(event.kind, event.payload);
        }
      }
    } catch (e: unknown) {
      awaitingSessionId = false;
      bufferedSessionEvents = [];
      if (isCurrentAttempt(generation, attempt)) {
        const terminal = parseCommandError(e, "START_SYNC_FAILED");
        pushLog("error", terminal.message);
        setTerminalError(terminal);
      }
    }
  };

  const startSync = () => beginSync(false);

  const retrySync = async () => {
    if (retryInFlight.value || !isTerminal()) return;
    if (
      status.value === "error" &&
      terminalError.value &&
      !["manual", "after_user_action"].includes(
        terminalError.value.retryAction,
      )
    ) {
      return;
    }
    const generation = viewGeneration;
    const retryAttempt = ++startAttempt;
    retryInFlight.value = true;
    canDismiss.value = false;
    activeSessionId.value = null;
    awaitingSessionId = false;
    bufferedSessionEvents = [];
    try {
      await stopAndReload();
      if (!isCurrentAttempt(generation, retryAttempt)) return;
      pushLog("info", "──────── 新同步尝试 ────────");
      status.value = "idle";
      terminalError.value = null;
      desktopInfo.value = null;
      summary.value = emptySummary();
      lastLoggedPhase = "";
      lastConnectionStatus = "";
      progressLineId = null;
      progressData.value = {
        phase: "initialization",
        total: 0,
        completed: 0,
      };
      await beginSync(true);
    } catch (error: unknown) {
      if (isCurrentView(generation)) {
        const terminal = parseCommandError(error, "STOP_SYNC_FAILED");
        pushLog("error", terminal.message);
        setTerminalError(terminal);
      }
    } finally {
      if (isCurrentView(generation)) retryInFlight.value = false;
    }
  };

  const close = async () => {
    if (!isOpen.value || !canDismiss.value) return;
    viewGeneration += 1;
    startAttempt += 1;
    isOpen.value = false;
    activeSessionId.value = null;
    desktopInfo.value = null;
    awaitingSessionId = false;
    bufferedSessionEvents = [];
    retryInFlight.value = false;
    activeTab.value = "live";
    cleanupListeners();
    listenerSetup = null;
    const quietRun = quiet.value;
    // 无人值守（自动同步或被收起的手动同步）收尾时沿用无写入短路；面板前手动关闭仍整页刷新。
    const unattended = quietRun || backgrounded.value;
    quiet.value = false;
    backgrounded.value = false;

    try {
      await stopAndReload(quietRun, unattended);
    } catch (e) {
      console.warn("[SyncSession] Failed to stop backend sync session:", e);
      if (quietRun) return;
      const terminal = parseCommandError(e, "STOP_SYNC_FAILED");
      useNotificationStore().addNotification({
        id: "sync_shutdown_pending",
        type: "warning",
        title: "同步尚未完成收尾",
        message: `${terminal.message} ${terminal.guidance}`,
        toastOnly: false,
      });
    }
  };

  /**
   * 收起面板但不打断同步：会话转为后台，监听器与状态保持不变，终态后由下方 watch 收尾。
   * 只在会话不可直接关闭（运行中）时生效并返回 true；可关闭时调用方应走 close()。
   */
  const hide = () => {
    if (!isOpen.value || quiet.value || canDismiss.value) return false;
    backgrounded.value = true;
    return true;
  };

  /**
   * 显式取消：运行中唯一会调用 stop_sync 的入口（二次确认由调用方负责）。
   * start_manual_sync 返回会话号之前不允许取消，避免 Rust 侧随后建立无人认领的会话。
   */
  const cancel = async () => {
    if (!isOpen.value || quiet.value) return false;
    if (status.value !== "connecting" && status.value !== "connected") return false;
    if (activeSessionId.value === null) return false;
    pushLog("warning", "已取消同步");
    canDismiss.value = true;
    await close();
    return true;
  };

  /**
   * 自动同步：不挂面板的一次完整会话（open → beginSync → 等终态 → close 刷新）。
   * 面板已打开或已有会话时让位；运行中用户打开面板则由面板接管，本函数不再关闭。
   */
  const runAutoSync = async (
    reason: string,
    options: { beforeClose?: () => Promise<unknown> } = {},
  ): Promise<"skipped" | "taken_over" | "timeout" | "completed" | "error"> => {
    if (isOpen.value) return "skipped";
    open();
    quiet.value = true;
    const generation = viewGeneration;
    const owned = () => quiet.value && isCurrentView(generation);
    await beginSync(false, true);
    if (owned() && !isTerminal()) {
      await waitUntil(() => !owned() || isTerminal(), AUTO_SYNC_SETTLE_TIMEOUT_MS);
    }
    if (!owned()) return "taken_over";
    if (!isTerminal()) {
      console.warn(`[AutoSync] ${reason}: 同步会话超时未结束，留给同步面板接管`);
      return "timeout";
    }
    const outcome = status.value === "error" ? "error" : "completed";
    if (outcome === "error" && terminalError.value) {
      const e = terminalError.value;
      console.warn(
        `[AutoSync] ${reason} failed: ${e.code} ${e.message}${e.logFile ? ` (log: ${e.logFile})` : ""}`,
      );
    }
    if (options.beforeClose) {
      await options.beforeClose().catch((error) => {
        console.warn("[AutoSync] beforeClose failed:", error);
      });
    }
    if (owned() && canDismiss.value) await close();
    return outcome;
  };

  // 被收起的手动同步到达终态即收尾（stop + 按需刷新），失败也不例外：
  // 残留 isOpen 会让 runAutoSync 一直 skipped。失败详情保留在同步历史日志中。
  watch(status, (next) => {
    if (!backgrounded.value || !isOpen.value || !isTerminal()) return;
    const notifications = useNotificationStore();
    if (next === "error") {
      notifications.addNotification({
        id: "sync_background_failed",
        type: "error",
        title: "同步未完成",
        message: `${terminalError.value?.message ?? "同步未能完成"} 已写入的数据已保留；打开同步面板可重新同步，详情见历史日志。`,
        toastOnly: false,
      });
      void close();
      return;
    }
    notifications.addNotification({
      id: "sync_background_completed",
      type: next === "completed_with_warnings" ? "warning" : "success",
      title: "同步已完成",
      message: next === "completed_with_warnings"
        ? `消息已同步，${summary.value.legacyAttachmentWarnings} 项旧附件信息无法安全识别已跳过；请在电脑端重新发送这些附件后再同步。`
        : `已同步 ${summary.value.successfulTopics} 个话题。`,
      toastOnly: next !== "completed_with_warnings",
    });
    void close();
  });

  // Android 通知栏进度：只为用户发起的同步挂文案（自动同步不打扰）；离开运行态即释放。
  const foregroundNotice = createSyncForegroundNotice();
  watch(
    () => {
      if (!isAndroid || !isOpen.value || quiet.value) return null;
      if (status.value !== "connecting" && status.value !== "connected") return null;
      const { phase, completed, total } = progressData.value;
      const batch = batchProgress.value;
      if (phase === "messages" && batch && batch.total > 1) {
        return formatSyncBatchNoticeLabel(batch.index, batch.total);
      }
      return formatSyncNoticeLabel(PHASE_LABELS[phase] ?? "同步处理", completed, total);
    },
    (label) => {
      if (label === null) foregroundNotice.hide();
      else foregroundNotice.show(label);
    },
  );

  const readSummary = (value: unknown): SyncSummary | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const readCount = (key: string) => {
      const count = source[key];
      return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
        ? count
        : null;
    };
    const successfulTopics = readCount("successfulTopics");
    const totalTopics = readCount("totalTopics");
    const failedTopics = readCount("failedTopics");
    const legacyAttachmentWarnings = readCount("legacyAttachmentWarnings");
    if (
      successfulTopics === null ||
      totalTopics === null ||
      failedTopics === null ||
      legacyAttachmentWarnings === null ||
      !Array.isArray(source.failedTopicIds) ||
      source.failedTopicIds.some(
        (id) => typeof id !== "string" || id.length === 0,
      )
    ) {
      return null;
    }
    const allFailedTopicIds = source.failedTopicIds as string[];
    if (
      new Set(allFailedTopicIds).size !== allFailedTopicIds.length ||
      allFailedTopicIds.length > failedTopics ||
      successfulTopics + failedTopics !== totalTopics
    ) {
      return null;
    }
    return {
      successfulTopics,
      totalTopics,
      failedTopics,
      legacyAttachmentWarnings,
      failedTopicIds: allFailedTopicIds,
      topicSets: readSyncTopicSets(source),
    };
  };

  const readDesktopInfo = (value: unknown): DesktopSyncInfo | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    if (
      typeof source.packageVersion !== "string" ||
      source.packageVersion.length === 0 ||
      (source.backendMode !== "legacy" && source.backendMode !== "cds")
    ) {
      return null;
    }
    return {
      packageVersion: source.packageVersion,
      backendMode: source.backendMode,
    };
  };

  const readProgressSummary = (
    payload: Record<string, unknown>,
  ): Omit<SyncSummary, "failedTopicIds"> | null => {
    const keys = [
      "successfulTopics",
      "totalTopics",
      "failedTopics",
      "legacyAttachmentWarnings",
    ] as const;
    const counts = keys.map((key) => payload[key]);
    if (
      counts.some(
        (count) =>
          typeof count !== "number" ||
          !Number.isSafeInteger(count) ||
          count < 0,
      )
    ) {
      return null;
    }
    const [successfulTopics, totalTopics, failedTopics, legacyAttachmentWarnings] =
      counts as number[];
    if (successfulTopics + failedTopics > totalTopics) return null;
    return {
      successfulTopics,
      totalTopics,
      failedTopics,
      legacyAttachmentWarnings,
    };
  };

  const readTerminalError = (
    payload: Record<string, unknown>,
  ): SyncTerminalError => {
    return (
      readSyncError(payload.error) ??
      localTerminalError("SYNC_ATTEMPT_FAILED", payload.error)
    );
  };

  // 阶段内进度以「活进度行」呈现：原地刷新同一条日志，既保留进度感知又不刷屏。
  // 阶段完成或切换时定格该行，使其作为普通历史行留在日志中。
  const updateLiveProgressLine = (
    phase: string,
    completed: number,
    total: number,
  ) => {
    const text =
      phase === "messages"
        ? `已同步会话 ${completed}/${total}`
        : `${PHASE_LABELS[phase] ?? "同步处理"}进度 ${completed}/${total}`;
    const existing = progressLineId
      ? logs.value.find((l) => l.id === progressLineId)
      : undefined;
    if (existing) {
      if (existing.message !== text) existing.message = text;
    } else {
      pushLog("info", text);
      progressLineId = logs.value[logs.value.length - 1]?.id ?? null;
    }
  };

  const applySessionEvent = (
    kind: BufferedSessionEvent["kind"],
    payload: Record<string, unknown>,
  ) => {
    if (kind === "log") {
      if (
        payload.audience === "operator" &&
        typeof payload.message === "string" &&
        payload.message.trim().length > 0
      ) {
        pushLog(
          typeof payload.level === "string" ? payload.level : "info",
          payload.message.trim(),
        );
      }
      return;
    }

    if (kind === "progress") {
      if (isTerminal()) return;
      if (payload.phase === "message_batch") {
        const index = payload.batchIndex;
        const total = payload.batchTotal;
        if (
          typeof index === "number" &&
          typeof total === "number" &&
          Number.isSafeInteger(index) &&
          Number.isSafeInteger(total) &&
          index >= 1 &&
          total >= index
        ) {
          batchProgress.value = { index, total };
        }
        return;
      }
      const reportedPhase =
        typeof payload.phase === "string"
          ? payload.phase
          : progressData.value.phase;
      if (!Object.prototype.hasOwnProperty.call(PHASE_LABELS, reportedPhase)) {
        return;
      }
      const nextPhase = reportedPhase;
      if (
        CHANGE_SIGNAL_PHASES.has(nextPhase) &&
        typeof payload.total === "number" &&
        payload.total > 0
      ) {
        changeSignalSeen = true;
        if (nextPhase !== "messages") metadataChangeSeen = true;
      }
      const indeterminate = INDETERMINATE_PHASES.has(nextPhase);
      const nextTotal = indeterminate
        ? 0
        : typeof payload.total === "number" &&
            Number.isSafeInteger(payload.total) &&
            payload.total >= 0
          ? payload.total
          : progressData.value.total;
      const nextCompleted = indeterminate
        ? 0
        : typeof payload.completed === "number" &&
            Number.isSafeInteger(payload.completed) &&
            payload.completed >= 0
          ? payload.completed
          : progressData.value.completed;
      progressData.value = {
        phase: nextPhase,
        total: nextTotal,
        completed: nextCompleted,
      };
      if (nextPhase !== lastLoggedPhase) {
        progressLineId = null; // 定格上一阶段的进度行
        pushLog("info", `开始${PHASE_LABELS[nextPhase] ?? "同步处理"}`);
        lastLoggedPhase = nextPhase;
      }
      if (nextTotal > 0) {
        updateLiveProgressLine(nextPhase, nextCompleted, nextTotal);
      }
      const nextSummary = readProgressSummary(payload);
      if (nextSummary) {
        summary.value = { ...summary.value, ...nextSummary };
      }
      return;
    }

    if (kind === "status") {
      const nextStatus = payload.status;
      if (nextStatus === "error") {
        if (
          status.value === "completed" ||
          status.value === "completed_with_warnings"
        ) {
          return;
        }
        terminalError.value = readTerminalError(payload);
        pushLog("error", terminalError.value.message);
        const failedTopics = Math.max(
          summary.value.failedTopics,
          terminalError.value.failedTopicIds.length,
        );
        summary.value = {
          ...summary.value,
          failedTopics,
          totalTopics: Math.max(
            summary.value.totalTopics,
            summary.value.successfulTopics + failedTopics,
          ),
          failedTopicIds: terminalError.value.failedTopicIds,
        };
        status.value = "error";
        canDismiss.value = true;
        return;
      }
      if (isTerminal()) return;
      if (nextStatus === "open") {
        desktopInfo.value = readDesktopInfo(payload.desktop);
        needsReload.value = true;
        status.value = "connected";
        canDismiss.value = false;
        if (lastConnectionStatus !== "open") {
          pushLog("success", "已连接电脑端，开始同步");
          lastConnectionStatus = "open";
        }
      } else if (nextStatus === "connecting") {
        desktopInfo.value = null;
        status.value = "connecting";
        canDismiss.value = false;
        if (lastConnectionStatus !== "connecting") {
          pushLog("info", "正在连接电脑端同步服务");
          lastConnectionStatus = "connecting";
        }
      } else if (
        nextStatus === "completed" ||
        nextStatus === "completed_with_warnings"
      ) {
        // The completed event carries the mandatory summary and is the only
        // authoritative success transition. A status-only terminal frame cannot
        // manufacture success or bypass summary validation.
        return;
      }
      return;
    }

    if (status.value === "error") return;
    if (
      payload.status !== "completed" &&
      payload.status !== "completed_with_warnings"
    ) {
      pushLog("error", "完成事件协议错误: status 非法");
      setLocalError(
        "INVALID_COMPLETION_EVENT",
        `完成事件 status 非法: ${diagnosticText(payload.status)}`,
      );
      return;
    }
    const completedSummary = readSummary(payload.summary);
    if (!completedSummary) {
      pushLog("error", "完成事件协议错误: summary 非法");
      setLocalError(
        "INVALID_COMPLETION_EVENT",
        `完成事件 summary 非法: ${diagnosticText(payload.summary)}`,
      );
      return;
    }
    if (
      completedSummary.failedTopics !== 0 ||
      completedSummary.failedTopicIds.length !== 0 ||
      (payload.status === "completed" &&
        completedSummary.legacyAttachmentWarnings !== 0) ||
      (payload.status === "completed_with_warnings" &&
        completedSummary.legacyAttachmentWarnings === 0)
    ) {
      pushLog("error", "完成事件协议错误: status 与 summary 不一致");
      setLocalError(
        "INVALID_COMPLETION_EVENT",
        `完成事件 status 与 summary 不一致: status=${diagnosticText(payload.status)} summary=${diagnosticText(payload.summary)}`,
      );
      return;
    }
    summary.value = completedSummary;
    noChangeConfirmed = !changeSignalSeen && completedSummary.totalTopics === 0;
    status.value = payload.status;
    canDismiss.value = true;
    needsReload.value = true;
    pushLog(
      status.value === "completed_with_warnings" ? "warning" : "success",
      status.value === "completed_with_warnings"
        ? `消息已同步，${completedSummary.legacyAttachmentWarnings} 项旧附件信息无法安全识别，已跳过`
        : "同步已全部完成，点击关闭以刷新数据",
    );
  };

  const routeSessionEvent = (
    kind: BufferedSessionEvent["kind"],
    rawPayload: unknown,
  ) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as Record<string, unknown>;
    const sessionId = payload.sessionId;
    if (!Number.isSafeInteger(sessionId) || (sessionId as number) <= 0) return;
    if (activeSessionId.value === sessionId) {
      applySessionEvent(kind, payload);
      return;
    }
    if (activeSessionId.value === null && awaitingSessionId) {
      bufferedSessionEvents.push({ kind, payload });
      if (bufferedSessionEvents.length > MAX_BUFFERED_SESSION_EVENTS) {
        bufferedSessionEvents.shift();
        // 丢弃的早期事件里可能有写入信号，不能再断言“无变化”。
        changeSignalSeen = true;
      }
    }
  };

  const registerListener = async (
    generation: number,
    eventName: string,
    callback: (payload: unknown) => void,
  ) => {
    const fn = await listen<unknown>(eventName, (event) => {
      if (isCurrentView(generation)) callback(event.payload);
    });
    if (!isCurrentView(generation)) {
      fn();
      return;
    }
    unlistenFns.push(fn);
  };

  const registerListeners = async (generation: number) => {
    await Promise.all([
      registerListener(generation, "vcp-log", (rawPayload) => {
        if (!rawPayload || typeof rawPayload !== "object") return;
        const payload = rawPayload as Record<string, unknown>;
        const { audience, category } = payload;
        if (category === "sync" && audience === "operator") {
          routeSessionEvent("log", payload);
        }
      }),

      registerListener(generation, "vcp-sync-progress", (payload) =>
        routeSessionEvent("progress", payload),
      ),

      registerListener(generation, "vcp-sync-status", (payload) =>
        routeSessionEvent("status", payload),
      ),

      registerListener(generation, "vcp-sync-completed", (payload) =>
        routeSessionEvent("completed", payload),
      ),
    ]);
  };

  const cleanupListeners = () => {
    unlistenFns.forEach((fn) => fn());
    unlistenFns = [];
  };

  const pushLog = (level: string, message: string) => {
    const id = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    logs.value.push({
      id,
      level,
      message,
      time: new Date().toLocaleTimeString(),
    });
    if (logs.value.length > 200) logs.value.shift();
  };

  const switchTab = (tab: "live" | "history") => {
    if (status.value === "connecting" || status.value === "connected") return;
    activeTab.value = tab;
  };

  return {
    isOpen,
    backgrounded,
    canDismiss,
    status,
    activeSessionId,
    summary,
    terminalError,
    desktopInfo,
    retryInFlight,
    needsReload,
    logs,
    progressData,
    activeTab,
    open,
    close,
    hide,
    cancel,
    startSync,
    retrySync,
    runAutoSync,
    switchTab,
  };
});
