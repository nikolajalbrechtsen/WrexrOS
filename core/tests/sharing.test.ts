import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrexr-share-'));
process.env.WREXR_STATE_DIR = stateDir;
process.env.WREXR_DEMO_MODE = '1';

const { initDb, closeDb } = await import('../src/db.ts');
const sharing = await import('../src/services/sharing.ts');

after(() => {
  closeDb();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

initDb({ seedDemo: false });

test('share creation, users, groups and ACLs persist in demo mode', () => {
  const user = sharing.createLocalUser({ username: 'media', groups: ['users'] });
  const group = sharing.createGroup({ name: 'users', members: [user.username] });
  const share = sharing.createShare({
    name: 'media',
    path: '/mnt/user/media',
    protocol: 'smb',
    users: ['media'],
    groups: [group.name],
    recycle: true,
  });
  assert.equal(share.protocol, 'smb');
  assert.deepEqual(share.users, ['media']);
  assert.equal(sharing.listShares().length, 1);
  assert.equal(sharing.getShare(share.id).name, 'media');

  const acl = sharing.updateAcl(share.id, [
    { principal: 'media', type: 'user', permission: 'rw' },
    { principal: 'users', type: 'group', permission: 'r' },
  ]);
  assert.equal(acl.length, 2);
  assert.equal(sharing.getShare(share.id).acl.length, 2);

  const configText = sharing.generateSambaConfig(sharing.listShares());
  assert.match(configText, /\[media\]/);
  assert.match(configText, /vfs objects = recycle/);
  assert.match(configText, /valid users = media/);
});

test('duplicate shares are rejected and shares can be removed', () => {
  assert.throws(
    () => sharing.createShare({ name: 'media', path: '/mnt/other' }),
    (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
  );
  const share = sharing.listShares()[0];
  assert.equal(sharing.deleteShare(share.id).deleted, true);
  assert.equal(sharing.listShares().length, 0);
});
