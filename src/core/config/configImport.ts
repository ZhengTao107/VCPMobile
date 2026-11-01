// configImport: 「粘贴配置串」导入/导出（vcpm1: 前缀 + base64url(JSON)）
// 承载连接所需的 5 个字符串字段 + 连接档案（connectionProfiles / connectionProfileMode）；
// 文件式完整备份见 features/settings/useConfigBackup.ts。
// 本模块只做纯计算，不读写设置；写入由调用方走 settingsStore.updateSettings。
import type {
  AppSettings,
  ConnectionProfile,
  ConnectionProfileMode,
  ConnectionProfileName,
} from "../stores/settings";

export const CONFIG_STRING_PREFIX = "vcpm1:";
export const CONFIG_STRING_VERSION = 1;
/** 正常配置串只有几百字节；超长输入直接拒绝，避免误粘大段文本 */
export const MAX_CONFIG_STRING_LENGTH = 16 * 1024;
const MAX_LABEL_LENGTH = 64;

/** 配置串字段白名单：未列出的键一律丢弃（防止经 Rust extra flatten 灌入垃圾键） */
export const CONFIG_STRING_FIELDS = [
  "vcpServerUrl",
  "vcpApiKey",
  "syncServerUrl",
  "syncHttpUrl",
  "syncToken",
] as const;

/** 结构化字段白名单：单独校验，不走字符串字段循环 */
export const CONFIG_PROFILE_FIELDS = ["connectionProfiles", "connectionProfileMode"] as const;

export type ConfigStringField = (typeof CONFIG_STRING_FIELDS)[number];

/** 手机端固定两档，与 settings.ts ConnectionProfileName 一致 */
export const CONFIG_PROFILE_NAMES: readonly ConnectionProfileName[] = ["本机", "服务器"];
const MAX_PROFILES = CONFIG_PROFILE_NAMES.length;
const SERVER_NAME: ConnectionProfileName = "服务器";

/** 配置串只接受显式档位；auto 依赖本机探测，不随配置串分发 */
export type ImportableProfileMode = Exclude<ConnectionProfileMode, "auto">;
const IMPORTABLE_MODES: readonly ImportableProfileMode[] = ["local", "server"];

export type ImportedConfig = Partial<Record<ConfigStringField, string>> & {
  connectionProfiles?: ConnectionProfile[];
  connectionProfileMode?: ImportableProfileMode;
  label?: string;
};

export type ParseConfigResult =
  | { ok: true; config: ImportedConfig }
  | { ok: false; error: string };

export interface BuildConfigOptions {
  /** 'server-only'：只导出「服务器」档案并强制 mode=server（朋友版，不外发本机内网地址） */
  profiles?: "all" | "server-only";
}

export interface ConfigPreviewItem {
  field: ConfigStringField | "connectionProfileMode" | `connectionProfiles.${ConnectionProfileName}`;
  label: string;
  value: string;
}

const FIELD_LABELS: Record<ConfigStringField, string> = {
  vcpServerUrl: "VCP 服务器地址",
  vcpApiKey: "VCP API Key",
  syncServerUrl: "同步 WebSocket 地址",
  syncHttpUrl: "同步 HTTP 地址",
  syncToken: "Mobile Sync Token",
};

const HTTP_PROTOCOLS: readonly string[] = ["http:", "https:"];

/** 与 sync_service.rs build_sync_session_config 的协议约束一致 */
const URL_PROTOCOLS: Partial<Record<ConfigStringField, readonly string[]>> = {
  vcpServerUrl: HTTP_PROTOCOLS,
  syncHttpUrl: HTTP_PROTOCOLS,
  syncServerUrl: ["ws:", "wss:"],
};

const SECRET_FIELDS: ReadonlySet<ConfigStringField> = new Set(["vcpApiKey", "syncToken"]);

/** 聊天软件转发时常被包上的引号（含中文全角） */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
];

const fail = (error: string): ParseConfigResult => ({ ok: false, error });

// ------------------------------------------------------------------
// base64url（UTF-8 安全；label 可能含中文）
// ------------------------------------------------------------------

function encodeBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 兼容标准 base64（+/ 与 = 填充）；非法编码或非 UTF-8 返回 null */
function decodeBase64Url(input: string): string | null {
  if (!/^[A-Za-z0-9_\-+/]+={0,2}$/.test(input)) return null;
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (b64.length % 4 === 1) return null;
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// 校验
// ------------------------------------------------------------------

/** 去掉所有空白（换行、折行、BOM），再剥掉成对包裹的引号 */
function normalizeInput(text: string): string {
  let s = text.replace(/\s+/g, "");
  let stripped = true;
  while (stripped && s.length >= 2) {
    stripped = false;
    for (const [open, close] of QUOTE_PAIRS) {
      if (s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length);
        stripped = true;
        break;
      }
    }
  }
  return s;
}

function checkUrl(value: string, protocols: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "不是合法的 URL";
  }
  if (!protocols.includes(url.protocol)) {
    return `协议必须是 ${protocols.map((p) => p.slice(0, -1)).join(" / ")}`;
  }
  if (!url.hostname) return "缺少主机名";
  return null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProfileName = (value: unknown): value is ConnectionProfileName =>
  typeof value === "string" && (CONFIG_PROFILE_NAMES as readonly string[]).includes(value);

const isImportableMode = (value: unknown): value is ImportableProfileMode =>
  typeof value === "string" && (IMPORTABLE_MODES as readonly string[]).includes(value);

type ProfilesResult = { ok: true; profiles: ConnectionProfile[] } | { ok: false; error: string };

/** 校验 connectionProfiles：任一项非法即整串拒绝；空数组返回空列表，由调用方视为未提供 */
function parseProfiles(value: unknown): ProfilesResult {
  const bad = (error: string): ProfilesResult => ({ ok: false, error: `连接档案：${error}` });
  if (!Array.isArray(value)) return bad("类型不正确");
  if (value.length > MAX_PROFILES) return bad(`最多 ${MAX_PROFILES} 个`);

  const profiles: ConnectionProfile[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return bad("档案格式不正确");
    const name: unknown = typeof item.name === "string" ? item.name.trim() : item.name;
    if (!isProfileName(name)) return bad(`名称只能是 ${CONFIG_PROFILE_NAMES.join(" / ")}`);
    if (profiles.some((profile) => profile.name === name)) return bad(`名称「${name}」重复`);

    const url = typeof item.vcpServerUrl === "string" ? item.vcpServerUrl.trim() : "";
    if (!url) return bad(`「${name}」缺少服务器地址`);
    const urlError = checkUrl(url, HTTP_PROTOCOLS);
    if (urlError) return bad(`「${name}」${urlError}`);

    const key = item.vcpApiKey ?? "";
    if (typeof key !== "string") return bad(`「${name}」API Key 类型不正确`);
    profiles.push({ name, vcpServerUrl: url, vcpApiKey: key.trim() });
  }
  return { ok: true, profiles };
}

/** 导出端的过滤：跳过非法/重复名称与缺地址、地址非法的档案，保证生成的串能被自己解析 */
function exportableProfiles(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value)) return [];
  const result: ConnectionProfile[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!isProfileName(name) || result.some((profile) => profile.name === name)) continue;
    const url = typeof item.vcpServerUrl === "string" ? item.vcpServerUrl.trim() : "";
    if (!url || checkUrl(url, HTTP_PROTOCOLS)) continue;
    const key = typeof item.vcpApiKey === "string" ? item.vcpApiKey.trim() : "";
    result.push({ name, vcpServerUrl: url, vcpApiKey: key });
  }
  return result;
}

// ------------------------------------------------------------------
// 公共 API
// ------------------------------------------------------------------

/**
 * 解析配置串。字段都可选：只返回出现且非空的字段，调用方只覆盖这些字段。
 * 空字符串 / 空档案数组视为未提供（不会把已有设置清空）。
 */
export function parseConfigString(text: string): ParseConfigResult {
  if (typeof text !== "string") return fail("配置串为空");
  if (text.length > MAX_CONFIG_STRING_LENGTH) return fail("配置串过长，请确认只粘贴了配置串");

  const normalized = normalizeInput(text);
  if (!normalized) return fail("配置串为空");
  if (!normalized.toLowerCase().startsWith(CONFIG_STRING_PREFIX)) {
    return fail(`配置串必须以 ${CONFIG_STRING_PREFIX} 开头`);
  }

  const json = decodeBase64Url(normalized.slice(CONFIG_STRING_PREFIX.length));
  if (json === null) return fail("配置串编码损坏，请确认复制完整");

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail("配置串内容不是合法的 JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("配置串内容格式不正确");
  }

  const obj = raw as Record<string, unknown>;
  if (obj.v !== CONFIG_STRING_VERSION) {
    return fail(`不支持的配置串版本: ${String(obj.v)}`);
  }

  const config: ImportedConfig = {};
  for (const field of CONFIG_STRING_FIELDS) {
    const value = obj[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return fail(`${FIELD_LABELS[field]} 类型不正确`);
    const trimmed = value.trim();
    if (!trimmed) continue;
    const protocols = URL_PROTOCOLS[field];
    if (protocols) {
      const error = checkUrl(trimmed, protocols);
      if (error) return fail(`${FIELD_LABELS[field]}：${error}`);
    }
    config[field] = trimmed;
  }

  if (obj.connectionProfiles !== undefined && obj.connectionProfiles !== null) {
    const parsed = parseProfiles(obj.connectionProfiles);
    if (!parsed.ok) return fail(parsed.error);
    if (parsed.profiles.length) config.connectionProfiles = parsed.profiles;
  }

  const mode = obj.connectionProfileMode;
  const modeIsEmpty = mode === undefined || mode === null || (typeof mode === "string" && !mode.trim());
  if (!modeIsEmpty) {
    const trimmedMode = typeof mode === "string" ? mode.trim() : mode;
    if (!isImportableMode(trimmedMode)) {
      return fail(`连接档位：只允许 ${IMPORTABLE_MODES.join(" / ")}`);
    }
    config.connectionProfileMode = trimmedMode;
  }

  const importable = [...CONFIG_STRING_FIELDS, ...CONFIG_PROFILE_FIELDS];
  if (!importable.some((field) => config[field] !== undefined)) {
    return fail("配置串里没有可导入的设置项");
  }
  if (typeof obj.label === "string" && obj.label.trim()) {
    config.label = obj.label.trim().slice(0, MAX_LABEL_LENGTH);
  }
  return { ok: true, config };
}

/**
 * 由当前设置生成配置串（只带非空字段）。
 * options.profiles='server-only'：只带「服务器」档案并强制 mode=server；顶层 vcpServerUrl/vcpApiKey
 * 可能就是本机内网地址，因此改用「服务器」档案的值，没有该档案时一并不带。
 */
export function buildConfigString(
  settings: Partial<AppSettings>,
  label?: string,
  options: BuildConfigOptions = {},
): string {
  const scope = options.profiles ?? "all";
  const payload: Record<string, unknown> = { v: CONFIG_STRING_VERSION };
  for (const field of CONFIG_STRING_FIELDS) {
    const value = settings[field];
    if (typeof value === "string" && value.trim()) payload[field] = value.trim();
  }

  const profiles = exportableProfiles(settings.connectionProfiles);
  if (scope === "server-only") {
    delete payload.vcpServerUrl;
    delete payload.vcpApiKey;
    const server = profiles.find((profile) => profile.name === SERVER_NAME);
    if (server) {
      payload.vcpServerUrl = server.vcpServerUrl;
      if (server.vcpApiKey) payload.vcpApiKey = server.vcpApiKey;
      payload.connectionProfiles = [server];
      payload.connectionProfileMode = "server";
    }
  } else {
    if (profiles.length) payload.connectionProfiles = profiles;
    // auto 不导出：它依赖接收端自己的探测
    if (isImportableMode(settings.connectionProfileMode)) {
      payload.connectionProfileMode = settings.connectionProfileMode;
    }
  }

  if (label?.trim()) payload.label = label.trim().slice(0, MAX_LABEL_LENGTH);
  return CONFIG_STRING_PREFIX + encodeBase64Url(JSON.stringify(payload));
}

/** 解析结果 → update_settings 的 patch（不含 label 等非设置项） */
export function toSettingsPatch(config: ImportedConfig): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  for (const field of CONFIG_STRING_FIELDS) {
    const value = config[field];
    if (value !== undefined) patch[field] = value;
  }
  if (config.connectionProfiles?.length) {
    patch.connectionProfiles = config.connectionProfiles.map((profile) => ({ ...profile }));
  }
  if (config.connectionProfileMode) patch.connectionProfileMode = config.connectionProfileMode;
  return patch;
}

/** 密钥只露后 4 位；长度不超过 4 时全部遮蔽，避免短密钥整段外露 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/** 导入前的脱敏预览：只列出配置串里出现的字段；每个档案一行，档位一行 */
export function maskPreview(config: ImportedConfig): ConfigPreviewItem[] {
  const items: ConfigPreviewItem[] = [];
  for (const field of CONFIG_STRING_FIELDS) {
    const value = config[field];
    if (value === undefined) continue;
    items.push({
      field,
      label: FIELD_LABELS[field],
      value: SECRET_FIELDS.has(field) ? maskSecret(value) : value,
    });
  }
  for (const profile of config.connectionProfiles ?? []) {
    const name = profile.name as ConnectionProfileName;
    const key = profile.vcpApiKey ? maskSecret(profile.vcpApiKey) : "未设置";
    items.push({
      field: `connectionProfiles.${name}`,
      label: `连接档案「${name}」`,
      value: `${profile.vcpServerUrl} · Key ${key}`,
    });
  }
  if (config.connectionProfileMode) {
    items.push({
      field: "connectionProfileMode",
      label: "连接档位",
      value: config.connectionProfileMode === "local" ? "本机（local）" : "服务器（server）",
    });
  }
  return items;
}
