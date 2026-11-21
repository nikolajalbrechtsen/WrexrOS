import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { Share, User, Group } from '../types.ts';
import { can, toast, errorMessage } from '../store.ts';
import {
  PageHead, Panel, DataTable, Badge, Icon, Modal, ConfirmDialog, Tabs,
  Input, Select, Toggle, EmptyState, Loading, ErrorBanner, iconBtn
} from '../components.ts';
import type { Column } from '../components.ts';

type Tab = 'shares' | 'users' | 'groups';
const shares = useState<Share[]>([]);
const users = useState<User[]>([]);
const groups = useState<Group[]>([]);
const disks = useState<any[]>([]);
const tab = useState<Tab>('shares');
const dialog = useState<null | 'share' | 'acl' | 'user' | 'group' | 'delete'>(null);
const selected = useState<any>(null);
const loading = useState(true);
const error = useState('');
const aclDraft = useState<any>({});
const form = useState<any>({ name: '', path: '', disk: '', protocol: 'smb', users: [], permissions: '0755', recycle: true, readOnly: false });
const userForm = useState<any>({ username: '', password: '', role: 'viewer' });
const groupForm = useState<any>({ name: '', members: [] });

let loaded = false;

export function load(force = false): void {
  if (loaded && !force) return;
  loaded = true;
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  Promise.all([api.shares.list(), api.users.list(), api.groups.list(), api.storage.disks()])
    .then(([s, u, g, d]) => {
      shares.set(s || []);
      users.set(u || []);
      groups.set(g || []);
      disks.set((d && d.disks) || []);
    })
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));
}

async function saveShare(): Promise<void> {
  const f = form.value;
  if (!f.name || !f.path) { toast('Name and path are required', 'warning'); return; }
  try {
    if (selected.value && selected.value.id) await api.shares.update(selected.value.id, f);
    else await api.shares.create(f);
    toast(selected.value ? 'Share updated' : 'Share created', 'success');
    dialog.set(null); selected.set(null);
    form.set({ name: '', path: '', disk: '', protocol: 'smb', users: [], permissions: '0755', recycle: true, readOnly: false });
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function saveAcl(): Promise<void> {
  const share = selected.value as Share;
  if (!share) return;
  try {
    await api.shares.acl(share.id, { acl: aclDraft.value });
    toast('ACL updated', 'success');
    dialog.set(null); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function createUser(): Promise<void> {
  try {
    await api.users.create(userForm.value);
    toast('User created', 'success'); dialog.set(null);
    userForm.set({ username: '', password: '', role: 'viewer' }); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function createGroup(): Promise<void> {
  try {
    await api.groups.create(groupForm.value);
    toast('Group created', 'success'); dialog.set(null);
    groupForm.set({ name: '', members: [] }); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

const shareColumns: Column[] = [
  { key: 'name', label: 'Name', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.name), h('div', { class: 'tiny dim mono' }, r.path)) },
  { key: 'protocol', label: 'Protocol', render: (r) => Badge({ kind: r.protocol === 'smb' ? 'info' : r.protocol === 'nfs' ? 'purple' : 'accent', text: String(r.protocol || '').toUpperCase() }) },
  { key: 'disk', label: 'Disk / pool', render: (r) => r.disk || '—' },
  { key: 'users', label: 'Users', render: (r) => (r.users || []).length ? (r.users || []).join(', ') : 'All' },
  { key: 'recycle', label: 'Recycle bin', render: (r) => r.recycle ? Badge({ kind: 'success', text: 'on' }) : Badge({ text: 'off' }) },
  { key: 'readOnly', label: 'Access', render: (r) => r.readOnly ? Badge({ kind: 'warning', text: 'read-only' }) : Badge({ kind: 'accent', text: 'read/write' }) }
];

const userColumns: Column[] = [
  { key: 'username', label: 'Username', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.username || r.name), h('div', { class: 'tiny dim' }, r.email || '')) },
  { key: 'role', label: 'Role', render: (r) => Badge({ kind: r.role === 'admin' ? 'purple' : 'accent', text: r.role || 'viewer' }) },
  { key: 'id', label: 'ID', render: (r) => h('span', { class: 'mono small' }, r.id || '—') }
];

const groupColumns: Column[] = [
  { key: 'name', label: 'Group', render: (r) => h('span', { class: 'strong' }, r.name) },
  { key: 'members', label: 'Members', render: (r) => (r.members || []).join(', ') || '—' }
];

export function View(): VNode {
  return h('div', { class: 'page' },
    PageHead({
      title: 'File sharing',
      subtitle: 'Network shares, local accounts and access control',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        tab.value === 'shares' && can('share:write') ? h('button', { class: 'btn btn-primary', onClick: () => { selected.set(null); form.set({ name: '', path: '', disk: '', protocol: 'smb', users: [], permissions: '0755', recycle: true, readOnly: false }); dialog.set('share'); } }, Icon({ name: 'plus', size: 15 }), 'New share') : null,
        tab.value === 'users' && can('user:write') ? h('button', { class: 'btn btn-primary', onClick: () => dialog.set('user') }, Icon({ name: 'plus', size: 15 }), 'New user') : null,
        tab.value === 'groups' && can('user:write') ? h('button', { class: 'btn btn-primary', onClick: () => dialog.set('group') }, Icon({ name: 'plus', size: 15 }), 'New group') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Loading shares and accounts…' }) : null,

    Tabs({
      tabs: [{ id: 'shares', label: 'Shares' }, { id: 'users', label: 'Users' }, { id: 'groups', label: 'Groups' }],
      active: tab.value, onChange: (id) => tab.set(id as Tab)
    }),

    tab.value === 'shares' ? Panel({ title: 'Configured shares', actions: Badge({ text: shares.value.length + ' shares' }) },
      DataTable({
        columns: shareColumns, rows: shares.value, keyField: 'id', empty: 'No shares configured', emptyIcon: 'share',
        actions: (r) => h(Fragment, {},
          iconBtn({ name: 'key', title: 'Edit ACL', onClick: () => {
            selected.set(r);
            aclDraft.set(r.permissions && typeof r.permissions === 'object' ? r.permissions : {});
            dialog.set('acl');
          } }),
          iconBtn({ name: 'edit', title: 'Edit', disabled: !can('share:write'), onClick: () => { selected.set(r); form.set({ ...r, users: r.users || [] }); dialog.set('share'); } }),
          iconBtn({ name: 'trash', title: 'Delete', disabled: !can('share:write'), onClick: () => { selected.set(r); dialog.set('delete'); } })
        )
      })
    ) : null,

    tab.value === 'users' ? Panel({ title: 'Local users', actions: Badge({ text: users.value.length + ' users' }) },
      DataTable({
        columns: userColumns, rows: users.value, keyField: 'id', empty: 'No local users', emptyIcon: 'users',
        actions: (r) => iconBtn({ name: 'trash', title: 'Delete', disabled: !can('user:write'), onClick: async () => {
          try { await api.users.remove(String(r.id)); toast('User deleted', 'success'); refresh(); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } })
      })
    ) : null,

    tab.value === 'groups' ? Panel({ title: 'Local groups', actions: Badge({ text: groups.value.length + ' groups' }) },
      DataTable({ columns: groupColumns, rows: groups.value, keyField: 'id', empty: 'No groups', emptyIcon: 'users' })
    ) : null,

    dialog.value === 'share' ? Modal({
      title: selected.value ? 'Edit share' : 'Create share',
      onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', disabled: !can('share:write'), onClick: saveShare }, 'Save share'))
    },
      h('div', { class: 'form-grid' },
        Input({ label: 'Share name', name: 'sh-name', value: form.value.name, onChange: (v) => form.set({ ...form.value, name: v }) }),
        Input({ label: 'Path', name: 'sh-path', value: form.value.path, placeholder: '/mnt/data/media', onChange: (v) => form.set({ ...form.value, path: v }) }),
        Select({
          label: 'Disk / pool', name: 'sh-disk', value: form.value.disk,
          options: [{ value: '', label: 'Default array' }].concat(disks.value.map((d) => ({ value: d.id, label: d.id + ' — ' + (d.model || d.type || '') }))),
          onChange: (v) => form.set({ ...form.value, disk: v })
        }),
        Select({
          label: 'Protocol', name: 'sh-proto', value: form.value.protocol,
          options: [{ value: 'smb', label: 'SMB / CIFS' }, { value: 'nfs', label: 'NFS' }, { value: 'ftp', label: 'FTP' }],
          onChange: (v) => form.set({ ...form.value, protocol: v })
        }),
        Input({ label: 'POSIX permissions', name: 'sh-perm', value: form.value.permissions, onChange: (v) => form.set({ ...form.value, permissions: v }) })
      ),
      h('div', { class: 'field' },
        h('label', {}, 'Authorized users'),
        h('div', { class: 'checkbox-list' },
          users.value.length ? users.value.map((u) => {
            const name = String(u.username || u.name || u.id);
            const checked = (form.value.users || []).indexOf(name) >= 0;
            return h('label', { key: name, class: 'check-chip' },
              h('input', {
                type: 'checkbox', checked,
                onChange: (e: Event) => {
                  const on = (e.target as HTMLInputElement).checked;
                  const next = on ? (form.value.users || []).concat([name]) : (form.value.users || []).filter((x: string) => x !== name);
                  form.set({ ...form.value, users: next });
                }
              }), name
            );
          }) : h('span', { class: 'tiny dim' }, 'No local users yet — leaving this empty allows all authenticated users.')
        )
      ),
      h('div', { class: 'form-grid' },
        Toggle({ label: 'Recycle bin', name: 'sh-recycle', checked: !!form.value.recycle, onChange: (v) => form.set({ ...form.value, recycle: v }) }),
        Toggle({ label: 'Read only', name: 'sh-ro', checked: !!form.value.readOnly, onChange: (v) => form.set({ ...form.value, readOnly: v }) })
      )
    ) : null,

    dialog.value === 'acl' ? Modal({
      title: 'Access control · ' + (selected.value?.name || ''),
      onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', disabled: !can('share:write'), onClick: saveAcl }, 'Save ACL'))
    },
      users.value.length ? h('div', { class: 'stack' }, ...users.value.map((u) => {
        const name = String(u.username || u.name || u.id);
        return h('div', { class: 'list-row', key: name },
          h('span', { class: 'grow strong small' }, name),
          Select({
            name: 'acl-' + name, value: aclDraft.value[name] || 'read-write',
            options: [{ value: 'read-only', label: 'Read only' }, { value: 'read-write', label: 'Read / write' }, { value: 'none', label: 'No access' }],
            onChange: (v) => aclDraft.set({ ...aclDraft.value, [name]: v })
          })
        );
      })) : EmptyState({ title: 'No users to assign', icon: 'key' }),
      groups.value.length ? h('div', { class: 'mt-3' }, h('div', { class: 'field-label mb-1' }, 'Groups'),
        h('div', { class: 'checkbox-list' }, ...groups.value.map((g) =>
          h('label', { key: g.id || g.name, class: 'check-chip' },
            h('input', { type: 'checkbox' }), g.name
          )
        ))
      ) : null
    ) : null,

    dialog.value === 'user' ? Modal({
      title: 'Create local user', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: createUser }, 'Create user'))
    },
      Input({ label: 'Username', name: 'u-name', value: userForm.value.username, onChange: (v) => userForm.set({ ...userForm.value, username: v }) }),
      Input({ label: 'Password', name: 'u-pass', type: 'password', value: userForm.value.password, onChange: (v) => userForm.set({ ...userForm.value, password: v }) }),
      Select({ label: 'Role', name: 'u-role', value: userForm.value.role, options: ['admin', 'operator', 'viewer'].map((r) => ({ value: r, label: r })), onChange: (v) => userForm.set({ ...userForm.value, role: v }) })
    ) : null,

    dialog.value === 'group' ? Modal({
      title: 'Create group', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: createGroup }, 'Create group'))
    },
      Input({ label: 'Group name', name: 'g-name', value: groupForm.value.name, onChange: (v) => groupForm.set({ ...groupForm.value, name: v }) }),
      h('div', { class: 'field' }, h('label', {}, 'Members'), h('div', { class: 'checkbox-list' },
        users.value.map((u) => {
          const name = String(u.username || u.name || u.id);
          return h('label', { key: name, class: 'check-chip' },
            h('input', { type: 'checkbox', onChange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              const next = on ? groupForm.value.members.concat([name]) : groupForm.value.members.filter((x: string) => x !== name);
              groupForm.set({ ...groupForm.value, members: next });
            } }), name
          );
        })
      ))
    ) : null,

    dialog.value === 'delete' && selected.value ? ConfirmDialog({
      title: 'Delete share?', message: selected.value.name + ' will be removed. Files on disk are kept.',
      danger: true, confirmLabel: 'Delete share',
      onConfirm: async () => {
        try { await api.shares.remove(selected.value.id); toast('Share deleted', 'success'); refresh(); }
        catch (err) { toast(errorMessage(err), 'error'); throw err; }
      },
      onClose: () => dialog.set(null)
    }) : null
  );
}
