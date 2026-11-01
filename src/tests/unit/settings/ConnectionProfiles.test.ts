import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, reactive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { emitTauriEvent, invokeMock, mockInvoke } from '../../mocks/tauri';
import { getEffectiveVcpConnection } from '@/core/utils/effectiveVcpConnection';
import {
  CONNECTION_FALLBACK_EVENT,
  CONNECTION_FALLBACK_MESSAGE,
  useConnectionProbe,
} from '@/core/composables/useConnectionProbe';
import { diffSettingsPatch, useSettingsStore, type AppSettings } from '@/core/stores/settings';
import { useNotificationStore } from '@/core/stores/notification';
import VcpCoreSettingsSection from '@/features/settings/components/VcpCoreSettingsSection.vue';

const baseSettings = (): AppSettings => ({
  userName: 'u',
  vcpServerUrl: 'https://legacy.example',
  chatEndpointMode: 'standard',
  vcpApiKey: 'legacy-key',
  vcpLogUrl: '',
  vcpLogKey: '',
  syncServerUrl: 'ws://sync.example',
  syncHttpUrl: 'http://sync.example',
  syncToken: 'sync-token',
  adminUsername: '',
  adminPassword: '',
  fileKey: '',
  topicSummaryModel: '',
  syncLogLevel: 'INFO',
  agentOrder: [],
  groupOrder: [],
  currentThemeMode: null,
  syncPrerenderEnabled: false,
  enableAssistant: false,
  assistantAgentId: '',
  distributedEnabled: false,
  distributedWsUrl: '',
  distributedVcpKey: '',
  distributedDeviceName: '',
});

const probeCalls = () => invokeMock.mock.calls.filter(([command]) => command === 'refresh_connection_probe');

describe('getEffectiveVcpConnection', () => {
  it('returns the Rust-resolved endpoint', async () => {
    mockInvoke('get_effective_vcp_connection', () => ({
      vcpServerUrl: 'https://vcp.example.com',
      vcpApiKey: 'server-key',
      source: 'server',
    }));
    await expect(getEffectiveVcpConnection()).resolves.toEqual({
      vcpServerUrl: 'https://vcp.example.com',
      vcpApiKey: 'server-key',
      source: 'server',
    });
  });

  it('returns null when resolution fails', async () => {
    mockInvoke('get_effective_vcp_connection', () => Promise.reject(new Error('not ready')));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(getEffectiveVcpConnection()).resolves.toBeNull();
  });
});

describe('useConnectionProbe', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const mountProbe = () =>
    mount(defineComponent({
      setup() {
        useConnectionProbe();
        return () => h('div');
      },
    }));

  it('does not probe outside auto mode', async () => {
    useSettingsStore().settings = { ...baseSettings(), connectionProfileMode: 'local' };
    mountProbe();
    window.dispatchEvent(new Event('online'));
    await flushPromises();
    expect(probeCalls()).toHaveLength(0);
  });

  it('probes on startup and when the device comes online in auto mode', async () => {
    useSettingsStore().settings = { ...baseSettings(), connectionProfileMode: 'auto' };
    const wrapper = mountProbe();
    await flushPromises();
    expect(probeCalls()).toHaveLength(1);

    window.dispatchEvent(new Event('online'));
    emitTauriEvent('vcp-network-changed', { connected: true });
    await flushPromises();
    expect(probeCalls()).toHaveLength(3);

    wrapper.unmount();
    window.dispatchEvent(new Event('online'));
    expect(probeCalls()).toHaveLength(3);
  });

  it('shows one toast per fallback event', async () => {
    useSettingsStore().settings = { ...baseSettings(), connectionProfileMode: 'auto' };
    const notify = vi.spyOn(useNotificationStore(), 'addNotification').mockImplementation(() => undefined as never);
    mountProbe();
    await flushPromises();
    emitTauriEvent(CONNECTION_FALLBACK_EVENT, { from: 'local', to: 'server' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      message: CONNECTION_FALLBACK_MESSAGE,
      toastOnly: true,
    }));
  });
});

describe('VcpCoreSettingsSection connection profiles', () => {
  const field = (wrapper: ReturnType<typeof mount>, label: string) =>
    wrapper.findAll('.settings-field').find((item) => item.text().includes(label))!.find('input');

  it('rendering leaves legacy settings untouched', async () => {
    const settings = reactive(baseSettings());
    const wrapper = mount(VcpCoreSettingsSection, { props: { settings } });
    await flushPromises();
    expect(diffSettingsPatch(baseSettings(), settings)).toEqual({});
    expect(wrapper.find('[aria-label="连接档案"] [role="radio"][aria-checked="true"]').text()).toContain('单一地址');
  });

  it('edits profiles and mode without touching legacy or sync fields', async () => {
    const settings = reactive(baseSettings());
    const wrapper = mount(VcpCoreSettingsSection, { props: { settings } });
    await field(wrapper, '本机 Chat URL').setValue('http://192.168.1.5:6005');
    await field(wrapper, '服务器 API Key').setValue('server-key');
    const server = wrapper
      .findAll('[aria-label="连接档案"] [role="radio"]')
      .find((button) => button.text().includes('固定使用「服务器」档案'))!;
    await server.trigger('click');

    expect(diffSettingsPatch(baseSettings(), settings)).toEqual({
      connectionProfileMode: 'server',
      connectionProfiles: [
        { name: '本机', vcpServerUrl: 'http://192.168.1.5:6005', vcpApiKey: '' },
        { name: '服务器', vcpServerUrl: '', vcpApiKey: 'server-key' },
      ],
    });

    const single = wrapper.findAll('[role="radio"]').find((button) => button.text().includes('单一地址'))!;
    await single.trigger('click');
    expect(settings.connectionProfileMode).toBeNull();
  });

  it('does not offer auto for active selection', async () => {
    const settings = reactive(baseSettings());
    const wrapper = mount(VcpCoreSettingsSection, { props: { settings } });
    const titles = wrapper.findAll('[aria-label="连接档案"] [role="radio"]').map((button) => button.text());
    expect(titles).toHaveLength(3);
    expect(titles.some((text) => text.includes('自动'))).toBe(false);
  });

  it('keeps a legacy auto value visible and selected until another mode is chosen', async () => {
    const settings = reactive({ ...baseSettings(), connectionProfileMode: 'auto' as const });
    const wrapper = mount(VcpCoreSettingsSection, { props: { settings } });
    expect(wrapper.find('[aria-label="连接档案"] [role="radio"][aria-checked="true"]').text()).toContain('自动（旧设置）');

    const local = wrapper
      .findAll('[aria-label="连接档案"] [role="radio"]')
      .find((button) => button.text().includes('固定使用「本机」档案'))!;
    await local.trigger('click');
    expect(settings.connectionProfileMode).toBe('local');
    const titles = wrapper.findAll('[aria-label="连接档案"] [role="radio"]').map((button) => button.text());
    expect(titles.some((text) => text.includes('自动'))).toBe(false);
  });
});
