import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { nextTick } from "vue";
import { useAssistantStore } from "@/core/stores/assistant";
import { useChatSessionStore } from "@/core/stores/chatSessionStore";
import { useTopicStore } from "@/core/stores/topicListManager";
import {
  CLOSED_TAB_HISTORY_LIMIT,
  normalizeClosedTabs,
  useOpenTabsStore,
} from "@/core/stores/openTabsStore";
import { clearInvokeMocks, invokeMock, mockInvoke } from "@/tests/mocks/tauri";

function installPersistedPinia() {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  pinia.install({
    provide: () => undefined,
    config: { globalProperties: {} },
  } as unknown as import("vue").App);
  setActivePinia(pinia);
}

const agent = (id: string) => ({ id, name: `Agent ${id}`, avatarCalculatedColor: "#123456" });

function setup() {
  installPersistedPinia();
  const assistant = useAssistantStore();
  assistant.agents = ["a", "b"].map(agent) as any;
  assistant.groups = [];
  const session = useChatSessionStore();
  const topics = useTopicStore();
  const tabs = useOpenTabsStore();
  const open = async (ownerId: string, topicId: string) => {
    await tabs.openInNewTab({ ownerId, ownerType: "agent", topicId, title: `T ${topicId}` });
    await nextTick();
  };
  const ref = (ownerId: string, topicId: string) => ({
    ownerId,
    ownerType: "agent" as const,
    topicId,
  });
  const ids = () => tabs.tabs.map((tab) => `${tab.ownerId}/${tab.topicId}`);
  const closedIds = () => tabs.recentlyClosed.map((tab) => `${tab.ownerId}/${tab.topicId}`);
  return { session, topics, tabs, open, ref, ids, closedIds };
}

beforeEach(() => {
  localStorage.clear();
  clearInvokeMocks();
  mockInvoke("get_unread_counts", () => ({}));
});

describe("open tabs closed history", () => {
  it("records closed tabs newest first and hides ones that are open again", async () => {
    const { tabs, open, ref, closedIds } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await open("a", "t3");
    await tabs.closeTab(ref("a", "t1"));
    await tabs.closeTab(ref("a", "t2"));
    expect(closedIds()).toEqual(["a/t2", "a/t1"]);
    expect(tabs.recentlyClosed[0].title).toBe("T t2");
    expect(tabs.recentlyClosed[0].closedAt).toBeGreaterThan(0);

    await open("a", "t1");
    expect(closedIds()).toEqual(["a/t2"]);
    // 再次关闭只保留一条，且排到最前。
    await tabs.closeTab(ref("a", "t1"));
    expect(closedIds()).toEqual(["a/t1", "a/t2"]);
    expect(tabs.closedTabs).toHaveLength(2);
  });

  it("caps history at the VCPChat limit and drops malformed entries", () => {
    const raw = [
      { ownerId: "a", ownerType: "agent" },
      ...Array.from({ length: CLOSED_TAB_HISTORY_LIMIT + 20 }, (_, i) => ({
        ownerId: "a",
        ownerType: "agent",
        topicId: `t${i}`,
        title: `T${i}`,
        closedAt: 1000 + i,
      })),
    ];
    const normalized = normalizeClosedTabs(raw);
    expect(CLOSED_TAB_HISTORY_LIMIT).toBe(100);
    expect(normalized).toHaveLength(100);
    expect(normalized[0]).toMatchObject({ topicId: "t0", title: "T0", closedAt: 1000 });
  });

  it("persists history and restores it after hydration", async () => {
    const first = setup();
    await first.open("a", "t1");
    await first.open("a", "t2");
    await first.tabs.closeTab(first.ref("a", "t1"));
    await nextTick();
    const stored = JSON.parse(localStorage.getItem("openTabs") ?? "{}");
    expect(stored.closedTabs.map((t: { topicId: string }) => t.topicId)).toEqual(["t1"]);

    const second = setup();
    expect(second.tabs.closedTabs.map((t) => t.topicId)).toEqual(["t1"]);
    expect(second.tabs.closedTabs[0].title).toBe("T t1");
  });

  it("removes deleted topics and owners from history", async () => {
    const { topics, tabs, open, ref, closedIds } = setup();
    mockInvoke("delete_topic", () => null);
    const assistant = useAssistantStore();
    await open("a", "t1");
    await open("a", "t2");
    await open("b", "t3");
    await tabs.closeAllTabs();
    expect(closedIds()).toHaveLength(3);

    await topics.deleteTopic("a", "agent", "t1");
    await nextTick();
    expect(closedIds()).toEqual(["a/t2", "b/t3"]);

    mockInvoke("delete_agent", () => true);
    await assistant.deleteAgent("b").catch(() => undefined);
    await nextTick();
    expect(closedIds()).toEqual(["a/t2"]);
    expect(tabs.recentlyClosed.every((t) => t.ownerId !== "b")).toBe(true);
    void ref;
  });

  it("close others keeps and activates the target; close all records everything", async () => {
    const { session, tabs, open, ref, ids, closedIds } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await open("a", "t3");
    await tabs.activateTab(ref("a", "t1"));
    await tabs.closeOtherTabs(ref("a", "t2"));
    expect(ids()).toEqual(["a/t2"]);
    expect(session.currentTopicId).toBe("t2");
    expect(closedIds().sort()).toEqual(["a/t1", "a/t3"]);

    tabs.closeAllTabs();
    expect(ids()).toEqual([]);
    expect(closedIds()[0]).toBe("a/t2");
  });

  it("rename goes through topicStore.updateTopicTitle and updates the tab title", async () => {
    const { tabs, open, ref } = setup();
    mockInvoke("update_topic_title", () => 123);
    await open("a", "t1");
    expect(await tabs.renameTab(ref("a", "t1"), "  新标题 ")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "update_topic_title",
      expect.objectContaining({ ownerId: "a", ownerType: "agent", topicId: "t1", title: "新标题" }),
    );
    expect(tabs.tabs[0].title).toBe("新标题");
    expect(await tabs.renameTab(ref("a", "t1"), "   ")).toBe(false);
  });
});
