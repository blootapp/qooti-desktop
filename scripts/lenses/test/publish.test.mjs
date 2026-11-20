// node --test "scripts/lenses/test/*.test.mjs"
// publish.mjs: only the refusal and stop paths, with stand-ins for wrangler and the network.
// Nothing here runs wrangler or uploads anything.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish, decideLive, main, checkLocalCatalogue, INDEX_KEY, ACCOUNT_ID } from '../publish.mjs';
import { writeIndex, serialize } from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VALID_SRC = path.join(here, 'fixtures', 'valid', 'src');
const VALID_BUILT = path.join(here, 'fixtures', 'valid', 'built');

const made = [];
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmpCopy = (dir) => { const t = mkTmp('lens-pub-'); for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(t, f)); return t; };

/** A clean local catalogue (the fixture lenses, index serial 2026111800) and an empty backup folder. */
function catalogue() {
  const bundledDir = tmpCopy(VALID_BUILT);
  const srcDir = tmpCopy(VALID_SRC);
  const distDir = mkTmp('lens-pub-dist-');
  const { index } = writeIndex({ bundledDir, distDir, date: '2026-11-18', log: () => {} });
  return { bundledDir, srcDir, distDir, index, backupDir: mkTmp('lens-pub-backup-') };
}

/** wrangler stand-in: R2 as a Map; `getFails(key)` makes a read fail; `corrupt(key)` returns other bytes. */
function fakeWrangler({ live = null, getFails = () => false, corrupt = () => false } = {}) {
  const r2 = new Map();
  if (live) r2.set(INDEX_KEY, Buffer.from(typeof live === 'string' ? live : serialize(live)));
  const calls = [];
  return {
    calls, r2, version: 'stand-in',
    whoami: () => { calls.push('whoami'); return `account ${ACCOUNT_ID}`; },
    get(key) { calls.push(`get ${key}`); if (getFails(key)) return null; if (corrupt(key)) return Buffer.from('other bytes'); return r2.has(key) ? Buffer.from(r2.get(key)) : null; },
    put(key, file) { calls.push(`put ${key}`); r2.set(key, fs.readFileSync(file)); },
  };
}
const answer = (status, extra = {}) => async () => ({ status, buf: null, ...extra });
const quiet = () => {};
const puts = (w) => w.calls.filter((c) => c.startsWith('put '));

test('without --yes-publish nothing runs', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...x) => errors.push(x.join(' '));
  try {
    assert.equal(await main(['--dry-run']), 2);
    assert.equal(await main([]), 2);
  } finally { console.error = orig; }
  assert.match(errors.join('\n'), /must not run without the owner's explicit OK/);
});

test('decideLive: "not published yet" only when R2 has nothing and the public URL answers 404', () => {
  assert.deepEqual(decideLive(null, { status: 404, buf: null }), { live: null, liveBuf: null });
  for (const pub of [{ status: 200, buf: Buffer.from('{}') }, { status: 500 }, { status: 403 }, { status: 0, error: 'getaddrinfo ENOTFOUND' }, { status: 404, error: 'socket hang up' }, null]) {
    assert.throws(() => decideLive(null, pub), /Stopped before uploading anything/, JSON.stringify(pub));
  }
  assert.throws(() => decideLive(Buffer.from('<html>sign in</html>'), { status: 200 }), /isn't valid JSON/);
  assert.throws(() => decideLive(Buffer.from(''), { status: 200 }), /isn't valid JSON/);
  assert.throws(() => decideLive(Buffer.from('{"serial":"7","lenses":[]}'), { status: 200 }), /doesn't look like a lens index/);
  // R2's copy wins, whatever the public URL says
  const { live } = decideLive(Buffer.from('{"format":2,"serial":5,"lenses":[]}'), { status: 0, error: 'offline' });
  assert.equal(live.serial, 5);
});

for (const [name, pub] of [['HTTP 200', answer(200, { buf: Buffer.from('{}') })], ['a network error', answer(0, { error: 'ECONNRESET' })], ['HTTP 503', answer(503)]]) {
  test(`a failed R2 read with the public URL answering ${name} stops before any upload or backup`, async () => {
    const c = catalogue();
    const w = fakeWrangler({ getFails: () => true });
    await assert.rejects(publish({ ...c, wrangler: w, fetchPublic: pub, log: quiet }), /Stopped before uploading anything/);
    assert.deepEqual(puts(w), []);
    assert.deepEqual(fs.readdirSync(c.backupDir), []);
  });
}

test('an unreadable live index stops before any upload', async () => {
  const c = catalogue();
  const w = fakeWrangler({ live: '{"serial": 1, "lenses": ' });
  await assert.rejects(publish({ ...c, wrangler: w, fetchPublic: answer(200), log: quiet }), /isn't valid JSON/);
  assert.deepEqual(puts(w), []);
});

test('when the live index can\'t be backed up, nothing is uploaded', async () => {
  const c = catalogue();
  const notADir = path.join(c.backupDir, 'a-file');
  fs.writeFileSync(notADir, 'x');
  const w = fakeWrangler({ live: { format: 2, serial: 2026111700, updated_at: '2026-11-17', lenses: [] } });
  await assert.rejects(publish({ ...c, backupDir: notADir, wrangler: w, fetchPublic: answer(200), log: quiet }), /couldn't back up the live index.*Stopped before uploading anything/s);
  assert.deepEqual(puts(w), []);
});

test('the backup is written before the first upload; a failed upload never reaches the index', async () => {
  const c = catalogue();
  const liveIndex = { format: 2, serial: 2026111700, updated_at: '2026-11-17', lenses: [] };
  const w = fakeWrangler({ live: liveIndex, corrupt: (key) => key !== INDEX_KEY });
  await assert.rejects(publish({ ...c, wrangler: w, fetchPublic: answer(200), date: '2026-11-18', log: quiet }), /doesn't match \(index NOT updated\)/);
  assert.deepEqual(puts(w).length, 1, 'stopped after the first lens file');
  assert.ok(!puts(w).includes(`put ${INDEX_KEY}`));
  const backups = fs.readdirSync(c.backupDir);
  assert.deepEqual(backups, ['qooti-lenses-2026-11-18-before-serial-2026111800.json']);
  assert.equal(fs.readFileSync(path.join(c.backupDir, backups[0]), 'utf8'), serialize(liveIndex));
});

test('serial and version rules against the live index stop before anything is written', async () => {
  const c = catalogue();
  const motion = c.index.lenses.find((e) => e.id === 'motion');
  const cases = [
    [{ serial: 2026111800, lenses: [] }, /not above the live serial/],
    [{ serial: 2026111700, lenses: [{ ...motion, version: 2 }] }, /would downgrade the live v2/],
    [{ serial: 2026111700, lenses: [{ ...motion, sha256: 'f'.repeat(64) }] }, /already published with different content: bump its version/],
  ];
  for (const [live, re] of cases) {
    const w = fakeWrangler({ live: { format: 2, updated_at: '2026-11-17', ...live } });
    await assert.rejects(publish({ ...c, wrangler: w, fetchPublic: answer(200), log: quiet }), re);
    assert.deepEqual(puts(w), []);
  }
  assert.deepEqual(fs.readdirSync(c.backupDir), []);
});

test('a lens id the app doesn\'t know is refused before wrangler runs', async () => {
  const c = catalogue();
  const promo = JSON.parse(fs.readFileSync(path.join(c.bundledDir, 'qooti-lens-motion.json'), 'utf8'));
  Object.assign(promo, { id: 'promo', borrows: [], concepts: [{ ...promo.concepts[0], id: 'p_banner', label: { en: 'Banner', uz: 'Banner' }, prompts: ['a promotional banner', 'an advertising banner'] }] });
  fs.writeFileSync(path.join(c.bundledDir, 'qooti-lens-promo.json'), serialize(promo));
  fs.writeFileSync(path.join(c.srcDir, 'promo.json'), serialize({ ...promo, format: undefined, min_app: undefined, updated_at: undefined, model: undefined, template: undefined, text_model: undefined, concepts: promo.concepts.map(({ vec, ...x }) => x) }));
  writeIndex({ bundledDir: c.bundledDir, distDir: c.distDir, date: '2026-11-19', log: () => {} });   // the index now lists promo
  const w = fakeWrangler();
  await assert.rejects(publish({ ...c, wrangler: w, fetchPublic: answer(404), log: quiet }), /lens\.unknown_id|index\.unknown_id/);
  assert.deepEqual(w.calls, [], 'wrangler never ran');
});

test('a bundled lens without a source is refused before wrangler runs', async () => {
  const c = catalogue();
  fs.rmSync(path.join(c.srcDir, 'thumbnail.json'));
  const w = fakeWrangler();
  await assert.rejects(publish({ ...c, wrangler: w, fetchPublic: answer(404), log: quiet }), /built\.no_source/);
  assert.deepEqual(w.calls, []);
});

test('an index that lists a lens twice, or misses one, is refused', () => {
  const c = catalogue();
  const indexFile = path.join(c.distDir, INDEX_KEY);
  const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  fs.writeFileSync(indexFile, serialize({ ...idx, lenses: [...idx.lenses, idx.lenses[0]] }));
  assert.throws(() => checkLocalCatalogue({ ...c, log: quiet }), /index\.dup|more than once/);
  fs.writeFileSync(indexFile, serialize({ ...idx, lenses: idx.lenses.filter((e) => e.id !== 'design') }));
  assert.throws(() => checkLocalCatalogue({ ...c, log: quiet }));
});

test('a dry run when the index is not published yet plans the upload and writes nothing', async () => {
  const c = catalogue();
  const w = fakeWrangler();
  const r = await publish({ ...c, dry: true, wrangler: w, fetchPublic: answer(404), log: quiet });
  assert.deepEqual(r, { dry: true, live: false, backup: null, uploads: c.index.lenses.map((e) => e.file) });
  assert.deepEqual(puts(w), []);
  assert.deepEqual(fs.readdirSync(c.backupDir), []);
});
