#!/usr/bin/env node
/** Fail the build when release-facing version strings drift apart. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const problems = [];

let version = '';
try {
  version = read('VERSION').trim();
} catch (error) {
  problems.push(`cannot read VERSION: ${error.message}`);
}
if (version && !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) {
  problems.push(`VERSION has an invalid release format: ${version}`);
}

const expectText = (file, needle) => {
  try {
    if (!read(file).includes(needle)) problems.push(`${file} does not contain ${JSON.stringify(needle)}`);
  } catch (error) {
    problems.push(`cannot read ${file}: ${error.message}`);
  }
};

const expectJsonVersion = (file) => {
  try {
    const parsed = JSON.parse(read(file));
    if (parsed.version !== version) problems.push(`${file} version is ${parsed.version}, expected ${version}`);
  } catch (error) {
    problems.push(`cannot validate ${file}: ${error.message}`);
  }
};

if (version) {
  expectText('core/VERSION', `${version}\n`);
  expectJsonVersion('package.json');
  expectJsonVersion('core/package.json');
  expectJsonVersion('cli/package.json');
  expectText('cli/src/wrexctl.ts', `const CLI_VERSION = '${version}';`);

  const system = read('core/src/system.ts');
  const fallbackCount = system.split(`'${version}'`).length - 1;
  if (fallbackCount < 2) {
    problems.push(`core/src/system.ts has ${fallbackCount} version fallback(s), expected at least 2`);
  }
  expectText('core/tests/updates.test.ts', `check.current, '${version}'`);
  expectText('boot/issue', `WrexrOS ${version}`);
  expectText('boot/wrexr-console.sh', `WREXR_VERSION:-${version}`);
  expectText('packaging/build-iso.sh', `VERSION="${version}"`);
  expectText('screenshots/dashboard.svg', `v${version}`);
  expectText('screenshots/console.svg', `WrexrOS ${version}`);
  expectText('CHANGELOG.md', `## [${version}]`);
  expectText('CHANGELOG.md', `[${version}]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v${version}`);
}

for (const file of [
  'installer/examples/unattended-standard.json',
  'installer/examples/unattended-zfs-raid.json',
  'installer/examples/unattended-parity-array.json',
]) {
  try {
    if (read(file).includes('/cdrom/')) problems.push(`${file} uses an obsolete /cdrom path`);
  } catch (error) {
    problems.push(`cannot read ${file}: ${error.message}`);
  }
}

try {
  const disk = read('installer/functions/disk.sh');
  if (/\(\(.*&&\s*-n\s/.test(disk)) {
    problems.push('installer/functions/disk.sh uses -n inside arithmetic; this fails under set -u');
  }
  const diskCommands = disk.split('\n').map((line) => line.replace(/#.*$/, ''));
  if (diskCommands.some((line) => /\blsblk\b[^\n]*\s-e\s+(?:[^\n]*\bloop\b|[^\n]*\brom\b)/.test(line))) {
    problems.push('installer/functions/disk.sh uses lsblk -e with device names; filter TYPE in the shell instead');
  }
} catch (error) {
  problems.push(`cannot read installer/functions/disk.sh: ${error.message}`);
}

try {
  const installer = read('installer/wrexr-installer.sh');
  for (const needle of ['ui_init', '--no-color', 'ui_summary', 'ui_firmware_label']) {
    if (!installer.includes(needle)) {
      problems.push(`installer/wrexr-installer.sh is missing adaptive UI helper ${needle}`);
    }
  }
  for (const needle of ['tui_init', 'tui_menu', 'tui_msgbox', 'ask_secret']) {
    if (!installer.includes(needle)) {
      problems.push(`installer/wrexr-installer.sh is missing full-screen installer helper ${needle}`);
    }
  }
  const uiWriteBody = installer.match(/ui_write\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  if (/\|\s*ui_write\b/.test(uiWriteBody)) {
    problems.push('installer/wrexr-installer.sh has a recursive ui_write pipeline');
  }
} catch (error) {
  problems.push(`cannot read installer/wrexr-installer.sh: ${error.message}`);
}

try {
  const tui = read('installer/functions/tui.sh');
  for (const needle of ['whiptail', '--menu', '--radiolist', '--passwordbox', 'tui_progress']) {
    if (!tui.includes(needle)) {
      problems.push(`installer/functions/tui.sh is missing full-screen dialog support: ${needle}`);
    }
  }
} catch (error) {
  problems.push(`cannot read installer/functions/tui.sh: ${error.message}`);
}

try {
  if (!/^whiptail$/m.test(read('packaging/packages.list'))) {
    problems.push('packaging/packages.list must include whiptail for the full-screen installer');
  }
} catch (error) {
  problems.push(`cannot read packaging/packages.list: ${error.message}`);
}

for (const shellFile of [
  'installer/wrexr-installer.sh',
  'installer/functions/disk.sh',
  'installer/functions/network.sh',
  'installer/functions/base.sh',
  'installer/functions/bootloader.sh',
  'installer/functions/finish.sh',
  'installer/functions/tui.sh',
]) {
  try {
    read(shellFile).split('\n').forEach((line, index) => {
      const match = line.match(/^\s*local\s+(.*)$/);
      if (!match) return;
      const names = [...match[1].matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((item) => item[1]);
      for (const name of names) {
        if (new RegExp(`\\$\\{?${name}(?:\\W|$)`).test(match[1])) {
          problems.push(`${shellFile}:${index + 1} references ${name} inside its own local declaration`);
        }
      }
    });
  } catch (error) {
    problems.push(`cannot read ${shellFile}: ${error.message}`);
  }
}

try {
  const build = read('packaging/build-iso.sh');
  if (build.includes('wrexr.install=standard"')) {
    problems.push('packaging/build-iso.sh still sets a global wrexr.install=standard default');
  }
  if (build.includes('wrexrd.service wrexr-console.service')) {
    problems.push('packaging/build-iso.sh still enables appliance units in the live image');
  }
  if (build.includes('timers.target.wants/wrexr-updater.timer')) {
    problems.push('packaging/build-iso.sh still enables the updater timer in the live image');
  }
  if (!build.includes('/etc/systemd/system/docker.service')) {
    problems.push('packaging/build-iso.sh does not mask Docker in the live image');
  }
} catch (error) {
  problems.push(`cannot read packaging/build-iso.sh: ${error.message}`);
}

if (process.env.RELEASE_TAG) {
  const tagVersion = process.env.RELEASE_TAG.replace(/^v/i, '');
  if (tagVersion !== version) {
    problems.push(`release tag ${process.env.RELEASE_TAG} does not match VERSION ${version}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`version consistency: ${problem}\n`);
  process.exit(1);
}
process.stdout.write(`version consistency OK (${version})\n`);
