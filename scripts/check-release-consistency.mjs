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
  const build = read('packaging/build-iso.sh');
  if (build.includes('wrexr.install=standard"')) {
    problems.push('packaging/build-iso.sh still sets a global wrexr.install=standard default');
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
