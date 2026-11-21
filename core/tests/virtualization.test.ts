import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrexr-vm-'));
process.env.WREXR_STATE_DIR = stateDir;
process.env.WREXR_DEMO_MODE = '1';

const { initDb, closeDb, get } = await import('../src/db.ts');
const virtualization = await import('../src/services/virtualization.ts');

after(() => {
  closeDb();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

initDb({ seedDemo: false });

test('VM lifecycle in demo mode: create, actions, snapshots, firewall, delete', async () => {
  const created = await virtualization.createVm({
    name: 'test-vm',
    type: 'kvm',
    cpu: 2,
    memory: 2048,
    disk: 32,
    network: 'br0',
  });
  assert.equal(created.name, 'test-vm');
  assert.equal(created.status, 'stopped');

  const started = await virtualization.vmAction(created.id, 'start');
  assert.equal(started.status, 'running');
  const snapshot = await virtualization.vmAction(created.id, 'snapshot');
  assert.equal(snapshot.snapshots.length, 1);
  assert.equal((await virtualization.vmAction(created.id, 'stop')).status, 'stopped');

  const rules = virtualization.setFirewall(created.id, [
    { action: 'allow', protocol: 'tcp', port: 22, source: '192.168.1.0/24' },
  ]);
  assert.equal(rules.length, 1);
  assert.equal(virtualization.getFirewall(created.id)[0].port, 22);
  assert.equal(virtualization.vncInfo(created.id).port, created.vncPort);

  const deleted = await virtualization.deleteVm(created.id);
  assert.equal(deleted.deleted, true);
  assert.equal(get('vms', created.id), null);
});

test('bridges, templates and PCI inventory work without host commands in demo mode', async () => {
  const bridge = virtualization.createBridge({ name: 'br-test', ports: ['eth0'], vlanAware: true, tag: 10 });
  assert.equal(bridge.name, 'br-test');
  assert.ok(virtualization.listBridges().some((item) => item.name === 'br-test'));
  assert.equal(virtualization.listTemplates().length, 3);
  const template = virtualization.createTemplate({ name: 'custom', type: 'lxc', cpu: 1, memory: 512, disk: 8 });
  assert.equal(template.name, 'custom');
  const pci = await virtualization.pciList();
  assert.ok(pci.devices.length >= 3);
  assert.equal(typeof pci.devices[0].iommuGroup, 'number');
});
