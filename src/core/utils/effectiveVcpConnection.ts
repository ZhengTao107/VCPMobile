import { invoke } from "@tauri-apps/api/core";

export type ConnectionSource = "legacy" | "local" | "server";

export interface EffectiveVcpConnection {
  vcpServerUrl: string;
  vcpApiKey: string;
  source: ConnectionSource;
}

/**
 * 前端自行发请求（语音转写等）时取当前生效端点。
 * 解析与 auto 探测状态只在 Rust connection_resolver 中维护，此处不重复判断。
 */
export async function getEffectiveVcpConnection(): Promise<EffectiveVcpConnection | null> {
  try {
    return (await invoke<EffectiveVcpConnection>("get_effective_vcp_connection")) ?? null;
  } catch (error) {
    console.warn("[EffectiveVcpConnection] Failed to resolve connection:", error);
    return null;
  }
}
