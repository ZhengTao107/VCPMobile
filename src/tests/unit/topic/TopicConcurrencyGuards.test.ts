import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { useAssistantStore } from "@/core/stores/assistant";
import { useChatSessionStore } from "@/core/stores/chatSessionStore";
import {
  useTopicStore,
  type Topic,
} from "@/core/stores/topicListManager";
import TopicList from "@/features/topic/TopicList.vue";
import {
  channelInstances,
  invokeMock,
  mockInvoke,
  type MockChannel,
} from "@/tests/mocks/tauri";

vi.mock("vue-router", () => ({
  useRouter: () => ({
    currentRoute: { value: { path: "/chat" } },
    push: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const topic = (
  id: string,
  name = id,
  overrides: Partial<Topic> = {},
): Topic => ({
  id,
  name,
  createdAt: 1,
  updatedAt: 1,
  locked: true,
  unread: false,
  unreadCount: 0,
  msgCount: 0,
  ownerId: "agent-a",
  ownerType: "agent" as const,
  ...overrides,
});

function createPersistedTopicStore() {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  const app = {
    provide: () => undefined,
    config: { globalProperties: {} },
  } as unknown as import("vue").App;
  pinia.install(app);
  setActivePinia(pinia);
  return useTopicStore();
}

describe("topic list concurrency guards", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("sorts pinned and regular sections by the same selected rule", () => {
    const store = useTopicStore();
    store.topics = [
      topic("older-active", "Older active", { createdAt: 100, updatedAt: 900 }),
      topic("newer-created", "Newer created", { createdAt: 300, updatedAt: 400 }),
      topic("middle", "Middle", { createdAt: 200, updatedAt: 800 }),
    ];
    store.setSortMode("created");
    store.toggleTopicPinned("agent-a", "agent", "older-active");
    store.toggleTopicPinned("agent-a", "agent", "newer-created");

    expect(store.topicSections.pinned.map((item) => item.id)).toEqual([
      "newer-created",
      "older-active",
    ]);
    expect(store.topicSections.regular.map((item) => item.id)).toEqual(["middle"]);

    store.setSortMode("updated");
    expect(store.topicSections.pinned.map((item) => item.id)).toEqual([
      "older-active",
      "newer-created",
    ]);
    expect(store.topicSections.regular.map((item) => item.id)).toEqual(["middle"]);
  });

  it("uses deterministic ties and isolates pinned identities by owner", () => {
    const store = useTopicStore();
    store.topics = [topic("tie-a"), topic("tie-b")];
    store.setSortMode("created");
    expect(store.topicSections.regular.map((item) => item.id)).toEqual([
      "tie-b",
      "tie-a",
    ]);

    store.topics = [...store.topics, topic("same-topic")];
    void store.toggleTopicPinned("agent-a", "agent", "same-topic");
    expect(store.isTopicPinned("agent-a", "agent", "same-topic")).toBe(true);
    expect(store.isTopicPinned("agent-b", "agent", "same-topic")).toBe(false);
    expect(store.isTopicPinned("agent-a", "group", "same-topic")).toBe(false);
  });

  it("lets an authoritative message bubble replace activity with an older live maximum", async () => {
    mockInvoke("get_topics_streamed", () => Promise.resolve());
    const store = useTopicStore();
    store.setSortMode("updated");
    const loading = store.loadTopicList("agent-a", "agent");
    channelInstances[channelInstances.length - 1]?.emit([
      topic("topic-a", "Topic A", { updatedAt: 900 }),
      topic("topic-b", "Topic B", { updatedAt: 500 }),
    ]);
    await loading;

    store.setTopicUpdatedAt("agent-a", "agent", "topic-a", 400);
    expect(store.topics.map((item) => item.id)).toEqual(["topic-b", "topic-a"]);
    expect(store.topics.find((item) => item.id === "topic-a")?.updatedAt).toBe(400);

    mockInvoke("set_topic_unread", () => null);
    await store.setTopicUnread("agent-a", "agent", "topic-a", false);
    expect(store.topics.map((item) => item.id)).toEqual(["topic-b", "topic-a"]);
  });

  it("persists the global sort mode while pins are written to the database", async () => {
    const first = createPersistedTopicStore();
    first.setSortMode("updated");
    first.topics = [topic("topic-a")];
    await expect(first.toggleTopicPinned("agent-a", "agent", "topic-a")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("set_topic_pinned", {
      ownerId: "agent-a",
      ownerType: "agent",
      topicId: "topic-a",
      pinned: true,
    });
    expect(first.isTopicPinned("agent-a", "agent", "topic-a")).toBe(true);
    expect(first.pinnedTopicKeys).toEqual([]);
    await nextTick();

    const restored = createPersistedTopicStore();
    expect(restored.effectiveSortMode).toBe("updated");
    // 置顶不再进 pinia，重启后由 DB 列表重新带回
    expect(restored.isTopicPinned("agent-a", "agent", "topic-a")).toBe(false);
  });

  it("rolls back a failed optimistic pin and unpins through the database", async () => {
    const store = useTopicStore();
    store.topics = [topic("topic-a")];
    mockInvoke("set_topic_pinned", () => Promise.reject(new Error("db down")));
    await expect(store.toggleTopicPinned("agent-a", "agent", "topic-a")).rejects.toThrow("db down");
    expect(store.isTopicPinned("agent-a", "agent", "topic-a")).toBe(false);

    mockInvoke("set_topic_pinned", (args) => (args?.pinned ? 50 : 60));
    await expect(store.toggleTopicPinned("agent-a", "agent", "topic-a")).resolves.toBe(true);
    expect(store.topics[0]).toMatchObject({ pinned: true, updatedAt: 50 });
    await expect(store.toggleTopicPinned("agent-a", "agent", "topic-a")).resolves.toBe(false);
    expect(store.topics[0]).toMatchObject({ pinned: false, updatedAt: 60 });
    expect(store.isTopicPinned("agent-a", "agent", "topic-a")).toBe(false);
  });

  it("reads legacy pinned keys and migrates them into the database once", async () => {
    const store = useTopicStore();
    store.pinnedTopicKeys = [
      JSON.stringify(["agent", "agent-a", "topic-a"]),
      JSON.stringify(["agent", "agent-a", "gone"]),
    ];
    expect(store.isTopicPinned("agent-a", "agent", "topic-a")).toBe(true);
    const migrated: unknown[] = [];
    mockInvoke("migrate_legacy_topic_pins", (args) => {
      migrated.push(args?.pins);
      return 1;
    });
    mockInvoke("get_topics_streamed", (args) => {
      (args?.onChunk as MockChannel<Topic[]>).emit([topic("topic-a")]);
    });

    await store.loadTopicList("agent-a", "agent");
    expect(migrated).toEqual([[{ ownerId: "agent-a", ownerType: "agent", topicId: "topic-a" }]]);
    expect(store.pinnedTopicKeys).toEqual([]);
    expect(store.topicSections.pinned.map((item) => item.id)).toEqual(["topic-a"]);

    await store.loadTopicList("agent-a", "agent");
    expect(migrated).toHaveLength(1);
  });




  it("deduplicates concurrent loads for the same owner", async () => {
    const pending = deferred<void>();
    mockInvoke("get_topics_streamed", () => pending.promise);
    const store = useTopicStore();

    const first = store.loadTopicList("agent-a", "agent");
    const second = store.loadTopicList("agent-a", "agent");

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "get_topics_streamed"),
    ).toHaveLength(1);
    pending.resolve();
    await Promise.all([first, second]);
  });

  it("requests the selected backend order and preserves its streamed prefix", async () => {
    const pending = deferred<void>();
    mockInvoke("get_topics_streamed", () => pending.promise);
    const store = useTopicStore();
    store.setSortMode("updated");

    const loading = store.loadTopicList("agent-a", "agent");
    const channel = channelInstances[channelInstances.length - 1];
    channel?.emit([
      topic("most-active", "Most active", { createdAt: 100, updatedAt: 900 }),
      topic("middle-active", "Middle active", { createdAt: 300, updatedAt: 800 }),
    ]);
    expect(store.topics.map((item) => item.id)).toEqual([
      "most-active",
      "middle-active",
    ]);

    channel?.emit([
      topic("least-active", "Least active", { createdAt: 500, updatedAt: 400 }),
    ]);
    expect(store.topics.map((item) => item.id)).toEqual([
      "most-active",
      "middle-active",
      "least-active",
    ]);
    expect(invokeMock).toHaveBeenCalledWith(
      "get_topics_streamed",
      expect.objectContaining({ sortMode: "updated" }),
    );

    pending.resolve();
    await loading;
  });

  it("restarts an in-flight list when its backend sort mode changes", async () => {
    const requests = [deferred<void>(), deferred<void>()];
    let callIndex = 0;
    mockInvoke("get_topics_streamed", () => requests[callIndex++].promise);
    const store = useTopicStore();

    const createdLoad = store.loadTopicList("agent-a", "agent");
    store.setSortMode("updated");
    await expect.poll(() => callIndex).toBe(2);

    channelInstances[0]?.emit([topic("stale-created")]);
    channelInstances[1]?.emit([
      topic("fresh-updated", "Fresh updated", { updatedAt: 900 }),
    ]);
    expect(store.topics.map((item) => item.id)).toEqual(["fresh-updated"]);
    expect(invokeMock.mock.calls
      .filter(([command]) => command === "get_topics_streamed")
      .map(([, args]) => args?.sortMode))
      .toEqual(["created", "updated"]);

    requests.forEach(({ resolve }) => resolve());
    await Promise.all([createdLoad, requests[1].promise]);
  });

  it("watches semantic owner identity instead of owner object identity", async () => {
    const requests = [deferred<void>(), deferred<void>()];
    let callIndex = 0;
    mockInvoke("get_topics_streamed", () => requests[callIndex++].promise);
    const assistantStore = useAssistantStore();
    assistantStore.agents = [
      {
        id: "agent-a",
        name: "A",
        model: "test",
        avatarCalculatedColor: null,
      },
      {
        id: "agent-b",
        name: "B",
        model: "test",
        avatarCalculatedColor: null,
      },
    ];
    const sessionStore = useChatSessionStore();
    sessionStore.setConversation(
      { id: "agent-a", name: "A", type: "agent" },
      "topic-a",
    );

    const wrapper = mount(TopicList, {
      global: { directives: { longpress: {} } },
    });
    await expect.poll(() => callIndex).toBe(1);

    sessionStore.setConversation({
      id: "agent-a",
      name: "A refreshed",
      type: "agent",
    }, "topic-a");
    await expect.poll(() => callIndex).toBe(1);

    sessionStore.setConversation({
      id: "agent-b",
      name: "B",
      type: "agent",
    }, null);
    await expect.poll(() => callIndex).toBe(2);

    wrapper.unmount();
    requests.forEach(({ resolve }) => resolve());
    await Promise.all(requests.map(({ promise }) => promise));
  });

  it("resets the virtual window when search narrows to an offscreen topic", async () => {
    const store = useTopicStore();
    store.topics = Array.from({ length: 60 }, (_, index) =>
      topic(
        `topic-${index}`,
        index === 55 ? "Needle Topic" : `Topic ${index}`,
      ),
    );

    const wrapper = mount(TopicList, {
      props: { searchQuery: "" },
      global: { directives: { longpress: {} } },
    });
    const scroller = wrapper.find<HTMLElement>(".vcp-scrollable");
    await nextTick();
    Object.defineProperty(scroller.element, "clientHeight", {
      configurable: true,
      value: 296,
    });
    scroller.element.scrollTop = 40 * 74;
    await scroller.trigger("scroll");
    expect(wrapper.text()).not.toContain("Needle Topic");

    await wrapper.setProps({ searchQuery: "needle" });

    await expect.poll(() => scroller.element.scrollTop).toBe(0);
    await expect.poll(() => wrapper.text()).toContain("Needle Topic");
    wrapper.unmount();
  });

  it("rejects stale chunks and stale finally across A to B to A", async () => {
    const requests = [deferred<void>(), deferred<void>(), deferred<void>()];
    let callIndex = 0;
    mockInvoke("get_topics_streamed", () => requests[callIndex++].promise);
    const store = useTopicStore();

    const firstA = store.loadTopicList("agent-a", "agent");
    const loadB = store.loadTopicList("agent-b", "agent");
    const latestA = store.loadTopicList("agent-a", "agent");

    channelInstances[0].emit([topic("stale-a")]);
    channelInstances[1].emit([topic("stale-b")]);
    expect(store.topics).toEqual([]);

    channelInstances[2].emit([topic("latest-a")]);
    expect(store.topics.map((item) => item.id)).toEqual(["latest-a"]);

    requests[0].resolve();
    requests[1].resolve();
    await Promise.all([firstA, loadB]);
    expect(store.loading).toBe(true);

    requests[2].resolve();
    await latestA;
    expect(store.loading).toBe(false);
  });

  it("invalidates an in-flight channel and allows an explicit same-owner reload", async () => {
    const requests = [deferred<void>(), deferred<void>()];
    let callIndex = 0;
    mockInvoke("get_topics_streamed", () => requests[callIndex++].promise);
    const store = useTopicStore();

    const stale = store.loadTopicList("agent-a", "agent");
    store.invalidateAllTopicCaches();
    const fresh = store.loadTopicList("agent-a", "agent");

    channelInstances[0].emit([topic("stale")]);
    channelInstances[1].emit([topic("fresh")]);
    expect(store.topics.map((item) => item.id)).toEqual(["fresh"]);

    requests[0].resolve();
    requests[1].resolve();
    await Promise.all([stale, fresh]);
  });

  it("does not inject a late create result into a different owner's list", async () => {
    const loads = [deferred<void>(), deferred<void>()];
    const create = deferred<any>();
    let loadIndex = 0;
    mockInvoke("get_topics_streamed", () => loads[loadIndex++].promise);
    mockInvoke("create_topic", () => create.promise);
    const store = useTopicStore();

    const loadA = store.loadTopicList("agent-a", "agent");
    channelInstances[0].emit([topic("topic-a")]);
    loads[0].resolve();
    await loadA;

    const creatingA = store.createTopic("agent-a", "agent", "new-a");
    const loadB = store.loadTopicList("agent-b", "agent");
    channelInstances[1].emit([topic("topic-b")]);
    loads[1].resolve();
    await loadB;

    create.resolve(topic("created-a"));
    await creatingA;
    expect(store.topics.map((item) => item.id)).toEqual(["topic-b"]);
  });
});
