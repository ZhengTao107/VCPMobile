import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import { invokeMock, mockInvoke } from "@/tests/mocks/tauri";

const hoisted = vi.hoisted(() => ({
  processStreamEvent: vi.fn(async () => {}),
  sync: vi.fn(async () => null),
}));

vi.mock("@/core/stores/chatStreamStore", () => ({
  useChatStreamStore: () => ({
    processStreamEvent: hoisted.processStreamEvent,
    getActiveStreamMessage: () => undefined,
  }),
}));
vi.mock("@/core/stores/settings", () => ({
  useSettingsStore: () => ({ settings: { identity: { userName: "主人" } } }),
}));
vi.mock("@/core/sync/sidechatRemote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/sync/sidechatRemote")>();
  return { ...actual, requestSidechatSync: hoisted.sync };
});

import { sendSidechatMessage, sidechatSending } from "@/features/sidechat/sidechatSend";
import {
  createSidechatRemote,
  isSidechatPathBusy,
  type SidechatRemoteDeps,
} from "@/core/sync/sidechatRemote";

const DIR = "UserData/a1/topics/sidechat_1_aa";
const child = { agentId: "a1", topicId: "sidechat_1_aa", parentTopicId: "p", createdAt: 1, dir: DIR };
const ctx = { ownerType: "agent", ownerId: "a1", topicId: "sidechat_1_aa", agentId: "a1" };

type Emit = (event: Record<string, unknown>) => void;

function mockSend(run: (emit: Emit, args: Record<string, any>) => Promise<unknown>) {
  mockInvoke("sidechat_send", (args) => {
    const channel = (args as any).streamChannel as { onmessage?: (e: unknown) => void };
    const emit: Emit = (event) =>
      channel.onmessage?.({ consumerRevision: 1, context: ctx, ...event });
    return run(emit, args as Record<string, any>);
  });
}

describe("sendSidechatMessage", () => {
  it("把用户消息交给 Rust 落盘，durable end 后触发子话题同步", async () => {
    hoisted.sync.mockClear();
    let busyDuringSend = false;
    mockSend(async (emit) => {
      busyDuringSend = isSidechatPathBusy(`${DIR}/history.json`);
      emit({ type: "thinking", messageId: "msg_r" });
      emit({ type: "end", messageId: "msg_r", finishReason: "completed", content: "好" });
      return { status: "sent" };
    });
    const users: string[] = [];
    const result = await sendSidechatMessage(child, "  继续说  ", { onUser: (m) => users.push(m.content) });
    expect(result).toBe("sent");
    const call = invokeMock.mock.calls.find(([cmd]) => cmd === "sidechat_send")!;
    const payload = (call[1] as any).payload;
    expect(payload.dir).toBe(DIR);
    expect(payload.agentId).toBe("a1");
    expect(payload.userMessage).toMatchObject({ role: "user", content: "继续说", name: "主人" });
    expect(users).toEqual(["继续说"]);
    expect(busyDuringSend).toBe(true);
    expect(isSidechatPathBusy(`${DIR}/history.json`)).toBe(false);
    expect(hoisted.processStreamEvent).toHaveBeenCalled();
    expect(hoisted.sync).toHaveBeenCalledTimes(1);
    expect(sidechatSending.has(DIR)).toBe(false);
  });

  it("出错终态不触发同步并向上抛错", async () => {
    hoisted.sync.mockClear();
    mockSend(async (emit) => {
      emit({ type: "end", messageId: "msg_e", finishReason: "error", content: "x" });
      throw new Error("VCP Error: 500");
    });
    await expect(sendSidechatMessage(child, "问")).rejects.toThrow("VCP Error: 500");
    expect(hoisted.sync).not.toHaveBeenCalled();
    expect(sidechatSending.has(DIR)).toBe(false);
  });

  it("同一子话题生成中禁止重复发送", async () => {
    hoisted.sync.mockClear();
    let finish!: () => void;
    mockSend(
      (emit) =>
        new Promise((resolve) => {
          emit({ type: "thinking", messageId: "msg_1" });
          finish = () => {
            emit({ type: "end", messageId: "msg_1", finishReason: "completed", content: "" });
            resolve({ status: "sent" });
          };
        }),
    );
    const first = sendSidechatMessage(child, "一");
    await Promise.resolve();
    expect(sidechatSending.get(DIR)).toBe("msg_1");
    expect(await sendSidechatMessage(child, "二")).toBe("busy");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "sidechat_send")).toHaveLength(1);
    finish();
    expect(await first).toBe("sent");
    expect(await sendSidechatMessage(child, "   ")).toBe("empty");
  });
});

describe("createSidechatRemote · 生成中", () => {
  it("跳过生成中子话题的下载、上推与删除", async () => {
    const H = `${DIR}/history.json`;
    const other = "UserData/a1/topics/sidechat_2_bb/history.json";
    const s = (c: string) => c.repeat(64);
    const calls: string[] = [];
    const deps: SidechatRemoteDeps = {
      getTarget: () => ({ baseUrl: "http://x", token: "t" }),
      fetchManifest: async () => ({
        status: 200,
        body: { revision: "r", files: [
          { path: H, size: 1, mtime: 1, sha256: s("a") },
          { path: other, size: 1, mtime: 1, sha256: s("c") },
        ] },
      }),
      pull: async (_t, path, sha) => {
        calls.push(`pull:${path}`);
        return { status: 200, sha256: sha, skipped: false };
      },
      localStatus: async () => [{ path: H, sha256: s("b"), base: s("b") }],
      push: async (_t, path) => {
        calls.push(`push:${path}`);
        return { status: 200, sha256: s("f") };
      },
      isBusy: (path) => path.startsWith(`${DIR}/`),
    };
    const summary = await createSidechatRemote(deps).sync();
    expect(calls).toEqual([`pull:${other}`]);
    expect(summary?.busy).toBe(1);
  });
});
