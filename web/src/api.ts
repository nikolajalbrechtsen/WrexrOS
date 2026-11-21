// Typed API client for the WrexrOS v1 contract.
import type {
  ApiErrorInfo, AuthStatus, AuthResult, User, ApiToken, Event, VM, VncInfo,
  PciDevice, Bridge, VmTemplate, FirewallRule, Snapshot, Disk, ArrayStatus,
  Dataset, Share, User as UserType, Group, CatalogApp, App, Repo, Alert,
  Backup, Plugin, ClusterNode, Settings, UpdateInfo, DashboardData,
  MetricsHistory, Metrics
} from './types.ts';

const TOKEN_KEY = 'wrexr_token';

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key) || sessionStorage.getItem(key); } catch { return null; }
}

export function getToken(): string | null { return storageGet(TOKEN_KEY); }

export function setToken(token: string, persistent = true): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    (persistent ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch { /* storage disabled */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

function apiBase(): string {
  const configured = (window as any).WREXR_API;
  if (configured) return String(configured).replace(/\/+$/, '') + '/api/v1';
  return '/api/v1';
}

function wsBase(): string {
  const w = window as any;
  if (w.WREXR_WS) return String(w.WREXR_WS).replace(/\/+$/, '');
  if (w.WREXR_API) return String(w.WREXR_API).replace(/^http/, 'ws').replace(/\/+$/, '') + '/api/v1';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + location.host + '/api/v1';
}

export class ApiError extends Error {
  code: string;
  status: number;
  details: any;
  constructor(message: string, code: string, status: number, details?: any) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: any): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  let response: Response;
  try {
    response = await fetch(apiBase() + path, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err: any) {
    throw new ApiError(err?.message || 'Network unavailable', 'NETWORK_ERROR', 0);
  }

  let envelope: any = null;
  try { envelope = await response.json(); } catch { /* non-JSON response */ }

  if (!response.ok || (envelope && envelope.ok === false)) {
    const info: ApiErrorInfo = (envelope && envelope.error) || {
      code: 'HTTP_' + response.status,
      message: envelope?.message || `Request failed (${response.status})`
    };
    if (response.status === 401) {
      clearToken();
      window.dispatchEvent(new CustomEvent('wrexr:unauthorized'));
    }
    throw new ApiError(info.message || 'Request failed', info.code, response.status, info.details);
  }

  if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
    return (envelope.data !== undefined ? envelope.data : {}) as T;
  }
  return (envelope === null ? {} : envelope) as T;
}

/**
 * The daemon wraps collection responses in a named key (for example
 * `{ vms: [...] }`). Normalise those here so every page can work with arrays.
 */
async function list<T>(method: string, path: string, key: string, body?: any): Promise<T[]> {
  const data: any = await request(method, path, body);
  if (Array.isArray(data)) return data as T[];
  if (data && Array.isArray(data[key])) return data[key] as T[];
  return [];
}

export interface SetupPayload {
  hostname: string;
  timezone: string;
  password: string;
  sshKeys: string[];
  network: any;
  createShare?: any;
  createVm?: any;
}

export interface WSHandlers {
  onOpen?: () => void;
  onMessage?: (message: any) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

export interface WSConnection {
  send(data: any): void;
  close(): void;
  readonly open: boolean;
}

function connectWS(path: string, handlers: WSHandlers = {}): WSConnection {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    if (closed) return;
    attempts++;
    const delay = Math.min(30000, 500 * Math.pow(2, Math.min(attempts, 6)));
    timer = setTimeout(connect, delay);
  }

  function connect(): void {
    if (closed) return;
    let url = wsBase() + (path.startsWith('/') ? path : '/' + path);
    const token = getToken();
    if (token) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
    try {
      socket = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    socket.onopen = () => { attempts = 0; if (handlers.onOpen) handlers.onOpen(); };
    socket.onmessage = (event: MessageEvent) => {
      let message: any = event.data;
      if (typeof message === 'string') {
        try { message = JSON.parse(message); } catch { /* plain text frame */ }
      }
      if (handlers.onMessage) handlers.onMessage(message);
    };
    socket.onerror = (event: Event) => { if (handlers.onError) handlers.onError(event); };
    socket.onclose = (event: CloseEvent) => {
      if (handlers.onClose) handlers.onClose(event);
      if (!closed) schedule();
    };
  }

  connect();

  return {
    send(data: any): void {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(typeof data === 'string' ? data : JSON.stringify(data));
      }
    },
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        try { socket.close(); } catch { /* ignore */ }
        socket = null;
      }
    },
    get open(): boolean { return !!socket && socket.readyState === WebSocket.OPEN; }
  };
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: any) => request<T>('POST', path, body),
  put: <T>(path: string, body?: any) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: any) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  request,
  connectWS,

  auth: {
    status: () => request<AuthStatus>('GET', '/auth/status'),
    login: async (password: string, totp?: string): Promise<AuthResult> => {
      const result = await request<AuthResult>('POST', '/auth/login', { password, totp });
      if (result && result.token) setToken(result.token);
      return result;
    },
    setup: async (payload: SetupPayload): Promise<AuthResult> => {
      const result = await request<AuthResult>('POST', '/auth/setup', payload);
      if (result && result.token) setToken(result.token);
      return result;
    },
    logout: async (): Promise<void> => {
      try { await request('POST', '/auth/logout'); } finally { clearToken(); }
    },
    me: () => request<{ user: User; permissions: string[] }>('GET', '/auth/me'),
    totpEnroll: () => request<{ secret: string; uri: string }>('POST', '/auth/totp/enroll'),
    totpVerify: (code: string) => request<{ enabled: boolean }>('POST', '/auth/totp/verify', { code }),
    tokens: () => list<ApiToken>('GET', '/auth/tokens', 'tokens'),
    createToken: (body: any) => request<ApiToken>('POST', '/auth/tokens', body),
    revokeToken: (id: string) => request('DELETE', '/auth/tokens/' + encodeURIComponent(id))
  },

  dashboard: () => request<DashboardData>('GET', '/dashboard'),
  history: () => request<MetricsHistory>('GET', '/metrics/history'),

  vms: {
    list: () => list<VM>('GET', '/vms', 'vms'),
    get: (id: string) => request<VM>('GET', '/vms/' + encodeURIComponent(id)),
    create: (body: any) => request<VM>('POST', '/vms', body),
    update: (id: string, body: any) => request<VM>('PUT', '/vms/' + encodeURIComponent(id), body),
    remove: (id: string) => request('DELETE', '/vms/' + encodeURIComponent(id)),
    action: (id: string, action: string) => request('POST', '/vms/' + encodeURIComponent(id) + '/' + action),
    vnc: (id: string) => request<VncInfo>('GET', '/vms/' + encodeURIComponent(id) + '/vnc'),
    snapshots: (id: string) => list<Snapshot>('GET', '/vms/' + encodeURIComponent(id) + '/snapshots', 'snapshots'),
    firewall: (id: string) => list<FirewallRule>('GET', '/vms/' + encodeURIComponent(id) + '/firewall', 'rules'),
    setFirewall: (id: string, rules: FirewallRule[]) => request('POST', '/vms/' + encodeURIComponent(id) + '/firewall', { rules })
  },
  pci: () => request<{ devices: PciDevice[] }>('GET', '/pci'),
  bridges: {
    list: () => list<Bridge>('GET', '/bridges', 'bridges'),
    create: (body: any) => request<Bridge>('POST', '/bridges', body)
  },
  templates: {
    list: () => list<VmTemplate>('GET', '/vm-templates', 'templates'),
    create: (body: any) => request<VmTemplate>('POST', '/vm-templates', body)
  },

  storage: {
    disks: () => request<{ disks: Disk[] }>('GET', '/storage/disks'),
    array: () => request<ArrayStatus>('GET', '/storage/array'),
    arrayAction: (action: string) => request('POST', '/storage/array/' + action),
    assignDisk: (body: any) => request('POST', '/storage/array/disks', body),
    datasets: () => list<Dataset>('GET', '/storage/datasets', 'datasets'),
    addDataset: (body: any) => request<Dataset>('POST', '/storage/datasets', body),
    deleteDataset: (name: string) => request('DELETE', '/storage/datasets/' + encodeURIComponent(name)),
    snapshots: () => list<Snapshot>('GET', '/storage/snapshots', 'snapshots'),
    addSnapshot: (body: any) => request<Snapshot>('POST', '/storage/snapshots', body),
    smart: () => request<any>('GET', '/storage/smart'),
    setSmart: (body: any) => request('POST', '/storage/smart', body),
    settings: () => request<Settings>('GET', '/storage/settings'),
    setSettings: (body: any) => request<any>('PUT', '/storage/settings', body)
  },

  shares: {
    list: () => list<Share>('GET', '/shares', 'shares'),
    get: (id: string) => request<Share>('GET', '/shares/' + encodeURIComponent(id)),
    create: (body: any) => request<Share>('POST', '/shares', body),
    update: (id: string, body: any) => request<Share>('PUT', '/shares/' + encodeURIComponent(id), body),
    remove: (id: string) => request('DELETE', '/shares/' + encodeURIComponent(id)),
    acl: (id: string, body: any) => request('POST', '/shares/' + encodeURIComponent(id) + '/acl', body)
  },
  users: {
    list: () => list<UserType>('GET', '/users', 'users'),
    create: (body: any) => request<UserType>('POST', '/users', body),
    remove: (id: string) => request('DELETE', '/users/' + encodeURIComponent(id))
  },
  groups: {
    list: () => list<Group>('GET', '/groups', 'groups'),
    create: (body: any) => request<Group>('POST', '/groups', body)
  },

  apps: {
    catalog: () => request<{ apps: CatalogApp[] }>('GET', '/apps/catalog'),
    installed: () => list<App>('GET', '/apps/installed', 'apps'),
    install: (body: any) => request<App>('POST', '/apps/install', body),
    get: (id: string) => request<App>('GET', '/apps/' + encodeURIComponent(id)),
    update: (id: string, body: any) => request<App>('PUT', '/apps/' + encodeURIComponent(id), body),
    remove: (id: string) => request('DELETE', '/apps/' + encodeURIComponent(id)),
    action: (id: string, action: string) => request('POST', '/apps/' + encodeURIComponent(id) + '/' + action),
    logs: (id: string) => request<{ lines: string[] }>('GET', '/apps/' + encodeURIComponent(id) + '/logs'),
    repos: () => list<Repo>('GET', '/apps/repos', 'repos'),
    addRepo: (body: any) => request<Repo>('POST', '/apps/repos', body),
    removeRepo: (id: string) => request('DELETE', '/apps/repos/' + encodeURIComponent(id)),
    syncRepos: () => request('POST', '/apps/repos/sync')
  },

  settings: {
    general: () => request<Settings>('GET', '/settings/general'),
    setGeneral: (body: any) => request('PUT', '/settings/general', body),
    network: () => request<Settings>('GET', '/settings/network'),
    setNetwork: (body: any) => request('PUT', '/settings/network', body),
    storage: () => request<Settings>('GET', '/settings/storage'),
    setStorage: (body: any) => request('PUT', '/settings/storage', body),
    access: () => request<Settings>('GET', '/settings/access'),
    setAccess: (body: any) => request('PUT', '/settings/access', body),
    updates: () => request<Settings>('GET', '/settings/updates'),
    setUpdates: (body: any) => request('PUT', '/settings/updates', body),
    advanced: () => request<Settings>('GET', '/settings/advanced'),
    setAdvanced: (body: any) => request('PUT', '/settings/advanced', body),
    raw: () => request<{ raw: string } | string>('GET', '/settings/raw'),
    saveRaw: (raw: string) => request<{ backupPath: string }>('PUT', '/settings/raw', { raw }),
    validateRaw: (raw: string) => request<{ valid: boolean; errors?: string[] }>('POST', '/settings/raw/validate', { raw })
  },

  updates: {
    check: () => request<UpdateInfo>('GET', '/updates/check'),
    install: (version?: string) => request<{ jobId: string }>('POST', '/updates/install', version ? { version } : {}),
    status: () => request<UpdateInfo>('GET', '/updates/status'),
    app: () => list<any>('GET', '/updates/app', 'apps'),
    repo: () => request<any>('GET', '/updates/repo')
  },

  events: () => list<Event>('GET', '/events', 'events'),
  audit: () => list<Event>('GET', '/audit', 'audit'),
  alerts: {
    list: () => list<Alert>('GET', '/alerts', 'alerts'),
    create: (body: any) => request<Alert>('POST', '/alerts', body)
  },
  backups: {
    list: () => list<Backup>('GET', '/backups', 'backups'),
    create: (body: any) => request<Backup>('POST', '/backups', body),
    run: (id: string) => request('POST', '/backups/' + encodeURIComponent(id) + '/run')
  },
  plugins: {
    list: () => list<Plugin>('GET', '/plugins', 'plugins'),
    add: (body: any) => request<Plugin>('POST', '/plugins', body),
    action: (id: string, action: string) => request('POST', '/plugins/' + encodeURIComponent(id) + '/' + action)
  },
  cluster: {
    nodes: () => list<ClusterNode>('GET', '/cluster/nodes', 'nodes'),
    add: (body: any) => request<ClusterNode>('POST', '/cluster/nodes', body),
    remove: (id: string) => request('DELETE', '/cluster/nodes/' + encodeURIComponent(id))
  },
  openapi: () => request<any>('GET', '/openapi.json')
};

export type { Metrics, DashboardData, User, VM };
