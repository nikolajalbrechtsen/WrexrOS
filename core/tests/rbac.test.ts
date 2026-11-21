import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrexr-rbac-'));
process.env.WREXR_STATE_DIR = stateDir;
process.env.WREXR_DEMO_MODE = '1';

const { initDb, closeDb } = await import('../src/db.ts');
const auth = await import('../src/auth.ts');

after(() => {
  closeDb();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

initDb({ seedDemo: false });

test('viewer can read but cannot mutate or access the audit log', () => {
  const viewer = auth.createUser('viewer', 'viewer-pass-1', 'viewer');
  const session = auth.createSession(viewer.id);
  const principal = auth.authenticate(session.token);
  assert.ok(principal);
  assert.equal(auth.hasPermission(principal, 'vm:read'), true);
  assert.equal(auth.hasPermission(principal, 'share:read'), true);
  assert.equal(auth.hasPermission(principal, 'vm:write'), false);
  assert.equal(auth.hasPermission(principal, 'system:admin'), false);
  assert.throws(
    () => auth.requirePermission(principal, 'vm:start'),
    (error: unknown) => (error as { code?: string }).code === 'FORBIDDEN',
  );
});

test('custom roles grant only their listed actions', () => {
  const custom = auth.createUser('operator-custom', 'custom-pass-1', 'custom', ['vm:start']);
  const principal = auth.authenticate(auth.createSession(custom.id).token);
  assert.equal(auth.hasPermission(principal, 'vm:start'), true);
  assert.equal(auth.hasPermission(principal, 'vm:stop'), false);
  assert.equal(auth.hasPermission(principal, 'share:read'), false);
});

test('wildcard grants match domains and actions', () => {
  assert.equal(auth.permissionMatches('*', 'anything:whatever'), true);
  assert.equal(auth.permissionMatches('vm:*', 'vm:start'), true);
  assert.equal(auth.permissionMatches('*:read', 'share:read'), true);
  assert.equal(auth.permissionMatches('*:read', 'share:write'), false);
  assert.equal(auth.permissionMatches('vm:start', 'vm:stop'), false);
});
