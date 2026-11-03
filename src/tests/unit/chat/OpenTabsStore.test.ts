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

const keyOf = (ownerId: string, topicId: string) =>
  openTabKey({ ownerId, ownerType: "agent", topicId });

function setup(agentIds = ["a", "b"]) {
  installPersistedPinia();
  const assistant = useAssistantStore();
  assistant.agents = agentIds.map(agent) as any;
  assistant.groups = [];
  const session = useChatSessionStore();
  const topics = useTopicStore();
  const tabs = useOpenTabsStore();
  /** 普通点击话题（TopicList 的行为）。 */
  const select = async (ownerId: string, topicId: string) => {
    await session.selectTopicById(ownerId, "agent", topicId);
    await nextTick();
  };
  /** 「在新标签页打开」。 */
  const open = async (ownerId: string, topicId: string) => {
    await tabs.openInNewTab({ ownerId, ownerType: "agent", topicId });
    await nextTick();
  };
  const ids = () => tabs.tabs.map((tab) => `${tab.ownerId}/${tab.topicId}`);
  return { assistant, session, topics, tabs, select, open, ids };
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
  it("plain selection replaces the active tab in place and never adds tabs", async () => {
    const { tabs, select, open, ids } = setup();
    await select("a", "t1");
    expect(ids()).toEqual(["a/t1"]);

    await select("a", "t2");
    expect(ids()).toEqual(["a/t2"]);

    await open("a", "t3");
    expect(ids()).toEqual(["a/t2", "a/t3"]);

    // 替换当前槽位（t3），保留其位置。
    await select("b", "t1");
    expect(ids()).toEqual(["a/t2", "b/t1"]);
    expect(tabs.activeTabKey).toBe(keyOf("b", "t1"));
    expect(tabs.tabs[1].ownerName).toBe("Agent b");
  });

  it("selecting an already open topic only switches to it", async () => {
    const { tabs, select, open, ids } = setup();
    await select("a", "t1");
    await open("a", "t2");
    await select("a", "t1");
    expect(ids()).toEqual(["a/t1", "a/t2"]);
    expect(tabs.activeKey).toBe(keyOf("a", "t1"));
    expect(tabs.activeTabKey).toBe(keyOf("a", "t1"));
  });

  it("openInNewTab inserts right of the active tab and activates; existing tab just switches", async () => {
    const { session, tabs, open, ids } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await open("a", "t3");
    expect(ids()).toEqual(["a/t1", "a/t2", "a/t3"]);

    await tabs.activateTab(tabs.tabs[0]);
    await nextTick();
    await open("a", "t4");
    expect(ids()).toEqual(["a/t1", "a/t4", "a/t2", "a/t3"]);
    expect(session.currentTopicId).toBe("t4");
    expect(tabs.activeTabKey).toBe(keyOf("a", "t4"));

    await open("a", "t3");
    expect(ids()).toHaveLength(4);
    expect(session.currentTopicId).toBe("t3");
  });

  it("does not cap the number of explicitly opened tabs and reorders", async () => {
    const { tabs, open, ids } = setup();
    for (let i = 0; i < 9; i += 1) await open("a", `t${i}`);
    expect(tabs.tabs).toHaveLength(9);
    tabs.moveTab(0, 8);
    expect(ids()[8]).toBe("a/t0");
    expect(ids()[0]).toBe("a/t1");
  });

  it("closing the active tab switches to its neighbour", async () => {
    const { session, tabs, open, select, ids } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await open("a", "t3");
    await tabs.activateTab(tabs.tabs[1]);
    await nextTick();

    await tabs.closeTab(tabs.tabs[1]);
    await nextTick();
    expect(ids()).toEqual(["a/t1", "a/t3"]);
    expect(session.currentTopicId).toBe("t3");
    expect(tabs.activeTabKey).toBe(keyOf("a", "t3"));

    // 关闭非当前标签不切换；随后的普通选择仍替换当前槽位。
    await tabs.closeTab(tabs.tabs[0]);
    expect(session.currentTopicId).toBe("t3");
    await select("a", "t9");
    expect(ids()).toEqual(["a/t9"]);
  });

  it("+ creates a new topic for the owner and opens it in a new tab", async () => {
    const { session, tabs, select, ids } = setup();
    mockInvoke("create_topic", () => topicDto("new1", "新话题"));
    mockInvoke("get_topics_streamed", (args) => {
      (args?.onChunk as { emit: (chunk: unknown) => void }).emit([
        topicDto("t1"),
        topicDto("new1", "新话题"),
      ]);
    });
    await select("a", "t1");

    const topicId = await tabs.openNewEmptyTab("agent", "a");
    await nextTick();
    expect(topicId).toBe("new1");
    expect(session.currentTopicId).toBe("new1");
    await vi.waitFor(() => expect(ids()).toEqual(["a/t1", "a/new1"]));
    expect(tabs.activeTabKey).toBe(keyOf("a", "new1"));
  });

  it("round-trips through persistence and drops corrupt entries", async () => {
    const first = setup();
    await first.open("a", "t1");
    await first.open("b", "t2");
    await vi.waitFor(() => expect(localStorage.getItem("openTabs")).toContain("t2"));

    const stored = JSON.parse(localStorage.getItem("openTabs")!);
    expect(stored.activeTabKey).toBe(keyOf("b", "t2"));
    stored.tabs.push({ ownerId: "", ownerType: "agent", topicId: "x" });
    stored.tabs.push({ ownerId: "a", ownerType: "bogus", topicId: "y" });
    stored.tabs.push({ ...stored.tabs[0] });
    localStorage.setItem("openTabs", JSON.stringify(stored));

    const second = setup();
    expect(second.ids()).toEqual(["a/t1", "b/t2"]);
    expect(second.tabs.activeTabKey).toBe(keyOf("b", "t2"));
  });

  it("restores legacy persisted tabs without activeTabKey from the current conversation", async () => {
    const legacyTab = (topicId: string) => ({
      ownerId: "a", ownerType: "agent", topicId, title: topicId,
      ownerName: "Agent a", avatarColor: null, unread: false,
    });
    localStorage.setItem("openTabs", JSON.stringify({
      tabs: [legacyTab("t1"), legacyTab("t2"), legacyTab("t3")],
    }));
    localStorage.setItem("chatSession", JSON.stringify({
      currentSelectedItem: { ...agent("a"), type: "agent" },
      currentTopicId: "t2",
      lastActiveTopicMap: {},
    }));

    const { tabs, select, ids } = setup();
    expect(ids()).toEqual(["a/t1", "a/t2", "a/t3"]);
    expect(tabs.activeTabKey).toBe(keyOf("a", "t2"));

    await select("a", "t9");
    expect(ids()).toEqual(["a/t1", "a/t9", "a/t3"]);
  });

  it("normalizes untrusted values", () => {
    expect(normalizeOpenTabs(null)).toEqual([]);
    expect(normalizeOpenTabs([{ ownerId: "a", ownerType: "group", topicId: "t" }])).toEqual([
      { ownerId: "a", ownerType: "group", topicId: "t", title: "t", ownerName: "", avatarColor: null, unread: false },
    ]);
  });

  it("removes tabs when a topic is deleted", async () => {
    const { topics, open, ids } = setup();
    mockInvoke("delete_topic", () => null);
    await open("a", "t1");
    await open("b", "t2");
    await topics.deleteTopic("a", "agent", "t1");
    expect(ids()).toEqual(["b/t2"]);
  });

  it("removes every tab of a deleted owner", async () => {
    const { assistant, open, ids } = setup();
    mockInvoke("delete_agent", () => undefined);
    await open("a", "t1");
    await open("a", "t2");
    await open("b", "t3");
    await assistant.deleteAgent("a");
    expect(ids()).toEqual(["b/t3"]);
  });

  it("removes tabs whose owner disappeared from a fresh snapshot", async () => {
    const { assistant, open, ids } = setup();
    await open("a", "t1");
    await open("b", "t2");
    mockInvoke("get_assistants_snapshot", () => ({
      agents: [agent("b")], groups: [], unreadCounts: {},
    }));
    await assistant.fetchAgentsAndGroups();
    expect(ids()).toEqual(["b/t2"]);
  });

  it("prunes topics missing from the owner's loaded list and refreshes titles", async () => {
    const { topics, open, ids, tabs } = setup();
    await open("b", "t4");
    await open("b", "t3");
    mockInvoke("get_topics_streamed", (args) => {
      (args?.onChunk as { emit: (chunk: unknown) => void }).emit([topicDto("t3", "Renamed")]);
    });
    await topics.loadTopicList("b", "agent");
    await nextTick();
    expect(ids()).toEqual(["b/t3"]);
    expect(tabs.tabs[0].title).toBe("Renamed");
  });

  it("marks background replies unread and clears on activation", async () => {
    const { topics, tabs, open } = setup();
    mockInvoke("increment_topic_unread_count", () => ({ unreadCount: 1, updatedAt: null }));
    await open("a", "t1");
    await open("a", "t2");
    await topics.incrementTopicUnreadCount("a", "agent", "t1");
    expect(tabs.tabs[0].unread).toBe(true);
    expect(tabs.tabs[1].unread).toBe(false);

    await tabs.activateTab(tabs.tabs[0]);
    await nextTick();
    expect(tabs.tabs[0].unread).toBe(false);
  });
});
