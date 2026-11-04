import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { useAssistantStore } from "@/core/stores/assistant";
import { useChatSessionStore } from "@/core/stores/chatSessionStore";
import { useOpenTabsStore } from "@/core/stores/openTabsStore";
import {
  formatTopicCreatedAt,
  useTopicStore,
  type Topic,
} from "@/core/stores/topicListManager";
import TopicList from "@/features/topic/TopicList.vue";
import { channelInstances, mockInvoke } from "@/tests/mocks/tauri";

vi.mock("vue-router", () => ({
  useRouter: () => ({
    currentRoute: { value: { path: "/chat" } },
    push: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const topic = (id: string, overrides: Partial<Topic> = {}): Topic => ({
  id,
  name: id,
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

const ids = (items: Topic[]) => items.map((item) => item.id);

function selectAgentA() {
  useAssistantStore().agents = [
    { id: "agent-a", name: "A", model: "test", avatarCalculatedColor: null },
  ];
  useChatSessionStore().setConversation({ id: "agent-a", name: "A", type: "agent" }, null);
}

describe("ptp4g#43 topic list reload keeps previous rows", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  async function loadInitial(requests: ReturnType<typeof deferred<void>>[]) {
    const store = useTopicStore();
    const first = store.loadTopicList("agent-a", "agent");
    channelInstances[channelInstances.length - 1].emit([topic("old-1"), topic("old-2")]);
    requests[0].resolve();
    await first;
    return store;
  }

  it("keeps topics non-empty through invalidate + same-owner reload, then commits once", async () => {
    const requests = [deferred<void>(), deferred<void>()];
    let callIndex = 0;
    mockInvoke("get_topics_streamed", () => requests[callIndex++].promise);
    selectAgentA();
    const store = await loadInitial(requests);
    expect(ids(store.topics)).toEqual(["old-1", "old-2"]);

    store.invalidateAllTopicCaches();
    expect(ids(store.topics)).toEqual(["old-1", "old-2"]);

    const reload = store.loadTopicList("agent-a", "agent");
    expect(store.topics.length).toBeGreaterThan(0);
    channelInstances[channelInstances.length - 1].emit([topic("new-1")]);
    // 流式中途不覆盖：仍是旧列表
    expect(ids(store.topics)).toEqual(["old-1", "old-2"]);

    requests[1].resolve();
    await reload;
    expect(ids(store.topics)).toEqual(["new-1"]);
  });

  it("keeps the previous list when the reload fails", async () => {
    const requests = [deferred<void>(), deferred<void>()];
    let callIndex = 0;
    mockInvoke("get_topics_streamed", () => requests[callIndex++].promise);
    selectAgentA();
    const store = await loadInitial(requests);

    const reload = store.loadTopicList("agent-a", "agent");
    channelInstances[channelInstances.length - 1].emit([topic("partial")]);
    requests[1].reject(new Error("ipc down"));
    await expect(reload).rejects.toThrow("ipc down");
    expect(ids(store.topics)).toEqual(["old-1", "old-2"]);
  });

  it("drops a stale buffered reload superseded by a newer one", async () => {
    const requests = [deferred<void>(), deferred<void>(), deferred<void>()];
    let callIndex = 0;
    mockInvoke("get_topics_streamed", () => requests[callIndex++].promise);
    selectAgentA();
    const store = await loadInitial(requests);

    const stale = store.loadTopicList("agent-a", "agent");
    channelInstances[channelInstances.length - 1].emit([topic("stale")]);
    store.invalidateAllTopicCaches();
    const fresh = store.loadTopicList("agent-a", "agent");
    channelInstances[channelInstances.length - 1].emit([topic("fresh")]);

    requests[1].resolve();
    await stale;
    expect(ids(store.topics)).toEqual(["old-1", "old-2"]);
    requests[2].resolve();
    await fresh;
    expect(ids(store.topics)).toEqual(["fresh"]);
  });

  it("still clears on owner switch and when the owner is no longer selected", async () => {
    const requests = [deferred<void>(), deferred<void>()];
    let callIndex = 0;
    mockInvoke("get_topics_streamed", () => requests[callIndex++].promise);
    const store = await loadInitial(requests);

    // 未选中任何 owner：失效即清空
    store.invalidateAllTopicCaches();
    expect(store.topics).toEqual([]);

    store.topics = [topic("old-1")];
    const loadB = store.loadTopicList("agent-b", "agent");
    expect(store.topics).toEqual([]);
    requests[1].resolve();
    await loadB;
  });
});

describe("ptp4g#43 formatTopicCreatedAt", () => {
  it("formats milliseconds and seconds identically in local time", () => {
    const ms = new Date(2026, 10, 4, 9, 5, 30).getTime();
    expect(formatTopicCreatedAt(ms)).toBe("2026-11-04 09:05");
    expect(formatTopicCreatedAt(Math.floor(ms / 1000))).toBe("2026-11-04 09:05");
  });

  it("returns an empty string for missing or invalid values", () => {
    expect(formatTopicCreatedAt(0)).toBe("");
    expect(formatTopicCreatedAt(undefined)).toBe("");
    expect(formatTopicCreatedAt(null)).toBe("");
    expect(formatTopicCreatedAt(Number.NaN)).toBe("");
  });

  it("matches search by the displayed date", () => {
    setActivePinia(createPinia());
    const store = useTopicStore();
    const ms = new Date(2026, 10, 4, 9, 5).getTime();
    store.topics = [topic("hit", { createdAt: ms }), topic("miss", { createdAt: 1 })];
    store.searchTerm = "2026-11-04 09";
    expect(ids(store.filteredTopics)).toEqual(["hit"]);
  });
});

describe("ptp4g#43 TopicList row markers", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("shows created time instead of id, a pin icon and an open-tab dot", async () => {
    const ms = new Date(2026, 10, 4, 9, 5).getTime();
    const store = useTopicStore();
    store.topics = [
      topic("topic-a", { name: "Alpha", createdAt: ms }),
      topic("topic-b", { name: "Beta", createdAt: ms }),
    ];
    store.toggleTopicPinned("agent-a", "agent", "topic-a");
    useOpenTabsStore().tabs = [{
      ownerId: "agent-a",
      ownerType: "agent",
      topicId: "topic-b",
      title: "Beta",
      ownerName: "A",
      avatarColor: null,
      unread: false,
    }];

    const wrapper = mount(TopicList, { global: { directives: { longpress: {} } } });
    await nextTick();

    const created = wrapper.findAll('[data-testid="topic-created-at"]');
    expect(created.length).toBe(2);
    expect(created.every((node) => node.text() === "2026-11-04 09:05")).toBe(true);
    expect(wrapper.text()).not.toContain("topic-a");
    expect(wrapper.findAll('[data-testid="topic-pin-icon"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="topic-open-tab-dot"]')).toHaveLength(1);
    wrapper.unmount();
  });
});
