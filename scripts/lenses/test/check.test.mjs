// node --test "scripts/lenses/test/*.test.mjs"
// check.mjs: the valid fixtures pass, and every rule of spec §2.3 has a fixture that breaks it
// (test/fixtures/invalid/cases.json, made by fixtures/make-fixtures.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSources, checkBuilt, checkLensObject, applyFocus, versionBumpProblem } from '../check.mjs';
import { writeIndex, serialize } from '../build.mjs';
import { HF_CACHE } from '../lib/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');
const VALID_SRC = path.join(FIX, 'valid', 'src');
const VALID_BUILT = path.join(FIX, 'valid', 'built');
const cases = JSON.parse(fs.readFileSync(path.join(FIX, 'invalid', 'cases.json'), 'utf8'));

// The real CLIP tokenizer when the model cache has it (no download in tests).
let countTokens = null;
try {
  const { loadTokenizer } = await import('../lib/models.mjs');
  countTokens = (await loadTokenizer(process.env.LENS_HF_CACHE || HF_CACHE, { offline: true })).count;
} catch { countTokens = null; }

const made = [];
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function tmpCopy(dir) {
  const t = mkTmp('lens-check-');
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(t, f));
  return t;
}
const errorsOf = (issues) => issues.filter((i) => i.level === 'error');

test('valid fixture sources pass with no errors or warnings', () => {
  const { issues, entries } = checkSources({ srcDir: VALID_SRC, countTokens });
  assert.equal(entries.length, 3);
  assert.deepEqual(issues, []);
});

test('valid built fixtures pass; with an index the catalogue is consistent', () => {
  const r = checkBuilt({ bundledDir: VALID_BUILT, distDir: path.join(os.tmpdir(), 'lens-no-dist-here'), srcDir: VALID_SRC });
  assert.deepEqual(errorsOf(r.issues), []);
  assert.deepEqual(r.issues.map((i) => i.code), ['index.none']);
  const bundled = tmpCopy(VALID_BUILT);
  const src = tmpCopy(VALID_SRC);
  const dist = mkTmp('lens-dist-');
  const { index } = writeIndex({ bundledDir: bundled, distDir: dist, date: '2026-11-18', log: () => {} });
  assert.deepEqual(index.lenses.map((e) => e.id), ['motion', 'design', 'thumbnail']);
  assert.equal(index.serial, 2026111800);
  const ok = checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src });
  assert.deepEqual(ok.issues, []);
  // Rewriting with nothing changed keeps the serial; a change bumps it.
  assert.equal(writeIndex({ bundledDir: bundled, distDir: dist, date: '2026-11-19', log: () => {} }).index.serial, 2026111800);
  // The owner bumps motion to v2 and rebuilds it (source and bundled copy agree again).
  for (const [dir, name] of [[bundled, 'qooti-lens-motion.json'], [src, 'motion.json']]) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    m.version = 2;
    fs.writeFileSync(path.join(dir, name), serialize(m));
  }
  const after = checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src });
  assert.ok(after.issues.some((i) => i.code === 'index.bundled_differs' && i.level === 'error'));
  const bumped = writeIndex({ bundledDir: bundled, distDir: dist, date: '2026-11-19', log: () => {} }).index;
  assert.equal(bumped.serial, 2026111900);
  assert.equal(fs.readdirSync(dist).filter((f) => f.startsWith('qooti-lens-motion-')).length, 1, 'the stale motion copy is pruned');
  assert.deepEqual(errorsOf(checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src }).issues), []);
  // A corrupted dist copy is caught.
  const f = path.join(dist, bumped.lenses[0].file);
  fs.appendFileSync(f, ' ');
  const bad = checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src });
  assert.ok(bad.issues.some((i) => i.code === 'index.sha256'));
  assert.ok(bad.issues.some((i) => i.code === 'index.size'));
  fs.rmSync(f);
  assert.ok(checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src }).issues.some((i) => i.code === 'index.missing_file'));
});

test('a changed lens needs a higher version than its built file (same version = error)', () => {
  const bundled = tmpCopy(VALID_BUILT);
  const src = tmpCopy(VALID_SRC);
  const dist = path.join(bundled, 'no-dist');
  const editSource = (fn) => {
    const m = JSON.parse(fs.readFileSync(path.join(src, 'motion.json'), 'utf8'));
    fn(m);
    fs.writeFileSync(path.join(src, 'motion.json'), serialize(m));
  };
  const codes = () => checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src }).issues.map((i) => `${i.level}:${i.code}`);
  // A label edit at the same version: an error, not just "stale".
  editSource((m) => { m.concepts[0].label.en = 'Green screens'; });
  const same = checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src }).issues.find((i) => i.code === 'built.same_version');
  assert.equal(same && same.level, 'error');
  assert.match(same.msg, /content changed: bump the version/);
  assert.ok(!codes().includes('warning:built.stale'));
  // Bumped: only "rebuild it".
  editSource((m) => { m.version = 2; });
  assert.ok(codes().includes('warning:built.stale'));
  assert.ok(!codes().some((c) => c.startsWith('error:')), JSON.stringify(codes()));
  // A built v3 with a changed v2 source: the version would go down.
  const b = JSON.parse(fs.readFileSync(path.join(bundled, 'qooti-lens-motion.json'), 'utf8'));
  b.version = 3;
  fs.writeFileSync(path.join(bundled, 'qooti-lens-motion.json'), serialize(b));
  assert.ok(codes().includes('error:built.same_version'));
  // A placeholder bundled file may be replaced at any version.
  b.version = 2;
  b.placeholder = true;
  fs.writeFileSync(path.join(bundled, 'qooti-lens-motion.json'), serialize(b));
  assert.ok(!codes().includes('error:built.same_version'));
  // Focus mode keeps it an error for that lens only.
  editSource((m) => { m.version = 1; });
  fs.copyFileSync(path.join(VALID_BUILT, 'qooti-lens-motion.json'), path.join(bundled, 'qooti-lens-motion.json'));
  const focused = checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src, focus: 'motion' }).issues;
  assert.ok(focused.some((i) => i.code === 'built.same_version' && i.level === 'error'));
  assert.ok(checkBuilt({ bundledDir: bundled, distDir: dist, srcDir: src, focus: 'design' }).issues.some((i) => i.code === 'built.same_version' && i.level === 'warning'));
});

test('versionBumpProblem: only a higher version may carry changed content', () => {
  assert.equal(versionBumpProblem(1, 2), null);
  assert.match(versionBumpProblem(1, 1), /^content changed: bump the version/);
  assert.match(versionBumpProblem(3, 2), /lower than the built v3/);
  assert.equal(versionBumpProblem(1, 1.5), null, 'a bad version is reported as lens.version');
});

test('lens ids other than motion, design and thumbnail are errors; so is a version above 100000', () => {
  const issues = { list: [], error(code) { this.list.push(`error:${code}`); }, warn(code) { this.list.push(`warning:${code}`); } };
  const promo = { ...JSON.parse(fs.readFileSync(path.join(VALID_SRC, 'motion.json'), 'utf8')), id: 'promo' };
  checkLensObject(issues, promo, { kind: 'source', file: 'promo.json' });
  assert.ok(issues.list.includes('error:lens.unknown_id'));
  for (const [v, bad] of [[1, false], [100000, false], [100001, true], [9223372036854775807, true]]) {
    const list = [];
    checkLensObject({ error: (c) => list.push(c), warn() {} }, { ...promo, id: 'motion', version: v }, { kind: 'source', file: 'motion.json' });
    assert.equal(list.includes('lens.version'), bad, `version ${v}`);
  }
});

for (const c of cases) {
  const needsTokenizer = c.expect.code === 'concept.prompt_tokens';
  test(`rule ${c.expect.code} (${c.expect.level}): ${c.name}`, { skip: needsTokenizer && !countTokens ? 'no CLIP tokenizer in the model cache' : false }, () => {
    const fixture = fs.readFileSync(path.join(FIX, 'invalid', c.file));
    let issues;
    if (c.kind === 'source') {
      const dir = tmpCopy(VALID_SRC);
      fs.writeFileSync(path.join(dir, c.target), fixture);
      issues = checkSources({ srcDir: dir, countTokens }).issues;
    } else {
      const dir = tmpCopy(VALID_BUILT);
      fs.writeFileSync(path.join(dir, c.target), fixture);
      issues = checkBuilt({ bundledDir: dir, distDir: path.join(dir, 'no-dist'), srcDir: VALID_SRC }).issues;
    }
    const hit = issues.find((i) => i.code === c.expect.code && i.level === c.expect.level);
    assert.ok(hit, `expected ${c.expect.level} ${c.expect.code}; got ${JSON.stringify(issues.map((i) => `${i.level}:${i.code}`))}`);
    if (c.expect.level === 'warning') assert.deepEqual(errorsOf(issues), [], 'a warning-only fixture must not produce errors');
  });
}

test('built files over 256 KB are rejected', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VALID_BUILT, 'qooti-lens-motion.json'), 'utf8'));
  m.concepts[0].about = { en: 'x'.repeat(270_000) };
  const text = serialize(m);
  const issues = { list: [], error(code) { this.list.push(code); }, warn() {} };
  checkLensObject(issues, m, { kind: 'built', file: 'qooti-lens-motion.json', bytes: Buffer.byteLength(text) });
  assert.ok(issues.list.includes('built.size'));
});

test('focus mode: problems involving another lens become warnings, own problems stay errors', () => {
  const dir = tmpCopy(VALID_SRC);
  const motion = JSON.parse(fs.readFileSync(path.join(dir, 'motion.json'), 'utf8'));
  motion.concepts[0].id = 'd_poster';                 // a second entry of design's tag: other labels, both media
  motion.concepts[1].label.en = 'L'.repeat(30);       // motion's own error
  fs.writeFileSync(path.join(dir, 'motion.json'), serialize(motion));
  const design = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
  design.concepts[0].label.uz = "Afisha'";            // design's own error
  fs.writeFileSync(path.join(dir, 'design.json'), serialize(design));
  const full = checkSources({ srcDir: dir, countTokens });
  for (const code of ['shared.label', 'shared.media_overlap']) assert.ok(full.issues.some((i) => i.code === code && i.level === 'error'), code);
  const focused = checkSources({ srcDir: dir, focus: 'motion', countTokens });
  for (const code of ['shared.label', 'shared.media_overlap']) assert.ok(focused.issues.some((i) => i.code === code && i.level === 'warning'), `${code} involves design`);
  assert.ok(focused.issues.some((i) => i.code === 'text.length' && i.level === 'error'), 'own error kept');
  assert.ok(focused.issues.some((i) => i.code === 'text.uz_apostrophe' && i.level === 'warning'), 'other lens downgraded');
  assert.equal(applyFocus([{ level: 'error', code: 'x', lenses: ['design'], where: '', msg: '' }], 'design,motion')[0].level, 'error');
});

// ── Shared tags (spec §0c) ────────────────────────────────────────────────────────────────

/** Source-check the valid fixtures after `edit(lenses by id)`; returns the issues as "level:code". */
function checkEdited(edit) {
  const dir = tmpCopy(VALID_SRC);
  const lenses = Object.fromEntries(['design', 'motion', 'thumbnail'].map((id) => [id, JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'))]));
  edit(lenses);
  for (const [id, l] of Object.entries(lenses)) fs.writeFileSync(path.join(dir, `${id}.json`), serialize(l));
  return checkSources({ srcDir: dir, countTokens }).issues.map((i) => `${i.level}:${i.code}`);
}
const entry = (l, id) => l.concepts.find((c) => c.id === id);

test('shared tag: one id in several lenses with the same labels and disjoint media passes', () => {
  // The valid fixtures already hold one (d_type: design for pictures, motion for videos, borrowed
  // by motion) and a shared add-by-hand tag (d_brand in design and thumbnail).
  const { issues } = checkSources({ srcDir: VALID_SRC, countTokens });
  assert.deepEqual(issues, []);
  // A group on only one of the entries is fine (motion's d_type has one, design's has none) …
  assert.ok(entry(JSON.parse(fs.readFileSync(path.join(VALID_SRC, 'motion.json'), 'utf8')), 'd_type').group);
  // … and so is the same group on both.
  assert.deepEqual(checkEdited((L) => { entry(L.design, 'd_type').group = { en: 'Techniques', uz: 'Usullar' }; }), []);
  // A third lens may add an add-by-hand entry for a scored tag: it covers no media.
  assert.deepEqual(checkEdited((L) => { L.thumbnail.concepts.push({ id: 'm_green', label: { en: 'Green screen', uz: 'Yashil ekran' }, suggest: false }); }), []);
  // Swapped media are still disjoint: design's entry for videos, motion's own for pictures (motion's
  // borrow then shows design's entry on videos).
  assert.deepEqual(checkEdited((L) => { entry(L.design, 'd_type').media = 'video'; entry(L.motion, 'd_type').media = 'picture'; }), []);
});

test('shared tag: overlapping media are an error wherever the second entry is', () => {
  // design any + motion video → both cover videos (and motion borrows it for pictures as well)
  const any = checkEdited((L) => { entry(L.design, 'd_type').media = 'any'; });
  assert.ok(any.includes('error:shared.media_overlap'));
  assert.ok(any.includes('error:borrows.overlap'), 'motion borrows d_type and owns it for videos, which design now covers too');
  // without the borrow, only the catalogue rule fires
  const noBorrow = checkEdited((L) => { entry(L.design, 'd_type').media = 'any'; L.motion.borrows = ['d_dark']; });
  assert.ok(noBorrow.includes('error:shared.media_overlap'));
  assert.ok(!noBorrow.includes('error:borrows.overlap'));
  // An add-by-hand entry never overlaps: making motion's entry suggest: false clears it
  assert.deepEqual(checkEdited((L) => {
    const e = entry(L.motion, 'd_type');
    delete e.media; delete e.prompts; e.suggest = false;
    entry(L.design, 'd_type').media = 'any';
  }), []);
});

test('limits: 80 scored entries and 120 in all per lens; explicit suggest: true is fine', () => {
  const many = (n, hand) => Array.from({ length: n }, (_, i) => (hand
    ? { id: `m_h${i}`, label: { en: `Hand ${i}`, uz: `Qo‘lda ${i}` }, suggest: false }
    : { id: `m_c${i}`, label: { en: `Motion ${i}`, uz: `Harakat ${i}` }, media: 'any', prompts: [`motion prompt ${i} one`, `motion prompt ${i} two`] }));
  assert.deepEqual(checkEdited((L) => { L.motion.concepts = [...many(80, false), ...many(40, true)]; L.motion.borrows = []; }), []);
  assert.ok(checkEdited((L) => { L.motion.concepts = [...many(80, false), ...many(41, true)]; L.motion.borrows = []; }).includes('error:lens.concept_count'));
  assert.ok(checkEdited((L) => { L.motion.concepts = many(81, false); L.motion.borrows = []; }).includes('error:lens.scored_count'));
  assert.deepEqual(checkEdited((L) => { L.motion.concepts[0].suggest = true; }), []);
});

test('labels: one key per name (case, spaces and ‘ ’ \' don\'t count), entries of one id excepted', () => {
  // Same id, same labels in two lenses: fine (the valid fixtures). Another id with design's label: not.
  assert.ok(checkEdited((L) => { entry(L.motion, 'm_render').label = { en: 'typography', uz: '3D render' }; }).includes('error:dup.label'));
  assert.ok(checkEdited((L) => { entry(L.motion, 'm_render').label.uz = 'Qorong’i'; }).includes('error:dup.label'), '’ and ‘ are one name');
  // A concept's own EN and UZ labels may be equal (3D render / 3D render); another tag's may not.
  assert.ok(checkEdited((L) => { entry(L.motion, 'm_green').label.en = 'Foto'; }).includes('error:dup.label_cross'));
  assert.ok(!checkEdited((L) => { entry(L.motion, 'm_green').label.en = 'Foto'; }).includes('error:dup.label'), 'no clash within one language');
});

test('labels, groups, names and summaries never hold an underscore (shown as they are, it reads as an id)', () => {
  // The owner saw "web_design" as a tag name in qooti 1.2.2: no text the app shows may look like an id.
  for (const [what, edit] of [
    ['English label', (L) => { entry(L.design, 'd_poster').label.en = 'Web_design'; }],
    ['Uzbek label', (L) => { entry(L.design, 'd_poster').label.uz = 'Veb_sayt'; }],
    ['group', (L) => { entry(L.motion, 'd_type').group = { en: 'Social_media', uz: 'Ijtimoiy' }; }],
    ['lens name', (L) => { L.thumbnail.name.en = 'YouTube_thumbnails'; }],
    ['lens summary', (L) => { L.design.summary.uz = 'Posterlar_SMD'; }],
  ]) {
    const got = checkEdited(edit);
    assert.ok(got.includes('error:text.underscore'), `${what}: ${JSON.stringify(got)}`);
  }
  // A space, a hyphen or ‘ ’ are fine; the concept id keeps its underscore.
  assert.deepEqual(checkEdited((L) => { entry(L.design, 'd_poster').label = { en: 'Web design', uz: 'Veb-sayt o‘yin' }; }), []);
  // The built check refuses it too (the bundled files are checked as built files).
  const m = JSON.parse(fs.readFileSync(path.join(VALID_BUILT, 'qooti-lens-motion.json'), 'utf8'));
  m.concepts[0].label.en = 'Green_screen';
  const issues = { list: [], error(code) { this.list.push(code); }, warn() {} };
  checkLensObject(issues, m, { kind: 'built', file: 'qooti-lens-motion.json' });
  assert.ok(issues.list.includes('text.underscore'));
});

test('missing lenses are an error only in a full check', () => {
  const dir = mkTmp('lens-partial-');
  fs.copyFileSync(path.join(VALID_SRC, 'design.json'), path.join(dir, 'design.json'));
  fs.copyFileSync(path.join(VALID_SRC, 'motion.json'), path.join(dir, 'motion.json'));
  assert.ok(checkSources({ srcDir: dir, countTokens }).issues.some((i) => i.code === 'catalogue.missing' && i.level === 'error'));
  assert.deepEqual(errorsOf(checkSources({ srcDir: dir, focus: 'motion', countTokens }).issues), []);
  // A specialist drafted before the base exists: the missing base is not its own error.
  const alone = mkTmp('lens-alone-');
  fs.copyFileSync(path.join(VALID_SRC, 'motion.json'), path.join(alone, 'motion.json'));
  const only = checkSources({ srcDir: alone, focus: 'motion', countTokens }).issues;
  assert.deepEqual(errorsOf(only), []);
  assert.ok(only.some((i) => i.code === 'catalogue.base' && i.level === 'warning'));
  assert.ok(only.some((i) => i.code === 'borrows.no_base' && i.level === 'warning'));
});
