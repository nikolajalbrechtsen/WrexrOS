import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { User, Group, ApiToken, Event } from '../types.ts';
import { can, toast, errorMessage, relativeTime } from '../store.ts';
import { PageHead, Panel, DataTable, Badge, Icon, Tabs, Modal, Input, Select, ConfirmDialog, EmptyState, Loading, ErrorBanner, iconBtn } from '../components.ts';
import type { Column } from '../components.ts';

type Tab = 'users' | 'groups' | 'tokens' | 'audit';
const users = useState<User[]>([]);
const groups = useState<Group[]>([]);
const tokens = useState<ApiToken[]>([]);
const audit = useState<Event[]>([]);
const tab = useState<Tab>('users');
const loading = useState(true);
const error = useState('');
const dialog = useState<null | 'user' | 'group' | 'token'>(null);
const pendingDelete = useState<User | null>(null);
const form = useState<any>({ name: '', password: '', role: 'viewer', members: '', scope: 'read' });

export function load(force = false): void {
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  Promise.all([api.users.list(), api.groups.list(), api.auth.tokens(), api.audit()])
    .then(([u, g, t, a]) => { users.set(u || []); groups.set(g || []); tokens.set(t || []); audit.set(a || []); })
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));
}

async function createUser(): Promise<void> {
  try {
    await api.users.create({ username: form.value.name, name: form.value.name, password: form.value.password, role: form.value.role });
    toast('User created', 'success'); dialog.set(null); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function createGroup(): Promise<void> {
  try {
    await api.groups.create({ name: form.value.name, members: String(form.value.members || '').split(',').map((s) => s.trim()).filter(Boolean) });
    toast('Group created', 'success'); dialog.set(null); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function createToken(): Promise<void> {
  try {
    const result = await api.auth.createToken({ name: form.value.name, scope: form.value.scope });
    if (result && result.token) {
      await navigator.clipboard?.writeText(result.token).catch(() => undefined);
      toast('Token created — copied to clipboard', 'success');
    } else toast('Token created', 'success');
    dialog.set(null); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

const userColumns: Column[] = [
  { key: 'username', label: 'User', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.username || r.name), h('div', { class: 'tiny dim' }, r.email || '')) },
  { key: 'role', label: 'Role', render: (r) => Badge({ kind: r.role === 'admin' ? 'purple' : r.role === 'operator' ? 'info' : 'accent', text: r.role || 'viewer' }) },
  { key: 'enabled', label: 'State', render: (r) => Badge({ kind: r.enabled === false ? 'danger' : 'success', text: r.enabled === false ? 'disabled' : 'active' }) }
];
const groupColumns: Column[] = [
  { key: 'name', label: 'Group', render: (r) => h('span', { class: 'strong' }, r.name) },
  { key: 'members', label: 'Members', render: (r) => (r.members || []).length ? (r.members || []).join(', ') : '—' }
];
const tokenColumns: Column[] = [
  { key: 'name', label: 'Name', render: (r) => h('span', { class: 'strong' }, r.name || r.id) },
  { key: 'created', label: 'Created', render: (r) => relativeTime(r.created) },
  { key: 'lastUsed', label: 'Last used', render: (r) => relativeTime(r.lastUsed) }
];
const auditColumns: Column[] = [
  { key: 'time', label: 'When', render: (r) => h('span', { class: 'small nowrap' }, relativeTime(r.time)) },
  { key: 'actor', label: 'Actor', render: (r) => r.actor || '—' },
  { key: 'action', label: 'Action', render: (r) => h('span', { class: 'mono small' }, r.action || '') },
  { key: 'resource', label: 'Resource', render: (r) => r.resource || '—' },
  { key: 'sourceIp', label: 'Source', render: (r) => h('span', { class: 'mono small' }, r.sourceIp || '—') }
];

export function View(): VNode {
  return h('div', { class: 'page' },
    PageHead({
      title: 'Users & access',
      subtitle: 'Local accounts, groups, API tokens and audit trail',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        tab.value === 'users' && can('user:write') ? h('button', { class: 'btn btn-primary', onClick: () => { form.set({ name: '', password: '', role: 'viewer' }); dialog.set('user'); } }, Icon({ name: 'plus', size: 15 }), 'New user') : null,
        tab.value === 'groups' && can('user:write') ? h('button', { class: 'btn btn-primary', onClick: () => { form.set({ name: '', members: '' }); dialog.set('group'); } }, Icon({ name: 'plus', size: 15 }), 'New group') : null,
        tab.value === 'tokens' ? h('button', { class: 'btn btn-primary', onClick: () => { form.set({ name: '', scope: 'read' }); dialog.set('token'); } }, Icon({ name: 'plus', size: 15 }), 'New token') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Loading accounts…' }) : null,

    Tabs({
      tabs: [{ id: 'users', label: 'Users' }, { id: 'groups', label: 'Groups' }, { id: 'tokens', label: 'API tokens' }, { id: 'audit', label: 'Audit log' }],
      active: tab.value, onChange: (id) => tab.set(id as Tab)
    }),

    tab.value === 'users' ? Panel({ title: 'Local accounts', actions: Badge({ text: users.value.length + ' users' }) },
      DataTable({
        columns: userColumns, rows: users.value, keyField: 'id', empty: 'No users configured', emptyIcon: 'users',
        actions: (r) => iconBtn({ name: 'trash', title: 'Delete', disabled: !can('user:write'), onClick: () => pendingDelete.set(r) })
      })
    ) : null,

    tab.value === 'groups' ? Panel({ title: 'Groups', actions: Badge({ text: groups.value.length + ' groups' }) },
      DataTable({ columns: groupColumns, rows: groups.value, keyField: 'id', empty: 'No groups', emptyIcon: 'users' })
    ) : null,

    tab.value === 'tokens' ? Panel({ title: 'API tokens', actions: Badge({ text: tokens.value.length + ' tokens' }) },
      DataTable({
        columns: tokenColumns, rows: tokens.value, keyField: 'id', empty: 'No API tokens', emptyIcon: 'key',
        actions: (r) => iconBtn({ name: 'trash', title: 'Revoke', onClick: async () => {
          try { await api.auth.revokeToken(String(r.id)); toast('Token revoked', 'success'); refresh(); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } })
      })
    ) : null,

    tab.value === 'audit' ? Panel({ title: 'Audit trail', actions: Badge({ text: audit.value.length + ' entries' }) },
      DataTable({ columns: auditColumns, rows: audit.value, keyField: 'id', empty: 'No audit entries', emptyIcon: 'file' })
    ) : null,

    pendingDelete.value ? ConfirmDialog({
      title: 'Delete user?', message: (pendingDelete.value.username || pendingDelete.value.name) + ' will lose access immediately.',
      danger: true, confirmLabel: 'Delete',
      onConfirm: async () => {
        try { await api.users.remove(String(pendingDelete.value!.id)); toast('User deleted', 'success'); refresh(); }
        catch (err) { toast(errorMessage(err), 'error'); throw err; }
      },
      onClose: () => pendingDelete.set(null)
    }) : null,

    dialog.value === 'user' ? Modal({
      title: 'Create user', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: createUser }, 'Create'))
    },
      Input({ label: 'Username', name: 'u-name', value: form.value.name, onChange: (v) => form.set({ ...form.value, name: v }) }),
      Input({ label: 'Password', name: 'u-pass', type: 'password', value: form.value.password, onChange: (v) => form.set({ ...form.value, password: v }) }),
      Select({ label: 'Role', name: 'u-role', value: form.value.role, options: ['admin', 'operator', 'viewer'].map((r) => ({ value: r, label: r })), onChange: (v) => form.set({ ...form.value, role: v }) })
    ) : null,

    dialog.value === 'group' ? Modal({
      title: 'Create group', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: createGroup }, 'Create'))
    },
      Input({ label: 'Group name', name: 'g-name', value: form.value.name, onChange: (v) => form.set({ ...form.value, name: v }) }),
      Input({ label: 'Members (comma separated)', name: 'g-members', value: form.value.members, onChange: (v) => form.set({ ...form.value, members: v }) })
    ) : null,

    dialog.value === 'token' ? Modal({
      title: 'Create API token', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: createToken }, 'Create token'))
    },
      Input({ label: 'Token name', name: 't-name', value: form.value.name, onChange: (v) => form.set({ ...form.value, name: v }) }),
      Select({ label: 'Scope', name: 't-scope', value: form.value.scope, options: [{ value: 'read', label: 'Read only' }, { value: 'write', label: 'Read / write' }, { value: 'admin', label: 'Admin' }], onChange: (v) => form.set({ ...form.value, scope: v }) })
    ) : null
  );
}
