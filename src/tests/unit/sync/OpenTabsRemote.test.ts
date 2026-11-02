import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import {
  createOpenTabsRemote,
  createTopicTitleResolver,
  formatDeviceFreshness,
  getOrCreateDeviceId,
  isValidDeviceId,
  OPEN_TABS_DEVICE_ID_KEY,
  OPEN_TABS_POLL_MS,
  OPEN_TABS_REPORT_DEBOUNCE_MS,
  parseSnapshot,
  toReportTabs,
  type OpenTabsHttpResponse,
  type OpenTabsRemoteDeps,
} from "@/core/sync/openTabsRemote";

const target = { baseUrl: "http://sync.example:5974", token: "test-token" };
const SELF = "android-self";

const snapshotBody = {
  revision: 5,
  devices: [
    { deviceId: SELF, deviceName: "本机", kind: "android", updatedAt: 10, tabs: [] },
    {
      deviceId: "pc-1",
      deviceName: "台式机",
      kind: "windows",
      updatedAt: 200,
      tabs: [
        { ownerType: "agent", ownerId: "a", topicId: "t2", order: 1 },
        { ownerType: "agent", ownerId: "a", topicId: "t1", order: 0 },
        { ownerType: "bogus", ownerId: "a", topicId: "t9", order: 2 },
        { ownerType: "agent", ownerId: "a", topicId: "t1", order: 3 },
      ],
    },
    { deviceId: "mac-1", kind: "mac", updatedAt: 300, tabs: "nope" },
    { deviceId: "bad/id", deviceName: "x", updatedAt: 1, tabs: [] },
  ],
};

function makeRemote(overrides: Partial<OpenTabsRemoteDeps> = {}) {
  const fetchSnapshot = vi.fn(
    async (): Promise<OpenTabsHttpResponse> => ({ status: 200, body: snapshotBody }),
  );
  const putDevice = vi.fn(async (): Promise<OpenTabsHttpResponse> => ({ status: 200, body: null }));
  const remote = createOpenTabsRemote({
    getTarget: () => target,
    deviceId: SELF,
    deviceName: () => "我的手机",
    fetchSnapshot,
    putDevice,
    now: () => 1_000,
    ...overrides,
  });
  return { remote, fetchSnapshot, putDevice };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("snapshot parsing", () => {
  it("filters out this device, invalid ids and tabs; sorts devices and tabs", () => {
    const snapshot = parseSnapshot(snapshotBody, SELF)!;
    expect(snapshot.revision).toBe(5);
    expect(snapshot.devices.map((d) => d.deviceId)).toEqual(["mac-1", "pc-1"]);
    const pc = snapshot.devices[1];
    expect(pc.tabs.map((t) => t.topicId)).toEqual(["t1", "t2"]);
    const mac = snapshot.devices[0];
    expect(mac).toMatchObject({ deviceName: "mac-1", kind: "mac", tabs: [] });
  });

  it("rejects malformed bodies", () => {
    expect(parseSnapshot(null, SELF)).toBeNull();
    expect(parseSnapshot({ devices: "x" }, SELF)).toBeNull();
  });

  it("shows freshness and offline duration", () => {
    const now = 10 * 60 * 60_000;
    expect(formatDeviceFreshness(0, now)).toBe("更新时间未知");
    expect(formatDeviceFreshness(now - 20_000, now)).toBe("刚刚更新");
    expect(formatDeviceFreshness(now - 3 * 60_000, now)).toBe("3 分钟前更新");
    expect(formatDeviceFreshness(now - 25 * 60_000, now)).toBe("离线 25 分钟");
    expect(formatDeviceFreshness(now - 3 * 60 * 60_000, now)).toBe("离线 3 小时");
    expect(formatDeviceFreshness(now - 50 * 60 * 60_000, now + 0)).toBe("离线 2 天");
  });
});

describe("open tabs remote client", () => {
  it("debounces reports by 2s and sends only the latest tabs", async () => {
    const { remote, putDevice } = makeRemote();
    const tab = (topicId: string) => ({ ownerType: "agent" as const, ownerId: "a", topicId });
    remote.scheduleReport(toReportTabs([tab("t1")]));
    await vi.advanceTimersByTimeAsync(1_000);
    remote.scheduleReport(toReportTabs([tab("t1"), tab("t2")]));
    await vi.advanceTimersByTimeAsync(OPEN_TABS_REPORT_DEBOUNCE_MS - 1);
    expect(putDevice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(putDevice).toHaveBeenCalledTimes(1);
    expect(putDevice).toHaveBeenCalledWith(target, SELF, {
      deviceName: "我的手机",
      kind: "android",
      tabs: [
        { ownerType: "agent", ownerId: "a", topicId: "t1", order: 0 },
        { ownerType: "agent", ownerId: "a", topicId: "t2", order: 1 },
      ],
    });
  });

  it("does nothing without a target (autoSync off / no url / no token)", async () => {
    const { remote, putDevice, fetchSnapshot } = makeRemote({ getTarget: () => null });
    expect(remote.enabled()).toBe(false);
    remote.scheduleReport([]);
    await remote.refresh();
    await vi.advanceTimersByTimeAsync(OPEN_TABS_REPORT_DEBOUNCE_MS * 2);
    expect(putDevice).not.toHaveBeenCalled();
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(remote.state.status).toBe("idle");
  });

  it("refresh stores devices without this device", async () => {
    const { remote } = makeRemote();
    await remote.refresh();
    expect(remote.state.status).toBe("ok");
    expect(remote.state.devices.map((d) => d.deviceId)).toEqual(["mac-1", "pc-1"]);
    expect(remote.state.fetchedAt).toBe(1_000);
  });

  it.each([404, 503])("degrades to 'unavailable' on %i without throwing", async (status) => {
    const { remote } = makeRemote({ fetchSnapshot: vi.fn(async () => ({ status, body: null })) });
    await expect(remote.refresh()).resolves.toBeUndefined();
    expect(remote.state.status).toBe("unavailable");
    expect(remote.state.devices).toEqual([]);
  });

  it("keeps the last devices on transient errors", async () => {
    const fetchSnapshot = vi
      .fn<() => Promise<OpenTabsHttpResponse>>()
      .mockResolvedValueOnce({ status: 200, body: snapshotBody })
      .mockRejectedValueOnce(new Error("TIMEOUT"));
    const { remote } = makeRemote({ fetchSnapshot });
    await remote.refresh();
    await remote.refresh();
    expect(remote.state.status).toBe("error");
    expect(remote.state.devices).toHaveLength(2);
  });

  it("polls every 30s while started and stops cleanly", async () => {
    const { remote, fetchSnapshot } = makeRemote();
    remote.startPolling();
    remote.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OPEN_TABS_POLL_MS);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    remote.stopPolling();
    await vi.advanceTimersByTimeAsync(OPEN_TABS_POLL_MS * 3);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("device id", () => {
  it("is generated once and persisted", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const first = getOrCreateDeviceId(storage);
    expect(isValidDeviceId(first)).toBe(true);
    expect(store.get(OPEN_TABS_DEVICE_ID_KEY)).toBe(first);
    expect(getOrCreateDeviceId(storage, () => "android-other")).toBe(first);
    store.set(OPEN_TABS_DEVICE_ID_KEY, "bad id!");
    expect(getOrCreateDeviceId(storage, () => "android-new")).toBe("android-new");
  });
});

describe("topic title resolver", () => {
  it("uses known titles, then loads the owner once; missing topics are null", async () => {
    vi.useRealTimers();
    const fetchTopics = vi.fn(async () => [{ id: "t2", name: "第二个" }]);
    const resolver = createTopicTitleResolver({
      known: (t) => (t.topicId === "t1" ? "已知" : null),
      fetchTopics,
    });
    const ref = (topicId: string) => ({ ownerType: "agent" as const, ownerId: "a", topicId });
    expect(resolver.resolve(ref("t1"))).toBe("已知");
    resolver.prefetch([ref("t1"), ref("t2"), ref("t3")]);
    expect(resolver.resolve(ref("t2"))).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchTopics).toHaveBeenCalledTimes(1);
    expect(resolver.resolve(ref("t2"))).toBe("第二个");
    expect(resolver.resolve(ref("t3"))).toBeNull();
  });
});
