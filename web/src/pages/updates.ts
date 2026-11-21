import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { UpdateInfo } from '../types.ts';
import { can, toast, errorMessage } from '../store.ts';
import { PageHead, Panel, Badge, StatusDot, StatCard, Tabs, DataTable, EmptyState, Loading, ErrorBanner, Icon } from '../components.ts';
import type { Column } from '../components.ts';

const info = useState<UpdateInfo>({});
const status = useState<UpdateInfo>({});
const appUpdates = useState<any[]>([]);
const repo = useState<any>({});
const tab = useState<'system' | 'apps' | 'repository'>('system');
const loading = useState(true);
const error = useState('');
const installing = useState(false);
let poll: ReturnType<typeof setInterval> | null = null;

export function load(force = false): void {
  refresh();
  if (!poll) poll = setInterval(() => {
    api.updates.status().then(status.set).catch(() => { /* keep last status */ });
  }, 5000);
}

export function dispose(): void {
  if (poll) { clearInterval(poll); poll = null; }
}

function refresh(): void {
  loading.set(true);
  error.set('');
  Promise.all([api.updates.check(), api.updates.status(), api.updates.app(), api.updates.repo()])
    .then(([i, s, a, r]) => { info.set(i || {}); status.set(s || {}); appUpdates.set(a || []); repo.set(r || {}); })
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));
}

async function install(): Promise<void> {
  installing.set(true);
  try {
    const result = await api.updates.install(info.value.latest);
    toast('Update job ' + (result.jobId || '') + ' started', 'success');
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { installing.set(false); }
}

const appColumns: Column[] = [
  { key: 'name', label: 'Application', render: (r) => h('span', { class: 'strong' }, r.name || r.appId || r.id) },
  { key: 'current', label: 'Installed', render: (r) => r.current || r.version || '—' },
  { key: 'latest', label: 'Available', render: (r) => r.latest || '—' },
  { key: 'status', label: 'State', render: (r) => Badge({ kind: 'info', text: r.status || 'update available' }) }
];

export function View(): VNode {
  const progress = Number(status.value.progress || 0);
  return h('div', { class: 'page' },
    PageHead({
      title: 'Updates',
      subtitle: 'System, application and repository maintenance',
      actions: h('button', { class: 'btn', onClick: refresh }, Icon({ name: 'refresh', size: 15 }), 'Check again')
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Checking for updates…' }) : null,

    h('div', { class: 'grid grid-4' },
      StatCard({ label: 'Installed', icon: 'server', value: info.value.current || '—' }),
      StatCard({ label: 'Latest', icon: 'rocket', value: info.value.latest || '—' }),
      StatCard({ label: 'Available', icon: 'download', value: info.value.updateAvailable ? 'Yes' : 'No', foot: info.value.publishedAt || '' }),
      StatCard({ label: 'Job state', icon: 'activity', value: status.value.state || 'idle', foot: String(status.value.message || '') })
    ),

    info.value.updateAvailable ? h('div', { class: 'alert-inline mt-3' },
      'Version ' + (info.value.latest || '') + ' is available. ' +
      (info.value.releaseUrl ? h('a', { href: info.value.releaseUrl, target: '_blank', rel: 'noreferrer' }, 'View release notes') : '')
    ) : null,

    progress > 0 && progress < 100 ? h('div', { class: 'card mt-3', style: { padding: '16px' } },
      h('div', { class: 'row small' }, h('span', {}, status.value.message || 'Installing update'), h('span', { class: 'spacer' }), h('span', { class: 'strong' }, progress.toFixed(0) + '%')),
      h('div', { class: 'progress' }, h('span', { style: { width: progress + '%' } }))
    ) : null,

    h('div', { class: 'mt-3' },
      h('div', { class: 'tabs' },
        h('button', { class: 'tab' + (tab.value === 'system' ? ' active' : ''), onClick: () => tab.set('system') }, 'System update'),
        h('button', { class: 'tab' + (tab.value === 'apps' ? ' active' : ''), onClick: () => tab.set('apps') }, 'App updates (' + appUpdates.value.length + ')'),
        h('button', { class: 'tab' + (tab.value === 'repository' ? ' active' : ''), onClick: () => tab.set('repository') }, 'Repository')
      )
    ),

    tab.value === 'system' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'System release', actions: info.value.updateAvailable ? Badge({ kind: 'warning', text: 'update available' }) : Badge({ kind: 'success', text: 'up to date' }) },
        h('dl', { class: 'kv' },
          h('dt', {}, 'Current version'), h('dd', { class: 'mono' }, info.value.current || '—'),
          h('dt', {}, 'Latest version'), h('dd', { class: 'mono' }, info.value.latest || '—'),
          h('dt', {}, 'Published'), h('dd', {}, info.value.publishedAt || '—'),
          h('dt', {}, 'Channel'), h('dd', {}, repo.value.channel || 'stable')
        ),
        h('button', {
          class: 'btn btn-primary mt-3', disabled: installing.value || !info.value.updateAvailable || !can('update:install'),
          onClick: install
        }, Icon({ name: 'download', size: 15 }), installing.value ? 'Starting…' : 'Install update')
      ),
      Panel({ title: 'Update job' },
        h('dl', { class: 'kv' },
          h('dt', {}, 'State'), h('dd', {}, StatusDot({ status: status.value.state || 'idle', label: status.value.state || 'idle' })),
          h('dt', {}, 'Progress'), h('dd', {}, (status.value.progress || 0) + '%'),
          h('dt', {}, 'Message'), h('dd', {}, status.value.message || '—'),
          h('dt', {}, 'Job ID'), h('dd', { class: 'mono' }, status.value.jobId || '—')
        )
      )
    ) : null,

    tab.value === 'apps' ? Panel({ title: 'Application updates' },
      appUpdates.value.length ? DataTable({ columns: appColumns, rows: appUpdates.value, keyField: 'id', empty: 'No app updates' })
        : EmptyState({ title: 'All applications up to date', icon: 'check' })
    ) : null,

    tab.value === 'repository' ? Panel({ title: 'Repository information' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Name'), h('dd', {}, repo.value.name || 'wrexr-os'),
        h('dt', {}, 'URL'), h('dd', { class: 'mono' }, repo.value.url || '—'),
        h('dt', {}, 'Channel'), h('dd', {}, repo.value.channel || 'stable'),
        h('dt', {}, 'Last sync'), h('dd', {}, repo.value.lastSync || '—'),
        h('dt', {}, 'Status'), h('dd', {}, StatusDot({ status: repo.value.status || 'ok', label: repo.value.status || 'ok' }))
      ),
      h('button', { class: 'btn mt-3', onClick: async () => {
        try { await api.settings.setUpdates({ ...(repo.value || {}) }); toast('Repository settings saved', 'success'); refresh(); }
        catch (err) { toast(errorMessage(err), 'error'); }
      } }, Icon({ name: 'save', size: 14 }), 'Save repository settings')
    ) : null
  );
}
