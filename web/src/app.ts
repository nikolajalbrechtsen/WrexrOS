// Application shell: history router, auth guard, theme, global WS and shortcuts.
import { h, mount, setScheduler } from './dom.ts';
import type { VNode } from './dom.ts';
import { api, getToken } from './api.ts';
import type { AuthResult } from './types.ts';
import { state, applyTheme, can, toast, errorMessage } from './store.ts';
import { Sidebar, Topbar, ToastStack, Icon, Input, ErrorBanner } from './components.ts';

import * as dashboard from './pages/dashboard.ts';
import * as vms from './pages/vms.ts';
import * as containers from './pages/containers.ts';
import * as storage from './pages/storage.ts';
import * as shares from './pages/shares.ts';
import * as apps from './pages/apps.ts';
import * as settings from './pages/settings.ts';
import * as wizard from './pages/wizard.ts';
import * as terminal from './pages/terminal.ts';
import * as updates from './pages/updates.ts';
import * as users from './pages/users.ts';
import * as alerts from './pages/alerts.ts';
import * as backups from './pages/backups.ts';
import * as plugins from './pages/plugins.ts';
import * as cluster from './pages/cluster.ts';

interface RouteDef {
  view: () => VNode;
  load?: (force?: boolean) => void;
  title: string;
  subtitle?: string;
  permission?: string;
}

export const ROUTES: Record<string, RouteDef> = {
  '/dashboard': { view: dashboard.View, load: dashboard.load, title: 'Dashboard', subtitle: 'Live appliance overview', permission: 'dashboard:read' },
  '/vms': { view: vms.View, load: vms.load, title: 'Virtual machines', subtitle: 'KVM & LXC instances', permission: 'vm:read' },
  '/containers': { view: containers.View, load: containers.load, title: 'Containers', subtitle: 'LXC workloads', permission: 'vm:read' },
  '/storage': { view: storage.View, load: storage.load, title: 'Storage', subtitle: 'Disks, array & datasets', permission: 'storage:read' },
  '/shares': { view: shares.View, load: shares.load, title: 'File sharing', subtitle: 'Network shares & ACLs', permission: 'share:read' },
  '/apps': { view: apps.View, load: apps.load, title: 'App store', subtitle: 'Container catalog', permission: 'app:read' },
  '/settings': { view: settings.View, load: settings.load, title: 'Settings', subtitle: 'Appliance configuration', permission: 'settings:read' },
  '/terminal': { view: terminal.View, load: terminal.load, title: 'Terminal', subtitle: 'WebSSH shell', permission: 'system:terminal' },
  '/updates': { view: updates.View, load: updates.load, title: 'Updates', subtitle: 'System & app updates', permission: 'update:read' },
  '/users': { view: users.View, load: users.load, title: 'Users & access', subtitle: 'Accounts, tokens & audit', permission: 'user:read' },
  '/alerts': { view: alerts.View, load: alerts.load, title: 'Alerts', subtitle: 'Thresholds & events', permission: 'alert:read' },
  '/backups': { view: backups.View, load: backups.load, title: 'Backups', subtitle: 'Schedules & jobs', permission: 'backup:read' },
  '/plugins': { view: plugins.View, load: plugins.load, title: 'Plugins', subtitle: 'Signed extensions', permission: 'plugin:read' },
  '/cluster': { view: cluster.View, load: cluster.load, title: 'Cluster', subtitle: 'Node linking & HA', permission: 'cluster:read' }
};

let authChecked = false;
const loginState = {
  password: '',
  totp: '',
  busy: false,
  error: ''
};

const wsConnections: any[] = [];
let started = false;
let root: Element | null = null;

export function navigate(path: string, replace = false): void {
  const clean = path.split('#')[0] || '/';
  if (replace) history.replaceState({}, '', clean);
  else if (location.pathname !== clean) history.pushState({}, '', clean);
  state.route.set(clean);
  activate(clean);
  render();
}

function activate(path: string): void {
  const def = ROUTES[path];
  if (def && def.load) def.load();
  if (path === '/wizard') wizard.load();
}

function render(): void {
  if (!root) return;
  const path = state.route.value;

  if (!authChecked) {
    mount(root, h('div', { class: 'boot-screen' },
      h('img', { src: '/logo.svg', alt: '', class: 'boot-logo' }),
      h('div', { class: 'boot-spinner' }),
      h('p', {}, 'Connecting to WrexrOS…')
    ));
    return;
  }

  if (state.authStatus.value && state.authStatus.value.setupRequired) {
    mount(root, wizard.View());
    return;
  }

  if (path === '/wizard') {
    mount(root, wizard.View());
    return;
  }

  if (path === '/login' || !state.user.value) {
    mount(root, LoginView());
    return;
  }

  const def = ROUTES[path];
  if (!def) { navigate('/dashboard', true); return; }
  if (def.permission && !can(def.permission)) {
    mount(root, h('div', { class: 'page' },
      h('div', { class: 'card', style: { padding: '40px', textAlign: 'center' } },
        h('div', { class: 'empty-icon' }, Icon({ name: 'lock', size: 26 })),
        h('h2', {}, 'Access denied'),
        h('p', { class: 'muted' }, 'Your role does not allow access to this section.'),
        h('button', { class: 'btn btn-primary', onClick: () => navigate('/dashboard') }, 'Back to dashboard')
      )
    ));
    return;
  }

  mount(root, h('div', { class: 'app-shell' },
    Sidebar(),
    h('main', { class: 'main' },
      Topbar({ title: def.title, subtitle: def.subtitle }),
      h('div', { class: 'content' }, def.view())
    ),
    ToastStack()
  ));
}

function LoginView(): VNode {
  return h('div', { class: 'auth-screen' },
    h('div', { class: 'card auth-card' },
      h('div', { class: 'auth-brand' },
        h('img', { src: '/logo.svg', alt: '' }),
        h('div', {}, h('h1', {}, 'WrexrOS'), h('p', {}, (state.authStatus.value?.hostname || 'Control plane') + ' · ' + (state.authStatus.value?.version || '')))
      ),
      h('h2', { class: 'auth-title' }, 'Sign in'),
      h('p', { class: 'auth-desc' }, 'Enter the root password to manage this appliance.'),
      loginState.error ? ErrorBanner({ message: loginState.error }) : null,
      Input({
        label: 'Password', name: 'login-password', type: 'password', value: loginState.password,
        placeholder: 'Root password',
        onChange: (v) => { loginState.password = v; },
        onInput: (v) => { loginState.password = v; }
      }),
      Input({
        label: 'TOTP code (if enabled)', name: 'login-totp', value: loginState.totp,
        placeholder: '000000',
        onChange: (v) => { loginState.totp = v; },
        onInput: (v) => { loginState.totp = v; }
      }),
      h('button', {
        class: 'btn btn-primary btn-lg btn-block mt-2', disabled: loginState.busy,
        onClick: async () => {
          loginState.busy = true;
          loginState.error = '';
          render();
          try {
            const result = await api.auth.login(loginState.password, loginState.totp || undefined);
            if (result && result.user) state.user.set(result.user);
            let permissions: string[] = (result && result.user && result.user.permissions) || [];
            try {
              const me = await api.auth.me();
              if (me && me.user) state.user.set(me.user);
              if (me && me.permissions) permissions = me.permissions;
            } catch { /* keep the user from the login response */ }
            state.permissions.set(permissions);
            const setup = await api.auth.status().catch(() => null);
            if (setup) state.authStatus.set(setup);
            navigate('/dashboard', true);
          } catch (err) {
            loginState.error = errorMessage(err);
            render();
          } finally { loginState.busy = false; }
        }
      }, loginState.busy ? 'Signing in…' : 'Sign in', h('span', { class: 'icon' }, Icon({ name: 'chevron', size: 16 }))),
      h('p', { class: 'tiny dim center mt-3' }, 'WrexrOS · self-hosted hypervisor & NAS')
    )
  );
}

function startGlobalSockets(): void {
  if (started) return;
  started = true;
  wsConnections.push(api.connectWS('/ws/metrics', {
    onMessage: (msg: any) => {
      if (!msg || msg.type !== 'metrics') return;
      state.metrics.set(msg.data || msg);
    }
  }));
  wsConnections.push(api.connectWS('/ws/events', {
    onMessage: (msg: any) => {
      if (!msg || (msg.type !== 'event' && msg.type !== 'alert')) return;
      const event = msg.data || msg;
      state.events.set((old) => [event].concat(old).slice(0, 200));
      if (/error|critical|crit/.test(String(event.level || ''))) toast(event.message || 'System alert', 'error');
    }
  }));
}

function installListeners(rootEl: Element): void {
  root = rootEl;
  window.addEventListener('popstate', () => { state.route.set(location.pathname || '/'); activate(state.route.value); render(); });
  window.addEventListener('wrexr:navigate', ((e: CustomEvent) => navigate(String(e.detail))) as EventListener);
  window.addEventListener('wrexr:unauthorized', () => {
    state.user.set(null);
    state.permissions.set([]);
    navigate('/login', true);
    toast('Session expired — please sign in again', 'warning');
  });
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (!typing && (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))) {
      e.preventDefault();
      const search = document.getElementById('global-search') as HTMLInputElement | null;
      if (search) search.focus();
    }
    if (e.key === 'Escape') state.sidebarOpen.set(false);
  });
  setScheduler(render);
  applyTheme(state.theme.value);
  state.theme.subscribe(applyTheme);
}

export function bootstrap(): void {
  const rootEl = document.getElementById('app');
  if (!rootEl) throw new Error('#app not found');
  installListeners(rootEl);
  const initial = location.pathname || '/dashboard';
  state.route.set(initial);
  render();

  api.auth.status().then((status) => {
    state.authStatus.set(status);
    authChecked = true;
    if (status.setupRequired) { navigate('/wizard', true); return; }
    if (getToken()) {
      api.auth.me().then((me) => {
        if (me && me.user) state.user.set(me.user);
        if (me && me.permissions) state.permissions.set(me.permissions);
        else if (me && me.user && me.user.permissions) state.permissions.set(me.user.permissions);
        if (!canAnyRead(state.route.value)) navigate('/dashboard', true);
        else {
          // Initial bootstrap skipped activate(); fetch this page's data now.
          activate(state.route.value);
          render();
        }
      }).catch(() => navigate('/login', true));
    } else if (initial !== '/login') {
      navigate('/login', true);
    } else render();
  }).catch((err) => {
    authChecked = true;
    toast('Cannot reach the daemon: ' + errorMessage(err), 'error');
    if (initial !== '/login') navigate('/login', true);
    else render();
  });

  startGlobalSockets();
}

function canAnyRead(path: string): boolean {
  const def = ROUTES[path];
  if (!def) return false;
  return !def.permission || can(def.permission);
}

// Keep a reference so tree-shaking does not drop the login auth result type.
export type { AuthResult };
