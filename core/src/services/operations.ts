/** Operations: events, audit, alerts, backups, plugins and cluster nodes. */
import { getAudit, getEvents } from '../audit.ts';
import { config } from '../config.ts';
import { all, get, insert, remove, update } from '../db.ts';
import {
  ApiError, asObject, id, optionalBoolean, optionalString, requireNumber, requireOneOf,
  requireString,
} from '../util.ts';
import { verifyTemplateSignature } from './apps.ts';

export { getAudit as listAuditEntries, getEvents as listEventEntries };

export function recentEvents(limit = 50) {
  return getEvents(limit);
}

export function recentAudit(limit = 100) {
  return getAudit(limit);
}

export interface Alert {
  id: string;
  type: string;
  target: string;
  threshold: number;
  enabled: boolean;
}

export function listAlerts(): Alert[] {
  return all<Alert>('alerts');
}

export function createAlert(input: Record<string, unknown>): Alert {
  const body = asObject(input);
  return insert<Alert>('alerts', {
    type: requireOneOf(body, 'type', ['temperature', 'usage', 'smart', 'offline', 'custom'] as const),
    target: requireString(body, 'target'),
    threshold: requireNumber(body, 'threshold', { min: 0, max: 100 }),
    enabled: optionalBoolean(body, 'enabled', true),
  });
}

export function deleteAlert(alertId: string): { deleted: boolean } {
  return { deleted: remove('alerts', alertId) };
}

export interface Backup {
  id: string;
  name: string;
  schedule: string;
  target: string;
  status: string;
  lastRun: number | null;
}

export function listBackups(): Backup[] {
  return all<Backup>('backups');
}

export function createBackup(input: Record<string, unknown>): Backup {
  const body = asObject(input);
  return insert<Backup>('backups', {
    name: requireString(body, 'name'),
    schedule: optionalString(body, 'schedule', '0 3 * * *'),
    target: requireString(body, 'target'),
    status: 'idle',
    lastRun: null,
  });
}

export function runBackup(backupId: string): Backup {
  const backup = get<Backup>('backups', backupId);
  if (!backup) throw new ApiError('NOT_FOUND', 'Backup not found', 404);
  return update<Backup>('backups', backupId, {
    status: 'success',
    lastRun: Date.now(),
  }) as Backup;
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  trusted: boolean;
  enabled: boolean;
  installed: boolean;
  signature?: string;
}

export function listPlugins(): Plugin[] {
  return all<Plugin>('plugins');
}

export function addPlugin(input: Record<string, unknown>): Plugin {
  const body = asObject(input);
  const signature = optionalString(body, 'signature');
  if (config.pluginPublicKey) {
    const check = verifyTemplateSignature(
      String(body.manifest ?? body.name ?? ''),
      signature,
      config.pluginPublicKey,
    );
    if (!check.valid) throw new ApiError('INVALID_SIGNATURE', 'Plugin signature is invalid', 400);
  }
  return insert<Plugin>('plugins', {
    name: requireString(body, 'name'),
    version: optionalString(body, 'version', '1.0.0'),
    trusted: body.trusted === true,
    enabled: false,
    installed: true,
    signature,
  });
}

export function pluginAction(pluginId: string, action: string): Plugin {
  requireOneOf({ action }, 'action', ['enable', 'disable', 'install'] as const);
  const plugin = get<Plugin>('plugins', pluginId);
  if (!plugin) throw new ApiError('NOT_FOUND', 'Plugin not found', 404);
  return update<Plugin>('plugins', pluginId, {
    enabled: action === 'enable',
    installed: true,
  }) as Plugin;
}

export interface ClusterNode {
  id: string;
  name: string;
  address: string;
  role: string;
  status: string;
  lastSeen: number;
}

export function listClusterNodes(): ClusterNode[] {
  return all<ClusterNode>('cluster_nodes');
}

export function addClusterNode(input: Record<string, unknown>): ClusterNode {
  const body = asObject(input);
  const address = requireString(body, 'address', { max: 255 });
  if (listClusterNodes().some((node) => node.address === address)) {
    throw new ApiError('CONFLICT', 'Node is already linked', 409);
  }
  return insert<ClusterNode>('cluster_nodes', {
    name: optionalString(body, 'name', address),
    address,
    role: optionalString(body, 'role', 'replica'),
    status: 'pending',
    lastSeen: Date.now(),
  });
}

export function deleteClusterNode(nodeId: string): { deleted: boolean } {
  return { deleted: remove('cluster_nodes', nodeId) };
}
