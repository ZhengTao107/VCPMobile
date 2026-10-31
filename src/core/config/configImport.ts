// configImport: 「粘贴配置串」导入/导出（vcpm1: 前缀 + base64url(JSON)）
// 只承载连接所需的 5 个字段；文件式完整备份见 features/settings/useConfigBackup.ts。
// 本模块只做纯计算，不读写设置；写入由调用方走 settingsStore.updateSettings。
import type { AppSettings } from "../stores/settings";

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

export type ConfigStringField = (typeof CONFIG_STRING_FIELDS)[number];

export type ImportedConfig = Partial<Record<ConfigStringField, string>> & {
  label?: string;
};

export type ParseConfigResult =
  | { ok: true; config: ImportedConfig }
  | { ok: false; error: string };

export interface ConfigPreviewItem {
  field: ConfigStringField;
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

/** 与 sync_service.rs build_sync_session_config 的协议约束一致 */
const URL_PROTOCOLS: Partial<Record<ConfigStringField, readonly string[]>> = {
  vcpServerUrl: ["http:", "https:"],
  syncHttpUrl: ["http:", "https:"],
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

// ------------------------------------------------------------------
// 公共 API
// ------------------------------------------------------------------

/**
 * 解析配置串。字段都可选：只返回出现且非空的字段，调用方只覆盖这些字段。
 * 空字符串视为未提供（不会把已有设置清空）。
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

  if (!CONFIG_STRING_FIELDS.some((field) => config[field] !== undefined)) {
    return fail("配置串里没有可导入的设置项");
  }
  if (typeof obj.label === "string" && obj.label.trim()) {
    config.label = obj.label.trim().slice(0, MAX_LABEL_LENGTH);
  }
  return { ok: true, config };
}

/** 由当前设置生成配置串（只带非空字段） */
export function buildConfigString(settings: Partial<AppSettings>, label?: string): string {
  const payload: Record<string, unknown> = { v: CONFIG_STRING_VERSION };
  for (const field of CONFIG_STRING_FIELDS) {
    const value = settings[field];
    if (typeof value === "string" && value.trim()) payload[field] = value.trim();
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
  return patch;
}

/** 密钥只露后 4 位；长度不超过 4 时全部遮蔽，避免短密钥整段外露 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/** 导入前的脱敏预览：只列出配置串里出现的字段 */
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
  return items;
}
