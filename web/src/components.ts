// Reusable UI kit. Every component returns a VNode built with h().
import { h, rawSvg, Fragment, useState } from './dom.ts';
import type { VNode, Child, Props, Store } from './dom.ts';
import { api } from './api.ts';
import { state, can, toggleTheme, dismissToast } from './store.ts';

/* ------------------------------------------------------------------ icons */
const ICONS: Record<string, string> = {
  dashboard: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  server: '<rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
  box: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="M3 7v10l9 5 9-5V7M12 12v10"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M12 15V3m0 0L8 7m4-4 4 4"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.1l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  terminal: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="m6 9 3 3-3 3m6 0h6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="m6 3 14 9-14 9V3Z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  camera: '<path d="M4 7h3l2-3h6l2 3h3v13H4V7Z"/><circle cx="12" cy="13" r="4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7M10 11v6m4-6v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5Z"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3"/>',
  upload: '<path d="M12 16V4m0 0 4 4m-4-4L8 8M4 17v3h16v-3"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
  memory: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11v2m4-2v2m4-2v2m4-2v2M6 7V4m12 3V4M6 20v-3m12 3v-3"/>',
  disk: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h7M11 16.5h7"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-4h14v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M17 5a3.5 3.5 0 0 1 0 7m1 3a6 6 0 0 1 4 5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9 2 2-2 2 2 2-3 3-2-2-2 2"/>',
  plug: '<path d="M9 3v6m6-6v6M6 9h12v3a6 6 0 0 1-12 0V9Zm6 9v3"/>',
  cluster: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="8.5" y="14" width="7" height="7" rx="1"/><path d="M6.5 10v2h11v-2m-5.5 2v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  backup: '<path d="M12 3a9 9 0 1 1-9 9"/><path d="M3 3v6h6"/><path d="m9 12 2 2 4-4"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-5 3 3 5-7"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  external: '<path d="M14 4h6v6m0-6L10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/>',
  save: '<path d="M5 3h11l3 3v15H5V3Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  activity: '<path d="M2 12h4l3-8 4 16 3-8h6"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5m-18 5 9 5 9-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  logout: '<path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5"/><path d="M14 8l4 4-4 4m4-4H9"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  file: '<path d="M6 2h8l5 5v15H6V2Z"/><path d="M14 2v5h5M9 13h6m-6 4h6"/>',
  rocket: '<path d="M5 15c-1 3-1 5-1 5s2 0 5-1m-4-4 4 4m-4-4 3-6 6-6 5 5-6 6-6 3Z"/><circle cx="15" cy="9" r="1"/>'
};

export function Icon(props: { name: string; size?: number; class?: string }): VNode {
  const path = ICONS[props.name] || ICONS.info;
  const size = props.size || 18;
  const markup = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  return h('span', { class: 'icon ' + (props.class || ''), style: { width: size, height: size } }, rawSvg(markup, true));
}

export function iconBtn(props: { name: string; title?: string; onClick?: () => void; disabled?: boolean; class?: string }): VNode {
  return h('button', {
    class: 'icon-btn ' + (props.class || ''), title: props.title || props.name,
    'aria-label': props.title || props.name, disabled: !!props.disabled,
    onClick: (e: Event) => { e.stopPropagation(); if (props.onClick) props.onClick(); }
  }, Icon({ name: props.name, size: 17 }));
}

export function navigate(path: string): void {
  window.dispatchEvent(new CustomEvent('wrexr:navigate', { detail: path }));
}

/* --------------------------------------------------------------- sidebar */
const NAV: Array<{ label: string; items: Array<{ path: string; label: string; icon: string; permission?: string; badge?: string }> }> = [
  {
    label: 'Overview',
    items: [
      { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', permission: 'dashboard:read' },
      { path: '/updates', label: 'Updates', icon: 'refresh', permission: 'update:read', badge: 'updates' },
      { path: '/alerts', label: 'Alerts', icon: 'bell', permission: 'alert:read', badge: 'alerts' }
    ]
  },
  {
    label: 'Compute',
    items: [
      { path: '/vms', label: 'Virtual machines', icon: 'server', permission: 'vm:read', badge: 'vms' },
      { path: '/containers', label: 'Containers', icon: 'box', permission: 'vm:read' },
      { path: '/apps', label: 'App store', icon: 'apps', permission: 'app:read' },
      { path: '/cluster', label: 'Cluster', icon: 'cluster', permission: 'cluster:read' }
    ]
  },
  {
    label: 'Storage',
    items: [
      { path: '/storage', label: 'Storage', icon: 'disk', permission: 'storage:read' },
      { path: '/shares', label: 'Shares', icon: 'share', permission: 'share:read' },
      { path: '/backups', label: 'Backups', icon: 'backup', permission: 'backup:read' }
    ]
  },
  {
    label: 'System',
    items: [
      { path: '/users', label: 'Users & access', icon: 'users', permission: 'user:read' },
      { path: '/plugins', label: 'Plugins', icon: 'plug', permission: 'plugin:read' },
      { path: '/terminal', label: 'Terminal', icon: 'terminal', permission: 'system:terminal' },
      { path: '/settings', label: 'Settings', icon: 'settings', permission: 'settings:read' }
    ]
  }
];

export function Sidebar(): VNode {
  const route = state.route.value;
  const badgeValue = (name: string): string => {
    if (name === 'alerts') return String(state.alerts.value.length || '');
    if (name === 'updates') return state.updateAvailable.value ? '1' : '';
    if (name === 'vms') return '';
    return '';
  };
  const sections = NAV.map((section) => {
    const items = section.items.filter((item) => !item.permission || can(item.permission));
    if (!items.length) return null;
    return h('div', {},
      h('div', { class: 'nav-label' }, section.label),
      ...items.map((item) => {
        const badge = item.badge ? badgeValue(item.badge) : '';
        return h('a', {
          href: item.path,
          class: 'nav-item' + (route === item.path || route.startsWith(item.path + '/') ? ' active' : ''),
          onClick: (e: Event) => { e.preventDefault(); state.sidebarOpen.set(false); navigate(item.path); }
        },
          Icon({ name: item.icon }),
          h('span', {}, item.label),
          badge ? h('span', { class: 'nav-count' }, badge) : null
        );
      })
    );
  }).filter(Boolean);

  const host = state.authStatus.value;
  return h(Fragment, {},
    state.sidebarOpen.value
      ? h('div', { class: 'sidebar-overlay', onClick: () => state.sidebarOpen.set(false) })
      : null,
    h('aside', { class: 'sidebar' + (state.sidebarOpen.value ? ' open' : '') },
      h('div', { class: 'sidebar-brand' },
        h('img', { src: '/logo.svg', alt: '' }),
        h('div', {},
          h('div', { class: 'brand-name' }, 'WrexrOS'),
          h('div', { class: 'brand-sub' }, host?.hostname || 'control plane')
        )
      ),
      h('div', { class: 'sidebar-scroll' }, ...sections),
      h('div', { class: 'sidebar-foot' },
        h('span', {}, 'v' + (host?.version || '—')),
        h('span', {}, host?.channel || 'stable')
      )
    )
  );
}

/* ---------------------------------------------------------------- topbar */
const SEARCH_ROUTES = NAV.flatMap((s) => s.items)
  .filter((i) => !i.permission || can(i.permission))
  .map((i) => ({ path: i.path, label: i.label, icon: i.icon }));

export function Topbar(props: { title: string; subtitle?: string }): VNode {
  const q = useState('');
  const menuOpen = useState(false);
  const results = SEARCH_ROUTES.filter((r) => !q.value || r.label.toLowerCase().indexOf(q.value.toLowerCase()) >= 0).slice(0, 7);
  const user = state.user.value;

  return h('header', { class: 'topbar' },
    iconBtn({ name: 'menu', title: 'Toggle navigation', class: 'menu-btn', onClick: () => state.sidebarOpen.set(!state.sidebarOpen.value) }),
    h('div', {},
      h('div', { class: 'topbar-title' }, props.title),
      props.subtitle ? h('div', { class: 'topbar-sub' }, props.subtitle) : null
    ),
    h('div', { class: 'topbar-spacer' }),
    h('div', { class: 'inline-search', style: { position: 'relative' } },
      Icon({ name: 'search', size: 15 }),
      h('input', {
        id: 'global-search', class: 'input', type: 'search', placeholder: 'Search  /',
        value: q.value, style: { width: '190px' },
        onInput: (e: Event) => q.set((e.target as HTMLInputElement).value),
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Escape') { q.set(''); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Enter' && results.length) { q.set(''); navigate(results[0].path); }
        }
      }),
      q.value ? h('div', {
        class: 'card', style: { position: 'absolute', top: '42px', right: '0', width: '240px', zIndex: '60', padding: '6px', boxShadow: 'var(--shadow)' }
      }, ...results.map((r) => h('a', {
        href: r.path, class: 'nav-item',
        onClick: (e: Event) => { e.preventDefault(); q.set(''); navigate(r.path); }
      }, Icon({ name: r.icon, size: 15 }), h('span', {}, r.label)))) : null
    ),
    iconBtn({ name: state.theme.value === 'dark' ? 'sun' : 'moon', title: 'Toggle theme', onClick: toggleTheme }),
    iconBtn({ name: 'bell', title: 'Alerts', onClick: () => navigate('/alerts') }),
    h('div', { style: { position: 'relative' } },
      h('button', {
        class: 'btn btn-ghost', onClick: () => menuOpen.set(!menuOpen.value)
      },
        Icon({ name: 'user', size: 16 }),
        h('span', { class: 'small' }, user?.username || user?.name || 'Account')
      ),
      menuOpen.value ? h('div', {
        class: 'card', style: { position: 'absolute', right: '0', top: '44px', width: '210px', zIndex: '60', padding: '8px', boxShadow: 'var(--shadow)' }
      },
        h('div', { class: 'small muted', style: { padding: '8px 10px' } },
          h('div', { class: 'strong' }, user?.name || user?.username || 'User'),
          h('div', { class: 'dim' }, user?.role || '—')
        ),
        h('button', { class: 'nav-item', style: { width: '100%' }, onClick: () => { menuOpen.set(false); navigate('/settings'); } }, Icon({ name: 'settings', size: 15 }), 'Settings'),
        h('button', { class: 'nav-item', style: { width: '100%' }, onClick: async () => {
          menuOpen.set(false);
          try { await api.auth.logout(); } catch { /* ignore */ }
          state.user.set(null);
          state.permissions.set([]);
          window.dispatchEvent(new CustomEvent('wrexr:unauthorized'));
        } }, Icon({ name: 'logout', size: 15 }), 'Sign out')
      ) : null
    )
  );
}

/* -------------------------------------------------------- layout helpers */
export function Card(props: Props, ...children: Child[]): VNode {
  return h('div', { class: 'card ' + (props.class || ''), style: props.style, onClick: props.onClick }, ...children);
}

export function Panel(props: { title: string; actions?: Child; class?: string; tight?: boolean }, ...children: Child[]): VNode {
  return h('section', { class: 'panel ' + (props.class || '') },
    h('div', { class: 'panel-head' },
      h('h2', {}, props.title),
      props.actions ? h('div', { class: 'panel-actions' }, props.actions) : null
    ),
    h('div', { class: 'panel-body' + (props.tight ? ' tight' : '') }, ...children)
  );
}

export function StatCard(props: { label: string; value: string; unit?: string; icon: string; foot?: string; percent?: number; tone?: string }): VNode {
  const pct = props.percent;
  return h('div', { class: 'card stat-card' },
    h('div', { class: 'stat-top' }, h('span', { class: 'stat-icon' }, Icon({ name: props.icon, size: 17 })), h('span', {}, props.label)),
    h('div', { class: 'stat-value' }, props.value, props.unit ? h('small', {}, ' ' + props.unit) : null),
    pct !== undefined ? h('div', { class: 'progress' + (pct > 85 ? ' warn' : '') }, h('span', { style: { width: Math.min(100, Math.max(0, pct)) + '%' } })) : null,
    props.foot ? h('div', { class: 'stat-foot' }, h('span', {}, props.foot)) : null
  );
}

export function PageHead(props: { title: string; subtitle?: string; actions?: Child }): VNode {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, props.title), props.subtitle ? h('p', {}, props.subtitle) : null),
    props.actions ? h('div', { class: 'page-actions' }, props.actions) : null
  );
}

export function ErrorBanner(props: { message: string; onRetry?: () => void }): VNode {
  return h('div', { class: 'error-banner' },
    Icon({ name: 'alert', size: 16 }),
    h('span', { class: 'grow' }, props.message),
    props.onRetry ? h('button', { class: 'btn btn-sm', onClick: props.onRetry }, 'Retry') : null
  );
}

export function Loading(props: { label?: string }): VNode {
  return h('div', { class: 'stack', style: { padding: '12px 0' } },
    h('div', { class: 'loading-line' }),
    h('div', { class: 'small dim' }, props.label || 'Loading…')
  );
}

export function EmptyState(props: { title: string; message?: string; icon?: string; action?: Child }): VNode {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, Icon({ name: props.icon || 'file', size: 24 })),
    h('h3', {}, props.title),
    props.message ? h('p', { class: 'small' }, props.message) : null,
    props.action ? h('div', { class: 'mt-2' }, props.action) : null
  );
}

/* ----------------------------------------------------------------- table */
export interface Column {
  key: string;
  label: string;
  render?: (row: any) => Child;
  width?: string;
  class?: string;
}

export function DataTable(props: {
  columns: Column[]; rows: any[]; keyField?: string; empty?: string; emptyIcon?: string;
  onRowClick?: (row: any) => void; actions?: (row: any) => Child; compact?: boolean;
  selected?: string | null;
}): VNode {
  if (!props.rows || !props.rows.length) {
    return EmptyState({ title: props.empty || 'Nothing here yet', message: 'Data will appear once available.', icon: props.emptyIcon || 'database' });
  }
  const keyField = props.keyField || 'id';
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data-table' + (props.compact ? ' compact' : '') },
      h('thead', {}, h('tr', {},
        ...props.columns.map((c) => h('th', { style: c.width ? { width: c.width } : undefined }, c.label)),
        props.actions ? h('th', { style: { textAlign: 'right' } }, 'Actions') : null
      )),
      h('tbody', {}, ...props.rows.map((row) => {
        const key = String(row[keyField] ?? '');
        return h('tr', {
          key,
          class: (props.onRowClick ? 'clickable ' : '') + (props.selected === key ? 'selected' : ''),
          onClick: () => { if (props.onRowClick) props.onRowClick(row); }
        },
          ...props.columns.map((c) => h('td', { class: c.class }, c.render ? c.render(row) : (row[c.key] ?? '—'))),
          props.actions ? h('td', {}, h('div', { class: 'cell-actions', onClick: (e: Event) => e.stopPropagation() }, props.actions(row))) : null
        );
      }))
    )
  );
}

/* ---------------------------------------------------------------- modal */
export function Modal(props: { title: string; onClose: () => void; footer?: Child; size?: 'wide' | 'narrow' }, ...children: Child[]): VNode {
  return h('div', {
    class: 'modal-backdrop',
    onClick: (e: Event) => { if (e.target === e.currentTarget) props.onClose(); }
  },
    h('div', { class: 'modal ' + (props.size || '') },
      h('div', { class: 'modal-head' },
        h('h2', {}, props.title),
        h('button', { class: 'icon-btn close-x', 'aria-label': 'Close', onClick: props.onClose }, Icon({ name: 'x', size: 16 }))
      ),
      h('div', { class: 'modal-body' }, ...children),
      props.footer ? h('div', { class: 'modal-foot' }, props.footer) : null
    )
  );
}

export function ConfirmDialog(props: {
  title: string; message: string; confirmLabel?: string; danger?: boolean;
  onConfirm: () => void | Promise<void>; onClose: () => void;
}): VNode {
  const busy = useState(false);
  return Modal({
    title: props.title, size: 'narrow', onClose: props.onClose,
    footer: h(Fragment, {},
      h('button', { class: 'btn', onClick: props.onClose }, 'Cancel'),
      h('button', {
        class: 'btn ' + (props.danger ? 'btn-danger' : 'btn-primary'), disabled: busy.value,
        onClick: async () => {
          busy.set(true);
          try { await props.onConfirm(); props.onClose(); } finally { busy.set(false); }
        }
      }, props.confirmLabel || 'Confirm')
    )
  }, h('p', { class: 'muted', style: { margin: '0' } }, props.message));
}

/* ----------------------------------------------------------------- forms */
export function Input(props: {
  key?: string; label?: string; name?: string; value?: any; type?: string; placeholder?: string;
  hint?: string; disabled?: boolean; required?: boolean; min?: any; max?: any; step?: any;
  onChange?: (value: string) => void; onInput?: (value: string) => void;
}): VNode {
  const key = props.key || props.name || props.label || 'input';
  return h('div', { class: 'field' },
    props.label ? h('label', { for: key }, props.label) : null,
    h('input', {
      id: key, key, name: props.name || key, class: 'input',
      type: props.type || 'text', value: props.value === undefined || props.value === null ? '' : props.value,
      placeholder: props.placeholder || '', disabled: !!props.disabled, required: !!props.required,
      min: props.min, max: props.max, step: props.step,
      onInput: (e: Event) => { if (props.onInput) props.onInput((e.target as HTMLInputElement).value); },
      onChange: (e: Event) => { if (props.onChange) props.onChange((e.target as HTMLInputElement).value); }
    }),
    props.hint ? h('span', { class: 'field-hint' }, props.hint) : null
  );
}

export function Select(props: {
  key?: string; label?: string; name?: string; value?: any; options: Array<{ value: any; label: string }>;
  hint?: string; disabled?: boolean; onChange?: (value: string) => void;
}): VNode {
  const key = props.key || props.name || props.label || 'select';
  return h('div', { class: 'field' },
    props.label ? h('label', { for: key }, props.label) : null,
    h('select', {
      id: key, key, name: props.name || key, class: 'select', value: props.value === undefined ? '' : props.value,
      disabled: !!props.disabled,
      onChange: (e: Event) => { if (props.onChange) props.onChange((e.target as HTMLSelectElement).value); }
    }, ...props.options.map((o) => h('option', { value: o.value }, o.label))),
    props.hint ? h('span', { class: 'field-hint' }, props.hint) : null
  );
}

export function Toggle(props: {
  key?: string; label?: string; name?: string; checked: boolean; hint?: string; disabled?: boolean;
  onChange?: (checked: boolean) => void;
}): VNode {
  const key = props.key || props.name || props.label || 'toggle';
  return h('div', { class: 'field' },
    h('label', { class: 'toggle' },
      h('input', {
        id: key, key, type: 'checkbox', name: props.name || key,
        checked: !!props.checked, disabled: !!props.disabled,
        onChange: (e: Event) => { if (props.onChange) props.onChange((e.target as HTMLInputElement).checked); }
      }),
      h('span', { class: 'toggle-track' }),
      props.label ? h('span', { class: 'toggle-label' }, props.label) : null
    ),
    props.hint ? h('span', { class: 'field-hint' }, props.hint) : null
  );
}

export function TextArea(props: {
  key?: string; label?: string; name?: string; value?: string; placeholder?: string; rows?: number;
  hint?: string; onChange?: (value: string) => void;
}): VNode {
  const key = props.key || props.name || props.label || 'textarea';
  return h('div', { class: 'field' },
    props.label ? h('label', { for: key }, props.label) : null,
    h('textarea', {
      id: key, key, name: props.name || key, class: 'textarea', rows: props.rows || 4,
      value: props.value || '', placeholder: props.placeholder || '',
      onChange: (e: Event) => { if (props.onChange) props.onChange((e.target as HTMLTextAreaElement).value); }
    }),
    props.hint ? h('span', { class: 'field-hint' }, props.hint) : null
  );
}

export function Badge(props: { kind?: string; children?: Child; text?: string }): VNode {
  return h('span', { class: 'badge ' + (props.kind || '') }, props.text !== undefined ? props.text : (props.children || ''));
}

export function StatusDot(props: { status?: string; label?: string; pulse?: boolean }): VNode {
  const status = String(props.status || '').toLowerCase();
  const tone = /running|active|online|ok|healthy|enabled|up|ready/.test(status) ? 'ok'
    : /paused|syncing|degraded|warning|busy/.test(status) ? 'warn'
    : /stopped|offline|error|failed|down|disabled/.test(status) ? 'err' : '';
  return h('span', { class: 'status-cell' },
    h('span', { class: 'status-dot ' + tone + (props.pulse ? ' pulse' : '') }),
    props.label !== undefined ? props.label : (props.status || '')
  );
}

/* ---------------------------------------------------------------- charts */
function chartSvg(series: Array<{ name: string; color: string; data: number[] }>, height: number, unit: string): string {
  const W = 820;
  const H = height;
  const pad = { l: 46, r: 14, t: 14, b: 26 };
  const values: number[] = [];
  for (const s of series) for (const v of s.data) if (isFinite(v)) values.push(v);
  let max = Math.max(1, ...values);
  max = max <= 1 ? 100 : max * 1.1;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Time series chart">`;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (i / 4) * (H - pad.t - pad.b);
    svg += `<line class="grid-line" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}"/>`;
    svg += `<text class="axis-label" x="4" y="${(y + 3).toFixed(1)}">${Math.round(max * (1 - i / 4))}${unit}</text>`;
  }
  for (const s of series) {
    if (!s.data.length) continue;
    const points = s.data.map((v, i) => {
      const value = Number.isFinite(v) ? v : 0;
      const x = pad.l + (i / Math.max(1, s.data.length - 1)) * (W - pad.l - pad.r);
      const y = pad.t + (1 - Math.min(1, Math.max(0, value / max))) * (H - pad.t - pad.b);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    svg += `<polygon class="area" points="${pad.l},${H - pad.b} ${points} ${W - pad.r},${H - pad.b}" fill="${s.color}"/>`;
    svg += `<polyline class="line" points="${points}" stroke="${s.color}"/>`;
  }
  svg += `<text class="axis-label" x="${pad.l}" y="${H - 6}">older</text>`;
  svg += `<text class="axis-label" x="${W - pad.r - 30}" y="${H - 6}">now</text>`;
  svg += '</svg>';
  return svg;
}

export function LineChart(props: { series: Array<{ name: string; color: string; data: number[] }>; height?: number; unit?: string }): VNode {
  const height = props.height || 220;
  return h('div', {},
    rawSvg(chartSvg(props.series || [], height, props.unit || ''), true),
    h('div', { class: 'chart-legend' }, ...(props.series || []).map((s) =>
      h('span', {}, h('i', { class: 'legend-swatch', style: { background: s.color } }), s.name)
    ))
  );
}

export function Sparkline(props: { data: number[]; color?: string; height?: number }): VNode {
  const color = props.color || 'var(--accent)';
  const data = (props.data || []).map((v: number) => Number.isFinite(v) ? v : 0);
  const max = Math.max(1, ...data);
  const points = data.map((v, i) => {
    const x = (i / Math.max(1, data.length - 1)) * 100;
    const y = 34 - (Math.min(1, v / max)) * 30;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const svg = `<svg class="sparkline" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">` +
    (points ? `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>` : '') +
    `</svg>`;
  return rawSvg(svg, true);
}

/* ---------------------------------------------------------------- toasts */
export function ToastStack(): VNode {
  return h('div', { class: 'toast-stack' }, ...state.toasts.value.map((t) =>
    h('div', { class: 'toast ' + t.kind },
      Icon({ name: t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info', size: 16 }),
      h('span', {}, t.message),
      h('button', { class: 'toast-close', 'aria-label': 'Dismiss', onClick: () => dismissToast(t.id) }, '×')
    )
  ));
}

/* ----------------------------------------------------------- code editor */
export function CodeEditor(props: { value: string; onChange?: (value: string) => void; language?: string; height?: string }): VNode {
  let lines: HTMLElement | null = null;
  const count = String(props.value || '').split('\n').length;
  return h('div', { class: 'code-editor' },
    h('div', {
      class: 'code-lines',
      ref: (el: HTMLElement | null) => { lines = el; },
      style: { maxHeight: props.height || '340px' }
    }, Array.from({ length: count }, (_, i) => String(i + 1)).join('\n')),
    h('textarea', {
      spellcheck: false, style: { maxHeight: props.height || '340px' },
      value: props.value || '',
      'aria-label': props.language || 'Configuration',
      onScroll: (e: Event) => { if (lines) lines.scrollTop = (e.target as HTMLElement).scrollTop; },
      onChange: (e: Event) => { if (props.onChange) props.onChange((e.target as HTMLTextAreaElement).value); }
    })
  );
}

/* -------------------------------------------------------------- terminal */
interface TerminalSession {
  conn: ReturnType<typeof api.connectWS>;
  lines: Store<string[]>;
}

const terminalSessions = new Map<string, TerminalSession>();

function terminalSession(key: string): TerminalSession {
  let session = terminalSessions.get(key);
  if (session) return session;
  const lines = useState<string[]>(['Connecting to WrexrOS shell…']);
  const conn = api.connectWS('/ws/terminal', {
    onOpen: () => lines.set((old) => old.concat(['Connected. Type `help` for available commands.'])),
    onMessage: (msg: any) => {
      if (msg && msg.type === 'output') lines.set((old) => old.concat(String(msg.data || '').replace(/\r?\n$/, '').split('\n')));
      else if (msg && msg.type === 'error') lines.set((old) => old.concat(['[error] ' + String(msg.data)]));
    },
    onClose: () => lines.set((old) => old.concat(['\n[connection closed — reconnecting…]']))
  });
  session = { conn, lines };
  terminalSessions.set(key, session);
  return session;
}

export function TerminalView(props: { title?: string; keyName?: string; onClose?: () => void }): VNode {
  const key = props.keyName || 'main';
  const session = terminalSession(key);
  const input = useState('');
  const bodyRef = (el: HTMLElement | null) => { if (el) el.scrollTop = el.scrollHeight; };
  return h('div', { class: 'terminal' },
    h('div', { class: 'terminal-head' },
      h('span', { class: 'terminal-dots' }, h('i', { style: { background: '#fb7185' } }), h('i', { style: { background: '#fbbf24' } }), h('i', { style: { background: '#34d399' } })),
      h('span', {}, props.title || 'root@wrexr:~#'),
      h('span', { class: 'spacer' }),
      props.onClose ? h('button', { class: 'btn btn-sm', onClick: () => {
        session.conn.close(); terminalSessions.delete(key); props.onClose && props.onClose();
      } }, 'Close') : null
    ),
    h('div', { class: 'terminal-body', ref: bodyRef }, session.lines.value.map((line, i) => h('div', { key: i }, line || ' '))),
    h('div', { class: 'term-input-row' },
      h('span', {}, '❯'),
      h('input', {
        class: '', value: input.value, placeholder: 'Type a command…', autocomplete: 'off',
        onInput: (e: Event) => input.set((e.target as HTMLInputElement).value),
        onKeydown: (e: KeyboardEvent) => {
          const target = e.target as HTMLInputElement;
          if (e.key === 'Enter' && target.value) {
            session.conn.send({ type: 'input', data: target.value + '\n' });
            session.lines.set((old) => old.concat(['❯ ' + target.value]));
            input.set('');
          }
        }
      })
    )
  );
}

/* -------------------------------------------------------------- tabs UI */
export function Tabs(props: { tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }): VNode {
  return h('div', { class: 'tabs' }, ...props.tabs.map((tab) =>
    h('button', {
      key: tab.id, class: 'tab' + (props.active === tab.id ? ' active' : ''),
      onClick: () => props.onChange(tab.id)
    }, tab.label)
  ));
}
