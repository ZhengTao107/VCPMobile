import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import {
  CANVAS_MAX_DELETES_PER_ROUND,
  createCanvasController,
  planSync,
  type CanvasApi,
  type CanvasLocalEntry,
  type CanvasMissingEntry,
} from "@/core/stores/canvasStore";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const TARGET = { baseUrl: "http://h:5974", token: "t" };
const local = (name: string, sha256: string, baseSha: string | null): CanvasLocalEntry => ({
  name,
  sha256,
  baseSha,
  localOnly: false,
  size: 1,
  mtime: 1,
});
const remote = (name: string, sha256: string) => ({ name, sha256, size: 1, mtime: 1 });
const gone = (name: string, baseSha: string): CanvasMissingEntry => ({ name, baseSha });

describe("planSync：删除双向同步", () => {
  it("电脑端已删：本机未改删本机，本机改过按新建上推", () => {
    expect(planSync([], [local("a.md", A, A), local("b.md", B, A)])).toEqual([
      { kind: "delete-local", name: "a.md" },
      { kind: "repush", name: "b.md" },
    ]);
  });

  it("本机已删：电脑端未改请电脑端删，电脑端改过拉回，两端都删只清基线", () => {
    expect(
      planSync([remote("a.md", A), remote("b.md", C)], [], [gone("a.md", A), gone("b.md", A), gone("c.md", A)]),
    ).toEqual([
      { kind: "delete-remote", name: "a.md" },
      { kind: "pull", name: "b.md", sha256: C },
      { kind: "forget", name: "c.md" },
    ]);
  });

  it("从未同步过的本机文件仍按新建上推", () => {
    expect(planSync([], [local("n.md", A, null)])).toEqual([{ kind: "push", name: "n.md" }]);
  });
});

function makeApi(
  files: Array<{ name: string; sha256: string }>,
  entries: CanvasLocalEntry[],
  missing: CanvasMissingEntry[] = [],
  overrides: Partial<CanvasApi> = {},
): CanvasApi {
  return {
    manifest: vi.fn(async () => ({
      status: 200,
      body: {
        revision: "1",
        files: files.map((f) => ({ path: `canvas/${f.name}`, size: 1, mtime: 1, sha256: f.sha256 })),
      },
    })),
    pull: vi.fn(async () => ({ status: 200, sha256: A, body: null })),
    push: vi.fn(async () => ({ status: 200, sha256: A, body: null })),
    wait: vi.fn(() => new Promise<never>(() => {})),
    cancelWait: vi.fn(),
    bindingsGet: vi.fn(async () => ({ status: 200, body: { revision: "r", bindings: {} } })),
    bindingsPut: vi.fn(async () => ({ status: 200, body: {} })),
    localList: vi.fn(async () => entries),
    localRead: vi.fn(async () => ""),
    localWrite: vi.fn(async () => A),
    saveConflict: vi.fn(async (name: string) => name),
    deleteRemote: vi.fn(async () => ({ status: 200, sha256: null, body: { deleted: true } })),
    localDelete: vi.fn(async () => 0),
    localMissing: vi.fn(async () => missing),
    localForget: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("Canvas 控制器：删除", () => {
  it("同步时执行两个方向的删除，删本机带 docKey", async () => {
    const api = makeApi([remote("b.md", B)], [local("a.md", A, A)], [gone("b.md", B)]);
    const ctrl = createCanvasController({ api, getTarget: () => TARGET, docKey: async (n) => `key:${n}` });
    await ctrl.start();
    ctrl.stop();
    expect(api.localDelete).toHaveBeenCalledWith("a.md", "key:a.md", false);
    expect(api.deleteRemote).toHaveBeenCalledWith(TARGET, "b.md");
  });

  it("删除数超过安全上限时整轮不删并提示", async () => {
    const entries = Array.from({ length: CANVAS_MAX_DELETES_PER_ROUND + 1 }, (_, i) => local(`d${i}.md`, A, A));
    const api = makeApi([], entries);
    const ctrl = createCanvasController({ api, getTarget: () => TARGET });
    await ctrl.start();
    ctrl.stop();
    expect(api.localDelete).not.toHaveBeenCalled();
    expect(ctrl.state.notices.some((n) => n.includes("安全上限"))).toBe(true);
  });

  it("deleteDoc：本机先删并保留基线，再请电脑端删；电脑端改过时提示将拉回", async () => {
    const api = makeApi([], [], [], {
      deleteRemote: vi.fn(async () => ({ status: 409, sha256: null, body: { serverSha: C } })),
    });
    const ctrl = createCanvasController({ api, getTarget: () => TARGET, docKey: async () => "k" });
    await ctrl.deleteDoc("a.md");
    expect(api.localDelete).toHaveBeenCalledWith("a.md", "k", true);
    expect(api.deleteRemote).toHaveBeenCalledWith(TARGET, "a.md");
    expect(ctrl.state.notices.some((n) => n.includes("电脑端改过"))).toBe(true);
  });
});
