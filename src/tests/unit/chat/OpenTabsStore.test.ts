import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { nextTick } from "vue";
import { useAssistantStore } from "@/core/stores/assistant";
import { useChatSessionStore } from "@/core/stores/chatSessionStore";
import { useTopicStore } from "@/core/stores/topicListManager";
import {
  normalizeOpenTabs,
  openTabKey,
  useOpenTabsStore,
} from "@/core/stores/openTabsStore";
import { clearInvokeMocks, mockInvoke } from "@/tests/mocks/tauri";

function installPersistedPinia() {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  pinia.install({
    provide: () => undefined,
    config: { globalProperties: {} },
  } as unknown as import("vue").App);
  setActivePinia(pinia);
  return pinia;
}

const agent = (id: string) => ({ id, name: `Agent ${id}`, avatarCalculatedColor: "#123456" });

const topicDto = (id: string, name = id) => ({
  id,
  name,
  createdAt: 1,
  updatedAt: 1,
  locked: true,
  unread: false,
  unreadCount: 0,
  msgCount: 0,
});

function setup(agentIds = ["a", "b"]) {
  installPersistedPinia();
  const assistant = useAssistantStore();
  assistant.agents = agentIds.map(agent) as any;
  assistant.groups = [];
  const session = useChatSessionStore();
  const topics = useTopicStore();
  const tabs = useOpenTabsStore();
  const select = async (ownerId: string, topicId: string) => {
    await session.selectTopicById(ownerId, "agent", topicId);
    await nextTick();
  };
  const ids = () => tabs.tabs.map((tab) => `${tab.ownerId}/${tab.topicId}`);
  return { assistant, session, topics, tabs, select, ids };
}

beforeEach(() => {
  localStorage.clear();
  clearInvokeMocks();
  mockInvoke("get_unread_counts", () => ({}));
  let revision = 0;
  const empty = { target: { kind: "welcome" }, focusRevision: 0, windowRevision: 0, anchorId: null };
  mockInvoke("connect_chat_view", () => ({ documentId: 1, focus: empty }));
  mockInvoke("register_chat_navigation_intent", () => ({ focus: empty }));
  mockInvoke("request_chat_navigation", (args) => ({
    status: "accepted",
    focus: { target: args?.target, focusRevision: ++revision, windowRevision: revision, anchorId: args?.anchorId ?? null },
  }));
  mockInvoke("restore_chat_view", (args) => ({
    status: "accepted",
    focus: { target: args?.hint, focusRevision: ++revision, windowRevision: revision, anchorId: null },
  }));
});

describe("open tabs store", () => {
  it("opens on selection without limit, dedups, reorders and closes to a neighbour", async () => {
    const { session, tabs, select, ids } = setup();
    for (let i = 0; i < 9; i += 1) await select("a", `t${i}`);
    expect(tabs.tabs).toHaveLength(9);

    await select("a", "t0");
    expect(tabs.tabs).toHaveLength(9);
    expect(tabs.activeKey).toBe(openTabKey({ ownerId: "a", ownerType: "agent", topicId: "t0" }));
    expect(tabs.tabs[0].title).toBe("t0");
    expect(tabs.tabs[0].ownerName).toBe("Agent a");

    tabs.moveTab(0, 8);
    expect(ids()[8]).toBe("a/t0");
    expect(ids()[0]).toBe("a/t1");

    await tabs.closeTab(tabs.tabs[8]);
    await nextTick();
    expect(ids()).not.toContain("a/t0");
    expect(session.currentTopicId).toBe("t8");

    await tabs.closeTab(tabs.tabs[0]);
    expect(ids()).not.toContain("a/t1");
    expect(session.currentTopicId).toBe("t8");
  });

  it("round-trips through persistence and drops corrupt entries", async () => {
    const first = setup();
    await first.select("a", "t1");
    await first.select("b", "t2");
    await vi.waitFor(() => expect(localStorage.getItem("openTabs")).toContain("t2"));

    const stored = JSON.parse(localStorage.getItem("openTabs")!);
    stored.tabs.push({ ownerId: "", ownerType: "agent", topicId: "x" });
    stored.tabs.push({ ownerId: "a", ownerType: "bogus", topicId: "y" });
    stored.tabs.push({ ...stored.tabs[0] });
    localStorage.setItem("openTabs", JSON.stringify(stored));

    const second = setup();
    expect(second.ids()).toEqual(["a/t1", "b/t2"]);
  });

  it("normalizes untrusted values", () => {
    expect(normalizeOpenTabs(null)).toEqual([]);
    expect(normalizeOpenTabs([{ ownerId: "a", ownerType: "group", topicId: "t" }])).toEqual([
      { ownerId: "a", ownerType: "group", topicId: "t", title: "t", ownerName: "", avatarColor: null, unread: false },
    ]);
  });

  it("removes tabs when a topic is deleted", async () => {
    const { topics, select, ids } = setup();
    mockInvoke("delete_topic", () => null);
    await select("a", "t1");
    await select("b", "t2");
    await topics.deleteTopic("a", "agent", "t1");
    expect(ids()).toEqual(["b/t2"]);
  });

  it("removes every tab of a deleted owner", async () => {
    const { assistant, select, ids } = setup();
    mockInvoke("delete_agent", () => undefined);
    await select("a", "t1");
    await select("a", "t2");
    await select("b", "t3");
    await assistant.deleteAgent("a");
    expect(ids()).toEqual(["b/t3"]);
  });

  it("removes tabs whose owner disappeared from a fresh snapshot", async () => {
    const { assistant, select, ids } = setup();
    await select("a", "t1");
    await select("b", "t2");
    mockInvoke("get_assistants_snapshot", () => ({
      agents: [agent("b")], groups: [], unreadCounts: {},
    }));
    await assistant.fetchAgentsAndGroups();
    expect(ids()).toEqual(["b/t2"]);
  });

  it("prunes topics missing from the owner's loaded list and refreshes titles", async () => {
    const { topics, select, ids, tabs } = setup();
    await select("b", "t4");
    await select("b", "t3");
    mockInvoke("get_topics_streamed", (args) => {
      (args?.onChunk as { emit: (chunk: unknown) => void }).emit([topicDto("t3", "Renamed")]);
    });
    await topics.loadTopicList("b", "agent");
    await nextTick();
    expect(ids()).toEqual(["b/t3"]);
    expect(tabs.tabs[0].title).toBe("Renamed");
  });

  it("marks background replies unread and clears on activation", async () => {
    const { topics, tabs, select } = setup();
    mockInvoke("increment_topic_unread_count", () => ({ unreadCount: 1, updatedAt: null }));
    await select("a", "t1");
    await select("a", "t2");
    await topics.incrementTopicUnreadCount("a", "agent", "t1");
    expect(tabs.tabs[0].unread).toBe(true);
    expect(tabs.tabs[1].unread).toBe(false);

    await tabs.activateTab(tabs.tabs[0]);
    await nextTick();
    expect(tabs.tabs[0].unread).toBe(false);
  });
});
