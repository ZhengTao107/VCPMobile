import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { useNotificationProcessor } from '@/core/composables/useNotificationProcessor';
import { useNotificationStore } from '@/core/stores/notification';

describe('VCPLog tool receipts stay out of floating toasts', () => {
  let pinia: Pinia;

  beforeEach(() => {
    vi.useFakeTimers();
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    disposePinia(pinia);
    vi.useRealTimers();
  });

  it.each([
    ['ProjectForge', 'success', 'tool', 'ProjectForge 执行成功'],
    ['CodeSearcher', 'success', 'tool', 'CodeSearcher 执行成功'],
    ['DailyNote', 'success', 'success', 'DailyNote 执行成功'],
    ['PowerShellExecutor', 'error', 'error', 'PowerShellExecutor 执行失败'],
  ])('%s %s receipt goes to history only', (tool_name, status, type, title) => {
    const { processPayload } = useNotificationProcessor();
    const store = useNotificationStore();

    const processed = processPayload({
      type: 'vcp_log',
      data: { tool_name, status, content: status === 'error' ? '执行错误: {"plugin_error":"boom"}' : 'done' },
    });
    expect(processed).toMatchObject({ historyOnly: true, type, title, silent: false });

    store.addNotification(processed);
    expect(store.activeToasts).toHaveLength(0);
    expect(store.historyList).toHaveLength(1);
    expect(store.historyList[0].title).toBe(title);
    expect(store.unreadCount).toBe(1);
  });

  it('keeps tool approval requests as floating toasts', () => {
    const { processPayload } = useNotificationProcessor();
    const store = useNotificationStore();

    store.addNotification(processPayload({
      type: 'tool_approval_request',
      data: { requestId: 'r1', toolName: 'ServerPowerShellExecutor', maid: '小雪', args: { command: 'ls' } },
    }));

    expect(store.activeToasts).toHaveLength(1);
    expect(store.activeToasts[0].actions).toHaveLength(2);
    expect(store.historyList).toHaveLength(1);
  });

  it('keeps core engine errors as floating toasts', () => {
    const { processPayload } = useNotificationProcessor();
    const store = useNotificationStore();

    store.addNotification(processPayload({ type: 'vcp-core-status', status: 'error', message: 'crashed' }));

    expect(store.activeToasts).toHaveLength(1);
    expect(store.activeToasts[0]).toMatchObject({ type: 'error', title: '核心引擎异常' });
  });

  it('leaves non-receipt VCPLog entries unchanged', () => {
    const { processPayload } = useNotificationProcessor();
    const store = useNotificationStore();

    const processed = processPayload({
      type: 'vcp_log',
      data: { source: 'DistPluginManager', content: '分布式节点已注册 3 个插件' },
    });
    expect(processed.historyOnly).toBe(false);

    store.addNotification(processed);
    expect(store.activeToasts).toHaveLength(1);
    expect(store.historyList).toHaveLength(1);
  });
});
