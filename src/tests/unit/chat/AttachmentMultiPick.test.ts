import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mockInvoke } from "../../mocks/tauri";
import {
  NATIVE_PICK_MAX_ITEMS,
  NATIVE_PICK_TOKEN_HINT_THRESHOLD,
  nativePickArgs,
  useAttachmentStore,
} from "../../../core/stores/attachmentStore";

const { addNotification } = vi.hoisted(() => ({ addNotification: vi.fn() }));

vi.mock("../../../core/utils/platform", () => ({
  nativePlatform: "android", isAndroid: true, isIOS: false,
}));

vi.mock("../../../core/stores/notification", () => ({
  useNotificationStore: () => ({ addNotification }),
}));

const PICK = "plugin:vcp-mobile|pick_file";

const emit = (name: string, detail: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

const picked = (ticket: string | undefined, name: string) => ({
  path: `/cache/uploads/${name}`,
  name,
  mime: "image/png",
  size: 10,
  hash: `h_${name}`,
  thumbnailPath: null,
  ...(ticket ? { stagingTicket: ticket } : {}),
});

const startAll = (entries: Array<[string, string]>) => {
  for (const [ticket, name] of entries) {
    emit("vcp-mobile-file-start", { name, size: 10, mime: "image/png", stagingTicket: ticket });
  }
};

const registered = (args?: Record<string, unknown>) => ({
  type: "image/png",
  internalPath: `/attachments/${String(args?.originalName)}`,
  name: String(args?.originalName),
  size: 10,
  hash: `h_${String(args?.originalName)}`,
  thumbnailPath: null,
});

type Failure = { stagingTicket: string; name?: string; reason: string };
const batch = (files: unknown[], failed: Failure[] = [], skipped = 0) => ({ files, failed, skipped });

describe("attachmentStore native multi-pick", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    addNotification.mockReset();
  });

  it("creates one card per staging ticket and registers files serially", async () => {
    let pickArgs: unknown;
    mockInvoke(PICK, (args) => {
      pickArgs = args;
      startAll([["t1", "a.png"], ["t2", "b.png"], ["t3", "c.png"]]);
      return batch([picked("t1", "a.png"), picked("t2", "b.png"), picked("t3", "c.png")]);
    });
    let active = 0;
    let maxActive = 0;
    const stableIds: string[] = [];
    mockInvoke("register_local_file", async (args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      stableIds.push(String(args?.stableId));
      return registered(args);
    });

    const store = useAttachmentStore();
    await store.handleAttachment("gallery");

    expect(pickArgs).toEqual({ mode: "gallery", multiple: true, maxItems: NATIVE_PICK_MAX_ITEMS });
    expect(store.stagedAttachments).toHaveLength(3);
    expect(new Set(store.stagedAttachments.map((a) => a.id)).size).toBe(3);
    expect(store.stagedAttachments.every((a) => a.status === "done")).toBe(true);
    expect(maxActive).toBe(1);
    // 卡片 unshift，注册按选择顺序
    expect(stableIds).toEqual(store.stagedAttachments.map((a) => a.id).reverse());
    expect(addNotification).not.toHaveBeenCalled();
  });

  it("keeps successful files when some fail natively or during registration", async () => {
    mockInvoke(PICK, () => {
      startAll([["t1", "a.png"], ["t2", "b.png"], ["t3", "c.png"]]);
      // 事件与回执都报告 t2 失败：只提示一次
      emit("vcp-mobile-file-failed", { stagingTicket: "t2", name: "b.png", reason: "copy failed" });
      return batch(
        [picked("t1", "a.png"), picked("t3", "c.png")],
        [{ stagingTicket: "t2", name: "b.png", reason: "copy failed" }],
      );
    });
    mockInvoke("register_local_file", async (args) => {
      if (args?.originalName === "c.png") throw new Error("disk full");
      return registered(args);
    });

    const store = useAttachmentStore();
    await store.handleAttachment("file");

    // 失败卡片保留在原位，带原因、无 src；成功的照常 done
    expect(store.stagedAttachments.map((a) => [a.name, a.status, a.failReason])).toEqual([
      ["c.png", "failed", "disk full"],
      ["b.png", "failed", "copy failed"],
      ["a.png", "done", undefined],
    ]);
    expect(store.stagedAttachments.filter((a) => a.status === "failed").every((a) => a.src === "")).toBe(true);
    expect(addNotification).toHaveBeenCalledTimes(1);
    const { title, message } = addNotification.mock.calls[0][0];
    expect(title).toBe("2 个文件导入失败");
    expect(String(message).match(/b\.png: copy failed/g)).toHaveLength(1);
    expect(String(message)).toContain("c.png: disk full");
  });

  it("settles from the batch event when the invoke reply is lost", async () => {
    mockInvoke(PICK, () => {
      startAll([["t1", "a.png"], ["t2", "b.png"]]);
      emit("vcp-mobile-file-batch", batch([picked("t1", "a.png"), picked("t2", "b.png")]));
      return new Promise(() => {});
    });
    mockInvoke("register_local_file", async (args) => registered(args));

    const store = useAttachmentStore();
    await store.handleAttachment("gallery");

    expect(store.stagedAttachments).toHaveLength(2);
    expect(store.stagedAttachments.every((a) => a.status === "done")).toBe(true);
  });

  it("reports failures carried by the invoke reply even when it beats the events", async () => {
    mockInvoke(PICK, () => {
      startAll([["t1", "a.png"], ["t2", "b.png"]]);
      // 失败事件晚于回执到达：监听已清理，不能造成重复或静默丢失
      setTimeout(() => emit("vcp-mobile-file-failed", { stagingTicket: "t2", name: "b.png", reason: "copy failed" }), 0);
      return batch([picked("t1", "a.png")], [{ stagingTicket: "t2", name: "b.png", reason: "copy failed" }]);
    });
    mockInvoke("register_local_file", async (args) => registered(args));

    const store = useAttachmentStore();
    await store.handleAttachment("gallery");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store.stagedAttachments.map((a) => [a.name, a.status, a.failReason])).toEqual([
      ["b.png", "failed", "copy failed"],
      ["a.png", "done", undefined],
    ]);
    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(String(addNotification.mock.calls[0][0].message)).toContain("b.png: copy failed");
  });

  it("summarizes every reason when the whole batch fails", async () => {
    mockInvoke(PICK, () => {
      startAll([["t1", "a.png"]]);
      // t2 在 start 事件前就失败：名字只能来自回执
      return batch([], [
        { stagingTicket: "t1", name: "a.png", reason: "io" },
        { stagingTicket: "t2", name: "b.png", reason: "decode" },
      ]);
    });

    const store = useAttachmentStore();
    await store.handleAttachment("gallery");

    // t1 有卡片原地标失败；t2 在 start 前失败，补建一张失败卡片
    expect(store.stagedAttachments).toHaveLength(2);
    expect(store.stagedAttachments.every((a) => a.status === "failed")).toBe(true);
    expect(Object.fromEntries(store.stagedAttachments.map((a) => [a.name, a.failReason]))).toEqual({
      "a.png": "io",
      "b.png": "decode",
    });
    expect(addNotification).toHaveBeenCalledTimes(1);
    const { title, message } = addNotification.mock.calls[0][0];
    expect(title).toBe("2 个文件导入失败");
    expect(String(message)).toContain("a.png: io");
    expect(String(message)).toContain("b.png: decode");
  });

  it("warns when the picker truncated the selection", async () => {
    mockInvoke(PICK, () => {
      startAll([["t1", "a.png"]]);
      return batch([picked("t1", "a.png")], [], 3);
    });
    mockInvoke("register_local_file", async (args) => registered(args));

    const store = useAttachmentStore();
    await store.handleAttachment("gallery");

    expect(store.stagedAttachments).toHaveLength(1);
    expect(addNotification).toHaveBeenCalledTimes(1);
    const { title, message, toastOnly } = addNotification.mock.calls[0][0];
    expect(title).toBe("已达选择上限");
    expect(String(message)).toContain("已忽略 3 个");
    expect(String(message)).toContain(`单次最多 ${NATIVE_PICK_MAX_ITEMS} 个`);
    expect(toastOnly).toBe(true);
  });

  it("keeps camera single-pick with the legacy args and result shape", async () => {
    let pickArgs: unknown;
    mockInvoke(PICK, (args) => {
      pickArgs = args;
      emit("vcp-mobile-file-start", { name: "Camera_1.jpg", size: 10, mime: "image/jpeg" });
      emit("vcp-mobile-file-progress", { name: "Camera_1.jpg", mime: "image/jpeg", loaded: 5, total: 10, progress: 50 });
      return picked(undefined, "Camera_1.jpg");
    });
    mockInvoke("register_local_file", async (args) => registered(args));

    const store = useAttachmentStore();
    await store.handleAttachment("camera");

    expect(pickArgs).toEqual({ mode: "camera" });
    expect(store.stagedAttachments).toHaveLength(1);
    expect(store.stagedAttachments[0].status).toBe("done");
  });

  it("never requests multi-select for avatar or camera", () => {
    expect(nativePickArgs("avatar")).toEqual({ mode: "avatar" });
    expect(nativePickArgs("camera")).toEqual({ mode: "camera" });
    expect(nativePickArgs("file")).toEqual({ mode: "file", multiple: true, maxItems: NATIVE_PICK_MAX_ITEMS });
  });

  it("drops staged cards silently when the picker is cancelled", async () => {
    mockInvoke(PICK, async () => {
      throw new Error("Cancelled");
    });

    const store = useAttachmentStore();
    await store.handleAttachment("gallery");

    expect(store.stagedAttachments).toHaveLength(0);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it("defaults multi-pick to the shared native cap of 100", () => {
    expect(NATIVE_PICK_MAX_ITEMS).toBe(100);
    expect(nativePickArgs("gallery")).toEqual({ mode: "gallery", multiple: true, maxItems: 100 });
  });

  const manyEntries = (n: number) =>
    Array.from({ length: n }, (_, i): [string, string] => [`t${i}`, `p${i}.png`]);

  it("hints token cost above the threshold without blocking staging", async () => {
    const entries = manyEntries(NATIVE_PICK_TOKEN_HINT_THRESHOLD + 1);
    mockInvoke(PICK, () => {
      startAll(entries);
      return batch(entries.map(([t, n]) => picked(t, n)));
    });
    mockInvoke("register_local_file", async (args) => registered(args));

    const store = useAttachmentStore();
    await store.handleAttachment("gallery");

    expect(store.stagedAttachments).toHaveLength(entries.length);
    expect(store.stagedAttachments.every((a) => a.status === "done")).toBe(true);
    expect(addNotification).toHaveBeenCalledTimes(1);
    const { type, message, toastOnly } = addNotification.mock.calls[0][0];
    expect(type).toBe("info");
    expect(String(message)).toContain(`${entries.length} 个`);
    expect(String(message)).toContain("token 消耗会明显增加");
    expect(toastOnly).toBe(true);
  });

  it("stays quiet at exactly the token hint threshold", async () => {
    const entries = manyEntries(NATIVE_PICK_TOKEN_HINT_THRESHOLD);
    mockInvoke(PICK, () => {
      startAll(entries);
      return batch(entries.map(([t, n]) => picked(t, n)));
    });
    mockInvoke("register_local_file", async (args) => registered(args));

    const store = useAttachmentStore();
    await store.handleAttachment("gallery");

    expect(store.stagedAttachments).toHaveLength(entries.length);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it("still drops the card on single-pick failure (camera keeps legacy behavior)", async () => {
    mockInvoke(PICK, () => {
      emit("vcp-mobile-file-start", { name: "Camera_2.jpg", size: 10, mime: "image/jpeg" });
      return picked(undefined, "Camera_2.jpg");
    });
    mockInvoke("register_local_file", async () => {
      throw new Error("disk full");
    });

    const store = useAttachmentStore();
    await store.handleAttachment("camera");

    expect(store.stagedAttachments).toHaveLength(0);
    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(String(addNotification.mock.calls[0][0].message)).toContain("Camera_2.jpg: disk full");
  });
});
