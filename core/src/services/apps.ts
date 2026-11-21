/** Docker app store: catalog, repos, installs, lifecycle and template signatures. */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.ts';
import { all, get, getSetting, insert, remove, setSetting, update } from '../db.ts';
import { logger } from '../logger.ts';
import { commandAvailable, runCommand } from '../system.ts';
import {
  ApiError, asObject, id, optionalString, requireOneOf, requireString, semverCompare, stringArray,
} from '../util.ts';

export interface CatalogApp {
  id: string;
  name: string;
  category: string;
  version: string;
  description: string;
  icon: string;
  trusted: boolean;
  image: string;
}

const BUILTIN_CATALOG: CatalogApp[] = [
  { id: 'nginx', name: 'Nginx', category: 'networking', version: '1.27.0', description: 'High performance web server and reverse proxy', icon: '🌐', trusted: true, image: 'nginx:1.27-alpine' },
  { id: 'jellyfin', name: 'Jellyfin', category: 'media', version: '10.9.0', description: 'Free software media system', icon: '🎬', trusted: true, image: 'jellyfin/jellyfin:10.9' },
  { id: 'nextcloud', name: 'Nextcloud', category: 'productivity', version: '29.0.0', description: 'Self-hosted collaboration platform', icon: '☁️', trusted: true, image: 'nextcloud:29-apache' },
  { id: 'grafana', name: 'Grafana', category: 'monitoring', version: '11.2.0', description: 'Observability dashboards', icon: '📊', trusted: true, image: 'grafana/grafana:11.2.0' },
  { id: 'home-assistant', name: 'Home Assistant', category: 'automation', version: '2026.11.0', description: 'Open source home automation', icon: '🏠', trusted: false, image: 'ghcr.io/home-assistant/home-assistant:stable' },
  { id: 'postgres', name: 'PostgreSQL', category: 'database', version: '17.0.0', description: 'Advanced open source database', icon: '🐘', trusted: true, image: 'postgres:17-alpine' },
];

function readCatalogFile(): CatalogApp[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(config.catalogPath, 'utf8'));
    const apps = Array.isArray(parsed)
      ? parsed
      : (parsed as { apps?: unknown })?.apps;
    if (!Array.isArray(apps)) return BUILTIN_CATALOG;
    const result: CatalogApp[] = [];
    for (const entry of apps as Array<Record<string, unknown>>) {
      if (typeof entry.id !== 'string' || typeof entry.name !== 'string') continue;
      result.push({
        id: entry.id,
        name: entry.name,
        category: typeof entry.category === 'string' ? entry.category : 'other',
        version: typeof entry.version === 'string' ? entry.version : '0.0.0',
        description: typeof entry.description === 'string' ? entry.description : '',
        icon: typeof entry.icon === 'string' ? entry.icon : '📦',
        trusted: entry.trusted === true,
        image: typeof entry.image === 'string' ? entry.image : entry.id,
      });
    }
    return result.length ? result : BUILTIN_CATALOG;
  } catch {
    return BUILTIN_CATALOG; // catalog is optional in tests and source checkouts
  }
}

export interface InstalledApp {
  id: string;
  appId: string;
  name: string;
  version: string;
  status: string;
  env: Record<string, unknown>;
  ports: string[];
  volumes: string[];
  limits: Record<string, unknown>;
  createdAt?: number;
}

export function listInstalled(): InstalledApp[] {
  return all<InstalledApp>('apps');
}

export function listCatalog(): {
  apps: Array<CatalogApp & { installed: boolean; updateAvailable: boolean }>;
} {
  const installed = listInstalled();
  const apps = readCatalogFile().map((app) => {
    const current = installed.find((item) => item.appId === app.id);
    return {
      ...app,
      installed: !!current,
      updateAvailable: !!current && semverCompare(app.version, current.version) > 0,
    };
  });
  // Include installed custom apps that are not in any catalog.
  for (const item of installed) {
    if (!apps.some((app) => app.id === item.appId)) {
      apps.push({
        id: item.appId,
        name: item.name,
        category: 'custom',
        version: item.version,
        description: 'Locally installed container',
        icon: '📦',
        trusted: false,
        image: item.appId,
        installed: true,
        updateAvailable: false,
      });
    }
  }
  return { apps };
}

function catalogEntry(appId: string): CatalogApp {
  return readCatalogFile().find((app) => app.id === appId) ?? {
    id: appId,
    name: appId,
    category: 'custom',
    version: '0.0.0',
    description: '',
    icon: '📦',
    trusted: false,
    image: appId,
  };
}

export async function installApp(input: Record<string, unknown>): Promise<InstalledApp> {
  const body = asObject(input);
  const appId = requireString(body, 'appId');
  const entry = catalogEntry(appId);
  const name = optionalString(body, 'name', `${entry.id}-wrexr`);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new ApiError('VALIDATION_ERROR', 'Invalid container name');
  if (listInstalled().some((app) => app.name === name)) {
    throw new ApiError('CONFLICT', 'A container with that name already exists', 409);
  }
  const env = body.env && typeof body.env === 'object' && !Array.isArray(body.env)
    ? (body.env as Record<string, unknown>)
    : {};
  const ports = stringArray(body.ports, 'ports');
  const volumes = stringArray(body.volumes, 'volumes');
  const limits = body.limits && typeof body.limits === 'object' && !Array.isArray(body.limits)
    ? (body.limits as Record<string, unknown>)
    : {};

  if (!config.demoMode && (await commandAvailable('docker'))) {
    await runCommand('docker', ['pull', entry.image]);
    const args = ['run', '-d', '--name', name];
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${String(value)}`);
    for (const port of ports) args.push('-p', port);
    for (const volume of volumes) args.push('-v', volume);
    if (typeof limits.cpus === 'number') args.push('--cpus', String(limits.cpus));
    if (typeof limits.memory === 'string') args.push('--memory', limits.memory);
    args.push(entry.image);
    const result = await runCommand('docker', args);
    if (result.code !== 0) logger.warn('docker run failed', { stderr: result.stderr });
  }

  return insert<InstalledApp>('apps', {
    appId,
    name,
    version: entry.version,
    status: 'running',
    env,
    ports,
    volumes,
    limits,
    createdAt: Date.now(),
  });
}

export function getApp(appId: string): InstalledApp {
  const app = get<InstalledApp>('apps', appId);
  if (!app) throw new ApiError('NOT_FOUND', 'App not found', 404);
  return app;
}

export function updateApp(appId: string, input: Record<string, unknown>): InstalledApp {
  const body = asObject(input);
  getApp(appId);
  const patch: Partial<InstalledApp> = {};
  if (body.name !== undefined) patch.name = requireString(body, 'name');
  if (body.env !== undefined && typeof body.env === 'object') patch.env = body.env as Record<string, unknown>;
  if (body.ports !== undefined) patch.ports = stringArray(body.ports, 'ports');
  if (body.volumes !== undefined) patch.volumes = stringArray(body.volumes, 'volumes');
  if (body.limits !== undefined && typeof body.limits === 'object') patch.limits = body.limits as Record<string, unknown>;
  return update<InstalledApp>('apps', appId, patch) as InstalledApp;
}

export async function removeApp(appId: string): Promise<{ deleted: boolean }> {
  const app = getApp(appId);
  if (!config.demoMode && (await commandAvailable('docker'))) {
    await runCommand('docker', ['rm', '-f', app.name]);
  }
  return { deleted: remove('apps', appId) };
}

export async function appAction(appId: string, action: string): Promise<InstalledApp> {
  requireOneOf({ action }, 'action', ['start', 'stop', 'restart', 'upgrade'] as const);
  const app = getApp(appId);
  if (!config.demoMode && (await commandAvailable('docker'))) {
    const args: Record<string, string[]> = {
      start: ['start', app.name],
      stop: ['stop', app.name],
      restart: ['restart', app.name],
      upgrade: ['restart', app.name],
    };
    const result = await runCommand('docker', args[action]);
    if (result.code !== 0) logger.warn('docker action failed', { action, stderr: result.stderr });
  }
  const status = action === 'stop' ? 'stopped' : 'running';
  const patch: Partial<InstalledApp> = { status };
  if (action === 'upgrade') patch.version = catalogEntry(app.appId).version;
  return update<InstalledApp>('apps', appId, patch) as InstalledApp;
}

export function appLogs(appId: string): { lines: string[] } {
  const app = getApp(appId);
  if (config.demoMode) {
    return {
      lines: [
        `[demo] container ${app.name} started`,
        `[demo] listening on ${app.ports.join(', ') || 'internal'}`,
        `[demo] no errors reported`,
      ],
    };
  }
  return { lines: [] };
}

export interface AppRepo {
  id: string;
  url: string;
  name: string;
  trusted: boolean;
  syncedAt?: number;
}

export function listRepos(): AppRepo[] {
  return all<AppRepo>('app_repos');
}

export function addRepo(input: Record<string, unknown>): AppRepo {
  const body = asObject(input);
  const url = requireString(body, 'url', { pattern: /^https?:\/\/\S+$/ });
  return insert<AppRepo>('app_repos', {
    url,
    name: optionalString(body, 'name', new URL(url).hostname),
    trusted: body.trusted === true,
    syncedAt: Date.now(),
  });
}

export function removeRepo(repoId: string): { deleted: boolean } {
  return { deleted: remove('app_repos', repoId) };
}

export function syncRepos(): { syncedAt: number; repos: number } {
  const syncedAt = Date.now();
  for (const repo of listRepos()) update<AppRepo>('app_repos', repo.id, { syncedAt });
  setSetting('appReposSyncedAt', syncedAt);
  return { syncedAt, repos: listRepos().length };
}

/**
 * Verify a signed app template. The public key may be PEM or base64 SPKI DER.
 * Returns `configured:false` when no key is set so callers can fail closed.
 */
export function verifyTemplateSignature(
  payload: string | Buffer,
  signatureBase64: string,
  publicKey: string = config.templatePublicKey,
): { valid: boolean; configured: boolean } {
  if (!publicKey) return { valid: false, configured: false };
  try {
    const key = publicKey.includes('BEGIN')
      ? createPublicKey(publicKey)
      : createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    const valid = cryptoVerify(
      null,
      Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
      key,
      Buffer.from(signatureBase64, 'base64'),
    );
    return { valid, configured: true };
  } catch (error) {
    logger.warn('Template signature verification failed', { error: String(error) });
    return { valid: false, configured: true };
  }
}
