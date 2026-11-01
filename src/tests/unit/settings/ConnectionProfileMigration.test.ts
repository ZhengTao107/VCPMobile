import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { invokeMock, mockInvoke } from '../../mocks/tauri';
import {
  CONNECTION_PROFILE_FIELDS,
  connectionProfileFromSettings,
  connectionProfilePatch,
  migrateConnectionSettings,
  normalizeConnectionProfiles,
  useSettingsStore,
  type AppSettings,
  type ConnectionProfile,
} from '@/core/stores/settings';

// 以下地址与 Key 均为虚构测试值
const baseSettings = (): AppSettings => ({
  userName: 'u',
  vcpServerUrl: 'https://in-use.example',
  chatEndpointMode: 'standard',
  vcpApiKey: 'sk-fake-in-use-0000',
  vcpLogUrl: 'wss://in-use.example/log',
  vcpLogKey: 'log-fake-0000',
  syncServerUrl: 'ws://sync.example',
  syncHttpUrl: 'http://sync.example',
  syncToken: 'sync-fake-0000',
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

const legacyProfiles = [
  { name: '本机', vcpServerUrl: 'http://192.168.1.5:6005', vcpApiKey: '' },
  { name: '服务器', vcpServerUrl: 'https://vcp.example.com', vcpApiKey: 'sk-fake-server-9876' },
];

const emptyFields = () =>
  Object.fromEntries(CONNECTION_PROFILE_FIELDS.map((field) => [field, ''])) as Record<string, string>;

const profile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile =>
  ({ id: 'p1', name: '公司', ...emptyFields(), ...overrides }) as ConnectionProfile;

describe('normalizeConnectionProfiles', () => {
  it('旧两档按同名转新结构：补 id，缺的字段留空', () => {
    const result = normalizeConnectionProfiles(legacyProfiles);
    expect(result.map((p) => p.name)).toEqual(['本机', '服务器']);
    expect(result[1]).toMatchObject({
      ...emptyFields(),
      name: '服务器',
      vcpServerUrl: 'https://vcp.example.com',
      vcpApiKey: 'sk-fake-server-9876',
    });
    for (const p of result) expect(p.id).toMatch(/\S/);
    expect(new Set(result.map((p) => p.id)).size).toBe(2);
  });

  it('名称自由、数量不限；无名称与非对象项丢弃，已有 id 保留', () => {
    const result = normalizeConnectionProfiles([
      profile({ id: 'keep', name: '家里' }),
      profile({ id: 'b', name: '公司' }),
      profile({ id: 'c', name: '手机热点' }),
      { name: '  ' },
      'junk',
      null,
    ]);
    expect(result.map((p) => [p.id, p.name])).toEqual([['keep', '家里'], ['b', '公司'], ['c', '手机热点']]);
  });

  it('非数组返回空列表', () => {
    expect(normalizeConnectionProfiles(undefined)).toEqual([]);
    expect(normalizeConnectionProfiles({ name: 'x' })).toEqual([]);
  });
});

describe('migrateConnectionSettings', () => {
  it('旧结构：档案转换、档位作废，正在用的那组字段不进补丁', () => {
    const patch = migrateConnectionSettings({
      ...baseSettings(),
      connectionProfiles: legacyProfiles as unknown as ConnectionProfile[],
      connectionProfileMode: 'server',
    });
    expect(patch).not.toBeNull();
    expect(Object.keys(patch!).sort()).toEqual(['connectionProfileMode', 'connectionProfiles']);
    expect(patch!.connectionProfileMode).toBeNull();
    expect(patch!.connectionProfiles!.map((p) => p.name)).toEqual(['本机', '服务器']);
  });

  it('只有残留档位（含 auto）也会清掉', () => {
    expect(migrateConnectionSettings({ ...baseSettings(), connectionProfileMode: 'auto' })).toEqual({
      connectionProfileMode: null,
    });
  });

  it('新结构、无档案、档位已为 null 时不迁移', () => {
    expect(migrateConnectionSettings(baseSettings())).toBeNull();
    expect(migrateConnectionSettings({ ...baseSettings(), connectionProfiles: [profile()] })).toBeNull();
    expect(migrateConnectionSettings({ ...baseSettings(), connectionProfiles: [], connectionProfileMode: null })).toBeNull();
  });
});

describe('connectionProfilePatch / connectionProfileFromSettings', () => {
  it('选用只写非空字段，非法请求入口忽略', () => {
    expect(
      connectionProfilePatch(profile({ vcpServerUrl: 'https://a.example', vcpApiKey: '  ', chatEndpointMode: 'bogus' })),
    ).toEqual({ vcpServerUrl: 'https://a.example' });
    expect(connectionProfilePatch(profile({ chatEndpointMode: 'vcpTools', fileKey: 'fk-fake' }))).toEqual({
      chatEndpointMode: 'vcpTools',
      fileKey: 'fk-fake',
    });
  });

  it('存为档案拷贝正在用的那组字段，名称去空白', () => {
    const settings = baseSettings();
    const saved = connectionProfileFromSettings(settings, '  当前  ');
    expect(saved.name).toBe('当前');
    expect(saved.id).toMatch(/\S/);
    for (const field of CONNECTION_PROFILE_FIELDS) expect(saved[field]).toBe(settings[field]);
    expect(connectionProfilePatch(saved)).toMatchObject({ vcpServerUrl: settings.vcpServerUrl, vcpLogUrl: settings.vcpLogUrl });
  });
});

describe('fetchSettings 迁移入口', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockInvoke('get_settings_recovery_status', () => ({ recoveredCorrupt: false, backupKey: null, message: null }));
  });

  const legacy = () => ({
    ...baseSettings(),
    connectionProfiles: legacyProfiles,
    connectionProfileMode: 'local',
  });

  it('读到旧结构时回写一次迁移补丁', async () => {
    mockInvoke('read_settings', legacy);
    mockInvoke('update_settings', (args) => ({ ...legacy(), ...(args?.updates as object) }));
    const store = useSettingsStore();
    await store.fetchSettings();

    const writes = invokeMock.mock.calls.filter(([command]) => command === 'update_settings');
    expect(writes).toHaveLength(1);
    const updates = (writes[0][1] as { updates: Partial<AppSettings> }).updates;
    expect(Object.keys(updates).sort()).toEqual(['connectionProfileMode', 'connectionProfiles']);
    expect(store.settings?.connectionProfileMode).toBeNull();
    expect(store.settings?.vcpServerUrl).toBe('https://in-use.example');
    expect(store.settings?.connectionProfiles?.map((p) => p.name)).toEqual(['本机', '服务器']);
  });

  it('回写失败不阻断读取，使用归一化副本', async () => {
    mockInvoke('read_settings', legacy);
    mockInvoke('update_settings', () => Promise.reject(new Error('db busy')));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = useSettingsStore();
    await store.fetchSettings();
    expect(store.error).toBeNull();
    expect(store.settings?.connectionProfileMode).toBeNull();
    expect(store.settings?.connectionProfiles?.[1]).toMatchObject({ name: '服务器', vcpLogUrl: '' });
  });

  it('新结构不触发写入', async () => {
    mockInvoke('read_settings', () => ({ ...baseSettings(), connectionProfiles: [profile()] }));
    await useSettingsStore().fetchSettings();
    expect(invokeMock.mock.calls.some(([command]) => command === 'update_settings')).toBe(false);
  });
});
