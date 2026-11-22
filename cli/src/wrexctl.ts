#!/usr/bin/env node
/** wrexctl - command-line client for the WrexrOS v1 API. No external dependencies. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  getConfigPath,
  loadConfig,
  saveConfig,
  updateConfig,
  type CliConfig,
} from './config.ts';
import {
  humanBytes,
  json as formatJson,
  paint,
  semverCompare,
  setColorEnabled,
  supportsColor,
  table,
} from './format.ts';
import { connect, type WSClient } from './ws-client.ts';

const CLI_VERSION = '0.1.3';
const DEFAULT_TIMEOUT_MS = 15000;
const SETTINGS_SECTIONS = new Set(['general', 'network', 'storage', 'access', 'updates', 'advanced', 'raw']);

export interface ApiErrorInfo {
  code: string;
  message: string;
  details?: unknown;
}

export class CliError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface Ctx {
  baseUrl: string;
  apiRoot: string;
  token: string;
  insecure: boolean;
  jsonOutput: boolean;
  configPath: string;
  timeoutMs: number;
}

interface GlobalFlags {
  url?: string;
  token?: string;
  config?: string;
  insecure?: boolean;
  json?: boolean;
  noColor?: boolean;
  help?: boolean;
  version?: boolean;
}

const BOOLEAN_FLAGS = new Set([
  'help', 'json', 'noColor', 'insecure', 'list', 'trusted', 'community', 'recycle',
  'readOnly', 'yes', 'follow', 'force', 'all', 'verify', 'wait', 'enabled', 'raw', 'detailed',
]);

function normalizeFlag(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function parseGlobals(argv: string[]): { globals: GlobalFlags; args: string[] } {
  const globals: GlobalFlags = {};
  const args: string[] = [];
  let commandSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--') {
      args.push(...argv.slice(i + 1));
      commandSeen = true;
      break;
    }
    if (commandSeen) {
      // --json/--no-color are convenient at the end; value flags belong to commands there.
      if (token === '--json') globals.json = true;
      else if (token === '--no-color') globals.noColor = true;
      else args.push(token);
      continue;
    }

    if (token === '--help' || token === '-h') { globals.help = true; continue; }
    if (token === '--version' || token === '-V') { globals.version = true; continue; }
    if (token === '--json') { globals.json = true; continue; }
    if (token === '--no-color') { globals.noColor = true; continue; }
    if (token === '--insecure') { globals.insecure = true; continue; }

    let matched = false;
    for (const name of ['url', 'token', 'config'] as const) {
      if (token === `--${name}`) {
        const value = argv[i + 1];
        if (value === undefined) throw new CliError('USAGE', `--${name} requires a value`);
        globals[name] = value;
        i += 1;
        matched = true;
        break;
      }
      if (token.startsWith(`--${name}=`)) {
        globals[name] = token.slice(name.length + 3);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    commandSeen = true;
    args.push(token);
  }
  return { globals, args };
}

/** Command-level flag parser; positionals stay in their original order. */
export class Args {
  readonly rest: string[] = [];
  readonly options = new Map<string, string | true>();

  constructor(tokens: string[]) {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token === '--') {
        this.rest.push(...tokens.slice(i + 1));
        break;
      }
      if (!token.startsWith('--')) {
        this.rest.push(token);
        continue;
      }
      const equals = token.indexOf('=');
      const rawName = equals > -1 ? token.slice(2, equals) : token.slice(2);
      const name = normalizeFlag(rawName);
      if (equals > -1) {
        this.options.set(name, token.slice(equals + 1));
      } else if (BOOLEAN_FLAGS.has(name)) {
        this.options.set(name, true);
      } else {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          this.options.set(name, next);
          i += 1;
        } else {
          this.options.set(name, true);
        }
      }
    }
  }

  shift(): string | undefined { return this.rest.shift(); }

  require(label: string): string {
    const value = this.shift();
    if (!value) throw new CliError('USAGE', `missing required ${label}`);
    return value;
  }

  raw(name: string): string | true | undefined { return this.options.get(normalizeFlag(name)); }

  has(name: string): boolean { return this.options.has(normalizeFlag(name)); }

  bool(name: string): boolean {
    const value = this.options.get(normalizeFlag(name));
    return value === true || value === 'true' || value === '1';
  }

  string(name: string): string | undefined {
    const value = this.raw(name);
    if (value === undefined) return undefined;
    if (value === true) throw new CliError('USAGE', `--${name} requires a value`);
    return value;
  }

  number(name: string): number | undefined {
    const value = this.string(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new CliError('USAGE', `--${name} must be a number`);
    return parsed;
  }

  json(name: string): unknown {
    const value = this.string(name);
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      throw new CliError('USAGE', `--${name} must be valid JSON`);
    }
  }

  /** Remaining positionals as an array. */
  remaining(): string[] { return [...this.rest]; }
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim().startsWith('[')) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new CliError('USAGE', 'expected a JSON array');
    return parsed.map(String);
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseEnv(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const parsed = parseJsonish(value);
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
  }
  const result: Record<string, string> = {};
  for (const pair of String(parsed).split(',')) {
    const index = pair.indexOf('=');
    if (index < 1) throw new CliError('USAGE', `--env entries must look like KEY=value`);
    result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return result;
}

function parseJsonish(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function setByPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.').filter(Boolean);
  if (parts.length === 0) throw new CliError('USAGE', '--key must not be empty');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/** Send an API request and unwrap the v1 envelope. */
export async function apiRequest(
  ctx: Ctx,
  method: string,
  endpoint: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-Id': crypto.randomUUID(),
    ...extraHeaders,
  };
  if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${ctx.apiRoot}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (error) {
    const err = error as Error & { name?: string };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CliError('TIMEOUT', `request timed out after ${ctx.timeoutMs}ms (${method} ${endpoint})`, undefined, undefined);
    }
    throw new CliError('NETWORK_ERROR', `cannot reach ${ctx.baseUrl}: ${err.message}`);
  }

  const text = await response.text();
  let envelope: unknown;
  try {
    envelope = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    throw new CliError('BAD_RESPONSE', `invalid JSON from ${method} ${endpoint}`, response.status);
  }
  const value = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {};
  if (value.ok === false || !response.ok) {
    const errorInfo = (value.error && typeof value.error === 'object' ? value.error : {}) as Record<string, unknown>;
    const code = typeof errorInfo.code === 'string' ? errorInfo.code : `HTTP_${response.status}`;
    const message = typeof errorInfo.message === 'string' ? errorInfo.message : `${method} ${endpoint} failed with HTTP ${response.status}`;
    throw new CliError(code, message, response.status, errorInfo.details);
  }
  return value.data;
}

function printLine(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function printError(error: unknown, jsonOutput = false): void {
  const err = error instanceof CliError
    ? error
    : new CliError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  if (jsonOutput) {
    printLine(formatJson({ ok: false, error: { code: err.code, message: err.message, details: err.details ?? {} } }));
  } else {
    process.stderr.write(`${paint('error:', 'red')} ${err.message}${err.code ? ` ${paint(`[${err.code}]`, 'dim')}` : ''}\n`);
  }
}

export function exitCodeFor(error: unknown): number {
  if (!(error instanceof CliError)) return 1;
  if (error.status === 401 || error.status === 403 || error.code === 'UNAUTHENTICATED') return 3;
  if (error.status === 404 || error.code === 'NOT_FOUND') return 4;
  if (error.status === 409 || error.code === 'CONFLICT') return 5;
  if (error.code === 'USAGE' || error.code === 'VALIDATION' || error.status === 400) return 2;
  if (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR') return 6;
  return 1;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /token|password|secret|privateKey/i.test(key) ? '***' : redact(item),
    ]));
  }
  return value;
}

function renderHuman(data: unknown): string {
  if (data === undefined || data === null) return 'ok';
  if (typeof data === 'string') return data;
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);
  if (Array.isArray(data)) {
    if (data.every((item) => typeof item !== 'object' || item === null)) return data.map(String).join('\n') || '(none)';
    return table(data as Array<Record<string, unknown>>);
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return 'ok';
  const sections: string[] = [];
  const arrayEntries = entries.filter(([, value]) => Array.isArray(value));
  const scalarEntries = entries.filter(([, value]) => !Array.isArray(value));
  for (const [key, value] of arrayEntries) {
    const items = value as unknown[];
    sections.push(`${paint(key.toUpperCase(), 'cyan')}\n${renderHuman(items)}`);
  }
  if (scalarEntries.length > 0) {
    const row = Object.fromEntries(scalarEntries.map(([key, value]) => [key, typeof value === 'number' && /bytes|size|used|total/i.test(key) ? humanBytes(value) : value]));
    sections.push(table([row]));
  }
  return sections.join('\n\n');
}

function show(ctx: Ctx, data: unknown, title?: string): void {
  if (ctx.jsonOutput) {
    printLine(formatJson(data ?? { ok: true }));
    return;
  }
  if (title) printLine(paint(`== ${title}`, 'bold'));
  printLine(renderHuman(redact(data)));
}

async function promptSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(label);
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: process.stdout });
    try {
      return await rl.question('');
    } finally {
      rl.close();
    }
  }

  const previousRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new CliError('INTERRUPTED', 'cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

function helpText(): string {
  return `${paint('wrexctl', 'bold')} ${CLI_VERSION} - WrexrOS command-line client

${paint('GLOBAL OPTIONS', 'bold')} (place before the command)
  --url URL          daemon base URL (default https://localhost:8443)
  --token TOKEN      bearer token (or WREXR_TOKEN)
  --insecure         allow invalid TLS certificates; use plain HTTP when WREXR_INSECURE_HTTP=1
  --json             machine-readable JSON output
  --no-color         disable ANSI colors
  --config PATH      config file (default ~/.config/wrexr/cli.json, honours XDG_CONFIG_HOME)
  --help, --version  show help/version

${paint('COMMANDS', 'bold')}
  status                             dashboard summary
  login --password [VALUE]           authenticate (prompts without echo if no value)
  whoami | logout                    identity / end session
  vm list|create|start|stop|reboot|delete|snapshot|vnc|firewall
  container list|create|start|stop|delete
  storage disks|array|start|stop|sync|datasets|snapshot|smart
  share list|create|delete|acl
  user list|create|delete | group list|create
  app catalog|installed|install|start|stop|upgrade|logs|repo add|repo sync
  settings get|set <section> [--file JSON] [--key K --value V]
  update check|install|status|apps
  audit | events | alert list|create | backup list|create|run
  plugin list|enable|disable | cluster list|add|remove
  shell                              interactive WebSocket terminal

${paint('EXAMPLES', 'bold')}
  wrexctl --json status
  wrexctl vm create --name web --type kvm --cpu 2 --memory 4096 --disk 40
  wrexctl app install --app nginx-proxy-manager --env 'KEY=value'
  wrexctl settings set network --key dns.servers --value '[\"1.1.1.1\"]'

Exit codes: 0 ok, 2 usage/validation, 3 auth, 4 not found, 5 conflict, 6 network, 1 other.`;
}

async function runVm(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('vm subcommand (list|create|start|stop|reboot|delete|snapshot|vnc|firewall)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/vms'), 'vms');
  if (sub === 'create') {
    const name = args.string('name') ?? args.require('VM name');
    const body: Record<string, unknown> = { name };
    for (const key of ['type', 'iso', 'template', 'network'] as const) {
      const value = args.string(key);
      if (value !== undefined) body[key] = value;
    }
    for (const key of ['cpu', 'memory', 'disk'] as const) {
      const value = args.number(key);
      if (value !== undefined) body[key] = value;
    }
    return show(ctx, await apiRequest(ctx, 'POST', '/vms', body), 'vm created');
  }
  const id = args.require('VM id');
  const encoded = encodeURIComponent(id);
  if (sub === 'start' || sub === 'stop' || sub === 'reboot') {
    return show(ctx, await apiRequest(ctx, 'POST', `/vms/${encoded}/${sub}`), `vm ${sub}`);
  }
  if (sub === 'delete') return show(ctx, await apiRequest(ctx, 'DELETE', `/vms/${encoded}`), 'vm deleted');
  if (sub === 'snapshot') {
    if (args.bool('list')) return show(ctx, await apiRequest(ctx, 'GET', `/vms/${encoded}/snapshots`), 'snapshots');
    const name = args.string('name');
    return show(ctx, await apiRequest(ctx, 'POST', `/vms/${encoded}/snapshot`, name ? { name } : {}), 'snapshot created');
  }
  if (sub === 'vnc') return show(ctx, await apiRequest(ctx, 'GET', `/vms/${encoded}/vnc`), 'vnc');
  if (sub === 'firewall') {
    if (args.has('rule')) {
      return show(ctx, await apiRequest(ctx, 'POST', `/vms/${encoded}/firewall`, args.json('rule')), 'firewall updated');
    }
    return show(ctx, await apiRequest(ctx, 'GET', `/vms/${encoded}/firewall`), 'firewall');
  }
  throw new CliError('USAGE', `unknown vm command: ${sub}`);
}

async function runContainer(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('container subcommand (list|create|start|stop|delete)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/apps/installed'), 'containers');
  if (sub === 'create') {
    const appId = args.string('app') ?? args.string('appId') ?? args.string('image') ?? args.require('app id');
    const body: Record<string, unknown> = { appId };
    const image = args.string('image');
    if (image) body.image = image;
    const name = args.string('name');
    if (name) body.name = name;
    const env = parseEnv(args.string('env'));
    if (env) body.env = env;
    const ports = args.json('ports');
    if (ports !== undefined) body.ports = ports;
    const volumes = args.json('volumes');
    if (volumes !== undefined) body.volumes = volumes;
    const limits = args.json('limits');
    if (limits !== undefined) body.limits = limits;
    return show(ctx, await apiRequest(ctx, 'POST', '/apps/install', body), 'container created');
  }
  const id = encodeURIComponent(args.require('container id'));
  if (sub === 'start' || sub === 'stop') {
    return show(ctx, await apiRequest(ctx, 'POST', `/apps/${id}/${sub}`), `container ${sub}`);
  }
  if (sub === 'delete') return show(ctx, await apiRequest(ctx, 'DELETE', `/apps/${id}`), 'container deleted');
  throw new CliError('USAGE', `unknown container command: ${sub}`);
}

async function runStorage(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('storage subcommand (disks|array|start|stop|sync|datasets|snapshot|smart)');
  if (sub === 'disks') return show(ctx, await apiRequest(ctx, 'GET', '/storage/disks'), 'disks');
  if (sub === 'array') {
    const action = args.string('action');
    if (action) return show(ctx, await apiRequest(ctx, 'POST', `/storage/array/${encodeURIComponent(action)}`), `array ${action}`);
    return show(ctx, await apiRequest(ctx, 'GET', '/storage/array'), 'array');
  }
  if (sub === 'start' || sub === 'stop' || sub === 'sync') {
    return show(ctx, await apiRequest(ctx, 'POST', `/storage/array/${sub}`), `array ${sub}`);
  }
  if (sub === 'datasets') {
    const deleteName = args.string('delete');
    if (deleteName) return show(ctx, await apiRequest(ctx, 'DELETE', `/storage/datasets/${encodeURIComponent(deleteName)}`), 'dataset deleted');
    const name = args.string('name');
    if (name) {
      const body: Record<string, unknown> = { name };
      for (const key of ['pool', 'compression', 'quota'] as const) {
        const value = args.string(key);
        if (value !== undefined) body[key] = value;
      }
      return show(ctx, await apiRequest(ctx, 'POST', '/storage/datasets', body), 'dataset created');
    }
    return show(ctx, await apiRequest(ctx, 'GET', '/storage/datasets'), 'datasets');
  }
  if (sub === 'snapshot') {
    const dataset = args.string('dataset');
    const name = args.string('name');
    if (dataset && name) {
      return show(ctx, await apiRequest(ctx, 'POST', '/storage/snapshots', { dataset, name }), 'snapshot created');
    }
    return show(ctx, await apiRequest(ctx, 'GET', '/storage/snapshots'), 'snapshots');
  }
  if (sub === 'smart') {
    const test = args.string('test');
    const disk = args.string('disk');
    if (test) return show(ctx, await apiRequest(ctx, 'POST', '/storage/smart', { test, disk }), 'smart test started');
    return show(ctx, await apiRequest(ctx, 'GET', '/storage/smart'), 'smart');
  }
  throw new CliError('USAGE', `unknown storage command: ${sub}`);
}

async function runShare(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('share subcommand (list|create|delete|acl)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/shares'), 'shares');
  if (sub === 'create') {
    const body: Record<string, unknown> = { name: args.string('name') ?? args.require('share name') };
    for (const key of ['path', 'disk', 'protocol', 'permissions'] as const) {
      const value = args.string(key);
      if (value !== undefined) body[key] = value;
    }
    const users = parseList(args.string('users'));
    if (users) body.users = users;
    if (args.has('recycle')) body.recycle = true;
    if (args.has('readOnly')) body.readOnly = true;
    return show(ctx, await apiRequest(ctx, 'POST', '/shares', body), 'share created');
  }
  const id = encodeURIComponent(args.require('share id'));
  if (sub === 'delete') return show(ctx, await apiRequest(ctx, 'DELETE', `/shares/${id}`), 'share deleted');
  if (sub === 'acl') {
    const rule = args.json('rule');
    const body = rule ?? {
      user: args.string('user'),
      permissions: args.string('permissions') ?? args.string('perm'),
    };
    return show(ctx, await apiRequest(ctx, 'POST', `/shares/${id}/acl`, body), 'acl updated');
  }
  throw new CliError('USAGE', `unknown share command: ${sub}`);
}

async function runUser(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('user subcommand (list|create|delete)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/users'), 'users');
  if (sub === 'create') {
    const name = args.string('name') ?? args.require('user name');
    let password = args.raw('password');
    if (password === undefined || password === true) password = await promptSecret(`Password for ${name}: `);
    if (typeof password !== 'string' || password.length === 0) throw new CliError('USAGE', 'a non-empty password is required');
    const body: Record<string, unknown> = { name, password };
    const groups = parseList(args.string('groups'));
    if (groups) body.groups = groups;
    return show(ctx, await apiRequest(ctx, 'POST', '/users', body), 'user created');
  }
  if (sub === 'delete') {
    return show(ctx, await apiRequest(ctx, 'DELETE', `/users/${encodeURIComponent(args.require('user id'))}`), 'user deleted');
  }
  throw new CliError('USAGE', `unknown user command: ${sub}`);
}

async function runGroup(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('group subcommand (list|create)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/groups'), 'groups');
  if (sub === 'create') {
    return show(ctx, await apiRequest(ctx, 'POST', '/groups', {
      name: args.string('name') ?? args.require('group name'),
      description: args.string('description'),
    }), 'group created');
  }
  throw new CliError('USAGE', `unknown group command: ${sub}`);
}

async function runApp(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('app subcommand (catalog|installed|install|start|stop|upgrade|logs|repo)');
  if (sub === 'catalog') return show(ctx, await apiRequest(ctx, 'GET', '/apps/catalog'), 'app catalog');
  if (sub === 'installed') return show(ctx, await apiRequest(ctx, 'GET', '/apps/installed'), 'installed apps');
  if (sub === 'install') {
    const appId = args.string('app') ?? args.string('appId') ?? args.require('app id');
    const body: Record<string, unknown> = { appId };
    const name = args.string('name');
    if (name) body.name = name;
    const env = parseEnv(args.string('env'));
    if (env) body.env = env;
    for (const key of ['ports', 'volumes', 'limits'] as const) {
      const value = args.json(key);
      if (value !== undefined) body[key] = value;
    }
    return show(ctx, await apiRequest(ctx, 'POST', '/apps/install', body), 'app installed');
  }
  if (sub === 'start' || sub === 'stop' || sub === 'upgrade') {
    const id = encodeURIComponent(args.require('app id'));
    return show(ctx, await apiRequest(ctx, 'POST', `/apps/${id}/${sub}`), `app ${sub}`);
  }
  if (sub === 'logs') {
    const id = encodeURIComponent(args.require('app id'));
    const tail = args.number('tail');
    const query = tail ? `?tail=${tail}` : '';
    const data = await apiRequest(ctx, 'GET', `/apps/${id}/logs${query}`) as { lines?: unknown };
    if (ctx.jsonOutput) return show(ctx, data);
    if (Array.isArray(data?.lines)) return printLine(data.lines.map(String).join('\n'));
    return show(ctx, data);
  }
  if (sub === 'repo') {
    const action = args.require('repo action (add|sync|list)');
    if (action === 'add') {
      return show(ctx, await apiRequest(ctx, 'POST', '/apps/repos', {
        url: args.string('url') ?? args.require('repo URL'),
        trusted: args.bool('trusted'),
      }), 'repo added');
    }
    if (action === 'sync') return show(ctx, await apiRequest(ctx, 'POST', '/apps/repos/sync'), 'repos synced');
    if (action === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/apps/repos'), 'repos');
    throw new CliError('USAGE', `unknown repo action: ${action}`);
  }
  throw new CliError('USAGE', `unknown app command: ${sub}`);
}

async function runSettings(ctx: Ctx, args: Args): Promise<void> {
  const action = args.require('settings action (get|set)');
  const section = args.require('settings section');
  if (!SETTINGS_SECTIONS.has(section)) {
    throw new CliError('USAGE', `unknown settings section: ${section} (expected ${[...SETTINGS_SECTIONS].join(', ')})`);
  }
  const endpoint = `/settings/${section}`;
  if (action === 'get') return show(ctx, await apiRequest(ctx, 'GET', endpoint), `settings ${section}`);
  if (action !== 'set') throw new CliError('USAGE', `unknown settings action: ${action}`);

  let body: Record<string, unknown>;
  const file = args.string('file');
  if (file !== undefined) {
    const source = file.trim().startsWith('{') ? file : fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CliError('USAGE', 'settings JSON must be an object');
    }
    body = parsed as Record<string, unknown>;
  } else {
    const key = args.string('key') ?? args.require('--key or --file');
    const rawValue = args.raw('value');
    if (rawValue === undefined) throw new CliError('USAGE', '--key requires --value');
    body = {};
    setByPath(body, key, typeof rawValue === 'string' ? parseJsonish(rawValue) : true);
  }
  return show(ctx, await apiRequest(ctx, 'PUT', endpoint, body), `settings ${section} updated`);
}

async function runUpdate(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('update subcommand (check|install|status|apps)');
  if (sub === 'check') return show(ctx, await apiRequest(ctx, 'GET', '/updates/check'), 'update check');
  if (sub === 'install') {
    const version = args.string('version') ?? args.shift();
    return show(ctx, await apiRequest(ctx, 'POST', '/updates/install', version ? { version } : {}), 'update started');
  }
  if (sub === 'status') return show(ctx, await apiRequest(ctx, 'GET', '/updates/status'), 'update status');
  if (sub === 'apps') return show(ctx, await apiRequest(ctx, 'GET', '/updates/app'), 'app updates');
  throw new CliError('USAGE', `unknown update command: ${sub}`);
}

async function runAlert(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('alert subcommand (list|create)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/alerts'), 'alerts');
  if (sub === 'create') {
    const body: Record<string, unknown> = {};
    for (const key of ['type', 'target', 'threshold'] as const) {
      const value = args.string(key);
      if (value !== undefined) body[key] = parseJsonish(value);
    }
    body.enabled = args.bool('enabled') || args.string('enabled') !== 'false';
    return show(ctx, await apiRequest(ctx, 'POST', '/alerts', body), 'alert created');
  }
  throw new CliError('USAGE', `unknown alert command: ${sub}`);
}

async function runBackup(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('backup subcommand (list|create|run)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/backups'), 'backups');
  if (sub === 'create') {
    const body: Record<string, unknown> = {};
    for (const key of ['name', 'target', 'schedule', 'retention'] as const) {
      const value = args.string(key);
      if (value !== undefined) body[key] = parseJsonish(value);
    }
    return show(ctx, await apiRequest(ctx, 'POST', '/backups', body), 'backup created');
  }
  if (sub === 'run') {
    return show(ctx, await apiRequest(ctx, 'POST', `/backups/${encodeURIComponent(args.require('backup id'))}/run`), 'backup started');
  }
  throw new CliError('USAGE', `unknown backup command: ${sub}`);
}

async function runPlugin(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('plugin subcommand (list|enable|disable)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/plugins'), 'plugins');
  if (sub === 'enable' || sub === 'disable') {
    const id = encodeURIComponent(args.require('plugin id'));
    return show(ctx, await apiRequest(ctx, 'POST', `/plugins/${id}/${sub}`), `plugin ${sub}`);
  }
  throw new CliError('USAGE', `unknown plugin command: ${sub}`);
}

async function runCluster(ctx: Ctx, args: Args): Promise<void> {
  const sub = args.require('cluster subcommand (list|add|remove)');
  if (sub === 'list') return show(ctx, await apiRequest(ctx, 'GET', '/cluster/nodes'), 'cluster nodes');
  if (sub === 'add') {
    const body: Record<string, unknown> = {};
    for (const key of ['name', 'address', 'url', 'token'] as const) {
      const value = args.string(key);
      if (value !== undefined) body[key] = value;
    }
    if (Object.keys(body).length === 0) throw new CliError('USAGE', 'cluster add needs --name and --address/--url');
    return show(ctx, await apiRequest(ctx, 'POST', '/cluster/nodes', body), 'node added');
  }
  if (sub === 'remove') {
    return show(ctx, await apiRequest(ctx, 'DELETE', `/cluster/nodes/${encodeURIComponent(args.require('node id'))}`), 'node removed');
  }
  throw new CliError('USAGE', `unknown cluster command: ${sub}`);
}

async function runShell(ctx: Ctx, args: Args): Promise<void> {
  const target = ctx.apiRoot.replace(/^http/, 'ws') + '/ws/terminal';
  const headers: Record<string, string> = {};
  if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;

  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw ?? false : false;
  let client: WSClient | undefined;
  let closedByUs = false;

  const restore = (): void => {
    stdin.off('data', onInput);
    process.stdout.off('resize', sendResize);
    if (stdin.isTTY) {
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }
  };
  const sendResize = (): void => {
    try {
      client?.send(JSON.stringify({
        type: 'resize',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      }));
    } catch {
      // Connection may be closing.
    }
  };
  const onInput = (chunk: string | Buffer): void => {
    const text = chunk.toString('utf8');
    if (text === '\u0004') {
      closedByUs = true;
      client?.close(1000, 'client exit');
      return;
    }
    try {
      client?.send(JSON.stringify({ type: 'input', data: text }));
    } catch (error) {
      printError(error, ctx.jsonOutput);
    }
  };

  await new Promise<void>((resolve) => {
    client = connect(
      target,
      headers,
      (data) => process.stdout.write(typeof data === 'string' ? data : data.toString('utf8')),
      (code, reason) => {
        restore();
        if (!closedByUs && (code !== 1000 || reason)) {
          process.stderr.write(`terminal closed (${code})${reason ? `: ${reason}` : ''}\n`);
        }
        resolve();
      },
      {
        insecure: ctx.insecure,
        handshakeTimeoutMs: ctx.timeoutMs,
        onOpen: () => {
          if (stdin.isTTY) {
            stdin.setRawMode(true);
            stdin.resume();
            stdin.setEncoding('utf8');
          }
          stdin.on('data', onInput);
          process.stdout.on('resize', sendResize);
          sendResize();
        },
      },
      (error) => {
        process.stderr.write(`terminal: ${error.message}\n`);
        restore();
        resolve();
      },
    );
    if (stdin.isTTY) stdin.resume();
  });
}

async function dispatch(ctx: Ctx, args: Args): Promise<void> {
  const command = args.shift();
  if (!command || command === 'help') {
    printLine(helpText());
    return;
  }
  switch (command) {
    case 'status': return show(ctx, await apiRequest(ctx, 'GET', '/dashboard'), 'status');
    case 'login': {
      const raw = args.raw('password');
      let password = typeof raw === 'string' ? raw : await promptSecret('Password: ');
      if (password.length === 0) throw new CliError('USAGE', 'password must not be empty');
      const body: Record<string, unknown> = { password };
      password = '';
      const totp = args.string('totp');
      if (totp) body.totp = totp;
      const data = await apiRequest(ctx, 'POST', '/auth/login', body) as Record<string, unknown>;
      const token = typeof data?.token === 'string' ? data.token : '';
      if (!token) throw new CliError('BAD_RESPONSE', 'login response did not contain a token');
      saveConfig(ctx.configPath, { url: ctx.baseUrl, token, allowInsecure: ctx.insecure });
      ctx.token = token;
      return show(ctx, data, 'logged in');
    }
    case 'whoami': return show(ctx, await apiRequest(ctx, 'GET', '/auth/me'), 'whoami');
    case 'logout': {
      await apiRequest(ctx, 'POST', '/auth/logout');
      updateConfig(ctx.configPath, { token: '' });
      return show(ctx, { ok: true }, 'logged out');
    }
    case 'vm': return runVm(ctx, args);
    case 'container': return runContainer(ctx, args);
    case 'storage': return runStorage(ctx, args);
    case 'share': return runShare(ctx, args);
    case 'user': return runUser(ctx, args);
    case 'group': return runGroup(ctx, args);
    case 'app': return runApp(ctx, args);
    case 'settings': return runSettings(ctx, args);
    case 'update': return runUpdate(ctx, args);
    case 'audit': return show(ctx, await apiRequest(ctx, 'GET', '/audit'), 'audit');
    case 'events': return show(ctx, await apiRequest(ctx, 'GET', '/events'), 'events');
    case 'alert': return runAlert(ctx, args);
    case 'backup': return runBackup(ctx, args);
    case 'plugin': return runPlugin(ctx, args);
    case 'cluster': return runCluster(ctx, args);
    case 'shell': return runShell(ctx, args);
    default: throw new CliError('USAGE', `unknown command: ${command} (try --help)`);
  }
}

function makeCtx(globals: GlobalFlags): Ctx {
  const configPath = globals.config ?? getConfigPath();
  const config: CliConfig = loadConfig(configPath);
  const insecure = globals.insecure === true || config.allowInsecure || process.env.WREXR_INSECURE_HTTP === '1';
  const baseUrl = (globals.url ?? process.env.WREXR_URL ?? config.url).replace(/\/+$/, '');
  const token = globals.token ?? (process.env.WREXR_TOKEN && process.env.WREXR_TOKEN.length > 0 ? process.env.WREXR_TOKEN : config.token);
  const timeoutMs = Number(process.env.WREXR_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CliError('USAGE', 'WREXR_TIMEOUT_MS must be a positive number');
  if (!/^https?:\/\//i.test(baseUrl)) throw new CliError('USAGE', '--url must start with http:// or https://');

  if (insecure && baseUrl.startsWith('https://') && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.stderr.write('warning: TLS certificate verification disabled (--insecure)\n');
  }
  return {
    baseUrl,
    apiRoot: baseUrl.endsWith('/api/v1') ? baseUrl : `${baseUrl}/api/v1`,
    token,
    insecure,
    jsonOutput: globals.json === true || process.env.WREXR_JSON === '1',
    configPath,
    timeoutMs,
  };
}

/** Main entry point, guarded so tests can import helpers safely. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { globals, args } = parseGlobals(argv);
  setColorEnabled(globals.noColor ? false : supportsColor());
  if (globals.help || args.includes('--help') || args.includes('-h')) {
    printLine(helpText());
    return 0;
  }
  if (globals.version) {
    printLine(CLI_VERSION);
    return 0;
  }
  const ctx = makeCtx(globals);
  if (args.some((item) => item === '--json')) ctx.jsonOutput = true;
  await dispatch(ctx, new Args(args));
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  const normalize = (value: string): string => {
    let resolved = value;
    try { resolved = fs.realpathSync(value); } catch { /* use as given */ }
    const absolute = path.resolve(resolved);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return normalize(entry) === normalize(here);
}

if (isMainModule()) {
  main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      let jsonOutput = false;
      try { jsonOutput = process.argv.slice(2).includes('--json'); } catch { /* ignore */ }
      printError(error, jsonOutput);
      process.exitCode = exitCodeFor(error);
    },
  );
}

export { ConfigError, getConfigPath, semverCompare };
