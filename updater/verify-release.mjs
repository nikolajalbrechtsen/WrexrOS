#!/usr/bin/env node
/** Verify a downloaded asset against SHA256SUMS and (optionally) a detached GPG signature. */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const GPG = 'gpg'; // allowlisted binary name; execFile is called with shell: false

function usage() {
  process.stdout.write(`Usage: verify-release.mjs <asset> <SHA256SUMS> [signature] [options]
  --keyring PATH        GPG keyring to trust (default: GPG defaults)
  --require-signature   fail when no detached signature is supplied
  --help                show this help

The signature, when supplied, must be detached over the SHA256SUMS file.`);
}

function parseArgs(argv) {
  const options = { asset: '', sums: '', signature: '', keyring: '', requireSignature: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--require-signature') options.requireSignature = true;
    else if (token === '--keyring' || token.startsWith('--keyring=')) {
      const value = token === '--keyring' ? argv[++i] : token.slice('--keyring='.length);
      if (!value) throw new Error('--keyring requires a path');
      options.keyring = value;
    } else if (token.startsWith('-')) throw new Error(`unknown option: ${token}`);
    else positional.push(token);
  }
  [options.asset, options.sums, options.signature] = positional;
  if (!options.help && (!options.asset || !options.sums)) {
    throw new Error('asset and SHA256SUMS paths are required');
  }
  return options;
}

function parseChecksums(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([a-fA-F0-9]{64})\s+[* ]?(.+)$/.exec(trimmed);
    if (!match) continue;
    result.set(path.basename(match[2].trim()), match[1].toLowerCase());
  }
  return result;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function verifySignature(signature, sums, keyring) {
  const args = [];
  if (keyring) args.push('--no-default-keyring', '--keyring', keyring);
  args.push('--verify', signature, sums);
  return new Promise((resolve, reject) => {
    execFile(GPG, args, { shell: false, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`GPG verification failed: ${(stderr || error.message).trim()}`));
      else resolve((stderr || stdout).trim());
    });
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    usage();
    return;
  }
  if (options.requireSignature && !options.signature) {
    process.stderr.write('error: a signing key is configured; refusing unsigned update\n');
    process.exitCode = 1;
    return;
  }

  try {
    const sumsText = fs.readFileSync(options.sums, 'utf8');
    const checksums = parseChecksums(sumsText);
    const name = path.basename(options.asset);
    const expected = checksums.get(name);
    if (!expected) throw new Error(`${name} is not listed in ${options.sums}`);
    const actual = await hashFile(options.asset);
    if (actual !== expected) throw new Error(`SHA256 mismatch for ${name}: expected ${expected}, got ${actual}`);
    process.stdout.write(`SHA256 OK  ${name}\n`);

    if (options.signature) {
      const keyring = options.keyring || (fs.existsSync('/etc/wrexr/trusted-updates.gpg') ? '/etc/wrexr/trusted-updates.gpg' : '');
      const report = await verifySignature(options.signature, options.sums, keyring);
      process.stdout.write(`GPG OK     ${report.split('\n')[0]}\n`);
    }
  } catch (error) {
    process.stderr.write(`verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

main();
