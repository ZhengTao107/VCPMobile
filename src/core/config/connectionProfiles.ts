/**
 * fork ptp4g#24：VCPChat 式连接档案。档案只是「填字段的快捷预设」：
 * 选用时把非空字段写进正在用的那组字段，界面永远只有一组连接字段。
 * 存储：settings.server.connectionProfiles（JSON 数组文本）。档案内键名沿用旧扁平名，
 * 兼容旧库数据（Rust split_legacy 已序列化迁入）与 vcpm1 配置串。
 */
import type { AppSettings } from "../stores/settings";

export const CONNECTION_PROFILE_FIELDS = [
  "vcpServerUrl",
  "chatEndpointMode",
  "vcpApiKey",
  "vcpLogUrl",
  "vcpLogKey",
  "fileKey",
  "syncHttpUrl",
  "syncServerUrl",
  "syncToken",
] as const;
export type ConnectionProfileField = (typeof CONNECTION_PROFILE_FIELDS)[number];
export type ConnectionProfile = { id: string; name: string } & Record<ConnectionProfileField, string>;
/** 朋友版配置串只导出此名称的档案 */
export const SERVER_PROFILE_NAME = "服务器";

/** 档案键 → 上游分域配置路径 */
export const CONNECTION_PROFILE_PATHS = {
  vcpServerUrl: "server.url",
  chatEndpointMode: "server.endpointMode",
  vcpApiKey: "server.apiKey",
  vcpLogUrl: "log.url",
  vcpLogKey: "log.key",
  fileKey: "server.fileKey",
  syncHttpUrl: "sync.httpUrl",
  syncServerUrl: "sync.serverUrl",
  syncToken: "sync.token",
} as const satisfies Record<ConnectionProfileField, string>;

const CHAT_ENDPOINT_MODES: readonly string[] = ["standard", "vcpTools", "raw"];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function newConnectionProfileId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 任意来源的档案列表 → 当前结构；缺的字段留空、补 id；没有名称的项丢弃。 */
export function normalizeConnectionProfiles(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: ConnectionProfile[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const profile = {
      id: typeof item.id === "string" && item.id ? item.id : newConnectionProfileId(),
      name,
    } as ConnectionProfile;
    for (const field of CONNECTION_PROFILE_FIELDS) {
      profile[field] = typeof item[field] === "string" ? (item[field] as string) : "";
    }
    profiles.push(profile);
  }
  return profiles;
}

/** 读 server.connectionProfiles；空串或坏 JSON 视为无档案。 */
export function parseConnectionProfiles(raw: string | null | undefined): ConnectionProfile[] {
  if (!raw?.trim()) return [];
  try {
    return normalizeConnectionProfiles(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function serializeConnectionProfiles(profiles: readonly ConnectionProfile[]): string {
  return profiles.length ? JSON.stringify(profiles) : "";
}

export function readConnectionField(settings: AppSettings, field: ConnectionProfileField): string {
  const [domain, key] = CONNECTION_PROFILE_PATHS[field].split(".");
  const value = (settings as unknown as Record<string, Record<string, unknown>>)[domain]?.[key];
  return typeof value === "string" ? value : "";
}

/** 选用档案：只取非空字段，按配置路径给出要写入的值；非法的请求入口值忽略。 */
export function connectionProfileFieldValues(profile: ConnectionProfile): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of CONNECTION_PROFILE_FIELDS) {
    const value = profile[field];
    if (typeof value !== "string" || !value.trim()) continue;
    if (field === "chatEndpointMode" && !CHAT_ENDPOINT_MODES.includes(value)) continue;
    values[CONNECTION_PROFILE_PATHS[field]] = value;
  }
  return values;
}

/** 存为档案：把正在用的那组字段拷成一个新档案。 */
export function connectionProfileFromSettings(settings: AppSettings, name: string): ConnectionProfile {
  const profile = { id: newConnectionProfileId(), name: name.trim() } as ConnectionProfile;
  for (const field of CONNECTION_PROFILE_FIELDS) profile[field] = readConnectionField(settings, field);
  return profile;
}
