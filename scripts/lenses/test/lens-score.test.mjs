// node --test "scripts/lenses/test/*.test.mjs"
// Invariants of the anchored scorer (spec §5), on the fixture lenses whose concept vectors are
// basis vectors e_k (test/fixtures/make-fixtures.mjs: BASIS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  prepareLenses, scoreItem, filterScores, lensSignature, visibleSuggestions, visibleDetail, shownBy, pickerConceptIds,
  decodeConceptVec, homeProbabilities, poolProbabilities, scoringEntry, covers, isScored, entryKey,
  pictureRule, PICTURE_MAX, MAX_TAG_VIDEO_SECS, tooLongForTags, videoStatus, lengthKnown, nameKey, sameNameConcepts,
  suggestItem, SIG_PREFIX, framesNeeded, VIDEO_SHARE_PCT,
} from '../lens-score.mjs';
import { encodeF16, decodeF16, toBase64 } from '../lib/f16.mjs';
import { BASIS } from './fixtures/make-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (id) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'valid', 'built', `qooti-lens-${id}.json`), 'utf8'));
const D = load('design'), M = load('motion'), T = load('thumbnail');

/** Unit vector from {conceptId | '<lens>/<conceptId>' | basisIndex: weight}. */
function unit(parts) {
  const v = new Float64Array(512);
  for (const [k, w] of Object.entries(parts)) v[BASIS[k] ?? Number(k)] += w;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const repeat = (n, v) => Array.from({ length: n }, () => v);
/** A video's stored length in these tests: known and well within the 60 s limit. */
const LEN = 12;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
/** A deterministic mix of pictures and videos around the fixture concepts, plus noise. */
function randomItems(n, seed = 1) {
  const r = rng(seed);
  const ids = Object.keys(BASIS);
  const vec = () => {
    const v = new Float64Array(512);
    for (let i = 0; i < 512; i++) v[i] = (r() - 0.5) * 0.02;
    for (let k = 0; k < 3; k++) v[BASIS[ids[Math.floor(r() * ids.length)]]] += r();
    const m = Math.hypot(...v);
    return v.map((x) => x / m);
  };
  const aspects = [0.5625, 1, 1.7778, null];
  return Array.from({ length: n }, (_, i) => {
    const aspect = aspects[Math.floor(r() * aspects.length)];
    if (i % 3 === 0) return { kind: 'video', aspect, duration: LEN, frames: Array.from({ length: 1 + Math.floor(r() * 8) }, vec), cover: vec() };
    return { kind: 'picture', aspect, vector: vec() };
  });
}

test('base output is identical whatever else is installed', () => {
  const alone = prepareLenses([D]);
  const all = prepareLenses([D, M, T]);
  const withMotion = prepareLenses([D, M]);
  let fired = 0;
  for (const it of randomItems(300, 7)) {
    const a = scoreItem(alone, it).byLens.design;
    assert.deepEqual(scoreItem(all, it).byLens.design, a);
    assert.deepEqual(scoreItem(withMotion, it).byLens.design, a);
    fired += a.length;
  }
  assert.ok(fired > 50, `the test items should trigger base suggestions (got ${fired})`);
});

test('specialists are independent of each other', () => {
  const all = prepareLenses([D, M, T]);
  const dm = prepareLenses([D, M]);
  const dt = prepareLenses([D, T]);
  let m = 0, t = 0;
  for (const it of randomItems(300, 11)) {
    const x = scoreItem(all, it);
    assert.deepEqual(scoreItem(dm, it).byLens.motion, x.byLens.motion);
    assert.deepEqual(scoreItem(dt, it).byLens.thumbnail, x.byLens.thumbnail);
    m += x.byLens.motion.length; t += x.byLens.thumbnail.length;
  }
  assert.ok(m > 10 && t > 5, `specialists should fire on the test items (motion ${m}, thumbnail ${t})`);
});

test('a specialist pool only suggests its own entries for the item\'s media; the base pool only base entries', () => {
  const all = prepareLenses([D, M, T]);
  let shared = 0;
  for (const it of randomItems(300, 3)) {
    const r = scoreItem(all, it);
    for (const [lid, list] of Object.entries(r.byLens)) {
      for (const s of list) {
        const e = all.entries.get(entryKey(lid, s.id));
        assert.ok(e && covers(e, it.kind), `${lid} suggested ${s.id} on a ${it.kind}, which is not its own scored entry for ${it.kind}s`);
        assert.equal(scoringEntry(all, s.id, it.kind), e, 'the one entry of that tag covering this media');
        if (s.id === 'd_type') shared++;
      }
    }
    const union = Object.fromEntries(Object.values(r.byLens).flat().map((s) => [s.id, s.score]));
    assert.deepEqual(r.scores, union, 'merge = union of the pools');
  }
  assert.ok(shared > 0, 'the shared tag fires on the test items');
});

test('video-only concepts never reach pictures, picture-only never reach videos', () => {
  const all = prepareLenses([D, M, T]);
  assert.ok(!all.pools.picture.some((p) => p.members.some((c) => c.id === 'm_screen')));
  assert.ok(!all.pools.video.some((p) => p.members.some((c) => c.id === 't_face' || c.id === 't_thumb')));
  const pic = scoreItem(all, { kind: 'picture', aspect: 1, vector: unit({ m_screen: 1 }) });
  assert.equal(pic.scores.m_screen, undefined);
  const vid = scoreItem(all, { kind: 'video', aspect: 1, duration: LEN, frames: repeat(8, unit({ m_screen: 1 })) });
  assert.ok(vid.scores.m_screen > 0.9);
  const face = scoreItem(all, { kind: 'video', aspect: 1, duration: LEN, frames: repeat(8, unit({ t_face: 1 })) });
  assert.equal(face.scores.t_face, undefined);
  const facePic = scoreItem(all, { kind: 'picture', aspect: 1, vector: unit({ t_face: 1 }) });
  assert.ok(facePic.scores.t_face > 0.9);
});

test('aspect gate: format concepts need the item aspect inside [min, max]', () => {
  const all = prepareLenses([D, M, T]);
  const story = unit({ d_story: 1 });
  assert.ok(scoreItem(all, { kind: 'picture', aspect: 0.5625, vector: story }).scores.d_story > 0.9);
  assert.equal(scoreItem(all, { kind: 'picture', aspect: 1, vector: story }).scores.d_story, undefined);
  assert.equal(scoreItem(all, { kind: 'picture', aspect: null, vector: story }).scores.d_story, undefined, 'unknown aspect counts as 1.0');
  const square = prepareLenses([{ ...D, concepts: D.concepts.map((c) => (c.id === 'd_story' ? { ...c, aspect: [0.9, 1.1] } : c)) }]);
  assert.ok(scoreItem(square, { kind: 'picture', aspect: null, vector: story }).scores.d_story > 0.9, 'unknown aspect = 1.0 passes a range around 1');
  assert.ok(scoreItem(all, { kind: 'picture', aspect: 0.6, vector: story }).scores.d_story > 0.9, 'inclusive bounds');
  const thumb = unit({ t_thumb: 1 });
  assert.ok(scoreItem(all, { kind: 'picture', aspect: 1.7778, vector: thumb }).scores.t_thumb > 0.9);
  assert.equal(scoreItem(all, { kind: 'picture', aspect: 0.5625, vector: thumb }).scores.t_thumb, undefined);
  // Videos too (the gate is a concept property; documented in lens-score.mjs).
  assert.ok(scoreItem(all, { kind: 'video', aspect: 0.5625, duration: LEN, frames: repeat(8, story) }).scores.d_story > 0.9);
  assert.equal(scoreItem(all, { kind: 'video', aspect: 1, duration: LEN, frames: repeat(8, story) }).scores.d_story, undefined);
});

test('aspect gate runs after the top-3 cut (no back-fill)', () => {
  const low = prepareLenses([D], { barOverride: { picture: 0.15, video: 0.15 } });
  // Four base concepts just above 0.24 each; d_story is the best.
  const v = unit({ d_poster: 1.003, d_logo: 1.002, d_photo: 1.001, d_story: 1.004 });
  const pool = low.pools.picture[0];
  const kept = pictureRule(pool, v, 0.5625).map((s) => s.id);
  assert.deepEqual(kept, ['d_story', 'd_poster', 'd_logo']);
  assert.equal(kept.length, PICTURE_MAX);
  const gated = pictureRule(pool, v, 1).map((s) => s.id);
  assert.deepEqual(gated, ['d_poster', 'd_logo'], 'd_photo (4th) is not promoted');
});

test('pictures: bar and at most 3, best first', () => {
  const all = prepareLenses([D, M, T]);
  const low = prepareLenses([D], { barOverride: { picture: 0.05 } });
  const v = unit({ d_poster: 1.004, d_logo: 1.003, d_photo: 1.002, d_dark: 1.001 });
  const got = scoreItem(low, { kind: 'picture', aspect: 1, vector: v }).byLens.design;
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((s) => s.id), ['d_poster', 'd_logo', 'd_photo']);
  assert.ok(got[0].score >= got[1].score && got[1].score >= got[2].score);
  // Below the bar (0.30): two concepts at ~0.5 each pass, a three-way split at ~0.33 passes, a 4-way at 0.25 doesn't.
  assert.equal(scoreItem(all, { kind: 'picture', aspect: 1, vector: unit({ d_poster: 1, d_logo: 1, d_photo: 1, d_dark: 1 }) }).byLens.design.length, 0);
  assert.equal(scoreItem(all, { kind: 'picture', aspect: 1, vector: unit({ d_poster: 1, d_logo: 1 }) }).byLens.design.length, 2);
});

test('videos: a 45 % share of frames, mean p over won frames, n == 1 and failed-frames fallback', () => {
  const all = prepareLenses([D, M, T]);
  const screen = unit({ m_screen: 1, d_dark: 0.3 });
  const poster = unit({ d_poster: 1 });
  const v = (frames, extra = {}) => ({ kind: 'video', aspect: 1.78, duration: LEN, frames, ...extra });
  // 4 of 8 frames = ceil(8 · 0.45) → qualifies
  const r4 = scoreItem(all, v([...repeat(4, screen), ...repeat(4, poster)]));
  assert.equal(r4.rule, 'video');
  assert.ok(r4.scores.m_screen > 0.9);
  assert.equal(r4.byLens.motion[0].won, 4);
  // 3 of 8 → doesn't
  const r3 = scoreItem(all, v([...repeat(3, screen), ...repeat(5, poster)]));
  assert.equal(r3.scores.m_screen, undefined);
  // n = 3 needs ceil(1.35) = 2
  assert.ok(scoreItem(all, v([screen, screen, poster])).scores.m_screen > 0.9);
  assert.equal(scoreItem(all, v([screen, poster, poster])).scores.m_screen, undefined);
  // n = 2 needs 1
  assert.ok(scoreItem(all, v([screen, poster])).scores.m_screen > 0.9);
  // n == 1 → picture rule (picture bar)
  const one = scoreItem(all, v([screen]));
  assert.equal(one.rule, 'frame1');
  assert.ok(one.scores.m_screen > 0.9);
  // n == 0 (frames failed) → the cover with the picture rule; no cover → not scored
  const cover = scoreItem(all, v([], { cover: unit({ m_render: 1 }) }));
  assert.equal(cover.rule, 'cover');
  assert.ok(cover.scores.m_render > 0.9);
  assert.equal(scoreItem(all, v([], { cover: null })), null);
  // no clip_frames row yet → not scored, even with a cover
  assert.equal(scoreItem(all, v(null, { cover: unit({ m_render: 1 }) })), null);
  // a picture without a vector → not scored
  assert.equal(scoreItem(all, { kind: 'picture', aspect: 1, vector: null }), null);
});

test('videos: one frame per second needs ceil(0.45 · n) frames (owner decision 2026-11-20, R45)', () => {
  assert.equal(VIDEO_SHARE_PCT, 45);
  const table = [[1, 1], [2, 1], [3, 2], [4, 2], [8, 4], [9, 5], [10, 5], [15, 7], [20, 9], [21, 10], [31, 14], [32, 15]];
  for (const [n, need] of table) assert.equal(framesNeeded(n), need, `n = ${n}`);
  // the measuring run's formula (vidadapt sim.mjs) gives the same for every n
  for (let n = 1; n <= 200; n++) assert.equal(framesNeeded(n), Math.ceil(n * 0.45 - 1e-9), `n = ${n}`);
  assert.equal(framesNeeded(8), Math.ceil(8 * 0.5), '8 frames: 4, as before');
  const all = prepareLenses([D, M, T]);
  const screen = unit({ m_screen: 1, d_dark: 0.3 });
  const poster = unit({ d_poster: 1 });
  const has = (n, k) => scoreItem(all, { kind: 'video', aspect: 1, duration: n, frames: [...repeat(k, screen), ...repeat(n - k, poster)] }).scores.m_screen !== undefined;
  for (const [n, need] of [[8, 4], [15, 7], [20, 9], [21, 10], [32, 15]]) {
    assert.ok(has(n, need), `${need} of ${n}`);
    assert.ok(!has(n, need - 1), `${need - 1} of ${n}`);
  }
  // where the share changed things: 9 of 20 is enough now (half needed 10)
  assert.equal(scoreItem(all, { kind: 'video', aspect: 1, duration: 20, frames: [...repeat(9, screen), ...repeat(11, poster)] }).byLens.motion[0].won, 9);
});

test('videos: the mean p over won frames must reach bar.video; ranking by frames won then mean p', () => {
  const split = unit({ m_screen: 1, m_render: 0.99 });   // m_screen wins with p ≈ 0.67
  const v = (frames) => ({ kind: 'video', aspect: 1, duration: LEN, frames });
  const strict = prepareLenses([D, M], { barOverride: { video: 0.9 } });
  assert.equal(scoreItem(strict, v(repeat(8, split))).scores.m_screen, undefined);
  const normal = prepareLenses([D, M]);
  const r = scoreItem(normal, v(repeat(8, split)));
  assert.ok(r.scores.m_screen > 0.6 && r.scores.m_screen < 0.75);
  // Two qualifiers with 4 frames each: the higher mean p comes first; never more than 2.
  const green = unit({ m_green: 1 });
  const both = scoreItem(normal, v([...repeat(4, split), ...repeat(4, green)]));
  assert.deepEqual(both.byLens.motion.map((s) => s.id), ['m_green', 'm_screen']);
  assert.ok(both.byLens.motion.length <= 2);
  // A frame whose top member is a base concept gives the specialist no vote.
  const dark = unit({ d_dark: 1 });
  assert.equal(scoreItem(normal, v([...repeat(4, dark), ...repeat(4, unit({ m_screen: 1, d_dark: 1.2 }))])).scores.m_screen, undefined);
});

test('filter: answered and owned concepts are dropped, collection hints kept unless answered', () => {
  const scores = { a: 0.5, b: 0.4, c: 0.3 };
  const out = filterScores(scores, { answered: new Set(['a', 'col:9']), owned: new Set(['b']), existing: { 'col:7': 0.6, 'col:9': 0.5, x: 0.9 } });
  assert.deepEqual(out, { c: 0.3, 'col:7': 0.6 });
});

test('signature over installed lenses (spec §5.4), scorer version 4', () => {
  const sha16 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  assert.equal(SIG_PREFIX, 'lens-score-4|clip-b32-q8|', 'the video rule of 2026-11-20 (R45) changed what is stored');
  const sig = lensSignature([{ id: 'thumbnail', sha256: 'cc' }, { id: 'design', sha256: 'aa' }, { id: 'motion', sha256: 'bb' }]);
  assert.equal(sig, sha16('lens-score-4|clip-b32-q8|maxvid=60|design@aa,motion@bb,thumbnail@cc'));
  assert.equal(sig.length, 16);
  // The same text tagging.rs signature_covers_installed_lenses_only hashes (and pins)
  const rust = sha16('lens-score-4|clip-b32-q8|maxvid=60|design@sha-design,motion@sha-motion,thumbnail@sha-thumbnail');
  assert.equal(rust, '9f0638fe4bb271b9');
  assert.equal(lensSignature([{ id: 'motion', sha256: 'sha-motion' }, { id: 'thumbnail', sha256: 'sha-thumbnail' }, { id: 'design', sha256: 'sha-design' }]), rust);
  // Version 1–3 signatures never match, so every item is re-scored once
  for (const v of [1, 2, 3]) for (const max of [30, 60]) assert.notEqual(sig, sha16(`lens-score-${v}|clip-b32-q8|maxvid=${max}|design@aa,motion@bb,thumbnail@cc`));
  // The video length limit is part of it (changing it re-scores the library)
  assert.notEqual(lensSignature([{ id: 'design', sha256: 'aa' }], 30), lensSignature([{ id: 'design', sha256: 'aa' }]));
});

test('videos over 60 s (plus 0.5 s of slack) get no suggestions (spec §0.11; 30 s until 2026-11-20)', () => {
  assert.equal(MAX_TAG_VIDEO_SECS, 60);
  assert.equal(tooLongForTags(30.51), false, 'a 30–60 s video is in now');
  assert.equal(tooLongForTags(45), false);
  assert.equal(tooLongForTags(60), false);
  assert.equal(tooLongForTags(60.5), false);
  assert.equal(tooLongForTags(60.51), true);
  assert.equal(tooLongForTags(120), true);
  assert.equal(tooLongForTags(null), false, 'an unknown length is measured first, never "too long"');
  assert.equal(tooLongForTags(undefined), false);
  assert.equal(tooLongForTags(45, 30), true, 'the tools can still measure with the old limit');
  assert.equal(tooLongForTags(75, Infinity), false);
});

test('video rule: only a known length within the limit is scored; a length that could not be measured never is', () => {
  const all = prepareLenses([D, M, T]);
  const render = unit({ m_render: 1 });
  const cover = unit({ m_render: 1 });
  const frames = repeat(8, render);
  // where a video stands
  assert.equal(videoStatus(LEN, frames), 'ready');
  assert.equal(videoStatus(LEN, []), 'ready', 'n = 0 with a known length: the cover is used');
  assert.equal(videoStatus(60.5, frames), 'ready');
  assert.equal(videoStatus(60.51, frames), 'long');
  assert.equal(videoStatus(61, null), 'long', 'a long video never waits');
  for (const unknown of [null, undefined, 0, -1, NaN]) {
    assert.equal(lengthKnown(unknown), false);
    assert.equal(videoStatus(unknown, null), 'waiting', `${unknown}: no frames row yet → waiting`);
    assert.equal(videoStatus(unknown, []), 'no_length', `${unknown}: measured, still no length → never`);
    assert.equal(videoStatus(unknown, frames), 'no_length');
  }
  assert.equal(videoStatus(LEN, null), 'waiting');
  assert.equal(videoStatus(45, frames), 'ready');
  assert.equal(videoStatus(45, frames, 30), 'long');
  // scoring follows it
  const v = (duration, fr, extra = {}) => ({ kind: 'video', aspect: 1, duration, frames: fr, cover, ...extra });
  assert.ok(scoreItem(all, v(LEN, frames)).scores.m_render > 0.9);
  assert.equal(scoreItem(all, v(LEN, [])).rule, 'cover');
  assert.equal(scoreItem(all, v(null, [])), null, 'no cover fallback without a known length');
  assert.equal(scoreItem(all, v(undefined, [])), null);
  assert.equal(scoreItem(all, v(0, [])), null);
  assert.equal(scoreItem(all, v(null, frames)), null);
  assert.equal(scoreItem(all, v(null, null)), null, 'waiting: not scored yet');
  assert.equal(scoreItem(all, v(61, frames)), null, 'over 60.5 s: never');
  assert.equal(homeProbabilities(all, v(null, [])), null);
  assert.equal(homeProbabilities(all, v(61, frames)), null);
  assert.ok(homeProbabilities(all, v(LEN, [])).get('m_render') > 0.9);
  // the limit comes from prepareLenses (the tools' --max-video-secs)
  assert.ok(scoreItem(all, v(45, frames)).scores.m_render > 0.9);
  assert.equal(scoreItem(prepareLenses([D, M, T], { maxVideoSecs: 30 }), v(45, frames)), null);
  assert.throws(() => prepareLenses([D], { maxVideoSecs: 0 }), /maxVideoSecs/);
  // pictures don't need a length
  assert.ok(scoreItem(all, { kind: 'picture', aspect: 1, vector: unit({ d_poster: 1 }) }).scores.d_poster > 0.9);
});

test('same-name rule: names compare trimmed, lower-cased, with ‘ ’ ʻ ʼ ` folded to \'', () => {
  assert.equal(nameKey('  Poster '), 'poster');
  assert.equal(nameKey('POSTER'), nameKey('poster'));
  for (const s of ['O‘yinlar', 'O’yinlar', 'Oʻyinlar', 'Oʼyinlar', 'O`yinlar', " o'yinlar\t"]) assert.equal(nameKey(s), "o'yinlar", s);
  assert.equal(nameKey('\u00a0Map\u3000'), 'map', 'Unicode spaces around a name are trimmed too');
  assert.notEqual(nameKey('ui'), nameKey('UI design'), 'only the whole name counts');
  assert.notEqual(nameKey('Post er'), nameKey('Poster'), 'inner spaces are kept');
  const all = prepareLenses([D, M, T]);
  assert.deepEqual([...sameNameConcepts(all, ['poster'])], ['d_poster'], 'EN label');
  assert.deepEqual([...sameNameConcepts(all, ['AFISHA '])], ['d_poster'], 'UZ label');
  assert.deepEqual([...sameNameConcepts(all, ["qorong'i"])], ['d_dark'], "UZ label Qorong‘i matches a tag typed with '");
  assert.deepEqual([...sameNameConcepts(all, ['3d render'])], ['m_render'], 'one label in both languages');
  assert.deepEqual([...sameNameConcepts(all, ['moodboard', 'ui', 5, null])], []);
  assert.deepEqual([...sameNameConcepts(all, ['TIPOGRAFIKA'])], ['d_type'], 'a shared tag is one concept (two entries, one name)');
  assert.deepEqual([...sameNameConcepts(all, ['branding'])], ['d_brand'], 'add-by-hand labels count too (harmless: never scored)');
  assert.deepEqual(filterScores({ d_poster: 0.6, d_logo: 0.5 }, { sameName: new Set(['d_poster']) }), { d_logo: 0.5 });
});

test('same-name rule: a concept is never suggested to an item that has a people\'s tag with its name', () => {
  const all = prepareLenses([D, M, T]);
  const item = { kind: 'picture', aspect: 1, vector: unit({ d_poster: 1, d_logo: 1 }) };
  const raw = scoreItem(all, item);
  assert.deepEqual(Object.keys(raw.scores).sort(), ['d_logo', 'd_poster']);
  assert.deepEqual(suggestItem(all, item), { ...raw, dropped: [] }, 'no people\'s tags: what the scorer gives');
  const s = suggestItem(all, { ...item, peopleTags: ['  POSTER'] });
  assert.deepEqual(Object.keys(s.scores), ['d_logo']);
  assert.deepEqual(s.byLens.design.map((x) => x.id), ['d_logo'], 'byLens filtered the same way');
  assert.deepEqual(s.dropped, ['d_poster']);
  assert.equal(s.scores.d_logo, raw.scores.d_logo, 'other scores unchanged');
  // UZ label, and a specialist concept
  const green = suggestItem(all, { kind: 'video', aspect: 1, duration: LEN, frames: repeat(8, unit({ m_green: 1 })), peopleTags: ['yashil ekran'] });
  assert.deepEqual(green.scores, {});
  assert.deepEqual(green.dropped, ['m_green']);
  // Dropping never back-fills: four concepts near 0.25 at a 0.15 bar; the top 3 are cut first.
  const low = prepareLenses([D], { barOverride: { picture: 0.15, video: 0.15 } });
  const four = { kind: 'picture', aspect: 0.5625, vector: unit({ d_poster: 1.003, d_logo: 1.002, d_photo: 1.001, d_story: 1.004 }) };
  assert.deepEqual(Object.keys(scoreItem(low, four).scores), ['d_story', 'd_poster', 'd_logo']);
  assert.deepEqual(Object.keys(suggestItem(low, { ...four, peopleTags: ['Story'] }).scores), ['d_poster', 'd_logo'], 'd_photo (4th) is not promoted');
  // answered and owned concepts go too; a not-scorable item stays null
  assert.deepEqual(Object.keys(suggestItem(all, { ...item, answered: new Set(['d_logo']), ownedConcepts: new Set(['d_poster']) }).scores), []);
  assert.equal(suggestItem(all, { kind: 'picture', aspect: 1, vector: null, peopleTags: ['Poster'] }), null);
});

test('display rule (§0c): a lens shows a key through its own entry for the item\'s media, or a borrow of a design entry for it', () => {
  const all = prepareLenses([D, M, T]);
  const scores = { m_green: 0.5, d_dark: 0.9, d_poster: 0.8, t_face: 0.95, 'col:abc': 0.4, unknown: 0.99 };
  // motion on: its own any-entry and the borrowed d_dark rank together (motion shows both), by score
  assert.deepEqual(visibleSuggestions(all, scores, { enabled: ['motion'], kind: 'picture' }), ['d_dark', 'm_green']);
  assert.deepEqual(visibleSuggestions(all, scores, { enabled: ['design'], kind: 'picture', colTags: new Set(['abc']) }), ['d_dark', 'd_poster', 'col:abc']);
  assert.deepEqual(visibleSuggestions(all, scores, { enabled: ['motion', 'thumbnail', 'design'], kind: 'picture' }), ['d_dark', 'm_green', 't_face']);
  // t_face is picture-only: hidden on a video whatever is on
  assert.deepEqual(visibleSuggestions(all, scores, { enabled: ['motion', 'thumbnail', 'design'], kind: 'video' }), ['d_dark', 'm_green']);
  assert.deepEqual(visibleSuggestions(all, scores, { enabled: [], kind: 'picture' }), []);
  assert.deepEqual(visibleSuggestions(all, scores, { enabled: ['motion'], kind: 'picture', on: false }), [], 'suggestions off');
  // The shared tag d_type: design's entry covers pictures, motion's covers videos, motion borrows design's
  const t = { d_type: 0.6 };
  assert.deepEqual(shownBy(all, 'd_type', { enabled: ['motion'], kind: 'picture' }), { lens: 'motion', via: 'borrow', rank: 0 });
  assert.deepEqual(shownBy(all, 'd_type', { enabled: ['motion'], kind: 'video' }), { lens: 'motion', via: 'own', rank: 0 });
  assert.deepEqual(shownBy(all, 'd_type', { enabled: ['design'], kind: 'picture' }), { lens: 'design', via: 'own', rank: 3 });
  assert.equal(shownBy(all, 'd_type', { enabled: ['design'], kind: 'video' }), null, 'design\'s entry covers pictures only');
  assert.equal(shownBy(all, 'd_type', { enabled: ['thumbnail'], kind: 'picture' }), null, 'thumbnail neither owns nor borrows it');
  assert.deepEqual(shownBy(all, 'd_type', { enabled: ['design', 'motion'], kind: 'picture' }), { lens: 'motion', via: 'borrow', rank: 0 }, 'the first lens in card order');
  assert.deepEqual(visibleSuggestions(all, t, { enabled: ['design'], kind: 'video' }), []);
  // A borrow needs the design entry to cover the media: d_photo is any → thumbnail shows it on videos too
  assert.deepEqual(shownBy(all, 'd_photo', { enabled: ['thumbnail'], kind: 'video' }), { lens: 'thumbnail', via: 'borrow', rank: 1 });
  // Add-by-hand tags cover nothing, so they never show; unknown lens ids are ignored
  for (const k of ['d_brand', 'm_meme']) assert.equal(shownBy(all, k, { enabled: ['motion', 'thumbnail', 'design'], kind: 'picture' }), null, k);
  assert.equal(shownBy(all, 'm_green', { enabled: ['ghost'], kind: 'picture' }), null);
  // Caps (3 pictures, 2 videos); equal rank and score go by key; non-numbers never show
  const five = { m_render: 0.5, m_green: 0.5, d_dark: 0.4, d_type: 0.3, 'col:x': 0.9 };
  assert.deepEqual(visibleDetail(all, five, { enabled: ['motion'], kind: 'picture' }).map((r) => r.key), ['m_green', 'm_render', 'd_dark']);
  assert.deepEqual(visibleDetail(all, five, { enabled: ['motion'], kind: 'video' }).map((r) => `${r.key}:${r.via}`), ['m_green:own', 'm_render:own']);
  assert.deepEqual(visibleSuggestions(all, { m_green: 'x', m_render: NaN, d_dark: 0.2 }, { enabled: ['motion'] }), ['d_dark']);
});

test('picker (§0c): every tag an enabled lens has an entry for (scored or add-by-hand) or borrows', () => {
  const all = prepareLenses([D, M, T]);
  assert.deepEqual(pickerConceptIds(all, ['motion']), ['m_green', 'm_screen', 'm_render', 'd_type', 'm_meme', 'd_dark']);
  assert.deepEqual(pickerConceptIds(all, ['design']), ['d_poster', 'd_logo', 'd_photo', 'd_story', 'd_dark', 'd_type', 'd_brand']);
  assert.deepEqual(pickerConceptIds(all, ['thumbnail']), ['t_face', 't_thumb', 'd_brand', 'd_photo']);
  assert.deepEqual(pickerConceptIds(all, ['thumbnail', 'motion', 'ghost']), [...pickerConceptIds(all, ['motion']), 't_face', 't_thumb', 'd_brand', 'd_photo']);
  assert.deepEqual(pickerConceptIds(all, []), []);
});

test('prepareLenses needs one base, one entry per tag per lens, and disjoint media per tag', () => {
  assert.throws(() => prepareLenses([M, T]), /exactly one base/);
  assert.throws(() => prepareLenses([D, { ...D, id: 'design2', concepts: [{ ...D.concepts[0], id: 'x_1' }] }]), /exactly one base/);
  assert.throws(() => prepareLenses([D, { ...M, concepts: [M.concepts[0], { ...M.concepts[1], id: 'm_green' }] }]), /appears twice in lens motion/);
  // A tag in two lenses is fine with disjoint media, never with overlapping ones
  assert.throws(() => prepareLenses([D, { ...M, concepts: [{ ...M.concepts[0], id: 'd_poster' }] }]), /d_poster: two scored entries cover pictures/);
  const motionAny = { ...M, concepts: M.concepts.map((c) => (c.id === 'd_type' ? { ...c, media: 'any' } : c)) };
  assert.throws(() => prepareLenses([D, motionAny]), /d_type: two scored entries cover pictures \(design: picture, motion: any\)/);
  const thumbVideo = { ...T, concepts: [...T.concepts, { ...M.concepts.find((c) => c.id === 'd_type') }] };
  assert.throws(() => prepareLenses([D, M, thumbVideo]), /d_type: two scored entries cover videos/);
  assert.throws(() => prepareLenses([D, D]), /exactly one base/);
});

test('per-media pools (§0c): a pool holds the scored entries covering its media; add-by-hand entries are in none', () => {
  const all = prepareLenses([D, M, T]);
  const ids = (p) => p.members.map((e) => `${e.lensId}/${e.id}`);
  const [bPic, mPic, tPic] = all.pools.picture;
  const basePic = ['design/d_poster', 'design/d_logo', 'design/d_photo', 'design/d_story', 'design/d_dark', 'design/d_type'];
  assert.deepEqual(ids(bPic), basePic);
  assert.deepEqual(ids(mPic), [...basePic, 'motion/m_green', 'motion/m_render']);
  assert.deepEqual([...mPic.own], ['m_green', 'm_render'], 'design\'s d_type is an anchor in motion\'s picture pool');
  assert.deepEqual(ids(tPic), [...basePic, 'thumbnail/t_face', 'thumbnail/t_thumb']);
  const [bVid, mVid, tVid] = all.pools.video;
  const baseVid = basePic.filter((k) => k !== 'design/d_type');
  assert.deepEqual(ids(bVid), baseVid, 'design\'s picture-only entry is in no video pool');
  assert.deepEqual(ids(mVid), [...baseVid, 'motion/m_green', 'motion/m_screen', 'motion/m_render', 'motion/d_type']);
  assert.deepEqual(ids(tVid), baseVid);
  assert.equal(tVid.own.size, 0, 'thumbnail covers no video: its video pool suggests nothing');
  for (const m of ['picture', 'video']) {
    for (const p of all.pools[m]) {
      assert.equal(new Set(p.members.map((e) => e.id)).size, p.members.length, 'never two entries of one tag in a pool');
      assert.ok(!p.members.some((e) => !e.suggest), 'no add-by-hand entry in a pool');
    }
  }
  // The add-by-hand entries: kept for labels and the picker, without vec or media
  const brand = all.concepts.get('d_brand');
  assert.deepEqual(brand.entries.map((e) => `${e.lensId}:${e.suggest}:${e.media}:${e.vec}`), ['design:false:null:null', 'thumbnail:false:null:null']);
  assert.deepEqual(brand.label, { en: 'Branding', uz: 'Brending' });
  assert.deepEqual(all.concepts.get('d_type').group, { en: 'Techniques', uz: 'Usullar' }, 'the group of the entry that gives one');
  assert.deepEqual(all.lenses.get('motion').handIds, ['m_meme']);
  assert.ok(isScored({}) && !isScored({ suggest: false }) && !covers({ suggest: false, media: 'any' }, 'picture') && covers({}, 'video'));
});

test('shared tag scoring: design scores d_type on pictures, motion on videos, also on one frame and on the cover', () => {
  const all = prepareLenses([D, M, T]);
  const v = (frames, extra = {}) => ({ kind: 'video', aspect: 1, duration: LEN, frames, ...extra });
  const pic = scoreItem(all, { kind: 'picture', aspect: 1, vector: unit({ d_type: 1 }) });
  assert.deepEqual(pic.byLens.design.map((s) => s.id), ['d_type']);
  assert.deepEqual([...pic.byLens.motion, ...pic.byLens.thumbnail], [], 'an anchor in the specialist pools');
  assert.equal(scoreItem(all, { kind: 'picture', aspect: 1, vector: unit({ 'motion/d_type': 1 }) }).scores.d_type, undefined, 'motion\'s video entry never reaches pictures');
  const vid = scoreItem(all, v(repeat(8, unit({ 'motion/d_type': 1, d_dark: 0.2 }))));
  assert.equal(vid.rule, 'video');
  assert.deepEqual(vid.byLens.motion.map((s) => [s.id, s.won]), [['d_type', 8]]);
  assert.deepEqual(vid.byLens.design.map((s) => s.id), ['d_dark']);
  assert.equal(scoreItem(all, v(repeat(8, unit({ d_type: 1, d_dark: 0.2 })))).scores.d_type, undefined, 'design\'s picture entry is in no video pool');
  // n == 1 and the cover use the VIDEO pools
  const one = scoreItem(all, v([unit({ 'motion/d_type': 1 })]));
  assert.equal(one.rule, 'frame1');
  assert.deepEqual(one.byLens.motion.map((s) => s.id), ['d_type']);
  const cover = scoreItem(all, v([], { cover: unit({ 'motion/d_type': 1 }) }));
  assert.equal(cover.rule, 'cover');
  assert.deepEqual(cover.byLens.motion.map((s) => s.id), ['d_type']);
  assert.deepEqual(scoreItem(all, v([], { cover: unit({ d_type: 1 }) })).scores, {}, 'a picture-direction cover finds nothing for d_type on a video');
  // homeProbabilities: d_type from design's pool on pictures, from motion's on videos
  assert.ok(homeProbabilities(all, { kind: 'picture', aspect: 1, vector: unit({ d_type: 1 }) }).get('d_type') > 0.99);
  assert.ok(homeProbabilities(all, v(repeat(4, unit({ 'motion/d_type': 1 })))).get('d_type') > 0.99);
  const pp = poolProbabilities(all, v(repeat(4, unit({ 'motion/d_type': 1 }))));
  assert.equal(pp.media, 'video');
  assert.deepEqual(pp.pools.map((x) => x.probs.length), all.pools.video.map((p) => p.members.length));
});

test('an empty pool suggests nothing (design for pictures only: no base anchors on videos)', () => {
  const pictureOnly = { ...D, concepts: D.concepts.map((c) => (isScored(c) ? { ...c, media: 'picture' } : c)) };
  const p = prepareLenses([pictureOnly, M, T]);
  assert.equal(p.pools.video[0].members.length, 0);
  const r = scoreItem(p, { kind: 'video', aspect: 1, duration: LEN, frames: repeat(8, unit({ m_green: 1 })) });
  assert.deepEqual(r.byLens.design, []);
  assert.deepEqual(r.byLens.thumbnail, []);
  assert.deepEqual(r.byLens.motion.map((s) => s.id), ['m_green'], 'motion\'s video pool is its own entries alone');
  assert.deepEqual(scoreItem(prepareLenses([pictureOnly]), { kind: 'video', aspect: 1, duration: LEN, frames: repeat(8, unit({ d_poster: 1 })) }).scores, {});
  // Pictures are unchanged by it
  assert.deepEqual(scoreItem(p, { kind: 'picture', aspect: 1, vector: unit({ d_poster: 1 }) }).byLens.design.map((s) => s.id), ['d_poster']);
});

// The hand-written vectors in fixtures/shared-tag-vectors.json (PORT-NOTES.md): the app's Rust and
// JS must give the same outputs.
const VECTORS = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'shared-tag-vectors.json'), 'utf8'));
const vecFrom = (parts) => unit(Object.fromEntries(Object.entries(parts).map(([k, w]) => [VECTORS.basis[k] ?? k, w])));

test('shared-tag vectors: scoring', () => {
  const all = prepareLenses(VECTORS.lenses.map((f) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'))));
  for (const c of VECTORS.scoring) {
    const it = { ...c.item };
    if (it.vector) it.vector = vecFrom(it.vector);
    if (it.cover) it.cover = vecFrom(it.cover);
    if (it.frames) it.frames = it.frames.count ? repeat(it.frames.count, vecFrom(it.frames.vector)) : [];
    const r = scoreItem(all, it);
    assert.equal(r.rule, c.expect.rule, c.name);
    for (const [lid, want] of Object.entries(c.expect.byLens)) {
      assert.deepEqual(r.byLens[lid].map((s) => s.id), want.map((w) => w[0]), `${c.name}: ${lid}`);
      r.byLens[lid].forEach((s, i) => assert.ok(Math.abs(s.score - want[i][1]) < 1e-3, `${c.name}: ${lid} ${s.id} ${s.score}`));
    }
  }
});

test('shared-tag vectors: display, picker and signature', () => {
  const all = prepareLenses(VECTORS.lenses.map((f) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'))));
  for (const c of VECTORS.display) {
    const got = visibleDetail(all, c.scores, { enabled: c.enabled, kind: c.kind, colTags: new Set(c.colTags || []), on: c.on ?? true });
    assert.deepEqual(got.map((r) => [r.key, r.lens, r.via]), c.expect, c.name);
  }
  for (const c of VECTORS.picker) assert.deepEqual(pickerConceptIds(all, c.enabled), c.expect, c.enabled.join('+'));
  for (const c of VECTORS.signature) {
    assert.equal(lensSignature(c.installed, c.maxvid), crypto.createHash('sha256').update(c.text).digest('hex').slice(0, 16));
  }
});

test('f16: round trip matches IEEE rounding; concept vectors are renormalised', () => {
  const r = rng(5);
  const vals = Array.from({ length: 2000 }, () => (r() - 0.5) * 4);
  vals.push(0, -0, 65504, 1e-7, 6.1e-5, -2.5e-6);
  const back = decodeF16(encodeF16(vals));
  vals.forEach((v, i) => assert.equal(back[i], Math.f16round(v), `value ${v}`));
  const scaled = new Float64Array(512); scaled[3] = 0.99; scaled[7] = 0.1;
  const v = decodeConceptVec(toBase64(encodeF16(scaled)));
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
});

test('home probabilities: each concept once, from its own pool', () => {
  const all = prepareLenses([D, M, T]);
  const p = homeProbabilities(all, { kind: 'picture', aspect: 1, vector: unit({ m_green: 1 }) });
  assert.ok(p.get('m_green') > 0.9);
  assert.ok(!p.has('m_screen'), 'video-only concept absent for pictures');
  assert.ok(!p.has('d_brand') && !p.has('m_meme'), 'add-by-hand tags have none');
  const pictureEntries = [D, M, T].flatMap((l) => l.concepts.filter((c) => covers(c, 'picture')));
  assert.equal(pictureEntries.length, 10);
  assert.equal([...p.keys()].length, pictureEntries.length);
  const pv = homeProbabilities(all, { kind: 'video', aspect: 1, duration: LEN, frames: [unit({ m_screen: 1 }), unit({ d_poster: 1 })] });
  assert.ok(Math.abs(pv.get('m_screen') - 0.5) < 0.01, 'mean over frames');
});
