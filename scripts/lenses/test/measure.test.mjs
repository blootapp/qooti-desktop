// node --test "scripts/lenses/test/*.test.mjs"
// measure.mjs reads a library DB copy the way the app scores it: people's tags for the same-name
// rule, and the video length rule (long, unmeasurable, waiting, ready). A tiny made-up DB.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadItems, readPeopleTags, suggestionPairs, entryStats, handEntries, lensCoverage, roleViews, shownToRole, nearDuplicates,
} from '../measure.mjs';
import { prepareLenses, suggestItem } from '../lens-score.mjs';
import { encodeF16, toBase64 } from '../lib/f16.mjs';
import { BASIS } from './fixtures/make-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (id) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'valid', 'built', `qooti-lens-${id}.json`), 'utf8'));
const lenses = [load('design'), load('motion'), load('thumbnail')];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-measure-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// node:sqlite prints an ExperimentalWarning once; keep the test output clean.
const orig = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w && w.message || w)) ? undefined : orig.call(process, w, ...rest));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = orig;

const e = (concept) => { const v = new Float32Array(512); v[BASIS[concept]] = 1; return v; };
const f32 = (v) => Buffer.from(v.buffer.slice(0));
const f16 = (vecs) => Buffer.from(encodeF16(vecs.flatMap((v) => [...v])));

const DB = path.join(tmp, 'copy.db');
{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE inspirations (id TEXT PRIMARY KEY, type TEXT, aspect_ratio REAL, stored_path TEXT, thumbnail_path TEXT, duration_secs REAL, created_at INTEGER);
    CREATE TABLE clip_embeddings (id TEXT PRIMARY KEY, model TEXT, emb BLOB);
    CREATE TABLE clip_frames (id TEXT PRIMARY KEY, model TEXT NOT NULL, n INTEGER NOT NULL, emb BLOB NOT NULL);
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL);
    CREATE TABLE inspiration_tags (inspiration_id TEXT, tag_id TEXT);`);
  let t = 100;
  const item = (id, type, dur, emb) => {
    db.prepare('INSERT INTO inspirations VALUES (?, ?, 1.0, ?, NULL, ?, ?)').run(id, type, `/x/${id}`, dur, t--);
    if (emb) db.prepare("INSERT INTO clip_embeddings VALUES (?, 'clip-b32-q8', ?)").run(id, f32(emb));
  };
  const frames = (id, vecs) => db.prepare("INSERT INTO clip_frames VALUES (?, 'clip-b32-q8', ?, ?)").run(id, vecs.length, vecs.length ? f16(vecs) : Buffer.alloc(0));
  const tag = (item, name, source) => {
    const id = `t-${name}`;
    db.prepare('INSERT OR IGNORE INTO tags VALUES (?, ?, ?, 1)').run(id, name, source);
    db.prepare('INSERT INTO inspiration_tags VALUES (?, ?)').run(item, id);
  };
  item('pic-tagged', 'image', null, e('d_poster')); tag('pic-tagged', ' POSTER', 'user');
  item('pic-import', 'gif', null, e('d_poster')); tag('pic-import', 'afisha', 'import');
  item('pic-model', 'image', null, e('d_poster')); tag('pic-model', 'Poster', 'model');   // an old suggestion tag
  item('pic-lens', 'image', null, e('d_poster')); tag('pic-lens', 'lens:d_poster', 'lens');
  item('vid-ready', 'video', 12, e('m_render')); frames('vid-ready', Array(8).fill(e('m_green')));
  item('vid-cover', 'video', 12, e('m_render')); frames('vid-cover', []);
  item('vid-nolen', 'video', null, e('m_render')); frames('vid-nolen', []);
  item('vid-zero', 'video', 0, e('m_render')); frames('vid-zero', Array(8).fill(e('m_green')));
  item('vid-wait', 'video', null, e('m_render'));
  item('vid-long', 'video', 75, e('m_render')); frames('vid-long', Array(8).fill(e('m_green')));
  // read one frame per second (clip.rs FRAMES_TAG): m_green tops 10 of 21 (ceil(0.45 · 21) = 10), m_screen 9
  item('vid-fps1', 'video', 20.4, e('m_render'));
  db.prepare("INSERT INTO clip_frames VALUES ('vid-fps1', 'clip-b32-q8@fps1', 21, ?)").run(f16([...Array(10).fill(e('m_green')), ...Array(9).fill(e('m_screen')), e('d_poster'), e('d_poster')]));
  // a 30–60 s video: in since 2026-11-20 (R45), waiting for its frames
  item('vid-mid', 'video', 45, e('m_render'));
  // a row of another kind: not read yet
  item('vid-odd', 'video', 12, e('m_render'));
  db.prepare("INSERT INTO clip_frames VALUES ('vid-odd', 'clip-b99', 8, ?)").run(f16(Array(8).fill(e('m_green'))));
  // for the embed-frames store
  for (const id of ['st-ready', 'st-long', 'st-nolen', 'st-none']) item(id, 'video', null, e('m_render'));
  db.close();
}

test('people\'s tags are the user and import tags only', async () => {
  const { openReadOnly } = await import('../lib/db.mjs');
  const db = await openReadOnly(DB);
  const tags = readPeopleTags(db);
  db.close();
  assert.deepEqual(Object.fromEntries(tags), { 'pic-tagged': [' POSTER'], 'pic-import': ['afisha'] });
});

test('clip_frames from the DB: long and unmeasurable videos are left out, the rest follow the video rule', async () => {
  const { items, longVideos, noLength } = await loadItems({ dbFile: DB, frames: 'db', log: () => {} });
  const ids = items.map((i) => i.id);
  assert.equal(longVideos, 1);
  assert.equal(noLength, 2, 'n = 0 with no length, and a stored length of 0');
  for (const out of ['vid-long', 'vid-nolen', 'vid-zero']) assert.ok(!ids.includes(out), out);
  for (const wait of ['vid-mid', 'vid-odd']) assert.equal(items.find((i) => i.id === wait).frames, null, `${wait}: waiting`);
  const p = prepareLenses(lenses);
  const got = Object.fromEntries(items.map((it) => [it.id, suggestItem(p, it)]));
  assert.deepEqual(Object.keys(got['pic-tagged'].scores), [], 'own tag " POSTER" → no Poster');
  assert.deepEqual(got['pic-tagged'].dropped, ['d_poster']);
  assert.deepEqual(Object.keys(got['pic-import'].scores), [], 'imported tag "afisha" = the UZ label');
  assert.deepEqual(Object.keys(got['pic-model'].scores), ['d_poster'], 'old suggestion tags don\'t count');
  assert.deepEqual(Object.keys(got['pic-lens'].scores), ['d_poster'], 'lens tags are the owned filter, not this rule');
  assert.deepEqual(Object.keys(got['vid-ready'].scores), ['m_green']);
  assert.equal(items.find((i) => i.id === 'vid-fps1').frames.length, 21, 'rows of both schedules are read');
  // (design's pool is uniform on m_* frames, so only motion's result says something here)
  assert.deepEqual(got['vid-fps1'].byLens.motion.map((s) => s.id), ['m_green'], '10 of 21 frames; m_screen\'s 9 are not enough');
  assert.equal(got['vid-fps1'].byLens.motion[0].won, 10);
  assert.equal(got['vid-cover'].rule, 'cover');
  assert.deepEqual(Object.keys(got['vid-cover'].scores), ['m_render']);
  assert.equal(got['vid-wait'], null, 'waiting: counted, not scored yet');
  assert.ok(ids.includes('vid-wait'));
});

test('an embed-frames store: its measured length stands in for a missing one', async () => {
  const store = {
    format: 1, items: {
      'st-ready': { n: 8, slots: [0, 1, 2, 3, 4, 5, 6, 7], duration: 10, f16: toBase64(f16(Array(8).fill(e('m_green')))) },
      'st-long': { n: 0, long: true, slots: [], times: [], duration: 75, f16: '' },
      'st-nolen': { n: 0, slots: [], times: [], duration: null, f16: '' },
    },
  };
  const file = path.join(tmp, 'frame-vectors.json');
  fs.writeFileSync(file, JSON.stringify(store));
  const { items, longVideos, noLength } = await loadItems({ dbFile: DB, frames: file, log: () => {} });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.ok(!by['st-long'] && !by['st-nolen']);
  assert.equal(longVideos, 2, 'vid-long by its DB length, st-long by the measured one');
  assert.equal(noLength, 1, 'st-nolen; the DB-only videos have no store entry, so they wait');
  assert.equal(by['st-ready'].duration, 10);
  assert.deepEqual(Object.keys(suggestItem(prepareLenses(lenses), by['st-ready']).scores), ['m_green']);
  assert.equal(by['st-none'].frames, null, 'no entry yet: waiting');
  assert.equal(suggestItem(prepareLenses(lenses), by['st-none']), null);
});

// ── Shared tags (spec §0c): per-entry reports, role views, judging keys, near-duplicates ─────

/** A unit vector (Float64Array) from {basis key or index: weight}. */
function uvec(parts) {
  const v = new Float64Array(512);
  for (const [k, w] of Object.entries(parts)) v[BASIS[k] ?? Number(k)] += w;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const picture = (id, parts) => ({ id, kind: 'picture', aspect: 1, vector: uvec(parts), peopleTags: [] });
const video = (id, parts, n = 8) => ({ id, kind: 'video', aspect: 1, duration: 12, frames: Array.from({ length: n }, () => uvec(parts)), cover: null, peopleTags: [] });

/** The fixture lenses and four items: the shared tag d_type on a picture (design) and a video (motion). */
function sharedSetup() {
  const p = prepareLenses(lenses);
  const items = [
    picture('pic-type-0001', { d_type: 1 }),                       // design's entry, borrowed by motion
    picture('pic-green-0002', { m_green: 1 }),                     // motion's own any-entry
    video('vid-type-00003', { 'motion/d_type': 1, d_dark: 0.2 }),  // motion's video entry; design gives d_dark
    video('vid-screen-004', { m_screen: 1 }),                      // motion's video-only entry
  ];
  const results = new Map(items.map((it) => [it.id, suggestItem(p, it)]));
  return { p, items, results };
}

test('suggestion pairs name the lens whose pool made them; judging keys stay item + concept id', () => {
  const { items, results } = sharedSetup();
  const pairs = suggestionPairs(items, results);
  const by = Object.fromEntries(pairs.map((x) => [`${x.item.id.slice(0, 8)}|${x.concept}`, `${x.lens}:${x.kind}`]));
  assert.deepEqual(by, {
    'pic-type|d_type': 'design:picture', 'pic-gree|m_green': 'motion:picture',
    'vid-type|d_type': 'motion:video', 'vid-type|d_dark': 'design:video', 'vid-scre|m_screen': 'motion:video',
  });
  assert.equal(new Set(Object.keys(by)).size, pairs.length, 'one pair per item and concept: one media per item, one entry per tag and media');
});

test('per-entry rows: a tag in two lenses has one row per lens, each over the items its media covers', () => {
  const { p, items, results } = sharedSetup();
  const rows = Object.fromEntries(entryStats(p, items, results).map((r) => [`${r.lens}/${r.id}`, r]));
  assert.ok(!rows['design/d_brand'] && !rows['motion/m_meme'], 'add-by-hand entries have no row');
  const dt = rows['design/d_type'], mt = rows['motion/d_type'];
  assert.deepEqual([dt.fires, dt.eligible, dt.shared, dt.media], [{ picture: 1, video: 0 }, 2, true, 'picture']);
  assert.deepEqual([mt.fires, mt.eligible, mt.shared, mt.media], [{ picture: 0, video: 1 }, 2, true, 'video']);
  assert.equal(rows['design/d_poster'].shared, false);
  assert.equal(rows['design/d_poster'].eligible, 4, 'an any-entry covers both media');
  assert.deepEqual(rows['motion/m_screen'].fires, { picture: 0, video: 1 });
  assert.equal(rows['motion/d_type'].rate, 0.5);
  assert.deepEqual(handEntries(p).map((h) => `${h.lens}/${h.id}`), ['design/d_brand', 'motion/m_meme', 'thumbnail/d_brand']);
  assert.equal(handEntries(p).find((h) => h.id === 'm_meme').group, 'Social');
});

test('lens coverage counts what each lens\'s own pool made (not concept ids it happens to share)', () => {
  const { p, items, results } = sharedSetup();
  const cov = lensCoverage(p, items, results);
  // design's d_type on the picture is not a motion suggestion, although motion has an entry with that id
  assert.deepEqual(cov.motion.picture, { items: 2, items_with_suggestion: 1, rate: 0.5, suggestions: 1 });
  assert.deepEqual(cov.motion.video, { items: 2, items_with_suggestion: 2, rate: 1, suggestions: 2 });
  assert.deepEqual(cov.design.picture, { items: 2, items_with_suggestion: 1, rate: 0.5, suggestions: 1 });
  assert.deepEqual(cov.design.video, { items: 2, items_with_suggestion: 1, rate: 0.5, suggestions: 1 });
  assert.equal(cov.thumbnail.video.items_with_suggestion, 0);
});

test('role views use the §0c display rule: motion sees design\'s d_type on pictures through its borrow, its own on videos', () => {
  const { p, items, results } = sharedSetup();
  const rv = roleViews(p, items, results);
  assert.deepEqual(rv.motion, { items: 4, items_with_visible: 4, rate: 1, avg_visible: 1.25, first_is_own: 3, first_is_borrowed: 1 });
  // design sees d_type on the picture only (its entry covers pictures); d_dark on the video
  assert.deepEqual(shownToRole(p, 'design', items, results).map((x) => `${x.item.id.slice(0, 8)}|${x.concept}`), ['pic-type|d_type', 'vid-type|d_dark']);
  assert.deepEqual(shownToRole(p, 'motion', items, results).map((x) => `${x.item.id.slice(0, 8)}|${x.concept}|${x.via}`),
    ['pic-type|d_type|borrow', 'pic-gree|m_green|own', 'vid-type|d_type|own', 'vid-type|d_dark|borrow', 'vid-scre|m_screen|own']);
  assert.equal(rv.thumbnail.items_with_visible, 0);
});

test('near-duplicates are found inside each media pool only', () => {
  const v = (parts) => Array.from(uvec(parts));
  const entry = (id, media, parts) => ({ id, label: { en: id, uz: id }, media, prompts: ['x y', 'y z'], vec: v(parts) });
  const base = { id: 'design', role: 'base', version: 1, bar: { picture: 0.3, video: 0.2 }, concepts: [
    entry('a', 'picture', { 0: 1 }), entry('b', 'picture', { 0: 1, 1: 0.05 }), entry('c', 'picture', { 2: 1 }),
  ] };
  const spec = { id: 'motion', role: 'specialist', version: 1, bar: { picture: 0.3, video: 0.2 }, borrows: [], concepts: [
    entry('w', 'picture', { 2: 1, 3: 0.05 }),        // near design's c: an own-vs-base pair in motion's picture pool
    entry('x', 'video', { 10: 1 }), entry('y', 'video', { 10: 1, 11: 0.05 }),
    entry('z', 'video', { 0: 1 }),                   // design's a, for videos: never in a pool with a
    entry('q', 'video', { 12: 1 }),
  ] };
  const p = prepareLenses([base, spec]);
  let s = 7;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const items = [];
  for (let i = 0; i < 40; i++) items.push(picture(`pic-${i}`, { 0: rnd() * 0.3, 2: rnd() * 0.3, 7: 0.2 + rnd() * 0.1 }));
  for (let i = 0; i < 40; i++) items.push(video(`vid-${i}`, { 10: rnd() * 0.3, 0: rnd() * 0.3, 12: rnd() * 0.3, 7: 0.2 }, 2));
  const dups = nearDuplicates(p, items);
  const names = dups.map((d) => `${d.media}:${d.pool}:${d.a_lens}.${d.a}~${d.b_lens}.${d.b}${d.anchor ? `(anchor ${d.anchor})` : ''}`).sort();
  assert.deepEqual(names, [
    'picture:design:design.a~design.b',
    'picture:motion:design.c~motion.w(anchor c)',
    'video:motion:motion.x~motion.y',
  ]);
  for (const d of dups) assert.ok(d.r >= 0.75 && d.items === 40 && d.text_cos > 0.99, JSON.stringify(d));
  assert.ok(!dups.some((d) => [d.a, d.b].includes('z')), 'z (video) and a (picture) share a direction but never a pool');
});
