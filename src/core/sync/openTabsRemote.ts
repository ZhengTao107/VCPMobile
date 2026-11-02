import { reactive, shallowReactive, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getActivePinia } from "pinia";
import { useSettingsStore, type AppSettings } from "../stores/settings";
import { openTabKey, useOpenTabsStore, type OpenTabRef } from "../stores/openTabsStore";
import type { ConversationOwnerType } from "../stores/chatSessionStore";
import { hintTargetFromSettings, onRemoteHint, type HintTarget } from "./remoteChangeHint";

/**
 * 三端互看已打开标签（ptp4g#36，方案 B：只看不改）的客户端。
 *
 * - 上报：本机标签（身份与顺序）变化后防抖 2s，PUT {syncHttpUrl}/api/open-tabs/device/{deviceId}。
 * - 获取：打开「⋯」面板时、收到电脑端变化提示时、面板打开期间每 30s，
 *   GET {syncHttpUrl}/api/open-tabs/snapshot，并过滤掉本机。
 * - 404/503 视为电脑端未启用，只在面板里显示，不弹窗。
 * - autoSync 关闭或缺 syncHttpUrl/Token 时整段不运行（与 remoteChangeHint 同一判定）。
 * - HTTP 经 Rust command（open_tabs_get / open_tabs_put）发出，原因见 sync/open_tabs.rs。
 */
export const OPEN_TABS_REPORT_DEBOUNCE_MS = 2_000;
export const OPEN_TABS_POLL_MS = 30_000;
/** 设备快照超过此时长未更新即显示“离线 N 分钟”。上报只在标签变化时发生，属估计口径。 */
export const OPEN_TABS_OFFLINE_AFTER_MS = 10 * 60_000;
export const OPEN_TABS_DEVICE_ID_KEY = "vcp_open_tabs_device_id_v1";
export const OPEN_TABS_DEVICE_KIND = "android";
export const UNSYNCED_TOPIC_TITLE = "未同步的话题";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface RemoteOpenTab extends OpenTabRef {
  order: number;
}

export interface RemoteDevice {
  deviceId: string;
  deviceName: string;
  kind: string;
  updatedAt: number;
  tabs: RemoteOpenTab[];
}

export interface OpenTabsSnapshot {
  revision: number;
  devices: RemoteDevice[];
}

export interface OpenTabsHttpResponse {
  status: number;
  body: unknown;
}

export interface OpenTabsReportBody {
  deviceName: string;
  kind: typeof OPEN_TABS_DEVICE_KIND;
  tabs: RemoteOpenTab[];
}

export const isValidDeviceId = (value: unknown): value is string =>
  typeof value === "string" && DEVICE_ID_PATTERN.test(value);

const isOwnerType = (value: unknown): value is ConversationOwnerType =>
  value === "agent" || value === "group";
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const randomHex = (length: number) => {
  const bytes = new Uint8Array(length);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export type DeviceIdStorage = Pick<Storage, "getItem" | "setItem">;
let memoryDeviceId: string | null = null;

/** 本机设备号：首次生成后持久化；存储不可用时退回进程内单例。 */
export function getOrCreateDeviceId(
  storage: DeviceIdStorage | null,
  generate: () => string = () => `android-${randomHex(12)}`,
): string {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(OPEN_TABS_DEVICE_ID_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (isValidDeviceId(stored)) return stored;
  if (!storage && memoryDeviceId) return memoryDeviceId;
  const created = generate();
  if (!isValidDeviceId(created)) throw new Error("generated device id is invalid");
  try {
    storage?.setItem(OPEN_TABS_DEVICE_ID_KEY, created);
  } catch {
    // 存储写失败时本次进程内仍使用同一个号。
  }
  memoryDeviceId = created;
  return created;
}

const parseRemoteTabs = (value: unknown): RemoteOpenTab[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabs: RemoteOpenTab[] = [];
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const record = raw as Record<string, unknown>;
    if (
      !isOwnerType(record.ownerType) ||
      !isNonEmptyString(record.ownerId) ||
      !isNonEmptyString(record.topicId)
    ) {
      return;
    }
    const tab: RemoteOpenTab = {
      ownerType: record.ownerType,
      ownerId: record.ownerId,
      topicId: record.topicId,
      order: isFiniteNumber(record.order) ? record.order : index,
    };
    const key = openTabKey(tab);
    if (seen.has(key)) return;
    seen.add(key);
    tabs.push(tab);
  });
  return tabs.sort((a, b) => a.order - b.order);
};

/** 校验快照并去掉本机；格式不符返回 null。设备按更新时间新到旧，标签按 order。 */
export function parseSnapshot(body: unknown, selfDeviceId: string): OpenTabsSnapshot | null {
  if (!body || typeof body !== "object") return null;
  const { revision, devices } = body as Record<string, unknown>;
  if (!Array.isArray(devices)) return null;
  const parsed: RemoteDevice[] = [];
  for (const raw of devices) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (!isValidDeviceId(record.deviceId) || record.deviceId === selfDeviceId) continue;
    parsed.push({
      deviceId: record.deviceId,
      deviceName: isNonEmptyString(record.deviceName) ? record.deviceName : record.deviceId,
      kind: isNonEmptyString(record.kind) ? record.kind : "unknown",
      updatedAt:
        isFiniteNumber(record.updatedAt) && record.updatedAt > 0 ? record.updatedAt : 0,
      tabs: parseRemoteTabs(record.tabs),
    });
  }
  parsed.sort((a, b) => b.updatedAt - a.updatedAt);
  return { revision: isFiniteNumber(revision) ? revision : 0, devices: parsed };
}

/** 设备分组副标题：近期显示“N 分钟前更新”，超过离线阈值显示“离线 N 分钟/小时/天”。 */
export function formatDeviceFreshness(updatedAt: number, now: number): string {
  if (!updatedAt) return "更新时间未知";
  const age = Math.max(0, now - updatedAt);
  const minutes = Math.floor(age / 60_000);
  if (age >= OPEN_TABS_OFFLINE_AFTER_MS) {
    if (minutes < 60) return `离线 ${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `离线 ${hours} 小时`;
    return `离线 ${Math.floor(hours / 24)} 天`;
  }
  return minutes < 1 ? "刚刚更新" : `${minutes} 分钟前更新`;
}

export const toReportTabs = (tabs: readonly OpenTabRef[]): RemoteOpenTab[] =>
  tabs.map((tab, order) => ({
    ownerType: tab.ownerType,
    ownerId: tab.ownerId,
    topicId: tab.topicId,
    order,
  }));

export type OpenTabsRemoteStatus = "idle" | "loading" | "ok" | "unavailable" | "error";

export interface OpenTabsRemoteState {
  status: OpenTabsRemoteStatus;
  devices: RemoteDevice[];
  fetchedAt: number | null;
}

export interface OpenTabsRemoteApi {
  readonly state: OpenTabsRemoteState;
  enabled: () => boolean;
  refresh: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

export interface OpenTabsRemote extends OpenTabsRemoteApi {
  scheduleReport: (tabs: RemoteOpenTab[]) => void;
  dispose: () => void;
}

export interface OpenTabsRemoteDeps {
  getTarget: () => HintTarget | null;
  deviceId: string;
  deviceName: () => string;
  fetchSnapshot: (target: HintTarget) => Promise<OpenTabsHttpResponse>;
  putDevice: (
    target: HintTarget,
    deviceId: string,
    body: OpenTabsReportBody,
  ) => Promise<OpenTabsHttpResponse>;
  now?: () => number;
}

const isDisabledStatus = (status: number) => status === 404 || status === 503;

export function createOpenTabsRemote(deps: OpenTabsRemoteDeps): OpenTabsRemote {
  const now = deps.now ?? Date.now;
  const state = reactive<OpenTabsRemoteState>({ status: "idle", devices: [], fetchedAt: null });
  let reportTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTabs: RemoteOpenTab[] | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let fetchSeq = 0;
  let disposed = false;

  const flushReport = async () => {
    reportTimer = null;
    const tabs = pendingTabs;
    pendingTabs = null;
    const target = deps.getTarget();
    if (!tabs || !target || disposed) return;
    try {
      const response = await deps.putDevice(target, deps.deviceId, {
        deviceName: deps.deviceName(),
        kind: OPEN_TABS_DEVICE_KIND,
        tabs,
      });
      if (response.status >= 400 && !isDisabledStatus(response.status)) {
        console.warn(`[OpenTabsRemote] report failed: HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn("[OpenTabsRemote] report failed:", error);
    }
  };

  const scheduleReport = (tabs: RemoteOpenTab[]) => {
    if (disposed || !deps.getTarget()) return;
    pendingTabs = tabs;
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(() => void flushReport(), OPEN_TABS_REPORT_DEBOUNCE_MS);
  };

  const refresh = async () => {
    const target = deps.getTarget();
    const seq = ++fetchSeq;
    if (!target || disposed) {
      state.status = "idle";
      state.devices = [];
      return;
    }
    if (state.status !== "ok") state.status = "loading";
    let status: OpenTabsRemoteStatus;
    let devices: RemoteDevice[] | null = null;
    try {
      const response = await deps.fetchSnapshot(target);
      if (isDisabledStatus(response.status)) {
        status = "unavailable";
        devices = [];
      } else if (response.status === 200) {
        const snapshot = parseSnapshot(response.body, deps.deviceId);
        status = snapshot ? "ok" : "error";
        devices = snapshot?.devices ?? null;
      } else {
        status = "error";
      }
    } catch (error) {
      console.warn("[OpenTabsRemote] snapshot failed:", error);
      status = "error";
    }
    if (seq !== fetchSeq || disposed) return;
    state.status = status;
    // 失败时保留上次结果，面板另行提示；未启用时清空。
    if (devices) state.devices = devices;
    state.fetchedAt = now();
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const startPolling = () => {
    if (disposed || pollTimer) return;
    void refresh();
    pollTimer = setInterval(() => void refresh(), OPEN_TABS_POLL_MS);
  };

  const dispose = () => {
    disposed = true;
    stopPolling();
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = null;
    pendingTabs = null;
  };

  return {
    state,
    enabled: () => deps.getTarget() !== null,
    refresh,
    startPolling,
    stopPolling,
    scheduleReport,
    dispose,
  };
}

export interface TopicTitleResolverDeps {
  known: (target: OpenTabRef) => string | null;
  fetchTopics: (
    ownerType: ConversationOwnerType,
    ownerId: string,
  ) => Promise<Array<{ id: string; name?: string | null }>>;
}

type OwnerTopics = Map<string, string> | "pending" | "failed";

/**
 * 远端标签的话题名：先查本地已知（标签/历史/当前列表），否则按 owner 读一次本机话题库。
 * resolve 返回 undefined 表示还在查，null 表示本机没有（显示“未同步的话题”）。
 */
export function createTopicTitleResolver(deps: TopicTitleResolverDeps) {
  const owners = shallowReactive(new Map<string, OwnerTopics>());
  const ownerKey = (ownerType: string, ownerId: string) => `${ownerType}\u0000${ownerId}`;

  const load = (ownerType: ConversationOwnerType, ownerId: string) => {
    const key = ownerKey(ownerType, ownerId);
    if (owners.has(key)) return;
    owners.set(key, "pending");
    void deps.fetchTopics(ownerType, ownerId).then(
      (topics) => {
        const names = new Map<string, string>();
        for (const topic of Array.isArray(topics) ? topics : []) {
          if (topic && isNonEmptyString(topic.id)) names.set(topic.id, topic.name || topic.id);
        }
        owners.set(key, names);
      },
      () => owners.set(key, "failed"),
    );
  };

  const resolve = (target: OpenTabRef): string | null | undefined => {
    const known = deps.known(target);
    if (known) return known;
    const entry = owners.get(ownerKey(target.ownerType, target.ownerId));
    if (entry === undefined || entry === "pending") return undefined;
    if (entry === "failed") return null;
    return entry.get(target.topicId) ?? null;
  };

  const prefetch = (targets: readonly OpenTabRef[]) => {
    for (const target of targets) {
      if (!deps.known(target)) load(target.ownerType, target.ownerId);
    }
  };

  return { resolve, prefetch, reset: () => owners.clear() };
}

export const deviceNameFromSettings = (settings: AppSettings | null | undefined) => {
  const name =
    typeof settings?.distributedDeviceName === "string" ? settings.distributedDeviceName.trim() : "";
  return name || "Android 手机";
};

const safeLocalStorage = (): DeviceIdStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const inertRemote = (): OpenTabsRemoteApi => ({
  state: reactive<OpenTabsRemoteState>({ status: "idle", devices: [], fetchedAt: null }),
  enabled: () => false,
  refresh: async () => {},
  startPolling: () => {},
  stopPolling: () => {},
});

interface SharedRemote {
  remote: OpenTabsRemote;
  users: number;
  teardown: () => void;
}

let shared: SharedRemote | null = null;

const mountShared = (): SharedRemote => {
  const settingsStore = useSettingsStore();
  const tabsStore = useOpenTabsStore();
  const getTarget = () => hintTargetFromSettings(settingsStore.settings, true);
  const remote = createOpenTabsRemote({
    getTarget,
    deviceId: getOrCreateDeviceId(safeLocalStorage()),
    deviceName: () => deviceNameFromSettings(settingsStore.settings),
    fetchSnapshot: (target) =>
      invoke<OpenTabsHttpResponse>("open_tabs_get", {
        baseUrl: target.baseUrl,
        token: target.token,
      }),
    putDevice: (target, deviceId, body) =>
      invoke<OpenTabsHttpResponse>("open_tabs_put", {
        baseUrl: target.baseUrl,
        token: target.token,
        deviceId,
        body,
      }),
  });
  // 只在身份/顺序或目标变化时上报；标题、未读的变化不触发。
  const stopWatch = watch(
    () => {
      const target = getTarget();
      return target
        ? [target.baseUrl, target.token, JSON.stringify(toReportTabs(tabsStore.tabs))].join("\n")
        : null;
    },
    (key) => {
      if (key !== null) remote.scheduleReport(toReportTabs(tabsStore.tabs));
    },
    { immediate: true },
  );
  const stopHint = onRemoteHint(() => void remote.refresh());
  return {
    remote,
    users: 0,
    teardown: () => {
      stopWatch();
      stopHint();
      remote.dispose();
    },
  };
};

/** 组件级入口（引用计数单例）：返回共享客户端与释放函数，最后一个使用者释放时停掉。 */
export function useOpenTabsRemote(): { remote: OpenTabsRemoteApi; release: () => void } {
  if (!getActivePinia()) return { remote: inertRemote(), release: () => {} };
  if (!shared) shared = mountShared();
  const current = shared;
  current.users += 1;
  let released = false;
  return {
    remote: current.remote,
    release: () => {
      if (released) return;
      released = true;
      current.users -= 1;
      if (current.users > 0) return;
      current.teardown();
      if (shared === current) shared = null;
    },
  };
}
