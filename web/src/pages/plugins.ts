import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { Plugin } from '../types.ts';
import { can, toast, errorMessage } from '../store.ts';
import { PageHead, Panel, DataTable, Badge, StatusDot, Icon, Modal, Input, Toggle, EmptyState, Loading, ErrorBanner, iconBtn } from '../components.ts';
import type { Column } from '../components.ts';

const plugins = useState<Plugin[]>([]);
const loading = useState(true);
const error = useState('');
const dialog = useState(false);
const form = useState<any>({ url: '', signed: true });
const busy = useState('');

export function load(force = false): void {
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  api.plugins.list().then((p) => plugins.set(p || [])).catch((err) => error.set(errorMessage(err))).finally(() => loading.set(false));
}

async function action(plugin: Plugin, name: string): Promise<void> {
  busy.set(plugin.id + ':' + name);
  try { await api.plugins.action(plugin.id, name); toast('Plugin ' + name + ' requested', 'success'); refresh(); }
  catch (err) { toast(errorMessage(err), 'error'); }
  finally { busy.set(''); }
}

async function add(): Promise<void> {
  if (!form.value.url) { toast('Plugin URL required', 'warning'); return; }
  try { await api.plugins.add(form.value); toast('Plugin submitted', 'success'); dialog.set(false); refresh(); }
  catch (err) { toast(errorMessage(err), 'error'); }
}

const columns: Column[] = [
  { key: 'name', label: 'Plugin', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.name || r.id), h('div', { class: 'tiny dim' }, r.description || '')) },
  { key: 'version', label: 'Version', render: (r) => r.version || '—' },
  { key: 'signed', label: 'Signature', render: (r) => r.signed ? Badge({ kind: 'success', text: 'signed' }) : Badge({ kind: 'warning', text: 'unsigned' }) },
  { key: 'enabled', label: 'State', render: (r) => StatusDot({ status: r.enabled ? 'enabled' : 'disabled', label: r.enabled ? 'Enabled' : 'Disabled' }) }
];

export function View(): VNode {
  return h('div', { class: 'page' },
    PageHead({
      title: 'Plugins',
      subtitle: 'Signed extensions for the WrexrOS control plane',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        can('plugin:write') ? h('button', { class: 'btn btn-primary', onClick: () => dialog.set(true) }, Icon({ name: 'plus', size: 15 }), 'Add plugin') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Loading plugins…' }) : null,

    Panel({ title: 'Installed plugins', actions: Badge({ text: plugins.value.length + ' plugins' }) },
      DataTable({
        columns, rows: plugins.value, keyField: 'id', empty: 'No plugins installed', emptyIcon: 'plug',
        actions: (r) => h(Fragment, {},
          !r.installed ? iconBtn({ name: 'download', title: 'Install', disabled: !can('plugin:write') || busy.value === r.id + ':install', onClick: () => action(r, 'install') }) : null,
          iconBtn({ name: r.enabled ? 'power' : 'play', title: r.enabled ? 'Disable' : 'Enable', disabled: !can('plugin:write'), onClick: () => action(r, r.enabled ? 'disable' : 'enable') })
        )
      })
    ),

    dialog.value ? Modal({
      title: 'Add plugin', onClose: () => dialog.set(false),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(false) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: add }, 'Add plugin'))
    },
      Input({ label: 'Plugin URL or identifier', name: 'pl-url', value: form.value.url, placeholder: 'https://…/plugin.wrexr', onChange: (v) => form.set({ ...form.value, url: v }) }),
      Toggle({ label: 'Require valid signature', name: 'pl-signed', checked: !!form.value.signed, onChange: (v) => form.set({ ...form.value, signed: v }) }),
      h('div', { class: 'alert-inline' }, 'Only install plugins from sources you trust. Unsigned plugins can access host resources.')
    ) : null
  );
}
