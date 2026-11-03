import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import {
  createSidechatRemote,
  listLocalChildren,
  parseHistory,
  readChildHistory,
  SIDECHAT_BACKOFF_MS,
  type SidechatHttpResponse,
  type SidechatLocalDeps,
} from "@/core/sync/sidechatRemote";

const target = { baseUrl: "http://sync.example:5974", token: "test-token" };
const sha = (c: string) => c.repeat(64);
const DIR_A = "UserData/a1/topics/sidechat_1_aa";
const DIR_B = "UserData/a1/topics/sidechat_2_bb";

function manifest(files: Array<[string, string]>): SidechatHttpResponse {
  return {
    status: 200,
    body: { revision: "r", files: files.map(([path, s]) => ({ path, size: 1, mtime: 1, sha256: s })) },
  };
}

describe("createSidechatRemote", () => {
  it("只拉取 sha 变化的文件", async () => {
    let current = manifest([
      [`${DIR_A}/history.json`, sha("1")],
      [`${DIR_A}/sidechat-child.json`, sha("2")],
    ]);
    const pull = vi.fn(async (_t: unknown, _p: string, s: string) => ({ status: 200, sha256: s, skipped: false }));
    const remote = createSidechatRemote({
      getTarget: () => target,
      fetchManifest: async () => current,
      pull,
    });

    expect(await remote.sync()).toEqual({ pulled: 2, unchanged: 0, failed: 0 });
    current = manifest([
      [`${DIR_A}/history.json`, sha("3")],
      [`${DIR_A}/sidechat-child.json`, sha("2")],
    ]);
    expect(await remote.sync()).toEqual({ pulled: 1, unchanged: 1, failed: 0 });
    expect(pull).toHaveBeenCalledTimes(3);
    expect(pull.mock.calls[2][1]).toBe(`${DIR_A}/history.json`);
  });

  it("没有目标时不请求", async () => {
    const fetchManifest = vi.fn();
    const remote = createSidechatRemote({ getTarget: () => null, fetchManifest, pull: vi.fn() });
    expect(await remote.sync()).toBeNull();
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it("404 后退避，期间不再请求", async () => {
    let clock = 1_000;
    const fetchManifest = vi.fn(async () => ({ status: 404, body: null }));
    const remote = createSidechatRemote({
      getTarget: () => target,
      fetchManifest,
      pull: vi.fn(),
      now: () => clock,
    });
    expect(await remote.sync()).toBeNull();
    clock += SIDECHAT_BACKOFF_MS - 1;
    expect(await remote.sync()).toBeNull();
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    clock += 2;
    await remote.sync();
    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });
});

function localDeps(): SidechatLocalDeps {
  const files: Record<string, string> = {
    [`${DIR_A}/sidechat-child.json`]: JSON.stringify({
      agentId: "a1",
      topicId: "sidechat_1_aa",
      parentTopicId: "topic_p1",
      createdAt: 100,
    }),
    [`${DIR_B}/sidechat-child.json`]: JSON.stringify({
      agentId: "a1",
      topicId: "sidechat_2_bb",
      parentTopicId: "topic_other",
      createdAt: 200,
    }),
    [`${DIR_A}/history.json`]: JSON.stringify([
      { id: "m1", role: "user", content: "**你好**", timestamp: 1 },
      { id: "m2", role: "assistant", name: "小雪", content: "收到", timestamp: 2 },
      { role: "broken" },
    ]),
  };
  return {
    listLocal: async () => Object.keys(files).map((path) => ({ path, size: files[path].length })),
    readLocal: async (path) => {
      if (!(path in files)) throw new Error("NOT_FOUND");
      return files[path];
    },
  };
}

describe("本地只读", () => {
  it("按父话题归组并读出消息", async () => {
    const deps = localDeps();
    const children = await listLocalChildren("topic_p1", deps);
    expect(children.map((c) => c.topicId)).toEqual(["sidechat_1_aa"]);
    expect(children[0].dir).toBe(DIR_A);
    const msgs = await readChildHistory(children[0], deps);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(parseHistory("not json")).toEqual([]);
  });
});
