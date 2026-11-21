import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { Disk, ArrayStatus, Dataset, Snapshot } from '../types.ts';
import { can, toast, errorMessage, humanBytes } from '../store.ts';
import {
  PageHead, Panel, DataTable, Badge, StatusDot, Icon, Tabs, Modal, ConfirmDialog,
  Input, Select, Toggle, EmptyState, Loading, ErrorBanner, iconBtn
} from '../components.ts';
import type { Column } from '../components.ts';

type Tab = 'array' | 'disks' | 'datasets' | 'snapshots' | 'smart';
type Dialog = null | 'assign' | 'dataset' | 'snapshot' | 'delete-dataset';

const disks = useState<Disk[]>([]);
const array = useState<ArrayStatus>({});
const datasets = useState<Dataset[]>([]);
const snapshots = useState<Snapshot[]>([]);
const smart = useState<any>({});
const settings = useState<any>({});
const tab = useState<Tab>('array');
const dialog = useState<Dialog>(null);
const selected = useState<any>(null);
const loading = useState(true);
const error = useState('');
const busy = useState('');
const datasetForm = useState<any>({ name: '', pool: 'tank', compression: 'lz4', quota: '' });
const snapshotForm = useState<any>({ dataset: '', name: '' });
const smartForm = useState<any>({ enabled: true, schedule: 'weekly', test: 'short' });

let loaded = false;

export function load(force = false): void {
  if (loaded && !force) return;
  loaded = true;
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  Promise.all([
    api.storage.disks(), api.storage.array(), api.storage.datasets(),
    api.storage.snapshots(), api.storage.smart(), api.storage.settings()
  ]).then(([d, a, ds, sn, sm, st]) => {
    disks.set((d && d.disks) || []);
    array.set(a || {});
    datasets.set(ds || []);
    snapshots.set(sn || []);
    smart.set(sm || {});
    settings.set(st || {});
  }).catch((err) => error.set(errorMessage(err))).finally(() => loading.set(false));
}

async function arrayAction(action: string): Promise<void> {
  busy.set(action);
  try {
    await api.storage.arrayAction(action);
    toast('Array ' + action + ' requested', 'success');
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { busy.set(''); }
}

async function assignRole(): Promise<void> {
  const d = selected.value as Disk;
  const role = (document.querySelector('select[name="disk-role"]') as HTMLSelectElement)?.value || 'data';
  try {
    await api.storage.assignDisk({ disk: d.id, role });
    toast('Disk role updated', 'success');
    dialog.set(null);
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function addDataset(): Promise<void> {
  const f = datasetForm.value;
  if (!f.name) { toast('Dataset name required', 'warning'); return; }
  try {
    await api.storage.addDataset({ name: f.name, pool: f.pool, compression: f.compression, quota: f.quota ? humanToBytes(f.quota) : undefined });
    toast('Dataset created', 'success'); dialog.set(null);
    datasetForm.set({ ...f, name: '' }); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

function humanToBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)i?B?$/i.exec(value.trim());
  if (!match) return Number(value) || 0;
  const mult = { K: 1024, M: 1048576, G: 1073741824, T: 1099511627776, P: 1125899906842624 } as any;
  return Math.round(parseFloat(match[1]) * (mult[match[2].toUpperCase()] || 1));
}

async function addSnapshot(): Promise<void> {
  const f = snapshotForm.value;
  if (!f.dataset) { toast('Select a dataset', 'warning'); return; }
  try {
    await api.storage.addSnapshot({ dataset: f.dataset, name: f.name || 'snap-' + Date.now() });
    toast('Snapshot created', 'success'); dialog.set(null); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function saveSmart(): Promise<void> {
  try {
    await api.storage.setSmart(smartForm.value);
    await api.storage.setSettings({ smart: smartForm.value });
    toast('SMART schedule saved', 'success');
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

const diskColumns: Column[] = [
  { key: 'id', label: 'Device', render: (r) => h('span', { class: 'mono small' }, r.id) },
  { key: 'model', label: 'Model', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.model || 'Unknown'), h('div', { class: 'tiny dim mono' }, r.serial || '')) },
  { key: 'size', label: 'Capacity', render: (r) => humanBytes(r.size) },
  { key: 'type', label: 'Type', render: (r) => Badge({ text: r.type || 'hdd' }) },
  { key: 'role', label: 'Role', render: (r) => Badge({ kind: r.role === 'parity' ? 'purple' : r.role === 'cache' ? 'info' : 'accent', text: r.role || 'unassigned' }) },
  { key: 'temp', label: 'Temp', render: (r) => r.temp ? r.temp + ' °C' : '—' },
  { key: 'smart', label: 'SMART', render: (r) => /pass|ok|healthy/i.test(String(r.smart)) ? Badge({ kind: 'success', text: String(r.smart) }) : Badge({ kind: 'warning', text: String(r.smart || 'unknown') }) },
  { key: 'state', label: 'State', render: (r) => StatusDot({ status: r.state || 'ok', label: r.state || 'OK' }) }
];

const datasetColumns: Column[] = [
  { key: 'name', label: 'Name', render: (r) => h('span', { class: 'mono strong' }, r.name) },
  { key: 'pool', label: 'Pool' },
  { key: 'compression', label: 'Compression', render: (r) => Badge({ text: r.compression || '—' }) },
  { key: 'quota', label: 'Quota', render: (r) => typeof r.quota === 'number' ? humanBytes(r.quota) : (r.quota || '—') },
  { key: 'used', label: 'Used', render: (r) => humanBytes(r.used) }
];

const snapshotColumns: Column[] = [
  { key: 'name', label: 'Snapshot', render: (r) => h('span', { class: 'mono strong' }, r.name) },
  { key: 'dataset', label: 'Dataset', render: (r) => r.dataset || '—' },
  { key: 'time', label: 'Created', render: (r) => r.time || r.created || '—' }
];

export function View(): VNode {
  const a = array.value;
  const progress = Number(a.syncProgress || 0);
  return h('div', { class: 'page' },
    PageHead({
      title: 'Storage',
      subtitle: 'Disks, array, datasets and protection schedule',
      actions: h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Refresh')
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Reading storage state…' }) : null,

    Tabs({
      tabs: [
        { id: 'array', label: 'Array' }, { id: 'disks', label: 'Disks' }, { id: 'datasets', label: 'Datasets' },
        { id: 'snapshots', label: 'Snapshots' }, { id: 'smart', label: 'SMART schedule' }
      ],
      active: tab.value, onChange: (id) => tab.set(id as Tab)
    }),

    tab.value === 'array' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'Array status', actions: StatusDot({ status: a.status || 'unknown', label: a.status || 'unknown', pulse: true }) },
        h('div', { class: 'stack' },
          h('div', { class: 'kv' },
            h('dt', {}, 'State'), h('dd', {}, a.status || a.state || 'unknown'),
            h('dt', {}, 'Capacity'), h('dd', {}, humanBytes(a.used) + ' used of ' + humanBytes(a.total)),
            h('dt', {}, 'Parity disks'), h('dd', {}, String((a.parity || []).length)),
            h('dt', {}, 'Data disks'), h('dd', {}, String((a.data || []).length))
          ),
          progress > 0 ? h(Fragment, {},
            h('div', { class: 'row small' }, h('span', {}, 'Sync / scrub progress'), h('span', { class: 'spacer' }), h('span', { class: 'strong' }, progress.toFixed(1) + '%')),
            h('div', { class: 'progress' + (progress > 85 ? ' warn' : '') }, h('span', { style: { width: Math.min(100, progress) + '%' } }))
          ) : null,
          (a.errors || []).length ? h('div', { class: 'alert-inline' }, (a.errors || []).join(' · ')) : null,
          h('div', { class: 'row mt-2' },
            ['start', 'stop', 'sync', 'scrub'].map((action) => h('button', {
              key: action, class: 'btn btn-sm' + (action === 'start' ? ' btn-primary' : ''),
              disabled: !can('storage:write') || busy.value === action,
              onClick: () => arrayAction(action)
            }, action.charAt(0).toUpperCase() + action.slice(1))),
            h('button', { class: 'btn btn-sm btn-danger', disabled: !can('storage:write'), onClick: () => arrayAction('clear') }, 'Clear errors')
          )
        )
      ),
      Panel({ title: 'Disk layout' },
        h('div', { class: 'stack' },
          h('div', { class: 'small muted' }, 'Parity'),
          (a.parity || []).length ? h('div', { class: 'row' }, ...(a.parity || []).map((d: any) => Badge({ kind: 'purple', text: typeof d === 'string' ? d : d.id }))) : EmptyState({ title: 'No parity disk', icon: 'disk' }),
          h('div', { class: 'small muted' }, 'Data'),
          (a.data || []).length ? h('div', { class: 'row' }, ...(a.data || []).map((d: any) => Badge({ kind: 'accent', text: typeof d === 'string' ? d : d.id }))) : EmptyState({ title: 'No data disks', icon: 'disk' }),
          h('button', { class: 'btn btn-sm mt-2', disabled: !can('storage:write'), onClick: () => { selected.set(disks.value[0]); dialog.set('assign'); } }, Icon({ name: 'plus', size: 14 }), 'Assign disk role')
        )
      )
    ) : null,

    tab.value === 'disks' ? Panel({ title: 'Physical disks', actions: Badge({ text: disks.value.length + ' detected' }) },
      DataTable({
        columns: diskColumns, rows: disks.value, keyField: 'id', empty: 'No disks detected', emptyIcon: 'disk',
        actions: can('storage:write') ? (r) => iconBtn({ name: 'edit', title: 'Assign role', onClick: () => { selected.set(r); dialog.set('assign'); } }) : undefined
      })
    ) : null,

    tab.value === 'datasets' ? Panel({
      title: 'Datasets',
      actions: can('storage:write') ? h('button', { class: 'btn btn-sm btn-primary', onClick: () => dialog.set('dataset') }, Icon({ name: 'plus', size: 14 }), 'New dataset') : null
    },
      DataTable({
        columns: datasetColumns, rows: datasets.value, keyField: 'name', empty: 'No datasets', emptyIcon: 'layers',
        actions: can('storage:write') ? (r) => iconBtn({ name: 'trash', title: 'Delete', onClick: async () => {
          try { await api.storage.deleteDataset(r.name); toast('Dataset deleted', 'success'); refresh(); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } }) : undefined
      })
    ) : null,

    tab.value === 'snapshots' ? Panel({
      title: 'Storage snapshots',
      actions: can('storage:write') ? h('button', { class: 'btn btn-sm btn-primary', onClick: () => dialog.set('snapshot') }, Icon({ name: 'plus', size: 14 }), 'Take snapshot') : null
    },
      DataTable({ columns: snapshotColumns, rows: snapshots.value, keyField: 'name', empty: 'No snapshots yet', emptyIcon: 'camera' })
    ) : null,

    tab.value === 'smart' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'SMART schedule' },
        h('div', { class: 'stack' },
          h('div', { class: 'kv' },
            h('dt', {}, 'Last result'), h('dd', {}, String(smart.value?.lastResult || smart.value?.status || '—')),
            h('dt', {}, 'Next test'), h('dd', {}, String(smart.value?.nextRun || '—')),
            h('dt', {}, 'Schedule'), h('dd', {}, String(smartForm.value.schedule))
          ),
          Toggle({ label: 'Enable scheduled tests', name: 'smart-enabled', checked: !!smartForm.value.enabled, onChange: (v) => smartForm.set({ ...smartForm.value, enabled: v }) }),
          Select({ label: 'Frequency', name: 'smart-sched', value: smartForm.value.schedule, options: ['daily', 'weekly', 'monthly'].map((s) => ({ value: s, label: s })), onChange: (v) => smartForm.set({ ...smartForm.value, schedule: v }) }),
          Select({ label: 'Test type', name: 'smart-test', value: smartForm.value.test, options: ['short', 'long', 'conveyance'].map((s) => ({ value: s, label: s })), onChange: (v) => smartForm.set({ ...smartForm.value, test: v }) }),
          h('button', { class: 'btn btn-primary', disabled: !can('storage:write'), onClick: saveSmart }, Icon({ name: 'save', size: 14 }), 'Save schedule')
        )
      ),
      Panel({ title: 'SMART results' },
        smart.value?.results ? DataTable({
          columns: [
            { key: 'disk', label: 'Disk' }, { key: 'result', label: 'Result', render: (r) => Badge({ kind: /pass/i.test(String(r.result)) ? 'success' : 'danger', text: String(r.result || '—') }) },
            { key: 'temp', label: 'Temperature' }
          ], rows: smart.value.results, keyField: 'disk', empty: 'No SMART results'
        }) : EmptyState({ title: 'No SMART results reported', icon: 'activity' })
      )
    ) : null,

    dialog.value === 'assign' && selected.value ? Modal({
      title: 'Assign disk role', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: assignRole }, 'Assign'))
    },
      h('p', { class: 'small muted' }, 'Disk: ', h('span', { class: 'mono' }, selected.value.id), ' — ', selected.value.model || ''),
      Select({
        label: 'Role', name: 'disk-role', value: selected.value.role || 'data',
        options: [{ value: 'parity', label: 'Parity' }, { value: 'data', label: 'Data' }, { value: 'cache', label: 'Cache / SSD' }],
        onChange: () => { /* read directly on assign to keep this modal simple */ }
      })
    ) : null,

    dialog.value === 'dataset' ? Modal({
      title: 'Create dataset', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: addDataset }, 'Create'))
    },
      h('div', { class: 'form-grid' },
        Input({ label: 'Name', name: 'ds-name', value: datasetForm.value.name, placeholder: 'tank/media', onChange: (v) => datasetForm.set({ ...datasetForm.value, name: v }) }),
        Input({ label: 'Pool', name: 'ds-pool', value: datasetForm.value.pool, onChange: (v) => datasetForm.set({ ...datasetForm.value, pool: v }) }),
        Select({ label: 'Compression', name: 'ds-comp', value: datasetForm.value.compression, options: ['off', 'lz4', 'zstd', 'gzip'].map((c) => ({ value: c, label: c })), onChange: (v) => datasetForm.set({ ...datasetForm.value, compression: v }) }),
        Input({ label: 'Quota (e.g. 500G)', name: 'ds-quota', value: datasetForm.value.quota, onChange: (v) => datasetForm.set({ ...datasetForm.value, quota: v }) })
      )
    ) : null,

    dialog.value === 'snapshot' ? Modal({
      title: 'Create storage snapshot', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: addSnapshot }, 'Snapshot'))
    },
      Select({
        label: 'Dataset', name: 'snap-ds', value: snapshotForm.value.dataset,
        options: [{ value: '', label: 'Select dataset…' }].concat(datasets.value.map((d) => ({ value: d.name, label: d.name }))),
        onChange: (v) => snapshotForm.set({ ...snapshotForm.value, dataset: v })
      }),
      Input({ label: 'Snapshot name', name: 'snap-name', value: snapshotForm.value.name, placeholder: 'auto if blank', onChange: (v) => snapshotForm.set({ ...snapshotForm.value, name: v }) })
    ) : null
  );
}
