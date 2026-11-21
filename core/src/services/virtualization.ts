/** Virtual machines, LXC, bridges, PCI passthrough, firewall, VNC and templates. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { all, get, getSetting, insert, remove, setSetting, update } from '../db.ts';
import { logger } from '../logger.ts';
import { commandAvailable, pciDevices, runCommand } from '../system.ts';
import { ApiError, asObject, id, optionalBoolean, requireNumber, requireOneOf, requireString, stringArray } from '../util.ts';

export interface VmRecord {
  id: string;
  name: string;
  type: 'kvm' | 'lxc';
  cpu: number;
  memory: number;
  disk: number;
  iso?: string;
  template?: string;
  image?: string;
  network?: string;
  status: string;
  vncPort: number;
  snapshots: Array<{ id: string; name: string; time: number }>;
  firewall: Array<Record<string, unknown>>;
  createdAt?: number;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const VM_ACTIONS = ['start', 'stop', 'reboot', 'shutdown', 'snapshot', 'resume', 'suspend'] as const;

function nameOf(vm: VmRecord): string {
  return vm.name;
}

/** Synchronise running state from libvirt/LXD when they are actually installed. */
async function syncFromHypervisor(vms: VmRecord[]): Promise<void> {
  if (config.demoMode) return;
  if (await commandAvailable('virsh')) {
    const result = await runCommand('virsh', ['list', '--all']);
    if (result.code === 0) {
      const lines = result.stdout.split('\n').slice(2);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const vm = vms.find((item) => item.type === 'kvm' && item.name === parts[1]);
        if (vm && vm.status !== parts[2]) update<VmRecord>('vms', vm.id, { status: parts[2] });
      }
    }
  }
  if (await commandAvailable('lxc')) {
    const result = await runCommand('lxc', ['list', '--format', 'csv']);
    if (result.code === 0) {
      for (const line of result.stdout.split('\n')) {
        const name = line.split(',')[0];
        const status = line.split(',')[3];
        const vm = vms.find((item) => item.type === 'lxc' && item.name === name);
        if (vm && status && vm.status !== status) update<VmRecord>('vms', vm.id, { status });
      }
    }
  }
}

export async function listVms(): Promise<VmRecord[]> {
  const vms = all<VmRecord>('vms');
  await syncFromHypervisor(vms);
  return all<VmRecord>('vms');
}

export function getVm(vmId: string): VmRecord {
  const vm = get<VmRecord>('vms', vmId);
  if (!vm) throw new ApiError('NOT_FOUND', 'VM not found', 404);
  return vm;
}

/** Write a small libvirt domain definition and define it via virsh (no shell). */
async function defineKvm(vm: VmRecord): Promise<void> {
  if (config.demoMode || !(await commandAvailable('virsh'))) return;
  const xml = [
    `<domain type='kvm'>`,
    `  <name>${vm.name}</name>`,
    `  <memory unit='KiB'>${vm.memory * 1024}</memory>`,
    `  <vcpu placement='static'>${vm.cpu}</vcpu>`,
    `  <os><type arch='x86_64'>hvm</type>${vm.iso ? `<boot dev='cdrom'/>` : ''}</os>`,
    `  <devices><disk type='file' device='disk'>`,
    `    <source file='${path.join(config.stateDir, 'vms', `${vm.name}.qcow2`)}'/>`,
    `    <target dev='vda' bus='virtio'/>`,
    `  </disk></devices>`,
    `</domain>`,
  ].join('\n');
  try {
    const target = path.join(config.stateDir, 'vms', `${vm.name}.xml`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, xml, 'utf8');
    const result = await runCommand('virsh', ['define', target]);
    if (result.code !== 0) logger.warn('virsh define failed', { stderr: result.stderr });
  } catch (error) {
    logger.warn('Could not persist libvirt definition', { error: String(error) });
  }
}

export async function createVm(input: Record<string, unknown>): Promise<VmRecord> {
  const body = asObject(input);
  const name = requireString(body, 'name', { pattern: NAME_RE });
  const type = requireOneOf(body, 'type', ['kvm', 'lxc'] as const, 'kvm');
  const cpu = requireNumber(body, 'cpu', { min: 1, max: 256, fallback: 2 });
  const memory = requireNumber(body, 'memory', { min: 128, max: 1_048_576, fallback: 2048 });
  const disk = requireNumber(body, 'disk', { min: 1, max: 1_000_000, fallback: 32 });
  if (all<VmRecord>('vms').some((vm) => vm.name === name)) {
    throw new ApiError('CONFLICT', 'A VM with that name already exists', 409);
  }
  const vm = insert<VmRecord>('vms', {
    name,
    type,
    cpu,
    memory,
    disk,
    iso: typeof body.iso === 'string' ? body.iso : undefined,
    template: typeof body.template === 'string' ? body.template : undefined,
    image: typeof body.image === 'string' ? body.image : undefined,
    network: typeof body.network === 'string' ? body.network : 'br0',
    status: 'stopped',
    vncPort: 5900 + all<VmRecord>('vms').length,
    snapshots: [],
    firewall: [],
    createdAt: Date.now(),
  });
  if (!config.demoMode) {
    if (type === 'kvm') await defineKvm(vm);
    else if (await commandAvailable('lxc')) {
      const result = await runCommand('lxc', [
        'launch',
        typeof body.image === 'string' ? body.image : 'images:alpine/3.20',
        name,
      ]);
      if (result.code !== 0) logger.warn('lxc launch failed', { stderr: result.stderr });
    }
  }
  return vm;
}

export async function updateVm(vmId: string, input: Record<string, unknown>): Promise<VmRecord> {
  getVm(vmId);
  const body = asObject(input);
  const patch: Partial<VmRecord> = {};
  if (body.name !== undefined) patch.name = requireString(body, 'name', { pattern: NAME_RE });
  if (body.cpu !== undefined) patch.cpu = requireNumber(body, 'cpu', { min: 1, max: 256 });
  if (body.memory !== undefined) patch.memory = requireNumber(body, 'memory', { min: 128 });
  if (body.disk !== undefined) patch.disk = requireNumber(body, 'disk', { min: 1 });
  if (body.network !== undefined) patch.network = requireString(body, 'network');
  if (body.iso !== undefined) patch.iso = requireString(body, 'iso');
  if (body.template !== undefined) patch.template = requireString(body, 'template');
  return update<VmRecord>('vms', vmId, patch) as VmRecord;
}

export async function deleteVm(vmId: string): Promise<{ deleted: boolean }> {
  const vm = getVm(vmId);
  if (!config.demoMode) {
    if (vm.type === 'kvm' && (await commandAvailable('virsh'))) {
      await runCommand('virsh', ['destroy', nameOf(vm)]);
      await runCommand('virsh', ['undefine', nameOf(vm)]);
    } else if (vm.type === 'lxc' && (await commandAvailable('lxc'))) {
      await runCommand('lxc', ['delete', nameOf(vm), '--force']);
    }
  }
  return { deleted: remove('vms', vmId) };
}

export async function vmAction(vmId: string, action: string): Promise<VmRecord> {
  if (!(VM_ACTIONS as readonly string[]).includes(action)) {
    throw new ApiError('INVALID_ACTION', `Unknown VM action: ${action}`);
  }
  const vm = getVm(vmId);
  if (!config.demoMode) {
    const command = vm.type === 'kvm' ? 'virsh' : 'lxc';
    if (await commandAvailable(command)) {
      const virshArgs: Record<string, string[]> = {
        start: ['start', vm.name],
        stop: ['destroy', vm.name],
        shutdown: ['shutdown', vm.name],
        reboot: ['reboot', vm.name],
        resume: ['resume', vm.name],
        suspend: ['suspend', vm.name],
        snapshot: ['snapshot-create-as', vm.name, `snap-${Date.now()}`],
      };
      const lxcArgs: Record<string, string[]> = {
        start: ['start', vm.name],
        stop: ['stop', vm.name],
        shutdown: ['stop', vm.name],
        reboot: ['restart', vm.name],
        resume: ['start', vm.name],
        suspend: ['pause', vm.name],
        snapshot: ['snapshot', vm.name, `snap-${Date.now()}`],
      };
      const result = await runCommand(command, vm.type === 'kvm' ? virshArgs[action] : lxcArgs[action]);
      if (result.code !== 0) logger.warn('VM action command failed', { action, stderr: result.stderr });
    }
  }
  const nextStatus =
    action === 'start' || action === 'resume' || action === 'reboot'
      ? 'running'
      : action === 'stop' || action === 'shutdown' || action === 'suspend'
        ? 'stopped'
        : vm.status;
  let snapshots = vm.snapshots;
  if (action === 'snapshot') {
    snapshots = [
      ...snapshots,
      { id: id(), name: `snapshot-${new Date().toISOString()}`, time: Date.now() },
    ];
  }
  return update<VmRecord>('vms', vmId, { status: nextStatus, snapshots }) as VmRecord;
}

export function vncInfo(vmId: string): { url: string; port: number; websocket: string } {
  const vm = getVm(vmId);
  const port = vm.vncPort || 5900;
  return {
    url: `https://${config.hostname}:${port}`,
    port,
    websocket: `wss://${config.hostname}:${port}/websockify`,
  };
}

export function listVmSnapshots(vmId: string): Array<Record<string, unknown>> {
  return getVm(vmId).snapshots ?? [];
}

export function createVmSnapshot(vmId: string, name?: string): Array<Record<string, unknown>> {
  const vm = getVm(vmId);
  const snapshots = [
    ...(vm.snapshots ?? []),
    { id: id(), name: name || `snapshot-${Date.now()}`, time: Date.now() },
  ];
  update<VmRecord>('vms', vmId, { snapshots });
  return snapshots;
}

export async function pciList(): Promise<{ devices: Array<Record<string, unknown>> }> {
  return { devices: await pciDevices() };
}

export interface Bridge {
  name: string;
  ports: string[];
  vlanAware: boolean;
  tag: number | null;
}

export function listBridges(): Bridge[] {
  const network = getSetting<Record<string, unknown>>('network.settings', {});
  return Array.isArray(network.bridges) ? (network.bridges as Bridge[]) : [];
}

export function createBridge(input: Record<string, unknown>): Bridge {
  const body = asObject(input);
  const name = requireString(body, 'name', { pattern: /^[A-Za-z0-9_.-]{1,15}$/ });
  const bridges = listBridges();
  if (bridges.some((bridge) => bridge.name === name)) {
    throw new ApiError('CONFLICT', 'Bridge already exists', 409);
  }
  const bridge: Bridge = {
    name,
    ports: stringArray(body.ports, 'ports'),
    vlanAware: optionalBoolean(body, 'vlanAware', true),
    tag: typeof body.tag === 'number' ? body.tag : null,
  };
  const network = getSetting<Record<string, unknown>>('network.settings', {});
  setSetting('network.settings', { ...network, bridges: [...bridges, bridge] });
  return bridge;
}

export interface VmTemplate {
  id: string;
  name: string;
  type: 'kvm' | 'lxc';
  cpu: number;
  memory: number;
  disk: number;
  image?: string;
}

const DEFAULT_TEMPLATES: VmTemplate[] = [
  { id: 'tpl-ubuntu', name: 'Ubuntu 24.04 LTS', type: 'kvm', cpu: 4, memory: 4096, disk: 60 },
  { id: 'tpl-debian', name: 'Debian 12', type: 'kvm', cpu: 2, memory: 2048, disk: 40 },
  { id: 'tpl-alpine', name: 'Alpine 3.20', type: 'lxc', cpu: 1, memory: 1024, disk: 8, image: 'images:alpine/3.20' },
];

export function listTemplates(): VmTemplate[] {
  const configured = getSetting<VmTemplate[]>('vm.templates', []);
  return configured.length ? configured : DEFAULT_TEMPLATES;
}

export function createTemplate(input: Record<string, unknown>): VmTemplate {
  const body = asObject(input);
  const template: VmTemplate = {
    id: id(),
    name: requireString(body, 'name'),
    type: requireOneOf(body, 'type', ['kvm', 'lxc'] as const),
    cpu: requireNumber(body, 'cpu', { min: 1, fallback: 2 }),
    memory: requireNumber(body, 'memory', { min: 128, fallback: 2048 }),
    disk: requireNumber(body, 'disk', { min: 1, fallback: 32 }),
    image: typeof body.image === 'string' ? body.image : undefined,
  };
  setSetting('vm.templates', [...listTemplates(), template]);
  return template;
}

export function getFirewall(vmId: string): Array<Record<string, unknown>> {
  return getVm(vmId).firewall ?? [];
}

export function setFirewall(
  vmId: string,
  input: Record<string, unknown> | Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const rules = Array.isArray(input)
    ? input
    : Array.isArray(asObject(input).rules)
      ? (asObject(input).rules as Array<Record<string, unknown>>)
      : [];
  const sanitized = rules.map((rule) => ({
    id: typeof rule.id === 'string' ? rule.id : id(),
    action: rule.action === 'deny' ? 'deny' : 'allow',
    protocol: typeof rule.protocol === 'string' ? rule.protocol : 'tcp',
    port: typeof rule.port === 'number' ? rule.port : 0,
    source: typeof rule.source === 'string' ? rule.source : 'any',
  }));
  update<VmRecord>('vms', vmId, { firewall: sanitized });
  return sanitized;
}
