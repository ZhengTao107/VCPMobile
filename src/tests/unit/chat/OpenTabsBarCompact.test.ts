import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { useOpenTabsStore } from "@/core/stores/openTabsStore";
import OpenTabsBar from "@/features/chat/components/OpenTabsBar.vue";

vi.mock("vue-router", () => ({
  useRouter: () => ({ currentRoute: { value: { path: "/chat" } }, push: vi.fn() }),
}));
vi.mock("@/core/sync/openTabsRemote", () => ({
  useOpenTabsRemote: () => ({ remote: ref([]), release: () => undefined }),
}));

describe("ptp4g#43 OpenTabsBar compact", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("uses one size smaller chips while keeping tap targets at least 28px", async () => {
    useOpenTabsStore().tabs = [{
      ownerId: "agent-a",
      ownerType: "agent",
      topicId: "topic-a",
      title: "Alpha",
      ownerName: "A",
      avatarColor: null,
      unread: false,
    }];
    const wrapper = mount(OpenTabsBar, {
      global: {
        directives: { longpress: {} },
        stubs: { VcpAvatar: { props: ["size"], template: '<span data-testid="avatar" :data-size="size" />' }, OpenTabsPanel: true },
      },
    });
    await nextTick();

    const scroller = wrapper.get('[role="tablist"]');
    expect(scroller.classes()).toEqual(expect.arrayContaining(["py-1", "gap-1.5"]));
    expect(scroller.classes()).not.toContain("py-1.5");
    expect(wrapper.get('[data-testid="avatar"]').attributes("data-size")).toBe("w-4 h-4");

    const tab = wrapper.get('[role="tab"]');
    expect(tab.classes()).toContain("min-h-7");
    expect(tab.get("span.truncate").classes()).toContain("text-[11px]");

    const close = wrapper.get('[aria-label^="关闭"]');
    expect(close.classes()).toEqual(expect.arrayContaining(["w-7", "h-7"]));
    wrapper.unmount();
  });
});
