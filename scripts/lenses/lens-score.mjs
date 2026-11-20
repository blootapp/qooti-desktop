// Anchored lens scoring, spec §5 + §0c (the shared-tag model) — the JS mirror of
// src-tauri/src/tagging.rs. Pure: no I/O.
//
//   cos = dot (all vectors L2-normalised) · logit = 100·cos · softmax over a pool (max subtracted)
//
// Entries (§0c): a lens lists entries. One concept id (one tag, one name) may have an entry in
//   several lenses; all of them carry identical labels, and its SCORED entries cover disjoint media:
//   in the whole catalogue at most one entry covers pictures (media 'picture' or 'any') and at most
//   one covers videos ('video' or 'any'). An add-by-hand entry ("suggest": false) has no prompts, no
//   vec and no media: it is never scored and covers nothing (it only puts the tag in the picker).
// Pools (§5.1 + §0c), for the item's media m ('picture' = image/gif; 'video' = video, also when a
//   video falls back to one frame or to its cover):
//   base pool       B_m    = the base lens's scored entries covering m
//   specialist pool P_S,m  = B_m ∪ S's scored entries covering m; it only ever suggests S's own
//                            entries (its base members mean "it's something else"). Specialists never share.
//   Disjoint media guarantee a pool never holds two entries of one id. An empty pool, or a pool with
//   no own entries, suggests nothing.
// Pictures (§5.2): own entries with p ≥ bar.picture, best first, at most 3; then the aspect gate.
// Videos (§5.3): each frame votes for its top pool member; an own entry that wins at least
//   ceil(n·0.45) frames (`framesNeeded`; owner decision 2026-11-20, R45; half before) with a mean p
//   (over the frames it won) ≥ bar.video qualifies; rank by frames won, then mean p; keep 2;
//   score = mean p; then the aspect gate. n is one frame per second of the clip, 8 to 32
//   (embed-frames.mjs frameCount), or 8 for frames read before 2026-11-20. n == 1 → the picture rule;
//   n == 0 (frames failed) → the picture rule on the cover vector if there is one; no frames row
//   yet (or no picture vector) → not scored. All of these use the VIDEO pools.
// Video length (§0.11 + the video rule, `videoStatus`): a video is scored only when its length is
//   known and at most 60 s (+0.5 s; 30 s until 2026-11-20). No clip_frames row yet = waiting. A length the indexer
//   couldn't measure (it then stores n = 0) = never scored, not even from the cover, in no total.
// Merge (§5.4): for one media every concept id has at most one scored entry, so exactly one pool can
//   decide it; union the pool results.
// Write path (§5.4, `suggestItem`): drop answered and owned concepts, and (the same-name rule)
//   every concept whose EN or UZ label equals the name of a people's tag (source user/import) the
//   item already has, compared with `nameKey`. Dropping never back-fills (no new top 3).
// Display (§0c, `visibleDetail`): key k on an item of media m is visible iff suggestions are on and
//   some enabled lens L has a scored entry for k covering m, or L is a specialist that borrows k
//   and the base's entry for k covers m. Card order: the first such lens in the order motion,
//   thumbnail, design (lenses.js CARD_RANK), then col: hints; by score within a rank; equal scores
//   by key. At most 3 for a picture, 2 for a video.
// Picker (§0c, `pickerConceptIds`): every concept id an enabled lens has an entry for (scored or
//   add-by-hand) or borrows, whatever the item's media and the suggestions switch.
//
// Decisions the spec leaves open, made the same way in src-tauri/src/tagging.rs (keep in sync):
//   • The aspect gate applies to every rule (pictures, videos, fallbacks): an entry with an
//     `aspect` range is dropped when the item's aspect ratio is outside [min, max] (inclusive).
//     A missing aspect_ratio counts as 1.0, as tagging.rs `load_inputs` does.
//   • Ties (equal p, or equal frames won and equal mean p) go to the earlier pool member: base
//     entries first in file order, then the specialist's entries in file order. On a tie for a
//     frame's top member, the earlier member wins.
import { createHash } from 'node:crypto';
import { decodeF16, fromBase64 } from './lib/f16.mjs';

export const DIM = 512;
export const LOGIT_SCALE = 100;
export const PICTURE_MAX = 3;
export const VIDEO_MAX = 2;
/** The share of a video's frames an entry must top, in percent (R45, 2026-11-20; 50 before). */
export const VIDEO_SHARE_PCT = 45;
/** How many of n frames an entry must top: ceil(0.45 · n) in whole numbers (tagging.rs
 *  frames_needed): 8 → 4, 15 → 7, 20 → 9, 21 → 10, 32 → 15. */
export const framesNeeded = (n) => Math.floor((n * VIDEO_SHARE_PCT + 99) / 100);
export const DEFAULT_BAR = Object.freeze({ picture: 0.30, video: 0.20 });
/** The two media kinds an item can have (pools are built per kind). */
export const MEDIA_KINDS = Object.freeze(['picture', 'video']);
/** Lists (onboarding, Settings, list_lenses): fixed order. */
export const LENS_ORDER = Object.freeze(['motion', 'design', 'thumbnail']);
/** Card suggestions (§5.6, §0c): specialists first, then the base, then collection hints. */
export const DISPLAY_ORDER = Object.freeze(['motion', 'thumbnail', 'design']);
/** Card ranks, as lenses.js CARD_RANK: motion 0, thumbnail 1, another specialist 2, design or
 *  another base 3, collection hints 4. A key's rank is the rank of the first lens that shows it. */
export const CARD_RANK = Object.freeze({ motion: 0, thumbnail: 1, design: 3 });
export const RANK_OTHER_SPECIALIST = 2;
export const RANK_OTHER_BASE = 3;
export const RANK_COLLECTION_HINT = 4;
/** Scorer version 3: the shared-tag model (§0c: per-entry media, per-media pools) changed what is
 *  stored; 4: the video rule of 2026-11-20 (R45: one frame per second, a 45 % share, up to 60 s). */
export const SIG_PREFIX = 'lens-score-4|clip-b32-q8|';
/**
 * Videos longer than this get no tag suggestions at all (owner decision §0.11; tagging.rs
 * MAX_TAG_VIDEO_SECS): no frames, no scoring (not even the cover), not in any total. Part of the
 * signature, so changing it re-scores the library. Tools take `--max-video-secs` (default this).
 * 30 until the owner's decision of 2026-11-20 (R45).
 */
export const MAX_TAG_VIDEO_SECS = 60;
/** A clip of up to 60.5 s still counts as "60 seconds" (tagging.rs VIDEO_SECS_SLACK). */
export const VIDEO_SECS_SLACK = 0.5;

/** tagging.rs too_long_for_tags: a video this long gets no tag suggestions. An unknown length
 *  (null, 0 or not a number) isn't "too long": the indexer measures it before reading frames. */
export function tooLongForTags(durationSecs, maxSecs = MAX_TAG_VIDEO_SECS) {
  return typeof durationSecs === 'number' && durationSecs > maxSecs + VIDEO_SECS_SLACK;
}

/** A length the app can use: a finite number of seconds above 0 (clip.rs index_video's test). */
export const lengthKnown = (d) => typeof d === 'number' && Number.isFinite(d) && d > 0;

/**
 * Where a video stands for tag suggestions (the video rule; tagging.rs load_inputs, stale_ids
 * and the status totals). `frames`: null/undefined = no clip_frames row yet, [] = n = 0.
 *   'long'       known length over the limit: never scored, in no total (§0.11)
 *   'no_length'  a clip_frames row but no known length: the indexer couldn't measure it and
 *                stored n = 0. Never scored (not even from the cover), in no total
 *   'waiting'    no clip_frames row yet, length unknown or within the limit: counts as waiting
 *   'ready'      known length within the limit and a clip_frames row: scored (n = 0 → the cover)
 */
export function videoStatus(durationSecs, frames, maxSecs = MAX_TAG_VIDEO_SECS) {
  if (tooLongForTags(durationSecs, maxSecs)) return 'long';
  if (frames == null) return 'waiting';
  return lengthKnown(durationSecs) ? 'ready' : 'no_length';
}

/** Only these characters around a name are trimmed (Unicode White_Space, like Rust's str::trim). */
const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;
/** ‘ ’ ʻ ʼ ` all count as ' when names are compared. */
const APOSTROPHES = /[‘’ʻʼ`]/g;

/**
 * The same-name rule's comparison key (tagging.rs mirrors it): trimmed, lower-cased, and every
 * ‘ ’ ʻ ʼ ` folded to '. "O‘yinlar" and " o'yinlar " give the same key. check.mjs compares labels
 * with it too (two labels with one key are one name).
 */
export const nameKey = (s) => String(s).replace(EDGE_SPACE, '').toLowerCase().replace(APOSTROPHES, "'");

function normalized(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  const out = new Float64Array(v.length);
  if (n > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** A built file's `vec` (base64 of 512 LE f16) → unit Float64Array (renormalised, like Rust). */
export function decodeConceptVec(vec) {
  if (typeof vec === 'string') {
    const vals = decodeF16(fromBase64(vec));
    if (vals.length !== DIM) throw new Error(`vec has ${vals.length} values, expected ${DIM}`);
    return normalized(vals);
  }
  if (vec && typeof vec.length === 'number') {
    if (vec.length !== DIM) throw new Error(`vec has ${vec.length} values, expected ${DIM}`);
    return normalized(vec);
  }
  throw new Error('concept has no vec');
}

/** DB type → media kind: 'video' for video, 'picture' for everything else (image, gif). */
export const mediaOf = (type) => (type === 'video' ? 'video' : 'picture');
/** An item's kind ('picture' | 'video'; anything else counts as a picture). */
const mediaKind = (kind) => (kind === 'video' ? 'video' : 'picture');

/** An entry is scored unless it says "suggest": false (an add-by-hand tag, never suggested). */
export const isScored = (entry) => !!entry && entry.suggest !== false;

/**
 * Does this entry take part in scoring items of media m ('picture' | 'video')? A scored entry
 * covers m when its media is 'any' or m (a missing media counts as 'any', as Rust reads it);
 * an add-by-hand entry covers nothing. Works on raw lens-file concepts and prepared entries.
 */
export function covers(entry, m) {
  if (!isScored(entry)) return false;
  const media = entry.media == null ? 'any' : entry.media;
  return media === 'any' || media === m;
}

/** The key of one entry: `<lens id>/<concept id>` (a lens holds at most one entry per id). */
export const entryKey = (lensId, conceptId) => `${lensId}/${conceptId}`;

/** A missing aspect ratio counts as square (tagging.rs: `aspect.unwrap_or(1.0)`). */
export const UNKNOWN_ASPECT = 1.0;

export function aspectOk(entry, aspect) {
  if (!entry.aspect) return true;
  const a = typeof aspect === 'number' && Number.isFinite(aspect) ? aspect : UNKNOWN_ASPECT;
  const [lo, hi] = entry.aspect;
  return a >= lo && a <= hi;
}

/** Numerically stable softmax over 100·cos. */
export function softmax(logits) {
  let m = -Infinity;
  for (const l of logits) if (l > m) m = l;
  const e = logits.map((l) => Math.exp(l - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

/**
 * Parses the installed lenses once. `lenses`: built lens objects (concept `vec` as base64 f16,
 * or a plain number array in tests; add-by-hand entries have none). Exactly one base lens is
 * required; a lens may list a concept id only once; and (§0c) at most one scored entry per concept
 * id may cover each media across all lenses — otherwise this throws.
 * opts.barOverride: {picture?, video?} replaces every lens's bar (measure.mjs uses it to collect
 * suggestions at a low bar for judging).
 * opts.maxVideoSecs: the video length limit (default 60; the tools' `--max-video-secs`).
 *
 * Returns {
 *   baseId, maxVideoSecs,
 *   lenses:   Map(lens id → { id, role, version, sha256, bar, borrows, entries: [entry, …] in file
 *             order, conceptIds, scoredIds, handIds }),
 *   entries:  Map(entryKey(lens id, concept id) → entry),
 *   concepts: Map(concept id → { id, label, group, entries: [entry, …] }),   one row per tag
 *   byLabel:  Map(nameKey(EN or UZ label) → Set(concept id)), for the same-name rule,
 *   pools:    { picture: [pool, …], video: [pool, …] }   base pool first, then the specialists,
 * }
 * entry = { id, lensId, order, suggest, media ('any'|'picture'|'video', null when add-by-hand),
 *           aspect ([min, max] | null), label, group (| null), vec (unit Float64Array | null) }
 * pool  = { lensId, members: [entry, …], own: Set(concept ids it may suggest), bar, matrix }
 */
export function prepareLenses(lenses, opts = {}) {
  const bases = lenses.filter((l) => l.role === 'base');
  if (bases.length !== 1) throw new Error(`exactly one base lens is required, found ${bases.length}`);
  const maxVideoSecs = opts.maxVideoSecs ?? MAX_TAG_VIDEO_SECS;
  if (!(maxVideoSecs > 0)) throw new Error('maxVideoSecs must be a number of seconds above 0');
  const base = bases[0];
  const specialists = lenses.filter((l) => l.role !== 'base');
  const lensMeta = new Map();
  const entries = new Map();
  const concepts = new Map();
  /** nameKey(EN or UZ label) → concept ids, for the same-name rule. */
  const byLabel = new Map();
  const ov = opts.barOverride || {};
  for (const l of lenses) {
    if (lensMeta.has(l.id)) throw new Error(`lens ${l.id} is given twice`);
    const bar = {
      picture: ov.picture ?? l.bar?.picture ?? DEFAULT_BAR.picture,
      video: ov.video ?? l.bar?.video ?? DEFAULT_BAR.video,
    };
    const own = [];
    l.concepts.forEach((c, order) => {
      const key = entryKey(l.id, c.id);
      if (entries.has(key)) throw new Error(`concept id ${c.id} appears twice in lens ${l.id}`);
      const suggest = isScored(c);
      const e = {
        id: c.id, lensId: l.id, order, suggest,
        media: suggest ? (c.media || 'any') : null,
        aspect: suggest && Array.isArray(c.aspect) ? [Number(c.aspect[0]), Number(c.aspect[1])] : null,
        label: c.label || null,
        group: c.group || null,
        vec: suggest ? decodeConceptVec(c.vec) : null,
      };
      entries.set(key, e);
      own.push(e);
      if (!concepts.has(c.id)) concepts.set(c.id, { id: c.id, label: e.label, group: e.group, entries: [] });
      const row = concepts.get(c.id);
      row.entries.push(e);
      if (!row.label && e.label) row.label = e.label;
      if (!row.group && e.group) row.group = e.group;
      for (const lang of ['en', 'uz']) {
        const text = c.label && c.label[lang];
        if (typeof text !== 'string') continue;
        const k = nameKey(text);
        if (!byLabel.has(k)) byLabel.set(k, new Set());
        byLabel.get(k).add(c.id);
      }
    });
    lensMeta.set(l.id, {
      id: l.id, role: l.role, version: l.version, sha256: l.sha256 || null, bar,
      borrows: l.role === 'base' ? [] : [...(l.borrows || [])],
      entries: own,
      conceptIds: own.map((e) => e.id),
      scoredIds: own.filter((e) => e.suggest).map((e) => e.id),
      handIds: own.filter((e) => !e.suggest).map((e) => e.id),
    });
  }
  // §0c: scored entries of one id cover disjoint media (so no pool holds two entries of one id).
  for (const c of concepts.values()) {
    for (const m of MEDIA_KINDS) {
      const cov = c.entries.filter((e) => covers(e, m));
      if (cov.length > 1) {
        throw new Error(`concept ${c.id}: two scored entries cover ${m}s (${cov.map((e) => `${e.lensId}: ${e.media}`).join(', ')})`);
      }
    }
  }
  const buildPools = (m) => {
    const baseMembers = lensMeta.get(base.id).entries.filter((e) => covers(e, m));
    const pools = [{ lensId: base.id, members: baseMembers, own: new Set(baseMembers.map((e) => e.id)) }];
    for (const s of specialists) {
      const own = lensMeta.get(s.id).entries.filter((e) => covers(e, m));
      pools.push({ lensId: s.id, members: [...baseMembers, ...own], own: new Set(own.map((e) => e.id)) });
    }
    for (const p of pools) {
      p.bar = lensMeta.get(p.lensId).bar;
      p.matrix = new Float64Array(p.members.length * DIM);
      p.members.forEach((e, i) => p.matrix.set(e.vec, i * DIM));
    }
    return pools;
  };
  return {
    baseId: base.id,
    lenses: lensMeta,
    entries,
    concepts,
    byLabel,
    maxVideoSecs,
    pools: { picture: buildPools('picture'), video: buildPools('video') },
  };
}

/** The one scored entry of `conceptId` that covers media m (§0c: at most one), or null. Its lens
 *  is the only pool that can suggest that concept on items of media m. */
export function scoringEntry(prepared, conceptId, m) {
  const c = prepared.concepts.get(conceptId);
  if (!c) return null;
  return c.entries.find((e) => covers(e, mediaKind(m))) || null;
}

/** Softmax probabilities of every member of `pool` for one unit vector. */
export function poolProbs(pool, vec) {
  const k = pool.members.length;
  const logits = new Array(k);
  for (let i = 0; i < k; i++) {
    let s = 0;
    const off = i * DIM;
    for (let d = 0; d < DIM; d++) s += vec[d] * pool.matrix[off + d];
    logits[i] = LOGIT_SCALE * s;
  }
  return k ? softmax(logits) : [];
}

/** §5.2 for one pool → [{id, score}] (already capped and aspect-gated). */
export function pictureRule(pool, vec, aspect) {
  const p = poolProbs(pool, vec);
  const cand = [];
  pool.members.forEach((c, i) => {
    if (pool.own.has(c.id) && p[i] >= pool.bar.picture) cand.push({ id: c.id, score: p[i], i });
  });
  cand.sort((a, b) => b.score - a.score || a.i - b.i);
  return cand.slice(0, PICTURE_MAX).filter((c) => aspectOk(pool.members[c.i], aspect)).map(({ id, score }) => ({ id, score }));
}

/** §5.3 share rule for one pool, n ≥ 2 frames → [{id, score, won}]. */
export function videoRule(pool, frames, aspect) {
  const n = frames.length;
  const need = framesNeeded(n);
  const wins = new Map();
  for (const f of frames) {
    const p = poolProbs(pool, f);
    let top = -1;
    for (let i = 0; i < p.length; i++) if (top < 0 || p[i] > p[top]) top = i;
    if (top < 0) continue;
    const c = pool.members[top];
    if (!pool.own.has(c.id)) continue;
    const w = wins.get(c.id) || { id: c.id, i: top, won: 0, sum: 0 };
    w.won += 1;
    w.sum += p[top];
    wins.set(c.id, w);
  }
  const q = [...wins.values()]
    .map((w) => ({ ...w, score: w.sum / w.won }))
    .filter((w) => w.won >= need && w.score >= pool.bar.video);
  q.sort((a, b) => b.won - a.won || b.score - a.score || a.i - b.i);
  return q.slice(0, VIDEO_MAX).filter((w) => aspectOk(pool.members[w.i], aspect)).map(({ id, score, won }) => ({ id, score, won }));
}

/**
 * The vectors the scorer uses for an item, and its media (§5.2/§5.3 incl. the fallbacks) →
 * { m, vecs, rule } or null when the item can't be scored (yet).
 */
export function itemVectors(prepared, item) {
  const m = mediaKind(item.kind);
  if (m === 'picture') return item.vector ? { m, vecs: [item.vector], rule: 'picture' } : null;
  // Only a video of known length within the limit, whose frames were read (or failed), is scored.
  if (videoStatus(item.duration, item.frames, prepared.maxVideoSecs) !== 'ready') return null;
  const frames = item.frames;
  if (frames.length === 0) return item.cover ? { m, vecs: [item.cover], rule: 'cover' } : null;
  if (frames.length === 1) return { m, vecs: [frames[0]], rule: 'frame1' };
  return { m, vecs: frames, rule: 'video' };
}

/**
 * Scores one item against every installed lens (§5.2–5.4), before the write-path filter
 * (`suggestItem` applies it).
 * item: { kind: 'picture'|'video', aspect, vector?: unit vec (pictures),
 *         frames?: unit vecs | null (videos; null = no clip_frames row yet, [] = n=0 failed),
 *         duration?: seconds (videos; null/undefined = unknown, see `videoStatus`),
 *         cover?: unit vec (videos: the clip_embeddings cover) }
 * Returns null when the item can't be scored (yet), else
 *   { rule: 'picture'|'video'|'frame1'|'cover', scores: {concept_id: score}, byLens: {lensId: [{id, score}]} }
 * byLens tells which pool (lens) made each suggestion.
 */
export function scoreItem(prepared, item) {
  const iv = itemVectors(prepared, item);
  if (!iv) return null;
  const run = iv.rule === 'video'
    ? (pool) => videoRule(pool, iv.vecs, item.aspect)
    : (pool) => pictureRule(pool, iv.vecs[0], item.aspect);
  const scores = {};
  const byLens = {};
  for (const pool of prepared.pools[iv.m]) {
    // A pool with no own entries for this media (or an empty pool) suggests nothing.
    const got = pool.own.size ? run(pool) : [];
    byLens[pool.lensId] = got;
    for (const g of got) {
      if (Object.prototype.hasOwnProperty.call(scores, g.id)) throw new Error(`concept ${g.id} decided by two pools`);
      scores[g.id] = g.score;
    }
  }
  return { rule: iv.rule, scores, byLens };
}

/** Which bar applies to a scored item's suggestions: the picture bar unless the video rule ran. */
export const barKind = (rule) => (rule === 'video' ? 'video' : 'picture');

/**
 * Every pool of the item's media, with each member's probability in that pool averaged over the
 * item's vectors (pictures: the vector; videos: the frames, or the cover/single frame) →
 * { media, pools: [{ pool, probs: Float64Array }] } or null when not scorable. measure.mjs finds
 * near-duplicates with it (pairs that compete inside one pool).
 */
export function poolProbabilities(prepared, item) {
  const iv = itemVectors(prepared, item);
  if (!iv) return null;
  return {
    media: iv.m,
    pools: prepared.pools[iv.m].map((pool) => {
      const mean = new Float64Array(pool.members.length);
      for (const v of iv.vecs) {
        const p = poolProbs(pool, v);
        for (let i = 0; i < p.length; i++) mean[i] += p[i];
      }
      for (let i = 0; i < mean.length; i++) mean[i] /= iv.vecs.length;
      return { pool, probs: mean };
    }),
  };
}

/**
 * Each concept's probability in the pool that can suggest it for this item's media (its own
 * entry's lens), averaged over the item's vectors. → Map(concept_id → p) or null when not scorable.
 */
export function homeProbabilities(prepared, item) {
  const pp = poolProbabilities(prepared, item);
  if (!pp) return null;
  const out = new Map();
  for (const { pool, probs } of pp.pools) {
    pool.members.forEach((c, i) => { if (pool.own.has(c.id)) out.set(c.id, probs[i]); });
  }
  return out;
}

/**
 * The same-name rule: concepts whose EN or UZ label equals (by `nameKey`) one of `names`, the
 * names of the people's tags (source user/import) an item already has. → Set of concept ids.
 */
export function sameNameConcepts(prepared, names = []) {
  const out = new Set();
  for (const n of names) {
    if (typeof n !== 'string') continue;
    const hit = prepared.byLabel.get(nameKey(n));
    if (hit) for (const id of hit) out.add(id);
  }
  return out;
}

/**
 * §5.4 filter: drop answered and owned concepts and the same-name ones (`sameName`, from
 * `sameNameConcepts`); keep existing col:* hints unless answered.
 */
export function filterScores(scores, { answered = new Set(), owned = new Set(), sameName = new Set(), existing = null } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(scores)) if (!answered.has(k) && !owned.has(k) && !sameName.has(k)) out[k] = v;
  if (existing) {
    for (const [k, v] of Object.entries(existing)) if (k.startsWith('col:') && !answered.has(k)) out[k] = v;
  }
  return out;
}

/**
 * What the app stores for one item (§5.4 write path): `scoreItem`, then the filter for what the
 * item already holds. item (besides scoreItem's fields):
 *   peopleTags?: names of its people's tags (source user/import), for the same-name rule
 *   ownedConcepts?: Set of concept ids it has as tags · answered?: Set of answered concept ids
 * Returns null like scoreItem, else scoreItem's result with `scores` and `byLens` filtered and
 * `dropped`: the concept ids the same-name rule removed (nothing moves up to take their place).
 */
export function suggestItem(prepared, item) {
  const r = scoreItem(prepared, item);
  if (!r) return null;
  const sameName = sameNameConcepts(prepared, item.peopleTags || []);
  const answered = item.answered || new Set();
  const owned = item.ownedConcepts || new Set();
  const scores = filterScores(r.scores, { answered, owned, sameName });
  const byLens = {};
  for (const [lid, list] of Object.entries(r.byLens)) byLens[lid] = list.filter((s) => Object.prototype.hasOwnProperty.call(scores, s.id));
  const dropped = Object.keys(r.scores).filter((k) => sameName.has(k));
  return { ...r, scores, byLens, dropped };
}

/** §5.4 signature over the INSTALLED lenses: [{id, sha256}] → 16 hex chars (tagging.rs `signature`:
 *  "lens-score-4|clip-b32-q8|maxvid=60|" + the sorted "<id>@<sha256>" joined by ","). */
export function lensSignature(installed, maxVideoSecs = MAX_TAG_VIDEO_SECS) {
  const parts = installed.map((l) => `${l.id}@${l.sha256}`).sort();
  return createHash('sha256').update(`${SIG_PREFIX}maxvid=${maxVideoSecs}|${parts.join(',')}`).digest('hex').slice(0, 16);
}

/** A lens's card rank (lenses.js lensOrderIndex): motion 0, thumbnail 1, another specialist 2,
 *  design or another base 3. */
export function cardRank(prepared, lensId) {
  if (Object.prototype.hasOwnProperty.call(CARD_RANK, lensId)) return CARD_RANK[lensId];
  return prepared.lenses.get(lensId)?.role === 'base' ? RANK_OTHER_BASE : RANK_OTHER_SPECIALIST;
}

/**
 * §0c display rule for one concept key on an item of media `kind` ('picture' | 'video'): the first
 * enabled lens, in card order, that shows it → { lens, via: 'own' | 'borrow', rank }, or null
 * when no enabled lens does. A lens L shows key k on media m when
 *   'own'     L has a scored entry for k covering m, or
 *   'borrow'  L is a specialist, borrows k, and the base lens's entry for k is scored and covers m.
 * Add-by-hand entries cover nothing, so they never make a key visible. Lens ids that aren't
 * installed are ignored; two lenses with the same rank are ordered by id.
 */
export function shownBy(prepared, key, { enabled = [], kind = 'picture' } = {}) {
  const m = mediaKind(kind);
  if (!prepared.concepts.has(key)) return null;
  const baseEntry = prepared.entries.get(entryKey(prepared.baseId, key)) || null;
  let best = null;
  for (const lid of new Set(enabled)) {
    const l = prepared.lenses.get(lid);
    if (!l) continue;
    let via = null;
    if (covers(prepared.entries.get(entryKey(lid, key)), m)) via = 'own';
    else if (l.role !== 'base' && l.borrows.includes(key) && covers(baseEntry, m)) via = 'borrow';
    if (!via) continue;
    const rank = cardRank(prepared, lid);
    if (!best || rank < best.rank || (rank === best.rank && lid < best.lens)) best = { lens: lid, via, rank };
  }
  return best;
}

/**
 * §0c display rule for an item's stored keys. scores: {key: score}; enabled: lens ids switched on;
 * kind: the item's media ('picture' | 'video'); colTags: Set of tag ids that still exist (for
 * `col:<tag id>` keys); on: the suggestions switch. Unknown keys, add-by-hand concepts and
 * non-numeric scores never show.
 * → [{ key, score, lens, via: 'own'|'borrow'|'col', rank }] in card order (rank, then score
 * descending, then key ascending), capped at 3 for a picture and 2 for a video.
 */
export function visibleDetail(prepared, scores, { enabled = [], kind = 'picture', colTags = new Set(), on = true } = {}) {
  if (!on) return [];
  const rows = [];
  for (const [key, score] of Object.entries(scores || {})) {
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    if (key.startsWith('col:')) {
      if (colTags.has(key.slice(4))) rows.push({ key, score, lens: null, via: 'col', rank: RANK_COLLECTION_HINT });
      continue;
    }
    const s = shownBy(prepared, key, { enabled, kind });
    if (s) rows.push({ key, score, lens: s.lens, via: s.via, rank: s.rank });
  }
  rows.sort((a, b) => a.rank - b.rank || b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows.slice(0, mediaKind(kind) === 'video' ? VIDEO_MAX : PICTURE_MAX);
}

/** `visibleDetail`, keys only. */
export function visibleSuggestions(prepared, scores, opts = {}) {
  return visibleDetail(prepared, scores, opts).map((r) => r.key);
}

/**
 * §0c tag picker: one row per concept id that an enabled lens has an entry for (scored or
 * add-by-hand) or borrows; the item's media and the suggestions switch don't matter. Order isn't
 * part of the rule; here: lenses in LENS_ORDER, each lens's entries in file order, then its borrows.
 */
export function pickerConceptIds(prepared, enabled = []) {
  const on = new Set(enabled);
  const rank = (id) => { const i = LENS_ORDER.indexOf(id); return i < 0 ? LENS_ORDER.length : i; };
  const ids = [...prepared.lenses.keys()].filter((id) => on.has(id)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  const seen = new Set();
  for (const lid of ids) {
    const l = prepared.lenses.get(lid);
    for (const id of [...l.conceptIds, ...l.borrows]) {
      if (seen.has(id) || !prepared.concepts.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
