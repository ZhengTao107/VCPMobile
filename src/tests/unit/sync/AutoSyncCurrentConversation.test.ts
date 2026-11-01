import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStreamStore } from "@/core/stores/chatStreamStore";
import { useChatSessionStore } from "@/core/stores/chatSessionStore";
import { waitForCurrentConversationIdle } from "@/core/sync/autoSyncTrigger";

describe("auto sync waits only for the current conversation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const session = useChatSessionStore();
    session.setConversation({ id: "a", type: "agent", name: "A" }, "current");
  });
  afterEach(() => vi.useRealTimers());

  it("does not wait for background topics that are streaming", async () => {
    const stream = useChatStreamStore();
    stream.addSessionStream("a", "agent", "background", "m1");
    stream.addSessionStream("b", "agent", "current", "m2");
    await expect(
      waitForCurrentConversationIdle(stream, useChatSessionStore(), 1000),
    ).resolves.toBe(true);
  });

  it("waits until the current conversation finishes", async () => {
    const stream = useChatStreamStore();
    stream.addSessionStream("a", "agent", "current", "m1");
    let settled: boolean | null = null;
    const wait = waitForCurrentConversationIdle(stream, useChatSessionStore(), 60_000)
      .then((ok) => { settled = ok; });
    await Promise.resolve();
    expect(settled).toBeNull();

    stream.removeSessionStream("a", "agent", "current", "m1", true);
    await wait;
    expect(settled).toBe(true);
  });

  it("re-evaluates when the user switches away from a streaming topic", async () => {
    const stream = useChatStreamStore();
    const session = useChatSessionStore();
    stream.addSessionStream("a", "agent", "current", "m1");
    const wait = waitForCurrentConversationIdle(stream, session, 60_000);
    session.setConversation({ id: "a", type: "agent", name: "A" }, "other");
    await expect(wait).resolves.toBe(true);
    expect(stream.isConversationStreaming({ ownerId: "a", ownerType: "agent", topicId: "current" })).toBe(true);
  });

  it("keeps the timeout guard", async () => {
    vi.useFakeTimers();
    const stream = useChatStreamStore();
    stream.addSessionStream("a", "agent", "current", "m1");
    const wait = waitForCurrentConversationIdle(stream, useChatSessionStore(), 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(wait).resolves.toBe(false);
  });
});
