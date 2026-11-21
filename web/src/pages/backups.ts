import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { Backup, Event } from '../types.ts';
import { can, toast, errorMessage, relativeTime } from '../store.ts';
import { PageHead, Panel, DataTable, Badge, StatusDot, Icon, Modal, Input, Select, Toggle, EmptyState, Loading, ErrorBanner, iconBtn } from '../components.ts';
import type { Column } from '../components.ts';

const backups = useState<Backup[]>([]);
const history = useState<Event[]>([]);
const loading = useState(true);
const error = useState('');
const dialog = useState(false);
const busy = useState('');
const form = useState<any>({ name: '', target: 'tank/backups', schedule: 'daily 02:00', retention: 7, enabled: true });

export function load(force = false): void {
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  Promise.all([api.backups.list(), api.events()])
    .then(([b, e]) => { backups.set(b || []); history.set((e || []).filter((x) => /backup|snapshot/i.test(String(x.action || x.message || '')))); })
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));
}

async function create(): Promise<void> {
  if (!form.value.name) { toast('Job name required', 'warning'); return; }
  try {
    await api.backups.create(form.value);
    toast('Backup job created', 'success'); dialog.set(false); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function runNow(job: Backup): Promise<void> {
  busy.set(String(job.id));
  try { await api.backups.run(String(job.id)); toast('Backup job started', 'success'); refresh(); }
  catch (err) { toast(errorMessage(err), 'error'); }
  finally { busy.set(''); }
}

const columns: Column[] = [
  { key: 'name', label: 'Job', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.name || r.id), h('div', { class: 'tiny dim mono' }, r.target || '')) },
  { key: 'schedule', label: 'Schedule', render: (r) => h('span', { class: 'mono small' }, r.schedule || 'manual') },
  { key: 'retention', label: 'Retention', render: (r) => r.retention ? r.retention + ' copies' : '—' },
  { key: 'lastRun', label: 'Last run', render: (r) => relativeTime(r.lastRun) },
  { key: 'status', label: 'State', render: (r) => StatusDot({ status: r.enabled === false ? 'disabled' : (r.status || 'idle'), label: r.status || (r.enabled === false ? 'Disabled' : 'Idle') }) }
];

export function View(): VNode {
  return h('div', { class: 'page' },
    PageHead({
      title: 'Backups',
      subtitle: 'Scheduled snapshots and off-site jobs',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        can('backup:write') ? h('button', { class: 'btn btn-primary', onClick: () => dialog.set(true) }, Icon({ name: 'plus', size: 15 }), 'New job') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Loading backup jobs…' }) : null,

    h('div', { class: 'grid grid-main' },
      Panel({ title: 'Backup schedules', actions: Badge({ text: backups.value.length + ' jobs' }) },
        DataTable({
          columns, rows: backups.value, keyField: 'id', empty: 'No backup jobs configured', emptyIcon: 'backup',
          actions: (r) => iconBtn({ name: 'play', title: 'Run now', disabled: !can('backup:write') || busy.value === String(r.id), onClick: () => runNow(r) })
        })
      ),
      Panel({ title: 'Recent backup events' },
        history.value.length ? h('div', { class: 'stack' }, ...history.value.slice(0, 20).map((e) =>
          h('div', { class: 'list-row', key: e.id },
            h('span', { class: 'grow' }, h('div', { class: 'small' }, e.message || e.action || 'Backup event'), h('div', { class: 'tiny dim' }, relativeTime(e.time))),
            Badge({ kind: /fail|error/.test(String(e.level)) ? 'danger' : 'success', text: e.level || 'ok' })
          )
        )) : EmptyState({ title: 'No backup events yet', icon: 'clock' })
      )
    ),

    dialog.value ? Modal({
      title: 'Create backup job', onClose: () => dialog.set(false),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(false) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: create }, 'Create job'))
    },
      h('div', { class: 'form-grid' },
        Input({ label: 'Job name', name: 'bk-name', value: form.value.name, onChange: (v) => form.set({ ...form.value, name: v }) }),
        Input({ label: 'Target', name: 'bk-target', value: form.value.target, onChange: (v) => form.set({ ...form.value, target: v }) }),
        Input({ label: 'Schedule', name: 'bk-sched', value: form.value.schedule, placeholder: 'daily 02:00', onChange: (v) => form.set({ ...form.value, schedule: v }) }),
        Input({ label: 'Retention (copies)', name: 'bk-ret', type: 'number', value: form.value.retention, onChange: (v) => form.set({ ...form.value, retention: Number(v) }) })
      ),
      Toggle({ label: 'Enabled', name: 'bk-enabled', checked: !!form.value.enabled, onChange: (v) => form.set({ ...form.value, enabled: v }) })
    ) : null
  );
}
