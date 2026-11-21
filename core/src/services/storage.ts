/** Disk inventory, Unraid-style parity array, datasets/snapshots and SMART. */
import { config } from '../config.ts';
import { all, get, getSetting, insert, remove, setSetting, update } from '../db.ts';
import { commandAvailable, runCommand } from '../system.ts';
import { ApiError, asObject, optionalString, requireNumber, requireOneOf, requireString } from '../util.ts';

export interface DiskRecord {
  id: string;
  model: string;
  size: number;
  type: 'hdd' | 'ssd' | 'nvme';
  temp: number;
  smart: string;
  role: 'parity' | 'data' | 'cache' | 'spare';
  state: string;
}

export function listDisks(): { disks: DiskRecord[] } {
  return { disks: all<DiskRecord>('disks') };
}

interface ArraySetting {
  status: string;
  syncProgress: number;
  syncStartedAt?: number;
  parity: string[];
  data: string[];
  cache: string[];
  errors: string[];
}

function defaultArray(): ArraySetting {
  return { status: 'stopped', syncProgress: 100, parity: [], data: [], cache: [], errors: [] };
}

export function getArray(): Record<string, unknown> {
  const array = { ...defaultArray(), ...getSetting<ArraySetting>('array', defaultArray()) };
  if (array.status !== 'stopped' && array.syncStartedAt !== undefined && array.syncProgress < 100) {
    // Simulated 90-second rebuild/scrub, advanced on read so no timer is needed.
    const progress = Math.min(100, Math.round(((Date.now() - array.syncStartedAt) / 90_000) * 100));
    if (progress !== array.syncProgress) {
      array.syncProgress = progress;
      setSetting('array', array);
    }
  }
  const disks = all<DiskRecord>('disks');
  const capacity = (ids: string[]) =>
    disks.filter((disk) => ids.includes(disk.id)).reduce((sum, disk) => sum + disk.size, 0);
  const used = capacity(array.data) * 0.62;
  const total = capacity(array.data);
  return {
    status: array.status,
    parity: array.parity,
    data: array.data,
    cache: array.cache,
    used: Math.round(used),
    total: Math.round(total),
    syncProgress: array.syncProgress,
    errors: array.errors,
  };
}

export function arrayAction(action: string): Record<string, unknown> {
  requireOneOf({ action }, 'action', ['start', 'stop', 'sync', 'scrub', 'clear'] as const);
  const array = { ...defaultArray(), ...getSetting<ArraySetting>('array', defaultArray()) };
  if (action === 'start') array.status = 'started';
  if (action === 'stop') {
    array.status = 'stopped';
    delete array.syncStartedAt;
  }
  if (action === 'sync' || action === 'scrub') {
    array.status = 'started';
    array.syncProgress = 0;
    array.syncStartedAt = Date.now();
  }
  if (action === 'clear') {
    array.errors = [];
    array.syncProgress = 100;
    delete array.syncStartedAt;
  }
  setSetting('array', array);
  return getArray();
}

export function assignDisk(input: Record<string, unknown>): Record<string, unknown> {
  const body = asObject(input);
  const diskId = requireString(body, 'disk');
  const role = requireOneOf(body, 'role', ['parity', 'data', 'cache', 'spare'] as const);
  const disk = get<DiskRecord>('disks', diskId);
  if (!disk) throw new ApiError('NOT_FOUND', 'Disk not found', 404);
  const existing = all<Record<string, unknown>>('array_disks').find((item) => item.disk === diskId);
  if (existing) update('array_disks', String(existing.id), { role });
  else insert('array_disks', { disk: diskId, role, device: `/dev/${diskId}` });
  update<DiskRecord>('disks', diskId, { role });

  const array = { ...defaultArray(), ...getSetting<ArraySetting>('array', defaultArray()) };
  array.parity = all<Record<string, unknown>>('array_disks')
    .filter((item) => item.role === 'parity')
    .map((item) => String(item.disk));
  array.data = all<Record<string, unknown>>('array_disks')
    .filter((item) => item.role === 'data')
    .map((item) => String(item.disk));
  array.cache = all<Record<string, unknown>>('array_disks')
    .filter((item) => item.role === 'cache')
    .map((item) => String(item.disk));
  setSetting('array', array);
  return { disk: diskId, role, array: getArray() };
}

export interface Dataset {
  id: string;
  name: string;
  pool: string;
  compression: string;
  quota: number;
  used: number;
}

export function listDatasets(): Dataset[] {
  return all<Dataset>('datasets');
}

export function createDataset(input: Record<string, unknown>): Dataset {
  const body = asObject(input);
  const name = requireString(body, 'name', { pattern: /^[A-Za-z0-9_./-]{1,128}$/ });
  if (listDatasets().some((dataset) => dataset.name === name)) {
    throw new ApiError('CONFLICT', 'Dataset already exists', 409);
  }
  const dataset = insert<Dataset>('datasets', {
    name,
    pool: optionalString(body, 'pool') || name.split('/')[0],
    compression: typeof body.compression === 'string' ? body.compression : 'lz4',
    quota: requireNumber(body, 'quota', { min: 0, fallback: 0 }),
    used: 0,
  });
  return dataset;
}

export function deleteDataset(name: string): { deleted: boolean } {
  const dataset = listDatasets().find((item) => item.name === name);
  if (!dataset) throw new ApiError('NOT_FOUND', 'Dataset not found', 404);
  const snapshots = all<Record<string, unknown>>('snapshots').filter((item) => item.dataset === name);
  for (const snap of snapshots) remove('snapshots', String(snap.id));
  return { deleted: remove('datasets', dataset.id) };
}

export interface Snapshot {
  id: string;
  dataset: string;
  name: string;
  time: number;
}

export function listSnapshots(): Snapshot[] {
  return all<Snapshot>('snapshots');
}

export function createSnapshot(input: Record<string, unknown>): Snapshot {
  const body = asObject(input);
  const dataset = requireString(body, 'dataset');
  const name = requireString(body, 'name', { pattern: /^[A-Za-z0-9_.:-]{1,128}$/ });
  if (!listDatasets().some((item) => item.name === dataset) && !config.demoMode) {
    throw new ApiError('NOT_FOUND', 'Dataset not found', 404);
  }
  return insert<Snapshot>('snapshots', { dataset, name, time: Date.now() });
}

export function smartStatus(): Record<string, unknown> {
  return {
    settings: getSetting<Record<string, unknown>>('storage.smart', {
      schedule: 'weekly',
      enabled: true,
      tests: [],
    }),
    results: all<Record<string, unknown>>('smart_results'),
  };
}

/** SMART results are stored in a document table created lazily via settings. */
export async function smartAction(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = asObject(input);
  if (body.schedule !== undefined || body.enabled !== undefined) {
    const current = smartStatus().settings as Record<string, unknown>;
    const next = { ...current };
    if (typeof body.schedule === 'string') next.schedule = body.schedule;
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    setSetting('storage.smart', next);
    return smartStatus();
  }
  const diskId = requireString(body, 'disk');
  const type = requireOneOf(body, 'type', ['short', 'long', 'conveyance'] as const, 'short');
  const disk = get<DiskRecord>('disks', diskId);
  if (!disk) throw new ApiError('NOT_FOUND', 'Disk not found', 404);
  let passed = true;
  let detail = 'simulated SMART test completed';
  if (!config.demoMode && (await commandAvailable('smartctl'))) {
    const result = await runCommand('smartctl', ['-t', type, `/dev/${disk.id}`]);
    passed = result.code === 0;
    detail = result.stderr || result.stdout;
  }
  const result = insert('smart_results', {
    disk: diskId,
    type,
    passed,
    detail,
    time: Date.now(),
  });
  return { result };
}

export function getStorageSettings(): Record<string, unknown> {
  return getSetting<Record<string, unknown>>('storage.settings', {
    trim: true,
    paritySchedule: 'weekly',
    scrubSchedule: 'monthly',
  });
}

export function setStorageSettings(input: Record<string, unknown>): Record<string, unknown> {
  const current = getStorageSettings();
  const next = { ...current };
  if (typeof input.trim === 'boolean') next.trim = input.trim;
  if (typeof input.paritySchedule === 'string') next.paritySchedule = input.paritySchedule;
  if (typeof input.scrubSchedule === 'string') next.scrubSchedule = input.scrubSchedule;
  setSetting('storage.settings', next);
  return next;
}
