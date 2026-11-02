import { watch } from "vue";
import { getActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settings";
import {
  LEGACY_THEME_MAP,
  normalizeThemeModuleKey,
  useThemeStore,
  type ThemeMode,
} from "../stores/theme";
import { hintTargetFromSettings, type HintTarget } from "./remoteChangeHint";

/**
 * 电脑端设置同步（ptp4g#37）：`{syncHttpUrl}/api/canvas-sync/settings`。
 *
 * - 拉取：同步目标出现时（启动后设置就绪、回到前台、换地址/Token）GET 一次。
 *   userName → 手机用户名；currentThemeMode（light/dark/system）→ 手机明暗。
 *   其余白名单键手机没有对应项，忽略。
 * - 上推：手机用户名/明暗变化后防抖 2s，只 PUT 与上次同步值不同的键。
 *   首次拉取成功前不上推，避免本机旧值覆盖电脑端。
 * - 三方合并：本机自上次同步后改过、尚未推上去的键，拉取时保留本机值，交给上推。
 * - autoSync 关闭或缺 syncHttpUrl/Token 时不运行（与 remoteChangeHint 同一判定）；
 *   404/503 视为电脑端未启用，静默指数退避（1 分钟起，最长 30 分钟）。
 * - 主题：电脑端只把当前主题拷成 styles/themes.css，settings.json 与 /settings 白名单里
 *   没有主题文件名，所以主题互映只提供映射函数，暂不接入同步。
 * - HTTP 经 Rust command（settings_sync_get / settings_sync_put），原因见 sync/settings_sync.rs。
 */
export const SETTINGS_PUSH_DEBOUNCE_MS = 2_000;
export const SETTINGS_BACKOFF_MIN_MS = 60_000;
export const SETTINGS_BACKOFF_MAX_MS = 30 * 60_000;

const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];
const isThemeMode = (value: unknown): value is ThemeMode =>
  THEME_MODES.includes(value as ThemeMode);

export interface SettingsHttpResponse {
  status: number;
  body: unknown;
}

export interface LocalSyncedSettings {
  userName: string;
  themeMode: ThemeMode;
}

type SyncedKey = keyof LocalSyncedSettings;
type SyncedValues = Partial<Record<SyncedKey, string>>;
const SYNCED_KEYS: readonly SyncedKey[] = ["userName", "themeMode"];

const cleanName = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** 电脑端 values → 手机侧可落地的项；无对应或取值非法的键丢弃。 */
export function localFromRemote(values: unknown): Partial<LocalSyncedSettings> {
  const out: Partial<LocalSyncedSettings> = {};
  if (!values || typeof values !== "object" || Array.isArray(values)) return out;
  const record = values as Record<string, unknown>;
  const name = cleanName(record.userName);
  if (name) out.userName = name;
  if (isThemeMode(record.currentThemeMode)) out.themeMode = record.currentThemeMode;
  return out;
}

/** 手机侧变化 → 电脑端白名单键；空用户名不推。 */
export function remoteFromLocal(patch: Partial<LocalSyncedSettings>): Record<string, string> {
  const values: Record<string, string> = {};
  const name = cleanName(patch.userName);
  if (name) values.userName = name;
  if (isThemeMode(patch.themeMode)) values.currentThemeMode = patch.themeMode;
  return values;
}

const cssToModuleKey = (name: string) =>
  name.endsWith(".css") ? `${name.slice(0, -4)}.ts` : name;

/** 电脑主题文件名 → 手机主题 id；不在映射表或手机没有该主题时返回 null（不改）。 */
export function mobileThemeFromComputer(computerTheme: unknown): string | null {
  if (typeof computerTheme !== "string") return null;
  const name = computerTheme.trim();
  if (!Object.prototype.hasOwnProperty.call(LEGACY_THEME_MAP, name)) return null;
  return normalizeThemeModuleKey(name);
}

/** 手机主题 id → 电脑主题文件名；反查不到返回 null（不推）。 */
export function computerThemeFromMobile(mobileTheme: unknown): string | null {
  if (typeof mobileTheme !== "string") return null;
  for (const [computer, mobile] of Object.entries(LEGACY_THEME_MAP)) {
    if (cssToModuleKey(mobile) === mobileTheme) return computer;
  }
  return null;
}

export interface SettingsRemoteDeps {
  getTarget: () => HintTarget | null;
  /** 设置尚未加载时返回 null。 */
  readLocal: () => LocalSyncedSettings | null;
  applyLocal: (patch: Partial<LocalSyncedSettings>) => Promise<unknown> | void;
  fetchSettings: (target: HintTarget) => Promise<SettingsHttpResponse>;
  putSettings: (target: HintTarget, values: Record<string, string>) => Promise<SettingsHttpResponse>;
  now?: () => number;
}

export interface SettingsRemote {
  pull: () => Promise<void>;
  schedulePush: () => void;
  dispose: () => void;
}

const isDisabledStatus = (status: number) => status === 404 || status === 503;
const isOk = (status: number) => status >= 200 && status < 300;

export function createSettingsRemote(deps: SettingsRemoteDeps): SettingsRemote {
  const now = deps.now ?? Date.now;
  /** 最近一次与电脑端一致的值；null = 尚未拉取成功，禁止上推。 */
  let synced: SyncedValues | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pullSeq = 0;
  let backoffMs = 0;
  let blockedUntil = 0;
  let disposed = false;

  const backingOff = () => now() < blockedUntil;
  const backOff = () => {
    backoffMs = backoffMs
      ? Math.min(backoffMs * 2, SETTINGS_BACKOFF_MAX_MS)
      : SETTINGS_BACKOFF_MIN_MS;
    blockedUntil = now() + backoffMs;
  };
  const recover = () => {
    backoffMs = 0;
    blockedUntil = 0;
  };

  const pull = async () => {
    const target = deps.getTarget();
    if (!target || disposed || backingOff()) return;
    const seq = ++pullSeq;
    let response: SettingsHttpResponse;
    try {
      response = await deps.fetchSettings(target);
    } catch (error) {
      console.warn("[SettingsRemote] pull failed:", error);
      return;
    }
    if (seq !== pullSeq || disposed) return;
    if (isDisabledStatus(response.status)) {
      backOff();
      return;
    }
    if (response.status !== 200) {
      console.warn(`[SettingsRemote] pull failed: HTTP ${response.status}`);
      return;
    }
    recover();
    const body = response.body;
    const values =
      body && typeof body === "object" ? (body as { values?: unknown }).values : undefined;
    const remote: SyncedValues = localFromRemote(values);
    const local = deps.readLocal();
    if (!local) return;
    const base = synced;
    const patch: SyncedValues = {};
    for (const key of SYNCED_KEYS) {
      const value = remote[key];
      if (value === undefined || value === local[key]) continue;
      if (base && base[key] !== undefined && local[key] !== base[key]) continue;
      patch[key] = value;
    }
    if (Object.keys(patch).length > 0) {
      try {
        await deps.applyLocal(patch as Partial<LocalSyncedSettings>);
      } catch (error) {
        // 落地失败时不留同步基线：否则本机旧值会被当成新改动推回电脑端。
        console.warn("[SettingsRemote] apply failed:", error);
        if (seq === pullSeq) synced = null;
        return;
      }
    }
    if (seq !== pullSeq || disposed) return;
    synced = remote;
    schedulePush();
  };

  const flushPush = async () => {
    pushTimer = null;
    const target = deps.getTarget();
    const local = deps.readLocal();
    const base = synced;
    if (!target || !local || !base || disposed || backingOff()) return;
    const diff: SyncedValues = {};
    for (const key of SYNCED_KEYS) {
      if (local[key] !== base[key]) diff[key] = local[key];
    }
    const values = remoteFromLocal(diff as Partial<LocalSyncedSettings>);
    if (Object.keys(values).length === 0) return;
    try {
      const response = await deps.putSettings(target, values);
      if (isDisabledStatus(response.status)) {
        backOff();
        return;
      }
      if (!isOk(response.status)) {
        console.warn(`[SettingsRemote] push failed: HTTP ${response.status}`);
        return;
      }
      recover();
      if (synced) {
        const sent: SyncedValues = {};
        if (values.userName !== undefined) sent.userName = values.userName;
        if (values.currentThemeMode !== undefined) sent.themeMode = values.currentThemeMode;
        synced = { ...synced, ...sent };
      }
    } catch (error) {
      console.warn("[SettingsRemote] push failed:", error);
    }
  };

  const schedulePush = () => {
    if (disposed || !synced || !deps.getTarget()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void flushPush(), SETTINGS_PUSH_DEBOUNCE_MS);
  };

  const dispose = () => {
    disposed = true;
    pullSeq += 1;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
  };

  return { pull, schedulePush, dispose };
}

let activeDispose: (() => void) | null = null;

/** 应用级单例：由 useAppLifecycle 挂载，返回卸载函数。 */
export function useSettingsRemote(isForeground: () => boolean): () => void {
  activeDispose?.();
  if (!getActivePinia()) return () => {};
  const settingsStore = useSettingsStore();
  const themeStore = useThemeStore();
  const getTarget = () => hintTargetFromSettings(settingsStore.settings, isForeground());
  const remote = createSettingsRemote({
    getTarget,
    readLocal: () => {
      const settings = settingsStore.settings;
      if (!settings) return null;
      const userName = typeof settings.userName === "string" ? settings.userName.trim() : "";
      return { userName, themeMode: themeStore.mode };
    },
    applyLocal: async (patch) => {
      if (patch.themeMode) themeStore.mode = patch.themeMode;
      if (patch.userName !== undefined) {
        await settingsStore.updateSettings({ userName: patch.userName });
      }
    },
    fetchSettings: (target) =>
      invoke<SettingsHttpResponse>("settings_sync_get", {
        baseUrl: target.baseUrl,
        token: target.token,
      }),
    putSettings: (target, values) =>
      invoke<SettingsHttpResponse>("settings_sync_put", {
        baseUrl: target.baseUrl,
        token: target.token,
        values,
      }),
  });
  // 目标由无到有（启动就绪、回前台）或换地址/Token 时拉取一次。
  const stopTarget = watch(
    () => {
      const target = getTarget();
      return target ? `${target.baseUrl}\n${target.token}` : null;
    },
    (key) => {
      if (key !== null) void remote.pull();
    },
    { immediate: true },
  );
  const stopLocal = watch(
    () => [settingsStore.settings?.userName, themeStore.mode],
    () => remote.schedulePush(),
  );
  const dispose = () => {
    stopTarget();
    stopLocal();
    remote.dispose();
    if (activeDispose === dispose) activeDispose = null;
  };
  activeDispose = dispose;
  return dispose;
}
