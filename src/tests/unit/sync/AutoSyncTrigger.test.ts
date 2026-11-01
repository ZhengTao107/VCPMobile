import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AppSettings } from "@/core/stores/settings";
import { useSyncSessionStore } from "@/core/stores/syncSession";
import { useChatStreamStore } from "@/core/stores/chatStreamStore";
import { useNotificationStore } from "@/core/stores/notification";
import { emitTauriEvent, invokeMock, mockInvoke } from "@/tests/mocks/tauri";

const requestSpy = vi.hoisted(() => vi.fn());

vi.mock("@/core/utils/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/utils/platform")>()),
  nativePlatform: "android",
  isAndroid: true,
  isIOS: false,
}));

vi.mock("@/core/sync/autoSyncTrigger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/sync/autoSyncTrigger")>()),
  requestAutoSync: requestSpy,
}));

import {
  AUTO_SYNC_DEBOUNCE_MS,
  createAutoSyncTrigger,
  isAutoSyncReady,
} from "@/core/sync/autoSyncTrigger";

describe("auto sync trigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges requests inside the trailing debounce window into one run", async () => {
    const run = vi.fn(async () => {});
    const trigger = createAutoSyncTrigger({ isReady: () => true, run });
    trigger.request("a");
    await vi.advanceTimersByTimeAsync(1000);
    trigger.request("b");
    trigger.request("c");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("c");
    trigger.dispose();
  });

  it("keeps one pending request while running and replays it exactly once", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const trigger = createAutoSyncTrigger({ isReady: () => true, run });
    trigger.request("first");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    trigger.request("x");
    trigger.request("y");
    trigger.request("z");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("z");

    release();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS * 3);
    expect(run).toHaveBeenCalledTimes(2);
    trigger.dispose();
  });

  it("does nothing when not ready, including readiness lost before firing", async () => {
    const run = vi.fn(async () => {});
    let ready = false;
    const trigger = createAutoSyncTrigger({ isReady: () => ready, run });
    trigger.request("unconfigured");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS * 2);
    expect(run).not.toHaveBeenCalled();

    ready = true;
    trigger.request("configured");
    ready = false;
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(run).not.toHaveBeenCalled();
    trigger.dispose();
  });

  it("survives a failed run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const trigger = createAutoSyncTrigger({ isReady: () => true, run });
    trigger.request("a");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    trigger.request("b");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
    trigger.dispose();
  });
});

describe("auto sync readiness", () => {
  const configured = {
    syncServerUrl: "ws://192.168.1.10:5975",
    syncToken: "sync-token-1",
  } as unknown as AppSettings;

  it("defaults on when sync address and token are configured", () => {
    expect(isAutoSyncReady(configured)).toBe(true);
    expect(isAutoSyncReady({ ...configured, autoSync: true })).toBe(true);
  });

  it("stays off without settings, address or token", () => {
    expect(isAutoSyncReady(null)).toBe(false);
    expect(isAutoSyncReady({ ...configured, syncServerUrl: "  " })).toBe(false);
    expect(isAutoSyncReady({ ...configured, syncToken: "" })).toBe(false);
  });

  it("is fully disabled by the switch", () => {
    expect(isAutoSyncReady({ ...configured, autoSync: false })).toBe(false);
  });
});

describe("stream terminal hook", () => {
  const context = { ownerId: "agent-a", ownerType: "agent", topicId: "topic-a" };

  beforeEach(() => {
    setActivePinia(createPinia());
    requestSpy.mockClear();
  });

  it("requests auto sync after a durable end", async () => {
    const stream = useChatStreamStore();
    await stream.processStreamEvent({
      type: "end", messageId: "done", consumerRevision: 1, context,
      content: "committed", finishReason: "completed", blocks: [],
    } as any);
    expect(requestSpy).toHaveBeenCalledWith("stream-end");
  });

  it("does not request on a non-durable error", async () => {
    const stream = useChatStreamStore();
    await stream.processStreamEvent({
      type: "error", messageId: "failed", consumerRevision: 1, context, content: "partial",
    } as any);
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

describe("quiet auto sync session", () => {
  const completed = (sessionId: number) => ({
    sessionId,
    status: "completed",
    summary: {
      successfulTopics: 1, totalTopics: 1, failedTopics: 0,
      legacyAttachmentWarnings: 0, failedTopicIds: [],
    },
  });

  beforeEach(() => {
    setActivePinia(createPinia());
    mockInvoke("stop_sync", () => undefined);
    mockInvoke("plugin:vcp-mobile|get_battery_status", () => ({ level: 80, isPowerSaveMode: false }));
    mockInvoke("start_manual_sync", () => 7);
    mockInvoke("get_assistants_snapshot", () => ({ agents: [], groups: [], unreadCounts: {} }));
    mockInvoke("batch_get_avatars", () => []);
  });

  it("runs without device-status logs and closes itself after completion", async () => {
    const store = useSyncSessionStore();
    const run = store.runAutoSync("test");
    await vi.waitFor(() => expect(store.activeSessionId).toBe(7));
    expect(invokeMock.mock.calls.some(([command]) => command === "plugin:vcp-mobile|get_battery_status")).toBe(true);
    expect(store.logs.some((log) => log.message.includes("设备状态"))).toBe(false);

    emitTauriEvent("vcp-sync-status", { sessionId: 7, status: "open" });
    emitTauriEvent("vcp-sync-completed", completed(7));
    await expect(run).resolves.toBe("completed");
    expect(store.isOpen).toBe(false);
    expect(invokeMock.mock.calls.some(([command]) => command === "stop_sync")).toBe(true);
  });

  it("writes one console line instead of a toast when quiet shutdown fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const add = vi.spyOn(useNotificationStore(), "addNotification");
    const store = useSyncSessionStore();
    const run = store.runAutoSync("test");
    await vi.waitFor(() => expect(store.activeSessionId).toBe(7));
    mockInvoke("stop_sync", () => { throw new Error("STOP_PENDING"); });
    emitTauriEvent("vcp-sync-completed", completed(7));
    await run;
    expect(add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("hands a running quiet session to the panel without resetting it", async () => {
    const store = useSyncSessionStore();
    const run = store.runAutoSync("test");
    await vi.waitFor(() => expect(store.activeSessionId).toBe(7));
    store.open();
    expect(store.activeSessionId).toBe(7);
    expect(store.status).toBe("connecting");
    await expect(run).resolves.toBe("taken_over");
    expect(store.isOpen).toBe(true);
    emitTauriEvent("vcp-sync-completed", completed(7));
    expect(store.status).toBe("completed");
    await store.close();
    expect(store.isOpen).toBe(false);
  });

  it("yields to an open panel and keeps manual sync output unchanged", async () => {
    const store = useSyncSessionStore();
    store.open();
    await expect(store.runAutoSync("test")).resolves.toBe("skipped");
    expect(invokeMock.mock.calls.some(([command]) => command === "start_manual_sync")).toBe(false);
    await store.startSync();
    expect(store.logs.some((log) => log.message === "设备状态检查完成")).toBe(true);
    emitTauriEvent("vcp-sync-completed", completed(7));
    await store.close();
  });

  describe("reload after completion", () => {
    const noChange = (sessionId: number) => ({
      sessionId,
      status: "completed",
      summary: {
        successfulTopics: 0, totalTopics: 0, failedTopics: 0,
        legacyAttachmentWarnings: 0, failedTopicIds: [],
      },
    });
    const reloadCount = () =>
      invokeMock.mock.calls.filter(([command]) => command === "get_assistants_snapshot").length;

    it("skips the full reload when the auto sync observed no writes", async () => {
      const store = useSyncSessionStore();
      const run = store.runAutoSync("test");
      await vi.waitFor(() => expect(store.activeSessionId).toBe(7));
      emitTauriEvent("vcp-sync-status", { sessionId: 7, status: "open" });
      emitTauriEvent("vcp-sync-progress", { sessionId: 7, phase: "topic_validation", total: 0, completed: 0 });
      emitTauriEvent("vcp-sync-completed", noChange(7));
      await expect(run).resolves.toBe("completed");
      expect(reloadCount()).toBe(0);
      expect(store.needsReload).toBe(false);
    });

    it("keeps the full reload when message topics changed", async () => {
      const store = useSyncSessionStore();
      const run = store.runAutoSync("test");
      await vi.waitFor(() => expect(store.activeSessionId).toBe(7));
      emitTauriEvent("vcp-sync-status", { sessionId: 7, status: "open" });
      emitTauriEvent("vcp-sync-completed", completed(7));
      await expect(run).resolves.toBe("completed");
      expect(reloadCount()).toBe(1);
    });

    it("keeps the full reload when only metadata operations ran", async () => {
      const store = useSyncSessionStore();
      const run = store.runAutoSync("test");
      await vi.waitFor(() => expect(store.activeSessionId).toBe(7));
      emitTauriEvent("vcp-sync-status", { sessionId: 7, status: "open" });
      emitTauriEvent("vcp-sync-progress", { sessionId: 7, phase: "owner_metadata", total: 2, completed: 2 });
      emitTauriEvent("vcp-sync-completed", noChange(7));
      await expect(run).resolves.toBe("completed");
      expect(reloadCount()).toBe(1);
    });

    it("keeps the full reload when early session events were dropped", async () => {
      let resolveSession!: (id: number) => void;
      mockInvoke("start_manual_sync", () => new Promise<number>((resolve) => { resolveSession = resolve; }));
      const store = useSyncSessionStore();
      const run = store.runAutoSync("test");
      await vi.waitFor(() =>
        expect(invokeMock.mock.calls.some(([command]) => command === "start_manual_sync")).toBe(true));
      for (let i = 0; i < 40; i += 1) {
        emitTauriEvent("vcp-sync-progress", { sessionId: 7, phase: "topic_validation", total: 0, completed: 0 });
      }
      resolveSession(7);
      await vi.waitFor(() => expect(store.activeSessionId).toBe(7));
      emitTauriEvent("vcp-sync-status", { sessionId: 7, status: "open" });
      emitTauriEvent("vcp-sync-completed", noChange(7));
      await expect(run).resolves.toBe("completed");
      expect(reloadCount()).toBe(1);
    });

    it("keeps the full reload for a manual panel sync even without writes", async () => {
      const store = useSyncSessionStore();
      store.open();
      await store.startSync();
      emitTauriEvent("vcp-sync-status", { sessionId: 7, status: "open" });
      emitTauriEvent("vcp-sync-completed", noChange(7));
      expect(store.status).toBe("completed");
      await store.close();
      expect(reloadCount()).toBe(1);
    });
  });
});
