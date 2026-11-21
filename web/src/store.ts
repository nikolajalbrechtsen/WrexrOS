// Global application state, theme persistence, permission helpers and toasts.
import { useState } from './dom.ts';
import type { AuthStatus, User, Event, Alert, Metrics, MetricsHistory } from './types.ts';

export type Theme = 'dark' | 'light';
export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('wrexr_theme');
    if (saved === 'light' || saved === 'dark') return saved;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch { /* ignore */ }
  return 'dark';
}

export const state = {
  user: useState<User | null>(null),
  permissions: useState<string[]>([]),
  authStatus: useState<AuthStatus | null>(null),
  route: useState<string>(location.pathname || '/dashboard'),
  theme: useState<Theme>(initialTheme()),
  events: useState<Event[]>([]),
  alerts: useState<Alert[]>([]),
  metrics: useState<Metrics | null>(null),
  history: useState<MetricsHistory>({ cpu: [], ram: [], network: [] }),
  toasts: useState<Toast[]>([]),
  sidebarOpen: useState(false),
  searchOpen: useState(false),
  updateAvailable: useState(false)
};

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1220' : '#f4f7fb');
  try { localStorage.setItem('wrexr_theme', theme); } catch { /* ignore */ }
}

export function toggleTheme(): void {
  const next: Theme = state.theme.value === 'dark' ? 'light' : 'dark';
  state.theme.set(next);
  applyTheme(next);
}

export function can(permission: string): boolean {
  const user = state.user.value;
  const role = user ? (user.role || (user.roles && user.roles[0]) || '') : '';
  if (role === 'admin') return true;
  const permissions = state.permissions.value || [];
  if (permissions.indexOf('*') >= 0 || permissions.indexOf(permission) >= 0) return true;
  const domain = permission.split(':')[0];
  if (permissions.indexOf(domain + ':*') >= 0) return true;
  if (role === 'viewer') {
    return /:(read|list|view|inspect)$/.test(permission);
  }
  return false;
}

export function canAny(permissions: string[]): boolean {
  return permissions.some(can);
}

let toastId = 0;

export function toast(message: string, kind: ToastKind = 'info'): number {
  const id = ++toastId;
  state.toasts.set((current) => current.concat([{ id, kind, message }]));
  setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4500);
  return id;
}

export function dismissToast(id: number): void {
  state.toasts.set((current) => current.filter((t) => t.id !== id));
}

export function errorMessage(err: any): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || err.code || String(err);
}

export function humanBytes(bytes: any): string {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

export function metricNumber(value: any): number {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isFinite(parsed) ? parsed : 0;
  }
  if (!value || typeof value !== 'object') return 0;
  for (const key of ['percent', 'usage', 'value', 'used', 'total']) {
    if (typeof value[key] === 'number' && isFinite(value[key])) return value[key];
  }
  return 0;
}

export function metricRatio(value: any): number {
  if (!value || typeof value !== 'object') {
    const n = metricNumber(value);
    return n > 1 ? Math.min(100, n) : n * 100;
  }
  if (typeof value.percent === 'number') return Math.min(100, value.percent);
  if (typeof value.usage === 'number') return Math.min(100, value.usage > 1 ? value.usage : value.usage * 100);
  if (typeof value.used === 'number' && typeof value.total === 'number' && value.total > 0) {
    return Math.min(100, (value.used / value.total) * 100);
  }
  return metricNumber(value);
}

export function relativeTime(value: any): string {
  if (!value) return '—';
  const time = typeof value === 'number' ? value : Date.parse(String(value));
  if (!isFinite(time)) return String(value);
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}
