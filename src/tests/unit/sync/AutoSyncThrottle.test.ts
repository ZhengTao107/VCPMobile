import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_SYNC_DEBOUNCE_MS,
  REMOTE_HINT_MIN_INTERVAL_MS,
  REMOTE_HINT_QUIET_MS,
  createAutoSyncTrigger,
} from "@/core/sync/autoSyncTrigger";

describe("auto sync remote-hint throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const run = vi.fn(async (_reason: string) => {});
    const trigger = createAutoSyncTrigger({ isReady: () => true, run, now: () => Date.now() });
    return { run, trigger };
  };

  it("merges a burst of hints into one run after the quiet window", async () => {
    const { run, trigger } = make();
    trigger.request("remote-hint");
    await vi.advanceTimersByTimeAsync(1000);
    trigger.request("remote-hint");
    trigger.request("remote-hint");
    await vi.advanceTimersByTimeAsync(REMOTE_HINT_QUIET_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("remote-hint");
    trigger.dispose();
  });

  it("continuous hints run at most once per min interval but never starve", async () => {
    const { run, trigger } = make();
    for (let i = 0; i < 95; i++) {
      trigger.request("remote-hint");
      await vi.advanceTimersByTimeAsync(1000);
    }
    // 95 秒内持续每秒一条提示：30s、60s、90s 各一轮。
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(REMOTE_HINT_MIN_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(4);
    trigger.dispose();
  });

  it("hints right after a run wait for the min interval", async () => {
    const { run, trigger } = make();
    trigger.request("remote-hint");
    await vi.advanceTimersByTimeAsync(REMOTE_HINT_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(1);
    trigger.request("remote-hint");
        await vi.advanceTimersByTimeAsync(REMOTE_HINT_MIN_INTERVAL_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    trigger.dispose();
  });

  it("stream-end is not throttled and overrides a pending hint", async () => {
    const { run, trigger } = make();
    trigger.request("remote-hint");
    await vi.advanceTimersByTimeAsync(REMOTE_HINT_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(1);
    trigger.request("remote-hint");
    trigger.request("stream-end");
    trigger.request("remote-hint");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("stream-end");
    trigger.dispose();
  });

  it("keeps a non-throttled pending reason while running", async () => {
    let release!: () => void;
    const run = vi.fn((_reason: string) => new Promise<void>((resolve) => { release = resolve; }));
    const trigger = createAutoSyncTrigger({ isReady: () => true, run });
    trigger.request("App foreground");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    trigger.request("stream-end");
    trigger.request("remote-hint");
    release();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("stream-end");
    trigger.dispose();
  });
});
