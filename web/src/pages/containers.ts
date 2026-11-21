import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { VM } from '../types.ts';
import { can, toast, errorMessage } from '../store.ts';
import { PageHead, Panel, DataTable, Badge, StatusDot, Icon, Modal, ConfirmDialog, Input, Select, EmptyState, Loading, ErrorBanner, iconBtn } from '../components.ts';
import type { Column } from '../components.ts';

const containers = useState<VM[]>([]);
const loading = useState(true);
const error = useState('');
const query = useState('');
const dialog = useState<null | 'create' | 'delete'>(null);
const selected = useState<VM | null>(null);
const form = useState<any>({ name: '', cpu: 1, memory: 512, disk: 8, template: 'alpine', network: 'vmbr0', privileged: false });

let loaded = false;

export function load(force = false): void {
  if (loaded && !force) return;
  loaded = true;
  refresh();
}

function refresh(): void {
  loading.set(true);
  api.vms.list()
    .then((all) => containers.set((all || []).filter((vm) => vm.type === 'lxc')))
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));
}

async function act(vm: VM, action: string): Promise<void> {
  try { await api.vms.action(vm.id, action); toast(vm.name + ' → ' + action, 'success'); refresh(); }
  catch (err) { toast(errorMessage(err), 'error'); }
}

async function create(): Promise<void> {
  const f = form.value;
  if (!f.name) { toast('Hostname required', 'warning'); return; }
  try {
    await api.vms.create({
      name: f.name, type: 'lxc', cpu: Number(f.cpu), memory: Number(f.memory), disk: Number(f.disk),
      template: f.template, network: { bridge: f.network }, privileged: !!f.privileged
    });
    toast('Container created', 'success');
    dialog.set(null);
    form.set({ ...f, name: '' });
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

const columns: Column[] = [
  { key: 'name', label: 'Hostname', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.name), h('div', { class: 'tiny dim' }, r.id)) },
  { key: 'status', label: 'State', render: (r) => StatusDot({ status: r.status || r.state || 'unknown', pulse: true }) },
  { key: 'template', label: 'Template', render: (r) => Badge({ kind: 'purple', text: r.template || 'lxc' }) },
  { key: 'cpu', label: 'CPU' },
  { key: 'memory', label: 'Memory', render: (r) => r.memory + ' MiB' },
  { key: 'ip', label: 'IP', render: (r) => h('span', { class: 'mono small' }, r.ip || '—') }
];

export function View(): VNode {
  const list = containers.value.filter((c) => !query.value || (c.name + ' ' + (c.ip || '')).toLowerCase().includes(query.value.toLowerCase()));
  return h('div', { class: 'page' },
    PageHead({
      title: 'Containers',
      subtitle: 'Lightweight LXC workloads managed through the VM API',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        can('vm:write') ? h('button', { class: 'btn btn-primary', onClick: () => dialog.set('create') }, Icon({ name: 'plus', size: 15 }), 'New container') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Listing containers…' }) : null,
    Panel({
      title: 'LXC instances',
      actions: h('div', { class: 'inline-search' }, Icon({ name: 'search', size: 15 }), h('input', {
        class: 'input', placeholder: 'Filter containers…', value: query.value, style: { width: '190px', paddingLeft: '30px' },
        onInput: (e: Event) => query.set((e.target as HTMLInputElement).value)
      }))
    },
      DataTable({
        columns, rows: list, keyField: 'id', empty: 'No LXC containers', emptyIcon: 'box',
        actions: (vm) => h(Fragment, {},
          iconBtn({ name: 'play', title: 'Start', onClick: () => act(vm, 'start') }),
          iconBtn({ name: 'stop', title: 'Stop', onClick: () => act(vm, 'stop') }),
          iconBtn({ name: 'rotate', title: 'Reboot', onClick: () => act(vm, 'reboot') }),
          iconBtn({ name: 'eye', title: 'Console', onClick: async () => {
            try {
              const info = await api.vms.vnc(vm.id);
              if (info.url) window.open(info.url, '_blank', 'noopener');
              else toast('No console URL returned', 'warning');
            } catch (err) { toast(errorMessage(err), 'error'); }
          } }),
          iconBtn({ name: 'trash', title: 'Delete', disabled: !can('vm:write'), onClick: () => { selected.set(vm); dialog.set('delete'); } })
        )
      })
    ),
    dialog.value === 'create' ? Modal({
      title: 'Create LXC container',
      onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: create }, 'Create container'))
    },
      h('div', { class: 'form-grid' },
        Input({ label: 'Hostname', name: 'ct-name', value: form.value.name, onChange: (v) => form.set({ ...form.value, name: v }) }),
        Select({ label: 'Template', name: 'ct-tpl', value: form.value.template, options: ['alpine', 'debian', 'ubuntu', 'fedora'].map((t) => ({ value: t, label: t })), onChange: (v) => form.set({ ...form.value, template: v }) }),
        Input({ label: 'vCPU', name: 'ct-cpu', type: 'number', value: form.value.cpu, min: 1, onChange: (v) => form.set({ ...form.value, cpu: v }) }),
        Input({ label: 'Memory (MiB)', name: 'ct-mem', type: 'number', value: form.value.memory, min: 64, onChange: (v) => form.set({ ...form.value, memory: v }) }),
        Input({ label: 'Root disk (GiB)', name: 'ct-disk', type: 'number', value: form.value.disk, min: 1, onChange: (v) => form.set({ ...form.value, disk: v }) }),
        Input({ label: 'Bridge', name: 'ct-net', value: form.value.network, onChange: (v) => form.set({ ...form.value, network: v }) })
      )
    ) : null,
    dialog.value === 'delete' && selected.value ? ConfirmDialog({
      title: 'Delete container?', message: selected.value.name + ' and its volumes will be removed.',
      danger: true, confirmLabel: 'Delete',
      onConfirm: async () => {
        try { await api.vms.remove(selected.value!.id); toast('Container deleted', 'success'); refresh(); }
        catch (err) { toast(errorMessage(err), 'error'); throw err; }
      },
      onClose: () => dialog.set(null)
    }) : null
  );
}
