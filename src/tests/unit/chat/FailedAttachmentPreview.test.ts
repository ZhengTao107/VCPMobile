import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import AttachmentPreviewBase from "@/features/chat/attachment/AttachmentPreviewBase.vue";
import type { Attachment } from "@/core/types/chat";

const card = (over: Partial<Attachment> = {}): Attachment => ({
  id: "att_1",
  type: "image/png",
  name: "b.png",
  size: 10,
  src: "",
  ...over,
});

describe("AttachmentPreviewBase failed state", () => {
  it("shows a red badge and reveals the reason on tap", async () => {
    const wrapper = mount(AttachmentPreviewBase, {
      props: { file: card({ status: "failed", failReason: "copy failed" }), index: 2, showRemove: true },
    });

    expect(wrapper.find('[data-testid="attachment-failed-badge"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="attachment-fail-reason"]').exists()).toBe(false);

    await wrapper.find('[data-testid="attachment-failed"]').trigger("click");

    expect(wrapper.find('[data-testid="attachment-fail-reason"]').text()).toBe("copy failed");
    expect(wrapper.find('[data-testid="attachment-failed"]').attributes("aria-expanded")).toBe("true");
  });

  it("emits remove with its index from the expanded remove button", async () => {
    // 本仓测试跑 Vue 生产构建，wrapper.emitted() 不记录（原删除按钮同样为空），改断言 props handler
    const onRemove = vi.fn();
    const wrapper = mount(AttachmentPreviewBase, {
      props: { file: card({ status: "failed", failReason: "io" }), index: 2, showRemove: true, onRemove },
    });

    await wrapper.find('[data-testid="attachment-failed"]').trigger("click");
    await wrapper.find('[data-testid="attachment-fail-remove"]').trigger("click");

    expect(onRemove.mock.calls).toEqual([[2]]);
    // 移除按钮 click.stop：不会顺带把原因收起
    expect(wrapper.find('[data-testid="attachment-fail-reason"]').exists()).toBe(true);
  });

  it("falls back to a generic reason when none is recorded", async () => {
    const wrapper = mount(AttachmentPreviewBase, {
      props: { file: card({ status: "failed" }), index: 0 },
    });
    await wrapper.find('[data-testid="attachment-failed"]').trigger("click");
    expect(wrapper.find('[data-testid="attachment-fail-reason"]').text()).toBe("处理失败");
  });

  it("renders no failed decoration for normal cards", () => {
    const wrapper = mount(AttachmentPreviewBase, {
      props: { file: card({ status: "done", src: "/attachments/b.png" }), index: 0, showRemove: true },
    });
    expect(wrapper.find('[data-testid="attachment-failed-badge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="attachment-failed"]').exists()).toBe(false);
  });
});
