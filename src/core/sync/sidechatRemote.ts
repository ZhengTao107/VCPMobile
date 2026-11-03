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
  unchanged: number;
  failed: number;
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

export interface SidechatRemoteDeps {
  getTarget: () => HintTarget | null;
  fetchManifest: (target: HintTarget) => Promise<SidechatHttpResponse>;
  pull: (target: HintTarget, path: string, sha256: string) => Promise<SidechatPullResult>;
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
