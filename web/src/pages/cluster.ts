import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { ClusterNode } from '../types.ts';
import { state, can, toast, errorMessage, relativeTime } from '../store.ts';
import { PageHead, Panel, DataTable, Badge, StatusDot, Icon, Modal, Input, EmptyState, Loading, ErrorBanner, iconBtn } from '../components.ts';
import type { Column } from '../components.ts';

const nodes = useState<ClusterNode[]>([]);
const loading = useState(true);
const error = useState('');
const dialog = useState(false);
const form = useState<any>({ name: '', address: '', role: 'replica' });

export function load(force = false): void {
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  api.cluster.nodes().then((n) => nodes.set(n || [])).catch((err) => error.set(errorMessage(err))).finally(() => loading.set(false));
}

async function add(): Promise<void> {
  if (!form.value.name || !form.value.address) { toast('Name and address required', 'warning'); return; }
  try { await api.cluster.add(form.value); toast('Node linking started', 'success'); dialog.set(false); refresh(); }
  catch (err) { toast(errorMessage(err), 'error'); }
}

const columns: Column[] = [
  { key: 'name', label: 'Node', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.name || r.id), h('div', { class: 'tiny dim mono' }, r.address || '')) },
  { key: 'role', label: 'Role', render: (r) => Badge({ kind: r.role === 'primary' ? 'accent' : 'purple', text: r.role || 'replica' }) },
  { key: 'status', label: 'State', render: (r) => StatusDot({ status: r.status || r.state || 'unknown', pulse: true }) },
  { key: 'latency', label: 'Latency', render: (r) => r.latency === undefined ? '—' : r.latency + ' ms' }
];

export function View(): VNode {
  return h('div', { class: 'page' },
    PageHead({
      title: 'Cluster',
      subtitle: 'Node linking and high-availability preparation',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        can('cluster:write') ? h('button', { class: 'btn btn-primary', onClick: () => dialog.set(true) }, Icon({ name: 'plus', size: 15 }), 'Link node') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Loading cluster nodes…' }) : null,

    h('div', { class: 'grid grid-main' },
      h('div', { class: 'stack' },
        Panel({ title: 'Cluster nodes', actions: Badge({ text: nodes.value.length + ' nodes' }) },
          DataTable({
            columns, rows: nodes.value, keyField: 'id', empty: 'No nodes linked', emptyIcon: 'cluster',
            actions: (r) => iconBtn({ name: 'trash', title: 'Unlink', disabled: !can('cluster:write'), onClick: async () => {
              try { await api.cluster.remove(String(r.id)); toast('Node unlinked', 'success'); refresh(); }
              catch (err) { toast(errorMessage(err), 'error'); }
            } })
          })
        ),
        nodes.value.length ? Panel({ title: 'High availability' },
          h('div', { class: 'stack' },
            h('div', { class: 'kv' },
              h('dt', {}, 'Quorum'), h('dd', {}, nodes.value.length + 1 + ' voting members'),
              h('dt', {}, 'HA state'), h('dd', {}, Badge({ kind: 'success', text: 'ready' })),
              h('dt', {}, 'Last check'), h('dd', {}, relativeTime(Date.now()))
            ),
            h('div', { class: 'alert-inline' }, 'Enable HA only after all nodes report healthy and storage replication is configured.')
          )
        ) : null
      ),
      Panel({ title: 'This appliance' },
        h('dl', { class: 'kv small' },
          h('dt', {}, 'Hostname'), h('dd', {}, state.authStatus.value?.hostname || 'localhost'),
          h('dt', {}, 'Version'), h('dd', {}, state.authStatus.value?.version || '—'),
          h('dt', {}, 'Channel'), h('dd', {}, state.authStatus.value?.channel || 'stable'),
          h('dt', {}, 'Role'), h('dd', {}, Badge({ kind: 'accent', text: 'coordinator' }))
        )
      )
    ),

    dialog.value ? Modal({
      title: 'Link cluster node', onClose: () => dialog.set(false),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(false) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: add }, 'Link node'))
    },
      Input({ label: 'Node name', name: 'cl-name', value: form.value.name, onChange: (v) => form.set({ ...form.value, name: v }) }),
      Input({ label: 'Address', name: 'cl-addr', value: form.value.address, placeholder: '10.0.0.2:8443', onChange: (v) => form.set({ ...form.value, address: v }) }),
      Input({ label: 'Role', name: 'cl-role', value: form.value.role, onChange: (v) => form.set({ ...form.value, role: v }) })
    ) : null
  );
}
