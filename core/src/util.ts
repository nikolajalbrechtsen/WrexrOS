/** Shared helpers: response envelopes, validation, semver, body parsing. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const MAX_BODY_BYTES = 1024 * 1024;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    status = 400,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface OkEnvelope<T> {
  ok: true;
  data: T;
}
export interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; details: Record<string, unknown> };
}
export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;

export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

export function fail(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ErrorEnvelope {
  return { ok: false, error: { code, message, details } };
}

export function id(): string {
  return randomUUID();
}

export function now(): number {
  return Date.now();
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asObject(value: unknown, name = 'body'): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ApiError('VALIDATION_ERROR', `${name} must be an object`);
  return value;
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; pattern?: RegExp; name?: string } = {},
): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('VALIDATION_ERROR', `${opts.name ?? key} is required`);
  }
  if (opts.min !== undefined && value.length < opts.min) {
    throw new ApiError('VALIDATION_ERROR', `${opts.name ?? key} is too short`);
  }
  if (opts.max !== undefined && value.length > opts.max) {
    throw new ApiError('VALIDATION_ERROR', `${opts.name ?? key} is too long`);
  }
  if (opts.pattern && !opts.pattern.test(value)) {
    throw new ApiError('VALIDATION_ERROR', `${opts.name ?? key} has an invalid format`);
  }
  return value;
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const value = obj[key];
  return typeof value === 'string' ? value : fallback;
}

export function requireOneOf<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback?: T,
): T {
  const value = obj[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ApiError('VALIDATION_ERROR', `${key} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

export function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; fallback?: number } = {},
): number {
  const value = obj[key];
  if (value === undefined && opts.fallback !== undefined) return opts.fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new ApiError('VALIDATION_ERROR', `${key} must be a number`);
  if (opts.min !== undefined && n < opts.min) {
    throw new ApiError('VALIDATION_ERROR', `${key} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new ApiError('VALIDATION_ERROR', `${key} must be <= ${opts.max}`);
  }
  return n;
}

export function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const value = obj[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function stringArray(value: unknown, name = 'list'): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ApiError('VALIDATION_ERROR', `${name} must be an array of strings`);
  }
  return value as string[];
}

/** Constant-time comparison that also tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Read a JSON request body with a hard size limit. */
export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limit) {
      throw new ApiError('PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`, 413);
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('INVALID_JSON', 'Request body is not valid JSON');
  }
}

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export interface ParsedQuery {
  [key: string]: string | string[];
}

export function parseQuery(url: URL): ParsedQuery {
  const out: ParsedQuery = {};
  for (const [key, value] of url.searchParams) {
    const previous = out[key];
    if (previous === undefined) out[key] = value;
    else out[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return out;
}

/**
 * Semver comparison including a leading "v" and prerelease identifiers.
 * Returns -1 when a < b, 0 when equal, 1 when a > b.
 */
export function semverCompare(a: string, b: string): -1 | 0 | 1 {
  const parse = (input: string) => {
    const cleaned = String(input ?? '').trim().replace(/^v/i, '');
    const [corePart, prePart = ''] = cleaned.split('-', 2);
    const core = corePart.split('.').map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (core.length < 3) core.push(0);
    const pre = prePart.split('.').filter(Boolean);
    return { core: core.slice(0, 3), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1; // release > prerelease
  if (right.pre.length === 0) return -1;
  const len = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = Number.parseInt(l, 10);
    const rn = Number.parseInt(r, 10);
    const bothNumeric = Number.isFinite(ln) && Number.isFinite(rn);
    if (bothNumeric) return ln > rn ? 1 : -1;
    return l > r ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return semverCompare(candidate, current) > 0;
}

/** Trailing-edge debounce, safe in timers and tests. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return (...args: A): void => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = undefined;
      fn(...args);
    }, ms);
  };
}

/** Pick only the safe, whitelisted keys from an object. */
export function pick<T extends Record<string, unknown>>(
  obj: T,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}
