/** Configuration storage for wrexctl (XDG-compatible, POSIX and Windows safe). */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CliConfig {
  url: string;
  token: string;
  allowInsecure: boolean;
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const insecureDev = env.WREXR_INSECURE_HTTP === '1';
  return {
    url: insecureDev ? 'http://localhost:8443' : 'https://localhost:8443',
    token: '',
    allowInsecure: insecureDev,
  };
}

/** ~/.config/wrexr/cli.json, or $XDG_CONFIG_HOME/wrexr/cli.json. */
export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'wrexr', 'cli.json');
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Read a config file; a missing file is not an error. */
export function loadConfig(configPath: string, env: NodeJS.ProcessEnv = process.env): CliConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig(env);
    throw new ConfigError(`cannot read config ${configPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`invalid JSON in config ${configPath}: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`config ${configPath} must contain a JSON object`);
  }

  const value = parsed as Record<string, unknown>;
  const defaults = defaultConfig(env);
  return {
    url: typeof value.url === 'string' && value.url.length > 0 ? value.url : defaults.url,
    token: typeof value.token === 'string' ? value.token : '',
    allowInsecure: typeof value.allowInsecure === 'boolean' ? value.allowInsecure : defaults.allowInsecure,
  };
}

/** Atomically write the config and restrict it to the current user (0600). */
export function saveConfig(configPath: string, config: CliConfig): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    // Windows does not implement POSIX mode bits; ignore.
  }
  fs.renameSync(temporary, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // See above.
  }
}

/** Persist only the given changes. */
export function updateConfig(
  configPath: string,
  changes: Partial<CliConfig>,
  env: NodeJS.ProcessEnv = process.env,
): CliConfig {
  const next = { ...loadConfig(configPath, env), ...changes };
  saveConfig(configPath, next);
  return next;
}
