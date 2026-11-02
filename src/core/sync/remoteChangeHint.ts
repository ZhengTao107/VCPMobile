import { watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getActivePinia } from "pinia";
import type { AppSettings } from "../stores/settings";
import { useSettingsStore } from "../stores/settings";
import { isAutoSyncReady, requestAutoSync } from "./autoSyncTrigger";

/**
 * 订阅电脑端 VCPMobileSyncHint（ptp4g#29）：前台、自动同步就绪且配置了同步 HTTP 地址时，
 * 对 `{syncHttpUrl}/api/mobile-sync-hint/wait` 做长轮询；电脑端 revision 变化后调用
 * requestAutoSync('remote-hint')，防抖与单飞交给 autoSyncTrigger。
 *
 * - 游标 {instanceId, revision} 只存内存；冷启动或换地址/Token 后的首轮只建立游标、不触发同步。
 * - 切后台：立即停循环并中止在途请求，保留游标；回前台用原游标续订。
 * - 404 视为电脑端未装插件，5 分钟后再试；401/503/网络错误/响应格式不符按 2s→60s 指数退避。
 * - HTTP 经 Rust command（sync_hint_wait）发出，原因见 src-tauri/.../sync/sync_hint.rs。
 */
export const HINT_WAIT_MS = 25_000;
/** 两次请求的最小间隔，防止服务端异常地立即返回时空转。 */
export const HINT_MIN_CYCLE_MS = 1_000;
export const HINT_BACKOFF_BASE_MS = 2_000;
export const HINT_BACKOFF_MAX_MS = 60_000;
export const HINT_MISSING_PLUGIN_MS = 5 * 60_000;

export interface HintTarget {
  baseUrl: string;
  token: string;
}

export interface HintWaitRequest {
  requestId: string;
  baseUrl: string;
  token: string;
  since?: number;
  instance?: string;
  timeoutMs: number;
}

export interface HintWaitResponse {
  status: number;
  body: unknown;
}

interface HintCursor {
  instanceId: string;
  revision: number;
}

export interface RemoteChangeHintDeps {
  wait: (request: HintWaitRequest) => Promise<HintWaitResponse>;
  cancel: (requestId: string) => unknown;
  onChange: () => void;
  now?: () => number;
}

export interface RemoteChangeHint {
  /** 传 null 停止（保留游标）；目标变化时清游标并重启；相同目标且在运行时不做任何事。 */
  update: (target: HintTarget | null) => void;
  dispose: () => void;
}

export function hintTargetFromSettings(
  settings: AppSettings | null | undefined,
  foreground: boolean,
): HintTarget | null {
  if (!foreground || !isAutoSyncReady(settings)) return null;
  const baseUrl = settings?.sync.httpUrl?.trim() ?? "";
  const token = settings?.sync.token?.trim() ?? "";
  return baseUrl && token ? { baseUrl, token } : null;
}

type Outcome =
  | { kind: "ok"; cursor: HintCursor; changed: boolean }
  | { kind: "missing" }
  | { kind: "error"; detail: string };

const classify = (response: HintWaitResponse): Outcome => {
  if (response.status === 404) return { kind: "missing" };
  if (response.status !== 200) return { kind: "error", detail: `HTTP ${response.status}` };
  const body = response.body;
  if (body && typeof body === "object") {
    const { instanceId, revision, changed } = body as Record<string, unknown>;
    if (
      typeof instanceId === "string" && instanceId.length > 0 &&
      typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 &&
      typeof changed === "boolean"
    ) {
      return { kind: "ok", cursor: { instanceId, revision }, changed };
    }
  }
  return { kind: "error", detail: "malformed response" };
};

const sameTarget = (a: HintTarget | null, b: HintTarget | null) =>
  !!a && !!b && a.baseUrl === b.baseUrl && a.token === b.token;

export function createRemoteChangeHint(deps: RemoteChangeHintDeps): RemoteChangeHint {
  const now = deps.now ?? Date.now;
  let target: HintTarget | null = null;
  let running = false;
  let cursor: HintCursor | null = null;
  let generation = 0;
  let inFlight: string | null = null;
  let wake: (() => void) | null = null;
  let failures = 0;
  let seq = 0;

  const cancelInFlight = () => {
    const requestId = inFlight;
    inFlight = null;
    if (!requestId) return;
    try {
      void Promise.resolve(deps.cancel(requestId)).catch(() => undefined);
    } catch {
      // 取消只是加速收尾；失败时请求会在超时后自然结束，结果按代际丢弃。
    }
  };

  const halt = () => {
    generation += 1;
    running = false;
    cancelInFlight();
    wake?.();
  };

  const sleep = (ms: number, gen: number) =>
    new Promise<void>((resolve) => {
      if (gen !== generation) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        if (wake === done) wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });

  const loop = async (gen: number, active: HintTarget) => {
    while (gen === generation) {
      seq += 1;
      const requestId = `sync-hint-${now().toString(36)}-${seq}`;
      inFlight = requestId;
      const startedAt = now();
      let outcome: Outcome;
      try {
        outcome = classify(await deps.wait({
          requestId,
          baseUrl: active.baseUrl,
          token: active.token,
          since: cursor?.revision,
          instance: cursor?.instanceId,
          timeoutMs: HINT_WAIT_MS,
        }));
      } catch (error) {
        outcome = { kind: "error", detail: String(error) };
      }
      if (inFlight === requestId) inFlight = null;
      if (gen !== generation) return;

      let delay: number;
      if (outcome.kind === "ok") {
        failures = 0;
        const established = cursor !== null;
        cursor = outcome.cursor;
        if (outcome.changed && established) {
          try {
            deps.onChange();
          } catch (error) {
            console.warn("[RemoteChangeHint] onChange failed:", error);
          }
        }
        delay = Math.max(0, HINT_MIN_CYCLE_MS - (now() - startedAt));
      } else if (outcome.kind === "missing") {
        failures = 0;
        delay = HINT_MISSING_PLUGIN_MS;
        console.warn("[RemoteChangeHint] hint endpoint not found (404); desktop plugin missing?");
      } else {
        delay = Math.min(HINT_BACKOFF_BASE_MS * 2 ** failures, HINT_BACKOFF_MAX_MS);
        failures += 1;
        console.warn(`[RemoteChangeHint] wait failed (${outcome.detail}); retry in ${delay}ms`);
      }
      if (delay > 0) await sleep(delay, gen);
    }
  };

  const update = (next: HintTarget | null) => {
    if (!next) {
      if (running) halt();
      return;
    }
    if (running && sameTarget(next, target)) return;
    if (!sameTarget(next, target)) cursor = null;
    halt();
    target = next;
    failures = 0;
    running = true;
    void loop(generation, next);
  };

  return { update, dispose: () => update(null) };
}

let activeDispose: (() => void) | null = null;

/** 应用级单例：由 useAppLifecycle 挂载，返回卸载函数。 */
export function useRemoteChangeHint(isForeground: () => boolean): () => void {
  activeDispose?.();
  // 未装配 pinia 的宿主（部分组件测试）没有设置可读，直接不挂载；真实 App 在 mount 前已 use(pinia)。
  if (!getActivePinia()) return () => {};
  const settingsStore = useSettingsStore();
  const hint = createRemoteChangeHint({
    wait: (request) => invoke<HintWaitResponse>("sync_hint_wait", { ...request }),
    cancel: (requestId) => invoke("sync_hint_cancel", { requestId }),
    onChange: () => requestAutoSync("remote-hint"),
  });
  const stopWatch = watch(
    () => hintTargetFromSettings(settingsStore.settings, isForeground()),
    (next) => hint.update(next),
    { immediate: true },
  );
  const dispose = () => {
    stopWatch();
    hint.dispose();
    if (activeDispose === dispose) activeDispose = null;
  };
  activeDispose = dispose;
  return dispose;
}
