import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { Alert, Event } from '../types.ts';
import { state, can, toast, errorMessage, relativeTime } from '../store.ts';
import { PageHead, Panel, DataTable, Badge, StatusDot, Icon, Tabs, Modal, Input, Select, Toggle, EmptyState, Loading, ErrorBanner } from '../components.ts';
import type { Column } from '../components.ts';

const alerts = useState<Alert[]>([]);
const events = useState<Event[]>([]);
const tab = useState<'rules' | 'history'>('rules');
const loading = useState(true);
const error = useState('');
const dialog = useState(false);
const form = useState<any>({ type: 'cpu', target: '', threshold: 85, enabled: true });

export function load(force = false): void {
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  Promise.all([api.alerts.list(), api.events()])
    .then(([a, e]) => { alerts.set(a || []); events.set(e || []); state.alerts.set(a || []); state.events.set(e || []); })
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));
}

async function create(): Promise<void> {
  try {
    await api.alerts.create(form.value);
    toast('Alert rule created', 'success'); dialog.set(false); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

const ruleColumns: Column[] = [
  { key: 'type', label: 'Metric', render: (r) => h('span', { class: 'strong' }, r.type || '—') },
  { key: 'target', label: 'Target', render: (r) => r.target || 'all hosts' },
  { key: 'threshold', label: 'Threshold', render: (r) => r.threshold ?? '—' },
  { key: 'enabled', label: 'State', render: (r) => StatusDot({ status: r.enabled === false ? 'disabled' : 'enabled', label: r.enabled === false ? 'Disabled' : 'Enabled' }) }
];
const eventColumns: Column[] = [
  { key: 'level', label: 'Level', render: (r) => Badge({ kind: /error|crit/.test(String(r.level)) ? 'danger' : /warn/.test(String(r.level)) ? 'warning' : 'info', text: r.level || 'info' }) },
  { key: 'message', label: 'Message', render: (r) => r.message || r.action || '—' },
  { key: 'time', label: 'When', render: (r) => h('span', { class: 'small nowrap' }, relativeTime(r.time)) }
];

export function View(): VNode {
  return h('div', { class: 'page' },
    PageHead({
      title: 'Alerts',
      subtitle: 'Thresholds and recent system notifications',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        can('alert:write') ? h('button', { class: 'btn btn-primary', onClick: () => dialog.set(true) }, Icon({ name: 'plus', size: 15 }), 'New rule') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Loading alerts…' }) : null,
    Tabs({ tabs: [{ id: 'rules', label: 'Rules' }, { id: 'history', label: 'Event history' }], active: tab.value, onChange: (id) => tab.set(id as 'rules' | 'history') }),

    tab.value === 'rules' ? Panel({ title: 'Alert rules', actions: Badge({ text: alerts.value.length + ' rules' }) },
      DataTable({ columns: ruleColumns, rows: alerts.value, keyField: 'id', empty: 'No alert rules configured', emptyIcon: 'bell' })
    ) : null,
    tab.value === 'history' ? Panel({ title: 'Recent events', actions: Badge({ text: events.value.length + ' events' }) },
      DataTable({ columns: eventColumns, rows: events.value, keyField: 'id', empty: 'No events recorded', emptyIcon: 'activity' })
    ) : null,

    dialog.value ? Modal({
      title: 'Create alert rule', onClose: () => dialog.set(false),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(false) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: create }, 'Create rule'))
    },
      Select({
        label: 'Metric', name: 'al-type', value: form.value.type,
        options: ['cpu', 'memory', 'disk', 'temperature', 'array_errors', 'app_update'].map((t) => ({ value: t, label: t })),
        onChange: (v) => form.set({ ...form.value, type: v })
      }),
      Input({ label: 'Target (optional)', name: 'al-target', value: form.value.target, placeholder: 'hostname or dataset', onChange: (v) => form.set({ ...form.value, target: v }) }),
      Input({ label: 'Threshold', name: 'al-threshold', type: 'number', value: form.value.threshold, onChange: (v) => form.set({ ...form.value, threshold: Number(v) }) }),
      Toggle({ label: 'Enabled', name: 'al-enabled', checked: !!form.value.enabled, onChange: (v) => form.set({ ...form.value, enabled: v }) })
    ) : null
  );
}
