/** Output helpers for wrexctl: ANSI colors, aligned tables and JSON. */

const ANSI: Record<string, string> = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
};

let colorEnabled: boolean | undefined;

export type ColorName = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'cyan';

/** Detect whether ANSI colors are appropriate for the current stdout. */
export function supportsColor(): boolean {
  if (colorEnabled !== undefined) return colorEnabled;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '0') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

/** Override color detection (used by --no-color / --color). */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function paint(text: string, color?: ColorName): string {
  if (!color || !supportsColor()) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}\u2026`;
}

/** Render rows as a compact, aligned text table. */
export function table(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0 && (!columns || columns.length === 0)) return '(none)';

  const keys = columns ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  if (keys.length === 0) return '(none)';

  const labels = keys.map((key) => key.toUpperCase());
  const cells = rows.map((row) => keys.map((key) => clip(formatCell(row[key]), 60)));
  const widths = keys.map((_, index) =>
    Math.max(labels[index]?.length ?? 0, ...cells.map((row) => row[index]?.length ?? 0)),
  );

  const render = (values: string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ').trimEnd();

  const lines = [paint(render(labels), 'bold'), paint(render(widths.map((width) => '-'.repeat(width))), 'dim')];
  for (const row of cells) lines.push(render(row));
  return lines.join('\n');
}

/** Pretty-printed JSON used by --json. */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** Parse a semantic version, tolerating a leading v and build metadata. */
export function parseSemver(input: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Compare two semantic versions. Returns -1, 0 or 1. */
export function semverCompare(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return a.localeCompare(b) < 0 ? -1 : a.localeCompare(b) > 0 ? 1 : 0;

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) return Number(l) < Number(r) ? -1 : 1;
    if (lNum) return -1;
    if (rNum) return 1;
    return l.localeCompare(r) < 0 ? -1 : 1;
  }
  return 0;
}
