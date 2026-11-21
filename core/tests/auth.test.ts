import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrexr-auth-'));
process.env.WREXR_STATE_DIR = stateDir;
process.env.WREXR_DEMO_MODE = '1';
process.env.WREXR_INSECURE_HTTP = '1';

const { initDb, closeDb, all } = await import('../src/db.ts');
const auth = await import('../src/auth.ts');

after(() => {
  closeDb();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

initDb({ seedDemo: false });

let adminId = '';

test('scrypt password hashing verifies the password and rejects wrong ones', () => {
  const hash = auth.hashPassword('correct-horse-9');
  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(auth.verifyPassword('correct-horse-9', hash), true);
  assert.equal(auth.verifyPassword('wrong-password', hash), false);
  assert.throws(() => auth.hashPassword('short'));
});

test('first-run setup creates an admin and login issues a session token', async () => {
  assert.equal(auth.setupRequired(), true);
  const { token, user } = await auth.setup({
    hostname: 'wrexr-test',
    timezone: 'UTC',
    password: 'correct-horse-9',
  });
  adminId = user.id;
  assert.equal(user.role, 'admin');
  assert.equal(user.username, 'admin');
  assert.equal(auth.setupRequired(), false);
  await assert.rejects(() => auth.setup({ password: 'another-pass-1' }));

  const loggedIn = auth.login('correct-horse-9');
  assert.ok(loggedIn.token.startsWith('wrexr_s_'));
  assert.ok(loggedIn.expiresAt > Date.now());
  const principal = auth.authenticate(loggedIn.token);
  assert.equal(principal?.username, 'admin');
  assert.equal(principal?.source, 'session');
  assert.equal(auth.authenticate(token)?.userId, adminId);
  assert.equal(auth.authenticate('not-a-token'), null);
  assert.throws(() => auth.login('wrong-password'));
});

test('TOTP secrets generate valid 6-digit codes and enrollment persists', () => {
  const secret = auth.generateTotpSecret();
  const code = auth.totpAt(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(auth.verifyTotp(secret, code), true);
  assert.equal(auth.verifyTotp(secret, code === '000000' ? '111111' : '000000'), false);
  assert.match(auth.totpUri(secret, 'admin'), /^otpauth:\/\/totp\//);

  const enrollment = auth.totpEnroll(adminId);
  assert.equal(typeof enrollment.secret, 'string');
  assert.deepEqual(auth.totpVerify(adminId, auth.totpAt(enrollment.secret)), { enabled: true });
  const admin = all<Record<string, unknown>>('users').find((u) => u.id === adminId);
  assert.equal(admin?.totpEnabled, true);
});

test('API token scopes narrow the permissions of an admin user', () => {
  assert.deepEqual(auth.ROLE_PERMISSIONS.viewer, ['*:read']);
  const created = auth.createApiToken(adminId, 'readonly', ['vm:read']);
  const principal = auth.authenticate(created.token);
  assert.equal(principal?.source, 'token');
  assert.deepEqual(principal?.permissions, ['vm:read']);
  assert.equal(auth.hasPermission(principal, 'vm:read'), true);
  assert.equal(auth.hasPermission(principal, 'vm:write'), false);
  assert.equal(auth.revokeToken(created.id), true);
  assert.equal(auth.authenticate(created.token), null);
});
