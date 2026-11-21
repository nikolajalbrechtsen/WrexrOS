/** Settings service: general, access, updates, advanced and validated raw config. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { allSettings, getSetting, getStateDir, setSetting } from '../db.ts';
import { coreVersion } from '../system.ts';
import { ApiError, asObject, isPlainObject, safeJsonParse } from '../util.ts';
import { getNetworkSettings, updateNetworkSettings } from './network.ts';
import { getStorageSettings, setStorageSettings } from './storage.ts';

export function getGeneral(): Record<string, unknown> {
  return {
    hostname: config.hostname,
    timezone: config.timezone,
    language: 'en',
    theme: 'dark',
    kiosk: false,
    ...getSetting<Record<string, unknown>>('general', {}),
  };
}

export function setGeneral(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...getGeneral() };
  for (const key of ['hostname', 'timezone', 'language', 'theme']) {
    if (typeof input[key] === 'string') next[key] = input[key];
  }
  if (typeof input.kiosk === 'boolean') next.kiosk = input.kiosk;
  setSetting('general', next);
  setSetting('hostname', next.hostname);
  setSetting('timezone', next.timezone);
  return next;
}

export { getNetworkSettings, updateNetworkSettings, getStorageSettings, setStorageSettings };

export function getAccess(): Record<string, unknown> {
  return {
    roles: ['admin', 'operator', 'viewer'],
    twoFactorPolicy: 'optional',
    sshKeys: [],
    ...getSetting<Record<string, unknown>>('access', {}),
  };
}

export function setAccess(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...getAccess() };
  if (Array.isArray(input.roles) && input.roles.every((role) => typeof role === 'string')) {
    next.roles = input.roles;
  }
  if (typeof input.twoFactorPolicy === 'string') next.twoFactorPolicy = input.twoFactorPolicy;
  if (Array.isArray(input.sshKeys) && input.sshKeys.every((key) => typeof key === 'string')) {
    next.sshKeys = input.sshKeys;
  }
  setSetting('access', next);
  return next;
}

export function getUpdatesSettings(): Record<string, unknown> {
  return {
    channel: config.channel,
    autoUpdate: false,
    appUpdates: true,
    repoUrl: config.updateRepo,
    syncStatus: 'idle',
    ...getSetting<Record<string, unknown>>('updates.settings', {}),
  };
}

export function setUpdatesSettings(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...getUpdatesSettings() };
  if (typeof input.channel === 'string') next.channel = input.channel;
  if (typeof input.autoUpdate === 'boolean') next.autoUpdate = input.autoUpdate;
  if (typeof input.appUpdates === 'boolean') next.appUpdates = input.appUpdates;
  if (typeof input.repoUrl === 'string') next.repoUrl = input.repoUrl;
  setSetting('updates.settings', next);
  return next;
}

export function getAdvanced(): Record<string, unknown> {
  return {
    kernelParams: {},
    rawConfig: '',
    ...getSetting<Record<string, unknown>>('advanced', {}),
  };
}

export function setAdvanced(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...getAdvanced() };
  if (isPlainObject(input.kernelParams)) next.kernelParams = input.kernelParams;
  if (typeof input.rawConfig === 'string') next.rawConfig = input.rawConfig;
  setSetting('advanced', next);
  return next;
}

export function getRawConfig(): Record<string, unknown> {
  return {
    version: coreVersion(),
    channel: config.channel,
    settings: allSettings(),
  };
}

const KNOWN_SECTIONS = new Set([
  'general', 'hostname', 'timezone', 'channel', 'network.settings', 'storage.settings',
  'array', 'access', 'updates.settings', 'advanced', 'vm.templates',
]);

/** Validate without writing: returns errors instead of throwing. */
export function validateRawConfig(raw: unknown): { valid: boolean; errors: string[] } {
  let value: unknown = raw;
  if (typeof value === 'string') value = safeJsonParse<unknown>(value, null);
  if (!isPlainObject(value)) return { valid: false, errors: ['Config must be a JSON object'] };
  const errors: string[] = [];
  const settings = isPlainObject(value.settings) ? value.settings : value;
  for (const [key, entry] of Object.entries(settings)) {
    if (!KNOWN_SECTIONS.has(key)) errors.push(`Unknown setting: ${key}`);
    if (['general', 'access', 'advanced', 'network.settings', 'storage.settings', 'array'].includes(key)
      && !isPlainObject(entry)) {
      errors.push(`${key} must be an object`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Validate, back up the previous raw config, then apply the new values. */
export function saveRawConfig(raw: unknown): { backupPath: string; valid: boolean } {
  const validation = validateRawConfig(raw);
  if (!validation.valid) {
    throw new ApiError('VALIDATION_ERROR', 'Raw config is invalid', 400, { errors: validation.errors });
  }
  let value: unknown = raw;
  if (typeof value === 'string') value = safeJsonParse<Record<string, unknown>>(value, {});
  const object = asObject(value);
  const settings = isPlainObject(object.settings) ? object.settings : object;

  const backupDir = path.join(getStateDir(), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `raw-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(getRawConfig(), null, 2), 'utf8');

  for (const [key, entry] of Object.entries(settings)) {
    if (KNOWN_SECTIONS.has(key)) setSetting(key, entry);
  }
  return { backupPath, valid: true };
}
