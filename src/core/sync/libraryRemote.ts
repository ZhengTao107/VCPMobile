import { ref, watch } from "vue";
import { getActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settings";
import { useModelStore } from "../stores/modelStore";
import { hintTargetFromSettings, onRemoteHint, type HintTarget } from "./remoteChangeHint";

/**
 * 电脑端提示词库与模型收藏同步（ptp4g#47），走 VCPCanvasSync 的 `/manifest` + `/file`：
 * - `global_prompt_warehouse.json`：全局提示词仓库（block 数组），手机只读查看与选用。
 * - `systemPromptPresets/*.md|txt`：系统提示词预设，手机只读查看与选用；电脑端删掉的预设本机随之删除。
 * - `model_favorites.json`：模型收藏（id 数组，电脑端新收藏追加在末尾），手机可增删并回推。
 *
 * 规则：
 * - 拉取：同步目标出现、回到前台、remote-hint 时拉 manifest；sha 与本机基线不同即拉取覆盖（以电脑端为准），
 *   收藏覆盖后整表写回 SQLite。首次 manifest 成功前不上推。
 * - 上推：本机收藏与镜像不同时防抖 2s，按"保留镜像顺序、去掉已取消、新增追加到末尾"合并后带 baseSha 上推；
 *   409 说明电脑端先改了，拉取并以电脑端为准。
 * - 404/503 视为电脑端未启用，静默指数退避（1 分钟起，最长 30 分钟）。
 * - 不同步地址、Key、本机路径：三类文件内容本身不含这些，路径白名单在 Rust（sync/library_sync.rs）再校验一次。
 */
export const LIBRARY_PUSH_DEBOUNCE_MS = 2_000;
export const LIBRARY_BACKOFF_MIN_MS = 60_000;
export const LIBRARY_BACKOFF_MAX_MS = 30 * 60_000;
export const WAREHOUSE_PATH = "global_prompt_warehouse.json";
export const FAVORITES_PATH = "model_favorites.json";
export const PRESETS_PREFIX = "systemPromptPresets/";

export interface LibraryHttpResponse {
  status: number;
  body: unknown;
}

export interface LibraryTransferResult {
  status: number;
  sha256: string | null;
  body: unknown;
}

export interface LibraryLocalEntry {
  path: string;
  sha256: string;
  baseSha: string | null;
}

export interface WarehouseBlock {
  id: string;
  content: string;
  disabled: boolean;
}

export interface PromptPreset {
  name: string;
  path: string;
  content: string;
}

export interface PromptLibrary {
  warehouse: WarehouseBlock[];
  presets: PromptPreset[];
}

/** 与 Rust validate_path 同规则：两个根文件，或 systemPromptPresets 根下的 .md/.txt。 */
export function isLibraryPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path === WAREHOUSE_PATH || path === FAVORITES_PATH) return true;
  if (!path.startsWith(PRESETS_PREFIX)) return false;
  const name = path.slice(PRESETS_PREFIX.length);
  return /^[^/\\:]+\.(md|txt)$/i.test(name)
    && !name.startsWith(".")
    && !name.includes(".bak")
    && !name.includes(".conflict-");
}

const uniqueIds = (list: unknown[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

/** 电脑端读到非数组时当作空；这里非法 JSON 返回 null，交给调用方保持现状。 */
export function parseFavorites(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? uniqueIds(value) : [];
  } catch {
    return null;
  }
}

/** 本机收藏推回电脑端的数组：保留镜像（电脑端）顺序，去掉本机已取消的，本机新增的按收藏先后追加到末尾。 */
export function mergeFavoritesForPush(mirror: string[], localNewestFirst: string[]): string[] {
  const local = new Set(localNewestFirst);
  const kept = mirror.filter((id) => local.has(id));
  const known = new Set(mirror);
  const added = localNewestFirst.filter((id) => !known.has(id)).reverse();
  return [...kept, ...added];
}

const sameSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
};

const blockText = (raw: Record<string, unknown>): string => {
  if (Array.isArray(raw.variants) && raw.variants.length > 0) {
    const index = typeof raw.selectedVariant === "number" ? raw.selectedVariant : 0;
    const variant = raw.variants[index] ?? raw.variants[0];
    if (typeof variant === "string") return variant;
  }
  return typeof raw.content === "string" ? raw.content : "";
};

/** 仓库是 modular-prompt-module 的 block 数组；换行块与空块不列出。 */
export function parseWarehouse(text: string | null): WarehouseBlock[] {
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const blocks: WarehouseBlock[] = [];
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const record = raw as Record<string, unknown>;
    if (record.type === "newline") return;
    const content = blockText(record);
    if (!content.trim()) return;
    blocks.push({
      id: typeof record.id === "string" && record.id ? record.id : `block-${index}`,
      content,
      disabled: record.disabled === true,
    });
  });
  return blocks;
}

export const presetName = (path: string) =>
  path.slice(PRESETS_PREFIX.length).replace(/\.(md|txt)$/i, "");

export interface LibraryRemoteDeps {
  getTarget: () => HintTarget | null;
  manifest: (target: HintTarget) => Promise<LibraryHttpResponse>;
  pull: (target: HintTarget, path: string, sha256: string | null) => Promise<LibraryTransferResult>;
  push: (target: HintTarget, path: string) => Promise<LibraryTransferResult>;
  localList: () => Promise<LibraryLocalEntry[]>;
  localRead: (path: string) => Promise<string>;
  localWrite: (path: string, content: string) => Promise<string>;
  localRemove: (path: string) => Promise<void>;
  /** SQLite 收藏，新收藏在前（export_favorite_models 的 DESC 顺序）。 */
  readFavorites: () => Promise<string[]>;
  /** 以电脑端数组整表替换 SQLite 收藏，返回写入后的顺序。 */
  replaceFavorites: (models: string[]) => Promise<string[]>;
  onLibrary?: (library: PromptLibrary) => void;
  now?: () => number;
}

export interface LibraryRemote {
  sync: () => Promise<void>;
  refreshLocal: () => Promise<void>;
  schedulePush: () => void;
  dispose: () => void;
}

const isDisabledStatus = (status: number) => status === 404 || status === 503;

export function createLibraryRemote(deps: LibraryRemoteDeps): LibraryRemote {
  const now = deps.now ?? Date.now;
  let synced = false;
  let disposed = false;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 0;
  let blockedUntil = 0;
  // sync 与上推共用一条队列：两者都读写同一份镜像与 baseSha。
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>) => {
    const run = queue.then(job).catch((error) => console.warn("[LibraryRemote]", error));
    queue = run;
    return run;
  };

  const backingOff = () => now() < blockedUntil;
  const backOff = () => {
    backoffMs = backoffMs ? Math.min(backoffMs * 2, LIBRARY_BACKOFF_MAX_MS) : LIBRARY_BACKOFF_MIN_MS;
    blockedUntil = now() + backoffMs;
  };
  const recover = () => {
    backoffMs = 0;
    blockedUntil = 0;
  };

  const readMirror = (path: string) => deps.localRead(path).catch(() => null);

  const refreshLocal = async () => {
    if (!deps.onLibrary) return;
    const entries = await deps.localList();
    const presets: PromptPreset[] = [];
    for (const entry of entries) {
      if (!entry.path.startsWith(PRESETS_PREFIX)) continue;
      const content = await readMirror(entry.path);
      if (content !== null) presets.push({ name: presetName(entry.path), path: entry.path, content });
    }
    presets.sort((a, b) => a.name.localeCompare(b.name));
    const warehouse = parseWarehouse(await readMirror(WAREHOUSE_PATH));
    if (!disposed) deps.onLibrary({ warehouse, presets });
  };

  const applyRemoteFavorites = async () => {
    const list = parseFavorites(await readMirror(FAVORITES_PATH));
    if (list !== null) await deps.replaceFavorites(list);
  };

  const pushFavorites = async (target: HintTarget) => {
    const mirrorText = await readMirror(FAVORITES_PATH);
    const mirror = parseFavorites(mirrorText);
    if (mirrorText !== null && mirror === null) return; // 镜像损坏：等下次拉取覆盖
    const local = await deps.readFavorites();
    // 镜像相对基线有未推出的改动（上次上推失败）也要重推，不能只比 SQLite 与镜像。
    const entry = (await deps.localList()).find((item) => item.path === FAVORITES_PATH);
    const mirrorDirty = !!entry && entry.sha256 !== entry.baseSha;
    if (sameSet(local, mirror ?? []) && !mirrorDirty) return;
    const next = mergeFavoritesForPush(mirror ?? [], local);
    await deps.localWrite(FAVORITES_PATH, `${JSON.stringify(next, null, 2)}\n`);
    const result = await deps.push(target, FAVORITES_PATH);
    if (isDisabledStatus(result.status)) {
      backOff();
      return;
    }
    if (result.status === 409) {
      // 电脑端先改了：以电脑端为准。
      const serverSha = (result.body as { serverSha?: unknown } | null)?.serverSha;
      const pulled = await deps.pull(target, FAVORITES_PATH, typeof serverSha === "string" ? serverSha : null);
      if (pulled.status === 200) await applyRemoteFavorites();
      return;
    }
    if (result.status !== 200) console.warn(`[LibraryRemote] favorites push failed: HTTP ${result.status}`);
    else recover();
  };

  let lastTargetKey: string | null = null;
  const runSync = async () => {
    const target = deps.getTarget();
    if (!target || disposed) return;
    const targetKey = `${target.baseUrl}\n${target.token}`;
    if (targetKey !== lastTargetKey) {
      // 换了电脑或 Token：旧目标的退避不作数。
      lastTargetKey = targetKey;
      recover();
    }
    if (backingOff()) return;
    const response = await deps.manifest(target);
    if (disposed) return;
    if (isDisabledStatus(response.status)) {
      backOff();
      return;
    }
    if (response.status !== 200) {
      console.warn(`[LibraryRemote] manifest failed: HTTP ${response.status}`);
      return;
    }
    recover();
    const files = (response.body as { files?: unknown } | null)?.files;
    const remote = new Map<string, string>();
    if (Array.isArray(files)) {
      for (const file of files) {
        const { path, sha256 } = (file ?? {}) as { path?: unknown; sha256?: unknown };
        if (isLibraryPath(path) && typeof sha256 === "string") remote.set(path, sha256);
      }
    }
    const local = new Map((await deps.localList()).map((entry) => [entry.path, entry]));
    let favoritesPulled = false;
    let failed = false;
    for (const [path, sha] of remote) {
      const entry = local.get(path);
      if (entry?.baseSha === sha && (entry.sha256 === sha || path === FAVORITES_PATH)) {
        // 电脑端未变；本机收藏的改动由下面的上推处理。
        continue;
      }
      // 电脑端变了，或本机只读副本（预设、仓库）被改过：以电脑端为准重新拉取。
      const result = await deps.pull(target, path, sha);
      if (disposed) return;
      if (result.status !== 200) {
        console.warn(`[LibraryRemote] pull ${path} failed: HTTP ${result.status}`);
        failed = true;
        continue;
      }
      if (path === FAVORITES_PATH) favoritesPulled = true;
    }
    for (const entry of local.values()) {
      if (entry.path.startsWith(PRESETS_PREFIX) && entry.baseSha && !remote.has(entry.path)) {
        await deps.localRemove(entry.path);
      }
    }
    if (favoritesPulled) await applyRemoteFavorites();
    synced = true;
    await refreshLocal();
    if (!failed) await pushFavorites(target);
  };

  const flushPush = async () => {
    pushTimer = null;
    const target = deps.getTarget();
    if (!target || !synced || disposed || backingOff()) return;
    await pushFavorites(target);
  };

  const schedulePush = () => {
    if (disposed || !synced || !deps.getTarget()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void enqueue(flushPush), LIBRARY_PUSH_DEBOUNCE_MS);
  };

  const dispose = () => {
    disposed = true;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
  };

  return {
    sync: () => enqueue(runSync),
    refreshLocal: () => enqueue(refreshLocal),
    schedulePush,
    dispose,
  };
}

/** 供设置页与 Agent 设置页读取的本机镜像视图。 */
export const promptLibrary = ref<PromptLibrary>({ warehouse: [], presets: [] });

let activeDispose: (() => void) | null = null;

/** 应用级单例：由 useAppLifecycle 挂载，返回卸载函数。 */
export function useLibraryRemote(isForeground: () => boolean): () => void {
  activeDispose?.();
  if (!getActivePinia()) return () => {};
  const settingsStore = useSettingsStore();
  const modelStore = useModelStore();
  const getTarget = () => hintTargetFromSettings(settingsStore.settings, isForeground());
  const remote = createLibraryRemote({
    getTarget,
    manifest: (t) => invoke<LibraryHttpResponse>("canvas_manifest", { baseUrl: t.baseUrl, token: t.token }),
    pull: (t, path, sha256) =>
      invoke<LibraryTransferResult>("library_pull", { baseUrl: t.baseUrl, token: t.token, path, sha256 }),
    push: (t, path) => invoke<LibraryTransferResult>("library_push", { baseUrl: t.baseUrl, token: t.token, path }),
    localList: async () => {
      const entries = await invoke<LibraryLocalEntry[] | null>("library_local_list");
      return Array.isArray(entries) ? entries : [];
    },
    localRead: (path) => invoke<string>("library_local_read", { path }),
    localWrite: (path, content) => invoke<string>("library_local_write", { path, content }),
    localRemove: (path) => invoke<void>("library_local_remove", { path }),
    readFavorites: async () => {
      const list = await invoke<string[] | null>("get_favorite_models");
      return Array.isArray(list) ? list : [];
    },
    replaceFavorites: async (models) => {
      const result = await invoke<string[] | null>("sync_replace_favorite_models", { models });
      const saved = Array.isArray(result) ? result : [...models];
      modelStore.favorites = saved;
      return saved;
    },
    onLibrary: (library) => {
      promptLibrary.value = library;
    },
  });
  void remote.refreshLocal();
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
  const stopFavorites = watch(
    () => [...modelStore.favorites],
    () => remote.schedulePush(),
  );
  const dispose = () => {
    stopTarget();
    stopHint();
    stopFavorites();
    remote.dispose();
    if (activeDispose === dispose) activeDispose = null;
  };
  activeDispose = dispose;
  return dispose;
}
