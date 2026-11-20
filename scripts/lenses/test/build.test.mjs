// node --test "scripts/lenses/test/*.test.mjs"
// build.mjs: the version-bump guard. A lens whose built file changes needs a higher version than
// the bundled file it replaces; otherwise the build writes nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionGuard, serialize, composeBuilt } from '../build.mjs';
import { checkLensObject, sourceView } from '../check.mjs';
import { HF_CACHE } from '../lib/paths.mjs';
import { modelFile, TEXT_FILE } from '../lib/models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, '..', 'build.mjs');
const VALID_SRC = path.join(here, 'fixtures', 'valid', 'src');
const VALID_BUILT = path.join(here, 'fixtures', 'valid', 'built');
const CACHE = process.env.LENS_HF_CACHE || HF_CACHE;

const made = [];
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmpCopy = (dir) => { const t = mkTmp('lens-build-'); for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(t, f)); return t; };
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const lens = (version, extra = {}) => serialize({ format: 2, id: 'motion', version, role: 'specialist', ...extra });

test('versionGuard: changed content needs a higher version', () => {
  const v1 = lens(1);
  assert.equal(versionGuard(null, v1), null, 'nothing built yet');
  assert.equal(versionGuard(v1, v1), null, 'unchanged');
  assert.match(versionGuard(v1, lens(1, { name: 'x' })), /^content changed: bump the version/);
  assert.equal(versionGuard(v1, lens(2, { name: 'x' })), null, 'bumped');
  assert.match(versionGuard(lens(3), lens(2, { name: 'x' })), /lower than the built v3/);
  assert.equal(versionGuard(lens(1, { placeholder: true }), lens(1, { name: 'x' })), null, 'a placeholder may be replaced');
  assert.equal(versionGuard('{ not json', v1), null, 'an unreadable old file is simply replaced');
});

test('composeBuilt (§0c): add-by-hand entries get no prompts, vec or media; group and suggest are carried; old entries build as before', () => {
  const src = JSON.parse(read(VALID_SRC, 'motion.json'));
  src.concepts[2].suggest = true;                    // an explicit true is kept as given
  src.concepts[2].about = { en: 'note' };
  const vecs = new Map(src.concepts.filter((c) => c.suggest !== false).map((c) => [c.id, `vec-of-${c.id}`]));
  const built = composeBuilt(src, { vecs, minApp: '1.2.3', updatedAt: '2026-11-19', textModel: 'tm' });
  const keys = Object.fromEntries(built.concepts.map((c) => [c.id, Object.keys(c).join(',')]));
  assert.deepEqual(keys, {
    m_green: 'id,label,group,media,prompts,vec',
    m_screen: 'id,label,group,media,prompts,vec',
    m_render: 'id,label,suggest,media,prompts,about,vec',
    d_type: 'id,label,group,media,prompts,vec',
    m_meme: 'id,label,group,suggest',
  });
  assert.equal(built.concepts.find((c) => c.id === 'm_meme').suggest, false);
  assert.deepEqual(built.concepts.find((c) => c.id === 'd_type').group, { en: 'Techniques', uz: 'Usullar' });
  assert.ok(!vecs.has('m_meme'), 'nothing is embedded for an add-by-hand entry');
  // The built file's content view is the source's (no endless "stale"), and an entry without the
  // new fields keeps the old key order: id, label, media, aspect?, prompts, about?, vec.
  assert.deepEqual(sourceView(built), sourceView({ ...src }), 'same content (key order aside, as check.mjs compares)');
  const old = composeBuilt({ ...src, concepts: [{ id: 'x_1', label: { en: 'X', uz: 'X' }, media: 'any', aspect: [1, 2], prompts: ['a b', 'c d'], about: { en: 'n' } }] }, { vecs: new Map([['x_1', 'v']]), minApp: '1.2.3', updatedAt: '2026-11-19', textModel: 'tm' });
  assert.equal(Object.keys(old.concepts[0]).join(','), 'id,label,media,aspect,prompts,about,vec');
  // The built fixtures (made with composeBuilt) pass the built-file checks
  for (const id of ['design', 'motion', 'thumbnail']) {
    const list = [];
    checkLensObject({ error: (c, l, w, m) => list.push(`${c} ${w} ${m}`), warn() {} }, JSON.parse(read(VALID_BUILT, `qooti-lens-${id}.json`)), { kind: 'built', file: `qooti-lens-${id}.json` });
    assert.deepEqual(list, [], id);
  }
});

const hasModel = fs.existsSync(modelFile(TEXT_FILE, CACHE));
test('build.mjs refuses a changed lens at the same version and writes nothing', { skip: hasModel ? false : 'no CLIP text model in the cache' }, () => {
  const src = tmpCopy(VALID_SRC);
  const bundled = tmpCopy(VALID_BUILT);            // basis-vector "builds" at v1: real vectors differ
  const dist = mkTmp('lens-build-dist-');
  const run = (...extra) => spawnSync(process.execPath, [BUILD, '--src-dir', src, '--bundled-dir', bundled, '--dist-dir', dist, '--cache', CACHE, '--date', '2026-11-18', ...extra], { encoding: 'utf8' });
  const before = Object.fromEntries(fs.readdirSync(bundled).map((f) => [f, read(bundled, f)]));

  const refused = run();
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /content changed: bump the version/);
  assert.match(refused.stderr, /nothing written/);
  for (const [f, text] of Object.entries(before)) assert.equal(read(bundled, f), text, `${f} untouched`);
  assert.deepEqual(fs.readdirSync(dist), [], 'no dist copies, no index');
  assert.equal(run('--dry-run').status, 1, 'a dry run reports it too');

  const allowed = run('--allow-same-version');
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.match(allowed.stdout, /changed at v1 \(--allow-same-version\)/);
  assert.notEqual(read(bundled, 'qooti-lens-motion.json'), before['qooti-lens-motion.json']);
  assert.ok(fs.existsSync(path.join(dist, 'qooti-lenses.json')));

  // The owner edits a label: refused at v1, fine at v2 (and the other lenses stay unchanged).
  const m = JSON.parse(read(src, 'motion.json'));
  m.concepts[0].label.en = 'Green screens';
  fs.writeFileSync(path.join(src, 'motion.json'), serialize(m));
  const motionV1 = read(bundled, 'qooti-lens-motion.json');
  assert.equal(run().status, 1);
  assert.equal(read(bundled, 'qooti-lens-motion.json'), motionV1);
  m.version = 2;
  fs.writeFileSync(path.join(src, 'motion.json'), serialize(m));
  const bumped = run();
  assert.equal(bumped.status, 0, bumped.stdout + bumped.stderr);
  assert.equal(JSON.parse(read(bundled, 'qooti-lens-motion.json')).version, 2);
  assert.match(bumped.stdout, /built design v1: .* unchanged/);
});
