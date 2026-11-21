import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { Settings } from '../types.ts';
import { can, toast, errorMessage, state, applyTheme } from '../store.ts';
import {
  PageHead, Panel, Badge, Icon, Tabs, Input, Select, Toggle, TextArea,
  CodeEditor, ConfirmDialog, EmptyState, Loading, ErrorBanner
} from '../components.ts';

type Tab = 'general' | 'network' | 'storage' | 'access' | 'updates' | 'advanced' | 'raw';

const settings = useState<Settings>({});
const raw = useState('');
const validation = useState<{ valid: boolean; errors: string[] } | null>(null);
const backupPath = useState('');
const tab = useState<Tab>('general');
const loading = useState(true);
const saving = useState(false);
const error = useState('');
const dirty = useState(false);

let loaded = false;

const LOADERS: Record<string, () => Promise<any>> = {
  general: () => api.settings.general(),
  network: () => api.settings.network(),
  storage: () => api.settings.storage(),
  access: () => api.settings.access(),
  updates: () => api.settings.updates()
};

export function load(force = false): void {
  if (loaded && !force) return;
  loaded = true;
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  const loader = LOADERS[tab.value];
  const chain: Promise<any>[] = [loader ? loader() : Promise.resolve({})];
  if (tab.value === 'advanced' || tab.value === 'raw') chain.push(api.settings.raw());
  Promise.all(chain).then((results) => {
    if (results[0]) settings.set(results[0]);
    if (results[1] !== undefined) {
      const value = results[1];
      raw.set(typeof value === 'string' ? value : (value.raw || JSON.stringify(value, null, 2)));
    }
    dirty.set(false);
  }).catch((err) => error.set(errorMessage(err))).finally(() => loading.set(false));
}

function switchTab(next: string): void {
  tab.set(next as Tab);
  refresh();
}

function update(key: string, value: any): void {
  settings.set({ ...settings.value, [key]: value });
  dirty.set(true);
}

async function save(): Promise<void> {
  if (!can('settings:write')) { toast('Insufficient permissions', 'error'); return; }
  saving.set(true);
  try {
    const key = tab.value;
    const saver: Record<string, (body: any) => Promise<any>> = {
      general: api.settings.setGeneral,
      network: api.settings.setNetwork,
      storage: api.settings.setStorage,
      access: api.settings.setAccess,
      updates: api.settings.setUpdates
    };
    if (saver[key]) {
      await saver[key](settings.value);
      if (settings.value.theme === 'light' || settings.value.theme === 'dark') {
        state.theme.set(settings.value.theme);
        applyTheme(settings.value.theme);
      }
      toast('Settings saved', 'success');
    }
    dirty.set(false);
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { saving.set(false); }
}

async function validate(): Promise<void> {
  try {
    const result = await api.settings.validateRaw(raw.value);
    validation.set({ valid: !!result.valid, errors: result.errors || [] });
    toast(result.valid ? 'Configuration valid' : 'Configuration has errors', result.valid ? 'success' : 'warning');
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function saveRaw(): Promise<void> {
  try {
    const result = await api.settings.saveRaw(raw.value);
    backupPath.set(result.backupPath || '');
    toast('Configuration saved with backup', 'success');
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

export function View(): VNode {
  const s = settings.value;
  return h('div', { class: 'page' },
    PageHead({
      title: 'Settings',
      subtitle: 'Appliance configuration and raw editor',
      actions: h(Fragment, {},
        dirty.value ? Badge({ kind: 'warning', text: 'unsaved changes' }) : null,
        h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Reload'),
        ['general', 'network', 'storage', 'access', 'updates'].indexOf(tab.value) >= 0 && can('settings:write')
          ? h('button', { class: 'btn btn-primary', disabled: saving.value, onClick: save }, Icon({ name: 'save', size: 15 }), saving.value ? 'Saving…' : 'Save changes')
          : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Loading configuration…' }) : null,

    Tabs({
      tabs: [
        { id: 'general', label: 'General' }, { id: 'network', label: 'Network' }, { id: 'storage', label: 'Storage' },
        { id: 'access', label: 'Users & access' }, { id: 'updates', label: 'Updates' },
        { id: 'advanced', label: 'Advanced' }, { id: 'raw', label: 'Raw config' }
      ],
      active: tab.value, onChange: switchTab
    }),

    tab.value === 'general' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'Identity' },
        Input({ label: 'Hostname', name: 'set-host', value: s.hostname || '', onChange: (v) => update('hostname', v) }),
        Select({
          label: 'Timezone', name: 'set-tz', value: s.timezone || 'UTC',
          options: ['UTC', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney'].map((z) => ({ value: z, label: z })),
          onChange: (v) => update('timezone', v)
        }),
        Select({
          label: 'Language', name: 'set-lang', value: s.language || 'en',
          options: [{ value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' }, { value: 'fr', label: 'Français' }],
          onChange: (v) => update('language', v)
        })
      ),
      Panel({ title: 'Interface' },
        Select({
          label: 'Theme', name: 'set-theme', value: s.theme || state.theme.value,
          options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
          onChange: (v) => { update('theme', v); state.theme.set(v as 'dark' | 'light'); applyTheme(v as 'dark' | 'light'); }
        }),
        Toggle({ label: 'Kiosk mode', name: 'set-kiosk', checked: !!s.kiosk, hint: 'Hide navigation for wall displays', onChange: (v) => update('kiosk', v) })
      )
    ) : null,

    tab.value === 'network' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'Interfaces' },
        (s.interfaces || []).length ? h('div', { class: 'stack' }, ...(s.interfaces || []).map((iface: any, i: number) =>
          h('div', { class: 'list-row', key: iface.name || i },
            h('span', { class: 'grow' }, h('div', { class: 'title mono' }, iface.name || iface.id), h('div', { class: 'sub' }, iface.address || iface.ipv4 || 'no address')),
            Badge({ kind: iface.up || iface.state === 'up' ? 'success' : 'danger', text: iface.up || iface.state === 'up' ? 'up' : 'down' })
          )
        )) : EmptyState({ title: 'No interface details returned', icon: 'network' }),
        Input({ label: 'Gateway', name: 'net-gw', value: s.gateway || '', onChange: (v) => update('gateway', v) }),
        Input({ label: 'DNS servers (comma separated)', name: 'net-dns', value: (s.dns || []).join(', '), onChange: (v) => update('dns', v.split(',').map((x) => x.trim()).filter(Boolean)) })
      ),
      Panel({ title: 'Proxy & firewall' },
        Input({ label: 'HTTP proxy', name: 'net-proxy', value: s.proxy || '', placeholder: 'http://proxy:3128', onChange: (v) => update('proxy', v) }),
        Toggle({ label: 'Firewall enabled', name: 'net-fw', checked: s.firewall?.enabled !== false, onChange: (v) => update('firewall', { ...(s.firewall || {}), enabled: v }) }),
        TextArea({ label: 'Firewall notes / extra rules', name: 'net-fw-rules', value: s.firewall?.rules || '', onChange: (v) => update('firewall', { ...(s.firewall || {}), rules: v }) })
      )
    ) : null,

    tab.value === 'storage' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'Array & parity' },
        Select({
          label: 'Parity schedule', name: 'st-parity', value: s.paritySchedule || 'weekly',
          options: ['daily', 'weekly', 'monthly', 'manual'].map((v) => ({ value: v, label: v })),
          onChange: (v) => update('paritySchedule', v)
        }),
        Toggle({ label: 'TRIM / discard', name: 'st-trim', checked: !!s.trim, onChange: (v) => update('trim', v) }),
        TextArea({ label: 'Array options', name: 'st-array', value: typeof s.array === 'string' ? s.array : JSON.stringify(s.array || {}, null, 2), onChange: (v) => update('array', v) })
      ),
      Panel({ title: 'SMART monitoring' },
        Toggle({ label: 'SMART polling', name: 'st-smart', checked: s.smart?.enabled !== false, onChange: (v) => update('smart', { ...(s.smart || {}), enabled: v }) }),
        Input({ label: 'Check interval (hours)', name: 'st-smart-int', type: 'number', value: s.smart?.interval || 24, onChange: (v) => update('smart', { ...(s.smart || {}), interval: Number(v) }) })
      )
    ) : null,

    tab.value === 'access' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'Authentication' },
        Select({
          label: 'Two-factor policy', name: 'ac-2fa', value: s.twoFactorPolicy || 'optional',
          options: [{ value: 'optional', label: 'Optional' }, { value: 'required', label: 'Required for all users' }, { value: 'admins', label: 'Required for admins' }],
          onChange: (v) => update('twoFactorPolicy', v)
        }),
        TextArea({ label: 'SSH authorized keys', name: 'ac-ssh', value: (s.sshKeys || []).join('\n'), onChange: (v) => update('sshKeys', v.split('\n').map((x) => x.trim()).filter(Boolean)) })
      ),
      Panel({ title: 'Roles' },
        (s.roles || []).length ? h('div', { class: 'stack' }, ...(s.roles || []).map((role: any, i: number) =>
          h('div', { class: 'list-row', key: role.name || i },
            h('span', { class: 'grow strong small' }, role.name || 'role-' + i),
            Badge({ text: (role.permissions || []).length + ' permissions' })
          )
        )) : EmptyState({ title: 'Using built-in roles', message: 'admin, operator and viewer are available by default.', icon: 'shield' })
      )
    ) : null,

    tab.value === 'updates' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'Release channel' },
        Select({
          label: 'Channel', name: 'up-channel', value: s.channel || 'stable',
          options: [{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }, { value: 'nightly', label: 'Nightly' }],
          onChange: (v) => update('channel', v)
        }),
        Toggle({ label: 'Automatic checks', name: 'up-auto', checked: s.autoCheck !== false, onChange: (v) => update('autoCheck', v) })
      ),
      Panel({ title: 'Update sources' },
        TextArea({ label: 'Repository configuration', name: 'up-repo', value: typeof s.repo === 'string' ? s.repo : JSON.stringify(s.repo || {}, null, 2), onChange: (v) => update('repo', v) }),
        h('button', { class: 'btn mt-2', onClick: async () => {
          try { await api.updates.repo(); toast('Repository information refreshed', 'success'); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } }, Icon({ name: 'refresh', size: 14 }), 'Check repository')
      )
    ) : null,

    tab.value === 'advanced' ? h('div', { class: 'stack' },
      h('div', { class: 'alert-inline' }, 'Advanced settings can break the appliance. Validate before saving; a backup is created automatically.'),
      Panel({ title: 'Kernel parameters' },
        TextArea({ label: 'Kernel command line additions', name: 'adv-kernel', value: s.kernelParams || '', onChange: (v) => update('kernelParams', v) }),
        TextArea({ label: 'Advanced settings (JSON)', name: 'adv-json', value: JSON.stringify(s, null, 2), rows: 12, onChange: () => { /* raw view is authoritative */ } })
      ),
      h('button', { class: 'btn', onClick: () => switchTab('raw') }, Icon({ name: 'file', size: 14 }), 'Open raw editor')
    ) : null,

    tab.value === 'raw' ? h('div', { class: 'stack' },
      h('div', { class: 'alert-inline' }, 'Changes here are validated, backed up, and applied atomically. ' + (backupPath.value ? 'Last backup: ' + backupPath.value : '')),
      Panel({ title: 'Raw configuration', actions: h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', onClick: validate }, Icon({ name: 'check', size: 14 }), 'Validate'),
        h('button', { class: 'btn btn-sm btn-primary', disabled: !can('settings:write'), onClick: saveRaw }, Icon({ name: 'save', size: 14 }), 'Save with backup')
      ) },
        CodeEditor({ value: raw.value, onChange: (v) => { raw.set(v); validation.set(null); }, height: '480px' }),
        validation.value ? h('div', { class: validation.value.valid ? 'alert-inline' : 'error-banner mt-2' },
          validation.value.valid ? 'Configuration is valid.' : h('div', {}, h('div', { class: 'strong' }, 'Validation failed:'), ...validation.value.errors.map((e) => h('div', {}, '• ' + e)))
        ) : null
      )
    ) : null
  );
}
