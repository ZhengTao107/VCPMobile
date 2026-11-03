import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import { flushPromises, mount } from "@vue/test-utils";

const fixture = vi.hoisted(() => {
  const dir = "UserData/a1/topics/sidechat_1_aa";
  const files: Record<string, string> = {
    [`${dir}/sidechat-child.json`]: JSON.stringify({
      agentId: "a1",
      topicId: "sidechat_1_aa",
      parentTopicId: "topic_p1",
      createdAt: 100,
    }),
    [`${dir}/history.json`]: JSON.stringify([
      { id: "m1", role: "user", content: "**你好**", timestamp: 1 },
      { id: "m2", role: "assistant", name: "小雪", content: "收到", timestamp: 2 },
    ]),
  };
  return {
    listLocal: async () => Object.keys(files).map((path) => ({ path, size: files[path].length })),
    readLocal: async (path: string) => {
      if (!(path in files)) throw new Error("NOT_FOUND");
      return files[path];
    },
  };
});

vi.mock("vue-router", () => ({
  useRoute: () => ({ query: { parentTopicId: "topic_p1", title: "父话题" } }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/core/sync/sidechatRemote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/sync/sidechatRemote")>();
  return { ...actual, requestSidechatSync: vi.fn(async () => null), sidechatLocal: fixture };
});

describe("SidechatView", () => {
  it("列出子话题并只读渲染消息", async () => {
    const { default: SidechatView } = await import("@/features/sidechat/SidechatView.vue");
    const wrapper = mount(SidechatView);
    await flushPromises();
    const items = wrapper.findAll('[data-testid="sidechat-child"]');
    expect(items).toHaveLength(1);
    await items[0].trigger("click");
    await flushPromises();
    const messages = wrapper.findAll('[data-testid="sidechat-message"]');
    expect(messages).toHaveLength(2);
    expect(messages[0].html()).toContain("<strong>你好</strong>");
  });
});
