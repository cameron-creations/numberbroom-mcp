#!/usr/bin/env node
// Does node_modules hold exactly what package-lock.json pins?
//
//     node scripts/lockfile-matches-install.mjs [dir] [--omit-dev]
//
// Exits 0 when it does, 1 with the first few differences when it does not.
// scripts/setup-worktree.sh runs `npm ci` on a 1. Pass --omit-dev for a folder
// installed with `npm ci --omit=dev`, so dev-only packages may be absent.
//
// Why: a worktree clones node_modules from the primary checkout, which may sit
// on an older commit. BeetrootPro's worktrees and pre-push builds ran an old
// Next.js for ten days that way (2026-10), behind a warning nobody read.
//
// How: npm writes the tree it actually installed to
// node_modules/.package-lock.json (the "hidden lockfile", npm 7+), so compare
// that with package-lock.json. Assumes a dev install (`npm ci`) unless
// --omit-dev is given.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const omitDev = args.includes('--omit-dev');
const dir = args.find((a) => !a.startsWith('--')) ?? process.cwd();

function packagesOf(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).packages ?? null;
  } catch {
    return null;
  }
}

const locked = packagesOf(join(dir, 'package-lock.json'));
const installed = packagesOf(join(dir, 'node_modules', '.package-lock.json'));
if (!locked) {
  console.error(`no readable package-lock.json in ${dir}`);
  process.exit(1);
}
if (!installed) {
  console.error('node_modules has no .package-lock.json, so what is installed is unknown');
  process.exit(1);
}

// True when this package, or one it is nested under, only installs on some
// platforms (os, cpu or libc).
function platformGated(path) {
  const parts = path.split('/node_modules/');
  for (let i = parts.length; i > 0; i--) {
    const entry = locked[parts.slice(0, i).join('/node_modules/')];
    if (entry && (entry.os || entry.cpu || entry.libc)) return true;
  }
  return false;
}

// npm skips an optional package it cannot install (platform binaries are
// locked for every platform and installed for one). devOptional is different:
// a dev install always installs it, unless it is itself a platform binary.
// With --omit-dev, a package only dev dependencies reach is not installed.
function mayBeAbsent(path, entry) {
  if (entry.optional) return true;
  if (omitDev && entry.dev) return true;
  if (entry.devOptional) return platformGated(path);
  return false;
}

const problems = [];
for (const [path, entry] of Object.entries(locked)) {
  if (path === '' || entry.link) continue;
  const have = installed[path];
  if (!have) {
    if (!mayBeAbsent(path, entry)) problems.push(`${path}: locked ${entry.version}, not installed`);
  } else if (entry.version && have.version !== entry.version) {
    problems.push(`${path}: locked ${entry.version}, installed ${have.version}`);
  }
}
// Installed but no longer locked: code that still imports it passes here and
// fails on a clean install.
for (const [path, entry] of Object.entries(installed)) {
  if (!(path in locked)) problems.push(`${path}: installed ${entry.version}, not in package-lock.json`);
}

if (problems.length) {
  console.error(`${problems.length} package(s) differ from package-lock.json:`);
  for (const p of problems.slice(0, 5)) console.error(`  ${p}`);
  if (problems.length > 5) console.error(`  ...and ${problems.length - 5} more`);
  process.exit(1);
}
console.log('node_modules matches package-lock.json');
