/**
 * 子话题发送（ptp4g#46）：Rust sidechat_send 负责上下文装配、请求与 history.json 落盘；
 * 这里只把同一条 StreamEvent 通道交给 chatStreamStore 消费，并在 durable end 后补一轮子话题同步。
 * 生成跨页面存活（与主聊一致）：切走或关闭页面不取消请求，状态记在模块级 sidechatSending。
 */
import { reactive } from "vue";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useChatStreamStore } from "../../core/stores/chatStreamStore";
import { useSettingsStore } from "../../core/stores/settings";
import { SETTINGS_DEFAULTS } from "../../core/config/generated/defaults";
import {
  requestSidechatSync,
  setSidechatBusy,
  type SidechatChild,
  type SidechatMessage,
} from "../../core/sync/sidechatRemote";
import type { StreamEventDto } from "../../core/types/chat";

/** 子话题目录 → 正在生成的助手消息 id（thinking 到达前为空串）。 */
export const sidechatSending = reactive(new Map<string, string>());

export type SidechatSendResult = "sent" | "busy" | "empty";

export async function sendSidechatMessage(
  child: SidechatChild,
  text: string,
  hooks: { onUser?: (message: SidechatMessage) => void } = {},
): Promise<SidechatSendResult> {
  const content = text.trim();
  if (!content) return "empty";
  if (sidechatSending.has(child.dir)) return "busy";
  sidechatSending.set(child.dir, "");
  setSidechatBusy(child.dir, true);

  const stream = useChatStreamStore();
  const settings = useSettingsStore();
  const now = Date.now();
  const userMessage: SidechatMessage = {
    id: `msg_${now}_${Math.random().toString(16).slice(2, 10)}`,
    role: "user",
    name: settings.settings?.identity.userName ?? SETTINGS_DEFAULTS.identity.userName,
    content,
    timestamp: now,
  };
  hooks.onUser?.(userMessage);

  let durableEnd = false;
  const channel = new Channel<StreamEventDto>();
  channel.onmessage = (event) => {
    if (event.messageId && event.type !== "request_activity" && sidechatSending.get(child.dir) === "") {
      sidechatSending.set(child.dir, event.messageId);
    }
    if (event.type === "end" && event.finishReason !== "error") durableEnd = true;
    void stream.processStreamEvent(event);
  };

  try {
    await invoke("sidechat_send", {
      payload: { dir: child.dir, agentId: child.agentId, userMessage },
      streamChannel: channel,
    });
  } finally {
    sidechatSending.delete(child.dir);
    setSidechatBusy(child.dir, false);
  }
  // Rust 在落盘后才发 end，且返回前释放生成锁；此时同步不会被本机守卫拦下。
  if (durableEnd) await requestSidechatSync();
  return "sent";
}

export async function stopSidechatMessage(child: SidechatChild): Promise<void> {
  const messageId = sidechatSending.get(child.dir);
  if (!messageId) return;
  const message = useChatStreamStore().getActiveStreamMessage(child.agentId, "agent", child.topicId, messageId);
  if (message) message.isStopping = true;
  await invoke<boolean>("sidechat_stop", {
    agentId: child.agentId,
    topicId: child.topicId,
    messageId,
  });
}
