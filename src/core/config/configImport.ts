// configImport: 「粘贴配置串」导入/导出（vcpm1: 前缀 + base64url(JSON)）
// 承载连接所需的 5 个字符串字段 + 连接档案（connectionProfiles：填字段的快捷预设，见 stores/settings.ts）；
// 文件式完整备份见 features/settings/useConfigBackup.ts。
// 本模块只做纯计算，不读写设置；写入由调用方走 settingsStore.updateSettings。
import {
  CONNECTION_PROFILE_FIELDS,
  SERVER_PROFILE_NAME,
  newConnectionProfileId,
  type AppSettings,
  type ConnectionProfile,
  type ConnectionProfileField,
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

/** 结构化字段白名单：单独校验，不走字符串字段循环。旧串里的 connectionProfileMode 已作废，导入时忽略 */
export const CONFIG_PROFILE_FIELDS = ["connectionProfiles"] as const;
const MAX_PROFILES = 32;

export type ConfigStringField = (typeof CONFIG_STRING_FIELDS)[number];

export type ImportedConfig = Partial<Record<ConfigStringField, string>> & {
  connectionProfiles?: ConnectionProfile[];
  label?: string;
};

export type ParseConfigResult =
  | { ok: true; config: ImportedConfig }
  | { ok: false; error: string };

export interface BuildConfigOptions {
  /** 'server-only'：只导出名为「服务器」的档案（朋友版），并剔除内网 / localhost 地址 */
  profiles?: "all" | "server-only";
}

export interface ConfigPreviewItem {
  field: ConfigStringField | `connectionProfiles.${string}`;
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

const PROFILE_FIELD_LABELS: Record<ConnectionProfileField, string> = {
  vcpServerUrl: "Chat URL",
  chatEndpointMode: "请求入口",
  vcpApiKey: "API Key",
  vcpLogUrl: "VCPLog URL",
  vcpLogKey: "VCPLog Key",
  fileKey: "File Key",
  syncHttpUrl: "同步 HTTP 地址",
  syncServerUrl: "同步 WebSocket 地址",
  syncToken: "Mobile Sync Token",
};

const HTTP_PROTOCOLS: readonly string[] = ["http:", "https:"];
const WS_PROTOCOLS: readonly string[] = ["ws:", "wss:"];
const CHAT_ENDPOINT_MODES: readonly string[] = ["standard", "vcpTools", "raw"];

/** 与 sync_service.rs build_sync_session_config 的协议约束一致 */
const URL_PROTOCOLS: Partial<Record<ConfigStringField, readonly string[]>> = {
  vcpServerUrl: HTTP_PROTOCOLS,
  syncHttpUrl: HTTP_PROTOCOLS,
  syncServerUrl: WS_PROTOCOLS,
};

const PROFILE_URL_PROTOCOLS: Partial<Record<ConnectionProfileField, readonly string[]>> = {
  vcpServerUrl: HTTP_PROTOCOLS,
  vcpLogUrl: WS_PROTOCOLS,
  syncHttpUrl: HTTP_PROTOCOLS,
  syncServerUrl: WS_PROTOCOLS,
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

/** 朋友版不外发的地址：localhost、回环、私网、链路本地、CGNAT（含 Tailscale 100.64/10）、.local */
function isInternalHost(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "0.0.0.0" || host === "::1") return true;
  if (host.includes(":")) return /^(fc|fd|fe80)/.test(host);
  const octets = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function profileFieldError(field: ConnectionProfileField, value: string): string | null {
  if (!value) return null;
  if (field === "chatEndpointMode") {
    return CHAT_ENDPOINT_MODES.includes(value) ? null : `只允许 ${CHAT_ENDPOINT_MODES.join(" / ")}`;
  }
  const protocols = PROFILE_URL_PROTOCOLS[field];
  return protocols ? checkUrl(value, protocols) : null;
}

type ProfilesResult = { ok: true; profiles: ConnectionProfile[] } | { ok: false; error: string };

/**
 * 校验 connectionProfiles：任一项非法即整串拒绝；空数组返回空列表，由调用方视为未提供。
 * 旧两档结构（只有 name/vcpServerUrl/vcpApiKey）照常通过，缺的字段留空；导入时重新分配 id。
 */
function parseProfiles(value: unknown): ProfilesResult {
  const bad = (error: string): ProfilesResult => ({ ok: false, error: `连接档案：${error}` });
  if (!Array.isArray(value)) return bad("类型不正确");
  if (value.length > MAX_PROFILES) return bad(`最多 ${MAX_PROFILES} 个`);

  const profiles: ConnectionProfile[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return bad("档案格式不正确");
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) return bad("缺少名称");
    if (name.length > MAX_LABEL_LENGTH) return bad(`名称过长（最多 ${MAX_LABEL_LENGTH} 字）`);
    if (profiles.some((profile) => profile.name === name)) return bad(`名称「${name}」重复`);

    const profile = { id: newConnectionProfileId(), name } as ConnectionProfile;
    for (const field of CONNECTION_PROFILE_FIELDS) {
      const raw = item[field] ?? "";
      if (typeof raw !== "string") return bad(`「${name}」${PROFILE_FIELD_LABELS[field]} 类型不正确`);
      const trimmed = raw.trim();
      const error = profileFieldError(field, trimmed);
      if (error) return bad(`「${name}」${PROFILE_FIELD_LABELS[field]}：${error}`);
      profile[field] = trimmed;
    }
    if (CONNECTION_PROFILE_FIELDS.every((field) => !profile[field])) {
      return bad(`「${name}」没有任何连接字段`);
    }
    profiles.push(profile);
  }
  return { ok: true, profiles };
}

type ExportedProfile = { name: string } & Partial<Record<ConnectionProfileField, string>>;

/**
 * 导出端的过滤：只带名称与非空字段（不带 id）；跳过无名称、重复名与全空档案，非法字段值清掉，
 * 保证生成的串能被自己解析。dropInternal 时剔除内网 / localhost 地址。
 */
function exportableProfiles(value: unknown, dropInternal: boolean): ExportedProfile[] {
  if (!Array.isArray(value)) return [];
  const result: ExportedProfile[] = [];
  for (const item of value) {
    if (result.length >= MAX_PROFILES) break;
    if (!isPlainObject(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || name.length > MAX_LABEL_LENGTH || result.some((profile) => profile.name === name)) continue;
    const profile: ExportedProfile = { name };
    for (const field of CONNECTION_PROFILE_FIELDS) {
      const raw = item[field];
      const trimmed = typeof raw === "string" ? raw.trim() : "";
      if (!trimmed || profileFieldError(field, trimmed)) continue;
      if (dropInternal && PROFILE_URL_PROTOCOLS[field] && isInternalHost(trimmed)) continue;
      profile[field] = trimmed;
    }
    if (CONNECTION_PROFILE_FIELDS.some((field) => profile[field] !== undefined)) result.push(profile);
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
 * options.profiles='server-only'：只带名为「服务器」的档案，顶层 vcpServerUrl/vcpApiKey 改用该档案的值
 * （顶层可能就是本机内网地址），所有内网 / localhost 地址一律不带；没有该档案时不带档案与顶层 VCP 地址。
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

  if (scope === "server-only") {
    delete payload.vcpServerUrl;
    delete payload.vcpApiKey;
    for (const field of CONFIG_STRING_FIELDS) {
      const value = payload[field];
      if (URL_PROTOCOLS[field] && typeof value === "string" && isInternalHost(value)) delete payload[field];
    }
    const server = exportableProfiles(settings.connectionProfiles, true).find(
      (profile) => profile.name === SERVER_PROFILE_NAME,
    );
    if (server) {
      if (server.vcpServerUrl) {
        payload.vcpServerUrl = server.vcpServerUrl;
        if (server.vcpApiKey) payload.vcpApiKey = server.vcpApiKey;
      }
      payload.connectionProfiles = [server];
    }
  } else {
    const profiles = exportableProfiles(settings.connectionProfiles, false);
    if (profiles.length) payload.connectionProfiles = profiles;
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
  return patch;
}

/** 密钥只露后 4 位；长度不超过 4 时全部遮蔽，避免短密钥整段外露 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/** 导入前的脱敏预览：只列出配置串里出现的字段；每个档案一行 */
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
    const key = profile.vcpApiKey ? maskSecret(profile.vcpApiKey) : "未设置";
    items.push({
      field: `connectionProfiles.${profile.name}`,
      label: `连接档案「${profile.name}」`,
      value: `${profile.vcpServerUrl || "未填 Chat URL"} · Key ${key}`,
    });
  }
  return items;
}
