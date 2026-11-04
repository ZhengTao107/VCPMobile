import { onMounted, onUnmounted, ref, watch } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useAppLifecycleStore } from '../stores/appLifecycle';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { useRagObserverStore } from '../stores/ragObserver';
import { requestAutoSync } from '../sync/autoSyncTrigger';
import { useRemoteChangeHint } from '../sync/remoteChangeHint';
import { useSettingsRemote } from '../sync/settingsRemote';
import { useSidechatRemote } from '../sync/sidechatRemote';
import { useLibraryRemote } from '../sync/libraryRemote';
import { isIOS } from '../utils/platform';
import type { LifecycleSnapshotDto } from '../types/lifecycle';
import { createVoiceHistorySync } from '../../features/chat/voice/voiceHistorySync';

export function useAppLifecycle() {
  const lifecycleStore = useAppLifecycleStore();
  const streamStore = useChatStreamStore();
  const infoStore = useRagObserverStore();
  const voiceHistory = createVoiceHistorySync();
  let unlisten: UnlistenFn | null = null;
  let unlistenNetwork: UnlistenFn | null = null;
  let recoveryPromise: Promise<void> | null = null;
  let disposed = false;
  const documentHidden = ref(document.hidden);
  const activeEpoch = ref<number | null>(null);
  const visibleEpoch = ref(0);

  const reconcileInterruptedStreams = (source: string) => {
    if (disposed || lifecycleStore.state !== 'READY' || documentHidden.value) return;
    if (lifecycleStore.lifecycleSnapshot?.phase !== 'active') return;
    if (recoveryPromise) return recoveryPromise;
    console.log(`[useAppLifecycle] ${source}. Triggering stream recovery.`);
    recoveryPromise = Promise.allSettled([
      streamStore.checkAndRecoverInterruptedStreams(),
      voiceHistory.reconcile(),
    ]).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(`[useAppLifecycle] Recovery failed (${source}):`, result.reason);
        }
      }
    }).finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };

  // 中断流恢复属于应用生命周期调和：冷启动、WebView 重载均由 READY 转换覆盖。
  watch(
    () => lifecycleStore.state,
    (state, previous) => {
      if (state === 'READY' && previous !== 'READY') {
        void reconcileInterruptedStreams('Core ready');
      }
    },
  );

  // Browser visibility only pauses rendering. It never overwrites the native phase.
  watch([() => lifecycleStore.lifecycleSnapshot?.phase, documentHidden], ([phase, hidden]) => {
    const paused = hidden || (phase !== undefined && phase !== 'active');
    document.documentElement.classList.toggle('vcp-paused-animations', paused);
  }, { immediate: true });

  // Native transitions and visibility can arrive together after JS thaws.
  // Only delivered wake signals start a read; applying its snapshot cannot start another.
  watch([() => lifecycleStore.lifecycleSnapshot?.phase, activeEpoch, visibleEpoch],
    ([phase, epoch, visible], [previousPhase, previousEpoch, previousVisible]) => {
      if (disposed || documentHidden.value) return;
      const woke = visible !== previousVisible || (phase === 'active' && epoch !== previousEpoch
        && lifecycleStore.lifecycleSnapshot?.transitionEpoch === epoch);
      if (woke) {
        void lifecycleStore.hydrateSystemStatus();
        void infoStore.refresh();
      }
      // A snapshot read on visibility may be the first authoritative active phase.
      if (woke || (phase === 'active' && phase !== previousPhase)) {
        // fork ptp4g#4：中断流调和后触发自动同步（防抖与开关由 autoSyncTrigger 负责）。
        void Promise.resolve(reconcileInterruptedStreams('App foreground'))
          .then(() => requestAutoSync('App foreground'));
      }
    });

  // 电脑端数据变化提示：仅前台时长轮询；切后台中止在途请求，回前台续订。
  const isForeground = () => {
    if (documentHidden.value) return false;
    const phase = lifecycleStore.lifecycleSnapshot?.phase;
    if (isIOS && !phase) return false;
    return !phase || phase === 'active';
  };
  const disposeRemoteHint = useRemoteChangeHint(isForeground);
  // 电脑端设置（用户名、明暗）：前台目标出现时拉取，本机变化防抖上推。
  const disposeSettingsRemote = useSettingsRemote(isForeground);
  // 子话题文件通道：前台目标出现与 remote-hint 时增量拉取（只拉不推）。
  const disposeSidechatRemote = useSidechatRemote(isForeground);
  // 提示词仓库/预设（只读镜像）与模型收藏（双向，冲突以电脑端为准）。
  const disposeLibraryRemote = useLibraryRemote(isForeground);

  const handleVisibilityChange = () => {
    documentHidden.value = document.hidden;
    if (!documentHidden.value) visibleEpoch.value++;
  };

  onMounted(async () => {
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Android and iOS native callbacks are the sole network recovery signal.
    // A satisfied path is a retry hint, not proof that the configured server is reachable.
    void listen<{ connected: boolean }>('vcp-network-changed', (event) => {
      if (event.payload.connected === true) {
        void Promise.resolve(reconcileInterruptedStreams('Native network online'))
          .then(() => requestAutoSync('Native network online'));
      }
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlistenNetwork = stopListening;
    }).catch((err) => {
      console.error('[useAppLifecycle] Failed to setup native network listener:', err);
    });

    try {
      const stopListening = await listen<LifecycleSnapshotDto>('vcp-lifecycle-changed', (event) => {
        if (disposed) return;
        lifecycleStore.applyLifecycleSnapshot(event.payload);
        const current = lifecycleStore.lifecycleSnapshot;
        if (current?.phase === 'active' && current.transitionEpoch === event.payload.transitionEpoch
          && event.payload.phase === 'active') {
          activeEpoch.value = current.transitionEpoch;
        }
      });
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
      // Subscribe first, then replay the owner snapshot. Epoch ordering handles races.
      await lifecycleStore.hydrateSystemStatus();
    } catch (err) {
      console.error("[useAppLifecycle] Failed to setup Tauri lifecycle listener:", err);
    }
  });

  onUnmounted(() => {
    disposed = true;
    disposeRemoteHint();
    voiceHistory.dispose();
    disposeSettingsRemote();
    disposeSidechatRemote();
    disposeLibraryRemote();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    if (unlisten) {
      unlisten();
    }
    if (unlistenNetwork) {
      unlistenNetwork();
    }
  });
}
