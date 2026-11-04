import { invoke } from "@tauri-apps/api/core";
import { useAssistantStore } from "../../core/stores/assistant";
import type { AgentConfigDto } from "../../core/types/assistant";

/**
 * 快切模型、选用提示词预设共用的写入口（ptp4g#47）。
 *
 * 作用域：电脑端 VCPChat 有话题时写 topic.model 并同改 Agent 默认；手机 topics 表没有 model 列，
 * 所以这里只写 Agent 默认模型，对应电脑端"未打开话题时只改 Agent 默认"那一支。群聊不提供快切。
 */
export type AgentConfigPatch = Partial<Pick<AgentConfigDto, "model" | "mobileSystemPrompt">>;

interface OwnerLike {
  id?: string | null;
  type?: string | null;
}

/** 只有单 Agent 会话可快切；群聊与未选会话返回 null。 */
export function quickSwitchAgentId(item: OwnerLike | null | undefined): string | null {
  return item?.type === "agent" && typeof item.id === "string" && item.id ? item.id : null;
}

/** 以最新落盘配置为基线，只改补丁字段后保存；基线不符由 save_agent_config 拒绝。 */
export async function patchAgentConfig(agentId: string, patch: AgentConfigPatch): Promise<AgentConfigDto> {
  const baseline = await invoke<AgentConfigDto>("read_agent_config", { agentId, allowDefault: false });
  const draft: AgentConfigDto = { ...JSON.parse(JSON.stringify(baseline)), ...patch };
  return useAssistantStore().saveAgent(draft, baseline);
}
