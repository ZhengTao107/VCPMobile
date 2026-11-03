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

/** 校验快照并去掉本机；格式不符返回 null。Windows 分组在前，其余按更新时间新到旧；标签按 order。 */
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
  // Windows（电脑）分组固定第一，其余按更新时间新到旧。
  parsed.sort(
    (a, b) =>
      Number(b.kind === "windows") - Number(a.kind === "windows") || b.updatedAt - a.updatedAt,
  );
  return { revision: isFiniteNumber(revision) ? revision : 0, devices: parsed };
}

/**
 * 设备分组副标题：统一显示“N 分钟前更新”，不判离线（电脑端无心跳，updatedAt 取
 * open-tabs.json 的 mtime，标签不动就不更新）。超过 1 小时按小时/天。
 */
export function formatDeviceFreshness(updatedAt: number, now: number): string {
  if (!updatedAt) return "更新时间未知";
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.floor(hours / 24)} 天前更新`;
}

export const formatOpenAllSummary = (opened: number, skipped: number) =>
  `已打开 ${opened}，跳过 ${skipped}（未同步）`;

export interface OpenDeviceTabsDeps {
  isOpen: (target: OpenTabRef) => boolean;
  /** 本机话题名；null 表示本机没有这个话题（未同步）。 */
  resolveTitle: (target: OpenTabRef) => Promise<string | null>;
  openTabsInBackground: (items: Array<OpenTabRef & { title: string }>) => {
    opened: OpenTabRef[];
    alreadyOpen: OpenTabRef[];
    missing: OpenTabRef[];
  };
  activateTab: (target: OpenTabRef) => Promise<boolean>;
}

export interface OpenDeviceTabsResult {
  opened: number;
  alreadyOpen: number;
  /** 本机查不到（未同步话题或 owner）而跳过的数量。 */
  skipped: number;
  activated: boolean;
}

/**
 * 「全部打开」：按 order 依次本机新开（只挂标签、不逐个激活、不触发生成，不限数量），
 * 已开的跳过，本机查不到的跳过；最后激活该设备 order 最前的已打开话题。
 */
export async function openDeviceTabs(
  device: RemoteDevice,
  deps: OpenDeviceTabsDeps,
): Promise<OpenDeviceTabsResult> {
  const ordered = [...device.tabs]
    .sort((a, b) => a.order - b.order)
    .map((tab) => ({ ownerType: tab.ownerType, ownerId: tab.ownerId, topicId: tab.topicId }));
  const present = ordered.filter((tab) => deps.isOpen(tab));
  const candidates = ordered.filter((tab) => !deps.isOpen(tab));
  const titles = await Promise.all(
    candidates.map((tab) => deps.resolveTitle(tab).catch(() => null)),
  );
  const toOpen: Array<OpenTabRef & { title: string }> = [];
  let unsynced = 0;
  candidates.forEach((tab, index) => {
    const title = titles[index];
    if (title) toOpen.push({ ...tab, title });
    else unsynced += 1;
  });
  const result = toOpen.length
    ? deps.openTabsInBackground(toOpen)
    : { opened: [], alreadyOpen: [], missing: [] };
  const usable = new Set([...present, ...result.opened, ...result.alreadyOpen].map(openTabKey));
  const first = ordered.find((tab) => usable.has(openTabKey(tab)));
  const activated = first ? await deps.activateTab(first) : false;
  return {
    opened: result.opened.length,
    alreadyOpen: present.length + result.alreadyOpen.length,
    skipped: unsynced + result.missing.length,
    activated,
  };
}

export interface ComputerRestoreState {
  device: RemoteDevice | null;
  /** 不可用时的原因；可用时为 null。 */
  reason: string | null;
}

/** 「恢复电脑的标签」= 对 Windows 分组执行「全部打开」；无快照或电脑端未启用时给出原因。 */
export function computerRestoreState(
  enabled: boolean,
  state: Pick<OpenTabsRemoteState, "status" | "devices">,
): ComputerRestoreState {
  if (!enabled) return { device: null, reason: "未开启自动同步或未配置同步地址" };
  if (state.status === "unavailable") return { device: null, reason: "电脑端未启用" };
  const device = state.devices.find((item) => item.kind === "windows") ?? null;
  if (!device) {
    const reason =
      state.status === "loading" || state.status === "idle"
        ? "加载中…"
        : state.status === "error"
          ? "获取失败，稍后重试"
          : "没有电脑的标签快照";
    return { device: null, reason };
  }
  if (device.tabs.length === 0) return { device: null, reason: "电脑没有打开的标签" };
  return { device, reason: null };
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
 * resolve 返回 undefined 表示还在查，null 表示本机没有（显示“未同步的话题”）；
 * resolveAsync 等查完再给结果（null = 未同步）。
 */
export function createTopicTitleResolver(deps: TopicTitleResolverDeps) {
  const owners = shallowReactive(new Map<string, OwnerTopics>());
  const loading = new Map<string, Promise<void>>();
  const ownerKey = (ownerType: string, ownerId: string) => `${ownerType}\u0000${ownerId}`;

  const load = (ownerType: ConversationOwnerType, ownerId: string): Promise<void> => {
    const key = ownerKey(ownerType, ownerId);
    const running = loading.get(key);
    if (running) return running;
    if (owners.has(key)) return Promise.resolve();
    owners.set(key, "pending");
    let fetched: Promise<Array<{ id: string; name?: string | null }>>;
    try {
      fetched = Promise.resolve(deps.fetchTopics(ownerType, ownerId));
    } catch (error) {
      fetched = Promise.reject(error);
    }
    const task = fetched
      .then(
        (topics) => {
          const names = new Map<string, string>();
          for (const topic of Array.isArray(topics) ? topics : []) {
            if (topic && isNonEmptyString(topic.id)) names.set(topic.id, topic.name || topic.id);
          }
          owners.set(key, names);
        },
        () => {
          owners.set(key, "failed");
        },
      )
      .finally(() => loading.delete(key));
    loading.set(key, task);
    return task;
  };

  const resolve = (target: OpenTabRef): string | null | undefined => {
    const known = deps.known(target);
    if (known) return known;
    const entry = owners.get(ownerKey(target.ownerType, target.ownerId));
    if (entry === undefined || entry === "pending") return undefined;
    if (entry === "failed") return null;
    return entry.get(target.topicId) ?? null;
  };

  const resolveAsync = async (target: OpenTabRef): Promise<string | null> => {
    const known = deps.known(target);
    if (known) return known;
    await load(target.ownerType, target.ownerId);
    return resolve(target) ?? null;
  };

  const prefetch = (targets: readonly OpenTabRef[]) => {
    for (const target of targets) {
      if (!deps.known(target)) void load(target.ownerType, target.ownerId);
    }
  };

  const reset = () => {
    owners.clear();
    loading.clear();
  };

  return { resolve, resolveAsync, prefetch, reset };
}

export const deviceNameFromSettings = (settings: AppSettings | null | undefined) => {
  const raw = settings?.distributed?.deviceName;
  const name = typeof raw === "string" ? raw.trim() : "";
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
