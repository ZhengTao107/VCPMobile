import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import {
  createLibraryRemote,
  FAVORITES_PATH,
  isLibraryPath,
  LIBRARY_BACKOFF_MIN_MS,
  LIBRARY_PUSH_DEBOUNCE_MS,
  mergeFavoritesForPush,
  parseWarehouse,
  WAREHOUSE_PATH,
  type LibraryLocalEntry,
  type LibraryTransferResult,
} from "@/core/sync/libraryRemote";

const sha = (text: string) => `sha:${text.length}:${text}`;
const favJson = (ids: string[]) => `${JSON.stringify(ids, null, 2)}\n`;
const ok = (sha256: string | null): LibraryTransferResult => ({ status: 200, sha256, body: null });

/** 内存版电脑端 + 本机镜像；pull/push 语义与 Rust library_sync 一致（expected 命中免下载、baseSha 不符回 409）。 */
function harness(server: Record<string, string>, localFavorites: string[] = []) {
  const mirror = new Map<string, string>();
  const base = new Map<string, string>();
  let sqlite = [...localFavorites];
  const state = { clock: 1_000, manifestStatus: 200, pushStatus: 0 };
  let target: { baseUrl: string; token: string } | null = { baseUrl: "http://pc.example:5974", token: "test-token" };

  const manifest = vi.fn(async () =>
    state.manifestStatus === 200
      ? {
          status: 200,
          body: { files: Object.entries(server).map(([path, content]) => ({ path, sha256: sha(content) })) },
        }
      : { status: state.manifestStatus, body: null },
  );
  const pull = vi.fn(async (_t: unknown, path: string, expected: string | null) => {
    const local = mirror.get(path);
    if (expected && local !== undefined && sha(local) === expected) {
      base.set(path, expected);
      return ok(expected);
    }
    const content = server[path];
    if (content === undefined) return { status: 404, sha256: null, body: null };
    mirror.set(path, content);
    base.set(path, sha(content));
    return ok(sha(content));
  });
  const push = vi.fn(async (_t: unknown, path: string): Promise<LibraryTransferResult> => {
    if (state.pushStatus) return { status: state.pushStatus, sha256: null, body: null };
    const current = server[path];
    if (current !== undefined && sha(current) !== (base.get(path) ?? null)) {
      return { status: 409, sha256: null, body: { serverSha: sha(current) } };
    }
    const content = mirror.get(path)!;
    server[path] = content;
    base.set(path, sha(content));
    return ok(sha(content));
  });
  const replaceFavorites = vi.fn(async (models: string[]) => {
    sqlite = [...models];
    return sqlite;
  });
  const onLibrary = vi.fn();

  const remote = createLibraryRemote({
    getTarget: () => target,
    manifest,
    pull,
    push,
    localList: async (): Promise<LibraryLocalEntry[]> =>
      [...mirror].map(([path, content]) => ({ path, sha256: sha(content), baseSha: base.get(path) ?? null })),
    localRead: async (path) => {
      const content = mirror.get(path);
      if (content === undefined) throw new Error("NOT_FOUND");
      return content;
    },
    localWrite: async (path, content) => {
      mirror.set(path, content);
      return sha(content);
    },
    localRemove: async (path) => {
      mirror.delete(path);
      base.delete(path);
    },
    readFavorites: async () => [...sqlite],
    replaceFavorites,
    onLibrary,
    now: () => state.clock,
  });

  return {
    remote,
    server,
    mirror,
    state,
    manifest,
    pull,
    push,
    replaceFavorites,
    onLibrary,
    sqlite: () => sqlite,
    /** 模拟本机 toggle：新收藏排在最前（export 的 DESC 顺序）。 */
    favorite: (id: string) => {
      sqlite = sqlite.includes(id) ? sqlite.filter((item) => item !== id) : [id, ...sqlite];
    },
    setTarget: (next: typeof target) => {
      target = next;
    },
    /** 触发防抖上推并等队列排空。 */
    flushPush: async () => {
      remote.schedulePush();
      await vi.advanceTimersByTimeAsync(LIBRARY_PUSH_DEBOUNCE_MS);
      await remote.refreshLocal();
    },
  };
}

const presetA = "systemPromptPresets/写作.md";
const presetB = "systemPromptPresets/代码.txt";

describe("libraryRemote 纯函数", () => {
  it("路径白名单只认两个根文件与预设根下的 md/txt", () => {
    expect(isLibraryPath(WAREHOUSE_PATH)).toBe(true);
    expect(isLibraryPath(FAVORITES_PATH)).toBe(true);
    expect(isLibraryPath(presetA)).toBe(true);
    for (const bad of [
      "settings.json",
      "canvas/a.md",
      "systemPromptPresets/sub/x.md",
      "systemPromptPresets/x.md.bak",
      "systemPromptPresets/.hidden.md",
      "systemPromptPresets/x.json",
      "systemPromptPresets/x.conflict-1.md",
      "../model_favorites.json",
    ]) {
      expect(isLibraryPath(bad)).toBe(false);
    }
  });

  it("收藏合并保留电脑端顺序、去掉已取消、新增按先后追加", () => {
    expect(mergeFavoritesForPush(["a", "b", "c"], ["e", "d", "a", "c"])).toEqual(["a", "c", "d", "e"]);
  });

  it("仓库解析跳过换行块与空块，取选中的变体", () => {
    const text = JSON.stringify([
      { id: "1", content: "甲" },
      { id: "2", type: "newline" },
      { id: "3", content: "  " },
      { id: "4", variants: ["乙0", "乙1"], selectedVariant: 1, disabled: true },
    ]);
    expect(parseWarehouse(text)).toEqual([
      { id: "1", content: "甲", disabled: false },
      { id: "4", content: "乙1", disabled: true },
    ]);
    expect(parseWarehouse("not json")).toEqual([]);
  });
});

describe("createLibraryRemote", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("三类数据拉取到本机，白名单外路径不拉不推，收藏整表写入 SQLite", async () => {
    const h = harness({
      [WAREHOUSE_PATH]: JSON.stringify([{ id: "w1", content: "全局块" }]),
      [presetA]: "写作预设",
      [presetB]: "代码预设",
      [FAVORITES_PATH]: favJson(["m1", "m2"]),
      "settings.json": "{}",
      "canvas/doc.md": "x",
      "systemPromptPresets/sub/x.md": "x",
    });
    await h.remote.sync();
    const pulled = h.pull.mock.calls.map((call) => call[1]).sort();
    expect(pulled).toEqual([FAVORITES_PATH, WAREHOUSE_PATH, presetB, presetA].sort());
    expect(h.push).not.toHaveBeenCalled();
    expect(h.sqlite()).toEqual(["m1", "m2"]);
    const calls = h.onLibrary.mock.calls;
    const library = calls[calls.length - 1][0];
    expect(library.warehouse).toEqual([{ id: "w1", content: "全局块", disabled: false }]);
    expect(library.presets.map((p: { name: string }) => p.name).sort()).toEqual(["代码", "写作"].sort());
  });

  it("本机加星防抖后只上推收藏文件，追加在电脑端数组末尾", async () => {
    const h = harness({ [FAVORITES_PATH]: favJson(["m1", "m2"]), [presetA]: "p" });
    await h.remote.sync();
    h.favorite("m3");
    await h.flushPush();
    expect(h.push.mock.calls.map((call) => call[1])).toEqual([FAVORITES_PATH]);
    expect(h.server[FAVORITES_PATH]).toBe(favJson(["m1", "m2", "m3"]));
  });

  it("电脑端先改过收藏时 409，以电脑端为准覆盖本机", async () => {
    const h = harness({ [FAVORITES_PATH]: favJson(["m1"]) });
    await h.remote.sync();
    h.server[FAVORITES_PATH] = favJson(["m1", "pc"]);
    h.favorite("phone");
    await h.flushPush();
    expect(h.server[FAVORITES_PATH]).toBe(favJson(["m1", "pc"]));
    expect(h.sqlite()).toEqual(["m1", "pc"]);
  });

  it("上推失败后镜像仍算未推出，下次重推", async () => {
    const h = harness({ [FAVORITES_PATH]: favJson(["m1"]) });
    await h.remote.sync();
    h.state.pushStatus = 500;
    h.favorite("m2");
    await h.flushPush();
    expect(h.server[FAVORITES_PATH]).toBe(favJson(["m1"]));
    h.state.pushStatus = 0;
    await h.flushPush();
    expect(h.server[FAVORITES_PATH]).toBe(favJson(["m1", "m2"]));
  });

  it("只读副本被本机改动时重拉覆盖，电脑端删掉的预设本机随之删除", async () => {
    const h = harness({ [presetA]: "A", [presetB]: "B" });
    await h.remote.sync();
    h.mirror.set(presetA, "本机改过");
    delete h.server[presetB];
    await h.remote.sync();
    expect(h.mirror.get(presetA)).toBe("A");
    expect(h.mirror.has(presetB)).toBe(false);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("404/503 退避，换目标立即重试", async () => {
    const h = harness({});
    h.state.manifestStatus = 404;
    await h.remote.sync();
    await h.remote.sync();
    expect(h.manifest).toHaveBeenCalledTimes(1);
    h.state.clock += LIBRARY_BACKOFF_MIN_MS;
    h.state.manifestStatus = 503;
    await h.remote.sync();
    expect(h.manifest).toHaveBeenCalledTimes(2);
    h.setTarget({ baseUrl: "http://other.example:5974", token: "test-token" });
    await h.remote.sync();
    expect(h.manifest).toHaveBeenCalledTimes(3);
  });

  it("首次 manifest 成功前不上推", async () => {
    const h = harness({ [FAVORITES_PATH]: favJson([]) }, ["m1"]);
    await h.flushPush();
    expect(h.push).not.toHaveBeenCalled();
  });
});
