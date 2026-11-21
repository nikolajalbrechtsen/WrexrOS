import { h, Fragment, useState } from '../dom.ts';
import type { VNode } from '../dom.ts';
import { api } from '../api.ts';
import type { CatalogApp, App, Repo } from '../types.ts';
import { can, toast, errorMessage } from '../store.ts';
import {
  PageHead, Panel, DataTable, Badge, StatusDot, Icon, Tabs, Modal, ConfirmDialog,
  Input, Select, Toggle, TextArea, EmptyState, Loading, ErrorBanner, iconBtn
} from '../components.ts';
import type { Column } from '../components.ts';

type Tab = 'catalog' | 'installed' | 'repos';
type Dialog = null | 'install' | 'logs' | 'remove' | 'repo';

const catalog = useState<CatalogApp[]>([]);
const installed = useState<App[]>([]);
const repos = useState<Repo[]>([]);
const logs = useState<string[]>([]);
const tab = useState<Tab>('catalog');
const dialog = useState<Dialog>(null);
const selected = useState<any>(null);
const loading = useState(true);
const error = useState('');
const query = useState('');
const category = useState('all');
const busy = useState('');
const form = useState<any>({ appId: '', name: '', env: '', ports: '', volumes: '', cpu: '', memory: '' });
const repoForm = useState<any>({ url: '', trusted: false });

let loaded = false;

export function load(force = false): void {
  if (loaded && !force) return;
  loaded = true;
  refresh();
}

function refresh(): void {
  loading.set(true);
  error.set('');
  Promise.all([api.apps.catalog(), api.apps.installed(), api.apps.repos()])
    .then(([c, i, r]) => {
      catalog.set((c && c.apps) || []);
      installed.set(i || []);
      repos.set(r || []);
    })
    .catch((err) => error.set(errorMessage(err)))
    .finally(() => loading.set(false));
}

async function install(): Promise<void> {
  const f = form.value;
  if (!f.appId) { toast('Select an application', 'warning'); return; }
  busy.set('install');
  try {
    await api.apps.install({
      appId: f.appId,
      name: f.name || undefined,
      env: parseLines(f.env),
      ports: parsePorts(f.ports),
      volumes: parseLines(f.volumes),
      limits: { cpus: f.cpu ? Number(f.cpu) : undefined, memory: f.memory ? f.memory + 'm' : undefined }
    });
    toast('Application installed', 'success');
    dialog.set(null);
    form.set({ appId: '', name: '', env: '', ports: '', volumes: '', cpu: '', memory: '' });
    refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { busy.set(''); }
}

function parseLines(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  String(value || '').split('\n').forEach((line) => {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return out;
}

function parsePorts(value: string): string[] {
  return String(value || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

async function openLogs(app: App): Promise<void> {
  selected.set(app);
  logs.set([]);
  dialog.set('logs');
  try {
    const result = await api.apps.logs(app.id);
    logs.set(result?.lines || []);
  } catch (err) { toast(errorMessage(err), 'error'); }
}

async function appAction(app: App, action: string): Promise<void> {
  try { await api.apps.action(app.id, action); toast(app.name || app.id + ' → ' + action, 'success'); refresh(); }
  catch (err) { toast(errorMessage(err), 'error'); }
}

async function addRepo(): Promise<void> {
  if (!repoForm.value.url) { toast('Repository URL required', 'warning'); return; }
  try {
    await api.apps.addRepo(repoForm.value);
    toast('Repository added', 'success'); dialog.set(null);
    repoForm.set({ url: '', trusted: false }); refresh();
  } catch (err) { toast(errorMessage(err), 'error'); }
}

const installedColumns: Column[] = [
  { key: 'name', label: 'Application', render: (r) => h('div', {}, h('div', { class: 'strong' }, r.name || r.appId || r.id), h('div', { class: 'tiny dim mono' }, r.image || '')) },
  { key: 'status', label: 'Status', render: (r) => StatusDot({ status: r.status || r.state || 'unknown', pulse: true }) },
  { key: 'version', label: 'Version', render: (r) => r.version || '—' },
  { key: 'ports', label: 'Ports', render: (r) => Array.isArray(r.ports) ? r.ports.join(', ') : (r.ports ? Object.keys(r.ports).join(', ') : '—') }
];

export function View(): VNode {
  const categories = ['all'].concat(Array.from(new Set(catalog.value.map((a) => a.category || 'other'))));
  const filtered = catalog.value.filter((a) => {
    const q = !query.value || (a.name + ' ' + a.description + ' ' + a.id).toLowerCase().includes(query.value.toLowerCase());
    const c = category.value === 'all' || (a.category || 'other') === category.value;
    return q && c;
  });
  const updates = catalog.value.filter((a) => a.updateAvailable).length;

  return h('div', { class: 'page' },
    PageHead({
      title: 'App store',
      subtitle: catalog.value.length + ' catalog entries · ' + updates + ' updates available',
      actions: h(Fragment, {},
        h('button', { class: 'btn', onClick: async () => {
          try { await api.apps.syncRepos(); toast('Catalog synced', 'success'); refresh(); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } }, Icon({ name: 'refresh', size: 15 }), 'Sync catalog'),
        tab.value === 'repos' && can('app:write') ? h('button', { class: 'btn btn-primary', onClick: () => dialog.set('repo') }, Icon({ name: 'plus', size: 15 }), 'Add repository') : null
      )
    }),
    error.value ? ErrorBanner({ message: error.value, onRetry: refresh }) : null,
    loading.value ? Loading({ label: 'Loading catalog…' }) : null,

    Tabs({
      tabs: [{ id: 'catalog', label: 'Catalog' }, { id: 'installed', label: 'Installed (' + installed.value.length + ')' }, { id: 'repos', label: 'Repositories' }],
      active: tab.value, onChange: (id) => tab.set(id as Tab)
    }),

    tab.value === 'catalog' ? h(Fragment, {},
      h('div', { class: 'row mb-2' },
        h('div', { class: 'inline-search', style: { flex: '1' } }, Icon({ name: 'search', size: 15 }), h('input', {
          class: 'input', placeholder: 'Search applications…', value: query.value, style: { paddingLeft: '32px' },
          onInput: (e: Event) => query.set((e.target as HTMLInputElement).value)
        })),
        Select({ name: 'app-cat', value: category.value, options: categories.map((c) => ({ value: c, label: c === 'all' ? 'All categories' : c })), onChange: (v) => category.set(v) })
      ),
      filtered.length ? h('div', { class: 'grid grid-4' }, ...filtered.map((app) => h('div', { class: 'app-tile', key: app.id },
        h('div', { class: 'row' },
          h('span', { class: 'app-icon' }, app.icon ? h('img', { src: app.icon, alt: '' }) : (app.name || '?').charAt(0).toUpperCase()),
          h('span', { class: 'spacer' }),
          app.trusted ? Badge({ kind: 'success', text: '✓ trusted' }) : Badge({ kind: 'warning', text: 'community' })
        ),
        h('div', {}, h('div', { class: 'app-name' }, app.name), h('div', { class: 'tiny dim' }, app.category || 'application')),
        h('div', { class: 'app-desc' }, app.description || 'No description provided.'),
        h('div', { class: 'row' },
          h('span', { class: 'tiny dim mono' }, 'v' + (app.version || '—')),
          app.updateAvailable ? Badge({ kind: 'info', text: 'update' }) : null,
          app.installed ? Badge({ kind: 'accent', text: 'installed' }) : null
        ),
        h('button', {
          class: 'btn btn-primary btn-sm btn-block', disabled: !can('app:install'),
          onClick: () => { form.set({ ...form.value, appId: app.id, name: app.name }); dialog.set('install'); }
        }, app.installed ? 'Install again' : 'Install')
      ))) : EmptyState({ title: 'No apps match your filter', icon: 'apps' })
    ) : null,

    tab.value === 'installed' ? Panel({ title: 'Installed containers', actions: Badge({ text: installed.value.length + ' running/managed' }) },
      DataTable({
        columns: installedColumns, rows: installed.value, keyField: 'id', empty: 'No applications installed', emptyIcon: 'apps',
        actions: (app) => h(Fragment, {},
          iconBtn({ name: 'file', title: 'Logs', onClick: () => openLogs(app) }),
          iconBtn({ name: 'play', title: 'Start', disabled: !can('app:write'), onClick: () => appAction(app, 'start') }),
          iconBtn({ name: 'stop', title: 'Stop', disabled: !can('app:write'), onClick: () => appAction(app, 'stop') }),
          iconBtn({ name: 'rotate', title: 'Restart', disabled: !can('app:write'), onClick: () => appAction(app, 'restart') }),
          iconBtn({ name: 'refresh', title: 'Upgrade', disabled: !can('app:write'), onClick: () => appAction(app, 'upgrade') }),
          iconBtn({ name: 'trash', title: 'Remove', disabled: !can('app:write'), onClick: () => { selected.set(app); dialog.set('remove'); } })
        )
      })
    ) : null,

    tab.value === 'repos' ? h('div', { class: 'grid grid-2' },
      Panel({ title: 'Template repositories' },
        repos.value.length ? h('div', { class: 'stack' }, ...repos.value.map((r) =>
          h('div', { class: 'list-row', key: r.id || r.url },
            h('span', { class: 'grow' }, h('div', { class: 'title mono small' }, r.url), h('div', { class: 'sub' }, r.status || 'synced')),
            r.trusted ? Badge({ kind: 'success', text: 'trusted' }) : Badge({ kind: 'warning', text: 'untrusted' }),
            iconBtn({ name: 'trash', title: 'Remove', disabled: !can('app:write'), onClick: async () => {
              if (!r.id) return;
              try { await api.apps.removeRepo(r.id); toast('Repository removed', 'success'); refresh(); }
              catch (err) { toast(errorMessage(err), 'error'); }
            } })
          )
        )) : EmptyState({ title: 'No custom repositories', icon: 'link' })
      ),
      Panel({ title: 'Repository info' },
        h('p', { class: 'small muted' }, 'Custom template repositories extend the catalog with additional application definitions. Only mark repositories as trusted when you control their contents.'),
        h('button', { class: 'btn', onClick: async () => {
          try { await api.apps.syncRepos(); toast('Repositories synced', 'success'); refresh(); }
          catch (err) { toast(errorMessage(err), 'error'); }
        } }, Icon({ name: 'refresh', size: 14 }), 'Sync now')
      )
    ) : null,

    dialog.value === 'install' ? Modal({
      title: 'Install ' + (catalog.value.find((a) => a.id === form.value.appId)?.name || 'application'),
      onClose: () => dialog.set(null),
      footer: h(Fragment, {},
        h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', disabled: busy.value === 'install' || !can('app:install'), onClick: install }, busy.value === 'install' ? 'Installing…' : 'Install')
      )
    },
      h('div', { class: 'form-grid' },
        Select({
          label: 'Application', name: 'in-app', value: form.value.appId,
          options: catalog.value.map((a) => ({ value: a.id, label: a.name })),
          onChange: (v) => form.set({ ...form.value, appId: v, name: catalog.value.find((a) => a.id === v)?.name || form.value.name })
        }),
        Input({ label: 'Container name', name: 'in-name', value: form.value.name, onChange: (v) => form.set({ ...form.value, name: v }) }),
        Input({ label: 'CPU limit', name: 'in-cpu', value: form.value.cpu, placeholder: '2', onChange: (v) => form.set({ ...form.value, cpu: v }) }),
        Input({ label: 'Memory limit (MiB)', name: 'in-mem', value: form.value.memory, placeholder: '512', onChange: (v) => form.set({ ...form.value, memory: v }) })
      ),
      TextArea({ label: 'Environment (KEY=value, one per line)', name: 'in-env', value: form.value.env, onChange: (v) => form.set({ ...form.value, env: v }) }),
      TextArea({ label: 'Ports (e.g. 8080:80, one per line)', name: 'in-ports', value: form.value.ports, onChange: (v) => form.set({ ...form.value, ports: v }) }),
      TextArea({ label: 'Volumes (host:container, one per line)', name: 'in-vols', value: form.value.volumes, onChange: (v) => form.set({ ...form.value, volumes: v }) })
    ) : null,

    dialog.value === 'logs' ? Modal({
      title: 'Logs · ' + (selected.value?.name || selected.value?.id || ''), size: 'wide',
      onClose: () => dialog.set(null),
      footer: h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Close')
    },
      logs.value.length ? h('pre', { class: 'log-view' }, logs.value.join('\n')) : Loading({ label: 'Fetching logs…' })
    ) : null,

    dialog.value === 'repo' ? Modal({
      title: 'Add template repository', onClose: () => dialog.set(null),
      footer: h(Fragment, {}, h('button', { class: 'btn', onClick: () => dialog.set(null) }, 'Cancel'), h('button', { class: 'btn btn-primary', onClick: addRepo }, 'Add repository'))
    },
      Input({ label: 'Repository URL', name: 'repo-url', value: repoForm.value.url, placeholder: 'https://…', onChange: (v) => repoForm.set({ ...repoForm.value, url: v }) }),
      Toggle({ label: 'Trusted source', name: 'repo-trust', checked: !!repoForm.value.trusted, onChange: (v) => repoForm.set({ ...repoForm.value, trusted: v }) })
    ) : null,

    dialog.value === 'remove' && selected.value ? ConfirmDialog({
      title: 'Remove application?', message: (selected.value.name || selected.value.id) + ' will be stopped and removed.',
      danger: true, confirmLabel: 'Remove',
      onConfirm: async () => {
        try { await api.apps.remove(selected.value.id); toast('Application removed', 'success'); refresh(); }
        catch (err) { toast(errorMessage(err), 'error'); throw err; }
      },
      onClose: () => dialog.set(null)
    }) : null
  );
}
