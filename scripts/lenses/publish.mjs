#!/usr/bin/env node
// Publish the lens catalogue to R2 (spec §3, §9).
//
//   ┌──────────────────────────────────────────────────────────────────────────────────────┐
//   │ DO NOT RUN without the owner's explicit OK. Without --yes-publish it does nothing.    │
//   └──────────────────────────────────────────────────────────────────────────────────────┘
//
//   node scripts/lenses/publish.mjs --yes-publish --dry-run   plan only: reads the live index, writes nothing
//   node scripts/lenses/publish.mjs --yes-publish             upload
//   options: --dist-dir <dir> · --wrangler <path to wrangler.js> (default: the global install)
//
// What it does, in order (any problem stops it before anything is uploaded):
//   1. Checks lenses/dist (spec §2.3 rules, index ↔ files ↔ bundled copies). The index must list
//      exactly motion, design and thumbnail (the only lenses apps install), and every bundled
//      file needs its source in lenses/src, built from the current source.
//   2. Runs wrangler with XDG_CONFIG_HOME="E:/DP 2/qooti 2.0/worker/.wrangler-azeez" and account
//      776b8a27d81b7766e6957af20242d7f6 (verified with `wrangler whoami`), from the qooti 2.0 repo
//      root (`npx wrangler` inside worker/ crashes on r2 puts, arch doc §51.1).
//   3. Reads the live index from R2 and the public URL. It counts as "not published yet" only
//      when R2 returns nothing AND the public URL answers 404 with no network error; any other
//      failure (network, login, HTTP 200 or 5xx while R2 gave nothing, unreadable JSON) stops.
//      The new serial must be higher; a lens version may never go down, and an already-published
//      id+version must keep its sha256 (bump the version instead).
//   4. Backs up the live index to worker/backups/qooti-lenses-<date>-before-serial-<n>.json and
//      reads the backup back. Without a backup the index is never uploaded (unless none is live).
//   5. Uploads only qooti-lens-* files that aren't live yet (bucket qooti-releases), each verified
//      by downloading it again and comparing sha256 — lens files first, the index LAST.
//   6. Checks the public URLs (https://api.bloot.app/download/<file>) and warns about stale caches.
//   Rollback: put the backup file back as qooti-releases/qooti-lenses.json.
// The steps are exported (checkLocalCatalogue, decideLive, backupLive, publish) so the tests can
// run them with stand-ins for wrangler and the network; the tests never run wrangler.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs, runMain } from './lib/args.mjs';
import { DIST_DIR, BUNDLED_DIR, SRC_DIR } from './lib/paths.mjs';
import { checkBuilt, printIssues, KNOWN_ROLES } from './check.mjs';

export const XDG_CONFIG_HOME = 'E:/DP 2/qooti 2.0/worker/.wrangler-azeez';
export const ACCOUNT_ID = '776b8a27d81b7766e6957af20242d7f6';
export const BUCKET = 'qooti-releases';
export const REPO_ROOT = 'E:/DP 2/qooti 2.0';
export const BACKUP_DIR = 'E:/DP 2/qooti 2.0/worker/backups';
export const PUBLIC_BASE = 'https://api.bloot.app/download/';
export const INDEX_KEY = 'qooti-lenses.json';
const LENS_KEY = /^qooti-lens-[a-z][a-z0-9_]*-\d+-[0-9a-f]{12}\.json$/;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

function defaultWrangler() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
}

function makeWrangler(jsPath) {
  if (!fs.existsSync(jsPath)) throw new Error(`wrangler not found at ${jsPath} (pass --wrangler <path to wrangler.js>)`);
  if (!fs.existsSync(XDG_CONFIG_HOME)) throw new Error(`wrangler config folder missing: ${XDG_CONFIG_HOME}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(jsPath), '..', 'package.json'), 'utf8'));
  const major = Number(String(pkg.version).split('.')[0]);
  const env = { ...process.env, XDG_CONFIG_HOME, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };
  const run = (args, { allowFail = false } = {}) => {
    const r = spawnSync(process.execPath, [jsPath, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0 && !allowFail) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${out.slice(-2000)}`);
    return { ok: r.status === 0, out };
  };
  const remote = major >= 4 ? ['--remote'] : [];
  return {
    version: pkg.version,
    whoami: () => run(['whoami']).out,
    get(key, file) {
      const r = run(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, ...remote], { allowFail: true });
      return r.ok && fs.existsSync(file) ? fs.readFileSync(file) : null;
    },
    put(key, file) {
      if (key !== INDEX_KEY && !LENS_KEY.test(key)) throw new Error(`refusing to write ${key}: only qooti-lens-* files and ${INDEX_KEY}`);
      run(['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--content-type', 'application/json', ...remote]);
    },
  };
}

/** GET a public URL, uncached: {status, buf} (buf only on 2xx), or {status: 0, error} on a network error. */
export async function fetchPublic(key) {
  try {
    const res = await fetch(`${PUBLIC_BASE}${key}?v=${Date.now()}`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
    if (res.status === 404) return { status: 404, buf: null };
    return { status: res.status, buf: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
  } catch (e) {
    return { status: 0, buf: null, error: e.message || String(e) };
  }
}

/** check.mjs warnings that still block a publish. */
const PUBLISH_BLOCKERS = new Set([
  'built.no_source',     // a bundled lens with no source in lenses/src (a stray or leftover file)
  'built.stale',         // the source changed after the last build: the files are not what the source says
  'index.not_bundled',   // the index lists a lens the app doesn't bundle
]);

/**
 * Step 1: the local catalogue must be complete and clean. Returns {index, indexBuf, indexPath}.
 * Stops on any check.mjs error, on PUBLISH_BLOCKERS, and on an index that doesn't list exactly
 * motion, design and thumbnail once each (apps install no other lens and could never remove one).
 */
export function checkLocalCatalogue({ distDir = DIST_DIR, bundledDir = BUNDLED_DIR, srcDir = SRC_DIR, log = console.log } = {}) {
  const { issues } = checkBuilt({ bundledDir, distDir, srcDir, focus: null });
  printIssues(issues, log === console.log ? console : { error: log, log });
  const blocking = issues.filter((i) => i.level === 'error' || PUBLISH_BLOCKERS.has(i.code));
  if (blocking.length) {
    throw new Error(`the local catalogue has ${blocking.length} problem(s) that block publishing (${[...new Set(blocking.map((i) => i.code))].join(', ')}); fix them and rebuild`);
  }
  const indexPath = path.join(distDir, INDEX_KEY);
  if (!fs.existsSync(indexPath)) throw new Error('no lenses/dist/qooti-lenses.json: run build.mjs first');
  const indexBuf = fs.readFileSync(indexPath);
  const index = JSON.parse(indexBuf.toString('utf8'));
  const ids = (index.lenses || []).map((e) => e && e.id);
  const unknown = ids.filter((id) => !Object.hasOwn(KNOWN_ROLES, id));
  if (unknown.length) throw new Error(`the index lists ${unknown.map(String).join(', ')}: only ${Object.keys(KNOWN_ROLES).join(', ')} may be published`);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length) throw new Error(`the index lists ${[...new Set(twice)].join(', ')} more than once`);
  for (const id of Object.keys(KNOWN_ROLES)) {
    if (!ids.includes(id)) throw new Error(`the index has no ${id} lens; publish all three together`);
  }
  for (const e of index.lenses) if (!LENS_KEY.test(e.file)) throw new Error(`unexpected file name ${e.file}`);
  return { index, indexBuf, indexPath };
}

/**
 * Step 3: what is live. `r2`: the bytes `wrangler r2 object get` returned, or null when it failed
 * (for whatever reason). `pub`: the public URL's answer. The index counts as missing only when R2
 * gave nothing AND the public URL answered 404 with no network error; every other case stops
 * here, before anything is uploaded. Returns {live, liveBuf} (both null when missing).
 */
export function decideLive(r2, pub) {
  if (r2 == null) {
    if (pub && pub.status === 404 && !pub.error) return { live: null, liveBuf: null };
    const what = !pub ? 'nothing' : pub.error ? `a network error (${pub.error})` : `HTTP ${pub.status}`;
    throw new Error(`couldn't read the live ${INDEX_KEY} from R2, and the public URL answered ${what}. `
      + 'Stopped before uploading anything: the index counts as not published only when R2 has nothing and the public URL answers 404.');
  }
  const liveBuf = Buffer.from(r2);
  let live;
  try { live = JSON.parse(liveBuf.toString('utf8')); } catch (e) {
    throw new Error(`the live ${INDEX_KEY} in R2 isn't valid JSON (${e.message}). Stopped before uploading anything.`);
  }
  if (!live || typeof live !== 'object' || !Number.isInteger(live.serial) || !Array.isArray(live.lenses)) {
    throw new Error(`the live ${INDEX_KEY} in R2 doesn't look like a lens index. Stopped before uploading anything.`);
  }
  return { live, liveBuf };
}

/**
 * Step 4: writes the live index to `backupDir` (flushed to disk), reads it back and compares.
 * Never overwrites a different earlier backup. Returns the backup's path; throws if it can't.
 */
export function backupLive(liveBuf, { backupDir = BACKUP_DIR, date = today(), serial }) {
  const want = sha256(liveBuf);
  fs.mkdirSync(backupDir, { recursive: true });
  const base = `qooti-lenses-${date}-before-serial-${serial}`;
  let file = path.join(backupDir, `${base}.json`);
  for (let i = 2; fs.existsSync(file) && sha256(fs.readFileSync(file)) !== want; i++) file = path.join(backupDir, `${base}-${i}.json`);
  if (!fs.existsSync(file)) {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeSync(fd, liveBuf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (sha256(fs.readFileSync(file)) !== want) throw new Error(`the backup ${file} doesn't match the live index`);
  return file;
}

/**
 * Steps 1–6. `wrangler`: {version, whoami(), get(key, file) → Buffer|null, put(key, file)};
 * `fetchPublic(key)` → {status, buf, error?}. Returns what it did; throws to stop.
 */
export async function publish({
  distDir = DIST_DIR, bundledDir = BUNDLED_DIR, srcDir = SRC_DIR, dry = false,
  wrangler, fetchPublic: getPublic = fetchPublic, backupDir = BACKUP_DIR, date = today(), log = console.log,
}) {
  // 1. Local catalogue.
  const { index, indexBuf, indexPath } = checkLocalCatalogue({ distDir, bundledDir, srcDir, log });
  log(`local index: serial ${index.serial}, ${index.lenses.map((e) => `${e.id} v${e.version}`).join(', ')}`);

  // 2. Wrangler, pinned to the owner's account.
  const who = wrangler.whoami();
  if (!String(who).includes(ACCOUNT_ID)) throw new Error(`wrangler is not signed in to account ${ACCOUNT_ID} with ${XDG_CONFIG_HOME}`);
  log(`wrangler ${wrangler.version}: account ${ACCOUNT_ID} ok (XDG_CONFIG_HOME=${XDG_CONFIG_HOME})`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qooti-lens-publish-'));
  try {
    // 3. Live state: stop on anything but a confirmed "not published yet".
    const r2 = wrangler.get(INDEX_KEY, path.join(tmp, 'live-index.json'));
    const pub = await getPublic(INDEX_KEY);
    const { live, liveBuf } = decideLive(r2, pub);
    log(`live index in R2: ${live ? `serial ${live.serial}, ${live.lenses.map((e) => `${e && e.id} v${e && e.version}`).join(', ')}` : 'none yet (R2 has nothing, the public URL answers 404)'}; public URL: ${!pub ? 'no answer' : pub.error ? `network error (${pub.error})` : `HTTP ${pub.status}`}`);
    if (live) {
      if (!(index.serial > live.serial)) throw new Error(`serial ${index.serial} is not above the live serial ${live.serial}; rebuild (build.mjs bumps it when anything changes)`);
      for (const e of index.lenses) {
        const old = live.lenses.find((x) => x && x.id === e.id);
        if (!old) continue;
        if (e.version < old.version) throw new Error(`${e.id}: v${e.version} would downgrade the live v${old.version}`);
        if (e.version === old.version && e.sha256 !== old.sha256) throw new Error(`${e.id} v${e.version} is already published with different content: bump its version`);
      }
    }
    const uploads = index.lenses.filter((e) => !(live && live.lenses.some((x) => x && x.id === e.id && x.sha256 === e.sha256 && x.file === e.file)));
    log(`plan: ${live ? 'back up the live index, ' : ''}upload ${uploads.length} lens file(s) [${uploads.map((e) => e.file).join(', ') || 'none'}], then ${INDEX_KEY} (serial ${index.serial})`);
    if (dry) { log('dry run: nothing written'); return { dry: true, live: !!live, backup: null, uploads: uploads.map((e) => e.file) }; }

    // 4. Backup, before anything is uploaded.
    let backup = null;
    if (live) {
      try { backup = backupLive(liveBuf, { backupDir, date, serial: index.serial }); } catch (e) {
        throw new Error(`couldn't back up the live index (${e.message}). Stopped before uploading anything.`);
      }
      log(`backed up the live index → ${backup}`);
    }

    // 5. Upload: lens files first, verify each, the index last (and never without its backup).
    for (const e of uploads) {
      const file = path.join(distDir, e.file);
      wrangler.put(e.file, file);
      const back = wrangler.get(e.file, path.join(tmp, e.file));
      if (!back || sha256(back) !== e.sha256) throw new Error(`${e.file}: the uploaded copy doesn't match (index NOT updated)`);
      log(`  uploaded + verified ${e.file}`);
    }
    if (live && !backup) throw new Error('no backup of the live index: index NOT updated');
    wrangler.put(INDEX_KEY, indexPath);
    const backIdx = wrangler.get(INDEX_KEY, path.join(tmp, 'new-index.json'));
    if (!backIdx || sha256(backIdx) !== sha256(indexBuf)) throw new Error(`the uploaded index does not match: restore the backup${backup ? ` (${backup})` : ''}`);
    log(`  uploaded + verified ${INDEX_KEY}`);

    // 6. Public URLs.
    for (const key of [...uploads.map((e) => e.file), INDEX_KEY]) {
      const want = key === INDEX_KEY ? sha256(indexBuf) : index.lenses.find((e) => e.file === key).sha256;
      const r = await getPublic(key);
      const ok = r.buf && sha256(r.buf) === want;
      log(`  public ${key}: HTTP ${r.status}${ok ? ' ok' : ' — NOT the new bytes yet (cache?); check again or purge'}`);
    }
    log('published.');
    return { dry: false, live: !!live, backup, uploads: uploads.map((e) => e.file) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function main(argv) {
  const a = parseArgs(argv, { flags: ['yes-publish', 'dry-run', 'help'], options: ['dist-dir', 'wrangler'] });
  if (a.help || !a['yes-publish']) {
    console.error('publish.mjs uploads the lens catalogue to R2 and must not run without the owner\'s explicit OK.');
    console.error('Nothing was done. To publish: node scripts/lenses/publish.mjs --yes-publish [--dry-run]');
    return 2;
  }
  const distDir = path.resolve(a['dist-dir'] || DIST_DIR);
  const wrangler = makeWrangler(a.wrangler || defaultWrangler());   // nothing runs until publish() has checked the local files
  await publish({ distDir, bundledDir: BUNDLED_DIR, srcDir: SRC_DIR, dry: a['dry-run'], wrangler, fetchPublic, backupDir: BACKUP_DIR });
  return 0;
}

runMain(import.meta.url, main);
