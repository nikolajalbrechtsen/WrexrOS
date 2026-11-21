// Dependency-free TypeScript -> ESM JavaScript build for WrexrOS.
// Uses Node 24's module.stripTypeScriptTypes, so no compiler package is needed.
import { stripTypeScriptTypes } from 'node:module';
import { readdir, readFile, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// stripTypeScriptTypes keeps module specifiers verbatim, so authored `.ts`
// imports must be rewritten to `.js` for the browser.
function rewriteSpecifiers(code) {
  return code
    .replace(/((?:from|import)\s*["'])([^"']+)\.ts(["'])/g, '$1$2.js$3')
    .replace(/(import\s*\(\s*["'])([^"']+)\.ts(["']\s*\))/g, '$1$2.js$3');
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

let built = 0;
let bytes = 0;

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const files = await walk(SRC);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file });
    const js = rewriteSpecifiers(stripped);
    const relative = path.relative(SRC, file).replace(/\.ts$/, '.js');
    const target = path.join(DIST, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, js, 'utf8');
    built++;
    bytes += Buffer.byteLength(js);
  }

  await copyFile(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
  await copyFile(path.join(ROOT, 'styles.css'), path.join(DIST, 'styles.css'));
  await copyFile(path.join(SRC, 'logo.svg'), path.join(DIST, 'logo.svg'));

  console.log(`[wrexros] built ${built} TypeScript modules -> dist (${(bytes / 1024).toFixed(1)} KiB JS)`);
  console.log('[wrexros] copied index.html, styles.css, logo.svg');
}

main().catch((err) => {
  console.error('[wrexros] build failed:', err);
  process.exitCode = 1;
});
