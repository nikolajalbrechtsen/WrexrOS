/** Network configuration (interfaces, bridges, VLAN, DHCP/static, DNS, proxy, firewall). */
import { getSetting, setSetting } from '../db.ts';
import { detailedNetworkInterfaces } from '../system.ts';
import { asObject, isPlainObject } from '../util.ts';

const DEFAULTS = {
  interfaces: [],
  bridges: [],
  vlan: 1,
  mode: 'dhcp',
  ipv4: '',
  gateway: '',
  dns: [] as string[],
  proxy: '',
  firewall: [] as Array<Record<string, unknown>>,
};

export function getNetworkSettings(): Record<string, unknown> {
  const stored = getSetting<Record<string, unknown>>('network.settings', {});
  return { ...DEFAULTS, ...stored };
}

/** Shallow merge with dedicated handling for nested lists supplied by the UI. */
export function updateNetworkSettings(input: Record<string, unknown>): Record<string, unknown> {
  const body = asObject(input);
  const next = { ...getNetworkSettings() };
  for (const [key, value] of Object.entries(body)) {
    if (key === 'dns' || key === 'interfaces' || key === 'bridges' || key === 'firewall') {
      if (Array.isArray(value)) next[key] = value;
    } else if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = { ...(next[key] as Record<string, unknown>), ...value };
    } else {
      next[key] = value;
    }
  }
  setSetting('network.settings', next);
  return next;
}

export async function listNetworkInterfaces() {
  return detailedNetworkInterfaces();
}
