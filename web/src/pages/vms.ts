import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { VM, VncInfo, PciDevice, Bridge, VmTemplate, FirewallRule, Snapshot } from '../types.ts';
import { state, can, toast, errorMessage, relativeTime } from '../store.ts';
import {
  PageHead, Panel, DataTable, Badge, StatusDot, Icon, Modal, ConfirmDialog, Tabs,
  Input, Select, Toggle, TextArea, EmptyState, Loading, ErrorBanner, iconBtn
} from '../components.ts';
import type { Column } from '../components.ts';

type Tab = 'instances' | 'pci' | 'bridges' | 'firewall' | 'templates';
type Dialog = null | 'create' | 'vnc' | 'snapshot' | 'pci' | 'bridge' | 'template' | 'firewall' | 'delete';

const vms = useState<VM[]>([]);
const devices = useState<PciDevice[]>([]);
const bridges = useState<Bridge[]>([]);
const templates = useState<VmTemplate[]>([]);
const snapshots = useState<Snapshot[]>([]);
const rules = useState<FirewallRule[]>([]);
const vnc = useState<VncInfo | null>(null);
const selected = useState<VM | null>(null);
const tab = useState<Tab>('instances');
const dialog = useState<Dialog>(null);
const loading = useState(true);
const error = useState('');
const query = useState('');
const busy = useState('');

const form = useState<any>({
  name: '', type: 'kvm', cpu: 2, memory: 2048, disk: 20, iso: '', template: '',
  network: 'vmbr0', startAfter: true, step: 0
});
const bridgeForm = useState<any>({ name: '', ports: '', vlanAware: true, tag: '' });
const templateForm = useState<any>({ name: '', cpu: 2, memory: 2048, disk: 20 });
const ruleForm = useState<FirewallRule>({ direction: 'in', action: 'accept', protocol: 'tcp', port: '', source: '', enabled: true });
const snapshotName = useState('');
const pciTarget = useState('');

let loaded = false;

export function load(force = false): void {
  if (loaded && !force) return;
  loaded = true;
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  Promise.all([api.vms.list(), api.pci(), api.bridges.list(), api.templates.list()])
    .then(([list, pci, br, tpl]) => {
      vms.set(list || []);
      devices.set((pci && pci.devices) || []);
      bridges.set(br || []);
      templates.set(tpl || []);
    })
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));
}

async function act(vm: VM, action: string): Promise<void> {
  if (!can('vm:write') && !can('vm:start') && !can('vm:stop')) { toast('Insufficient permissions', 'error'); return; }
  busy.set(vm.id + ':' + action);
  try {
    await api.vms.action(vm.id, action);
    toast(vm.name + ' → ' + action, 'success');
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { busy.set(''); }
}

async function openVnc(vm: VM): Promise<void> {
  selected.set(vm);
  vnc.set(null);
  dialog.set('vnc');
  try { vnc.set(await api.vms.vnc(vm.id)); }
  catch (err) { toast(errorMessage(err), 'error'); }
}

async function openSnapshots(vm: VM): Promise<void> {
  selected.set(vm);
  snapshotName.set('');
  dialog.set('snapshot');
  try { snapshots.set(await api.vms.snapshots(vm.id)); }
  catch (err) { toast(errorMessage(err), 'error'); }
}

async function openFirewall(vm: VM): Promise<void> {
  selected.set(vm);
  dialog.set('firewall');
  try { rules.set(await api.vms.firewall(vm.id)); }
  catch (err) { toast(errorMessage(err), 'error'); }
}

async function createVm(): Promise<void> {
  const f = form.value;
  if (!f.name) { toast('Name is required', 'warning'); return; }
  busy.set('create');
  try {
    await api.vms.create({
      name: f.name, type: f.type, cpu: Number(f.cpu), memory: Number(f.memory),
      disk: Number(f.disk), iso: f.iso || undefined, template: f.template || undefined,
      network: { bridge: f.network, startAfter: !!f.startAfter }
    });
    toast('Virtual machine created', 'success');
    dialog.set(null);
    form.set({ ...f, name: '', step: 0 });
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { busy.set(''); }
}

async function createBridge(): Promise<void> {
  const f = bridgeForm.value;
  if (!f.name) { toast('Bridge name required', 'warning'); return; }
  try {
    await api.bridges.create({ name: f.name, ports: String(f.ports).split(',').map((s) => s.trim()).filter(Boolean), vlanAware: !!f.vlanAware, tag: f.tag ? Number(f.tag) : undefined });
    toast('Bridge created', 'success');
    dialog.set(null);
    bridgeForm.set({ name: '', ports: '', vlanAware: true, tag: '' });
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function createTemplate(): Promise<void> {
  const f = templateForm.value;
  if (!f.name) { toast('Template name required', 'warning'); return; }
  try {
    await api.templates.create({ name: f.name, cpu: Number(f.cpu), memory: Number(f.memory), disk: Number(f.disk) });
    toast('Template saved', 'success');
    dialog.set(null);
    templateForm.set({ name: '', cpu: 2, memory: 2048, disk: 20 });
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function saveRules(): Promise<void> {
  const vm = selected.value;
  if (!vm) return;
  try {
    await api.vms.setFirewall(vm.id, rules.value);
    toast('Firewall rules updated', 'success');
    dialog.set(null);
  } catch (err) { toast(errorMessage(err), 'error'); }
}

const columns: Column[] = [
  { key: 'name', label: 'Name', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.name), h('div', { class: 'tiny dim' }, r.id)) },
  { key: 'type', label: 'Type', render: (r) => Badge({ kind: r.type === 'kvm' ? 'info' : 'purple', text: String(r.type || '').toUpperCase() }) },
  { key: 'status', label: 'Status', render: (r) => StatusDot({ status: r.status || r.state || 'unknown', pulse: /running/.test(String(r.status || r.state)) }) },
  { key: 'cpu', label: 'vCPU', render: (r) => r.cpu ?? '—' },
  { key: 'memory', label: 'Memory', render: (r) => r.memory ? (Number(r.memory) >= 1024 ? (Number(r.memory) / 1024).toFixed(1) + ' GiB' : r.memory + ' MiB') : '—' },
  { key: 'ip', label: 'IP address', render: (r) => h('span', { class: 'mono small' }, r.ip || '—') }
];

export function View(): VNode {
  const list = vms.value.filter((vm) => !query.value || (vm.name + ' ' + (vm.ip || '') + ' ' + vm.type).toLowerCase().includes(query.value.toLowerCase()));
  const running = vms.value.filter((vm) => /running|active/.test(String(vm.status || vm.state || ''))).length;

  return h('div', { class: 'page' },
    PageHead({
      title: 'Virtual machines',
      subtitle: running + ' of ' + vms.value.length + ' instances running',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: () => refresh() }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        can('vm:write') ? h('button', { class: 'btn btn-primary', onClick: () => { form.set({ ...form.value, step: 0 }); dialog.set('create'); } }, Icon({ name: 'plus', size: 15 }), 'New instance') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,

    Tabs({
      tabs: [
        { id: 'instances', label: 'Instances' },
        { id: 'pci', label: 'PCI passthrough' },
        { id: 'bridges', label: 'Bridges' },
        { id: 'firewall', label: 'Firewall' },
        { id: 'templates', label: 'Templates' }
      ],
      active: tab.value,
      onChange: (id) => tab.set(id as Tab)
    }),

    loading.value && !vms.value.length ? Loading({ label: 'Loading compute resources…' }) : null,

    tab.value === 'instances' ? Panel({
      title: 'All instances',
      actions: h('div', { class: 'inline-search' }, Icon({ name: 'search', size: 15 }), h('input', {
        class: 'input', placeholder: 'Filter instances…', value: query.value,
        style: { width: '200px', paddingLeft: '30px' },
        onInput: (e: Event) => query.set((e.target as HTMLInputElement).value)
      }))
    },
      DataTable({
        columns, rows: list, keyField: 'id', empty: 'No virtual machines', emptyIcon: 'server',
        actions: (vm) => h(Fragment, {},
          iconBtn({ name: 'play', title: 'Start', disabled: busy.value === vm.id + ':start' || !can('vm:start'), onClick: () => act(vm, 'start') }),
          iconBtn({ name: 'stop', title: 'Stop', disabled: busy.value === vm.id + ':stop' || !can('vm:stop'), onClick: () => act(vm, 'stop') }),
          iconBtn({ name: 'rotate', title: 'Reboot', disabled: !can('vm:start'), onClick: () => act(vm, 'reboot') }),
          iconBtn({ name: 'eye', title: 'VNC console', onClick: () => openVnc(vm) }),
          iconBtn({ name: 'camera', title: 'Snapshots', onClick: () => openSnapshots(vm) }),
          iconBtn({ name: 'shield', title: 'Firewall', onClick: () => openFirewall(vm) }),
          iconBtn({ name: 'trash', title: 'Delete', disabled: !can('vm:write'), onClick: () => { selected.set(vm); dialog.set('delete'); } })
        )
      })
    ) : null,

    tab.value === 'pci' ? Panel({ title: 'PCI devices', actions: Badge({ text: devices.value.length + ' devices' }) },
      DataTable({
        columns: [
          { key: 'id', label: 'Device', render: (r) => h('span', { class: 'mono small' }, r.id) },
          { key: 'vendor', label: 'Vendor' },
          { key: 'device', label: 'Model' },
          { key: 'iommuGroup', label: 'IOMMU', render: (r) => 'group ' + (r.iommuGroup ?? '—') },
          { key: 'usable', label: '状态', render: (r) => StatusDot({ status: r.usable ? 'ok' : 'warn', label: r.usable ? 'Usable' : 'In use' }) }
        ],
        rows: devices.value, keyField: 'id', empty: 'No PCI devices detected', emptyIcon: 'plug',
        actions: can('vm:write') ? (r) => iconBtn({
          name: 'plus', title: 'Passthrough', disabled: !r.usable,
          onClick: () => { pciTarget.set(''); selected.set(r as any); dialog.set('pci'); }
        }) : undefined
      })
    ) : null,

    tab.value === 'bridges' ? Panel({
      title: 'Network bridges',
      actions: can('network:write') ? h('button', { class: 'btn btn-sm btn-primary', onClick: () => dialog.set('bridge') }, Icon({ name: 'plus', size: 14 }), 'New bridge') : null
    },
      DataTable({
        columns: [
          { key: 'name', label: 'Name', render: (r) => h('span', { class: 'mono strong' }, r.name) },
          { key: 'ports', label: 'Ports', render: (r) => (r.ports || []).join(', ') || '—' },
          { key: 'vlanAware', label: 'VLAN aware', render: (r) => r.vlanAware ? Badge({ kind: 'accent', text: 'yes' }) : Badge({ text: 'no' }) },
          { key: 'tag', label: 'Tag', render: (r) => r.tag ?? '—' }
        ],
        rows: bridges.value, keyField: 'name', empty: 'No bridges configured', emptyIcon: 'network'
      })
    ) : null,

    tab.value === 'firewall' ? Panel({ title: 'VM firewall rules', actions: Badge({ text: vms.value.length + ' instances' }) },
      vms.value.length ? h('div', { class: 'stack' }, ...vms.value.map((vm) =>
        h('div', { class: 'list-row' },
          h('span', { class: 'grow' }, h('div', { class: 'title' }, vm.name), h('div', { class: 'sub' }, vm.id)),
          h('button', { class: 'btn btn-sm', onClick: () => openFirewall(vm) }, Icon({ name: 'shield', size: 14 }), 'Rules')
        )
      )) : EmptyState({ title: 'No instances to configure', icon: 'shield' })
    ) : null,

    tab.value === 'templates' ? Panel({
      title: 'Resource templates',
      actions: can('vm:write') ? h('button', { class: 'btn btn-sm btn-primary', onClick: () => dialog.set('template') }, Icon({ name: 'plus', size: 14 }), 'New template') : null
    },
      DataTable({
        columns: [
          { key: 'name', label: 'Name', render: (r) => h('span', { class: 'strong' }, r.name) },
          { key: 'cpu', label: 'vCPU' },
          { key: 'memory', label: 'Memory (MiB)' },
          { key: 'disk', label: 'Disk (GiB)' }
        ],
        rows: templates.value, keyField: 'id', empty: 'No templates yet', emptyIcon: 'layers',
        actions: (r) => h('button', {
          class: 'btn btn-sm', onClick: () => {
            form.set({ ...form.value, name: r.name + '-clone', cpu: r.cpu, memory: r.memory, disk: r.disk, template: r.name, step: 0 });
            dialog.set('create');
          }
        }, 'Use')
      })
    ) : null,

    dialog.value === 'create' ? createDialog() : null,
    dialog.value === 'vnc' ? vncDialog() : null,
    dialog.value === 'snapshot' ? snapshotDialog() : null,
    dialog.value === 'pci' ? pciDialog() : null,
    dialog.value === 'bridge' ? bridgeDialog() : null,
    dialog.value === 'template' ? templateDialog() : null,
    dialog.value === 'firewall' ? firewallDialog() : null,
    dialog.value === 'delete' && selected.value ? ConfirmDialog({
      title: 'Delete ' + selected.value.name + '?',
      message: 'This destroys the instance and its virtual disks. This action cannot be undone.',
      confirmLabel: 'Delete instance', danger: true,
      onConfirm: async () => {
        try { await api.vms.remove(selected.value!.id); toast('Instance deleted', 'success'); refresh(); }
        catch (err) { toast(errorMessage(err), 'error'); throw err; }
      },
      onClose: () => dialog.set(null)
    }) : null
  );
}

function createDialog(): VNode {
  const f = form.value;
  const step = Number(f.step || 0);
  return Modal({
    title: 'Create virtual machine',
    onClose: () => dialog.set(null),
    footer: h(Fragment, {},
      step > 0 ? h('button', { class: 'btn', onClick: () => form.set({ ...f, step: step - 1 }) }, 'Back') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'),
      step === 0
        ? h('button', { class: 'btn btn-primary', onClick: () => form.set({ ...f, step: 1 }) }, 'Next')
        : h('button', { class: 'btn btn-primary', disabled: busy.value === 'create', onClick: createVm }, busy.value === 'create' ? 'Creating…' : 'Create instance')
    )
  },
    h('div', { class: 'stepper' }, h('div', { class: 'active' }), h('div', { class: step === 1 ? 'active' : '' })),
    step === 0 ? h(Fragment, {},
      h('h3', { class: 'step-title' }, 'Instance type'),
      h('p', { class: 'step-desc' }, 'Choose the virtualization technology and resources.'),
      h('div', { class: 'form-grid' },
        Input({ label: 'Name', name: 'vm-name', value: f.name, placeholder: 'e.g. app-server-01', onChange: (v) => form.set({ ...form.value, name: v }) }),
        Select({
          label: 'Type', name: 'vm-type', value: f.type, onChange: (v) => form.set({ ...form.value, type: v }),
          options: [{ value: 'kvm', label: 'KVM — full virtualization' }, { value: 'lxc', label: 'LXC — Linux container' }]
        }),
        Input({ label: 'vCPU cores', name: 'vm-cpu', type: 'number', value: f.cpu, min: 1, onChange: (v) => form.set({ ...form.value, cpu: v }) }),
        Input({ label: 'Memory (MiB)', name: 'vm-mem', type: 'number', value: f.memory, min: 128, onChange: (v) => form.set({ ...form.value, memory: v }) }),
        Input({ label: 'Disk (GiB)', name: 'vm-disk', type: 'number', value: f.disk, min: 1, onChange: (v) => form.set({ ...form.value, disk: v }) }),
        Select({
          label: 'Template', name: 'vm-template', value: f.template, onChange: (v) => form.set({ ...form.value, template: v }),
          options: [{ value: '', label: 'No template' }].concat(templates.value.map((t) => ({ value: t.name, label: t.name })))
        })
      )
    ) : h(Fragment, {},
      h('h3', { class: 'step-title' }, 'Installation & network'),
      h('p', { class: 'step-desc' }, 'Optional ISO image and bridge attachment.'),
      h('div', { class: 'form-grid' },
        Input({ label: 'ISO image', name: 'vm-iso', value: f.iso, placeholder: '/mnt/iso/ubuntu.iso', onChange: (v) => form.set({ ...form.value, iso: v }) }),
        Select({
          label: 'Network bridge', name: 'vm-net', value: f.network, onChange: (v) => form.set({ ...form.value, network: v }),
          options: (bridges.value.length ? bridges.value.map((b) => ({ value: b.name, label: b.name })) : [{ value: 'vmbr0', label: 'vmbr0 (default)' }])
        })
      ),
      Toggle({ label: 'Start after creation', name: 'vm-start', checked: !!f.startAfter, onChange: (v) => form.set({ ...form.value, startAfter: v }) })
    )
  );
}

function vncDialog(): VNode {
  const vm = selected.value;
  const info = vnc.value;
  return Modal({
    title: 'Console · ' + (vm ? vm.name : ''),
    size: 'wide',
    onClose: () => dialog.set(null),
    footer: h(Fragment, {},
      info && info.url ? h('a', { class: 'btn', href: info.url, target: '_blank', rel: 'noreferrer' }, Icon({ name: 'external', size: 14 }), 'Open in new tab') : null,
      h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Close')
    )
  },
    !info ? Loading({ label: 'Opening console…' }) : h('div', { class: 'stack' },
      info.url ? h('iframe', { class: 'vnc-frame', src: info.url, title: 'VNC console' }) : EmptyState({ title: 'No console URL returned', icon: 'eye' }),
      h('div', { class: 'kv small' },
        h('dt', {}, 'URL'), h('dd', { class: 'mono' }, info.url || '—'),
        h('dt', {}, 'Port'), h('dd', { class: 'mono' }, String(info.port || '—')),
        h('dt', {}, 'WebSocket'), h('dd', { class: 'mono' }, info.websocket || '—')
      )
    )
  );
}

function snapshotDialog(): VNode {
  const vm = selected.value;
  return Modal({
    title: 'Snapshots · ' + (vm ? vm.name : ''),
    onClose: () => dialog.set(null),
    footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Close'))
  },
    h('div', { class: 'input-group mb-2' },
      h('input', { class: 'input', placeholder: 'Snapshot name (optional)', value: snapshotName.value, onInput: (e: Event) => snapshotName.set((e.target as HTMLInputElement).value) }),
      h('button', {
        class: 'btn btn-primary', disabled: !can('vm:write'),
        onClick: async () => {
          if (!vm) return;
          try {
            await api.post('/vms/' + vm.id + '/snapshots', { name: snapshotName.value || 'snapshot-' + Date.now() });
            toast('Snapshot created', 'success');
            snapshotName.set('');
            snapshots.set(await api.vms.snapshots(vm.id));
          } catch (err) { toast(errorMessage(err), 'error'); }
        }
      }, Icon({ name: 'plus', size: 14 }), 'Take snapshot')
    ),
    snapshots.value.length ? h('div', { class: 'stack' }, ...snapshots.value.map((s) =>
      h('div', { class: 'list-row' }, h('span', { class: 'grow' }, h('div', { class: 'title' }, s.name), h('div', { class: 'sub' }, relativeTime(s.time || s.created))), Badge({ kind: 'accent', text: 'saved' }))
    )) : EmptyState({ title: 'No snapshots', message: 'Take a snapshot before making changes.', icon: 'camera' })
  );
}

function pciDialog(): VNode {
  const device = selected.value as any;
  const targets = vms.value;
  return Modal({
    title: 'Assign PCI device',
    onClose: () => dialog.set(null),
    footer: h(Fragment, {},
      h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary', disabled: !pciTarget.value,
        onClick: async () => {
          try {
            await api.vms.update(pciTarget.value, { pci: [device.id] });
            toast('PCI device assigned', 'success');
            dialog.set(null);
          } catch (err) { toast(errorMessage(err), 'error'); }
        }
      }, 'Assign')
    )
  },
    h('p', { class: 'small muted' }, 'Device: ', h('span', { class: 'mono' }, device?.id || '')),
    Select({
      label: 'Target instance', name: 'pci-vm', value: pciTarget.value,
      options: [{ value: '', label: 'Select a VM…' }].concat(targets.map((vm) => ({ value: vm.id, label: vm.name }))),
      onChange: (v) => pciTarget.set(v)
    })
  );
}

function bridgeDialog(): VNode {
  const f = bridgeForm.value;
  return Modal({
    title: 'Create network bridge',
    onClose: () => dialog.set(null),
    footer: h(Fragment, {},
      h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onClick: createBridge }, 'Create bridge')
    )
  },
    Input({ label: 'Bridge name', name: 'br-name', value: f.name, placeholder: 'vmbr1', onChange: (v) => bridgeForm.set({ ...bridgeForm.value, name: v }) }),
    Input({ label: 'Ports (comma separated)', name: 'br-ports', value: f.ports, placeholder: 'eno1, eno2', onChange: (v) => bridgeForm.set({ ...bridgeForm.value, ports: v }) }),
    Input({ label: 'VLAN tag', name: 'br-tag', type: 'number', value: f.tag, onChange: (v) => bridgeForm.set({ ...bridgeForm.value, tag: v }) }),
    Toggle({ label: 'VLAN aware', name: 'br-vlan', checked: !!f.vlanAware, onChange: (v) => bridgeForm.set({ ...bridgeForm.value, vlanAware: v }) })
  );
}

function templateDialog(): VNode {
  const f = templateForm.value;
  return Modal({
    title: 'New resource template',
    onClose: () => dialog.set(null),
    footer: h(Fragment, {},
      h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onClick: createTemplate }, 'Save template')
    )
  },
    Input({ label: 'Template name', name: 'tpl-name', value: f.name, onChange: (v) => templateForm.set({ ...templateForm.value, name: v }) }),
    h('div', { class: 'form-grid' },
      Input({ label: 'vCPU', name: 'tpl-cpu', type: 'number', value: f.cpu, onChange: (v) => templateForm.set({ ...templateForm.value, cpu: v }) }),
      Input({ label: 'Memory (MiB)', name: 'tpl-mem', type: 'number', value: f.memory, onChange: (v) => templateForm.set({ ...templateForm.value, memory: v }) }),
      Input({ label: 'Disk (GiB)', name: 'tpl-disk', type: 'number', value: f.disk, onChange: (v) => templateForm.set({ ...templateForm.value, disk: v }) })
    )
  );
}

function firewallDialog(): VNode {
  const vm = selected.value;
  return Modal({
    title: 'Firewall · ' + (vm ? vm.name : ''),
    onClose: () => dialog.set(null),
    footer: h(Fragment, {},
      h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'),
      can('vm:write') ? h('button', { class: 'btn btn-primary', onClick: saveRules }, 'Save rules') : null
    )
  },
    rules.value.length ? h('div', { class: 'stack mb-2' }, ...rules.value.map((rule, i) =>
      h('div', { class: 'list-row' },
        h('span', { class: 'small mono' }, (rule.direction || 'in') + ' ' + (rule.action || 'accept') + ' ' + (rule.protocol || 'any') + ' ' + (rule.port || '*') + ' ' + (rule.source || 'any')),
        h('span', { class: 'spacer' }),
        iconBtn({ name: 'trash', title: 'Remove', onClick: () => rules.set(rules.value.filter((_, idx) => idx !== i)) })
      )
    )) : EmptyState({ title: 'No firewall rules', icon: 'shield' }),
    h('div', { class: 'form-grid mt-3' },
      Select({ label: 'Direction', name: 'fw-dir', value: ruleForm.value.direction, options: [{ value: 'in', label: 'Inbound' }, { value: 'out', label: 'Outbound' }], onChange: (v) => ruleForm.set({ ...ruleForm.value, direction: v }) }),
      Select({ label: 'Action', name: 'fw-act', value: ruleForm.value.action, options: [{ value: 'accept', label: 'Accept' }, { value: 'drop', label: 'Drop' }, { value: 'reject', label: 'Reject' }], onChange: (v) => ruleForm.set({ ...ruleForm.value, action: v }) }),
      Input({ label: 'Protocol', name: 'fw-proto', value: ruleForm.value.protocol, placeholder: 'tcp', onChange: (v) => ruleForm.set({ ...ruleForm.value, protocol: v }) }),
      Input({ label: 'Port', name: 'fw-port', value: ruleForm.value.port, placeholder: '443', onChange: (v) => ruleForm.set({ ...ruleForm.value, port: v }) }),
      Input({ label: 'Source', name: 'fw-src', value: ruleForm.value.source, placeholder: '0.0.0.0/0', onChange: (v) => ruleForm.set({ ...ruleForm.value, source: v }) })
    ),
    h('button', {
      class: 'btn btn-sm mt-2', onClick: () => {
        rules.set(rules.value.concat([{ ...ruleForm.value }]));
        ruleForm.set({ direction: 'in', action: 'accept', protocol: 'tcp', port: '', source: '', enabled: true });
      }
    }, Icon({ name: 'plus', size: 14 }), 'Add rule to draft')
  );
}
