#!/usr/bin/env node
/** Check GitHub releases for a newer WrexrOS version. No external dependencies. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_API = 'https://api.github.com/repos/nikolajalbrechtsen/WrexrOS/releases/latest';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERSION_FILE = path.resolve(SCRIPT_DIR, '..', 'VERSION');

function parseArgs(argv) {
  const options = { channel: 'stable', json: false, quiet: false, timeoutMs: 10000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--json') options.json = true;
    else if (token === '--quiet') options.quiet = true;
    else if (token === '--channel' || token.startsWith('--channel=')) {
      const value = token === '--channel' ? argv[++i] : token.slice('--channel='.length);
      if (value !== 'stable' && value !== 'beta') throw new Error('--channel must be stable or beta');
      options.channel = value;
    } else if (token === '--timeout' || token.startsWith('--timeout=')) {
      const value = token === '--timeout' ? argv[++i] : token.slice('--timeout='.length);
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--timeout must be a positive number of milliseconds');
      options.timeoutMs = parsed;
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return options;
}

function compareSemver(a, b) {
  const parse = (input) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(input).trim());
    if (!match) return null;
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) return Number(l) - Number(r);
    if (lNum) return -1;
    if (rNum) return 1;
    return l.localeCompare(r);
  }
  return 0;
}

function releaseBase(api) {
  const clean = api.replace(/\/+$/, '');
  return clean.endsWith('/releases/latest') ? clean.slice(0, -'/releases/latest'.length) : clean;
}

function describeRelease(release) {
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const assets = Array.isArray(release.assets) ? release.assets.map((asset) => ({
    name: String(asset.name ?? ''),
    size: Number(asset.size ?? 0),
    downloadUrl: String(asset.browser_download_url ?? asset.url ?? ''),
    contentType: String(asset.content_type ?? ''),
  })) : [];
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    releaseUrl: String(release.html_url ?? ''),
    publishedAt: String(release.published_at ?? ''),
    prerelease: release.prerelease === true,
    assets,
  };
}

async function getJson(url, timeoutMs) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'wrexr-check-update',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot reach GitHub (${url}): ${detail}. Check network connectivity or WREXR_REPO_API.`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const remaining = response.headers.get('x-ratelimit-remaining');
    const isRateLimit = remaining === '0' || (response.status === 403 && /rate limit/i.test(body));
    if (isRateLimit) {
      const reset = response.headers.get('x-ratelimit-reset');
      const when = reset ? ` Resets at ${new Date(Number(reset) * 1000).toISOString()}.` : '';
      throw new Error(`GitHub API rate limit exceeded.${when} Set GITHUB_TOKEN or retry later.`);
    }
    throw new Error(`GitHub API returned HTTP ${response.status} for ${url}: ${body.slice(0, 200)}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`GitHub returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write('Usage: check-update.mjs [--channel stable|beta] [--json] [--quiet] [--timeout MS]\n');
    return;
  }

  const fail = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`update check failed: ${message}\n`);
    process.exitCode = 2;
  };

  let current;
  try {
    current = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch (error) {
    fail(new Error(`cannot read ${VERSION_FILE}: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  if (!current) {
    fail(new Error(`${VERSION_FILE} is empty`));
    return;
  }

  const api = process.env.WREXR_REPO_API || DEFAULT_REPO_API;

  try {
    const stable = describeRelease(await getJson(api, options.timeoutMs));
    let chosen = stable;

    if (options.channel === 'beta') {
      const releases = await getJson(`${releaseBase(api)}/releases?per_page=20`, options.timeoutMs);
      if (!Array.isArray(releases)) throw new Error('GitHub prerelease endpoint did not return a list');
      const prereleases = releases
        .filter((release) => release && release.prerelease === true)
        .map(describeRelease)
        .filter((release) => release.tag.length > 0);
      for (const candidate of prereleases) {
        if (compareSemver(candidate.version, chosen.version) > 0) chosen = candidate;
      }
    }

    if (!chosen.tag) throw new Error('no release tag found in GitHub response');
    const result = {
      current,
      latest: chosen.version,
      updateAvailable: compareSemver(chosen.version, current) > 0,
      releaseUrl: chosen.releaseUrl,
      publishedAt: chosen.publishedAt,
      assets: chosen.assets,
    };
    if (!options.quiet) process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.current} -> ${result.latest}: ${result.updateAvailable ? 'update available' : 'up to date'}\n${result.releaseUrl}\n`);
  } catch (error) {
    fail(error);
  }
}

main();
