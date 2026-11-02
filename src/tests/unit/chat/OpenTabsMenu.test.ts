import { describe, expect, it, vi } from "vitest";
import { buildTabMenuActions, type TabMenuDeps } from "@/features/chat/components/openTabsMenu";
import type { OpenTab } from "@/core/stores/openTabsStore";
import type { PromptConfig } from "@/core/types/overlay";

const tab: OpenTab = {
  ownerId: "a",
  ownerType: "agent",
  topicId: "topic_1",
  title: "旧标题",
  ownerName: "Agent a",
  avatarColor: null,
  unread: false,
};

function deps(overrides: Partial<TabMenuDeps> = {}) {
  let prompt: PromptConfig | null = null;
  const d: TabMenuDeps = {
    tabCount: 3,
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeAllTabs: vi.fn(),
    renameTab: vi.fn(async () => true),
    openPrompt: vi.fn((config: PromptConfig) => {
      prompt = config;
    }),
    copyText: vi.fn(async () => {}),
    notify: vi.fn(),
    ...overrides,
  };
  return { d, prompt: () => prompt };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("tab long-press menu", () => {
  it("mirrors VCPChat tab menu: close / close others / close all / rename / copy id", () => {
    const { d } = deps();
    const actions = buildTabMenuActions(tab, d);
    expect(actions.map((a) => a.label)).toEqual([
      "关闭标签",
      "关闭其他标签",
      "关闭全部标签",
      "重命名话题",
      "复制话题 ID",
    ]);
    actions[0].handler();
    actions[1].handler();
    actions[2].handler();
    expect(d.closeTab).toHaveBeenCalledWith(tab);
    expect(d.closeOtherTabs).toHaveBeenCalledWith(tab);
    expect(d.closeAllTabs).toHaveBeenCalledTimes(1);
  });

  it("disables close others with a single tab", () => {
    const { d } = deps({ tabCount: 1 });
    expect(buildTabMenuActions(tab, d)[1].disabled).toBe(true);
  });

  it("rename opens the existing prompt and ignores blank input", async () => {
    const { d, prompt } = deps();
    buildTabMenuActions(tab, d)[3].handler();
    expect(prompt()).toMatchObject({ title: "修改话题标题", initialValue: "旧标题" });
    prompt()!.onConfirm("   ");
    expect(d.renameTab).not.toHaveBeenCalled();
    prompt()!.onConfirm("新标题");
    expect(d.renameTab).toHaveBeenCalledWith(tab, "新标题");
  });

  it("rename failure surfaces a toast", async () => {
    const { d, prompt } = deps({ renameTab: vi.fn(async () => Promise.reject(new Error("x"))) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    buildTabMenuActions(tab, d)[3].handler();
    prompt()!.onConfirm("新标题");
    await flush();
    expect(d.notify).toHaveBeenCalledWith("error", "重命名失败", expect.any(String));
  });

  it("copy id writes the topic id and reports success or failure", async () => {
    const ok = deps();
    await buildTabMenuActions(tab, ok.d)[4].handler();
    await flush();
    expect(ok.d.copyText).toHaveBeenCalledWith("topic_1");
    expect(ok.d.notify).toHaveBeenCalledWith("info", "复制成功", "话题 ID 已复制到剪贴板");

    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = deps({ copyText: vi.fn(async () => Promise.reject(new Error("denied"))) });
    await buildTabMenuActions(tab, bad.d)[4].handler();
    await flush();
    expect(bad.d.notify).toHaveBeenCalledWith("error", "复制失败", "无法访问剪贴板");
  });
});
