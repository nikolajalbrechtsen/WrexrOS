import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrexr-updates-'));
process.env.WREXR_STATE_DIR = stateDir;
process.env.WREXR_DEMO_MODE = '1';

const { initDb, closeDb } = await import('../src/db.ts');
const { semverCompare, isNewerVersion } = await import('../src/util.ts');
const updates = await import('../src/services/updates.ts');

after(() => {
  closeDb();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

initDb({ seedDemo: false });

test('semver comparison handles versions, v-prefixes and prereleases', () => {
  assert.equal(semverCompare('0.1.0', '0.2.0'), -1);
  assert.equal(semverCompare('v1.2.0', '1.2.0'), 0);
  assert.equal(semverCompare('1.10.0', '1.9.9'), 1);
  assert.equal(semverCompare('2.0.0-rc.1', '2.0.0'), -1);
  assert.equal(semverCompare('2.0.0-rc.2', '2.0.0-rc.1'), 1);
  assert.equal(isNewerVersion('0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.2.0'), false);
});

test('demo update check and install job avoid network access', async () => {
  const check = await updates.checkUpdates();
  assert.equal(check.current, '0.1.6');
  assert.equal(check.latest, '0.2.0');
  assert.equal(check.updateAvailable, true);
  assert.match(check.releaseUrl, /github\.com/);

  const job = updates.installUpdate();
  assert.match(job.jobId, /^[0-9a-f-]{36}$/);
  const status = updates.updateStatus();
  assert.equal(status.jobId, job.jobId);
  assert.ok(status.progress >= 0 && status.progress <= 100);
  assert.ok(['running', 'success'].includes(status.state));
  assert.equal(updates.repoInfo().repository, 'nikolajalbrechtsen/WrexrOS');
  assert.deepEqual(updates.appUpdates(), []);
});
