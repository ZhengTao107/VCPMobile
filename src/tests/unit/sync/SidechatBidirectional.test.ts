import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import {
  createSidechatRemote,
  planSidechatSync,
  SIDECHAT_MAX_DELETES_PER_ROUND,
  type SidechatHttpResponse,
  type SidechatLocalStatus,
  type SidechatPushResult,
  type SidechatRemoteDeps,
} from "@/core/sync/sidechatRemote";

const target = { baseUrl: "http://sync.example:5974", token: "test-token" };
const sha = (c: string) => c.repeat(64);
const DIR = "UserData/a1/topics/sidechat_1_aa";
const H = `${DIR}/history.json`;
const META = `${DIR}/sidechat-child.json`;

function manifest(files: Array<[string, string]>): SidechatHttpResponse {
  return {
    status: 200,
    body: { revision: "r", files: files.map(([path, s]) => ({ path, size: 1, mtime: 1, sha256: s })) },
  };
}
const file = (path: string, s: string) => ({ path, size: 1, mtime: 1, sha256: s });
const local = (path: string, l: string | null, b: string | null): SidechatLocalStatus => ({
  path,
  sha256: l,
  base: b,
});

function harness(
  remote: Array<[string, string]>,
  locals: SidechatLocalStatus[],
  pushResult: SidechatPushResult = { status: 200, sha256: sha("f") },
  deleteStatus = 200,
) {
  const calls: string[] = [];
  const deps: SidechatRemoteDeps = {
    getTarget: () => target,
    fetchManifest: async () => manifest(remote),
    pull: vi.fn(async (_t, path, s) => {
      calls.push(`pull:${path}:${s[0]}`);
      return { status: 200, sha256: s, skipped: false };
    }),
    removeLocal: vi.fn(async (path) => {
      calls.push(`rm:${path}`);
      return true;
    }),
    localStatus: async () => locals,
    push: vi.fn(async (_t, path) => {
      calls.push(`push:${path}`);
      return pushResult;
    }),
    deleteRemote: vi.fn(async (_t, path) => {
      calls.push(`del:${path}`);
      return { status: deleteStatus, body: null };
    }),
    saveConflict: vi.fn(async (path) => {
      calls.push(`conflict:${path}`);
    }),
    forget: vi.fn(async (path) => {
      calls.push(`forget:${path}`);
    }),
  };
  return { deps, calls, remote: createSidechatRemote(deps) };
}

describe("planSidechatSync", () => {
  it("覆盖三方比对各分支", () => {
    const kinds = (r: string | null, l: string | null, b: string | null) =>
      planSidechatSync(r ? [file(H, r)] : [], l || b ? [local(H, l, b)] : []).map((a) => a.kind);
    expect(kinds(sha("1"), sha("1"), sha("1"))).toEqual([]);
    expect(kinds(sha("1"), sha("2"), sha("1"))).toEqual(["upload"]);
    expect(kinds(sha("2"), sha("1"), sha("1"))).toEqual(["download"]);
    expect(kinds(sha("2"), sha("3"), sha("1"))).toEqual(["conflict"]);
    expect(kinds(sha("1"), null, sha("1"))).toEqual(["delete-remote"]);
    expect(kinds(sha("2"), null, sha("1"))).toEqual(["download"]);
    expect(kinds(null, sha("1"), sha("1"))).toEqual(["delete-local"]);
    expect(kinds(null, sha("2"), sha("1"))).toEqual(["upload"]);
    expect(kinds(null, null, sha("1"))).toEqual(["forget"]);
    expect(kinds(sha("1"), null, null)).toEqual(["download"]);
    expect(kinds(null, sha("1"), null)).toEqual(["upload"]);
    expect(kinds(sha("1"), sha("1"), null)).toEqual(["download"]);
  });

  it("sidechat-child.json 排在最后，临时文件与冲突副本不参与", () => {
    const plan = planSidechatSync(
      [],
      [
        local(META, sha("1"), null),
        local(H, sha("2"), null),
        local(`${DIR}/history.json.1.2.3.tmp`, sha("3"), null),
        local(`${DIR}/history.conflict-手机.json`, sha("4"), null),
      ],
    );
    expect(plan.map((a) => a.path)).toEqual([H, META]);
  });
});

describe("createSidechatRemote 双向模式", () => {
  it("本机改远端未改 → 推", async () => {
    const h = harness([[H, sha("1")]], [local(H, sha("2"), sha("1"))]);
    const summary = await h.remote.sync();
    expect(h.calls).toEqual([`push:${H}`]);
    expect(summary).toMatchObject({ pushed: 1, failed: 0 });
  });

  it("远端改本机未改 → 拉", async () => {
    const h = harness([[H, sha("2")]], [local(H, sha("1"), sha("1"))]);
    const summary = await h.remote.sync();
    expect(h.calls).toEqual([`pull:${H}:2`]);
    expect(summary).toMatchObject({ pulled: 1, failed: 0 });
  });

  it("双改 → 先存冲突副本，再以电脑端为准拉回", async () => {
    const h = harness([[H, sha("2")]], [local(H, sha("3"), sha("1"))]);
    const summary = await h.remote.sync();
    expect(h.calls).toEqual([`conflict:${H}`, `pull:${H}:2`]);
    expect(h.deps.push).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ conflicts: 1, pulled: 1 });
  });

  it("push 409 带 serverSha → 冲突副本 + 拉回 serverSha", async () => {
    const h = harness([[H, sha("1")]], [local(H, sha("2"), sha("1"))], {
      status: 409,
      sha256: null,
      serverSha: sha("9"),
    });
    const summary = await h.remote.sync();
    expect(h.calls).toEqual([`push:${H}`, `conflict:${H}`, `pull:${H}:9`]);
    expect(summary).toMatchObject({ conflicts: 1, pulled: 1, failed: 0 });
  });

  it("push 409 无 serverSha → 清基线，不算失败", async () => {
    const h = harness([[H, sha("1")]], [local(H, sha("2"), sha("1"))], { status: 409, sha256: null, serverSha: null });
    const summary = await h.remote.sync();
    expect(h.calls).toEqual([`push:${H}`, `forget:${H}`]);
    expect(summary).toMatchObject({ failed: 0 });
  });

  it("本机删 → DELETE，sidechat-child.json 最后删", async () => {
    const h = harness(
      [
        [META, sha("1")],
        [H, sha("2")],
      ],
      [local(META, null, sha("1")), local(H, null, sha("2"))],
    );
    const summary = await h.remote.sync();
    expect(h.calls).toEqual([`del:${H}`, `del:${META}`]);
    expect(summary).toMatchObject({ deletedRemote: 2, failed: 0 });
  });

  it("DELETE 409 不算失败（电脑端已改，下一轮拉回）", async () => {
    const h = harness([[H, sha("1")]], [local(H, null, sha("1"))], undefined, 409);
    const summary = await h.remote.sync();
    expect(summary).toMatchObject({ failed: 0 });
    expect(summary?.deletedRemote).toBeUndefined();
  });

  it("电脑端删 → 本机删，标记最后", async () => {
    const h = harness([], [local(META, sha("1"), sha("1")), local(H, sha("2"), sha("2"))]);
    const summary = await h.remote.sync();
    expect(h.calls).toEqual([`rm:${H}`, `rm:${META}`]);
    expect(summary).toMatchObject({ removed: 2 });
  });

  it(`单轮删除 > ${SIDECHAT_MAX_DELETES_PER_ROUND} 整轮不删，其他动作照常`, async () => {
    const n = SIDECHAT_MAX_DELETES_PER_ROUND + 1;
    const remote: Array<[string, string]> = [];
    const locals: SidechatLocalStatus[] = [local(`${DIR}/new.json`, sha("5"), null)];
    for (let i = 0; i < n; i += 1) {
      const p = `UserData/a1/topics/sidechat_${i}_aa/history.json`;
      if (i % 2) remote.push([p, sha("1")]);
      locals.push(local(p, i % 2 ? null : sha("1"), sha("1")));
    }
    const h = harness(remote, locals);
    const summary = await h.remote.sync();
    expect(h.deps.removeLocal).not.toHaveBeenCalled();
    expect(h.deps.deleteRemote).not.toHaveBeenCalled();
    expect(h.calls).toEqual([`push:${DIR}/new.json`]);
    expect(summary).toMatchObject({ held: n, pushed: 1 });
  });

  it("缺 localStatus 时保持只拉旧路径", async () => {
    const h = harness([[H, sha("1")]], [local(H, sha("2"), sha("1"))]);
    delete h.deps.localStatus;
    const summary = await createSidechatRemote(h.deps).sync();
    expect(h.deps.push).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ pulled: 1 });
  });
});
