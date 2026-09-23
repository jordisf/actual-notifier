'use strict';

/**
 * Panel config persistence (data-model.md):
 *  - .env key=value read/write, preserving unrelated lines/comments/order.
 *  - thin wrappers over src/store.js's existing `kv` table for panel-only state.
 */

const fs = require('fs');

const ENV_PATH_DEFAULT = '/app/.env';

function envPath() {
  return process.env.PANEL_ENV_PATH || ENV_PATH_DEFAULT;
}

/** Parse one raw line into a descriptor; non key=value lines (comments, blanks) have key: null. */
function parseLine(raw) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(raw);
  if (m) return { raw, key: m[1], value: m[2] };
  return { raw, key: null, value: null };
}

/**
 * Read a file into line descriptors, stripping (and separately tracking) a
 * single trailing newline so join-back never duplicates it. A missing/empty
 * file behaves as zero lines with an implied trailing newline.
 */
function readLines(filePath) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (text === '') return { lines: [], trailingNewline: true };
  const trailingNewline = /\r?\n$/.test(text);
  const body = trailingNewline ? text.replace(/\r?\n$/, '') : text;
  const lines = body === '' ? [] : body.split(/\r?\n/);
  return { lines: lines.map(parseLine), trailingNewline };
}

function writeLines(filePath, descriptors, trailingNewline) {
  const out = descriptors.map((l) => l.raw).join('\n') + (trailingNewline ? '\n' : '');
  fs.writeFileSync(filePath, out, 'utf8');
}

/** Read a single key's value from the .env file. Returns null if absent or file missing. */
function envGet(key, filePath = envPath()) {
  if (!fs.existsSync(filePath)) return null;
  const { lines } = readLines(filePath);
  const found = lines.find((l) => l.key === key);
  return found ? found.value : null;
}

/**
 * Replace the matching `KEY=` line in place, or append if missing.
 * Never reorders or drops unrelated lines/comments.
 */
function envSet(key, value, filePath = envPath()) {
  const { lines, trailingNewline } = readLines(filePath);
  let replaced = false;
  const next = lines.map((l) => {
    if (l.key === key) {
      replaced = true;
      return { raw: `${key}=${value}`, key, value };
    }
    return l;
  });
  if (!replaced) next.push({ raw: `${key}=${value}`, key, value });
  writeLines(filePath, next, trailingNewline);
}

/** Set several .env keys atomically (single read + single write). */
function envSetMany(pairs, filePath = envPath()) {
  const { lines, trailingNewline } = readLines(filePath);
  const remaining = new Map(Object.entries(pairs));
  const next = lines.map((l) => {
    if (l.key !== null && remaining.has(l.key)) {
      const value = remaining.get(l.key);
      remaining.delete(l.key);
      return { raw: `${l.key}=${value}`, key: l.key, value };
    }
    return l;
  });
  for (const [key, value] of remaining) next.push({ raw: `${key}=${value}`, key, value });
  writeLines(filePath, next, trailingNewline);
}

// --- crontab.txt (single-line schedule file; research.md mtime-watcher) ---

const CRONTAB_PATH_DEFAULT = '/app/crontab.txt';

function cronPath() {
  return process.env.PANEL_CRONTAB_PATH || CRONTAB_PATH_DEFAULT;
}

/** Read crontab.txt's raw content verbatim (empty string if the file is missing). */
function cronRead(filePath = cronPath()) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

/** Overwrite crontab.txt's content verbatim; entrypoint.sh's mtime-watcher reinstalls it. */
function cronWrite(content, filePath = cronPath()) {
  fs.writeFileSync(filePath, content, 'utf8');
}

// --- kv wrappers (thin pass-through to src/store.js's existing kv table) ---

const { kvGet, kvSet } = require('../store');

module.exports = {
  envGet,
  envSet,
  envSetMany,
  cronPath,
  cronRead,
  cronWrite,
  kvGet,
  kvSet,
};
