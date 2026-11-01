import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatHistoryStore } from "@/core/stores/chatHistoryStore";
import { useChatSessionStore } from "@/core/stores/chatSessionStore";
import { useSettingsStore } from "@/core/stores/settings";
import { useAttachmentStore } from "@/core/stores/attachmentStore";
import { useNotificationStore } from "@/core/stores/notification";
import { invokeMock, mockInvoke } from "@/tests/mocks/tauri";
import type { Attachment } from "@/core/types/chat";

const done = (name: string): Attachment => ({
  id: `att_${name}`,
  type: "image/png",
  name,
  size: 10,
  src: `/attachments/${name}`,
  hash: `h_${name}`,
  status: "done",
});

const failedCard = (name: string): Attachment => ({
  id: `att_${name}`,
  type: "image/png",
  name,
  size: 0,
  src: "",
  status: "failed",
  failReason: "copy failed",
});

const appendedMessage = () =>
  invokeMock.mock.calls.find(([command]) => command === "append_single_message")?.[1]?.message as
    | { attachments?: Attachment[] }
    | undefined;

describe("sendMessage skips failed attachment cards", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    mockInvoke("get_active_generations", () => []);
    mockInvoke("load_chat_history", () => []);
    mockInvoke("append_single_message", () => ({ blocks: [], topicUpdatedAt: 1 }));
    mockInvoke("handle_agent_chat_message", () => null);
    useSettingsStore().settings = {
      userName: "User",
      vcpServerUrl: "https://example.invalid",
      vcpApiKey: "key",
    } as any;
    useChatSessionStore().setConversation({ id: "agent-a", type: "agent" }, "topic-a");
    await useChatHistoryStore().loadHistoryPaginated("agent-a", "agent", "topic-a");
  });

  it("sends only ready attachments and clears failed cards with a light hint", async () => {
    const attachments = useAttachmentStore();
    const notify = vi.spyOn(useNotificationStore(), "addNotification");
    attachments.stagedAttachments.push(failedCard("b.png"), done("a.png"), failedCard("c.png"));

    await useChatHistoryStore().sendMessage("看图");

    const sent = appendedMessage();
    expect(sent?.attachments?.map((a) => a.name)).toEqual(["a.png"]);
    expect(sent?.attachments?.[0].attachmentOrder).toBe(0);
    expect(sent?.attachments?.some((a) => a.status === "failed" || a.src === "")).toBe(false);
    expect(attachments.stagedAttachments).toHaveLength(0);
    const hint = notify.mock.calls.find(([n]) => n.title === "已跳过失败附件")?.[0];
    expect(hint).toMatchObject({ type: "info", toastOnly: true });
    expect(String(hint?.message)).toContain("2 个");
  });

  it("sends text alone when every staged card failed", async () => {
    const attachments = useAttachmentStore();
    attachments.stagedAttachments.push(failedCard("b.png"));

    await useChatHistoryStore().sendMessage("只有文字");

    expect(appendedMessage()?.attachments).toBeUndefined();
  });

  it("does not send when only failed cards and no text remain", async () => {
    const attachments = useAttachmentStore();
    attachments.stagedAttachments.push(failedCard("b.png"));

    await useChatHistoryStore().sendMessage("   ");

    expect(appendedMessage()).toBeUndefined();
    expect(attachments.stagedAttachments).toHaveLength(1);
  });

  it("still waits for loading cards even when a failed card is present", async () => {
    const attachments = useAttachmentStore();
    attachments.stagedAttachments.push(failedCard("b.png"), { ...done("a.png"), status: "loading" });

    await useChatHistoryStore().sendMessage("等一下");

    expect(appendedMessage()).toBeUndefined();
    expect(attachments.stagedAttachments).toHaveLength(2);
  });

  it("emits no hint when nothing was skipped", async () => {
    const attachments = useAttachmentStore();
    const notify = vi.spyOn(useNotificationStore(), "addNotification");
    attachments.stagedAttachments.push(done("a.png"));

    await useChatHistoryStore().sendMessage("正常发送");

    expect(appendedMessage()?.attachments?.map((a) => a.name)).toEqual(["a.png"]);
    expect(notify.mock.calls.some(([n]) => n.title === "已跳过失败附件")).toBe(false);
  });
});
