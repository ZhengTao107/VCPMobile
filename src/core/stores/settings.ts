import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useNotificationStore } from "./notification";

export type ChatEndpointMode = "standard" | "vcpTools" | "raw";

/**
 * 连接档案 = 填字段的快捷预设（与 VCPChat connection-profiles 同一范式）：
 * 选用时把档案的非空字段写进下面那组「正在用」的字段，走正常保存；档案本身不参与任何请求解析。
 */
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

export interface AppSettings {
  userName: string;
  vcpServerUrl: string;
  chatEndpointMode: ChatEndpointMode;
  vcpApiKey: string;
  connectionProfiles?: ConnectionProfile[];
  vcpLogUrl: string;
  vcpLogKey: string;
  syncServerUrl: string;
  syncHttpUrl: string;
  syncToken: string;
  /** 消息完成/回前台/联网后自动同步；缺省视为开启，仅显式 false 关闭。 */
  autoSync?: boolean;
  adminUsername: string;
  adminPassword: string;
  fileKey: string;
  topicSummaryModel: string;
  syncLogLevel: string;
  agentOrder: string[];
  groupOrder: string[];
  currentThemeMode: string | null;
  syncPrerenderEnabled: boolean;
  // [SUSPENDED BETA] 浮动助手（划词悬浮球）功能当前已暂停使用，保留字段供后续重启
  enableAssistant: boolean;
  assistantAgentId: string;
  distributedEnabled: boolean;
  distributedWsUrl: string;
  distributedVcpKey: string;
  distributedDeviceName: string;
  [key: string]: unknown;
}

export function diffSettingsPatch(
  baseline: AppSettings,
  edited: AppSettings,
): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  for (const key of Object.keys(edited)) {
    if (JSON.stringify(edited[key]) !== JSON.stringify(baseline[key])) {
      patch[key] = edited[key];
    }
  }
  return patch;
}

const CHAT_ENDPOINT_MODES: readonly string[] = ["standard", "vcpTools", "raw"];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function newConnectionProfileId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const isCurrentProfile = (value: unknown): value is ConnectionProfile =>
  isPlainObject(value) &&
  typeof value.id === "string" &&
  value.id.length > 0 &&
  typeof value.name === "string" &&
  CONNECTION_PROFILE_FIELDS.every((field) => typeof value[field] === "string");

/**
 * 任意来源的档案列表 → 新结构。旧结构（本机/服务器，只有 vcpServerUrl/vcpApiKey）按同名转换，
 * 缺的字段留空、补 id；没有名称的项丢弃。
 */
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

/**
 * #5 遗留结构的迁移补丁：档案转新结构、档位 connectionProfileMode 作废（写 null）。
 * 「正在用」的那组字段不动。已是新结构时返回 null。
 */
export function migrateConnectionSettings(settings: AppSettings): Partial<AppSettings> | null {
  const raw = settings.connectionProfiles as unknown;
  const legacyMode = settings.connectionProfileMode !== undefined && settings.connectionProfileMode !== null;
  const legacyProfiles =
    raw !== undefined && raw !== null && (!Array.isArray(raw) || !raw.every(isCurrentProfile));
  if (!legacyMode && !legacyProfiles) return null;
  const patch: Partial<AppSettings> = {};
  if (legacyProfiles) patch.connectionProfiles = normalizeConnectionProfiles(raw);
  if (legacyMode) patch.connectionProfileMode = null;
  return patch;
}

/** 选用档案：只取非空字段写进正在用的那组字段；非法的请求入口值忽略 */
export function connectionProfilePatch(profile: ConnectionProfile): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  for (const field of CONNECTION_PROFILE_FIELDS) {
    const value = profile[field];
    if (typeof value !== "string" || !value.trim()) continue;
    if (field === "chatEndpointMode" && !CHAT_ENDPOINT_MODES.includes(value)) continue;
    (patch as Record<string, unknown>)[field] = value;
  }
  return patch;
}

/** 存为档案：把正在用的那组字段拷成一个新档案 */
export function connectionProfileFromSettings(settings: AppSettings, name: string): ConnectionProfile {
  const profile = { id: newConnectionProfileId(), name: name.trim() } as ConnectionProfile;
  for (const field of CONNECTION_PROFILE_FIELDS) {
    const value = settings[field];
    profile[field] = typeof value === "string" ? value : "";
  }
  return profile;
}

interface SettingsRecoveryStatus {
  recoveredCorrupt: boolean;
  backupKey: string | null;
  message: string | null;
}

export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<AppSettings | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const recoveryNotified = ref(false);
  const notificationStore = useNotificationStore();
  let activeOperations = 0;
  let operationTail: Promise<void> = Promise.resolve();
  const enqueueOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    activeOperations += 1;
    loading.value = true;
    const queued = operationTail.catch(() => undefined).then(operation);
    operationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued.finally(() => {
      activeOperations = Math.max(0, activeOperations - 1);
      loading.value = activeOperations > 0;
    });
  };

  // 旧连接档案结构在读取时迁移一次并回写；回写失败不阻断读取，先用归一化后的副本。
  const migrateFetchedSettings = async (fetched: AppSettings): Promise<AppSettings> => {
    const migration = migrateConnectionSettings(fetched);
    if (!migration) return fetched;
    try {
      return await invoke<AppSettings>("update_settings", { updates: migration });
    } catch (e) {
      console.warn("[SettingsStore] Connection profile migration not persisted:", e);
      return { ...fetched, ...migration };
    }
  };

  const fetchSettings = () => enqueueOperation(async () => {
    error.value = null;
    try {
      const fetchedSettings = await invoke<AppSettings>("read_settings");
      settings.value = await migrateFetchedSettings(fetchedSettings);
      const recovery = await invoke<SettingsRecoveryStatus>("get_settings_recovery_status");
      if (recovery.recoveredCorrupt && !recoveryNotified.value) {
        recoveryNotified.value = true;
        notificationStore.addNotification({
          type: "warning",
          title: "设置已从损坏数据恢复",
          message: recovery.message || "原始设置已在数据库中备份，当前使用默认设置。",
          toastOnly: true,
        });
      }
    } catch (e: any) {
      error.value = e.toString();
      console.error("[SettingsStore] Failed to fetch settings:", e);
      throw e;
    }
  });

  const updateSettings = (updates: Partial<AppSettings>) => enqueueOperation(async () => {
    error.value = null;
    try {
      const updated = await invoke<AppSettings>("update_settings", { updates });
      settings.value = updated;

      notificationStore.addNotification({
        type: "success",
        title: "配置同步成功",
        message: "变更已生效",
        toastOnly: true,
      });
      return updated;
    } catch (e: any) {
      error.value = e.toString();
      console.error("[SettingsStore] Failed to update settings:", e);
      throw e;
    }
  });

  return {
    settings,
    loading,
    error,
    fetchSettings,
    updateSettings,
  };
});
