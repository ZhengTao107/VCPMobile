import { getActivePinia } from "pinia";

/**
 * 显示层本机媒体链接改写（ptp4g#10）。
 *
 * 电脑端历史消息里大量媒体地址指向主机本身（localhost:6005 后端、:5974 分布式/同步 HTTP），
 * 在手机上 localhost 指向手机自己，图片必然失效。这里只在渲染时把这两个端口映射到当端
 * 配置的远程地址：不改存储、不改同步数据、不改哈希。
 *
 * 不改写：其他端口、file://、Windows 盘符路径（交给附件同步），以及目标为空的情况。
 */

export interface LocalMediaTargets {
  /** settings.server.url，端口 6005 的映射目标 */
  vcpServerUrl?: string | null;
  /** settings.sync.httpUrl，端口 5974 的映射目标 */
  syncHttpUrl?: string | null;
}

const PORT_TO_TARGET: Record<string, keyof LocalMediaTargets> = {
  "6005": "vcpServerUrl",
  "5974": "syncHttpUrl",
};

const HTTP_AUTHORITY_RE = /^https?:\/\/[^/?#]*/i;

/** localhost / 127.x / ::1 / 10.x / 172.16-31.x / 192.168.x */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((part) => Number(part) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function httpOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** 纯函数：输入原始 URL 与目标设置，输出显示用 URL；不满足改写条件时原样返回。 */
export function rewriteLocalMediaUrl(value: string, targets: LocalMediaTargets): string {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!HTTP_AUTHORITY_RE.test(trimmed)) return value;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return value;
  }

  const targetKey = PORT_TO_TARGET[parsed.port];
  if (!targetKey || !isLocalOrPrivateHost(parsed.hostname)) return value;

  const targetOrigin = httpOrigin(targets[targetKey]);
  if (!targetOrigin || targetOrigin === parsed.origin) return value;

  // 只替换 scheme://authority，path/query（含 /pw= 段）/hash 保留原始字节，不经 URL 规范化。
  return trimmed.replace(HTTP_AUTHORITY_RE, targetOrigin);
}

const EMPTY_TARGETS: LocalMediaTargets = Object.freeze({});

/**
 * 软读取当前设置：不 import settings store（避免循环依赖与测试 vi.mock 缺导出），
 * 直接读活跃 pinia 中 "settings" 的 snapshot 状态；无 pinia 或未加载设置时返回空目标（即不改写）。
 */
export function currentLocalMediaTargets(): LocalMediaTargets {
  const pinia = getActivePinia();
  type Snapshot = { data?: { server?: { url?: string }; sync?: { httpUrl?: string } } | null } | null;
  const data = (pinia?.state.value.settings as { snapshot?: Snapshot } | undefined)?.snapshot?.data;
  if (!data) return EMPTY_TARGETS;
  return { vcpServerUrl: data.server?.url, syncHttpUrl: data.sync?.httpUrl };
}
