import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import GroupAvatar from "@/features/agent/GroupAvatar.vue";
import VcpAvatar from "@/components/ui/VcpAvatar.vue";
import { useAssistantStore } from "@/core/stores/assistant";
import { useAvatarStore } from "@/core/stores/avatar";
import { collageInitials, pickGroupCollageMembers } from "@/features/agent/groupCollage";

const agents = [
  { id: "a1", name: "Nova", model: "m", avatarCalculatedColor: null },
  { id: "a2", name: "小雪", model: "m", avatarCalculatedColor: null },
  { id: "a3", name: "小科", model: "m", avatarCalculatedColor: null },
  { id: "a4", name: "小信", model: "m", avatarCalculatedColor: null },
  { id: "a5", name: "小写", model: "m", avatarCalculatedColor: null },
];

const mountGroupAvatar = (members: string[]) =>
  mount(GroupAvatar, {
    props: { groupId: "g1", groupName: "GSEM", members },
    global: { stubs: { VcpAvatar: true } },
  });

describe("pickGroupCollageMembers (VCPChat itemListManager parity)", () => {
  it("keeps member order, skips missing agents and caps at 4", () => {
    const picked = pickGroupCollageMembers(["gone", "a3", "a1", "a2", "a4", "a5"], agents);
    expect(picked.map((m) => m.id)).toEqual(["a3", "a1", "a2", "a4"]);
  });

  it("returns empty for absent or empty member lists", () => {
    expect(pickGroupCollageMembers(undefined, agents)).toEqual([]);
    expect(pickGroupCollageMembers([], agents)).toEqual([]);
    expect(pickGroupCollageMembers(["gone"], agents)).toEqual([]);
  });

  it("uses the first two characters upper-cased as initials", () => {
    expect(collageInitials("nova")).toBe("NO");
    expect(collageInitials(" 小雪 ")).toBe("小雪");
    expect(collageInitials("")).toBe("?");
  });
});

describe("GroupAvatar", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useAssistantStore().agents = agents;
  });

  it("shows the group's own avatar when one is synced", () => {
    useAvatarStore().metadata.set("group:g1", { avatarHash: "h", updatedAt: 1 });
    const wrapper = mountGroupAvatar(["a1", "a2"]);
    const avatars = wrapper.findAllComponents(VcpAvatar);
    expect(avatars).toHaveLength(1);
    expect(avatars[0].props()).toMatchObject({ ownerType: "group", ownerId: "g1" });
    expect(wrapper.find(".group-avatar-collage").exists()).toBe(false);
  });

  it("falls back to a member collage like VCPChat when no group avatar exists", () => {
    const wrapper = mountGroupAvatar(["a1", "a2", "a3", "a4", "a5"]);
    const collage = wrapper.find(".group-avatar-collage");
    expect(collage.exists()).toBe(true);
    expect(collage.attributes("data-count")).toBe("4");
    const cells = wrapper.findAllComponents(VcpAvatar);
    expect(cells.map((c) => c.props("ownerType"))).toEqual(["agent", "agent", "agent", "agent"]);
    expect(cells.map((c) => c.props("ownerId"))).toEqual(["a1", "a2", "a3", "a4"]);
    expect(cells[0].props("fallbackText")).toBe("NO");
  });

  it("uses the single-initial group placeholder when no member is resolvable", () => {
    const wrapper = mountGroupAvatar(["gone"]);
    const avatars = wrapper.findAllComponents(VcpAvatar);
    expect(avatars).toHaveLength(1);
    expect(avatars[0].props()).toMatchObject({ ownerType: "group", ownerId: "g1", fallbackName: "GSEM" });
  });
});

describe("VcpAvatar fallbackText", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("renders the override text instead of the first initial", () => {
    const wrapper = mount(VcpAvatar, {
      props: { ownerType: "agent", ownerId: "a1", fallbackName: "Nova", fallbackText: "NO", fallbackTextClass: "text-[8px]" },
      global: { directives: { "intersection-observer": {} } },
    });
    expect(wrapper.text()).toBe("NO");
    expect(wrapper.find(".text-\\[8px\\]").exists()).toBe(true);
  });
});
