import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeMock } from "@/tests/mocks/tauri";
import {
  SYNC_NOTICE_PRIORITY,
  SYNC_NOTICE_TAG,
  createSyncForegroundNotice,
  formatSyncNoticeLabel,
} from "@/core/sync/syncForegroundNotice";

const callsOf = (command: string) =>
  invokeMock.mock.calls.filter(([name]) => name === `plugin:vcp-mobile|${command}`);

describe("sync foreground notice", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats phase progress", () => {
    expect(formatSyncNoticeLabel("历史消息同步", 3, 10)).toBe("VCP 正在同步 · 历史消息同步 3/10");
    expect(formatSyncNoticeLabel("初始化", 0, 0)).toBe("VCP 正在同步 · 初始化");
  });

  it("sends the first label at once and coalesces later labels within the throttle window", async () => {
    const notice = createSyncForegroundNotice(1000);
    notice.show("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(callsOf("acquire_foreground")).toHaveLength(1);
    expect(callsOf("acquire_foreground")[0][1]).toEqual({
      tag: SYNC_NOTICE_TAG,
      priority: SYNC_NOTICE_PRIORITY,
      label: "a",
      screenKeepOn: false,
    });

    notice.show("b");
    notice.show("c");
    await vi.advanceTimersByTimeAsync(999);
    expect(callsOf("acquire_foreground")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callsOf("acquire_foreground")).toHaveLength(2);
    expect((callsOf("acquire_foreground")[1][1] as Record<string, unknown>).label).toBe("c");

    notice.hide();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsOf("release_foreground")).toEqual([
      ["plugin:vcp-mobile|release_foreground", { tag: SYNC_NOTICE_TAG }],
    ]);
  });

  it("drops a pending label on hide and never releases what it never acquired", async () => {
    const notice = createSyncForegroundNotice(1000);
    notice.hide();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsOf("release_foreground")).toHaveLength(0);

    notice.show("a");
    notice.show("b");
    notice.hide();
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsOf("acquire_foreground")).toHaveLength(1);
    expect(callsOf("release_foreground")).toHaveLength(1);
  });
});
