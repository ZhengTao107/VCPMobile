import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { mountWithPinia } from "@/tests/utils/mount";
import CanvasDocPane from "@/features/canvas/CanvasDocPane.vue";
import { canvasDocKey } from "@/features/canvas/canvasSharedTranslation";
import {
  createCanvasController,
  evaluateRevisions,
  parseManifest,
  REVISION_STALE_HINT,
  type CanvasApi,
  type CanvasRevisionView,
} from "@/core/stores/canvasStore";

// 真实 sidecar（电脑 AppData/CanvasRevisions/<sha256("tgfs.txt")>.json）与 TGFS.txt 的裁剪件；
// 读入后统一 LF，避免 autocrlf 改动正文导致哈希漂移。
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, "fixtures", name), "utf8").replace(/\r\n/g, "\n");
const CONTENT = fixture("tgfs.txt");
const SIDECAR = fixture("tgfs.revisions.json");
const TGFS_KEY = "0c5aeb7ffcbf89c864bcb0fd12a035868da532a863db4dd6e23f3aa01d4cb1b6";
const A = "a".repeat(64);
const R1 = "1".repeat(64);
const R2 = "2".repeat(64);
const OTHER_KEY = "f".repeat(64);

describe("修订 manifest 分流", () => {
  it("CanvasRevisions/<docKey>.json 单独暴露，不进文稿列表；jsonl 与子目录不收", () => {
    const parsed = parseManifest({
      revision: "9-4",
      files: [
        { path: "canvas/tgfs.txt", size: 1, mtime: 1, sha256: A },
        { path: `CanvasRevisions/${TGFS_KEY}.json`, size: 1, mtime: 1, sha256: R1 },
        { path: `CanvasRevisions/${TGFS_KEY}.json.revisions.jsonl`, size: 1, mtime: 1, sha256: R2 },
        { path: `CanvasRevisions/x/${OTHER_KEY}.json`, size: 1, mtime: 1, sha256: R2 },
        { path: "CanvasRevisions/x/y.json", size: 1, mtime: 1, sha256: A },
      ],
    });
    expect(parsed?.files.map((f) => f.name)).toEqual(["tgfs.txt"]);
    expect({ ...parsed?.revisions }).toEqual({ [TGFS_KEY]: R1 });
  });

  it("手机 docKey 与电脑 portable key 一致", async () => {
    expect(await canvasDocKey("TGFS.txt")).toBe(TGFS_KEY);
  });
});

describe("evaluateRevisions（真实 sidecar）", () => {
  it("内容哈希一致：按缓存 netChanges 给出增删段与作者", async () => {
    const view = await evaluateRevisions(SIDECAR, CONTENT);
    expect(view.status).toBe("ready");
    if (view.status !== "ready") return;
    expect(view.counts).toEqual({ insert: 3, delete: 1, replace: 3 });
    expect(view.authors).toEqual(["用户"]);
    const ins = view.spans.filter((s) => s.kind === "ins");
    const del = view.spans.filter((s) => s.kind === "del");
    expect(ins).toHaveLength(6);
    expect(del.map((s) => s.text)).toEqual([
      "Univariate LDSC produced positive SNP-heritability estimates for each of the",
      "u",
      "t",
      "its",
    ]);
    expect(ins[0].author).toBe("用户");
    expect(ins[0].timestamp).toBe("2026-09-19T01:42:42.849Z");
    // 去掉删除段即还原当前正文。
    expect(view.spans.filter((s) => s.kind !== "del").map((s) => s.text).join("")).toBe(CONTENT);
  });

  it("内容被改过（哈希不一致）→ stale，不显示", async () => {
    expect((await evaluateRevisions(SIDECAR, `${CONTENT} `)).status).toBe("stale");
  });

  it("算法版本不同 → stale；无 sidecar / 无净变更 → none", async () => {
    const state = JSON.parse(SIDECAR);
    state.netChangesAlgorithmVersion = 3;
    expect((await evaluateRevisions(JSON.stringify(state), CONTENT)).status).toBe("stale");
    expect((await evaluateRevisions(null, CONTENT)).status).toBe("none");
    expect((await evaluateRevisions("{bad", CONTENT)).status).toBe("none");
    state.netChangesAlgorithmVersion = 4;
    state.netChanges = [];
    expect((await evaluateRevisions(JSON.stringify(state), CONTENT)).status).toBe("none");
  });
});

function revisionApi(manifestFiles: unknown[]) {
  const api: CanvasApi = {
    manifest: vi.fn(async () => ({ status: 200, body: { revision: "1-1", files: manifestFiles } })),
    pull: vi.fn(async () => ({ status: 200, sha256: A, body: null })),
    push: vi.fn(async () => ({ status: 200, sha256: A, body: null })),
    wait: vi.fn(() => new Promise<never>(() => {})),
    cancelWait: vi.fn(),
    bindingsGet: vi.fn(async () => ({ status: 200, body: { bindings: {} } })),
    bindingsPut: vi.fn(async () => ({ status: 200, body: null })),
    localList: vi.fn(async () => [
      { name: "TGFS.txt", size: 1, mtime: 1, sha256: A, baseSha: A, localOnly: false },
    ]),
    localRead: vi.fn(async () => CONTENT),
    localWrite: vi.fn(async () => A),
    saveConflict: vi.fn(async () => "x"),
    deleteRemote: vi.fn(async () => ({ status: 200, sha256: null, body: null })),
    localDelete: vi.fn(async () => 0),
    localMissing: vi.fn(async () => []),
    localForget: vi.fn(async () => {}),
    revisionLoad: vi.fn(async () => SIDECAR),
    revisionPull: vi.fn(async () => ({ status: 200, sha256: R1, body: null })),
  };
  return api;
}

describe("controller.loadRevisions 按需拉取", () => {
  const target = { baseUrl: "http://pc:5974", token: "t" };

  it("只拉打开文稿的 docKey，带 manifest 的 sha", async () => {
    const api = revisionApi([
      { path: "canvas/TGFS.txt", size: 1, mtime: 1, sha256: A },
      { path: `CanvasRevisions/${TGFS_KEY}.json`, size: 1, mtime: 1, sha256: R1 },
      { path: `CanvasRevisions/${OTHER_KEY}.json`, size: 1, mtime: 1, sha256: R2 },
    ]);
    const controller = createCanvasController({ api, getTarget: () => target, docKey: canvasDocKey });
    await controller.start();
    expect(api.revisionPull).not.toHaveBeenCalled(); // 对账不拉修订
    const view = await controller.loadRevisions("TGFS.txt", CONTENT);
    controller.stop();
    expect(api.revisionPull).toHaveBeenCalledTimes(1);
    expect(api.revisionPull).toHaveBeenCalledWith(target, TGFS_KEY, R1);
    expect(api.revisionLoad).toHaveBeenCalledWith(TGFS_KEY);
    expect(view.status).toBe("ready");
  });

  it("电脑端没有这篇的 sidecar：不拉、不读旧缓存", async () => {
    const api = revisionApi([
      { path: "canvas/TGFS.txt", size: 1, mtime: 1, sha256: A },
      { path: `CanvasRevisions/${OTHER_KEY}.json`, size: 1, mtime: 1, sha256: R2 },
    ]);
    const controller = createCanvasController({ api, getTarget: () => target, docKey: canvasDocKey });
    await controller.start();
    const view = await controller.loadRevisions("TGFS.txt", CONTENT);
    controller.stop();
    expect(view.status).toBe("none");
    expect(api.revisionPull).not.toHaveBeenCalled();
    expect(api.revisionLoad).not.toHaveBeenCalled();
  });

  it("拉取失败退回本机缓存，仍由内容哈希把关", async () => {
    const api = revisionApi([
      { path: "canvas/TGFS.txt", size: 1, mtime: 1, sha256: A },
      { path: `CanvasRevisions/${TGFS_KEY}.json`, size: 1, mtime: 1, sha256: R1 },
    ]);
    api.revisionPull = vi.fn(async () => {
      throw new Error("CONNECT");
    });
    const controller = createCanvasController({ api, getTarget: () => target, docKey: canvasDocKey });
    await controller.start();
    const ok = await controller.loadRevisions("TGFS.txt", CONTENT);
    const stale = await controller.loadRevisions("TGFS.txt", `${CONTENT}x`);
    controller.stop();
    expect(ok.status).toBe("ready");
    expect(stale.status).toBe("stale");
  });
});

describe("CanvasDocPane 修订显示", () => {
  const doc = { name: "TGFS.txt", size: 1, mtime: 1, sha256: A, baseSha: A, localOnly: false };
  const mountPane = (revisions: (name: string, content: string) => Promise<CanvasRevisionView>) =>
    mountWithPinia(CanvasDocPane, {
      props: { doc, read: async () => CONTENT, save: async () => true, revisions },
    });
  const findButton = (wrapper: ReturnType<typeof mountPane>, label: string) =>
    wrapper.findAll("button").find((b) => b.text().startsWith(label));
  // crypto.subtle.digest 由线程池完成，单轮 flushPromises 不保证等到；等可观测结果。
  const waitForButton = async (wrapper: ReturnType<typeof mountPane>, label: string) => {
    await vi.waitFor(() => {
      if (!findButton(wrapper, label)) throw new Error(`no ${label}`);
    });
    return findButton(wrapper, label)!;
  };

  it("哈希一致：出现修订按钮，打开后区分新增与删除并显示作者", async () => {
    const wrapper = mountPane((_, content) => evaluateRevisions(SIDECAR, content));
    const button = await waitForButton(wrapper, "修订");
    expect(button.text()).toBe("修订 7");
    await button.trigger("click");
    expect(wrapper.findAll('[data-rev="ins"]')).toHaveLength(6);
    expect(wrapper.findAll('[data-rev="del"]')).toHaveLength(4);
    expect(wrapper.find('[data-rev="summary"]').text()).toContain("用户");
    expect(wrapper.find('[data-rev="stale"]').exists()).toBe(false);
  });

  it("哈希不一致：不显示修订，只给轻提示", async () => {
    const wrapper = mountPane(async () => ({ status: "stale" }));
    await vi.waitFor(() => {
      if (!wrapper.find('[data-rev="stale"]').exists()) throw new Error("no hint");
    });
    expect(findButton(wrapper, "修订")).toBeUndefined();
    expect(wrapper.find('[data-rev="stale"]').text()).toBe(REVISION_STALE_HINT);
  });

  it("手机本机编辑保存后修订自动隐藏", async () => {
    const wrapper = mountPane((_, content) => evaluateRevisions(SIDECAR, content));
    await (await waitForButton(wrapper, "修订")).trigger("click");
    expect(wrapper.find('[data-rev="ins"]').exists()).toBe(true);
    await findButton(wrapper, "编辑")!.trigger("click");
    await wrapper.find("textarea").setValue(`${CONTENT}\n手机补一句`);
    await findButton(wrapper, "保存")!.trigger("click");
    await flushPromises();
    expect(findButton(wrapper, "修订")).toBeUndefined();
    expect(wrapper.find('[data-rev="ins"]').exists()).toBe(false);
    expect(wrapper.find('[data-rev="stale"]').exists()).toBe(false);
  });
});
