import { describe, expect, it, vi, beforeEach } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { mockInvoke, clearInvokeMocks } from "@/tests/mocks/tauri";
import { mountWithPinia } from "@/tests/utils/mount";

vi.mock("@/features/chat/ChatView.vue", async () => {
  const { h } = await import("vue");
  return { default: { name: "ChatView", render: () => h("div", { "data-test": "chat-view" }) } };
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

const SHA = "a".repeat(64);
const agent = (id: string) => ({ id, name: id.toUpperCase() }) as never;
const TOPICS: Record<string, Array<{ id: string; name: string }>> = {
  a0: [{ id: "t0", name: "原话题" }],
  a1: [{ id: "t1", name: "话题一" }],
  ghost: [{ id: "tg", name: "幽灵话题" }],
};

function mockCanvasBackend(bindings: Record<string, unknown> = {}) {
  mockInvoke("canvas_local_list", () => [
    { name: "AAHS.txt", size: 4, mtime: 1, sha256: SHA, baseSha: SHA, localOnly: false },
  ]);
  mockInvoke("canvas_manifest", () => ({
    status: 200,
    body: { revision: "1-1", files: [{ path: "canvas/AAHS.txt", size: 4, mtime: 1, sha256: SHA }] },
  }));
  mockInvoke("canvas_pull", () => ({ status: 200, sha256: SHA, body: null }));
  mockInvoke("canvas_bindings_get", () => ({ status: 200, body: { revision: "r", bindings } }));
  mockInvoke("canvas_wait", () => new Promise(() => {}));
  mockInvoke("canvas_local_read", () => "# 标题\n\n**正文**");
  mockInvoke("get_topics", (args) => TOPICS[String(args?.ownerId)] ?? []);
  mockInvoke("canvas_bindings_put", () => ({ status: 200, body: { revision: "r2", key: "aahs.txt" } }));
}

async function mountCanvas() {
  const wrapper = mountWithPinia(CanvasView, {}, () => {});
  const assistants = useAssistantStore();
  assistants.agents = [agent("a0"), agent("a1")];
  const session = useChatSessionStore();
  await session.selectTopicById("a0", "agent", "t0");
  await flushPromises();
  await wrapper.find("ul button").trigger("click");
  await flushPromises();
  return { wrapper, session, assistants };
}

const tab = (wrapper: ReturnType<typeof mountWithPinia>, label: string) =>
  wrapper.findAll('[role="tab"]').find((node) => node.text() === label)!;
const button = (wrapper: ReturnType<typeof mountWithPinia>, text: string) =>
  wrapper.findAll("button").find((b) => b.text().includes(text))!;

describe("Canvas 文稿预览", () => {
  beforeEach(() => {
    clearInvokeMocks();
    mockCanvasBackend();
  });

  it(".txt 按 Markdown 渲染（对齐电脑端 isArticleDocument）", async () => {
    const { wrapper } = await mountCanvas();
    expect(wrapper.find(".canvas-markdown strong").text()).toBe("正文");
    wrapper.unmount();
  });
});

describe("Canvas [对话] 流程", () => {
  beforeEach(() => {
    clearInvokeMocks();
    mockCanvasBackend();
  });

  it("无绑定时默认预选当前会话；改选话题后显示 ChatView，回到 [文稿] 恢复原标签", async () => {
    const { wrapper, session } = await mountCanvas();
    await tab(wrapper, "对话").trigger("click");
    await flushPromises();
    const ownerSelect = wrapper.find('select[aria-label="选择 Agent 或群"]');
    const topicSelect = wrapper.find('select[aria-label="选择话题"]');
    expect((ownerSelect.element as HTMLSelectElement).value).toBe("agent:a0");
    expect((topicSelect.element as HTMLSelectElement).value).toBe("t0");

    await ownerSelect.setValue("agent:a1");
    await flushPromises();
    await topicSelect.setValue("t1");
    await button(wrapper, "关联并打开").trigger("click");
    await flushPromises();

    expect(wrapper.text()).not.toContain("正在切换");
    expect(wrapper.find('[data-test="chat-view"]').exists()).toBe(true);
    expect(session.currentConversationKey).toMatchObject({ ownerId: "a1", topicId: "t1" });

    await tab(wrapper, "文稿").trigger("click");
    await flushPromises();
    expect(session.currentConversationKey).toMatchObject({ ownerId: "a0", topicId: "t0" });
    wrapper.unmount();
  });

  it("绑定的 owner 不在手机上：显示原因与重试，补齐后重试成功", async () => {
    clearInvokeMocks();
    mockCanvasBackend({ "aahs.txt": { agentId: "ghost", topicId: "tg", itemType: "agents" } });
    const { wrapper, session, assistants } = await mountCanvas();
    await tab(wrapper, "对话").trigger("click");
    await flushPromises();

    expect(wrapper.text()).not.toContain("正在切换");
    expect(wrapper.find('[role="alert"]').text()).toContain("手机上没有 Agent 「ghost」");
    expect(wrapper.find('[data-test="chat-view"]').exists()).toBe(false);

    assistants.agents = [agent("a0"), agent("a1"), agent("ghost")];
    await button(wrapper, "重试").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="chat-view"]').exists()).toBe(true);
    expect(session.currentConversationKey).toMatchObject({ ownerId: "ghost", ownerType: "agent", topicId: "tg" });
    wrapper.unmount();
  });
});
