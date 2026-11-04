import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import { createSidechatRemote, SIDECHAT_MAX_DELETES_PER_ROUND } from "@/core/sync/sidechatRemote";

const target = { baseUrl: "http://sync.example:5974", token: "test-token" };
const DIR = "UserData/a1/topics/sidechat_1_aa";
const manifest = (paths: string[]) => ({
  status: 200,
  body: { revision: "r", files: paths.map((path) => ({ path, size: 1, mtime: 1, sha256: "1".repeat(64) })) },
});

describe("子话题：电脑端已删的文件删本机镜像", () => {
  it("manifest 里没有的本机文件被删除，sidechat-child.json 最后删", async () => {
    const removed: string[] = [];
    const remote = createSidechatRemote({
      getTarget: () => target,
      fetchManifest: async () => manifest([]),
      pull: vi.fn(),
      listLocal: async () => [
        { path: `${DIR}/sidechat-child.json`, size: 1 },
        { path: `${DIR}/history.json`, size: 1 },
      ],
      removeLocal: async (path) => {
        removed.push(path);
        return true;
      },
    });
    const summary = await remote.sync();
    expect(removed).toEqual([`${DIR}/history.json`, `${DIR}/sidechat-child.json`]);
    expect(summary?.removed).toBe(2);
  });

  it("仍在 manifest 里的文件不删；超过安全上限整轮不删", async () => {
    const removeLocal = vi.fn(async () => true);
    const many = Array.from({ length: SIDECHAT_MAX_DELETES_PER_ROUND + 1 }, (_, i) => ({
      path: `UserData/a1/topics/sidechat_${i + 2}_aa/history.json`,
      size: 1,
    }));
    const remote = createSidechatRemote({
      getTarget: () => target,
      fetchManifest: async () => manifest([`${DIR}/history.json`]),
      pull: vi.fn(async (_t: unknown, _p: string, s: string) => ({ status: 200, sha256: s, skipped: true })),
      listLocal: async () => [{ path: `${DIR}/history.json`, size: 1 }, ...many],
      removeLocal,
    });
    const summary = await remote.sync();
    expect(removeLocal).not.toHaveBeenCalled();
    expect(summary?.held).toBe(SIDECHAT_MAX_DELETES_PER_ROUND + 1);
  });
});
