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

/** 记过 baseSha、本机正文已不在：本机删除，待推给电脑端。 */
export interface CanvasMissingEntry {
  name: string;
  baseSha: string;
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
  deleteRemote: (target: CanvasTarget, name: string) => Promise<CanvasTransferResult>;
  localDelete: (name: string, docKey: string | null, keepBase: boolean) => Promise<number>;
  localMissing: () => Promise<CanvasMissingEntry[]>;
  localForget: (name: string) => Promise<void>;
  /** ptp4g#49 修订 sidecar（只读）：读本机缓存；按 manifest sha 拉取单个 docKey。 */
  revisionLoad?: (docKey: string) => Promise<string | null>;
  revisionPull?: (target: CanvasTarget, docKey: string, sha256: string) => Promise<CanvasTransferResult>;
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

const REVISIONS_PREFIX = "CanvasRevisions/";
const REVISION_FILE_RE = /^([a-f0-9]{64})\.json$/;

/**
 * 文稿只取 canvas 根下单层、可同步的 .md/.txt；
 * 修订 sidecar（`CanvasRevisions/<docKey>.json`，单层）单独放 revisions（docKey → sha256），不进文稿列表。
 * 其余 CanvasRevisions 条目（.revisions.jsonl、子目录）不使用。
 */
export function parseManifest(
  body: unknown,
): { revision: string; files: CanvasRemoteFile[]; revisions: Record<string, string> } | null {
  if (!body || typeof body !== "object") return null;
  const { revision, files } = body as Record<string, unknown>;
  if (typeof revision !== "string" || !Array.isArray(files)) return null;
  const out: CanvasRemoteFile[] = [];
  const revisions: Record<string, string> = Object.create(null);
  for (const raw of files) {
    if (!raw || typeof raw !== "object") continue;
    const { path, size, mtime, sha256 } = raw as Record<string, unknown>;
    if (typeof path !== "string" || !isSha(sha256)) continue;
    if (path.startsWith(REVISIONS_PREFIX)) {
      const match = REVISION_FILE_RE.exec(path.slice(REVISIONS_PREFIX.length));
      if (match) revisions[match[1]] = sha256;
      continue;
    }
    if (!path.startsWith(SCOPE_PREFIX)) continue;
    const name = path.slice(SCOPE_PREFIX.length);
    if (!name || name.includes("/") || !isCanvasDocName(name) || isLocalOnlyName(name)) continue;
    out.push({
      name,
      sha256,
      size: typeof size === "number" ? size : 0,
      mtime: typeof mtime === "number" ? mtime : 0,
    });
  }
  return { revision, files: out, revisions };
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
  | { kind: "conflict"; name: string; sha256: string }
  /** 电脑端已删、本机自上次同步未改：删本机（连带同 docKey 译文）。 */
  | { kind: "delete-local"; name: string }
  /** 本机已删、电脑端未改：请电脑端删除。 */
  | { kind: "delete-remote"; name: string }
  /** 电脑端已删、本机改过：清基线后按新建上推（修改优先于删除）。 */
  | { kind: "repush"; name: string }
  /** 两端都已删：只清本机基线。 */
  | { kind: "forget"; name: string };

/** 单轮删除安全阀：超过即整轮不删，只提示。 */
export const CANVAS_MAX_DELETES_PER_ROUND = 20;
export const isDeleteAction = (action: CanvasAction) =>
  action.kind === "delete-local" || action.kind === "delete-remote";

/**
 * 三方比较 本机 sha / 记录的 baseSha / 电脑端 sha：
 * 本机未改 → 拉；电脑端未改 → 推；两边都改且不一致 → 冲突；内容已一致 → 拉（Rust 只补记 baseSha，不下载）。
 * 删除：本机删除时保留 baseSha（missing）；本机有 baseSha 而电脑端没有，视为电脑端已删。
 */
export function planSync(
  remote: readonly CanvasRemoteFile[],
  local: readonly CanvasLocalEntry[],
  missing: readonly CanvasMissingEntry[] = [],
): CanvasAction[] {
  const byName = new Map(local.map((entry) => [entry.name, entry]));
  const gone = new Map(missing.map((entry) => [entry.name, entry.baseSha]));
  const actions: CanvasAction[] = [];
  for (const file of remote) {
    const mine = byName.get(file.name);
    byName.delete(file.name);
    if (!mine) {
      const base = gone.get(file.name);
      gone.delete(file.name);
      if (base === file.sha256) actions.push({ kind: "delete-remote", name: file.name });
      else actions.push({ kind: "pull", name: file.name, sha256: file.sha256 });
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
    if (mine.localOnly) continue;
    if (mine.baseSha === null) actions.push({ kind: "push", name: mine.name });
    else if (mine.sha256 === mine.baseSha) actions.push({ kind: "delete-local", name: mine.name });
    else actions.push({ kind: "repush", name: mine.name });
  }
  for (const name of gone.keys()) actions.push({ kind: "forget", name });
  return actions;
}

/** 电脑端 itemType 只写 'agent'/'group'（canvasHandlers.js:2296）；兼容大小写与复数，其余按 agent。 */
export function normalizeOwnerType(itemType: string | null | undefined): "agent" | "group" {
  const value = String(itemType ?? "").trim().toLowerCase();
  return value === "group" || value === "groups" ? "group" : "agent";
}

export function bindingToTab(binding: CanvasBinding): OpenTabRef {
  return {
    ownerId: binding.agentId,
    ownerType: normalizeOwnerType(binding.itemType),
    topicId: binding.topicId,
  };
}

/** 与电脑端 Canvasmodules/canvas.js isArticleDocument 一致：md/txt/markdown 按 Markdown 预览。 */
export const isArticleName = (name: string) => /\.(md|txt|markdown)$/i.test(name);

// ---------------------------------------------------------------- 修订（ptp4g#49，只读）

/** 同电脑 canvasRevisionTracker 的 NET_CHANGES_ALGORITHM_VERSION；版本不同的缓存不可信。 */
export const NET_CHANGES_ALGORITHM_VERSION = 4;
export const REVISION_STALE_HINT = "修订记录与当前内容不一致，请在电脑端查看";

export interface CanvasRevisionSpan {
  kind: "same" | "ins" | "del";
  text: string;
  author?: string;
  source?: string;
  timestamp?: string | null;
}

export interface CanvasRevisionCounts {
  insert: number;
  delete: number;
  replace: number;
}

export type CanvasRevisionView =
  | { status: "none" }
  | { status: "stale" }
  | { status: "ready"; spans: CanvasRevisionSpan[]; counts: CanvasRevisionCounts; authors: string[] };

export const NO_REVISIONS: CanvasRevisionView = { status: "none" };
const STALE_REVISIONS: CanvasRevisionView = { status: "stale" };

interface RawRevisionHunk {
  afterStart: number;
  afterEnd: number;
  oldText: string;
  newText: string;
  type?: unknown;
  author?: unknown;
  source?: unknown;
  timestamp?: unknown;
}

/** 同电脑 hashContent：UTF-8 正文 sha256 十六进制。 */
async function hashContent(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? "")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const optionalText = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const hunkType = (hunk: RawRevisionHunk): keyof CanvasRevisionCounts => {
  if (hunk.type === "insert" || hunk.type === "delete" || hunk.type === "replace") return hunk.type;
  if (hunk.oldText && hunk.newText) return "replace";
  return hunk.oldText ? "delete" : "insert";
};

/**
 * 只用电脑端 sidecar 缓存的 netChanges，不在手机上重算 diff。
 * 校验同电脑 hasCurrentNetChangesCache：内容哈希（finalContentHash 与 netChangesContentHash）、算法版本、
 * 基线哈希、修订数；再逐条核对 content[afterStart, afterEnd) === newText。任一不符 → stale。
 */
export async function evaluateRevisions(raw: string | null, content: string): Promise<CanvasRevisionView> {
  if (!raw) return NO_REVISIONS;
  let state: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NO_REVISIONS;
    state = parsed as Record<string, unknown>;
  } catch {
    return NO_REVISIONS;
  }
  const changes = state.netChanges;
  if (!Array.isArray(changes) || changes.length === 0) return NO_REVISIONS;
  const hash = await hashContent(content);
  if (
    state.finalContentHash !== hash
    || state.netChangesContentHash !== hash
    || state.netChangesAlgorithmVersion !== NET_CHANGES_ALGORITHM_VERSION
  ) {
    return STALE_REVISIONS;
  }
  if (typeof state.baseContent === "string" && state.netChangesBaseHash !== (await hashContent(state.baseContent))) {
    return STALE_REVISIONS;
  }
  const revisionCount = Array.isArray(state.revisions) ? state.revisions.length : state.revisionCount;
  if (typeof revisionCount === "number" && state.netChangesRevisionCount !== revisionCount) return STALE_REVISIONS;

  const hunks: RawRevisionHunk[] = [];
  for (const change of changes) {
    if (!change || typeof change !== "object") return STALE_REVISIONS;
    const hunk = change as Record<string, unknown>;
    const { afterStart, afterEnd, oldText, newText } = hunk;
    if (!isIndex(afterStart) || !isIndex(afterEnd) || afterEnd < afterStart || afterEnd > content.length) {
      return STALE_REVISIONS;
    }
    if (typeof oldText !== "string" || typeof newText !== "string") return STALE_REVISIONS;
    if (content.slice(afterStart, afterEnd) !== newText) return STALE_REVISIONS;
    hunks.push(hunk as unknown as RawRevisionHunk);
  }
  hunks.sort((a, b) => a.afterStart - b.afterStart || a.afterEnd - b.afterEnd);

  const spans: CanvasRevisionSpan[] = [];
  const counts: CanvasRevisionCounts = { insert: 0, delete: 0, replace: 0 };
  const authors = new Set<string>();
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.afterStart < cursor) return STALE_REVISIONS;
    if (hunk.afterStart > cursor) spans.push({ kind: "same", text: content.slice(cursor, hunk.afterStart) });
    const meta = {
      author: optionalText(hunk.author),
      source: optionalText(hunk.source),
      timestamp: optionalText(hunk.timestamp) ?? null,
    };
    if (hunk.oldText) spans.push({ kind: "del", text: hunk.oldText, ...meta });
    if (hunk.newText) spans.push({ kind: "ins", text: hunk.newText, ...meta });
    counts[hunkType(hunk)] += 1;
    if (meta.author) authors.add(meta.author);
    cursor = hunk.afterEnd;
  }
  if (cursor < content.length) spans.push({ kind: "same", text: content.slice(cursor) });
  return { status: "ready", spans, counts, authors: [...authors] };
}

/** [对话] 切换时限：超时或失败时显示原因与重试，不再停在“正在切换”。 */
export const CHAT_SWITCH_TIMEOUT_MS = 3_000;
export interface ChatSwitchState {
  state: "idle" | "switching" | "failed";
  reason: string | null;
}

const sameRef = (a: OpenTabRef | null, b: OpenTabRef | null) =>
  !!a && !!b && a.ownerId === b.ownerId && a.ownerType === b.ownerType && a.topicId === b.topicId;

export interface ChatSwitcherDeps {
  current: () => OpenTabRef | null;
  open: (tab: OpenTabRef) => Promise<boolean>;
  activate: (tab: OpenTabRef) => Promise<boolean>;
}

/**
 * [对话] 把全局会话切到绑定话题（不新开、不切换聊天标签）；回到 [文稿] 时切回进入前的会话。
 * 切到其他聊天标签时调用 reset，丢弃记录，避免把用户新选的会话改回去。
 */
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
  const reset = () => {
    origin = undefined;
  };
  return { enter, leave, reset, entered: () => origin !== undefined };
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
  /** docKey → 修订 sidecar sha256（来自最近一次 manifest，只读）。 */
  revisions: Record<string, string>;
}

export interface CanvasControllerDeps {
  api: CanvasApi;
  getTarget: () => CanvasTarget | null;
  now?: () => number;
  retryMs?: number;
  /** 电脑同规则 docKey（翻译缓存文件名前缀），删除文稿时连带清本机译文。 */
  docKey?: (name: string) => Promise<string>;
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
    revisions: Object.create(null),
  });
  let generation = 0;
  let waitSeq = 0;
  let waitId: string | null = null;
  let sleepTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeSleep: (() => void) | null = null;
  let running = false;
  let heldDeletes = 0;

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

  const docKeyOf = async (name: string): Promise<string | null> => {
    if (!deps.docKey) return null;
    try {
      return await deps.docKey(name);
    } catch {
      return null;
    }
  };

  /** 请电脑端删除；409 serverSha 为空视为已删，带 sha 说明电脑端改过（Rust 已清基线，下轮拉回）。 */
  const deleteRemoteOne = async (target: CanvasTarget, name: string) => {
    const result = await api.deleteRemote(target, name);
    if (isDisabledStatus(result.status)) throw Object.assign(new Error("disabled"), { disabled: true });
    if (result.status === 409) {
      const serverSha = (result.body as { serverSha?: unknown } | null)?.serverSha;
      if (isSha(serverSha)) notify(`「${name}」电脑端改过，未删除，将重新拉回`);
      return;
    }
    if (result.status !== 200) throw new Error(`删除 ${name} 失败：HTTP ${result.status}`);
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
      const actions = planSync(manifest.files, await api.localList(), await api.localMissing());
      const deletes = actions.filter(isDeleteAction).length;
      const allowDeletes = deletes <= CANVAS_MAX_DELETES_PER_ROUND;
      if (!allowDeletes && deletes !== heldDeletes) {
        notify(`本轮有 ${deletes} 个删除，超过安全上限 ${CANVAS_MAX_DELETES_PER_ROUND}，已暂缓执行`);
      }
      heldDeletes = allowDeletes ? 0 : deletes;
      const failures: string[] = [];
      for (const action of actions) {
        if (gen !== generation) return false;
        if (!allowDeletes && isDeleteAction(action)) continue;
        try {
          if (action.kind === "pull") {
            const pulled = await api.pull(target, action.name, action.sha256);
            if (pulled.status !== 200) failures.push(`${action.name}: HTTP ${pulled.status}`);
          } else if (action.kind === "push") {
            await pushOne(target, action.name);
          } else if (action.kind === "conflict") {
            await resolveConflict(target, action.name, action.sha256);
          } else if (action.kind === "delete-local") {
            await api.localDelete(action.name, await docKeyOf(action.name), false);
          } else if (action.kind === "delete-remote") {
            await deleteRemoteOne(target, action.name);
          } else if (action.kind === "repush") {
            await api.localForget(action.name);
            await pushOne(target, action.name);
          } else {
            await api.localForget(action.name);
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
      state.revisions = manifest.revisions;
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

  /** 删除文稿：本机先删（保留基线作删除记录），联网可用时立即请电脑端删除；离线则下次同步补推。 */
  const deleteDoc = async (name: string) => {
    await api.localDelete(name, await docKeyOf(name), true);
    const target = deps.getTarget();
    if (target && state.status !== "unavailable") {
      try {
        await deleteRemoteOne(target, name);
      } catch (error) {
        if ((error as { disabled?: boolean }).disabled) state.status = "unavailable";
        else state.error = errorText(error);
      }
    }
    await refreshLocal();
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

  /**
   * 打开文稿时按需取修订（只读）：只拉这一篇 docKey 的 sidecar，manifest sha 与本机缓存一致时 Rust 不走网络。
   * 已对过账且电脑端没有这份 sidecar 时不用旧缓存；离线或拉取失败退回缓存，仍由内容哈希把关。
   */
  const loadRevisions = async (name: string, content: string): Promise<CanvasRevisionView> => {
    if (!api.revisionLoad) return NO_REVISIONS;
    const key = await docKeyOf(name);
    if (!key) return NO_REVISIONS;
    const sha = state.revisions[key];
    if (!sha && state.revision !== null) return NO_REVISIONS;
    const target = deps.getTarget();
    if (sha && target && api.revisionPull) {
      try {
        await api.revisionPull(target, key, sha);
      } catch {
        // 退回本机缓存。
      }
    }
    return evaluateRevisions(await api.revisionLoad(key), content);
  };

  return {
    state,
    start,
    stop,
    saveDoc,
    deleteDoc,
    readDoc: (name: string) => api.localRead(name),
    bindingFor,
    bind,
    dismissNotice,
    loadRevisions,
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
  deleteRemote: (t, name) => invoke("canvas_delete", { baseUrl: t.baseUrl, token: t.token, name }),
  localDelete: (name, docKey, keepBase) => invoke("canvas_local_delete", { name, docKey, keepBase }),
  localMissing: () => invoke("canvas_local_missing"),
  localForget: (name) => invoke("canvas_local_forget", { name }),
  revisionLoad: (docKey) => invoke("canvas_revision_load", { docKey }),
  revisionPull: (t, docKey, sha256) =>
    invoke("canvas_revision_pull", { baseUrl: t.baseUrl, token: t.token, docKey, sha256 }),
};

export const useCanvasStore = defineStore("canvas", () => {
  const settingsStore = useSettingsStore();
  const controller = createCanvasController({
    api: tauriCanvasApi,
    getTarget: () => hintTargetFromSettings(settingsStore.settings, true),
    docKey: (name) =>
      import("../../features/canvas/canvasSharedTranslation").then((mod) => mod.canvasDocKey(name)),
  });
  return { ...controller };
});
