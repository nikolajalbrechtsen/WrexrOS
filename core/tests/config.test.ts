import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';

test('WREXR_CONFIG TOML startup values are applied', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wrexr-config-'));
  const toml = path.join(dir, 'wrexrd.toml');
  writeFileSync(
    toml,
    [
      '# installer-generated config',
      'port = 9443',
      'demoMode = true',
      'updateChannel = "beta"',
      'repoUrl = "https://example.invalid/repo" # trailing comment',
      'tls = true',
      'tlsCert = "/var/lib/wrexr/tls/cert.pem"',
      '',
      '[log]',
      'level = "warn"',
      '',
    ].join('\n'),
    'utf8',
  );

  const keys = [
    'WREXR_CONFIG',
    'WREXR_PORT',
    'WREXR_DEMO_MODE',
    'WREXR_CHANNEL',
    'WREXR_UPDATE_REPO',
    'WREXR_INSECURE_HTTP',
    'WREXR_TLS_CERT',
    'WREXR_LOG_LEVEL',
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.WREXR_CONFIG = toml;

  try {
    const config = loadConfig({ stateDir: dir });
    assert.equal(config.port, 9443);
    assert.equal(config.demoMode, true);
    assert.equal(config.channel, 'beta');
    assert.equal(config.updateRepo, 'https://example.invalid/repo');
    assert.equal(config.insecureHttp, false);
    assert.equal(config.tlsCert, path.resolve('/var/lib/wrexr/tls/cert.pem'));
    assert.equal(config.logLevel, 'warn');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
