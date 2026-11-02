import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useSettingsStore, type AppSettings } from "@/core/stores/settings";
import { invokeMock, mockInvoke } from "@/tests/mocks/tauri";

const requestSpy = vi.hoisted(() => vi.fn());

vi.mock("@/core/sync/autoSyncTrigger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/sync/autoSyncTrigger")>()),
  requestAutoSync: requestSpy,
}));

import {
  HINT_BACKOFF_BASE_MS,
  HINT_BACKOFF_MAX_MS,
  HINT_MIN_CYCLE_MS,
  HINT_MISSING_PLUGIN_MS,
  createRemoteChangeHint,
  hintTargetFromSettings,
  useRemoteChangeHint,
  type HintWaitRequest,
  type HintWaitResponse,
} from "@/core/sync/remoteChangeHint";

const TARGET = { baseUrl: "http://sync.example:5974", token: "fake-token-a" };
const ok = (revision: number, changed: boolean, instanceId = "inst-1"): HintWaitResponse => ({
  status: 200,
  body: { instanceId, revision, changed },
});

interface PendingCall {
  req: HintWaitRequest;
  resolve: (response: HintWaitResponse) => void;
  reject: (error: unknown) => void;
}

function harness() {
  const calls: PendingCall[] = [];
  const wait = vi.fn((req: HintWaitRequest) =>
    new Promise<HintWaitResponse>((resolve, reject) => calls.push({ req, resolve, reject })));
  // 与 Rust 侧一致：取消让在途请求以 CANCELLED 结束。
  const cancel = vi.fn((requestId: string) => {
    calls.find((call) => call.req.requestId === requestId)?.reject("CANCELLED");
  });
  const onChange = vi.fn();
  const hint = createRemoteChangeHint({ wait, cancel, onChange });
  return { calls, wait, cancel, onChange, hint };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const lastCall = (h: { calls: PendingCall[] }) => h.calls[h.calls.length - 1];

describe("remote change hint loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("first response only establishes the cursor, later change triggers once", async () => {
    const h = harness();
    h.hint.update(TARGET);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].req.since).toBeUndefined();
    expect(h.calls[0].req.instance).toBeUndefined();
    expect(h.calls[0].req.token).toBe(TARGET.token);

    h.calls[0].resolve(ok(5, true));
    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].req).toMatchObject({ since: 5, instance: "inst-1" });

    h.calls[1].resolve(ok(5, false));
    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS);
    expect(h.onChange).not.toHaveBeenCalled();

    h.calls[2].resolve(ok(9, true));
    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.calls[3].req).toMatchObject({ since: 9, instance: "inst-1" });
    h.hint.dispose();
  });

  it("backs off exponentially on errors, caps at the maximum, waits 5 min on 404", async () => {
    const h = harness();
    h.hint.update(TARGET);
    await flush();
    const expected = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    expect(HINT_BACKOFF_BASE_MS).toBe(expected[0]);
    expect(HINT_BACKOFF_MAX_MS).toBe(60_000);
    const failures: Array<() => void> = [
      () => lastCall(h).reject("NETWORK: down"),
      () => lastCall(h).resolve({ status: 401, body: { error: "unauthorized" } }),
      () => lastCall(h).resolve({ status: 503, body: { code: "CDS_UNAVAILABLE" } }),
      () => lastCall(h).resolve({ status: 200, body: { revision: "x" } }),
      () => lastCall(h).reject("TIMEOUT"),
      () => lastCall(h).reject("TIMEOUT"),
      () => lastCall(h).reject("TIMEOUT"),
    ];
    for (const [i, fail] of failures.entries()) {
      const before = h.calls.length;
      fail();
      await vi.advanceTimersByTimeAsync(expected[i] - 1);
      expect(h.calls).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.calls).toHaveLength(before + 1);
    }

    // 成功后退避清零；404 退 5 分钟且不累计失败。
    lastCall(h).resolve(ok(1, true));
    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS);
    let before = h.calls.length;
    lastCall(h).resolve({ status: 404, body: null });
    await vi.advanceTimersByTimeAsync(HINT_MISSING_PLUGIN_MS - 1);
    expect(h.calls).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(before + 1);

    before = h.calls.length;
    lastCall(h).reject("NETWORK: down");
    await vi.advanceTimersByTimeAsync(HINT_BACKOFF_BASE_MS);
    expect(h.calls).toHaveLength(before + 1);
    expect(h.onChange).not.toHaveBeenCalled();
    h.hint.dispose();
  });

  it("stops on background, cancels in-flight, and resumes with the kept cursor", async () => {
    const h = harness();
    h.hint.update(TARGET);
    await flush();
    h.calls[0].resolve(ok(3, true));
    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS);
    expect(h.calls).toHaveLength(2);

    h.hint.update(null);
    await flush();
    expect(h.cancel).toHaveBeenCalledWith(h.calls[1].req.requestId);
    await vi.advanceTimersByTimeAsync(HINT_BACKOFF_MAX_MS * 2);
    expect(h.calls).toHaveLength(2);

    h.hint.update({ ...TARGET });
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].req).toMatchObject({ since: 3, instance: "inst-1" });
    h.calls[2].resolve(ok(4, true));
    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    h.hint.dispose();
  });

  it("stopping during a backoff sleep wakes and exits without another request", async () => {
    const h = harness();
    h.hint.update(TARGET);
    await flush();
    h.calls[0].reject("NETWORK: down");
    await flush();
    h.hint.update(null);
    await vi.advanceTimersByTimeAsync(HINT_BACKOFF_MAX_MS);
    expect(h.calls).toHaveLength(1);
  });

  it("same target while running is a no-op", async () => {
    const h = harness();
    h.hint.update(TARGET);
    await flush();
    h.hint.update({ ...TARGET });
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.cancel).not.toHaveBeenCalled();
    h.hint.dispose();
  });

  it("settings change restarts the loop and clears the cursor", async () => {
    const h = harness();
    h.hint.update(TARGET);
    await flush();
    h.calls[0].resolve(ok(7, true));
    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS);
    expect(h.calls).toHaveLength(2);

    h.hint.update({ ...TARGET, token: "fake-token-b" });
    await flush();
    expect(h.cancel).toHaveBeenCalledWith(h.calls[1].req.requestId);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].req.since).toBeUndefined();
    expect(h.calls[2].req.token).toBe("fake-token-b");

    // 新地址的首轮仍只建游标；旧请求迟到的结果被丢弃。
    h.calls[1].resolve(ok(99, true));
    h.calls[2].resolve(ok(1, true, "inst-2"));
    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(4);
    expect(h.calls[3].req).toMatchObject({ since: 1, instance: "inst-2" });
    h.hint.dispose();
  });
});

describe("hint target from settings", () => {
  const settings = {
    syncServerUrl: "ws://sync.example:5975/ws-sync",
    syncHttpUrl: " http://sync.example:5974 ",
    syncToken: "fake-token-a",
  } as unknown as AppSettings;

  it("requires foreground, auto sync, http url and token", () => {
    expect(hintTargetFromSettings(settings, true)).toEqual(TARGET);
    expect(hintTargetFromSettings(settings, false)).toBeNull();
    expect(hintTargetFromSettings({ ...settings, autoSync: false }, true)).toBeNull();
    expect(hintTargetFromSettings({ ...settings, syncHttpUrl: "  " }, true)).toBeNull();
    expect(hintTargetFromSettings({ ...settings, syncToken: "" }, true)).toBeNull();
    expect(hintTargetFromSettings(null, true)).toBeNull();
  });
});

describe("useRemoteChangeHint wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    requestSpy.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const waitCalls = () =>
    invokeMock.mock.calls.filter(([command]) => command === "sync_hint_wait");

  it("drives invoke from settings and foreground, requests auto sync on change", async () => {
    const responses: HintWaitResponse[] = [ok(1, true), ok(2, true)];
    mockInvoke("sync_hint_wait", () => responses.shift() ?? new Promise(() => {}));
    mockInvoke("sync_hint_cancel", () => undefined);
    const store = useSettingsStore();
    const foreground = ref(true);
    const dispose = useRemoteChangeHint(() => foreground.value);
    await flush();
    expect(waitCalls()).toHaveLength(0);

    store.settings = {
      syncServerUrl: "ws://sync.example:5975/ws-sync",
      syncHttpUrl: "http://sync.example:5974",
      syncToken: "fake-token-a",
    } as AppSettings;
    await nextTick();
    await flush();
    expect(waitCalls()).toHaveLength(1);
    expect(waitCalls()[0][1]).toMatchObject({ baseUrl: TARGET.baseUrl, token: TARGET.token });

    await vi.advanceTimersByTimeAsync(HINT_MIN_CYCLE_MS * 2);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith("remote-hint");
    expect(waitCalls()).toHaveLength(3);

    foreground.value = false;
    await nextTick();
    await flush();
    const cancelled = invokeMock.mock.calls.filter(([command]) => command === "sync_hint_cancel");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0][1]).toEqual({ requestId: waitCalls()[2][1]!.requestId });

    dispose();
  });
});
