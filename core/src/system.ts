/**
 * Host information, metric sampling, command execution and TLS bootstrap.
 *
 * External commands are executed with execFile and argument arrays only. The
 * command name must be in a strict allowlist; no shell is ever involved.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, lanIp, type Config } from './config.ts';
import { logger } from './logger.ts';
import { addMetric, getMetrics, pruneMetrics } from './db.ts';

const execFileAsync = promisify(execFile);

export const COMMAND_ALLOWLIST = new Set([
  'df', 'ip', 'lspci', 'smartctl', 'virsh', 'lxc', 'docker',
  'systemctl', 'zfs', 'zpool', 'openssl', 'uname', 'hostname',
]);

const LINUX_ONLY = new Set(['ip', 'lspci', 'systemctl', 'zfs', 'zpool', 'virsh', 'lxc']);
const availability = new Map<string, boolean>();

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runCommand(
  command: string,
  args: string[] = [],
  timeoutMs = 5000,
): Promise<CommandResult> {
  if (!COMMAND_ALLOWLIST.has(command)) {
    throw new Error(`Command '${command}' is not in the WrexrOS allowlist`);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Command arguments must be an array of strings without NUL bytes');
  }
  if (process.platform === 'win32' && LINUX_ONLY.has(command)) {
    return { stdout: '', stderr: 'command unavailable on Windows', code: 127 };
  }
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (error: any) {
    return {
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? String(error)),
      code: typeof error?.code === 'number' ? error.code : 1,
    };
  }
}

export async function commandAvailable(command: string): Promise<boolean> {
  if (!COMMAND_ALLOWLIST.has(command)) return false;
  if (availability.has(command)) return availability.get(command) as boolean;
  if (process.platform === 'win32' && LINUX_ONLY.has(command)) {
    availability.set(command, false);
    return false;
  }
  const probe = await runCommand(command, ['--version'], 3000);
  const ok = probe.code === 0 || /version|usage|invalid/i.test(probe.stderr);
  availability.set(command, ok);
  return ok;
}

/** Read the VERSION file next to src/; fall back when it is missing. */
export function coreVersion(cfg: Config = config): string {
  try {
    const text = fs.readFileSync(cfg.versionPath, 'utf8').trim();
    return text || '0.1.4';
  } catch {
    return '0.1.4';
  }
}

export interface NetworkInterface {
  name: string;
  mac: string;
  addresses: Array<{ family: string; address: string; netmask: string }>;
  internal: boolean;
  state: string;
}

export function networkInterfaces(): NetworkInterface[] {
  const groups = os.networkInterfaces();
  return Object.entries(groups).map(([name, entries]) => ({
    name,
    mac: entries?.[0]?.mac || '',
    internal: !!entries?.[0]?.internal,
    state: entries?.[0]?.internal ? 'loopback' : 'up',
    addresses: (entries ?? []).map((entry) => ({
      family: entry.family,
      address: entry.address,
      netmask: entry.netmask,
    })),
  }));
}

/** Enrich os.networkInterfaces() with `ip -j addr` on real Linux hosts. */
export async function detailedNetworkInterfaces(): Promise<NetworkInterface[]> {
  const base = networkInterfaces();
  if (config.demoMode || process.platform !== 'linux') return base;
  if (!(await commandAvailable('ip'))) return base;
  try {
    const result = await runCommand('ip', ['-j', 'addr']);
    if (result.code !== 0) return base;
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return base;
    for (const link of parsed as Array<Record<string, any>>) {
      if (typeof link.ifname !== 'string') continue;
      const match = base.find((item) => item.name === link.ifname);
      if (match) {
        match.state = typeof link.operstate === 'string' ? link.operstate : match.state;
      } else {
        base.push({
          name: link.ifname,
          mac: typeof link.address === 'string' ? link.address : '',
          internal: link.operstate === 'LOOPBACK',
          state: typeof link.operstate === 'string' ? link.operstate : 'unknown',
          addresses: Array.isArray(link.addr_info)
            ? link.addr_info.map((a: Record<string, unknown>) => ({
                family: String(a.family ?? 'IPv4'),
                address: String(a.local ?? ''),
                netmask: String(a.prefixlen ?? ''),
              }))
            : [],
        });
      }
    }
  } catch {
    /* ip output is best-effort */
  }
  return base;
}

export interface HostInfo {
  hostname: string;
  platform: string;
  arch: string;
  kernel: string;
  uptime: number;
  cpuModel: string;
  cores: number;
  ip: string;
  version: string;
  channel: string;
  demo: boolean;
}

export function hostInfo(cfg: Config = config): HostInfo {
  const cpus = os.cpus();
  return {
    hostname: cfg.hostname || os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    kernel: os.release(),
    uptime: os.uptime(),
    cpuModel: cpus[0]?.model || 'WrexrOS virtual CPU',
    cores: cpus.length || 4,
    ip: lanIp(),
    version: coreVersion(cfg),
    channel: cfg.channel,
    demo: cfg.demoMode,
  };
}

export interface SystemMetrics {
  cpu: { usage: number; cores: number; load: number[]; model: string };
  ram: { used: number; total: number; free: number; percent: number };
  disk: { used: number; total: number; free: number; percent: number; read: number; write: number };
  network: { rx: number; tx: number; interfaces: NetworkInterface[] };
  time: number;
}

let previousCpu: { idle: number; total: number } | null = null;
let previousNet: { rx: number; tx: number; time: number } | null = null;

function demoMetrics(): SystemMetrics {
  const t = Date.now() / 1000;
  const wave = Math.sin(t / 18);
  const total = 16 * 1024 ** 3;
  const ramUsed = Math.round(total * (0.55 + wave * 0.06));
  const diskTotal = 32 * 1000 ** 4;
  const diskUsed = Math.round(diskTotal * 0.42);
  return {
    cpu: {
      usage: Math.round(28 + wave * 14 + Math.sin(t / 5) * 4),
      cores: os.cpus().length || 4,
      load: [0.8, 0.6, 0.4].map((v) => Number((v + wave * 0.2).toFixed(2))),
      model: os.cpus()[0]?.model || 'WrexrOS virtual CPU',
    },
    ram: { used: ramUsed, total, free: total - ramUsed, percent: Math.round((ramUsed / total) * 100) },
    disk: {
      used: diskUsed,
      total: diskTotal,
      free: diskTotal - diskUsed,
      percent: Math.round((diskUsed / diskTotal) * 100),
      read: Math.round(2_400_000 + wave * 800_000),
      write: Math.round(1_100_000 + wave * 400_000),
    },
    network: {
      rx: Math.round(1_200_000 + wave * 500_000),
      tx: Math.round(560_000 + wave * 220_000),
      interfaces: networkInterfaces(),
    },
    time: Date.now(),
  };
}

function statfs(pathname: string) {
  try {
    return fs.statfsSync(pathname);
  } catch {
    return null;
  }
}

function procNetCounters(): { rx: number; tx: number } | null {
  if (process.platform !== 'linux') return null;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      rx += Number(parts[1]) || 0;
      tx += Number(parts[9]) || 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

export async function systemMetrics(cfg: Config = config): Promise<SystemMetrics> {
  if (cfg.demoMode) return demoMetrics();

  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const [key, value] of Object.entries(cpu.times)) {
      total += value;
      if (key === 'idle') idle += value;
    }
  }
  let usage = 0;
  if (previousCpu) {
    const deltaTotal = total - previousCpu.total;
    const deltaIdle = idle - previousCpu.idle;
    usage = deltaTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 100))) : 0;
  }
  previousCpu = { idle, total };

  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const fsInfo = statfs(cfg.stateDir);
  const diskTotal = fsInfo ? Number(fsInfo.blocks) * Number(fsInfo.bsize) : 1;
  const diskFree = fsInfo ? Number(fsInfo.bavail) * Number(fsInfo.bsize) : 0;
  const diskUsed = Math.max(0, diskTotal - diskFree);

  const counters = procNetCounters();
  let rx = 0;
  let tx = 0;
  if (counters) {
    const time = Date.now();
    if (previousNet) {
      const seconds = Math.max(1, (time - previousNet.time) / 1000);
      rx = Math.max(0, Math.round((counters.rx - previousNet.rx) / seconds));
      tx = Math.max(0, Math.round((counters.tx - previousNet.tx) / seconds));
    }
    previousNet = { ...counters, time };
  }

  return {
    cpu: {
      usage,
      cores: cpus.length || 1,
      load: os.loadavg().map((v) => Number(v.toFixed(2))),
      model: cpus[0]?.model || 'unknown',
    },
    ram: {
      used: totalRam - freeRam,
      total: totalRam,
      free: freeRam,
      percent: totalRam > 0 ? Math.round(((totalRam - freeRam) / totalRam) * 100) : 0,
    },
    disk: {
      used: diskUsed,
      total: diskTotal,
      free: diskFree,
      percent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0,
      read: 0,
      write: 0,
    },
    network: { rx, tx, interfaces: networkInterfaces() },
    time: Date.now(),
  };
}

/** Take one sample and store it for the history graphs. */
export async function sampleMetrics(cfg: Config = config): Promise<SystemMetrics> {
  const metrics = await systemMetrics(cfg);
  addMetric('sample', {
    cpu: metrics.cpu.usage,
    ram: { used: metrics.ram.used, total: metrics.ram.total, percent: metrics.ram.percent },
    network: { rx: metrics.network.rx, tx: metrics.network.tx },
    disk: { used: metrics.disk.used, total: metrics.disk.total, percent: metrics.disk.percent },
  });
  pruneMetrics();
  return metrics;
}

export function metricsHistory(limit = 120): {
  cpu: Array<{ time: number; value: number }>;
  ram: Array<{ time: number; used: number; total: number; percent: number }>;
  network: Array<{ time: number; rx: number; tx: number }>;
} {
  const rows = getMetrics('sample', limit);
  return {
    cpu: rows.map((row) => ({ time: Number(row.time), value: Number(row.cpu ?? 0) })),
    ram: rows.map((row) => ({
      time: Number(row.time),
      used: Number((row.ram as Record<string, unknown> | undefined)?.used ?? 0),
      total: Number((row.ram as Record<string, unknown> | undefined)?.total ?? 0),
      percent: Number((row.ram as Record<string, unknown> | undefined)?.percent ?? 0),
    })),
    network: rows.map((row) => ({
      time: Number(row.time),
      rx: Number((row.network as Record<string, unknown> | undefined)?.rx ?? 0),
      tx: Number((row.network as Record<string, unknown> | undefined)?.tx ?? 0),
    })),
  };
}

export interface TlsPaths {
  cert: string;
  key: string;
}

/** Generate a self-signed certificate with openssl when one is missing. */
export async function ensureTls(cfg: Config = config): Promise<TlsPaths | null> {
  if (cfg.insecureHttp) return null;
  try {
    if (fs.existsSync(cfg.tlsCert) && fs.existsSync(cfg.tlsKey)) {
      return { cert: cfg.tlsCert, key: cfg.tlsKey };
    }
    if (!(await commandAvailable('openssl'))) {
      logger.warn('openssl unavailable: falling back to plain HTTP');
      return null;
    }
    fs.mkdirSync(path.dirname(cfg.tlsCert), { recursive: true });
    fs.mkdirSync(path.dirname(cfg.tlsKey), { recursive: true });
    const hostname = /^[A-Za-z0-9_.-]+$/.test(cfg.hostname) ? cfg.hostname : 'wrexr';
    const ip = lanIp();
    const result = await runCommand('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', cfg.tlsKey,
      '-out', cfg.tlsCert,
      '-days', '3650',
      '-subj', '/CN=WrexrOS',
      '-addext', `subjectAltName=DNS:${hostname},DNS:localhost,IP:${ip}`,
    ]);
    if (result.code !== 0 || !fs.existsSync(cfg.tlsCert) || !fs.existsSync(cfg.tlsKey)) {
      logger.warn('openssl could not create TLS certificate', { stderr: result.stderr });
      return null;
    }
    logger.info('Generated self-signed TLS certificate', { cert: cfg.tlsCert, ip });
    return { cert: cfg.tlsCert, key: cfg.tlsKey };
  } catch (error) {
    logger.warn('TLS setup failed, using plain HTTP', { error: String(error) });
    return null;
  }
}

/** PCI inventory: use lspci on real Linux hosts, otherwise realistic demo data. */
export async function pciDevices(): Promise<Array<Record<string, unknown>>> {
  if (!config.demoMode && (await commandAvailable('lspci'))) {
    const result = await runCommand('lspci', ['-nn']);
    if (result.code === 0) {
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line, index) => ({
          id: line.split(' ')[0] || `pci-${index}`,
          vendor: line.replace(/^[^ ]+ /, ''),
          device: line,
          iommuGroup: index,
          usable: true,
        }));
    }
  }
  return [
    { id: '0000:01:00.0', vendor: 'NVIDIA Corporation', device: 'GA106 [GeForce RTX 3060]', iommuGroup: 12, usable: true },
    { id: '0000:02:00.0', vendor: 'Intel Corporation', device: 'I225-V 2.5GbE', iommuGroup: 18, usable: true },
    { id: '0000:03:00.0', vendor: 'LSI Logic', device: 'MegaRAID SAS-3 3108', iommuGroup: 24, usable: false },
  ];
}
