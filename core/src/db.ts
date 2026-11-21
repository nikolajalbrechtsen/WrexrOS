/**
 * Persistent document-style store built on node:sqlite.
 *
 * Most entities are stored as JSON documents in a per-entity table with a
 * shared schema (id, data, created_at, updated_at). Settings, metrics, audit
 * and events have dedicated schemas so they can be queried efficiently.
 * Table names are always validated against a whitelist because SQLite cannot
 * bind identifiers as parameters.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { id, safeJsonParse } from './util.ts';

export const DOC_TABLES = [
  'users',
  'sessions',
  'tokens',
  'vms',
  'containers',
  'shares',
  'users_shares',
  'acls',
  'apps',
  'app_repos',
  'disks',
  'array_disks',
  'datasets',
  'snapshots',
  'smart_results',
  'alerts',
  'backups',
  'plugins',
  'cluster_nodes',
  'local_users',
  'groups',
] as const;

export type DocTable = (typeof DOC_TABLES)[number];
const DOC_SET = new Set<string>(DOC_TABLES);

let database: DatabaseSync | null = null;
let activeStateDir = config.stateDir;

function assertDocTable(table: string): DocTable {
  if (!DOC_SET.has(table)) throw new Error(`Unknown document table: ${table}`);
  return table as DocTable;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getDb(): DatabaseSync {
  if (!database) throw new Error('Database not initialized');
  return database;
}

export function getStateDir(): string {
  return activeStateDir;
}

/** Create directories, tables and (optionally) demo seed data. */
export function initDb(options: { stateDir?: string; seedDemo?: boolean } = {}): DatabaseSync {
  if (database) {
    if (options.seedDemo) seedDemoData();
    return database;
  }
  activeStateDir = path.resolve(options.stateDir ?? config.stateDir);
  fs.mkdirSync(activeStateDir, { recursive: true });

  // node:sqlite is embedded; the file is local to the state directory, so
  // Windows paths work without any special handling.
  const dbPath = options.stateDir
    ? path.join(activeStateDir, 'wrexr.db')
    : config.dbPath;
  try {
    database = new DatabaseSync(dbPath);
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA foreign_keys = ON;');
  } catch (error) {
    logger.error('Failed to open database', { dbPath, error: String(error) });
    throw error;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      result TEXT NOT NULL,
      ip TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metrics (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      time INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_kind_time ON metrics(kind, time);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  `);

  for (const table of DOC_TABLES) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  if (options.seedDemo ?? config.demoMode) seedDemoData();
  logger.info('Database ready', { stateDir: activeStateDir, demo: config.demoMode });
  return database;
}

export function closeDb(): void {
  if (database) {
    try {
      database.close();
    } catch {
      /* ignore */
    }
    database = null;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  return safeJsonParse<T>(row.value, fallback);
}

export function hasSetting(key: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value ?? null), nowIso());
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function allSettings(): Record<string, unknown> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = safeJsonParse(row.value, null);
  return out;
}

// ---------------------------------------------------------------------------
// Generic document helpers
// ---------------------------------------------------------------------------

function parseDoc<T>(row: unknown): T | null {
  if (!row || typeof row !== 'object') return null;
  const data = (row as { data?: string }).data;
  if (typeof data !== 'string') return null;
  return safeJsonParse<T | null>(data, null);
}

/**
 * Insert a document. An explicit `id` in the payload is honoured (useful for
 * demo fixtures and tests); otherwise a UUID is generated.
 */
export function insert<T extends Record<string, unknown>>(table: string, data: T): T & { id: string } {
  const name = assertDocTable(table);
  const doc = { ...data } as Record<string, unknown>;
  const docId = typeof doc.id === 'string' && doc.id ? doc.id : id();
  doc.id = docId;
  const now = nowIso();
  getDb()
    .prepare(`INSERT INTO ${name} (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(docId, JSON.stringify(doc), now, now);
  return doc as T & { id: string };
}

export function all<T = Record<string, unknown>>(table: string): T[] {
  const name = assertDocTable(table);
  const rows = getDb()
    .prepare(`SELECT data FROM ${name} ORDER BY created_at ASC, rowid ASC`)
    .all();
  const out: T[] = [];
  for (const row of rows) {
    const doc = parseDoc<T>(row);
    if (doc) out.push(doc);
  }
  return out;
}

export function get<T = Record<string, unknown>>(table: string, docId: string): T | null {
  const name = assertDocTable(table);
  const row = getDb().prepare(`SELECT data FROM ${name} WHERE id = ?`).get(docId);
  return parseDoc<T>(row);
}

export function update<T extends Record<string, unknown>>(
  table: string,
  docId: string,
  patch: Partial<T>,
): (T & { id: string }) | null {
  const name = assertDocTable(table);
  const existing = get<Record<string, unknown>>(name, docId);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id: docId };
  getDb()
    .prepare(`UPDATE ${name} SET data = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(merged), nowIso(), docId);
  return merged as T & { id: string };
}

export function remove(table: string, docId: string): boolean {
  const name = assertDocTable(table);
  const result = getDb().prepare(`DELETE FROM ${name} WHERE id = ?`).run(docId);
  return result.changes > 0;
}

export function count(table: string): number {
  const name = assertDocTable(table);
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function addMetric(kind: string, data: Record<string, unknown>): void {
  getDb()
    .prepare('INSERT INTO metrics (kind, time, data) VALUES (?, ?, ?)')
    .run(kind, Date.now(), JSON.stringify(data));
}

export function getMetrics(kind: string, limit = 120): Array<Record<string, unknown> & { time: number }> {
  const rows = getDb()
    .prepare('SELECT time, data FROM metrics WHERE kind = ? ORDER BY time DESC LIMIT ?')
    .all(kind, limit) as Array<{ time: number; data: string }>;
  return rows
    .reverse()
    .map((row) => ({ time: row.time, ...safeJsonParse<Record<string, unknown>>(row.data, {}) }));
}

export function pruneMetrics(keep = 2000): void {
  getDb()
    .prepare(
      'DELETE FROM metrics WHERE seq NOT IN (SELECT seq FROM metrics ORDER BY seq DESC LIMIT ?)',
    )
    .run(keep);
}

// ---------------------------------------------------------------------------
// Audit & events
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  ts: number;
  actor: string;
  action: string;
  resource: string;
  result: string;
  ip: string;
  message: string;
  data: Record<string, unknown>;
}

export function appendAudit(entry: Omit<AuditEntry, 'id' | 'ts'> & Partial<Pick<AuditEntry, 'id' | 'ts'>>): AuditEntry {
  const full: AuditEntry = {
    id: entry.id ?? id(),
    ts: entry.ts ?? Date.now(),
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    result: entry.result,
    ip: entry.ip,
    message: entry.message,
    data: entry.data ?? {},
  };
  getDb()
    .prepare(
      'INSERT INTO audit (id, ts, actor, action, resource, result, ip, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      full.id,
      full.ts,
      full.actor,
      full.action,
      full.resource,
      full.result,
      full.ip,
      full.message,
      JSON.stringify(full.data),
    );
  return full;
}

export function listAudit(limit = 100): AuditEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM audit ORDER BY ts DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    ts: Number(row.ts),
    actor: String(row.actor),
    action: String(row.action),
    resource: String(row.resource),
    result: String(row.result),
    ip: String(row.ip),
    message: String(row.message),
    data: safeJsonParse<Record<string, unknown>>(String(row.data ?? '{}'), {}),
  }));
}

export interface EventEntry {
  id: string;
  ts: number;
  level: string;
  message: string;
  data: Record<string, unknown>;
}

export function appendEvent(
  entry: Omit<EventEntry, 'id' | 'ts'> & Partial<Pick<EventEntry, 'id' | 'ts'>>,
): EventEntry {
  const full: EventEntry = {
    id: entry.id ?? id(),
    ts: entry.ts ?? Date.now(),
    level: entry.level,
    message: entry.message,
    data: entry.data ?? {},
  };
  getDb()
    .prepare('INSERT INTO events (id, ts, level, message, data) VALUES (?, ?, ?, ?, ?)')
    .run(full.id, full.ts, full.level, full.message, JSON.stringify(full.data));
  return full;
}

export function listEvents(limit = 100): EventEntry[] {
  const rows = getDb()
    .prepare('SELECT id, ts, level, message, data FROM events ORDER BY ts DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    ts: Number(row.ts),
    level: String(row.level),
    message: String(row.message),
    data: safeJsonParse<Record<string, unknown>>(String(row.data ?? '{}'), {}),
  }));
}

// ---------------------------------------------------------------------------
// Demo fixtures (never contain a default password)
// ---------------------------------------------------------------------------

export function seedDemoData(): void {
  if (getSetting('demoSeeded', false)) return;
  const hostname = config.hostname;

  setSetting('hostname', hostname);
  setSetting('timezone', config.timezone);
  setSetting('channel', config.channel);
  setSetting('general', {
    hostname,
    timezone: config.timezone,
    language: 'en',
    theme: 'dark',
    kiosk: false,
  });
  setSetting('network.settings', {
    interfaces: [],
    bridges: [{ name: 'br0', ports: ['eth0'], vlanAware: true, tag: null }],
    vlan: 1,
    mode: 'dhcp',
    ipv4: '',
    gateway: '',
    dns: ['1.1.1.1', '8.8.8.8'],
    proxy: '',
    firewall: [{ id: 'fw-demo', action: 'allow', protocol: 'tcp', port: 8443, source: 'any' }],
  });
  setSetting('storage.settings', { trim: true, paritySchedule: 'weekly', scrubSchedule: 'monthly' });
  setSetting('array', {
    status: 'started',
    syncProgress: 100,
    parity: ['disk-parity'],
    data: ['disk-data-1', 'disk-data-2'],
    cache: ['disk-cache'],
    errors: [],
  });
  setSetting('updates.settings', {
    channel: config.channel,
    autoUpdate: false,
    appUpdates: true,
    repoUrl: config.updateRepo,
    syncStatus: 'idle',
  });
  setSetting('access', {
    roles: ['admin', 'operator', 'viewer'],
    twoFactorPolicy: 'optional',
    sshKeys: [],
  });
  setSetting('advanced', { kernelParams: {}, rawConfig: '' });

  const disks = [
    { id: 'disk-parity', model: 'WDC WD8002FFWX', size: 8_000_000_000_000, type: 'hdd', temp: 34, smart: 'PASSED', role: 'parity', state: 'spun_up' },
    { id: 'disk-data-1', model: 'Seagate Exos X16', size: 16_000_000_000_000, type: 'hdd', temp: 32, smart: 'PASSED', role: 'data', state: 'spun_up' },
    { id: 'disk-data-2', model: 'Seagate Exos X16', size: 16_000_000_000_000, type: 'hdd', temp: 36, smart: 'PASSED', role: 'data', state: 'spun_up' },
    { id: 'disk-cache', model: 'Samsung 990 PRO 2TB', size: 2_000_000_000_000, type: 'nvme', temp: 41, smart: 'PASSED', role: 'cache', state: 'spun_up' },
    { id: 'disk-spare', model: 'WDC WD8002FFWX', size: 8_000_000_000_000, type: 'hdd', temp: 28, smart: 'PASSED', role: 'spare', state: 'spun_down' },
  ];
  for (const disk of disks) insert('disks', disk);
  for (const disk of disks) {
    if (disk.role !== 'spare') {
      insert('array_disks', { disk: disk.id, role: disk.role, device: `/dev/${disk.id}` });
    }
  }

  insert('vms', {
    name: 'ubuntu-server',
    type: 'kvm',
    cpu: 4,
    memory: 8192,
    disk: 80,
    iso: 'ubuntu-24.04-live-server-amd64.iso',
    network: 'br0',
    status: 'running',
    vncPort: 5900,
    snapshots: [{ id: 'snap-vm-1', name: 'clean-install', time: Date.now() - 86_400_000 }],
    firewall: [],
  });
  insert('vms', {
    name: 'alpine-lab',
    type: 'lxc',
    cpu: 2,
    memory: 2048,
    disk: 20,
    template: 'alpine-3.20',
    network: 'br0',
    status: 'stopped',
    vncPort: 5901,
    snapshots: [],
    firewall: [],
  });
  insert('containers', {
    name: 'debian-ct',
    image: 'debian:12',
    cpu: 2,
    memory: 2048,
    status: 'running',
    network: 'br0',
  });

  insert('shares', {
    name: 'media',
    path: '/mnt/user/media',
    disk: 'disk-data-1',
    protocol: 'smb',
    users: ['media'],
    groups: ['users'],
    permissions: '0775',
    recycle: true,
    readOnly: false,
    acl: [{ principal: 'media', type: 'user', permission: 'rw' }],
  });
  insert('shares', {
    name: 'backup',
    path: '/mnt/user/backup',
    disk: 'disk-data-2',
    protocol: 'nfs',
    users: [],
    groups: ['users'],
    permissions: '0755',
    recycle: false,
    readOnly: true,
    acl: [],
  });
  insert('local_users', { username: 'media', groups: ['users'], shell: '/usr/sbin/nologin' });
  insert('groups', { name: 'users', members: ['media'] });
  insert('acls', { share: 'media', principal: 'media', type: 'user', permission: 'rw' });

  insert('apps', {
    appId: 'nginx',
    name: 'nginx (demo)',
    version: '1.27.0',
    status: 'running',
    env: {},
    ports: ['8080:80'],
    volumes: [],
    limits: { cpus: 1, memory: '512m' },
  });
  insert('apps', {
    appId: 'grafana',
    name: 'grafana (demo)',
    version: '11.2.0',
    status: 'stopped',
    env: { GF_SECURITY_ADMIN_PASSWORD: 'demo-only-replace-me' },
    ports: ['3000:3000'],
    volumes: ['grafana-data:/var/lib/grafana'],
    limits: { cpus: 2, memory: '1g' },
  });
  insert('app_repos', {
    name: 'community',
    url: 'https://raw.githubusercontent.com/WrexrOS/community/main/index.json',
    trusted: false,
    syncedAt: Date.now() - 3_600_000,
  });

  insert('datasets', { name: 'tank/media', pool: 'tank', compression: 'lz4', quota: 8_000_000_000_000, used: 1_200_000_000_000 });
  insert('datasets', { name: 'tank/docker', pool: 'tank', compression: 'zstd', quota: 2_000_000_000_000, used: 340_000_000_000 });
  insert('snapshots', { dataset: 'tank/media', name: 'nightly-2026-11-20', time: Date.now() - 86_400_000 });
  insert('snapshots', { dataset: 'tank/docker', name: 'pre-upgrade', time: Date.now() - 172_800_000 });

  insert('alerts', { type: 'temperature', target: 'disk-parity', threshold: 45, enabled: true });
  insert('alerts', { type: 'usage', target: 'tank/media', threshold: 85, enabled: true });
  insert('backups', { name: 'nightly-config', schedule: '0 3 * * *', target: '/mnt/user/backup', status: 'idle', lastRun: Date.now() - 86_400_000 });
  insert('plugins', { name: 'example-plugin', version: '1.0.0', trusted: false, enabled: false, installed: true });
  insert('cluster_nodes', { name: 'wrexr-2', address: '192.168.1.42', role: 'replica', status: 'online', lastSeen: Date.now() - 60_000 });

  const now = Date.now();
  for (let i = 59; i >= 0; i--) {
    const t = now - i * 60_000;
    const wave = Math.sin(i / 6);
    addMetric('sample', {
      cpu: Math.round(24 + wave * 12),
      ram: { used: Math.round(9_000_000_000 + wave * 1_000_000_000), total: 16_000_000_000, percent: Math.round(56 + wave * 6) },
      network: { rx: Math.round(1_200_000 + wave * 600_000), tx: Math.round(540_000 + wave * 250_000) },
    });
  }

  appendEvent({ level: 'info', message: 'Demo environment initialised', data: { hostname } });
  appendEvent({ level: 'info', message: 'Parity array started', data: { array: 'started' } });
  appendEvent({ level: 'warn', message: 'SMART temperature above threshold', data: { disk: 'disk-cache', temp: 41 } });
  appendAudit({
    actor: 'system',
    action: 'demo.seed',
    resource: 'system',
    result: 'success',
    ip: '',
    message: 'Seeded demo environment',
    data: {},
  });

  setSetting('demoSeeded', true);
}
