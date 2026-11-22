/**
 * WrexrOS configuration.
 *
 * Everything is configurable through WREXR_* environment variables. Startup
 * values may also live in the file named by WREXR_CONFIG (the installer writes
 * /etc/wrexr/wrexrd.toml); legacy <stateDir>/config.json is read as a fallback.
 * Precedence is: explicit argument > environment > WREXR_CONFIG > config.json.
 * This module deliberately has no dependencies on other project modules so it
 * can be imported by the logger and the database layer without creating cycles.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  stateDir: string;
  dbPath: string;
  tlsCert: string;
  tlsKey: string;
  demoMode: boolean;
  channel: string;
  insecureHttp: boolean;
  hostname: string;
  timezone: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  cors: boolean;
  terminalEnabled: boolean;
  sessionTtlMs: number;
  updateRepo: string;
  templatePublicKey: string;
  pluginPublicKey: string;
  /** Absolute paths derived from this file's location, never from cwd. */
  webDir: string;
  catalogPath: string;
  versionPath: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePort(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.wrexr-write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function firstIp(): string {
  const entries = Object.values(os.networkInterfaces());
  for (const list of entries) {
    for (const ni of list ?? []) {
      if (!ni.internal && ni.family === 'IPv4' && ni.address) return ni.address;
    }
  }
  return '127.0.0.1';
}

function parseScalar(value: string): unknown {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  const numeric = Number(text);
  return text !== '' && Number.isFinite(numeric) ? numeric : text;
}

/** Minimal TOML reader for the installer-generated startup config (no comments inside quotes). */
function readTomlConfig(file: string | undefined): Record<string, unknown> {
  if (!file) return {};
  try {
    const out: Record<string, unknown> = {};
    let section = '';
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      let clean = '';
      let quote: string | null = null;
      for (const ch of line) {
        if (quote) {
          clean += ch;
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          clean += ch;
          continue;
        }
        if (ch === '#') break;
        clean += ch;
      }
      const trimmed = clean.trim();
      if (!trimmed) continue;
      const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
      if (sectionMatch) {
        section = sectionMatch[1].trim();
        continue;
      }
      const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(trimmed);
      if (pair) out[section ? `${section}.${pair[1]}` : pair[1]] = parseScalar(pair[2]);
    }
    return out;
  } catch {
    return {};
  }
}

/** Map installer TOML names onto Config keys. */
function mapTomlConfig(toml: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toml)) {
    switch (key) {
      case 'port':
        if (typeof value === 'string' || typeof value === 'number') out.port = value;
        break;
      case 'stateDir':
        if (typeof value === 'string') out.stateDir = value;
        break;
      case 'demoMode':
        if (typeof value === 'boolean') out.demoMode = value;
        break;
      case 'updateChannel':
        if (typeof value === 'string') out.channel = value;
        break;
      case 'repoUrl':
        if (typeof value === 'string') out.updateRepo = value;
        break;
      case 'tls':
        if (typeof value === 'boolean') out.insecureHttp = !value;
        break;
      case 'tlsCert':
        if (typeof value === 'string') out.tlsCert = value;
        break;
      case 'tlsKey':
        if (typeof value === 'string') out.tlsKey = value;
        break;
      case 'log.level':
        if (typeof value === 'string') out.logLevel = value;
        break;
    }
  }
  return out;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  // src/config.ts -> core/
  const coreDir = path.resolve(srcDir, '..');

  const tomlConfig = mapTomlConfig(readTomlConfig(process.env.WREXR_CONFIG));
  const tomlStateDir = typeof tomlConfig.stateDir === 'string' ? tomlConfig.stateDir : undefined;
  const requestedStateDir =
    process.env.WREXR_STATE_DIR || tomlStateDir || '/var/lib/wrexr';
  const stateDir = overrides.stateDir
    ? path.resolve(overrides.stateDir)
    : isWritable(path.resolve(requestedStateDir))
      ? path.resolve(requestedStateDir)
      : path.join(os.tmpdir(), 'wrexr');

  // Legacy JSON config is a fallback; WREXR_CONFIG takes precedence over it.
  let jsonConfig: Record<string, unknown> = {};
  try {
    const file = path.join(stateDir, 'config.json');
    if (fs.existsSync(file)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        jsonConfig = parsed as Record<string, unknown>;
      }
    }
  } catch {
    /* A broken config file must never prevent first boot. */
  }
  const fileConfig = { ...jsonConfig, ...tomlConfig };

  const pickBool = (envName: string, key: string, fallback: boolean): boolean => {
    if (process.env[envName] !== undefined) return parseBool(process.env[envName], fallback);
    const fromFile = fileConfig[key];
    if (typeof fromFile === 'boolean') return fromFile;
    if (typeof fromFile === 'string' || typeof fromFile === 'number') {
      return parseBool(String(fromFile), fallback);
    }
    return fallback;
  };

  const pick = (envName: string, key: string, fallback: string): string => {
    if (process.env[envName] !== undefined) return process.env[envName] as string;
    const fromFile = fileConfig[key];
    return typeof fromFile === 'string' || typeof fromFile === 'number'
      ? String(fromFile)
      : fallback;
  };

  const demoMode = overrides.demoMode ?? pickBool('WREXR_DEMO_MODE', 'demoMode', false);
  const insecureHttp =
    overrides.insecureHttp ?? pickBool('WREXR_INSECURE_HTTP', 'insecureHttp', false);
  const port = overrides.port ?? parsePort(pick('WREXR_PORT', 'port', '8443'), 8443);
  const host = overrides.host ?? pick('WREXR_HOST', 'host', '0.0.0.0');
  const tlsCert = path.resolve(
    overrides.tlsCert ?? pick('WREXR_TLS_CERT', 'tlsCert', path.join(stateDir, 'tls', 'cert.pem')),
  );
  const tlsKey = path.resolve(
    overrides.tlsKey ?? pick('WREXR_TLS_KEY', 'tlsKey', path.join(stateDir, 'tls', 'key.pem')),
  );
  const logLevelRaw = pick('WREXR_LOG_LEVEL', 'logLevel', 'info').toLowerCase();
  const logLevel = (['debug', 'info', 'warn', 'error'].includes(logLevelRaw)
    ? logLevelRaw
    : 'info') as Config['logLevel'];

  return {
    port,
    host,
    stateDir,
    dbPath: path.resolve(stateDir, 'wrexr.db'),
    tlsCert,
    tlsKey,
    demoMode,
    channel: overrides.channel ?? pick('WREXR_CHANNEL', 'channel', 'stable'),
    insecureHttp,
    hostname:
      overrides.hostname ?? pick('WREXR_HOSTNAME', 'hostname', os.hostname() || 'wrexr'),
    timezone: overrides.timezone ?? pick('WREXR_TIMEZONE', 'timezone', 'UTC'),
    logLevel,
    cors: overrides.cors ?? parseBool(process.env.WREXR_CORS, demoMode),
    terminalEnabled:
      overrides.terminalEnabled ?? parseBool(process.env.WREXR_TERMINAL_ENABLED, false),
    sessionTtlMs:
      overrides.sessionTtlMs ??
      parsePort(process.env.WREXR_SESSION_TTL_HOURS, 24) * 60 * 60 * 1000,
    updateRepo:
      overrides.updateRepo ??
      pick(
        'WREXR_UPDATE_REPO',
        'updateRepo',
        'https://github.com/nikolajalbrechtsen/WrexrOS',
      ),
    templatePublicKey:
      overrides.templatePublicKey ?? pick('WREXR_TEMPLATE_PUBLIC_KEY', 'templatePublicKey', ''),
    pluginPublicKey:
      overrides.pluginPublicKey ?? pick('WREXR_PLUGIN_PUBLIC_KEY', 'pluginPublicKey', ''),
    // The SPA and catalog are repository-root projects; fall back to core-local
    // copies so the daemon also runs when core/ is extracted on its own.
    webDir: fs.existsSync(path.resolve(coreDir, '..', 'web', 'dist'))
      ? path.resolve(coreDir, '..', 'web', 'dist')
      : path.resolve(coreDir, 'web', 'dist'),
    catalogPath: fs.existsSync(path.resolve(coreDir, '..', 'catalog', 'index.json'))
      ? path.resolve(coreDir, '..', 'catalog', 'index.json')
      : path.resolve(coreDir, 'catalog', 'index.json'),
    versionPath: fs.existsSync(path.resolve(coreDir, '..', 'VERSION'))
      ? path.resolve(coreDir, '..', 'VERSION')
      : path.resolve(coreDir, 'VERSION'),
  };
}

/** Shared process-wide configuration. Tests use loadConfig() for isolated copies. */
export const config: Config = loadConfig();

/** The LAN IP advertised in the startup banner. */
export function lanIp(): string {
  return firstIp();
}
