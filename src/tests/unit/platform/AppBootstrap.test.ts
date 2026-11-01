import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { useAppLifecycleStore } from '../../../core/stores/appLifecycle';
import { useNotificationStore } from '../../../core/stores/notification';
import { useNotificationProcessor } from '../../../core/composables/useNotificationProcessor';
import { invokeMock, mockInvoke } from '../../mocks/tauri';

const testPlatform = vi.hoisted(() => ({ value: null as 'android' | 'ios' | null }));
vi.mock('../../../core/utils/platform', () => ({
  get nativePlatform() { return testPlatform.value; },
  get isAndroid() { return testPlatform.value === 'android'; },
  get isIOS() { return testPlatform.value === 'ios'; },
}));

vi.mock('../../../core/stores/assistant', () => ({
  useAssistantStore: () => ({ fetchAgentsAndGroups: async () => {} }),
}));
vi.mock('../../../core/stores/settings', () => ({
  useSettingsStore: () => ({ fetchSettings: async () => {} }),
}));
vi.mock('../../../core/stores/theme', () => ({
  useThemeStore: () => ({ initTheme: async () => {} }),
}));
vi.mock('../../../core/stores/chatSessionStore', () => ({
  useChatSessionStore: () => ({
    currentSelectedItem: null,
    currentTopicId: null,
    reconcileCurrentConversation: () => {},
  }),
}));
vi.mock('../../../core/stores/chatHistoryStore', () => ({
  useChatHistoryStore: () => ({ preloadHistory: async () => {} }),
}));
vi.mock('../../../core/stores/topicListManager', () => ({
  useTopicStore: () => ({ loadTopicList: async () => {} }),
}));
vi.mock('../../../core/stores/avatar', () => ({
  useAvatarStore: () => ({ preloadMetadata: async () => {} }),
}));
vi.mock('../../../core/utils/bootTrace', () => ({
  bootMark: () => {},
  reportBootTrace: async () => {},
  trackBootStage: (_name: string, promise: Promise<unknown>) => promise,
}));

describe('platform-aware bootstrap', () => {
  let pinia: Pinia;
  let backgroundServiceFailures: Array<'guardian' | 'helper' | 'events'>;

  beforeEach(() => {
    testPlatform.value = null;
    localStorage.clear();
    pinia = createPinia();
    setActivePinia(pinia);
    backgroundServiceFailures = [];
    mockInvoke('get_system_snapshot', () => ({
      lifecycle: null,
      core: 'ready',
      message: 'ready',
      log: 'connected',
      sync: 'disconnected',
      databaseRecovery: null,
      backgroundServiceFailures,
    }));
  });

  afterEach(() => {
    disposePinia(pinia);
    vi.useRealTimers();
  });

  it.each(['realtime', 'snapshot'])('accepts a retained events failure once when %s arrives first', async first => {
    vi.useFakeTimers();
    backgroundServiceFailures = ['events'];
    const lifecycle = useAppLifecycleStore();
    const store = useNotificationStore();
    const { processPayload } = useNotificationProcessor();
    const deliverRealtime = () => store.addNotification(processPayload({
      type: 'vcp-background-service-error', service: 'events',
    }));

    if (first === 'realtime') deliverRealtime();
    else await lifecycle.hydrateSystemStatus();
    const firstTimestamp = store.historyList[0].timestamp;

    vi.advanceTimersByTime(60_000);
    if (first === 'realtime') await lifecycle.hydrateSystemStatus();
    else deliverRealtime();

    expect(store.historyList).toHaveLength(1);
    expect(store.activeToasts).toHaveLength(1);
    expect(store.unreadCount).toBe(1);
    expect(store.historyList[0].timestamp).toBe(firstTimestamp);
    expect(store.activeToasts[0].timestamp).toBe(firstTimestamp);
  });

  it('does not restore a cleared events notice when the same WebView hydrates again', async () => {
    vi.useFakeTimers();
    backgroundServiceFailures = ['events'];
    const lifecycle = useAppLifecycleStore();
    const store = useNotificationStore();
    await lifecycle.hydrateSystemStatus();
    store.activeToasts = [];
    store.clearHistory();

    vi.advanceTimersByTime(60_000);
    await lifecycle.hydrateSystemStatus();

    expect(store.historyList).toHaveLength(0);
    expect(store.activeToasts).toHaveLength(0);
    expect(store.unreadCount).toBe(0);
  });

  it('replays the retained events failure into a new WebView Pinia', async () => {
    backgroundServiceFailures = ['events'];
    await useAppLifecycleStore().hydrateSystemStatus();
    const oldStore = useNotificationStore();
    expect(oldStore.historyList).toHaveLength(1);

    disposePinia(pinia);
    pinia = createPinia();
    setActivePinia(pinia);
    await useAppLifecycleStore().hydrateSystemStatus();
    const newStore = useNotificationStore();

    expect(newStore).not.toBe(oldStore);
    expect(newStore.historyList).toHaveLength(1);
    expect(newStore.activeToasts).toHaveLength(1);
    expect(newStore.unreadCount).toBe(1);
    expect(newStore.historyList[0].id).toBe('vcp_background_service_error_events');
  });

  it.each(['denied', 'authorized', 'provisional', 'unknown'])('does not block iOS chat when notification permission is %s', async authorization => {
    testPlatform.value = 'ios';
    mockInvoke('plugin:vcp-mobile|get_notification_permission', () => ({ authorization }));
    const lifecycle = useAppLifecycleStore();

    await lifecycle.bootstrap();

    expect(lifecycle.state).toBe('READY');
    expect(invokeMock).toHaveBeenCalledWith('get_system_snapshot');
    expect(invokeMock.mock.calls.filter(([command]) => command.startsWith('plugin:vcp-mobile|')).map(([command]) => command))
      .toEqual(['plugin:vcp-mobile|get_notification_permission']);
    expect(useNotificationStore().historyList).toHaveLength(0);
  });

  it('lets an iOS user skip the first optional introduction without faking OS authorization or showing it again', async () => {
    testPlatform.value = 'ios';
    mockInvoke('plugin:vcp-mobile|get_notification_permission', () => ({ authorization: 'notDetermined' }));
    const lifecycle = useAppLifecycleStore();
    await lifecycle.bootstrap();
    expect(lifecycle.state).toBe('PERMISSIONS');
    await lifecycle.continueFromPermissionGuide();
    expect(lifecycle.state).toBe('READY');
    expect(invokeMock).not.toHaveBeenCalledWith('plugin:vcp-mobile|request_notification_permission');

    disposePinia(pinia);
    pinia = createPinia();
    setActivePinia(pinia);
    await useAppLifecycleStore().bootstrap();
    expect(useAppLifecycleStore().state).toBe('READY');
    expect(invokeMock.mock.calls.filter(([command]) => command === 'plugin:vcp-mobile|get_notification_permission')).toHaveLength(1);
  });

  it('continues iOS startup if an optional permission query fails', async () => {
    testPlatform.value = 'ios';
    mockInvoke('plugin:vcp-mobile|get_notification_permission', () => Promise.reject(new Error('native unavailable')));
    await useAppLifecycleStore().bootstrap();
    expect(useAppLifecycleStore().state).toBe('READY');
    expect(useNotificationStore().historyList).toHaveLength(0);
  });

  it('keeps the Android permission gate and rechecks native authorization before entering', async () => {
    testPlatform.value = 'android';
    mockInvoke('plugin:vcp-mobile|check_all_permissions', () => ({ notification: false, battery: true }));
    mockInvoke('plugin:vcp-mobile|check_notification_listener_permission', () => ({ enabled: true }));
    const lifecycle = useAppLifecycleStore();

    await lifecycle.bootstrap();
    expect(lifecycle.state).toBe('PERMISSIONS');
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'plugin:vcp-mobile|check_all_permissions',
      'plugin:vcp-mobile|check_notification_listener_permission',
    ]);

    mockInvoke('plugin:vcp-mobile|check_all_permissions', () => ({ notification: true, battery: true }));
    await lifecycle.bootstrap(true);
    expect(lifecycle.state).toBe('READY');
  });

  it('lets an Android user defer the keep-alive guide once, remembers it with a warning, and forgets it after all grants', async () => {
    testPlatform.value = 'android';
    mockInvoke('plugin:vcp-mobile|check_all_permissions', () => ({ notification: false, battery: true }));
    mockInvoke('plugin:vcp-mobile|check_notification_listener_permission', () => ({ enabled: false }));
    const lifecycle = useAppLifecycleStore();
    await lifecycle.bootstrap();
    expect(lifecycle.state).toBe('PERMISSIONS');

    await lifecycle.continueFromPermissionGuide();
    expect(lifecycle.state).toBe('READY');
    expect(useNotificationStore().historyList.some((item) => item.id === 'startup_permission_skipped')).toBe(true);

    disposePinia(pinia);
    pinia = createPinia();
    setActivePinia(pinia);
    await useAppLifecycleStore().bootstrap();
    expect(useAppLifecycleStore().state).toBe('READY');
    expect(useNotificationStore().historyList.some((item) => item.id === 'startup_permission_skipped')).toBe(true);

    mockInvoke('plugin:vcp-mobile|check_all_permissions', () => ({ notification: true, battery: true }));
    mockInvoke('plugin:vcp-mobile|check_notification_listener_permission', () => ({ enabled: true }));
    disposePinia(pinia);
    pinia = createPinia();
    setActivePinia(pinia);
    await useAppLifecycleStore().bootstrap();
    expect(useAppLifecycleStore().state).toBe('READY');
    expect(localStorage.getItem('vcp_android_permission_skip_v1')).toBeNull();
    expect(useNotificationStore().historyList.some((item) => item.id === 'startup_permission_skipped')).toBe(false);
  });

  it('retains the Android foreground fallback with an explicit warning when its permission query fails', async () => {
    testPlatform.value = 'android';
    mockInvoke('plugin:vcp-mobile|check_all_permissions', async () => { throw new Error('permission query failed'); });

    await useAppLifecycleStore().bootstrap();

    expect(useAppLifecycleStore().state).toBe('READY');
    expect(useNotificationStore().historyList.some((item) => item.id === 'startup_permission_check_failed')).toBe(true);
  });
});
