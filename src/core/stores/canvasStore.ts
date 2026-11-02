import { defineStore } from "pinia";
import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "./settings";
import type { OpenTabRef } from "./openTabsStore";
import { hintTargetFromSettings } from "../sync/remoteChangeHint";

/**
 * 手机 Canvas 一期（ptp4g#9，自用版）：镜像电脑端 AppData/canvas 根下的 .md/.txt。
 *
 * 网络与文件 IO 在 Rust（canvas_sync.rs）；这里只做决策：
 * - 进入页面 start()：先列本机镜像，再拉 manifest 按 sha/baseSha 拉取或上推，之后订阅 /wait；
 * - 离开页面 stop()：取消在途 wait、停止退避；
 * - 双方都改过（或上推 409）：本机正文另存为 `.conflict-手机-` 副本，再拉电脑端版本覆盖；
 *   副本名含 `.conflict-`，电脑端 manifest 与 PUT 都排除，因此只留本机。
 * autoSync 关闭、缺 syncHttpUrl/Token 时不发任何请求（status = "disabled"）；
 * 电脑端 404/503 视为未启用 VCPCanvasSync（status = "unavailable"）。
 */

export const CANVAS_WAIT_MS = 25_000;
export const CANVAS_RETRY_MS = 5_000;
const SCOPE_PREFIX = "canvas/";

export interface CanvasTarget {
  baseUrl: string;
  token: string;
}

export interface CanvasHttpResponse {
  status: number;
  body: unknown;
}

export interface CanvasTransferResult {
  status: number;
  sha256: string | null;
  body: unknown;
}

export interface CanvasLocalEntry {
  name: string;
  size: number;
  mtime: number;
  sha256: string;
  baseSha: string | null;
  localOnly: boolean;
}

export interface CanvasRemoteFile {
  name: string;
  size: number;
  mtime: number;
  sha256: string;
}

export interface CanvasBinding {
  agentId: string;
  topicId: string;
  itemType: string | null;
  updatedAt?: number;
  source?: string;
}

export type CanvasStatus = "idle" | "disabled" | "unavailable" | "syncing" | "ready" | "error";

export interface CanvasApi {
  manifest: (target: CanvasTarget) => Promise<CanvasHttpResponse>;
  pull: (target: CanvasTarget, name: string, sha256: string | null) => Promise<CanvasTransferResult>;
  push: (target: CanvasTarget, name: string) => Promise<CanvasTransferResult>;
  wait: (
    requestId: string,
    target: CanvasTarget,
    since: string | null,
    timeoutMs: number,
  ) => Promise<CanvasHttpResponse>;
  cancelWait: (requestId: string) => unknown;
  bindingsGet: (target: CanvasTarget) => Promise<CanvasHttpResponse>;
  bindingsPut: (
    target: CanvasTarget,
    name: string,
    binding: Pick<CanvasBinding, "agentId" | "topicId" | "itemType">,
  ) => Promise<CanvasHttpResponse>;
  localList: () => Promise<CanvasLocalEntry[]>;
  localRead: (name: string) => Promise<string>;
  localWrite: (name: string, content: string) => Promise<string>;
  saveConflict: (name: string) => Promise<string>;
}

// ---------------------------------------------------------------- 纯函数

/** 与电脑端 normalizeBindingKey / canvasDocKey 同规则：相对 canvas 根、posix、NFC、小写。 */
export function normalizeCanvasKey(name: string): string {
  let key = String(name).replace(/\\/g, "/").normalize("NFC");
  if (key.startsWith(SCOPE_PREFIX)) key = key.slice(SCOPE_PREFIX.length);
  return key.toLowerCase();
}

export const isCanvasDocName = (name: string) => /\.(md|txt)$/i.test(name);
export const isLocalOnlyName = (name: string) => name.includes(".bak") || name.includes(".conflict-");
const isSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isDisabledStatus = (status: number) => status === 404 || status === 503;

/** 只取 canvas 根下单层、可同步的 .md/.txt；CanvasRevisions 等一期不镜像。 */
export function parseManifest(body: unknown): { revision: string; files: CanvasRemoteFile[] } | null {
  if (!body || typeof body !== "object") return null;
  const { revision, files } = body as Record<string, unknown>;
  if (typeof revision !== "string" || !Array.isArray(files)) return null;
  const out: CanvasRemoteFile[] = [];
  for (const raw of files) {
    if (!raw || typeof raw !== "object") continue;
    const { path, size, mtime, sha256 } = raw as Record<string, unknown>;
    if (typeof path !== "string" || !path.startsWith(SCOPE_PREFIX) || !isSha(sha256)) continue;
    const name = path.slice(SCOPE_PREFIX.length);
    if (!name || name.includes("/") || !isCanvasDocName(name) || isLocalOnlyName(name)) continue;
    out.push({
      name,
      sha256,
      size: typeof size === "number" ? size : 0,
      mtime: typeof mtime === "number" ? mtime : 0,
    });
  }
  return { revision, files: out };
}

export function parseBindings(body: unknown): Record<string, CanvasBinding> {
  const out: Record<string, CanvasBinding> = Object.create(null);
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).bindings : null;
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { agentId, topicId, itemType, updatedAt, source } = value as Record<string, unknown>;
    if (typeof agentId !== "string" || !agentId || typeof topicId !== "string" || !topicId) continue;
    out[normalizeCanvasKey(key)] = {
      agentId,
      topicId,
      itemType: typeof itemType === "string" ? itemType : null,
      updatedAt: typeof updatedAt === "number" ? updatedAt : undefined,
      source: typeof source === "string" ? source : undefined,
    };
  }
  return out;
}

export type CanvasAction =
  | { kind: "pull"; name: string; sha256: string }
  | { kind: "push"; name: string }
  | { kind: "conflict"; name: string; sha256: string };

/**
 * 三方比较 本机 sha / 记录的 baseSha / 电脑端 sha：
 * 本机未改 → 拉；电脑端未改 → 推；两边都改且不一致 → 冲突；内容已一致 → 拉（Rust 只补记 baseSha，不下载）。
 * 本机有、电脑端没有：从未同步过的视为本机新建上推；同步过的（电脑端已删）保留本机不动。
 */
export function planSync(remote: readonly CanvasRemoteFile[], local: readonly CanvasLocalEntry[]): CanvasAction[] {
  const byName = new Map(local.map((entry) => [entry.name, entry]));
  const actions: CanvasAction[] = [];
  for (const file of remote) {
    const mine = byName.get(file.name);
    byName.delete(file.name);
    if (!mine) {
      actions.push({ kind: "pull", name: file.name, sha256: file.sha256 });
    } else if (mine.sha256 === file.sha256) {
      if (mine.baseSha !== file.sha256) actions.push({ kind: "pull", name: file.name, sha256: file.sha256 });
    } else if (mine.sha256 === mine.baseSha) {
      actions.push({ kind: "pull", name: file.name, sha256: file.sha256 });
    } else if (file.sha256 === mine.baseSha) {
      actions.push({ kind: "push", name: file.name });
    } else {
      actions.push({ kind: "conflict", name: file.name, sha256: file.sha256 });
    }
  }
  for (const mine of byName.values()) {
    if (!mine.localOnly && mine.baseSha === null) actions.push({ kind: "push", name: mine.name });
  }
  return actions;
}

export function bindingToTab(binding: CanvasBinding): OpenTabRef {
  return {
    ownerId: binding.agentId,
    ownerType: binding.itemType === "group" ? "group" : "agent",
    topicId: binding.topicId,
  };
}

const sameRef = (a: OpenTabRef | null, b: OpenTabRef | null) =>
  !!a && !!b && a.ownerId === b.ownerId && a.ownerType === b.ownerType && a.topicId === b.topicId;

export interface ChatSwitcherDeps {
  current: () => OpenTabRef | null;
  open: (tab: OpenTabRef) => Promise<boolean>;
  activate: (tab: OpenTabRef) => Promise<boolean>;
}

/** [对话] 激活绑定话题的标签（没开就新开）；回到 [文稿] 或退出时切回进入前的标签。 */
export function createChatSwitcher(deps: ChatSwitcherDeps) {
  let origin: OpenTabRef | null | undefined;
  const enter = async (target: OpenTabRef) => {
    if (origin === undefined) {
      const current = deps.current();
      origin = current ? { ownerId: current.ownerId, ownerType: current.ownerType, topicId: current.topicId } : null;
    }
    return deps.open(target);
  };
  const leave = async () => {
    if (origin === undefined) return false;
    const back = origin;
    origin = undefined;
    if (!back || sameRef(back, deps.current())) return false;
    return deps.activate(back);
  };
  return { enter, leave, entered: () => origin !== undefined };
}

// ---------------------------------------------------------------- controller

export interface CanvasState {
  status: CanvasStatus;
  docs: CanvasLocalEntry[];
  bindings: Record<string, CanvasBinding>;
  revision: string | null;
  notices: string[];
  error: string | null;
  lastSyncAt: number;
}

export interface CanvasControllerDeps {
  api: CanvasApi;
  getTarget: () => CanvasTarget | null;
  now?: () => number;
  retryMs?: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createCanvasController(deps: CanvasControllerDeps) {
  const { api } = deps;
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? CANVAS_RETRY_MS;
  const state = reactive<CanvasState>({
    status: "idle",
    docs: [],
    bindings: Object.create(null),
    revision: null,
    notices: [],
    error: null,
    lastSyncAt: 0,
  });
  let generation = 0;
  let waitSeq = 0;
  let waitId: string | null = null;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeSleep: (() => void) | null = null;
  let running = false;

  const notify = (text: string) => {
    state.notices = [...state.notices, text].slice(-20);
  };

  const refreshLocal = async () => {
    state.docs = (await api.localList()).filter((entry) => isCanvasDocName(entry.name));
  };

  const resolveConflict = async (target: CanvasTarget, name: string, serverSha: string | null) => {
    const copy = await api.saveConflict(name);
    const pulled = await api.pull(target, name, serverSha);
    if (pulled.status !== 200) throw new Error(`拉取 ${name} 失败：HTTP ${pulled.status}`);
    notify(`「${name}」电脑端和手机都改过，手机版本已另存为「${copy}」`);
  };

  const pushOne = async (target: CanvasTarget, name: string) => {
    const result = await api.push(target, name);
    if (result.status === 409) {
      const serverSha = (result.body as { serverSha?: unknown } | null)?.serverSha;
      await resolveConflict(target, name, isSha(serverSha) ? serverSha : null);
      return;
    }
    if (isDisabledStatus(result.status)) throw Object.assign(new Error("disabled"), { disabled: true });
    if (result.status !== 200) throw new Error(`上推 ${name} 失败：HTTP ${result.status}`);
  };

  /** 一次完整对账；返回 false 表示电脑端未启用或不可用，订阅应停止。 */
  const syncOnce = async (gen: number): Promise<boolean> => {
    const target = deps.getTarget();
    if (!target) {
      state.status = "disabled";
      return false;
    }
    state.status = "syncing";
    try {
      const response = await api.manifest(target);
      if (gen !== generation) return false;
      if (isDisabledStatus(response.status)) {
        state.status = "unavailable";
        return false;
      }
      const manifest = response.status === 200 ? parseManifest(response.body) : null;
      if (!manifest) throw new Error(`manifest 无效：HTTP ${response.status}`);
      const actions = planSync(manifest.files, await api.localList());
      const failures: string[] = [];
      for (const action of actions) {
        if (gen !== generation) return false;
        try {
          if (action.kind === "pull") {
            const pulled = await api.pull(target, action.name, action.sha256);
            if (pulled.status !== 200) failures.push(`${action.name}: HTTP ${pulled.status}`);
          } else if (action.kind === "push") {
            await pushOne(target, action.name);
          } else {
            await resolveConflict(target, action.name, action.sha256);
          }
        } catch (error) {
          if ((error as { disabled?: boolean }).disabled) {
            state.status = "unavailable";
            return false;
          }
          failures.push(`${action.name}: ${errorText(error)}`);
        }
      }
      const bindings = await api.bindingsGet(target);
      if (bindings.status === 200) state.bindings = parseBindings(bindings.body);
      await refreshLocal();
      if (gen !== generation) return false;
      state.revision = manifest.revision;
      state.lastSyncAt = now();
      state.error = failures.length ? failures.join("；") : null;
      state.status = "ready";
      return true;
    } catch (error) {
      if (gen !== generation) return false;
      state.error = errorText(error);
      state.status = "error";
      return true; // 网络错误可恢复：订阅循环退避后重试。
    }
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wakeSleep = resolve;
      sleepTimer = setTimeout(() => {
        sleepTimer = null;
        wakeSleep = null;
        resolve();
      }, ms);
    });

  const waitLoop = async (gen: number) => {
    while (gen === generation) {
      const target = deps.getTarget();
      if (!target) {
        state.status = "disabled";
        return;
      }
      if (state.status === "error") {
        await sleep(retryMs);
        if (gen !== generation) return;
        if (!(await syncOnce(gen))) return;
        continue;
      }
      const id = `canvas-${gen}-${++waitSeq}`;
      waitId = id;
      let response: CanvasHttpResponse;
      try {
        response = await api.wait(id, target, state.revision, CANVAS_WAIT_MS);
      } catch (error) {
        if (gen !== generation) return;
        state.error = errorText(error);
        state.status = "error";
        continue;
      } finally {
        if (waitId === id) waitId = null;
      }
      if (gen !== generation) return;
      if (isDisabledStatus(response.status)) {
        state.status = "unavailable";
        return;
      }
      const body = response.body as { changed?: unknown; revision?: unknown } | null;
      if (response.status !== 200 || !body || typeof body.changed !== "boolean") {
        state.error = `wait 无效：HTTP ${response.status}`;
        state.status = "error";
        continue;
      }
      if (body.changed) {
        if (!(await syncOnce(gen))) return;
      } else if (typeof body.revision === "string") {
        state.revision = body.revision;
      }
    }
  };

  const start = async () => {
    stop();
    const gen = ++generation;
    running = true;
    try {
      await refreshLocal();
    } catch (error) {
      state.error = errorText(error);
    }
    if (gen !== generation) return;
    if (!deps.getTarget()) {
      state.status = "disabled";
      return;
    }
    if (await syncOnce(gen)) void waitLoop(gen);
  };

  function stop() {
    generation += 1;
    running = false;
    if (waitId) {
      void Promise.resolve(api.cancelWait(waitId)).catch(() => {});
      waitId = null;
    }
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = null;
    wakeSleep?.();
    wakeSleep = null;
    if (state.status === "syncing") state.status = "idle";
  }

  /** 保存本机编辑；联网可用时立即上推（409 走冲突副本）。返回是否已同步到电脑端。 */
  const saveDoc = async (name: string, content: string) => {
    await api.localWrite(name, content);
    const target = deps.getTarget();
    let synced = false;
    if (target && state.status !== "unavailable") {
      try {
        await pushOne(target, name);
        synced = true;
      } catch (error) {
        if ((error as { disabled?: boolean }).disabled) state.status = "unavailable";
        else state.error = errorText(error);
      }
    }
    await refreshLocal();
    return synced;
  };

  const bindingFor = (name: string): CanvasBinding | null => state.bindings[normalizeCanvasKey(name)] ?? null;

  const bind = async (name: string, binding: Pick<CanvasBinding, "agentId" | "topicId" | "itemType">) => {
    const target = deps.getTarget();
    if (!target) throw new Error("未配置同步地址或 Token");
    const response = await api.bindingsPut(target, name, binding);
    if (isDisabledStatus(response.status)) throw new Error("电脑端未启用");
    if (response.status !== 200) throw new Error(`绑定失败：HTTP ${response.status}`);
    state.bindings = { ...state.bindings, [normalizeCanvasKey(name)]: { ...binding, source: "manual" } };
  };

  const dismissNotice = (index: number) => {
    state.notices = state.notices.filter((_, i) => i !== index);
  };

  return {
    state,
    start,
    stop,
    saveDoc,
    readDoc: (name: string) => api.localRead(name),
    bindingFor,
    bind,
    dismissNotice,
    isRunning: () => running,
  };
}

export type CanvasController = ReturnType<typeof createCanvasController>;

// ---------------------------------------------------------------- tauri 绑定

export const tauriCanvasApi: CanvasApi = {
  manifest: (t) => invoke("canvas_manifest", { baseUrl: t.baseUrl, token: t.token }),
  pull: (t, name, sha256) => invoke("canvas_pull", { baseUrl: t.baseUrl, token: t.token, name, sha256 }),
  push: (t, name) => invoke("canvas_push", { baseUrl: t.baseUrl, token: t.token, name }),
  wait: (requestId, t, since, timeoutMs) =>
    invoke("canvas_wait", { requestId, baseUrl: t.baseUrl, token: t.token, since, timeoutMs }),
  cancelWait: (requestId) => invoke("canvas_wait_cancel", { requestId }),
  bindingsGet: (t) => invoke("canvas_bindings_get", { baseUrl: t.baseUrl, token: t.token }),
  bindingsPut: (t, name, b) =>
    invoke("canvas_bindings_put", {
      baseUrl: t.baseUrl,
      token: t.token,
      name,
      agentId: b.agentId,
      topicId: b.topicId,
      itemType: b.itemType,
    }),
  localList: () => invoke("canvas_local_list"),
  localRead: (name) => invoke("canvas_local_read", { name }),
  localWrite: (name, content) => invoke("canvas_local_write", { name, content }),
  saveConflict: (name) => invoke("canvas_local_save_conflict", { name }),
};

export const useCanvasStore = defineStore("canvas", () => {
  const settingsStore = useSettingsStore();
  const controller = createCanvasController({
    api: tauriCanvasApi,
    getTarget: () => hintTargetFromSettings(settingsStore.settings, true),
  });
  return { ...controller };
});
