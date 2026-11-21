/**
 * HTTP router: method + pattern matching, auth/RBAC middleware, central audit
 * recording, response envelopes, CORS, static SPA hosting and OpenAPI 3.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authenticate, getMe, login, logout, revokeToken, createApiToken, listTokens,
  setup, setupRequired, totpEnroll, totpVerify, requirePermission, hasPermission,
  type Principal,
} from './auth.ts';
import { record } from './audit.ts';
import { config } from './config.ts';
import { count } from './db.ts';
import { logger } from './logger.ts';
import { hostInfo, metricsHistory, systemMetrics, coreVersion } from './system.ts';
import {
  ApiError, asObject, fail, ok, optionalString, parseQuery, readBody, requireString,
  stringArray, type ParsedQuery,
} from './util.ts';
import * as virtualization from './services/virtualization.ts';
import * as storage from './services/storage.ts';
import * as sharing from './services/sharing.ts';
import * as apps from './services/apps.ts';
import * as network from './services/network.ts';
import * as settings from './services/settings.ts';
import * as updates from './services/updates.ts';
import * as operations from './services/operations.ts';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: ParsedQuery;
  body: any;
  principal: Principal | null;
  url: URL;
}

export interface Route {
  method: string;
  path: string;
  handler: (ctx: RouteContext) => unknown | Promise<unknown>;
  permission?: string;
  auth?: boolean;
  status?: number;
  summary?: string;
}

export const ROUTES: Route[] = [];

function add(
  method: string,
  routePath: string,
  handler: Route['handler'],
  options: Omit<Route, 'method' | 'path' | 'handler'> = {},
): void {
  ROUTES.push({ method, path: routePath, handler, ...options });
}

const p = (ctx: RouteContext, key: string) => String(ctx.params[key] ?? '');

// --- Auth / first boot ------------------------------------------------------

add('GET', '/auth/status', () => ({
  setupRequired: setupRequired(),
  version: coreVersion(),
  hostname: config.hostname,
  channel: config.channel,
}), { auth: false, summary: 'First-boot status' });

add('POST', '/auth/setup', async (ctx) => {
  const result = await setup(ctx.body);
  return result;
}, { auth: false, status: 201, summary: 'Run first-boot wizard' });

add('POST', '/auth/login', (ctx) => {
  const body = asObject(ctx.body);
  return login(requireString(body, 'password'), typeof body.totp === 'string' ? body.totp : undefined);
}, { auth: false, summary: 'Log in with password and optional TOTP' });

add('POST', '/auth/logout', (ctx) => ({ loggedOut: logout(bearerToken(ctx.req, ctx.url)) }), {
  summary: 'Invalidate the current session',
});

add('GET', '/auth/me', (ctx) => getMe(ctx.principal as Principal), { summary: 'Current identity' });

add('POST', '/auth/totp/enroll', (ctx) => totpEnroll((ctx.principal as Principal).userId), {
  summary: 'Start TOTP enrollment',
});
add('POST', '/auth/totp/verify', (ctx) =>
  totpVerify((ctx.principal as Principal).userId, requireString(asObject(ctx.body), 'code')), {
  summary: 'Confirm TOTP enrollment',
});

add('GET', '/auth/tokens', () => ({ tokens: listTokens() }), {
  permission: 'auth:write', summary: 'List API tokens',
});
add('POST', '/auth/tokens', (ctx) => {
  const body = asObject(ctx.body);
  return createApiToken(
    (ctx.principal as Principal).userId,
    requireString(body, 'name'),
    stringArray(body.scopes, 'scopes'),
    typeof body.expiresAt === 'number' ? body.expiresAt : undefined,
  );
}, { permission: 'auth:write', status: 201, summary: 'Create API token' });
add('DELETE', '/auth/tokens/:id', (ctx) => ({ deleted: revokeToken(p(ctx, 'id')) }), {
  permission: 'auth:write', summary: 'Revoke API token',
});

// --- Dashboard --------------------------------------------------------------

add('GET', '/dashboard', async () => {
  const [host, metrics] = await Promise.all([
    Promise.resolve(hostInfo()),
    systemMetrics(),
  ]);
  const alerts = operations.listAlerts();
  return {
    host,
    metrics: { cpu: metrics.cpu, ram: metrics.ram, disk: metrics.disk, network: metrics.network },
    counts: {
      vms: count('vms'),
      containers: count('containers'),
      shares: count('shares'),
      apps: count('apps'),
    },
    array: storage.getArray(),
    events: operations.recentEvents(10),
    alerts,
  };
}, { summary: 'Dashboard overview' });

add('GET', '/metrics/history', (ctx) => metricsHistory(Number(ctx.query.limit ?? 120)), {
  summary: 'Metric history for graphs',
});

// --- Virtualization ---------------------------------------------------------

add('GET', '/vms', async () => ({ vms: await virtualization.listVms() }), { summary: 'List VMs' });
add('POST', '/vms', async (ctx) => virtualization.createVm(ctx.body), {
  status: 201, summary: 'Create VM or LXC',
});
add('GET', '/vms/:id', (ctx) => virtualization.getVm(p(ctx, 'id')), { summary: 'Inspect VM' });
add('PUT', '/vms/:id', (ctx) => virtualization.updateVm(p(ctx, 'id'), ctx.body), { summary: 'Update VM' });
add('DELETE', '/vms/:id', async (ctx) => virtualization.deleteVm(p(ctx, 'id')), { summary: 'Delete VM' });
add('GET', '/vms/:id/vnc', (ctx) => virtualization.vncInfo(p(ctx, 'id')), { summary: 'VNC details' });
add('GET', '/vms/:id/snapshots', (ctx) => ({ snapshots: virtualization.listVmSnapshots(p(ctx, 'id')) }), {
  summary: 'List VM snapshots',
});
add('POST', '/vms/:id/snapshots', (ctx) => ({
  snapshots: virtualization.createVmSnapshot(p(ctx, 'id'), optionalString(asObject(ctx.body), 'name') || undefined),
}), { summary: 'Create VM snapshot' });
add('GET', '/vms/:id/firewall', (ctx) => ({ rules: virtualization.getFirewall(p(ctx, 'id')) }), {
  summary: 'List VM firewall rules',
});
add('POST', '/vms/:id/firewall', (ctx) => ({ rules: virtualization.setFirewall(p(ctx, 'id'), ctx.body) }), {
  summary: 'Update VM firewall rules',
});
add('POST', '/vms/:id/:action', async (ctx) => virtualization.vmAction(p(ctx, 'id'), p(ctx, 'action')), {
  permission: '@action:vm', summary: 'Run VM lifecycle action',
});

add('GET', '/pci', async () => virtualization.pciList(), { summary: 'List PCI devices' });
add('GET', '/bridges', () => ({ bridges: virtualization.listBridges() }), { summary: 'List bridges' });
add('POST', '/bridges', (ctx) => virtualization.createBridge(ctx.body), {
  status: 201, summary: 'Create bridge',
});
add('GET', '/vm-templates', () => ({ templates: virtualization.listTemplates() }), {
  summary: 'List VM templates',
});
add('POST', '/vm-templates', (ctx) => virtualization.createTemplate(ctx.body), {
  status: 201, summary: 'Create VM template',
});

// --- Storage ----------------------------------------------------------------

add('GET', '/storage/disks', () => storage.listDisks(), { summary: 'List disks' });
add('GET', '/storage/array', () => storage.getArray(), { summary: 'Parity array status' });
add('POST', '/storage/array/disks', (ctx) => storage.assignDisk(ctx.body), {
  summary: 'Assign disk role',
});
add('POST', '/storage/array/:action', (ctx) => storage.arrayAction(p(ctx, 'action')), {
  permission: '@action:storage', summary: 'Array action',
});
add('GET', '/storage/datasets', () => ({ datasets: storage.listDatasets() }), {
  summary: 'List datasets',
});
add('POST', '/storage/datasets', (ctx) => storage.createDataset(ctx.body), {
  status: 201, summary: 'Create dataset',
});
add('DELETE', '/storage/datasets/:name', (ctx) => storage.deleteDataset(p(ctx, 'name')), {
  summary: 'Delete dataset',
});
add('GET', '/storage/snapshots', () => ({ snapshots: storage.listSnapshots() }), {
  summary: 'List snapshots',
});
add('POST', '/storage/snapshots', (ctx) => storage.createSnapshot(ctx.body), {
  status: 201, summary: 'Create snapshot',
});
add('GET', '/storage/smart', () => storage.smartStatus(), { summary: 'SMART status' });
add('POST', '/storage/smart', async (ctx) => storage.smartAction(ctx.body), {
  summary: 'Run SMART test / update schedule',
});
add('GET', '/storage/settings', () => storage.getStorageSettings(), { summary: 'Storage settings' });
add('PUT', '/storage/settings', (ctx) => storage.setStorageSettings(ctx.body), {
  summary: 'Update storage settings',
});

// --- Sharing ----------------------------------------------------------------

add('GET', '/shares', () => ({ shares: sharing.listShares() }), { summary: 'List shares' });
add('POST', '/shares', (ctx) => sharing.createShare(ctx.body), {
  status: 201, summary: 'Create share',
});
add('GET', '/shares/:id', (ctx) => sharing.getShare(p(ctx, 'id')), { summary: 'Inspect share' });
add('PUT', '/shares/:id', (ctx) => sharing.updateShare(p(ctx, 'id'), ctx.body), {
  summary: 'Update share',
});
add('DELETE', '/shares/:id', (ctx) => sharing.deleteShare(p(ctx, 'id')), {
  summary: 'Delete share',
});
add('POST', '/shares/:id/acl', (ctx) => ({ acl: sharing.updateAcl(p(ctx, 'id'), ctx.body) }), {
  summary: 'Update share ACL',
});
add('GET', '/users', () => ({ users: sharing.listLocalUsers() }), { summary: 'List local users' });
add('POST', '/users', (ctx) => sharing.createLocalUser(ctx.body), {
  status: 201, summary: 'Create local user',
});
add('DELETE', '/users/:id', (ctx) => sharing.deleteLocalUser(p(ctx, 'id')), {
  summary: 'Delete local user',
});
add('GET', '/groups', () => ({ groups: sharing.listGroups() }), { summary: 'List groups' });
add('POST', '/groups', (ctx) => sharing.createGroup(ctx.body), {
  status: 201, summary: 'Create group',
});

// --- Apps -------------------------------------------------------------------

add('GET', '/apps/catalog', () => apps.listCatalog(), { summary: 'App catalog' });
add('GET', '/apps/installed', () => ({ apps: apps.listInstalled() }), { summary: 'Installed apps' });
add('POST', '/apps/install', async (ctx) => apps.installApp(ctx.body), {
  status: 201, permission: 'app:install', summary: 'Install app',
});
add('GET', '/apps/repos', () => ({ repos: apps.listRepos() }), { summary: 'List app repos' });
add('POST', '/apps/repos', (ctx) => apps.addRepo(ctx.body), {
  status: 201, summary: 'Add app repo',
});
add('POST', '/apps/repos/sync', () => apps.syncRepos(), { summary: 'Sync app repos' });
add('DELETE', '/apps/repos/:id', (ctx) => apps.removeRepo(p(ctx, 'id')), {
  summary: 'Remove app repo',
});
add('GET', '/apps/:id/logs', (ctx) => apps.appLogs(p(ctx, 'id')), { summary: 'App logs' });
add('GET', '/apps/:id', (ctx) => apps.getApp(p(ctx, 'id')), { summary: 'Inspect app' });
add('PUT', '/apps/:id', (ctx) => apps.updateApp(p(ctx, 'id'), ctx.body), { summary: 'Update app' });
add('DELETE', '/apps/:id', async (ctx) => apps.removeApp(p(ctx, 'id')), { summary: 'Remove app' });
add('POST', '/apps/:id/:action', async (ctx) => apps.appAction(p(ctx, 'id'), p(ctx, 'action')), {
  permission: '@action:app', summary: 'App lifecycle action',
});

// --- Settings ---------------------------------------------------------------

add('GET', '/settings/general', () => settings.getGeneral(), { summary: 'General settings' });
add('PUT', '/settings/general', (ctx) => settings.setGeneral(ctx.body), { summary: 'Save general settings' });
add('GET', '/settings/network', () => settings.getNetworkSettings(), { summary: 'Network settings' });
add('PUT', '/settings/network', (ctx) => settings.updateNetworkSettings(ctx.body), {
  summary: 'Save network settings',
});
add('GET', '/settings/storage', () => settings.getStorageSettings(), { summary: 'Storage settings' });
add('PUT', '/settings/storage', (ctx) => settings.setStorageSettings(ctx.body), {
  summary: 'Save storage settings',
});
add('GET', '/settings/access', () => settings.getAccess(), { summary: 'Access settings' });
add('PUT', '/settings/access', (ctx) => settings.setAccess(ctx.body), {
  permission: 'settings:admin', summary: 'Save access settings',
});
add('GET', '/settings/updates', () => settings.getUpdatesSettings(), { summary: 'Update settings' });
add('PUT', '/settings/updates', (ctx) => settings.setUpdatesSettings(ctx.body), {
  summary: 'Save update settings',
});
add('GET', '/settings/advanced', () => settings.getAdvanced(), { summary: 'Advanced settings' });
add('PUT', '/settings/advanced', (ctx) => settings.setAdvanced(ctx.body), {
  summary: 'Save advanced settings',
});
add('GET', '/settings/raw', () => settings.getRawConfig(), { summary: 'Raw config' });
add('PUT', '/settings/raw', (ctx) => settings.saveRawConfig(ctx.body), {
  permission: 'settings:admin', summary: 'Save raw config with backup',
});
add('POST', '/settings/raw/validate', (ctx) => settings.validateRawConfig(ctx.body), {
  summary: 'Validate raw config',
});

// --- Updates ----------------------------------------------------------------

add('GET', '/updates/check', async () => updates.checkUpdates(), { summary: 'Check for updates' });
add('POST', '/updates/install', (ctx) => updates.installUpdate(optionalString(asObject(ctx.body), 'version') || undefined), {
  permission: 'updates:write', status: 202, summary: 'Install update',
});
add('GET', '/updates/status', () => updates.updateStatus(), { summary: 'Update job status' });
add('GET', '/updates/app', () => ({ apps: updates.appUpdates() }), { summary: 'App update notifications' });
add('GET', '/updates/repo', () => updates.repoInfo(), { summary: 'Repository information' });

// --- Operations -------------------------------------------------------------

add('GET', '/events', (ctx) => ({ events: operations.recentEvents(Number(ctx.query.limit ?? 100)) }), {
  summary: 'Recent events',
});
add('GET', '/audit', (ctx) => ({ audit: operations.recentAudit(Number(ctx.query.limit ?? 100)) }), {
  permission: 'system:admin', summary: 'Audit log',
});
add('GET', '/alerts', () => ({ alerts: operations.listAlerts() }), { summary: 'Alert rules' });
add('POST', '/alerts', (ctx) => operations.createAlert(ctx.body), {
  status: 201, summary: 'Create alert rule',
});
add('GET', '/backups', () => ({ backups: operations.listBackups() }), { summary: 'Backups' });
add('POST', '/backups', (ctx) => operations.createBackup(ctx.body), {
  status: 201, summary: 'Create backup schedule',
});
add('POST', '/backups/:id/run', (ctx) => operations.runBackup(p(ctx, 'id')), {
  summary: 'Run backup now',
});
add('GET', '/plugins', () => ({ plugins: operations.listPlugins() }), { summary: 'Plugins' });
add('POST', '/plugins', (ctx) => operations.addPlugin(ctx.body), {
  status: 201, summary: 'Add plugin',
});
add('POST', '/plugins/:id/:action', (ctx) => operations.pluginAction(p(ctx, 'id'), p(ctx, 'action')), {
  permission: '@action:plugin', summary: 'Plugin action',
});
add('GET', '/cluster/nodes', () => ({ nodes: operations.listClusterNodes() }), {
  summary: 'Cluster nodes',
});
add('POST', '/cluster/nodes', (ctx) => operations.addClusterNode(ctx.body), {
  status: 201, summary: 'Link cluster node',
});
add('DELETE', '/cluster/nodes/:id', (ctx) => operations.deleteClusterNode(p(ctx, 'id')), {
  summary: 'Unlink cluster node',
});

add('GET', '/openapi.json', () => openapiDocument(), {
  auth: false, summary: 'OpenAPI 3.1 description',
});

/** Static paths win over parametrised paths, then longer paths. */
const ROUTES_SORTED = [...ROUTES].sort((a, b) => {
  const statics = (route: Route) => route.path.split('/').filter((s) => s && !s.startsWith(':')).length;
  return statics(b) - statics(a) || b.path.length - a.path.length;
});

const DOMAIN_BY_PREFIX: Record<string, string> = {
  vms: 'vm', pci: 'vm', bridges: 'vm', 'vm-templates': 'vm',
  storage: 'storage', shares: 'share', users: 'user', groups: 'user',
  apps: 'app', settings: 'settings', updates: 'updates', auth: 'auth',
  dashboard: 'system', metrics: 'system', events: 'system', audit: 'system',
  alerts: 'system', backups: 'system', plugins: 'plugin', cluster: 'cluster',
};

function requiredPermission(route: Route, params: Record<string, string>): string | undefined {
  if (!route.permission) {
    const domain = DOMAIN_BY_PREFIX[route.path.split('/')[1]] ?? 'system';
    return route.method === 'GET' ? `${domain}:read` : `${domain}:write`;
  }
  if (route.permission.startsWith('@action:')) {
    const domain = route.permission.slice('@action:'.length);
    return `${domain}:${params.action ?? 'write'}`;
  }
  return route.permission;
}

function bearerToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  const cookies = req.headers.cookie ?? '';
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'wrexr_session') return decodeURIComponent(rest.join('='));
  }
  const queryToken = url.searchParams.get('token');
  return queryToken ?? undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  if (config.cors) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Wrexr-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve the built SPA (core/web/dist). Returns false when no build exists. */
async function serveStatic(res: ServerResponse, pathname: string, head: boolean): Promise<boolean> {
  const root = path.resolve(config.webDir);
  const indexPath = path.join(root, 'index.html');
  try {
    await fs.promises.access(indexPath, fs.constants.R_OK);
  } catch {
    return false;
  }
  let relative = pathname;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const candidate = path.resolve(root, `.${relative}`);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return false;
  let target = candidate;
  try {
    const stat = await fs.promises.stat(target);
    if (stat.isDirectory()) target = indexPath;
  } catch {
    // SPA fallback for extensionless routes and known frontend paths.
    if (path.extname(target)) return false;
    target = indexPath;
  }
  try {
    const data = await fs.promises.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(head ? undefined : data);
    return true;
  } catch {
    return false;
  }
}

/** Generate an OpenAPI 3.1 document from the live route table. */
export function openapiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const pattern = '/' + route.path.split('/').filter(Boolean)
      .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
      .join('/');
    const pathItem = (paths[pattern] ??= {});
    const params = route.path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => ({
      name: segment.slice(1),
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const operation: Record<string, unknown> = {
      summary: route.summary ?? `${route.method} ${pattern}`,
      operationId: `${route.method.toLowerCase()}_${route.path.replace(/[^A-Za-z0-9]+/g, '_')}`,
      responses: {
        '200': { description: 'Success envelope' },
        '401': { description: 'Unauthenticated' },
        '403': { description: 'Forbidden' },
        '500': { description: 'Internal error' },
      },
    };
    if (route.auth !== false) operation.security = [{ bearerAuth: [] }];
    if (params.length) operation.parameters = params;
    if (['POST', 'PUT', 'PATCH'].includes(route.method)) {
      operation.requestBody = {
        content: { 'application/json': { schema: { type: 'object' } } },
      };
    }
    pathItem[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'WrexrOS management API', version: coreVersion() },
    servers: [{ url: '/api/v1', description: 'WrexrOS daemon' }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        OkEnvelope: { type: 'object', required: ['ok', 'data'] },
        ErrorEnvelope: { type: 'object', required: ['ok', 'error'] },
      },
    },
  };
}

/** Build the request handler used by both HTTP and HTTPS servers. */
export function createRouter(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handleRequest(req, res): Promise<void> {
    if (applyCors(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = url.pathname;
    const isApiRequest = pathname.startsWith('/api/v1');
    if (pathname === '/api/v1/openapi.json') pathname = '/openapi.json';
    if (pathname.startsWith('/api/v1/')) pathname = pathname.slice('/api/v1'.length);
    else if (pathname === '/api/v1') pathname = '/';

    try {
      const segments = pathname.split('/').filter(Boolean);
      let matched: { route: Route; params: Record<string, string> } | null = null;
      for (const route of ROUTES_SORTED) {
        if (route.method !== req.method) continue;
        const pattern = route.path.split('/').filter(Boolean);
        if (pattern.length !== segments.length) continue;
        const params: Record<string, string> = {};
        let fits = true;
        for (let i = 0; i < pattern.length; i++) {
          const part = pattern[i] as string;
          if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[i] as string);
          else if (part !== segments[i]) {
            fits = false;
            break;
          }
        }
        if (fits) {
          matched = { route, params };
          break;
        }
      }

      if (!matched) {
        // Unknown API paths must stay JSON 404s; only browser routes fall back
        // to the SPA shell.
        if (!isApiRequest && (req.method === 'GET' || req.method === 'HEAD')) {
          if (await serveStatic(res, pathname, req.method === 'HEAD')) return;
        }
        send(res, 404, fail('NOT_FOUND', `No route for ${req.method} ${pathname}`));
        return;
      }

      const { route, params } = matched;
      let principal: Principal | null = null;
      if (route.auth !== false) {
        principal = authenticate(bearerToken(req, url));
        if (!principal) {
          send(res, 401, fail('UNAUTHENTICATED', 'Authentication required'));
          return;
        }
      }
      const permission = requiredPermission(route, params);
      if (permission && principal && !hasPermission(principal, permission)) {
        // requirePermission keeps one enforcement path for both router and services.
        try {
          requirePermission(principal, permission);
        } catch (error) {
          const err = error as ApiError;
          send(res, err.status, fail(err.code, err.message));
          return;
        }
      }

      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')
        ? await readBody(req)
        : {};
      const ctx: RouteContext = {
        req,
        res,
        params,
        query: parseQuery(url),
        body,
        principal,
        url,
      };

      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '');
      try {
        const data = await route.handler(ctx);
        if (mutating) {
          record(req, `${(req.method ?? '').toLowerCase()}:${route.path}`,
            String(params.id ?? params.name ?? route.path), 'success', {
              method: req.method,
              path: route.path,
              params,
            });
        }
        send(res, route.status ?? 200, ok(data === undefined ? null : data));
      } catch (error) {
        const err = error instanceof ApiError
          ? error
          : new ApiError('INTERNAL_ERROR', 'Internal server error', 500);
        if (!(error instanceof ApiError)) logger.error('Unhandled route error', {
          route: route.path, error: error instanceof Error ? error.stack : String(error),
        });
        if (mutating) {
          record(req, `${(req.method ?? '').toLowerCase()}:${route.path}`,
            String(params.id ?? params.name ?? route.path), 'failure', {
              method: req.method,
              path: route.path,
              code: err.code,
            });
        }
        send(res, err.status, fail(err.code, err.message, err.details));
      }
    } catch (error) {
      const err = error instanceof ApiError
        ? error
        : new ApiError('INTERNAL_ERROR', 'Internal server error', 500);
      if (!(error instanceof ApiError)) logger.error('Router error', {
        error: error instanceof Error ? error.stack : String(error),
      });
      send(res, err.status, fail(err.code, err.message, err.details));
    }
  };
}

export const handleRequest = createRouter();
