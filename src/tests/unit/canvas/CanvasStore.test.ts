import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import {
  bindingToTab,
  createCanvasController,
  createChatSwitcher,
  normalizeCanvasKey,
  parseBindings,
  parseManifest,
  planSync,
  type CanvasApi,
  type CanvasLocalEntry,
  type CanvasTarget,
} from "@/core/stores/canvasStore";
import type { OpenTabRef } from "@/core/stores/openTabsStore";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const TARGET: CanvasTarget = { baseUrl: "http://h:5974", token: "t" };

const local = (name: string, sha256: string, baseSha: string | null, localOnly = false): CanvasLocalEntry => ({
  name,
  sha256,
  baseSha,
  localOnly,
  size: 1,
  mtime: 1,
});

function fakeApi(overrides: Partial<CanvasApi> = {}) {
  let files: CanvasLocalEntry[] = [];
  const api: CanvasApi = {
    manifest: vi.fn(async () => ({ status: 200, body: { revision: "1-1", files: [] } })),
    pull: vi.fn(async () => ({ status: 200, sha256: A, body: null })),
    push: vi.fn(async () => ({ status: 200, sha256: A, body: null })),
    wait: vi.fn(() => new Promise<never>(() => {})),
    cancelWait: vi.fn(),
    bindingsGet: vi.fn(async () => ({ status: 200, body: { revision: "r", bindings: {} } })),
    bindingsPut: vi.fn(async () => ({ status: 200, body: {} })),
    localList: vi.fn(async () => files),
    localRead: vi.fn(async () => ""),
    localWrite: vi.fn(async () => A),
    saveConflict: vi.fn(async (name: string) => name.replace(/\.md$/, ".conflict-手机-1.md")),
    deleteRemote: vi.fn(async () => ({ status: 200, sha256: null, body: { deleted: true } })),
    localDelete: vi.fn(async () => 0),
    localMissing: vi.fn(async () => []),
    localForget: vi.fn(async () => {}),
    ...overrides,
  };
  return { api, setLocal: (next: CanvasLocalEntry[]) => (files = next) };
}

describe("canvas 路径归一", () => {
  it("与电脑端 canvasDocKey 同规则：去 canvas/ 前缀、posix、NFC、小写", () => {
    expect(normalizeCanvasKey("canvas/Note.MD")).toBe("note.md");
    expect(normalizeCanvasKey("canvas\\A.md")).toBe("a.md");
    expect(normalizeCanvasKey("Cafe\u0301.md")).toBe("caf\u00e9.md");
    const bindings = parseBindings({ bindings: { "Note.md": { agentId: "x", topicId: "y", itemType: "agent" } } });
    expect(bindings["note.md"]).toMatchObject({ agentId: "x", topicId: "y" });
  });

  it("manifest 只保留 canvas 根下可同步的 .md/.txt", () => {
    const parsed = parseManifest({
      revision: "9-4",
      files: [
        { path: "canvas/a.md", size: 1, mtime: 1, sha256: A },
        { path: "canvas/b.png", size: 1, mtime: 1, sha256: A },
        { path: "CanvasRevisions/x/y.json", size: 1, mtime: 1, sha256: A },
        { path: "canvas/c.conflict-手机-1.md", size: 1, mtime: 1, sha256: A },
      ],
    });
    expect(parsed?.revision).toBe("9-4");
    expect(parsed?.files.map((f) => f.name)).toEqual(["a.md"]);
    expect(parseManifest({ revision: 1, files: [] })).toBeNull();
  });
});

describe("planSync 三方比较", () => {
  const remote = (name: string, sha256: string) => ({ name, sha256, size: 1, mtime: 1 });
  it("按 本机/base/电脑端 决定拉、推、冲突", () => {
    const actions = planSync(
      [remote("new.md", A), remote("pull.md", B), remote("push.md", A), remote("both.md", C), remote("same.md", A)],
      [
        local("pull.md", A, A),
        local("push.md", B, A),
        local("both.md", B, A),
        local("same.md", A, A),
        local("mine.md", B, null),
        local("gone.md", B, B),
        local("x.conflict-手机-1.md", B, null, true),
      ],
    );
    expect(actions).toEqual([
      { kind: "pull", name: "new.md", sha256: A },
      { kind: "pull", name: "pull.md", sha256: B },
      { kind: "push", name: "push.md" },
      { kind: "conflict", name: "both.md", sha256: C },
      { kind: "push", name: "mine.md" },
      { kind: "delete-local", name: "gone.md" },
    ]);
  });
});

describe("canvas controller", () => {
  it("双方都改过：本机另存冲突副本、拉电脑端版本并提示", async () => {
    const { api, setLocal } = fakeApi({
      manifest: vi.fn(async () => ({ status: 200, body: { revision: "2-1", files: [{ path: "canvas/a.md", size: 1, mtime: 1, sha256: C }] } })),
    });
    setLocal([local("a.md", B, A)]);
    const ctl = createCanvasController({ api, getTarget: () => TARGET });
    await ctl.start();
    expect(api.saveConflict).toHaveBeenCalledWith("a.md");
    expect(api.pull).toHaveBeenCalledWith(TARGET, "a.md", C);
    expect(ctl.state.notices[0]).toContain("a.conflict-手机-1.md");
    expect(ctl.state.status).toBe("ready");
    ctl.stop();
  });

  it("保存后上推遇 409：走冲突副本并用 serverSha 拉取", async () => {
    const { api } = fakeApi({
      push: vi.fn(async () => ({ status: 409, sha256: null, body: { serverSha: C } })),
    });
    const ctl = createCanvasController({ api, getTarget: () => TARGET });
    const synced = await ctl.saveDoc("a.md", "edited");
    expect(api.localWrite).toHaveBeenCalledWith("a.md", "edited");
    expect(api.saveConflict).toHaveBeenCalledWith("a.md");
    expect(api.pull).toHaveBeenCalledWith(TARGET, "a.md", C);
    expect(synced).toBe(true);
  });

  it("无 target 时不发请求；电脑端 404 显示未启用且不订阅", async () => {
    const off = fakeApi();
    const ctlOff = createCanvasController({ api: off.api, getTarget: () => null });
    await ctlOff.start();
    expect(ctlOff.state.status).toBe("disabled");
    expect(off.api.manifest).not.toHaveBeenCalled();

    const missing = fakeApi({ manifest: vi.fn(async () => ({ status: 404, body: null })) });
    const ctl = createCanvasController({ api: missing.api, getTarget: () => TARGET });
    await ctl.start();
    expect(ctl.state.status).toBe("unavailable");
    await Promise.resolve();
    expect(missing.api.wait).not.toHaveBeenCalled();
  });

  it("wait 带 revision 订阅；stop 取消在途 wait，迟到的变化不再触发同步", async () => {
    let resolveWait: (value: { status: number; body: unknown }) => void = () => {};
    const { api } = fakeApi({
      wait: vi.fn(() => new Promise<{ status: number; body: unknown }>((resolve) => (resolveWait = resolve))),
    });
    const ctl = createCanvasController({ api, getTarget: () => TARGET });
    await ctl.start();
    await vi.waitFor(() => expect(api.wait).toHaveBeenCalledTimes(1));
    const [requestId, , since] = vi.mocked(api.wait).mock.calls[0];
    expect(since).toBe("1-1");
    ctl.stop();
    expect(api.cancelWait).toHaveBeenCalledWith(requestId);
    resolveWait({ status: 200, body: { changed: true, revision: "2-2" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.manifest).toHaveBeenCalledTimes(1);
    expect(api.wait).toHaveBeenCalledTimes(1);
    expect(ctl.isRunning()).toBe(false);
  });
});

describe("对话标签往返", () => {
  it("进入时记住原标签，返回时切回；原本就是绑定话题则不切", async () => {
    const origin: OpenTabRef = { ownerId: "o", ownerType: "agent", topicId: "t0" };
    let current: OpenTabRef | null = origin;
    const open = vi.fn(async (tab: OpenTabRef) => ((current = tab), true));
    const activate = vi.fn(async (tab: OpenTabRef) => ((current = tab), true));
    const switcher = createChatSwitcher({ current: () => current, open, activate });
    const target = bindingToTab({ agentId: "g", topicId: "t1", itemType: "group" });
    expect(target).toEqual({ ownerId: "g", ownerType: "group", topicId: "t1" });

    await switcher.enter(target);
    await switcher.enter(target); // 重复进入不覆盖原标签
    expect(current).toEqual(target);
    expect(await switcher.leave()).toBe(true);
    expect(activate).toHaveBeenCalledWith(origin);
    expect(current).toEqual(origin);
    expect(await switcher.leave()).toBe(false);

    current = target;
    await switcher.enter(target);
    expect(await switcher.leave()).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
