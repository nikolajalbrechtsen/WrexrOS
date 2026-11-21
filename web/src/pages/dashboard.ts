import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { DashboardData, Metrics, MetricsHistory } from '../types.ts';
import { state, metricNumber, metricRatio, humanBytes, relativeTime, errorMessage } from '../store.ts';
import { PageHead, StatCard, Panel, Badge, StatusDot, LineChart, DataTable, Loading, ErrorBanner, EmptyState, Icon, Tabs, navigate } from '../components.ts';
import type { Column } from '../components.ts';

const data = useState<DashboardData | null>(null);
const loading = useState(true);
const error = useState('');
const live = useState<Metrics | null>(null);
const localHistory = useState<MetricsHistory>({ cpu: [], ram: [], network: [] });
const activityTab = useState<'events' | 'alerts'>('events');

let loaded = false;
let wsStarted = false;

export function load(force = false): void {
  if (loaded && !force) return;
  loaded = true;
  loading.set(true);
  error.set('');
  Promise.all([api.dashboard(), api.history()])
    .then(([dash, hist]) => {
      data.set(dash);
      const next: MetricsHistory = {
        cpu: (hist && hist.cpu) || [],
        ram: (hist && hist.ram) || [],
        network: (hist && hist.network) || []
      };
      localHistory.set(next);
      state.history.set(next);
      state.events.set((dash && dash.events) || []);
      state.alerts.set((dash && dash.alerts) || []);
      if (dash && dash.metrics) live.set(dash.metrics);
    })
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));

  if (!wsStarted) {
    wsStarted = true;
    api.connectWS('/ws/metrics', {
      onMessage: (msg: any) => {
        if (!msg || msg.type !== 'metrics') return;
        const metrics: Metrics = msg.data || msg;
        live.set(metrics);
        state.metrics.set(metrics);
        localHistory.set((old) => {
          const next = {
            cpu: old.cpu.concat(metricRatio(metrics.cpu)).slice(-60),
            ram: old.ram.concat(metricRatio(metrics.ram)).slice(-60),
            network: old.network.concat(metricNumber(metrics.network && (metrics.network as any).rx)).slice(-60)
          };
          state.history.set(next);
          return next;
        });
      }
    });
  }
}

function pct(value: any): number { return Math.round(metricRatio(value) * 10) / 10; }

export function View(): VNode {
  const d = data.value;
  const m = live.value || (d && d.metrics) || {};
  const hist = localHistory.value;
  const counts = (d && d.counts) || {};

  const eventColumns: Column[] = [
    { key: 'level', label: '', width: '36px', render: (r) => h('span', { class: 'status-dot ' + (/error|crit|danger/.test(String(r.level)) ? 'err' : /warn/.test(String(r.level)) ? 'warn' : 'ok') }) },
    { key: 'message', label: 'Message', render: (r) => h('div', {}, h('div', { class: 'truncate', style: { maxWidth: '460px' } }, r.message || r.action || 'Event'), h('div', { class: 'tiny dim' }, r.actor || r.sourceIp || '')) },
    { key: 'time', label: 'When', render: (r) => h('span', { class: 'small muted nowrap' }, relativeTime(r.time)) }
  ];
  const alertColumns: Column[] = [
    { key: 'type', label: 'Rule', render: (r) => h('span', { class: 'strong' }, r.type || r.message || 'Alert') },
    { key: 'target', label: 'Target', render: (r) => r.target || '—' },
    { key: 'threshold', label: 'Threshold', render: (r) => r.threshold === undefined ? '—' : String(r.threshold) },
    { key: 'enabled', label: 'State', render: (r) => StatusDot({ status: r.enabled === false ? 'disabled' : 'enabled', label: r.enabled === false ? 'Off' : 'On' }) }
  ];

  return h('div', { class: 'page' },
    PageHead({
      title: 'Dashboard',
      subtitle: d && d.host ? (d.host.hostname || 'System overview') + ' · ' + (d.host.version || '') : 'System overview',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: () => { load(true); } }, Icon({ name: 'refresh', size: 15 }), 'Refresh'),
        h('button', { class: 'btn btn-primary', onClick: () => navigate('/vms') }, Icon({ name: 'plus', size: 15 }), 'New VM')
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: () => load(true) }) : null,
    loading.value && !d ? Loading({ label: 'Collecting host metrics…' }) : null,

    d ? h(Fragment, {},
      h('div', { class: 'grid grid-4' },
        StatCard({ label: 'CPU', icon: 'cpu', value: String(pct(m.cpu)), unit: '%', percent: pct(m.cpu), foot: (m.cpu as any)?.temp ? ((m.cpu as any).temp + ' °C') : ((d.host.cores || 0) + ' cores') }),
        StatCard({ label: 'Memory', icon: 'memory', value: String(pct(m.ram)), unit: '%', percent: pct(m.ram), foot: humanBytes((m.ram as any)?.used) + ' / ' + humanBytes((m.ram as any)?.total) }),
        StatCard({ label: 'Disk', icon: 'disk', value: String(pct(m.disk)), unit: '%', percent: pct(m.disk), foot: humanBytes((m.disk as any)?.used) + ' / ' + humanBytes((m.disk as any)?.total) }),
        StatCard({ label: 'Network', icon: 'network', value: humanBytes((m.network as any)?.rx || metricNumber(m.network)), unit: '/s', foot: 'RX ' + humanBytes((m.network as any)?.rx) + ' · TX ' + humanBytes((m.network as any)?.tx) })
      ),

      h('div', { class: 'grid grid-2 mt-3' },
        Panel({ title: 'CPU & memory history', actions: Badge({ kind: 'accent', text: 'live · 2s' }) },
          LineChart({
            height: 220, unit: '%',
            series: [
              { name: 'CPU', color: '#2dd4bf', data: hist.cpu },
              { name: 'Memory', color: '#a78bfa', data: hist.ram }
            ]
          })
        ),
        Panel({ title: 'Network throughput', actions: Badge({ text: 'KB/s' }) },
          LineChart({ height: 220, unit: '', series: [{ name: 'RX', color: '#38bdf8', data: hist.network }] })
        )
      ),

      h('div', { class: 'grid grid-3 mt-3' },
        Panel({ title: 'Compute', actions: h('button', { class: 'btn btn-sm', onClick: () => navigate('/vms') }, 'Manage') },
          h('div', { class: 'kv' },
            h('dt', {}, 'Virtual machines'), h('dd', {}, String(counts.vms || 0)),
            h('dt', {}, 'Containers'), h('dd', {}, String(counts.containers || 0)),
            h('dt', {}, 'Docker apps'), h('dd', {}, String(counts.apps || 0)),
            h('dt', {}, 'Shares'), h('dd', {}, String(counts.shares || 0))
          )
        ),
        Panel({ title: 'Array health', actions: h('button', { class: 'btn btn-sm', onClick: () => navigate('/storage') }, 'Open') },
          h('div', { class: 'stack' },
            h('div', { class: 'row' },
              StatusDot({ status: d.array?.status || 'unknown', label: d.array?.status || 'Unknown', pulse: true }),
              h('span', { class: 'spacer' }),
              h('span', { class: 'small muted' }, humanBytes(d.array?.used) + ' / ' + humanBytes(d.array?.total))
            ),
            d.array?.syncProgress !== undefined ? h(Fragment, {},
              h('div', { class: 'small muted' }, 'Sync ' + Number(d.array.syncProgress).toFixed(1) + '%'),
              h('div', { class: 'progress' }, h('span', { style: { width: Math.min(100, Number(d.array.syncProgress)) + '%' } }))
            ) : null,
            (d.array?.errors || []).length ? h('div', { class: 'alert-inline' }, (d.array?.errors || []).join(', ')) : h('div', { class: 'small dim' }, 'No array errors reported.')
          )
        ),
        Panel({ title: 'Host', actions: Badge({ kind: 'success', text: 'online' }) },
          h('div', { class: 'kv' },
            h('dt', {}, 'Hostname'), h('dd', {}, d.host?.hostname || state.authStatus.value?.hostname || '—'),
            h('dt', {}, 'Kernel'), h('dd', { class: 'mono small' }, d.host?.kernel || '—'),
            h('dt', {}, 'Uptime'), h('dd', {}, typeof d.host?.uptime === 'number' ? Math.floor(d.host.uptime / 3600) + ' h' : (d.host?.uptime || '—')),
            h('dt', {}, 'Temperature'), h('dd', {}, d.host?.temperature ? d.host.temperature + ' °C' : '—')
          )
        )
      ),

      h('div', { class: 'grid grid-main mt-3' },
        Panel({
          title: 'Recent activity',
          actions: h('div', { class: 'row' },
            Tabs({
              tabs: [{ id: 'events', label: 'Events' }, { id: 'alerts', label: 'Alerts' }],
              active: activityTab.value,
              onChange: (id) => activityTab.set(id as 'events' | 'alerts')
            })
          )
        },
          activityTab.value === 'events'
            ? (state.events.value.length
              ? DataTable({ columns: eventColumns, rows: state.events.value.slice(0, 12), keyField: 'id', compact: true, empty: 'No recent events' })
              : EmptyState({ title: 'No recent events', icon: 'activity' }))
            : (state.alerts.value.length
              ? DataTable({ columns: alertColumns, rows: state.alerts.value, keyField: 'id', compact: true, empty: 'No alert rules' })
              : EmptyState({ title: 'No alert rules', message: 'Create one from the Alerts page.', icon: 'bell', action: h('button', { class: 'btn btn-sm', onClick: () => navigate('/alerts') }, 'Go to alerts') }))
        ),
        Panel({ title: 'Quick actions' },
          h('div', { class: 'stack' },
            quickAction('server', 'Deploy virtual machine', 'KVM or LXC from template', '/vms'),
            quickAction('apps', 'Install an app', 'Browse the trusted catalog', '/apps'),
            quickAction('share', 'Create a network share', 'SMB, NFS or FTP', '/shares'),
            quickAction('backup', 'Configure backups', 'Scheduled snapshots and jobs', '/backups')
          )
        )
      )
    ) : null
  );
}

function quickAction(icon: string, title: string, subtitle: string, route: string): VNode {
  return h('button', { class: 'btn btn-ghost', style: { justifyContent: 'flex-start', padding: '10px', textAlign: 'left' }, onClick: () => navigate(route) },
    h('span', { class: 'stat-icon' }, Icon({ name: icon, size: 17 })),
    h('span', {}, h('span', { class: 'strong small', style: { display: 'block' } }, title), h('span', { class: 'tiny dim', style: { display: 'block' } }, subtitle))
  );
}
