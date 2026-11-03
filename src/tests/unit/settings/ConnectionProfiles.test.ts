import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import VcpCoreSettingsSection from '@/features/settings/components/VcpCoreSettingsSection.vue';
import type { ConnectionFields } from '@/features/settings/editing/fieldSets';
import { parseConnectionProfiles } from '@/core/config/connectionProfiles';

const fields = (extra: Record<string, unknown> = {}) => ({
  'server.url': 'https://legacy.example',
  'server.endpointMode': 'standard',
  'server.apiKey': 'legacy-key',
  'server.connectionProfiles': '',
  'server.fileKey': '',
  'log.url': '',
  'log.key': '',
  'sync.serverUrl': 'ws://sync.example',
  'sync.httpUrl': 'http://sync.example',
  'sync.token': 'sync-token',
  'sync.autoSync': true,
  ...extra,
}) as unknown as ConnectionFields;

const mountSection = (settings: ConnectionFields) =>
  mount(VcpCoreSettingsSection, {
    props: { settings, active: true, commit: async () => ({ status: 'saved' }) as never },
  });

type Wrapper = ReturnType<typeof mountSection>;
const edits = (w: Wrapper) => (w.emitted('edit') ?? []).map(([v]) => v as Record<string, unknown>);
const lastEdit = (w: Wrapper) => edits(w)[edits(w).length - 1];
const lastProfiles = (w: Wrapper) =>
  parseConnectionProfiles(lastEdit(w)?.['server.connectionProfiles'] as string);
const field = (w: Wrapper, label: string) =>
  w.findAll('.settings-field').find((item) => item.text().includes(label))!.find('input');
const action = (w: Wrapper, name: string) => w.find(`[data-profile-action="${name}"]`);
const pick = (w: Wrapper, name: string) =>
  w.findAll('[aria-label="连接档案"] [role="radio"]').find((b) => b.text().includes(name))!.trigger('click');

const HOME = JSON.stringify([{
  id: 'p-home', name: '家里',
  vcpServerUrl: 'http://192.168.1.5:6005', chatEndpointMode: 'vcpTools', vcpApiKey: 'sk-fake-home-1111',
  vcpLogUrl: 'ws://192.168.1.5:6005', vcpLogKey: '', fileKey: '',
  syncHttpUrl: '', syncServerUrl: '', syncToken: '',
}]);

describe('VcpCoreSettingsSection connection profiles (fork ptp4g#24)', () => {
  it('rendering emits nothing and shows only the single field group', async () => {
    const w = mountSection(fields());
    await flushPromises();
    expect(edits(w)).toEqual([]);
    expect(w.text()).not.toContain('单一地址');
    expect(w.text()).not.toContain('服务器 Chat URL');
    expect(action(w, 'apply').attributes('disabled')).toBeDefined();
  });

  it('存为档案 copies the in-use fields into server.connectionProfiles and commits', async () => {
    const w = mountSection(fields());
    await field(w, '档案名称').setValue('公司');
    await action(w, 'save').trigger('click');
    const profiles = lastProfiles(w);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: '公司', vcpServerUrl: 'https://legacy.example', vcpApiKey: 'legacy-key', syncToken: 'sync-token',
    });
    expect(w.emitted('blur')).toBeTruthy();
  });

  it('选用 emits only the non-empty profile fields by config path; 删除 empties the list', async () => {
    const w = mountSection(fields({ 'server.connectionProfiles': HOME }));
    await pick(w, '家里');
    await action(w, 'apply').trigger('click');
    expect(lastEdit(w)).toEqual({
      'server.url': 'http://192.168.1.5:6005',
      'server.endpointMode': 'vcpTools',
      'server.apiKey': 'sk-fake-home-1111',
      'log.url': 'ws://192.168.1.5:6005',
    });

    await pick(w, '家里');
    await action(w, 'delete').trigger('click');
    expect(lastEdit(w)).toEqual({ 'server.connectionProfiles': '' });
  });

  it('同名存为档案覆盖原档案，不新增', async () => {
    const w = mountSection(fields());
    await field(w, '档案名称').setValue('公司');
    await action(w, 'save').trigger('click');
    const first = lastProfiles(w)[0];
    await w.setProps({
      settings: fields({ 'server.url': 'https://new.example', 'server.connectionProfiles': JSON.stringify([first]) }),
    });
    await field(w, '档案名称').setValue('公司');
    await action(w, 'save').trigger('click');
    const profiles = lastProfiles(w);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: first.id, vcpServerUrl: 'https://new.example' });
  });
});
