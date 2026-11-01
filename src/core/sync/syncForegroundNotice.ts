import { invoke } from "@tauri-apps/api/core";

/**
 * 手动同步的 Android 通知栏进度。
 *
 * Rust 同步会话已用 ForegroundTask::Sync（tag `sync:N`，优先级 40，文案「[数据同步] VCP Mobile」）
 * 经 ForegroundGuardian 拉起 StreamKeepaliveService。这里以更高优先级的固定 tag 再挂一个消费者，
 * 只为让同一条前台通知显示阶段进度，不另起服务、不改 FGS 类型。
 * 同 tag 重复 acquire 幂等：Guardian 更新文案，并重置该 tag 的 `sync:` 前缀 30 分钟超时。
 */
export const SYNC_NOTICE_TAG = "sync:ui";
export const SYNC_NOTICE_PRIORITY = 41;
export const SYNC_NOTICE_THROTTLE_MS = 3000;

export const formatSyncNoticeLabel = (
  phaseLabel: string,
  completed: number,
  total: number,
): string =>
  total > 0
    ? `VCP 正在同步 · ${phaseLabel} ${completed}/${total}`
    : `VCP 正在同步 · ${phaseLabel}`;

export function createSyncForegroundNotice(throttleMs = SYNC_NOTICE_THROTTLE_MS) {
  let active = false;
  let sentLabel = "";
  let lastSentAt = 0;
  let pendingLabel: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // acquire 会等待服务就绪；串行投递保证 release 不会越过仍在途的 acquire 留下孤儿消费者。
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = (command: string, args: Record<string, unknown>) => {
    chain = chain
      .then(() => invoke(`plugin:vcp-mobile|${command}`, args))
      .catch((error) => console.warn(`[SyncNotice] ${command} failed:`, error));
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingLabel = null;
  };

  const send = (label: string) => {
    active = true;
    sentLabel = label;
    lastSentAt = Date.now();
    enqueue("acquire_foreground", {
      tag: SYNC_NOTICE_TAG,
      priority: SYNC_NOTICE_PRIORITY,
      label,
      screenKeepOn: false,
    });
  };

  const show = (label: string) => {
    if (active && label === sentLabel) return;
    const wait = active ? lastSentAt + throttleMs - Date.now() : 0;
    if (wait <= 0) {
      clearTimer();
      send(label);
      return;
    }
    pendingLabel = label;
    if (timer) return;
    timer = setTimeout(() => {
      const next = pendingLabel;
      timer = null;
      pendingLabel = null;
      if (active && next !== null && next !== sentLabel) send(next);
    }, wait);
  };

  const hide = () => {
    clearTimer();
    if (!active) return;
    active = false;
    sentLabel = "";
    enqueue("release_foreground", { tag: SYNC_NOTICE_TAG });
  };

  return { show, hide };
}
