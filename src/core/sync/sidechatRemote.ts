/**
 * 子话题文件通道（ptp4g#41）：电脑端 VCPSidechatSync → 手机私有目录 sidechat-mirror/。
 *
 * - 第一期只拉不推不删；网络与落盘在 Rust（sidechat_sync.rs），这里只做调度与解析。
 * - 前台就绪 / 地址或 Token 变化 / remote-hint / 打开子话题页时同步一次；
 *   子话题不进 CDS，remote-hint 不会因子话题变化触发，所以打开页面时会主动同步。
 * - 本次会话内记住每个文件拉到的 sha，manifest 未变的文件不再调用 pull。
 * - autoSync 关闭或缺 syncHttpUrl/Token 时不运行（与 remoteChangeHint 同一判定）。
 */
import { watch } from "vue";
import { getActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settings";
import { hintTargetFromSettings, onRemoteHint, type HintTarget } from "./remoteChangeHint";

export const SIDECHAT_BACKOFF_MS = 60_000;
/** 单轮删除本机镜像的安全阀。 */
export const SIDECHAT_MAX_DELETES_PER_ROUND = 20;
const CHILD_META = "sidechat-child.json";

export interface SidechatManifestFile {
  path: string;
  size: number;
  mtime: number;
  sha256: string;
}
export interface SidechatHttpResponse {
  status: number;
  body: unknown;
}
export interface SidechatPullResult {
  status: number;
  sha256: string | null;
  skipped: boolean;
}
export interface SidechatLocalEntry {
  path: string;
  size: number;
}
export interface SidechatChild {
  agentId: string;
  topicId: string;
  parentTopicId: string;
  createdAt: number;
  /** 镜像内子话题目录的相对路径（不含末尾斜杠）。 */
  dir: string;
}
export interface SidechatMessage {
  id: string;
  role: string;
  name: string | null;
  content: string;
  timestamp: number;
}
export interface SidechatSyncSummary {
  pulled: number;
  /** 电脑端已删、本轮从本机镜像删掉的文件数。 */
  removed?: number;
  /** 超过安全阀暂缓删除的文件数。 */
  held?: number;
  /** 双向模式：推到电脑端的文件数。 */
  pushed?: number;
  /** 双向模式：本机已删、本轮在电脑端删掉的文件数。 */
  deletedRemote?: number;
  /** 双向模式：双改另存冲突副本的文件数。 */
  conflicts?: number;
  unchanged: number;
  failed: number;
}
export interface SidechatLocalStatus {
  path: string;
  /** 本机当前内容摘要；本机已删时为 null。 */
  sha256: string | null;
  /** 上次两端一致时的基线摘要；从未同步过为 null。 */
  base: string | null;
}
export interface SidechatPushResult {
  status: number;
  sha256: string | null;
  /** 409 时电脑端当前摘要；电脑端已无此文件为 null。 */
  serverSha?: string | null;
}
export type SidechatActionKind =
  | "upload"
  | "download"
  | "delete-local"
  | "delete-remote"
  | "forget"
  | "conflict";
export interface SidechatAction {
  kind: SidechatActionKind;
  path: string;
  remoteSha: string | null;
  base: string | null;
}

const SHA_RE = /^[a-f0-9]{64}$/;

export function parseManifest(body: unknown): SidechatManifestFile[] | null {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return null;
  const out: SidechatManifestFile[] = [];
  for (const item of files) {
    const f = item as Partial<SidechatManifestFile> | null;
    if (!f || typeof f.path !== "string" || typeof f.sha256 !== "string" || !SHA_RE.test(f.sha256)) continue;
    out.push({
      path: f.path,
      size: typeof f.size === "number" ? f.size : 0,
      mtime: typeof f.mtime === "number" ? f.mtime : 0,
      sha256: f.sha256,
    });
  }
  return out;
}

const isChildMeta = (path: string) => path === CHILD_META || path.endsWith(`/${CHILD_META}`);
/** 只属于本机的产物：原子写临时文件、冲突副本，不参与同步。 */
const isLocalOnly = (path: string) =>
  path.endsWith(".tmp") || /(^|\/)history\.conflict-[^/]*\.json$/.test(path);

/**
 * 三方比对（R=电脑端 manifest，L=本机，B=基线）。双改以电脑端为准并另存冲突副本；
 * 本机改、电脑端删时保留本机内容重新上传。sidechat-child.json 排在最后：新增时内容先到，删除时标记最后删。
 */
export function planSidechatSync(
  remote: SidechatManifestFile[],
  local: SidechatLocalStatus[],
): SidechatAction[] {
  const remoteMap = new Map(remote.map((file) => [file.path, file.sha256] as const));
  const localMap = new Map<string, SidechatLocalStatus>();
  for (const entry of local) if (!isLocalOnly(entry.path)) localMap.set(entry.path, entry);
  const out: SidechatAction[] = [];
  for (const path of new Set([...remoteMap.keys(), ...localMap.keys()])) {
    const r = remoteMap.get(path) ?? null;
    const entry = localMap.get(path);
    const l = entry?.sha256 ?? null;
    const b = entry?.base ?? null;
    let kind: SidechatActionKind | null = null;
    if (r && l) {
      if (r === l) kind = b === r ? null : "download";
      else if (b === l) kind = "download";
      else if (b === r) kind = "upload";
      else kind = "conflict";
    } else if (r) {
      kind = b === r ? "delete-remote" : "download";
    } else if (l) {
      kind = b === l ? "delete-local" : "upload";
    } else if (b) {
      kind = "forget";
    }
    if (kind) out.push({ kind, path, remoteSha: r, base: b });
  }
  return out.sort(
    (a, b) => Number(isChildMeta(a.path)) - Number(isChildMeta(b.path)) || a.path.localeCompare(b.path),
  );
}

export interface SidechatRemoteDeps {
  getTarget: () => HintTarget | null;
  fetchManifest: (target: HintTarget) => Promise<SidechatHttpResponse>;
  pull: (target: HintTarget, path: string, sha256: string) => Promise<SidechatPullResult>;
  listLocal?: () => Promise<SidechatLocalEntry[]>;
  removeLocal?: (path: string) => Promise<boolean>;
  /** 双向模式：与 push 同时提供才走三方比对，否则保持只拉。 */
  localStatus?: () => Promise<SidechatLocalStatus[]>;
  push?: (target: HintTarget, path: string, baseSha: string | null) => Promise<SidechatPushResult>;
  deleteRemote?: (target: HintTarget, path: string, baseSha: string) => Promise<SidechatHttpResponse>;
  /** 把本机内容另存为同目录 history.conflict-手机.json。 */
  saveConflict?: (path: string) => Promise<void>;
  /** 两端都已没有该文件时清掉基线。 */
  forget?: (path: string) => Promise<void>;
  now?: () => number;
}

export interface SidechatRemote {
  /** 同步一次；无目标、退避中、manifest 不可用时返回 null。并发调用共用同一次。 */
  sync: () => Promise<SidechatSyncSummary | null>;
}

export function createSidechatRemote(deps: SidechatRemoteDeps): SidechatRemote {
  const now = deps.now ?? Date.now;
  const known = new Map<string, string>();
  let backoffUntil = 0;
  let inflight: Promise<SidechatSyncSummary | null> | null = null;

  async function runBidirectional(
    target: HintTarget,
    files: SidechatManifestFile[],
    localStatus: NonNullable<SidechatRemoteDeps["localStatus"]>,
    push: NonNullable<SidechatRemoteDeps["push"]>,
  ): Promise<SidechatSyncSummary | null> {
    let local: SidechatLocalStatus[];
    try {
      local = await localStatus();
    } catch {
      return null;
    }
    const actions = planSidechatSync(files, local);
    const touched = new Set(actions.map((action) => action.path));
    const summary: SidechatSyncSummary = {
      pulled: 0,
      unchanged: files.filter((file) => !touched.has(file.path)).length,
      failed: 0,
    };
    const deletes = actions.filter((a) => a.kind === "delete-local" || a.kind === "delete-remote").length;
    const holdDeletes = deletes > SIDECHAT_MAX_DELETES_PER_ROUND;
    if (holdDeletes) summary.held = deletes;
    const bump = (key: "pushed" | "removed" | "deletedRemote" | "conflicts") => {
      summary[key] = (summary[key] ?? 0) + 1;
    };
    const pullInto = async (path: string, sha256: string) => {
      const result = await deps.pull(target, path, sha256);
      if (result.status === 200 && result.sha256) {
        if (result.skipped) summary.unchanged += 1;
        else summary.pulled += 1;
      } else {
        summary.failed += 1;
      }
    };
    const conflictThenPull = async (path: string, sha256: string) => {
      if (!deps.saveConflict) {
        summary.failed += 1;
        return;
      }
      await deps.saveConflict(path);
      bump("conflicts");
      await pullInto(path, sha256);
    };
    for (const action of actions) {
      try {
        switch (action.kind) {
          case "download":
            await pullInto(action.path, action.remoteSha as string);
            break;
          case "conflict":
            await conflictThenPull(action.path, action.remoteSha as string);
            break;
          case "upload": {
            const res = await push(target, action.path, action.base);
            if (res.status === 200 && res.sha256) bump("pushed");
            else if (res.status === 409 && res.serverSha) await conflictThenPull(action.path, res.serverSha);
            else if (res.status === 409) await deps.forget?.(action.path);
            else summary.failed += 1;
            break;
          }
          case "delete-remote": {
            if (holdDeletes) break;
            if (!deps.deleteRemote) {
              summary.failed += 1;
              break;
            }
            // 409：电脑端已改，Rust 侧清基线，下一轮按新文件拉回。
            const res = await deps.deleteRemote(target, action.path, action.base as string);
            if (res.status === 200) bump("deletedRemote");
            else if (res.status !== 409) summary.failed += 1;
            break;
          }
          case "delete-local":
            if (holdDeletes) break;
            if (!deps.removeLocal) {
              summary.failed += 1;
              break;
            }
            if (await deps.removeLocal(action.path)) bump("removed");
            break;
          case "forget":
            await deps.forget?.(action.path);
            break;
        }
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }

  async function run(): Promise<SidechatSyncSummary | null> {
    const target = deps.getTarget();
    if (!target || now() < backoffUntil) return null;
    let response: SidechatHttpResponse;
    try {
      response = await deps.fetchManifest(target);
    } catch {
      backoffUntil = now() + SIDECHAT_BACKOFF_MS;
      return null;
    }
    if (response.status !== 200) {
      if (response.status === 404 || response.status === 503) {
        backoffUntil = now() + SIDECHAT_BACKOFF_MS;
      }
      return null;
    }
    const files = parseManifest(response.body);
    if (!files) return null;
    if (deps.localStatus && deps.push) {
      return runBidirectional(target, files, deps.localStatus, deps.push);
    }
    const summary: SidechatSyncSummary = { pulled: 0, unchanged: 0, failed: 0 };
    for (const file of files) {
      if (known.get(file.path) === file.sha256) {
        summary.unchanged += 1;
        continue;
      }
      try {
        const result = await deps.pull(target, file.path, file.sha256);
        if (result.status === 200 && result.sha256) {
          known.set(file.path, result.sha256);
          if (result.skipped) summary.unchanged += 1;
          else summary.pulled += 1;
        } else {
          summary.failed += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
    if (deps.listLocal && deps.removeLocal) {
      const live = new Set(files.map((file) => file.path));
      let entries: SidechatLocalEntry[] = [];
      try {
        entries = await deps.listLocal();
      } catch {
        entries = [];
      }
      const isMeta = (path: string) => Number(path.endsWith(`/${CHILD_META}`));
      const stale = entries
        .filter((entry) => !live.has(entry.path))
        .sort((a, b) => isMeta(a.path) - isMeta(b.path));
      if (stale.length > SIDECHAT_MAX_DELETES_PER_ROUND) {
        summary.held = stale.length;
      } else {
        let removed = 0;
        for (const entry of stale) {
          try {
            if (await deps.removeLocal(entry.path)) removed += 1;
            known.delete(entry.path);
          } catch {
            summary.failed += 1;
          }
        }
        if (removed) summary.removed = removed;
      }
    }
    return summary;
  }

  return {
    sync: () => {
      if (!inflight) {
        inflight = run().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}

// ---------------------------------------------------------------- 本地只读

export interface SidechatLocalDeps {
  listLocal: () => Promise<SidechatLocalEntry[]>;
  readLocal: (path: string) => Promise<string>;
}

export function parseChildMeta(raw: string, dir: string): SidechatChild | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { agentId, topicId, parentTopicId, createdAt } = data ?? {};
  if (typeof agentId !== "string" || typeof parentTopicId !== "string") return null;
  if (typeof topicId !== "string" || !topicId.startsWith("sidechat_")) return null;
  return {
    agentId,
    topicId,
    parentTopicId,
    createdAt: typeof createdAt === "number" ? createdAt : 0,
    dir,
  };
}

export function parseHistory(raw: string): SidechatMessage[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: SidechatMessage[] = [];
  for (const item of data) {
    const m = item as Record<string, unknown> | null;
    if (!m || typeof m.id !== "string" || typeof m.role !== "string") continue;
    out.push({
      id: m.id,
      role: m.role,
      name: typeof m.name === "string" ? m.name : null,
      content: typeof m.content === "string" ? m.content : "",
      timestamp: typeof m.timestamp === "number" ? m.timestamp : 0,
    });
  }
  return out;
}

export async function listLocalChildren(
  parentTopicId: string,
  deps: SidechatLocalDeps,
): Promise<SidechatChild[]> {
  const entries = await deps.listLocal();
  const children: SidechatChild[] = [];
  for (const entry of entries) {
    if (!entry.path.endsWith(`/${CHILD_META}`)) continue;
    const dir = entry.path.slice(0, -(CHILD_META.length + 1));
    try {
      const child = parseChildMeta(await deps.readLocal(entry.path), dir);
      if (child && child.parentTopicId === parentTopicId) children.push(child);
    } catch {
      // 单个子话题读失败不影响其余
    }
  }
  return children.sort((a, b) => b.createdAt - a.createdAt);
}

export async function readChildHistory(
  child: SidechatChild,
  deps: SidechatLocalDeps,
): Promise<SidechatMessage[]> {
  return parseHistory(await deps.readLocal(`${child.dir}/history.json`));
}

export const sidechatLocal: SidechatLocalDeps = {
  listLocal: () => invoke<SidechatLocalEntry[]>("sidechat_local_list"),
  readLocal: (path) => invoke<string>("sidechat_local_read", { path }),
};

// ---------------------------------------------------------------- 挂载

let activeDispose: (() => void) | null = null;
let activeRemote: SidechatRemote | null = null;

/** 供子话题页主动触发；未挂载时直接返回 null。 */
export function requestSidechatSync(): Promise<SidechatSyncSummary | null> {
  return activeRemote ? activeRemote.sync() : Promise.resolve(null);
}

interface RustLocalStatus {
  path: string;
  sha256: string | null;
  baseSha: string | null;
}
interface RustTransferResult {
  status: number;
  sha256: string | null;
  body: unknown;
}

export function useSidechatRemote(isForeground: () => boolean): () => void {
  activeDispose?.();
  if (!getActivePinia()) return () => {};
  const settingsStore = useSettingsStore();
  const getTarget = () => hintTargetFromSettings(settingsStore.settings, isForeground());
  const remote = createSidechatRemote({
    getTarget,
    fetchManifest: (target) =>
      invoke<SidechatHttpResponse>("sidechat_manifest", {
        baseUrl: target.baseUrl,
        token: target.token,
      }),
    pull: (target, path, sha256) =>
      invoke<SidechatPullResult>("sidechat_pull", {
        baseUrl: target.baseUrl,
        token: target.token,
        path,
        sha256,
      }),
    listLocal: () => invoke<SidechatLocalEntry[]>("sidechat_local_list"),
    removeLocal: (path) => invoke<boolean>("sidechat_local_remove", { path }),
    localStatus: async () => {
      const rows = await invoke<RustLocalStatus[]>("sidechat_local_status");
      return rows.map((row) => ({ path: row.path, sha256: row.sha256 ?? null, base: row.baseSha ?? null }));
    },
    // baseSha 由 Rust 从本机基线读取，这里不再传。
    push: async (target, path) => {
      const res = await invoke<RustTransferResult>("sidechat_push", {
        baseUrl: target.baseUrl,
        token: target.token,
        path,
      });
      const serverSha = (res.body as { serverSha?: unknown } | null)?.serverSha;
      return {
        status: res.status,
        sha256: res.sha256 ?? null,
        serverSha: typeof serverSha === "string" ? serverSha : null,
      };
    },
    deleteRemote: async (target, path) => {
      const res = await invoke<RustTransferResult>("sidechat_delete", {
        baseUrl: target.baseUrl,
        token: target.token,
        path,
      });
      return { status: res.status, body: res.body ?? null };
    },
    saveConflict: async (path) => {
      await invoke<string>("sidechat_save_conflict", { path });
    },
    forget: (path) => invoke<void>("sidechat_forget_base", { path }),
  });
  activeRemote = remote;
  const stopTarget = watch(
    () => {
      const target = getTarget();
      return target ? `${target.baseUrl}\n${target.token}` : null;
    },
    (key) => {
      if (key !== null) void remote.sync();
    },
    { immediate: true },
  );
  const stopHint = onRemoteHint(() => void remote.sync());
  const dispose = () => {
    stopTarget();
    stopHint();
    if (activeRemote === remote) activeRemote = null;
    if (activeDispose === dispose) activeDispose = null;
  };
  activeDispose = dispose;
  return dispose;
}
