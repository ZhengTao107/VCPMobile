import { describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { diffSettingsPatch, type AppSettings } from '@/core/stores/settings';
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

describe('VcpCoreSettingsSection connection profiles', () => {
  const field = (wrapper: ReturnType<typeof mount>, label: string) =>
    wrapper.findAll('.settings-field').find((item) => item.text().includes(label))!.find('input');
  const action = (wrapper: ReturnType<typeof mount>, name: string) =>
    wrapper.find(`[data-profile-action="${name}"]`);
  const pick = async (wrapper: ReturnType<typeof mount>, name: string) =>
    wrapper.findAll('[aria-label="连接档案"] [role="radio"]').find((b) => b.text().includes(name))!.trigger('click');

  it('rendering leaves settings untouched and shows only the single upstream field group', async () => {
    const settings = reactive(baseSettings());
    const wrapper = mount(VcpCoreSettingsSection, { props: { settings } });
    await flushPromises();
    expect(diffSettingsPatch(baseSettings(), settings)).toEqual({});
    expect(wrapper.text()).not.toContain('单一地址');
    expect(wrapper.text()).not.toContain('本机 Chat URL');
    expect(wrapper.text()).not.toContain('服务器 Chat URL');
    expect(action(wrapper, 'apply').attributes('disabled')).toBeDefined();
  });

  it('存为档案 copies the in-use fields into a new named profile and saves', async () => {
    const settings = reactive(baseSettings());
    const onSaveRequest = vi.fn();
    const wrapper = mount(VcpCoreSettingsSection, { props: { settings, onSaveRequest } });
    await field(wrapper, '档案名称').setValue('公司');
    await action(wrapper, 'save').trigger('click');

    expect(settings.connectionProfiles).toHaveLength(1);
    expect(settings.connectionProfiles![0]).toMatchObject({
      name: '公司',
      vcpServerUrl: 'https://legacy.example',
      vcpApiKey: 'legacy-key',
      syncToken: 'sync-token',
    });
    expect(onSaveRequest).toHaveBeenCalledTimes(1);
  });

  it('选用 writes the non-empty profile fields into the in-use group; 删除 removes it', async () => {
    const settings = reactive({
      ...baseSettings(),
      connectionProfiles: [{
        id: 'p-home', name: '家里',
        vcpServerUrl: 'http://192.168.1.5:6005', chatEndpointMode: 'vcpTools', vcpApiKey: 'sk-fake-home-1111',
        vcpLogUrl: 'ws://192.168.1.5:6005', vcpLogKey: '', fileKey: '',
        syncHttpUrl: '', syncServerUrl: '', syncToken: '',
      }],
    });
    const onSaveRequest = vi.fn();
    const wrapper = mount(VcpCoreSettingsSection, { props: { settings, onSaveRequest } });
    await pick(wrapper, '家里');
    await action(wrapper, 'apply').trigger('click');

    expect(settings.vcpServerUrl).toBe('http://192.168.1.5:6005');
    expect(settings.chatEndpointMode).toBe('vcpTools');
    expect(settings.vcpLogUrl).toBe('ws://192.168.1.5:6005');
    expect(settings.syncToken).toBe('sync-token');
    expect(onSaveRequest).toHaveBeenCalledTimes(1);

    await pick(wrapper, '家里');
    await action(wrapper, 'delete').trigger('click');
    expect(settings.connectionProfiles).toEqual([]);
    expect(settings.vcpServerUrl).toBe('http://192.168.1.5:6005');
  });

  it('同名存为档案覆盖原档案，不新增', async () => {
    const settings = reactive(baseSettings());
    const wrapper = mount(VcpCoreSettingsSection, { props: { settings } });
    await field(wrapper, '档案名称').setValue('公司');
    await action(wrapper, 'save').trigger('click');
    const firstId = settings.connectionProfiles![0].id;
    settings.vcpServerUrl = 'https://new.example';
    await field(wrapper, '档案名称').setValue('公司');
    await action(wrapper, 'save').trigger('click');
    expect(settings.connectionProfiles).toHaveLength(1);
    expect(settings.connectionProfiles![0]).toMatchObject({ id: firstId, vcpServerUrl: 'https://new.example' });
  });
});
