import { describe, expect, it, vi, beforeEach } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { mockInvoke, clearInvokeMocks } from "@/tests/mocks/tauri";
import { mockChatNavigation } from "@/tests/helpers/chatNavigation";
import { mountWithPinia } from "@/tests/utils/mount";

vi.mock("@/features/chat/ChatView.vue", async () => {
  const { h } = await import("vue");
  return {
    default: {
      name: "ChatView",
      props: { embedded: Boolean },
      render(this: { embedded: boolean }) {
        return h("div", { "data-test": "chat-view", "data-embedded": String(this.embedded) });
      },
    },
  };
});
vi.mock("vue-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-router")>()),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/core/sync/remoteChangeHint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/sync/remoteChangeHint")>()),
  hintTargetFromSettings: () => ({ baseUrl: "http://pc:5974", token: "t" }),
}));

import CanvasView from "@/features/canvas/CanvasView.vue";
import { useAssistantStore } from "@/core/stores/assistant";
import { useChatSessionStore } from "@/core/stores/chatSessionStore";
import {
  canvasTabKey,
  normalizeCanvasTabs,
  normalizeClosedTabs,
  openTabKey,
  useOpenTabsStore,
} from "@/core/stores/openTabsStore";
import { toReportTabs } from "@/core/sync/openTabsRemote";

const SHA = "a".repeat(64);
const agent = (id: string) => ({ id, name: id.toUpperCase() }) as never;
const ORIGIN = { ownerId: "a0", ownerType: "agent" as const, topicId: "t0" };

function mockBackend() {
  mockInvoke("canvas_local_list", () => [
    { name: "AAHS.txt", size: 4, mtime: 1, sha256: SHA, baseSha: SHA, localOnly: false },
  ]);
  mockInvoke("canvas_manifest", () => ({
    status: 200,
    body: { revision: "1-1", files: [{ path: "canvas/AAHS.txt", size: 4, mtime: 1, sha256: SHA }] },
  }));
  mockInvoke("canvas_pull", () => ({ status: 200, sha256: SHA, body: null }));
  mockInvoke("canvas_bindings_get", () => ({
    status: 200,
    body: { revision: "r", bindings: { "aahs.txt": { agentId: "a1", topicId: "t1", itemType: "agent" } } },
  }));
  mockInvoke("canvas_wait", () => new Promise(() => {}));
  mockInvoke("canvas_local_read", () => "# 标题");
  mockInvoke("canvas_translation_load", () => null);
  mockInvoke("get_topics", () => []);
}

describe("Canvas 标签流程", () => {
  beforeEach(() => {
    clearInvokeMocks();
    mockChatNavigation();
    mockBackend();
  });

  it("打开文稿→canvas 标签→切聊天→切回→[对话]内嵌→× 关闭回原标签→最近关闭恢复", async () => {
    const wrapper = mountWithPinia(CanvasView, {}, () => {});
    useAssistantStore().agents = [agent("a0"), agent("a1")];
    const session = useChatSessionStore();
    const tabs = useOpenTabsStore();
    await session.selectTopicById("a0", "agent", "t0");
    await tabs.openInNewTab(ORIGIN);
    await flushPromises();
    expect(tabs.tabs).toHaveLength(1);

    await wrapper.find("ul button").trigger("click");
    await flushPromises();
    expect(tabs.canvasTabs.map((t) => t.path)).toEqual(["canvas/AAHS.txt"]);
    expect(tabs.activeKey).toBe(canvasTabKey("canvas/AAHS.txt"));
    const canvasChip = () => wrapper.find('[data-tab-kind="canvas"]');
    expect(canvasChip().text()).toContain("AAHS.txt");

    await wrapper.find('[data-tab-kind="chat"] button[role="tab"]').trigger("click");
    await flushPromises();
    expect(tabs.activeCanvasPath).toBeNull();
    expect(tabs.activeKey).toBe(openTabKey(ORIGIN));

    await canvasChip().find('button[role="tab"]').trigger("click");
    await flushPromises();
    expect(tabs.activeCanvasPath).toBe("canvas/AAHS.txt");

    const segmentTab = wrapper.findAll('[role="tab"]').find((n) => n.text() === "对话")!;
    await segmentTab.trigger("click");
    await flushPromises();
    const chat = wrapper.find('[data-test="chat-view"]');
    expect(chat.exists()).toBe(true);
    expect(chat.attributes("data-embedded")).toBe("true");
    expect(session.currentConversationKey).toMatchObject({ ownerId: "a1", topicId: "t1" });
    expect(tabs.tabs).toHaveLength(1); // 不新开聊天标签
    expect(tabs.activeKey).toBe(canvasTabKey("canvas/AAHS.txt"));
    expect(toReportTabs(tabs.tabs).map((t) => t.topicId)).toEqual(["t0"]); // canvas 不进上报

    await canvasChip().find('button[aria-label^="关闭"]').trigger("click");
    await flushPromises();
    expect(tabs.canvasTabs).toHaveLength(0);
    expect(tabs.activeKey).toBe(openTabKey(ORIGIN));
    expect(session.currentConversationKey).toMatchObject(ORIGIN);

    const closed = tabs.recentlyClosed[0];
    expect(closed).toMatchObject({ kind: "canvas", path: "canvas/AAHS.txt" });
    expect(tabs.restoreClosedCanvas("canvas/AAHS.txt")).toBe(true);
    expect(tabs.activeCanvasPath).toBe("canvas/AAHS.txt");
    expect(tabs.recentlyClosed.some((e) => e.kind === "canvas")).toBe(false);
    wrapper.unmount();
  });
});

describe("持久化兼容", () => {
  it("旧数据无 kind 按聊天标签加载；canvas 标签校验路径", () => {
    const legacy = normalizeClosedTabs([
      { ownerId: "a0", ownerType: "agent", topicId: "t0", title: "旧", closedAt: 5 },
    ]);
    expect(legacy).toEqual([expect.objectContaining({ kind: "tab", ownerId: "a0", topicId: "t0" })]);
    expect(normalizeCanvasTabs(undefined)).toEqual([]);
    expect(
      normalizeCanvasTabs([
        { kind: "canvas", path: "canvas/a.md" },
        { kind: "canvas", path: "canvas/a.md" },
        { kind: "canvas", path: "canvas/x/y.md" },
        { kind: "canvas", path: "other/a.md" },
      ]),
    ).toEqual([{ kind: "canvas", path: "canvas/a.md", name: "a.md" }]);
  });
});
