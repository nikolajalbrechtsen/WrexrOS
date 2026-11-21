import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrexr-router-'));
process.env.WREXR_STATE_DIR = stateDir;
process.env.WREXR_DEMO_MODE = '1';
process.env.WREXR_INSECURE_HTTP = '1';

const { initDb, closeDb, all } = await import('../src/db.ts');
const auth = await import('../src/auth.ts');
const { handleRequest } = await import('../src/router.ts');

const server = http.createServer(handleRequest);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const base = `http://127.0.0.1:${address.port}`;

after(() => {
  server.close();
  closeDb();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

initDb({ seedDemo: false });
const setup = await auth.setup({ hostname: 'router-test', timezone: 'UTC', password: 'router-pass-1' });
const headers = { Authorization: `Bearer ${setup.token}` };

test('unauthenticated status endpoint uses the ok envelope', async () => {
  const response = await fetch(`${base}/api/v1/auth/status`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.ok, true);
  assert.equal(body.data.setupRequired, false);
  assert.equal(body.data.channel, 'stable');
});

test('protected routes return 401/404 error envelopes', async () => {
  const unauthorized = await fetch(`${base}/api/v1/vms`);
  assert.equal(unauthorized.status, 401);
  const body = await unauthorized.json() as any;
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'UNAUTHENTICATED');

  const missing = await fetch(`${base}/api/v1/does-not-exist`, { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as any).error.code, 'NOT_FOUND');
});

test('bearer token accesses VM list and mutations are audited', async () => {
  const response = await fetch(`${base}/api/v1/vms`, { headers });
  assert.equal(response.status, 200);
  const list = await response.json() as any;
  assert.equal(list.ok, true);
  assert.ok(Array.isArray(list.data.vms));

  const created = await fetch(`${base}/api/v1/vms`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'router-vm', type: 'kvm', cpu: 2, memory: 1024, disk: 20 }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as any).data.name, 'router-vm');

  const audit = await fetch(`${base}/api/v1/audit`, { headers });
  const entries = (await audit.json() as any).data.audit as Array<Record<string, unknown>>;
  assert.ok(entries.some((entry) => entry.action === 'post:/vms' && entry.result === 'success'));
});

test('viewer receives 403 on mutating routes', async () => {
  const viewer = auth.createUser('viewer-router', 'viewer-pass-1', 'viewer');
  const token = auth.createSession(viewer.id).token;
  const response = await fetch(`${base}/api/v1/shares`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'nope', path: '/mnt/nope' }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as any).error.code, 'FORBIDDEN');
  assert.equal(all('shares').length, 0);
});

test('openapi.json is generated from the route table', async () => {
  const response = await fetch(`${base}/api/v1/openapi.json`);
  assert.equal(response.status, 200);
  const doc = (await response.json() as any).data;
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.paths['/vms/{id}/{action}']);
  assert.ok(doc.paths['/auth/login']);
});
