import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { nextTick } from "vue";
import { useAssistantStore } from "@/core/stores/assistant";
import { useChatSessionStore } from "@/core/stores/chatSessionStore";
import { useTopicStore } from "@/core/stores/topicListManager";
import {
  CLOSED_BATCH_TAB_LIMIT,
  CLOSED_TAB_HISTORY_LIMIT,
  normalizeClosedTabs,
  useOpenTabsStore,
  type ClosedHistoryEntry,
  type RecentlyClosedEntry,
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

/** 单条记为 "a/t1"，批次记为 "[a/t1,a/t2]"。 */
const describeEntry = (entry: RecentlyClosedEntry | ClosedHistoryEntry) =>
  entry.kind === "batch"
    ? `[${entry.tabs.map((tab) => `${tab.ownerId}/${tab.topicId}`).join(",")}]`
    : `${entry.ownerId}/${entry.topicId}`;

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
  const closed = () => tabs.recentlyClosed.map(describeEntry);
  const batchId = () => {
    const entry = tabs.recentlyClosed.find((item) => item.kind === "batch");
    if (!entry || entry.kind !== "batch") throw new Error("no batch");
    return entry.id;
  };
  return { assistant, session, topics, tabs, open, ref, ids, closed, batchId };
}

beforeEach(() => {
  localStorage.clear();
  clearInvokeMocks();
  mockInvoke("get_unread_counts", () => ({}));
});

describe("closed history: single entries", () => {
  it("records single closes newest first and hides ones that are open again", async () => {
    const { tabs, open, ref, closed } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await open("a", "t3");
    await tabs.closeTab(ref("a", "t1"));
    await tabs.closeTab(ref("a", "t2"));
    expect(closed()).toEqual(["a/t2", "a/t1"]);
    expect(tabs.recentlyClosed[0]).toMatchObject({ kind: "tab", title: "T t2" });

    await open("a", "t1");
    expect(closed()).toEqual(["a/t2"]);
    await tabs.closeTab(ref("a", "t1"));
    expect(closed()).toEqual(["a/t1", "a/t2"]);
    expect(tabs.closedTabs).toHaveLength(2);
  });

  it("restoreClosed reopens and removes the entry", async () => {
    const { tabs, open, ref, ids, closed } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await tabs.closeTab(ref("a", "t1"));
    expect(await tabs.restoreClosed(ref("a", "t1"))).toBe(true);
    expect(ids()).toContain("a/t1");
    expect(closed()).toEqual([]);
    expect(tabs.closedTabs).toHaveLength(0);
  });
});

describe("closed history: batches", () => {
  it("close others / close all record one batch each; single close stays single", async () => {
    const { session, tabs, open, ref, ids, closed } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await open("a", "t3");
    await tabs.activateTab(ref("a", "t1"));
    await tabs.closeOtherTabs(ref("a", "t2"));
    expect(ids()).toEqual(["a/t2"]);
    expect(session.currentTopicId).toBe("t2");
    expect(closed()).toEqual(["[a/t1,a/t3]"]);
    const batch = tabs.recentlyClosed[0];
    expect(batch.kind === "batch" && batch.title).toBe("关闭了 2 个标签");

    tabs.closeAllTabs();
    // 只剩一个标签时「关闭全部」等同单个关闭。
    expect(closed()).toEqual(["a/t2", "[a/t1,a/t3]"]);
  });

  it("hides open children, retitles partial batches and drops fully reopened ones", async () => {
    const { tabs, open, closed } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await open("a", "t3");
    tabs.closeAllTabs();
    expect(closed()).toEqual(["[a/t1,a/t2,a/t3]"]);
    await open("a", "t1");
    expect(closed()).toEqual(["[a/t2,a/t3]"]);
    const view = tabs.recentlyClosed[0];
    expect(view.kind === "batch" && view.title).toBe("关闭了 2 个标签");
    await open("a", "t2");
    await open("a", "t3");
    expect(closed()).toEqual([]);
    // 存储里的批次本身不被改动，再次关闭后又会出现。
    expect(tabs.closedTabs).toHaveLength(1);
  });

  it("restores a whole batch in order, activates the first and skips missing owners", async () => {
    const { session, tabs, ids, closed, batchId } = setup();
    tabs.closedTabs = normalizeClosedTabs([
      {
        kind: "batch",
        id: "batch-x",
        closedAt: 5,
        tabs: [
          { ownerId: "a", ownerType: "agent", topicId: "t1", title: "一" },
          { ownerId: "zz", ownerType: "agent", topicId: "t9", title: "消失的" },
          { ownerId: "b", ownerType: "agent", topicId: "t2", title: "二" },
        ],
      },
    ]);
    expect(batchId()).toBe("batch-x");
    const result = await tabs.restoreClosedBatch("batch-x");
    expect(result).toEqual({ opened: 2, skipped: 1, activated: true });
    expect(ids()).toEqual(["a/t1", "b/t2"]);
    expect(session.currentTopicId).toBe("t1");
    expect(closed()).toEqual(["[zz/t9]"]);
  });

  it("restores a single child and keeps the rest of the batch", async () => {
    const { tabs, open, ref, ids, closed, batchId } = setup();
    await open("a", "t1");
    await open("a", "t2");
    await open("a", "t3");
    tabs.closeAllTabs();
    expect(await tabs.restoreClosedBatchChild(batchId(), ref("a", "t2"))).toBe(true);
    expect(ids()).toEqual(["a/t2"]);
    expect(closed()).toEqual(["[a/t1,a/t3]"]);
    expect(await tabs.restoreClosedBatchChild("missing", ref("a", "t1"))).toBe(false);
  });

  it("prunes deleted topics and owners from batches", async () => {
    const { assistant, topics, tabs, open, closed } = setup();
    mockInvoke("delete_topic", () => null);
    await open("a", "t1");
    await open("a", "t2");
    await open("b", "t3");
    tabs.closeAllTabs();
    await topics.deleteTopic("a", "agent", "t1");
    await nextTick();
    expect(closed()).toEqual(["[a/t2,b/t3]"]);

    mockInvoke("delete_agent", () => true);
    await assistant.deleteAgent("b").catch(() => undefined);
    await nextTick();
    expect(closed()).toEqual(["[a/t2]"]);
    await topics.deleteTopic("a", "agent", "t2");
    await nextTick();
    expect(tabs.closedTabs).toHaveLength(0);
  });
});

describe("closed history: normalize and persistence", () => {
  it("caps at the VCPChat limits, keeps legacy entries and drops malformed batches", () => {
    const singles = Array.from({ length: CLOSED_TAB_HISTORY_LIMIT + 20 }, (_, i) => ({
      ownerId: "a",
      ownerType: "agent",
      topicId: `t${i}`,
      title: `T${i}`,
      closedAt: 1000 + i,
    }));
    const normalized = normalizeClosedTabs([{ ownerId: "a", ownerType: "agent" }, ...singles]);
    expect(CLOSED_TAB_HISTORY_LIMIT).toBe(100);
    expect(normalized).toHaveLength(100);
    expect(normalized[0]).toMatchObject({ kind: "tab", topicId: "t0", closedAt: 1000 });

    const child = (topicId: string) => ({ ownerId: "a", ownerType: "agent", topicId });
    const batches = normalizeClosedTabs([
      { kind: "batch", id: "ok", closedAt: 7, tabs: [child("t1"), child("t1"), child("t2")] },
      { kind: "batch", id: "ok", closedAt: 8, tabs: [child("t3")] },
      { kind: "batch", id: "empty", tabs: [] },
      { kind: "batch", id: "", tabs: [child("t4")] },
      {
        kind: "batch",
        id: "huge",
        tabs: Array.from({ length: CLOSED_BATCH_TAB_LIMIT + 1 }, (_, i) => child(`h${i}`)),
      },
    ]);
    expect(batches.map(describeEntry)).toEqual(["[a/t1,a/t2]"]);
    expect(batches[0].kind === "batch" && batches[0].tabs[0].closedAt).toBe(7);
  });

  it("persists singles and batches and restores them after hydration", async () => {
    const first = setup();
    await first.open("a", "t1");
    await first.open("a", "t2");
    await first.open("a", "t3");
    await first.tabs.closeTab(first.ref("a", "t3"));
    first.tabs.closeAllTabs();
    await nextTick();
    const stored = JSON.parse(localStorage.getItem("openTabs") ?? "{}");
    expect(stored.closedTabs.map((entry: { kind: string }) => entry.kind)).toEqual(["batch", "tab"]);

    const second = setup();
    expect(second.tabs.closedTabs.map(describeEntry)).toEqual(["[a/t1,a/t2]", "a/t3"]);
  });
});

describe("rename", () => {
  it("goes through topicStore.updateTopicTitle and updates the tab title", async () => {
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
