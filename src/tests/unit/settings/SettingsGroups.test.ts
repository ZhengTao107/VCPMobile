import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { diffSettingsPatch, type AppSettings } from '@/core/stores/settings';
import { SETTINGS_GROUPS, findSettingsPage } from '@/features/settings/settingsGroups';
import SyncSettingsSection from '@/features/settings/components/SyncSettingsSection.vue';
import settingsViewSource from '../../../features/settings/SettingsView.vue?raw';

const baseSettings = (): AppSettings => ({
  userName: 'u',
  vcpServerUrl: '',
  chatEndpointMode: 'standard',
  vcpApiKey: '',
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

describe('settings home groups', () => {
  it('orders groups as connection → sync → chat → appearance → advanced', () => {
    expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual([
      'connection',
      'sync',
      'chat',
      'appearance',
      'advanced',
    ]);
    expect(SETTINGS_GROUPS.map((group) => group.title)).toEqual(['连接', '同步', '聊天', '外观', '高级']);
  });

  it('collapses only the advanced group', () => {
    expect(SETTINGS_GROUPS.filter((group) => group.collapsed).map((group) => group.id)).toEqual(['advanced']);
  });

  it('uses unique page ids and resolves every title', () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.pages.map((page) => page.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(findSettingsPage(id)?.title).toBeTruthy();
    expect(findSettingsPage('missing')).toBeUndefined();
    expect(findSettingsPage(null)).toBeUndefined();
  });

  it('renders a subpage branch for every page (about uses the immersive layer)', () => {
    const ids = SETTINGS_GROUPS.flatMap((group) => group.pages.map((page) => page.id));
    for (const id of ids.filter((pageId) => pageId !== 'about')) {
      expect(settingsViewSource).toContain(`visibleSubPage === '${id}'`);
    }
    expect(settingsViewSource).toContain('currentSubPage.value === "about"');
    expect(settingsViewSource).not.toContain("visibleSubPage === 'advanced'");
  });
});

describe('SyncSettingsSection auto sync switch', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const switchOf = (wrapper: ReturnType<typeof mount>) =>
    wrapper.find('[data-setting="autoSync"] .settings-switch');

  it('shows on by default without writing a patch', () => {
    const settings = reactive(baseSettings());
    const wrapper = mount(SyncSettingsSection, { props: { settings } });
    expect(switchOf(wrapper).find('.translate-x-5').exists()).toBe(true);
    expect(diffSettingsPatch(baseSettings(), settings)).toEqual({});
  });

  it('toggles settings.autoSync explicitly', async () => {
    const settings = reactive(baseSettings());
    const wrapper = mount(SyncSettingsSection, { props: { settings } });
    await switchOf(wrapper).trigger('click');
    expect(settings.autoSync).toBe(false);
    await switchOf(wrapper).trigger('click');
    expect(settings.autoSync).toBe(true);
  });

  it('reflects an explicit false', () => {
    const settings = reactive({ ...baseSettings(), autoSync: false });
    const wrapper = mount(SyncSettingsSection, { props: { settings } });
    expect(switchOf(wrapper).find('.translate-x-0').exists()).toBe(true);
  });
});
