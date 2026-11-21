import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { defaultConfig, getConfigPath, loadConfig, saveConfig } from '../src/config.ts';
import { formatCell, json as toJson, semverCompare, table } from '../src/format.ts';
import { apiRequest, CliError, exitCodeFor } from '../src/wrexctl.ts';

const tempRoots: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrexctl-test-'));
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

test('config path honours XDG_CONFIG_HOME', () => {
  const base = tempDir();
  assert.equal(getConfigPath({ XDG_CONFIG_HOME: base }), path.join(base, 'wrexr', 'cli.json'));
  assert.equal(getConfigPath({ XDG_CONFIG_HOME: '' }), path.join(os.homedir(), '.config', 'wrexr', 'cli.json'));
});

test('config defaults follow WREXR_INSECURE_HTTP', () => {
  assert.equal(defaultConfig({}).url, 'https://localhost:8443');
  assert.deepEqual(defaultConfig({ WREXR_INSECURE_HTTP: '1' }), {
    url: 'http://localhost:8443',
    token: '',
    allowInsecure: true,
  });
});

test('config load/save round-trip and restrictive mode', () => {
  const file = path.join(tempDir(), 'wrexr', 'cli.json');
  assert.deepEqual(loadConfig(file, {}), defaultConfig({}));
  saveConfig(file, { url: 'https://nas.local:8443', token: 'abc', allowInsecure: false });
  assert.deepEqual(loadConfig(file, {}), {
    url: 'https://nas.local:8443',
    token: 'abc',
    allowInsecure: false,
  });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('table and JSON formatting', () => {
  const rendered = table([{ name: 'vm1', state: 'running' }, { name: 'vm2', state: 'stopped' }], ['name', 'state']);
  assert.match(rendered, /NAME/);
  assert.match(rendered, /STATE/);
  assert.match(rendered, /vm1/);
  assert.match(rendered, /stopped/);
  assert.equal(table([]), '(none)');
  assert.equal(formatCell({ a: 1 }), '{"a":1}');
  assert.equal(formatCell(null), '-');
  assert.equal(toJson({ ok: true }), '{\n  "ok": true\n}');
});

test('semver comparison including prereleases', () => {
  assert.equal(semverCompare('1.2.3', '1.2.2'), 1);
  assert.equal(semverCompare('0.1.0', '0.1.0'), 0);
  assert.equal(semverCompare('2.0.0', '10.0.0'), -1);
  assert.equal(semverCompare('1.2.3-beta.2', '1.2.3-beta.10'), -1);
  assert.equal(semverCompare('1.2.3-rc.1', '1.2.3'), -1);
  assert.equal(semverCompare('v1.2.3+build.5', '1.2.3'), 0);
});

test('apiRequest unwraps envelopes and reports API errors', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/v1/ok') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data: { hostname: 'wrexr' } }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'missing' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ctx = {
    baseUrl,
    apiRoot: `${baseUrl}/api/v1`,
    token: 'test-token',
    insecure: false,
    jsonOutput: false,
    configPath: '',
    timeoutMs: 2000,
  };

  try {
    assert.deepEqual(await apiRequest(ctx, 'GET', '/ok'), { hostname: 'wrexr' });
    await assert.rejects(
      () => apiRequest(ctx, 'GET', '/missing'),
      (error: unknown) => error instanceof CliError && error.code === 'NOT_FOUND' && exitCodeFor(error) === 4,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
