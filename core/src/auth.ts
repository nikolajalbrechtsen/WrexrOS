/**
 * Authentication: scrypt password hashing, sessions, scoped API tokens,
 * TOTP (RFC 6238), first-run setup and RBAC.
 *
 * There is deliberately NO default password. setupRequired() stays true until
 * POST /auth/setup creates the first administrator.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.ts';
import { all, count, get, insert, remove, update, getSetting, setSetting } from './db.ts';
import { ApiError, id, isPlainObject, safeEqual, stringArray } from './util.ts';

export type Role = 'admin' | 'operator' | 'viewer' | 'custom';

export interface UserRecord {
  id: string;
  username: string;
  role: Role;
  permissions: string[];
  passwordHash: string;
  totpSecret?: string;
  totpEnabled: boolean;
  disabled?: boolean;
  createdAt: number;
}

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  permissions: string[];
  totpEnabled: boolean;
  createdAt: number;
}

export interface Principal {
  userId: string;
  username: string;
  role: Role;
  permissions: string[];
  source: 'session' | 'token';
  tokenId?: string;
  user: PublicUser;
}

/** Role defaults. Custom roles carry their own granular permission strings. */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: ['*'],
  operator: [
    '*:read',
    'vm:write',
    'vm:start',
    'vm:stop',
    'vm:snapshot',
    'storage:write',
    'share:write',
    'user:write',
    'app:write',
    'app:install',
    'app:start',
    'network:write',
    'updates:write',
    'alerts:write',
    'backups:write',
    'system:write',
  ],
  viewer: ['*:read'],
  custom: [],
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
    throw new ApiError('VALIDATION_ERROR', 'password must be between 8 and 1024 characters');
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = String(stored ?? '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- TOTP (base32 secret + HMAC-SHA1, 30 second steps, 6 digits) ------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += BASE32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = String(input ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new ApiError('VALIDATION_ERROR', 'Invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, time = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(time / 30_000));
}

export function verifyTotp(secret: string, code: string, window = 1): boolean {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  try {
    const step = Math.floor(Date.now() / 30_000);
    for (let delta = -window; delta <= window; delta++) {
      if (safeEqual(hotp(base32Decode(secret), step + delta), code)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function totpUri(secret: string, account = 'admin', issuer = 'WrexrOS'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// --- Permission helpers -----------------------------------------------------

/** grant may be '*', 'domain:*', '*:read' or a fully qualified permission. */
export function permissionMatches(grant: string, required: string): boolean {
  const [grantDomain, grantAction = '*'] = String(grant).split(':');
  const [requiredDomain, requiredAction = '*'] = String(required).split(':');
  return (
    (grantDomain === '*' || grantDomain === requiredDomain) &&
    (grantAction === '*' || grantAction === requiredAction)
  );
}

export function hasGrant(grants: string[], required: string): boolean {
  return grants.some((grant) => permissionMatches(grant, required));
}

export function permissionsForUser(user: UserRecord): string[] {
  if (user.role === 'custom') return Array.isArray(user.permissions) ? user.permissions : [];
  return [...(ROLE_PERMISSIONS[user.role] ?? [])];
}

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: permissionsForUser(user),
    totpEnabled: !!user.totpEnabled,
    createdAt: user.createdAt,
  };
}

export function hasPermission(principal: Principal | null, required: string): boolean {
  if (!principal) return false;
  return hasGrant(principal.permissions, required);
}

export function requirePermission(principal: Principal | null, required: string): void {
  if (!hasPermission(principal, required)) {
    throw new ApiError('FORBIDDEN', `Missing permission ${required}`, 403);
  }
}

// --- First-run setup and login ---------------------------------------------

export function setupRequired(): boolean {
  return count('users') === 0;
}

export interface SetupPayload {
  hostname?: string;
  timezone?: string;
  password: string;
  sshKeys?: string[];
  network?: Record<string, unknown>;
  createShare?: boolean;
  createVm?: boolean;
  username?: string;
}

function findUserByName(username: string): UserRecord | null {
  return (
    all<UserRecord>('users').find(
      (user) => user.username.toLowerCase() === username.toLowerCase(),
    ) ?? null
  );
}

export async function setup(payload: SetupPayload): Promise<{ token: string; user: PublicUser }> {
  if (!isPlainObject(payload)) throw new ApiError('VALIDATION_ERROR', 'setup payload must be an object');
  if (!setupRequired()) throw new ApiError('ALREADY_SETUP', 'This system is already set up', 409);

  const username = payload.username ?? 'admin';
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
    throw new ApiError('VALIDATION_ERROR', 'Invalid username');
  }
  const hostname = typeof payload.hostname === 'string' && payload.hostname
    ? payload.hostname
    : config.hostname;
  const timezone = typeof payload.timezone === 'string' && payload.timezone
    ? payload.timezone
    : config.timezone;
  const sshKeys = payload.sshKeys === undefined ? [] : stringArray(payload.sshKeys, 'sshKeys');

  const user = insert<UserRecord>('users', {
    username,
    role: 'admin',
    permissions: [],
    passwordHash: hashPassword(payload.password),
    totpEnabled: false,
    createdAt: Date.now(),
  });

  setSetting('hostname', hostname);
  setSetting('timezone', timezone);
  setSetting('general', { hostname, timezone, language: 'en', theme: 'dark', kiosk: false });
  const access = getSetting<Record<string, unknown>>('access', {});
  setSetting('access', { ...access, sshKeys, roles: ['admin', 'operator', 'viewer'] });
  if (payload.network && isPlainObject(payload.network)) {
    const network = getSetting<Record<string, unknown>>('network.settings', {});
    setSetting('network.settings', { ...network, ...payload.network });
  }

  // Optional first-boot extras are best-effort; failure must not lock the user out.
  try {
    if (payload.createShare) {
      const sharing = await import('./services/sharing.ts');
      sharing.createShare({
        name: 'media',
        path: '/mnt/user/media',
        protocol: 'smb',
      });
    }
    if (payload.createVm) {
      const virtualization = await import('./services/virtualization.ts');
      virtualization.createVm({ name: 'first-vm', type: 'kvm', cpu: 2, memory: 2048, disk: 32 });
    }
  } catch (error) {
    // Audit is not critical during setup; just avoid an unhandled rejection.
    void error;
  }

  const session = createSession(user.id);
  return { token: session.token, user: publicUser(user) };
}

export interface LoginResult {
  token: string;
  user: PublicUser;
  expiresAt: number;
}

export function login(password: string, totp?: string): LoginResult {
  if (setupRequired()) throw new ApiError('SETUP_REQUIRED', 'System setup is required', 409);
  const user = findUserByName('admin') ?? all<UserRecord>('users')[0];
  if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
    // Same error for unknown user and wrong password: no user enumeration.
    throw new ApiError('UNAUTHENTICATED', 'Invalid credentials', 401);
  }
  if (user.totpEnabled && !verifyTotp(user.totpSecret ?? '', totp ?? '')) {
    throw new ApiError('TOTP_REQUIRED', 'A valid TOTP code is required', 401);
  }
  const session = createSession(user.id);
  return { token: session.token, user: publicUser(user), expiresAt: session.expiresAt };
}

export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = `wrexr_s_${randomBytes(32).toString('base64url')}`;
  const expiresAt = Date.now() + config.sessionTtlMs;
  insert('sessions', { id: id(), tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export function logout(token: string): boolean {
  const hash = hashToken(token);
  const session = all<Record<string, unknown>>('sessions').find(
    (item) => typeof item.tokenHash === 'string' && safeEqual(item.tokenHash, hash),
  );
  return session ? remove('sessions', String(session.id)) : false;
}

export function authenticate(token: string | undefined | null): Principal | null {
  if (!token || typeof token !== 'string' || token.length < 8) return null;
  const hash = hashToken(token);
  const now = Date.now();

  const session = all<Record<string, unknown>>('sessions').find(
    (item) =>
      typeof item.tokenHash === 'string' &&
      safeEqual(item.tokenHash, hash) &&
      Number(item.expiresAt) > now,
  );
  if (session) {
    const user = get<UserRecord>('users', String(session.userId));
    if (!user || user.disabled) return null;
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      permissions: permissionsForUser(user),
      source: 'session',
      user: publicUser(user),
    };
  }

  const apiToken = all<Record<string, unknown>>('tokens').find(
    (item) =>
      typeof item.tokenHash === 'string' &&
      safeEqual(item.tokenHash, hash) &&
      (item.expiresAt === undefined || Number(item.expiresAt) > now),
  );
  if (!apiToken) return null;
  const user = get<UserRecord>('users', String(apiToken.userId));
  if (!user || user.disabled) return null;
  const userGrants = permissionsForUser(user);
  const scopes = Array.isArray(apiToken.scopes) ? (apiToken.scopes as string[]) : [];
  // Scopes can only narrow the user's own permissions.
  const permissions = scopes.filter((scope) => hasGrant(userGrants, scope));
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    permissions,
    source: 'token',
    tokenId: String(apiToken.id),
    user: publicUser(user),
  };
}

export function getMe(principal: Principal): {
  user: PublicUser;
  permissions: string[];
  role: Role;
} {
  return { user: principal.user, permissions: principal.permissions, role: principal.role };
}

// --- API tokens ------------------------------------------------------------

export interface CreatedToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  token: string;
  createdAt: number;
  expiresAt?: number;
}

export function createApiToken(
  userId: string,
  name: string,
  scopes: string[],
  expiresAt?: number,
): CreatedToken {
  const token = `wrexr_a_${randomBytes(32).toString('base64url')}`;
  const record = insert('tokens', {
    name,
    prefix: token.slice(0, 16),
    tokenHash: hashToken(token),
    userId,
    scopes,
    expiresAt,
  });
  return {
    id: record.id,
    name,
    prefix: record.prefix as string,
    scopes,
    token,
    createdAt: Date.now(),
    expiresAt,
  };
}

export function listTokens(): Array<Record<string, unknown>> {
  return all('tokens').map((token) => {
    const { tokenHash: _hash, ...safe } = token;
    return safe;
  });
}

export function revokeToken(tokenId: string): boolean {
  return remove('tokens', tokenId);
}

// --- TOTP enrollment -------------------------------------------------------

export function totpEnroll(userId: string): { secret: string; uri: string } {
  const user = get<UserRecord>('users', userId);
  if (!user) throw new ApiError('NOT_FOUND', 'User not found', 404);
  const secret = generateTotpSecret();
  update<UserRecord>('users', userId, { totpSecret: secret, totpEnabled: false });
  return { secret, uri: totpUri(secret, user.username) };
}

export function totpVerify(userId: string, code: string): { enabled: boolean } {
  const user = get<UserRecord>('users', userId);
  if (!user?.totpSecret) throw new ApiError('NOT_ENROLLED', 'TOTP enrollment is required', 409);
  if (!verifyTotp(user.totpSecret, code)) {
    throw new ApiError('INVALID_CODE', 'Invalid TOTP code');
  }
  update<UserRecord>('users', userId, { totpEnabled: true });
  return { enabled: true };
}

/** Create a user with an explicit role; used by tests and by the users API. */
export function createUser(
  username: string,
  password: string,
  role: Role,
  permissions: string[] = [],
): PublicUser {
  if (findUserByName(username)) throw new ApiError('CONFLICT', 'User already exists', 409);
  const user = insert<UserRecord>('users', {
    username,
    role,
    permissions,
    passwordHash: hashPassword(password),
    totpEnabled: false,
    createdAt: Date.now(),
  });
  return publicUser(user);
}
