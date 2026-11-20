#!/usr/bin/env node
// Lens measurement on the private library copy (spec §9, §10, §0c). Read-only on the DB copy.
//
// Inputs: picture vectors from clip_embeddings (model clip-b32-q8, made by the Rust indexer);
// video frame vectors from embed-frames.mjs (default) or a clip_frames table (--frames db; rows of
// both schedules, embed-frames.mjs FRAMES_TAG and FRAMES_TAG_8, as the app reads them);
// built lens files (default: src-tauri/lenses/qooti-lens-*.json).
// It runs lens-score.mjs (= spec §5 + §0c) for every item and writes to --out:
//   report.json / report.md   one row per lens ENTRY (a tag in two lenses has two rows: e.g.
//                              design's for pictures, motion's for videos): counts and fire rates
//                              (flag > 25 %), entries that never fire, add-by-hand entries,
//                              near-duplicate pairs inside each media pool (Pearson r ≥ 0.75 of the
//                              probabilities two members of one pool get per item), out-of-domain
//                              fires, and what each role would see (§0c display rule)
//   judge/sheet-NN.json        BLIND sheets: suggestions made at a low bar (default 0.15) so one
//                              judging pass scores every bar; per item the image (or 3 frames + a
//                              contact sheet) and each concept's English label. No scores, no lens names.
//   judge/answers-NN.json      the matching answer templates (item + concept id, as the judgments)
//   judge/domain-sheet.json    (with --domain-sheet) items to mark as clearly out of a role's domain
// With --judgments it adds strict/lenient precision and coverage per lens and per entry at bars
// 0.15/0.20/0.25/0.30/0.35/0.40 (and at each lens's own bar). Judgments stay keyed by item + concept
// id: an item has one media, so at most one entry of a tag can suggest it there.
//
//   node scripts/lenses/measure.mjs --lens motion --out "E:/DP 2/qooti-tag-eval/runs/motion"
//        [--judgments "E:/DP 2/qooti-tag-eval/judgments"] [--domains <file>]
//        [--judge-lens motion] [--judge-bar 0.15] [--sheet-size 40] [--round 1] [--seed 1]
//        [--base <design build to anchor with>] [--files a.json,b.json] [--lens-dir <dir>]
//        [--db <copy>] [--frames <frame-vectors.json>|db] [--no-sheets] [--no-previews] [--domain-sheet]
//        [--discard-answers]  (re-running refuses to wipe answers-NN.json files that hold verdicts
//                              not yet saved in the judgments folder, unless this is given)
//        [--max-video-secs 60] videos longer than this (+0.5 s) are left out entirely, as the app
//                              does (spec §0.11, tagging.rs MAX_TAG_VIDEO_SECS); Infinity keeps all
// Like the app (lens-score.mjs `videoStatus`), a video needs a known length: the DB's
// duration_secs, else the length embed-frames measured. A video with frames but no length is left
// out entirely (the app can't tag it), one with neither is counted as waiting. Like the app's write
// path (`suggestItem`), a concept is never suggested to an item that has a people's tag (source
// user/import, read from the DB copy) with the same name as its EN or UZ label (the same-name rule).
// The base lens is always included (it anchors every pool). Privacy: report files carry item ids
// as 8 characters and counts only; judge sheets (private, eval folder) carry local paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs, runMain } from './lib/args.mjs';
import { BUNDLED_DIR, DB_COPY, FRAME_VECTORS, PREVIEWS_DIR, RUNS_DIR, FRAMES_DIR, JUDGMENTS_DIR, slash } from './lib/paths.mjs';
import { openReadOnly, hasTable } from './lib/db.mjs';
import { decodeF16, decodeF32, fromBase64, normalize } from './lib/f16.mjs';
import {
  prepareLenses, suggestItem, poolProbabilities, visibleDetail, lensSignature, barKind, covers, LENS_ORDER,
  MEDIA_KINDS, MAX_TAG_VIDEO_SECS, videoStatus, lengthKnown,
} from './lens-score.mjs';
import { checkLensObject, checkCatalogue } from './check.mjs';
import { FRAMES_TAG, FRAMES_TAG_8 } from './embed-frames.mjs';

export const BARS = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
export const FIRE_FLAG = 0.25;
export const DUP_R = 0.75;
const VERDICT_RANK = { no: 0, partly: 1, yes: 2 };
/** Lens-file problems that break scoring itself (the rest are only noted). */
const CRITICAL = /^(dup\.concept_id|shared\.media_overlap|catalogue\.base|vec\.|lens\.json|lens\.concepts|concept\.(id|media|aspect|type|suggest)|lens\.role|lens\.bar)/;
const id8 = (id) => id.slice(0, 8);
const pct = (x) => (x == null || !Number.isFinite(x) ? '–' : `${(100 * x).toFixed(1)} %`);
const fx = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const rank = (id) => { const i = LENS_ORDER.indexOf(id); return i < 0 ? 99 : i; };

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ── Lenses ────────────────────────────────────────────────────────────────────────────────

function readLens(file) {
  const buf = fs.readFileSync(file);
  const data = JSON.parse(buf.toString('utf8'));
  return { ...data, sha256: crypto.createHash('sha256').update(buf).digest('hex'), file };
}

export function loadLensSet({ lensDir = BUNDLED_DIR, files = [], lensIds = [], baseFile = null, log = console.log } = {}) {
  const paths = files.length ? files.map((f) => path.resolve(f))
    : (fs.existsSync(lensDir) ? fs.readdirSync(lensDir).filter((f) => /^qooti-lens-.*\.json$/.test(f)).sort().map((f) => path.join(lensDir, f)) : []);
  let lenses = [];
  for (const p of paths) {
    let l;
    try { l = readLens(p); } catch (e) { log(`  skip ${path.basename(p)}: ${e.message}`); continue; }
    if (l.placeholder === true) { log(`  skip ${path.basename(p)}: placeholder (not a real lens)`); continue; }
    lenses.push(l);
  }
  if (baseFile) {
    const b = readLens(path.resolve(baseFile));
    if (b.role !== 'base') throw new Error(`--base ${baseFile} is not a base lens`);
    if (b.placeholder === true) throw new Error(`--base ${baseFile} is a placeholder, not a real build`);
    lenses = lenses.filter((l) => l.role !== 'base' && l.id !== b.id);
    lenses.push(b);
  }
  if (lensIds.length) {
    for (const id of lensIds) if (!lenses.some((l) => l.id === id)) throw new Error(`lens ${id} is not built (no qooti-lens-${id}.json); run build.mjs --lens ${id}`);
    lenses = lenses.filter((l) => lensIds.includes(l.id) || l.role === 'base');
  }
  const bases = lenses.filter((l) => l.role === 'base');
  if (bases.length !== 1) {
    throw new Error(bases.length ? `${bases.length} base lenses loaded (${bases.map((b) => b.id).join(', ')})`
      : 'no base lens: every pool is anchored by design. Build it first (build.mjs --lens design) or pass --base <a design build>');
  }
  // The same checks Rust applies; only problems that break scoring stop the run.
  const issues = { list: [], error(code, l, where, msg) { this.list.push({ level: 'error', code, where, msg }); }, warn(code, l, where, msg) { this.list.push({ level: 'warning', code, where, msg }); } };
  for (const l of lenses) {
    const { sha256, file, ...data } = l;
    checkLensObject(issues, data, { kind: 'built', file: path.basename(file) === `qooti-lens-${l.id}.json` ? file : '', countTokens: null });
  }
  checkCatalogue(issues, lenses, { kind: 'built' });
  const critical = issues.list.filter((i) => i.level === 'error' && CRITICAL.test(i.code));
  const other = issues.list.filter((i) => !critical.includes(i));
  for (const i of other) log(`  note ${i.code} ${i.where}: ${i.msg}`);
  if (critical.length) {
    for (const i of critical) log(`  ERROR ${i.code} ${i.where}: ${i.msg}`);
    throw new Error('these lens files can\'t be scored (see above)');
  }
  lenses.sort((x, y) => rank(x.id) - rank(y.id) || x.id.localeCompare(y.id));
  return lenses;
}

// ── Items ─────────────────────────────────────────────────────────────────────────────────

function decodeFrames(f16b64, n) {
  if (!n) return [];
  const vals = decodeF16(fromBase64(f16b64));
  if (vals.length !== n * 512) throw new Error('frame blob size mismatch');
  const out = [];
  for (let i = 0; i < n; i++) out.push(normalize(vals.subarray(i * 512, (i + 1) * 512)));
  return out;
}

/**
 * People's tags (source user/import; never lens or old suggestion tags) per item: id → [name].
 * The same-name rule compares these names with the concept labels.
 */
export function readPeopleTags(db) {
  const out = new Map();
  if (!hasTable(db, 'tags') || !hasTable(db, 'inspiration_tags')) return out;
  const hasSource = !!db.prepare("SELECT 1 FROM pragma_table_info('tags') WHERE name = 'source'").get();
  const rows = db.prepare(`SELECT it.inspiration_id AS id, t.name AS name
    FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id
    ${hasSource ? "WHERE t.source IN ('user', 'import')" : ''}
    ORDER BY it.inspiration_id, t.name`).all();
  for (const r of rows) {
    if (typeof r.name !== 'string') continue;
    if (!out.has(r.id)) out.set(r.id, []);
    out.get(r.id).push(r.name);
  }
  return out;
}

export async function loadItems({ dbFile = DB_COPY, frames = FRAME_VECTORS, maxVideoSecs = MAX_TAG_VIDEO_SECS, log = console.log } = {}) {
  const db = await openReadOnly(dbFile);
  const hasDuration = !!db.prepare("SELECT 1 FROM pragma_table_info('inspirations') WHERE name = 'duration_secs'").get();
  const rows = db.prepare(`SELECT id, type, aspect_ratio AS aspect, stored_path AS path, thumbnail_path AS thumb,
    ${hasDuration ? 'duration_secs' : 'NULL'} AS dur
    FROM inspirations ORDER BY created_at DESC, id`).all();
  const emb = new Map();
  for (const r of db.prepare("SELECT id, emb FROM clip_embeddings WHERE model = 'clip-b32-q8'").all()) {
    if (r.emb && r.emb.length === 2048) emb.set(r.id, normalize(decodeF32(r.emb)));
  }
  const peopleTags = readPeopleTags(db);
  const frameMap = new Map();
  let framesSource;
  if (frames === 'db') {
    framesSource = 'clip_frames table';
    if (hasTable(db, 'clip_frames')) {
      for (const r of db.prepare('SELECT id, n, emb FROM clip_frames WHERE model IN (?, ?)').all(FRAMES_TAG, FRAMES_TAG_8)) {
        const n = Number(r.n) || 0;
        const vals = n ? decodeF16(r.emb) : [];
        const vecs = [];
        for (let i = 0; i < n; i++) vecs.push(normalize(vals.subarray(i * 512, (i + 1) * 512)));
        frameMap.set(r.id, { vecs, slots: null, duration: null });
      }
    } else log('  note: the DB copy has no clip_frames table; videos are not scored');
  } else {
    framesSource = `embed-frames output (${slash(frames)})`;
    let store = null;
    try { store = JSON.parse(fs.readFileSync(frames, 'utf8')); } catch { log(`  note: no frame vectors at ${slash(frames)}; run embed-frames.mjs (videos are not scored)`); }
    if (store && store.items) {
      for (const [id, it] of Object.entries(store.items)) {
        // A long video embed-frames measured has no frames: it only records the length it found.
        frameMap.set(id, it.long ? { vecs: null, slots: null, duration: it.duration } : { vecs: decodeFrames(it.f16, it.n), slots: it.slots || null, duration: it.duration });
      }
    }
  }
  db.close();
  let longVideos = 0, noLength = 0;
  const items = rows.map((r) => {
    const kind = r.type === 'video' ? 'video' : (r.type === 'image' || r.type === 'gif') ? 'picture' : null;
    if (!kind) return null;
    const fr = frameMap.get(r.id);
    const tags = peopleTags.get(r.id) || [];
    if (kind === 'picture') {
      return { id: r.id, kind, type: r.type, aspect: typeof r.aspect === 'number' ? r.aspect : null, path: r.path, thumb: r.thumb, vector: emb.get(r.id) || null, peopleTags: tags };
    }
    // The app stores the length the indexer measured; here that is the one embed-frames found.
    const duration = lengthKnown(r.dur) ? r.dur : (fr && lengthKnown(fr.duration) ? fr.duration : null);
    const frameVecs = fr ? fr.vecs : null;
    const status = videoStatus(duration, frameVecs, maxVideoSecs);
    // §0.11: the app never tags videos over the limit (not even from their cover) and leaves
    // them out of every total, so they're not part of the population at all; nor is a video
    // whose length couldn't be measured (no cover fallback either)
    if (status === 'long') { longVideos++; return null; }
    if (status === 'no_length') { noLength++; return null; }
    return {
      id: r.id, kind, type: r.type, aspect: typeof r.aspect === 'number' ? r.aspect : null, path: r.path, thumb: r.thumb,
      duration, frames: frameVecs, slots: fr ? fr.slots : null, cover: emb.get(r.id) || null, peopleTags: tags,
    };
  }).filter(Boolean);
  if (longVideos) log(`  left out ${longVideos} videos longer than ${maxVideoSecs} s (+0.5 s), as the app does`);
  if (noLength) log(`  left out ${noLength} videos whose length couldn't be measured, as the app does`);
  return { items, framesSource, longVideos, noLength };
}

// ── Judgments ─────────────────────────────────────────────────────────────────────────────

/** Loads judgment files (JSON arrays) from files and/or folders; resolves repeats. */
export function loadJudgments(sources, { log = console.log } = {}) {
  const files = [];
  for (const s of sources) {
    if (!fs.existsSync(s)) { log(`  note: judgments path not found: ${slash(s)}`); continue; }
    if (fs.statSync(s).isDirectory()) for (const f of fs.readdirSync(s).filter((x) => x.endsWith('.json')).sort()) files.push(path.join(s, f));
    else files.push(s);
  }
  const best = new Map();
  let total = 0, blank = 0, bad = 0, conflicts = 0;
  for (const f of files) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { log(`  note: ${path.basename(f)} is not valid JSON; skipped`); continue; }
    if (!Array.isArray(arr) || !arr.some((x) => x && typeof x === 'object' && 'verdict' in x)) continue;
    for (const j of arr) {
      if (!j || typeof j !== 'object') { bad++; continue; }
      if (j.verdict === '' || j.verdict == null) { blank++; continue; }
      if (typeof j.item !== 'string' || j.item.length !== 8 || typeof j.concept !== 'string' || !(j.verdict in VERDICT_RANK)) { bad++; continue; }
      total++;
      const round = Number.isInteger(j.round) ? j.round : 1;
      const k = `${j.item}|${j.concept}`;
      const prev = best.get(k);
      if (!prev || round > prev.round) best.set(k, { verdict: j.verdict, round, judges: new Set([j.judge || '?']) });
      else if (round === prev.round) {
        if (j.verdict !== prev.verdict) conflicts++;
        if (VERDICT_RANK[j.verdict] < VERDICT_RANK[prev.verdict]) prev.verdict = j.verdict;
        prev.judges.add(j.judge || '?');
      }
    }
  }
  return { map: best, stats: { files: files.length, entries: total, unique: best.size, blank, bad, conflicts } };
}

// ── Statistics helpers ────────────────────────────────────────────────────────────────────

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx < 1e-18 || syy < 1e-18) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const aspectClass = (a) => (a == null ? 'unknown' : a < 0.9 ? 'portrait' : a <= 1.15 ? 'square' : 'landscape');
const OOD_GROUPS = ['media:picture', 'media:video', 'aspect:portrait', 'aspect:square', 'aspect:landscape', 'aspect:unknown'];

/** A JSON array with one compact object per line (easy to fill in with an editor). */
export const oneLinePerEntry = (arr) => `[\n${arr.map((x) => ` ${JSON.stringify(x)}`).join(',\n')}\n]\n`;

// ── Analysis (pure; exported for the tests) ───────────────────────────────────────────────
// `items` are scored items ({id, kind: 'picture'|'video', aspect, …}); `results` maps an item id to
// what lens-score.mjs `suggestItem` gave it ({rule, scores, byLens}). byLens names the pool (lens)
// that made each suggestion: with shared tags (§0c) a concept id alone no longer says which lens.

const dotv = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/**
 * Every suggestion as {item, concept, lens, score, kind}: `lens` = the pool that made it, `kind` =
 * the bar it was held to ('video' for the video rule, else 'picture'). Judging keys it by
 * item + concept id (one media per item, so one entry per tag can make it).
 */
export function suggestionPairs(items, results) {
  const out = [];
  for (const it of items) {
    const r = results.get(it.id);
    if (!r) continue;
    for (const [lens, list] of Object.entries(r.byLens)) {
      for (const s of list) out.push({ item: it, concept: s.id, lens, score: s.score, kind: barKind(r.rule) });
    }
  }
  return out;
}

/**
 * One row per scored ENTRY (lens order, then file order): how often that lens's entry fired, over
 * the scored items whose media it covers (`eligible`). A tag with entries in two lenses gets two
 * rows. `lowResults`: the same at the judging bar (for `low_bar_fires`).
 */
export function entryStats(prepared, items, results, lowResults = new Map()) {
  const rows = [];
  for (const l of prepared.lenses.values()) {
    for (const e of l.entries) {
      if (!e.suggest) continue;
      const fires = { picture: 0, video: 0 };
      let lowFires = 0, sum = 0, eligible = 0;
      const top = [];
      for (const it of items) {
        const r = results.get(it.id);
        if (!r || !covers(e, it.kind)) continue;
        eligible++;
        const hit = (r.byLens[l.id] || []).find((s) => s.id === e.id);
        if (hit) { fires[it.kind]++; sum += hit.score; top.push([hit.score, id8(it.id)]); }
        if ((lowResults.get(it.id)?.byLens[l.id] || []).some((s) => s.id === e.id)) lowFires++;
      }
      const total = fires.picture + fires.video;
      top.sort((x, y) => y[0] - x[0]);
      rows.push({
        lens: l.id, id: e.id, label: e.label?.en ?? e.id, group: e.group?.en ?? null, media: e.media, aspect: e.aspect,
        shared: prepared.concepts.get(e.id).entries.length > 1,
        fires, fires_total: total, eligible, rate: eligible ? total / eligible : 0,
        flag: eligible > 0 && total / eligible > FIRE_FLAG,
        mean_score: total ? sum / total : null,
        low_bar_fires: lowFires,
        examples: top.slice(0, 3).map((x) => x[1]),
      });
    }
  }
  return rows;
}

/** The add-by-hand entries ("suggest": false): in the picker, never scored. */
export function handEntries(prepared) {
  const out = [];
  for (const l of prepared.lenses.values()) {
    for (const e of l.entries) if (!e.suggest) out.push({ lens: l.id, id: e.id, label: e.label?.en ?? e.id, group: e.group?.en ?? null });
  }
  return out;
}

/** Per lens and media: items that got a suggestion from that lens's own pool. */
export function lensCoverage(prepared, items, results) {
  const out = {};
  for (const lid of prepared.lenses.keys()) {
    const row = {};
    for (const kind of MEDIA_KINDS) {
      const pop = items.filter((i) => i.kind === kind && results.has(i.id));
      let withS = 0, n = 0;
      for (const it of pop) {
        const k = (results.get(it.id).byLens[lid] || []).length;
        if (k) withS++;
        n += k;
      }
      row[kind] = { items: pop.length, items_with_suggestion: withS, rate: pop.length ? withS / pop.length : 0, suggestions: n };
    }
    out[lid] = row;
  }
  return out;
}

/** The (item, concept) pairs a role sees: only `lensId` on, the §0c display rule, card caps. */
export function shownToRole(prepared, lensId, items, results) {
  const out = [];
  for (const it of items) {
    const r = results.get(it.id);
    if (!r) continue;
    for (const v of visibleDetail(prepared, r.scores, { enabled: [lensId], kind: it.kind })) out.push({ item: it, concept: v.key, via: v.via });
  }
  return out;
}

/**
 * What each role would see with only its lens on (§0c display rule): items with a visible
 * suggestion, the average number shown, and whether the first question is a borrowed tag
 * (shown through `borrows`) or one of the lens's own entries.
 */
export function roleViews(prepared, items, results) {
  const out = {};
  const scored = items.filter((i) => results.has(i.id));
  for (const lid of prepared.lenses.keys()) {
    let withV = 0, nV = 0, borrowedFirst = 0, ownFirst = 0;
    for (const it of scored) {
      const vis = visibleDetail(prepared, results.get(it.id).scores, { enabled: [lid], kind: it.kind });
      if (vis.length) {
        withV++;
        if (vis[0].via === 'borrow') borrowedFirst++; else ownFirst++;
      }
      nV += vis.length;
    }
    out[lid] = {
      items: scored.length, items_with_visible: withV, rate: scored.length ? withV / scored.length : 0,
      avg_visible: scored.length ? nV / scored.length : 0, first_is_own: ownFirst, first_is_borrowed: borrowedFirst,
    };
  }
  return out;
}

/**
 * Near-duplicates inside each media pool (§0c): for every pool of each media, Pearson r over that
 * media's scored items of the probabilities two members get in that pool (mean over a video's
 * frames). Pairs with at least one of the pool's own entries are compared (two base members of a
 * specialist pool are the base pool's pair). Members of different pools never compete in one
 * softmax, so e.g. design's picture entry and motion's video entry of one tag are never a pair.
 * → [{media, pool, a, a_lens, b, b_lens, anchor, r, items, text_cos}], highest r first;
 * `anchor` names the base member of an own-vs-base pair (null when both are own).
 */
export function nearDuplicates(prepared, items, { minR = DUP_R } = {}) {
  const out = [];
  for (const m of MEDIA_KINDS) {
    const pools = prepared.pools[m];
    const rows = pools.map(() => []);
    for (const it of items) {
      if (it.kind !== m) continue;
      const pp = poolProbabilities(prepared, it);
      if (pp) pp.pools.forEach((x, pi) => rows[pi].push(x.probs));
    }
    pools.forEach((pool, pi) => {
      const k = pool.members.length;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          const a = pool.members[i], b = pool.members[j];
          const aOwn = pool.own.has(a.id), bOwn = pool.own.has(b.id);
          if (!aOwn && !bOwn) continue;
          const xs = rows[pi].map((p) => p[i]), ys = rows[pi].map((p) => p[j]);
          const r = pearson(xs, ys);
          if (r == null || r < minR) continue;
          out.push({
            media: m, pool: pool.lensId, a: a.id, a_lens: a.lensId, b: b.id, b_lens: b.lensId,
            anchor: aOwn && bOwn ? null : (aOwn ? b.id : a.id),
            r: +r.toFixed(3), items: xs.length, text_cos: +dotv(a.vec, b.vec).toFixed(3),
          });
        }
      }
    });
  }
  out.sort((x, y) => y.r - x.r || (x.media < y.media ? -1 : x.media > y.media ? 1 : 0));
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

async function makePreview(item, file) {
  const sharp = (await import('sharp')).default;
  await sharp(item.path, { pages: 1, failOn: 'none', limitInputPixels: false }).rotate()
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#808080' })
    .jpeg({ quality: 80 }).toFile(file);
}

function pickFrames(slots, dir) {
  if (!slots || !slots.length) return [];
  // slots 1, 4 and 6 of 8; the same places in a longer schedule (one frame per second, up to 32)
  const n = Math.max(8, Math.max(...slots) + 1);
  const want = [1, 4, 6].map((w) => Math.round((w * n) / 8));
  const chosen = [];
  for (const w of want) {
    let best = null;
    for (const s of slots) if (!chosen.includes(s) && (best == null || Math.abs(s - w) < Math.abs(best - w))) best = s;
    if (best != null) chosen.push(best);
  }
  return chosen.sort((x, y) => x - y).map((s) => slash(path.join(dir, `f${s}.jpg`)));
}

async function main(argv) {
  const a = parseArgs(argv, {
    flags: ['help', 'no-sheets', 'no-previews', 'domain-sheet', 'discard-answers'],
    options: ['db', 'frames', 'out', 'judge-bar', 'sheet-size', 'seed', 'base', 'lens-dir', 'round', 'domain-sample', 'max-video-secs'],
    multi: ['lens', 'files', 'judgments', 'judge-lens', 'domains'],
  });
  if (a.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n')); return 0; }
  const T0 = performance.now();
  const judgeBar = Number(a['judge-bar'] ?? 0.15);
  if (!(judgeBar > 0 && judgeBar < 1)) throw new Error('--judge-bar must be between 0 and 1');
  const sheetSize = Math.max(5, Number(a['sheet-size'] || 40));
  // Frame JPEGs live next to the frame-vectors file embed-frames wrote.
  const framesDir = a.frames && a.frames !== 'db' ? path.dirname(path.resolve(a.frames)) : FRAMES_DIR;
  const round = Number(a.round || 1);
  const seed = Number(a.seed || 1);
  const maxVideoSecs = a['max-video-secs'] != null ? Number(a['max-video-secs']) : MAX_TAG_VIDEO_SECS;
  if (!(maxVideoSecs > 0)) throw new Error('--max-video-secs must be a number of seconds above 0 (Infinity keeps every video)');

  // Lenses
  const lenses = loadLensSet({ lensDir: a['lens-dir'] || BUNDLED_DIR, files: a.files, lensIds: a.lens, baseFile: a.base || null });
  const outDir = path.resolve(a.out || path.join(RUNS_DIR, lenses.map((l) => l.id).join('+')));
  fs.mkdirSync(outDir, { recursive: true });
  const judgeLenses = new Set(a['judge-lens'].length ? a['judge-lens'] : (a.lens.length ? a.lens : lenses.map((l) => l.id)));
  const prepared = prepareLenses(lenses, { maxVideoSecs });
  const low = prepareLenses(lenses, { barOverride: { picture: judgeBar, video: judgeBar }, maxVideoSecs });
  for (const l of lenses) {
    if (l.bar.picture < judgeBar || l.bar.video < judgeBar) console.log(`  note: ${l.id} has a bar below the judging bar ${judgeBar}; its sheets miss some shown suggestions`);
  }
  const signature = lensSignature(lenses, maxVideoSecs);
  const entryCount = (l) => { const m = prepared.lenses.get(l.id); return m.handIds.length ? `${m.scoredIds.length} + ${m.handIds.length} by hand` : `${m.scoredIds.length}`; };
  console.log(`lenses: ${lenses.map((l) => `${l.id} v${l.version} (${entryCount(l)})`).join(', ')} · sig ${signature}`);

  // Items
  const tl = performance.now();
  const { items, framesSource, longVideos, noLength } = await loadItems({ dbFile: a.db || DB_COPY, frames: a.frames === 'db' ? 'db' : (a.frames || FRAME_VECTORS), maxVideoSecs });
  const loadMs = performance.now() - tl;

  // Score: what the app stores (the write path drops same-name concepts)
  const ts = performance.now();
  const results = new Map();
  const lowResults = new Map();
  const sameName = { items_with_people_tags: items.filter((i) => i.peopleTags.length).length, items: 0, suggestions: 0, low_bar_suggestions: 0, dropped: [] };
  for (const it of items) {
    const r = suggestItem(prepared, it);
    if (r) {
      results.set(it.id, r);
      if (r.dropped.length) { sameName.items++; sameName.suggestions += r.dropped.length; for (const c of r.dropped) sameName.dropped.push({ item: id8(it.id), concept: c }); }
    }
    const r2 = suggestItem(low, it);
    if (r2) { lowResults.set(it.id, r2); sameName.low_bar_suggestions += r2.dropped.length; }
  }
  const scoreMs = performance.now() - ts;

  // Populations
  const pics = items.filter((i) => i.kind === 'picture');
  const vids = items.filter((i) => i.kind === 'video');
  const ruleCount = (rule) => [...results.values()].filter((r) => r.rule === rule).length;
  const counts = {
    items: items.length, pictures: pics.length, videos: vids.length,
    pictures_with_vectors: pics.filter((i) => i.vector).length,
    videos_with_frames: vids.filter((i) => i.frames && i.frames.length > 1).length,
    videos_one_frame: vids.filter((i) => i.frames && i.frames.length === 1).length,
    videos_frames_failed: vids.filter((i) => i.frames && i.frames.length === 0).length,
    videos_cover_fallback: ruleCount('cover'),
    videos_no_frames_row: vids.filter((i) => i.frames == null).length,   // waiting for the indexer
    scored: results.size, not_scored: items.length - results.size,
    rule: { picture: ruleCount('picture'), video: ruleCount('video'), frame1: ruleCount('frame1'), cover: ruleCount('cover') },
    long_videos_left_out: longVideos, no_length_videos_left_out: noLength, max_video_secs: maxVideoSecs,
    same_name: sameName,
  };
  const scoredItems = items.filter((i) => results.has(i.id));

  // Per entry (a tag in two lenses has a row for each), per lens, per role
  const entryRows = entryStats(prepared, scoredItems, results, lowResults);
  const hand = handEntries(prepared);
  const perLens = lensCoverage(prepared, scoredItems, results);
  const roleView = roleViews(prepared, scoredItems, results);
  /** A lens fired on an item when its own pool made a suggestion there (byLens). */
  const lensFired = (it, lid) => (results.get(it.id).byLens[lid] || []).length > 0;

  // Near-duplicates inside each media pool
  const td = performance.now();
  const dups = nearDuplicates(prepared, scoredItems);
  const dupMs = performance.now() - td;

  // Out of domain: a metadata proxy, plus labelled items when --domains is given
  const ood = { proxy: {}, labelled: null };
  for (const l of lenses.filter((x) => x.role === 'specialist')) {
    const groups = {};
    for (const it of scoredItems) {
      const keys = [`media:${it.kind}`, `aspect:${aspectClass(it.aspect)}`];
      const fired = lensFired(it, l.id);
      for (const g of keys) { groups[g] ||= { items: 0, fired: 0 }; groups[g].items++; if (fired) groups[g].fired++; }
    }
    for (const g of Object.values(groups)) g.rate = g.items ? g.fired / g.items : 0;
    ood.proxy[l.id] = Object.fromEntries(OOD_GROUPS.filter((k) => groups[k]).map((k) => [k, groups[k]]));
  }
  if (a.domains.length) {
    const labels = new Map();
    for (const f of a.domains) {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const d of arr) if (d && typeof d.item === 'string' && Array.isArray(d.out)) labels.set(d.item, new Set(d.out));
    }
    ood.labelled = {};
    for (const l of lenses.filter((x) => x.role === 'specialist')) {
      let n = 0, fired = 0;
      const ex = [];
      for (const it of scoredItems) {
        const out = labels.get(id8(it.id));
        if (!out || !out.has(l.id)) continue;
        n++;
        if (lensFired(it, l.id)) { fired++; if (ex.length < 10) ex.push(id8(it.id)); }
      }
      ood.labelled[l.id] = { out_of_domain_items: n, fired, rate: n ? fired / n : null, target: 0.05, examples: ex };
    }
  }

  // Judging: low-bar suggestions, minus what's already judged (keyed by item + concept id)
  const J = a.judgments.length ? loadJudgments(a.judgments) : null;
  const judged = J ? J.map : new Map();
  const pairs = suggestionPairs(scoredItems, lowResults);
  const judgeable = pairs.filter((p) => judgeLenses.has(p.lens));
  const todo = judgeable.filter((p) => !judged.has(`${id8(p.item.id)}|${p.concept}`));
  const judging = { bar: judgeBar, lenses: [...judgeLenses], pairs: judgeable.length, already_judged: judgeable.length - todo.length, to_judge: todo.length, sheets: [] };
  if (!a['no-sheets']) {
    const jdir = path.join(outDir, 'judge');
    // Never wipe answers someone filled in place but didn't save to the judgments folder yet.
    if (fs.existsSync(jdir) && !a['discard-answers']) {
      const saved = J ? judged : loadJudgments([JUDGMENTS_DIR], { log: () => {} }).map;
      let unsaved = 0;
      const files = [];
      for (const f of fs.readdirSync(jdir).filter((x) => /^answers-\d+\.json$/.test(x))) {
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(path.join(jdir, f), 'utf8')); } catch { continue; }
        const n = (Array.isArray(arr) ? arr : []).filter((x) => x && x.verdict && !saved.has(`${x.item}|${x.concept}`)).length;
        if (n) { unsaved += n; files.push(f); }
      }
      if (unsaved) {
        throw new Error(`${slash(jdir)} has ${unsaved} filled verdict(s) not in ${slash(JUDGMENTS_DIR)} (${files.join(', ')}). `
          + 'Move those files into the judgments folder first, or pass --discard-answers.');
      }
    }
    fs.rmSync(jdir, { recursive: true, force: true });
    fs.mkdirSync(jdir, { recursive: true });
    const rnd = mulberry32(seed);
    const byItem = new Map();
    for (const p of todo) { if (!byItem.has(p.item.id)) byItem.set(p.item.id, []); byItem.get(p.item.id).push(p); }
    const order = shuffle([...byItem.keys()].sort(), rnd);
    fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
    const entries = [];
    for (const iid of order) {
      const ps = byItem.get(iid);
      const it = ps[0].item;
      const e = { item: id8(iid), media: it.kind };
      if (it.kind === 'picture') {
        const prev = path.join(PREVIEWS_DIR, `${iid}.jpg`);
        if (!a['no-previews'] && !fs.existsSync(prev)) { try { await makePreview(it, prev); } catch { /* fall back to the original */ } }
        e.image = slash(fs.existsSync(prev) ? prev : it.path);
      } else if (it.frames && it.frames.length) {
        const dir = path.join(framesDir, iid);
        e.frames = pickFrames(it.slots, dir).filter((f) => fs.existsSync(f));
        const contact = path.join(dir, 'contact.jpg');
        if (fs.existsSync(contact)) e.contact = slash(contact);
      } else {
        e.media = 'video (cover only)';
        e.image = slash(it.thumb || it.path);
      }
      e.concepts = shuffle(ps.map((p) => ({ concept: p.concept, label: prepared.concepts.get(p.concept).label.en })), rnd);
      entries.push(e);
    }
    const nSheets = Math.ceil(entries.length / sheetSize);
    for (let s = 0; s < nSheets; s++) {
      const chunk = entries.slice(s * sheetSize, (s + 1) * sheetSize);
      const nn = String(s + 1).padStart(2, '0');
      fs.writeFileSync(path.join(jdir, `sheet-${nn}.json`), JSON.stringify({
        how: 'For each item, look at the image (or the frames / contact sheet) and judge every listed tag: "yes" = a user would happily accept this tag; "partly" = related or only partly true; "no" = wrong. Judge the item as the user sees it, not what a model might see. Fill the answers file and save it under E:/DP 2/qooti-tag-eval/judgments/.',
        sheet: s + 1, of: nSheets, round, items: chunk,
      }, null, 2) + '\n');
      fs.writeFileSync(path.join(jdir, `answers-${nn}.json`), oneLinePerEntry(
        chunk.flatMap((e) => e.concepts.map((c) => ({ item: e.item, concept: c.concept, verdict: '', judge: '', round })))));
      judging.sheets.push(`judge/sheet-${nn}.json`);
    }
    fs.writeFileSync(path.join(jdir, 'README.md'), judgeReadme(judging, round));
    if (a['domain-sheet']) {
      const sample = shuffle(scoredItems.map((i) => i.id).sort(), mulberry32(seed + 7)).slice(0, Number(a['domain-sample'] || 150));
      const ds = [];
      for (const iid of sample) {
        const it = items.find((x) => x.id === iid);
        const e = { item: id8(iid), media: it.kind };
        if (it.kind === 'picture') {
          const prev = path.join(PREVIEWS_DIR, `${iid}.jpg`);
          if (!a['no-previews'] && !fs.existsSync(prev)) { try { await makePreview(it, prev); } catch { /* original */ } }
          e.image = slash(fs.existsSync(prev) ? prev : it.path);
        } else {
          const contact = path.join(framesDir, iid, 'contact.jpg');
          e.image = slash(fs.existsSync(contact) ? contact : (it.thumb || it.path));
        }
        ds.push(e);
      }
      fs.writeFileSync(path.join(jdir, 'domain-sheet.json'), JSON.stringify({
        how: 'For each item list the roles whose work it is CLEARLY NOT reference for, in "out": "motion" (video editor / motion designer), "thumbnail" (YouTube thumbnail designer). Leave "out" empty when unsure. Save as E:/DP 2/qooti-tag-eval/judgments/domains-<judge>.json and pass it with --domains.',
        roles: ['motion', 'thumbnail'], items: ds,
      }, null, 2) + '\n');
      fs.writeFileSync(path.join(jdir, 'domain-answers.json'), oneLinePerEntry(ds.map((e) => ({ item: e.item, out: [], judge: '' }))));
    }
  }

  // Precision with judgments
  let precision = null;
  if (J) {
    const popByKind = {
      picture: scoredItems.filter((i) => barKind(results.get(i.id).rule) === 'picture').length,
      video: scoredItems.filter((i) => barKind(results.get(i.id).rule) === 'video').length,
    };
    const tally = (ps) => {
      let y = 0, p = 0, n = 0;
      for (const x of ps) {
        const j = judged.get(`${id8(x.item.id)}|${x.concept}`);
        if (!j) continue;
        if (j.verdict === 'yes') y++; else if (j.verdict === 'partly') p++; else n++;
      }
      const jd = y + p + n;
      return { suggestions: ps.length, judged: jd, yes: y, partly: p, no: n, strict: jd ? y / jd : null, lenient: jd ? (y + p) / jd : null };
    };
    precision = { stats: J.stats, per_lens: {}, per_entry: [], roles: {} };
    for (const l of lenses) {
      const own = pairs.filter((p) => p.lens === l.id);
      const out = {};
      for (const kind of MEDIA_KINDS) {
        const rows = [];
        const bars = [...new Set([...BARS, l.bar[kind]])].sort((x, y) => x - y);
        for (const b of bars) {
          if (b < judgeBar - 1e-12) continue;
          const sel = own.filter((p) => p.kind === kind && p.score >= b);
          const items = new Set(sel.map((p) => p.item.id)).size;
          rows.push({ bar: b, current: Math.abs(b - l.bar[kind]) < 1e-12, ...tally(sel), coverage: popByKind[kind] ? items / popByKind[kind] : null, items_with_suggestion: items });
        }
        out[kind] = { population: popByKind[kind], rows };
      }
      precision.per_lens[l.id] = out;
      for (const e of prepared.lenses.get(l.id).entries) {
        if (!e.suggest) continue;
        const cs = own.filter((p) => p.concept === e.id);
        precision.per_entry.push({
          lens: l.id, concept: e.id, label: e.label?.en ?? e.id, media: e.media,
          bars: BARS.filter((b) => b >= judgeBar - 1e-12).map((b) => ({ bar: b, ...tally(cs.filter((p) => p.score >= b)) })),
          current: tally(cs.filter((p) => p.score >= l.bar[p.kind])),
        });
      }
      // What a user of this role is shown, at the lens's own bars (§0c display rule).
      precision.roles[l.id] = tally(shownToRole(prepared, l.id, scoredItems, results));
    }
  }

  const entryName = (r) => `${r.lens}/${r.id}`;
  const report = {
    generated_at: new Date().toISOString(),
    signature, frames_source: framesSource,
    lenses: lenses.map((l) => {
      const m = prepared.lenses.get(l.id);
      return { id: l.id, role: l.role, version: l.version, sha256: l.sha256.slice(0, 12), bar: l.bar, borrows: l.borrows || [], concepts: l.concepts.length, scored: m.scoredIds.length, add_by_hand: m.handIds.length };
    }),
    counts, per_lens: perLens, role_view: roleView,
    entries: entryRows,
    add_by_hand: hand,
    never_firing: entryRows.filter((c) => c.fires_total === 0).map(entryName),
    never_firing_low_bar: entryRows.filter((c) => c.low_bar_fires === 0).map(entryName),
    over_25: entryRows.filter((c) => c.flag).map(entryName),
    near_duplicates: dups, out_of_domain: ood, judging, precision,
    timing_ms: { load: Math.round(loadMs), score_both_bars: Math.round(scoreMs), duplicates: Math.round(dupMs), total: Math.round(performance.now() - T0) },
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(report));
  console.log(`items ${counts.items} (pictures ${counts.pictures_with_vectors}/${counts.pictures} with vectors, videos ${counts.videos_with_frames} with frames, ${counts.videos_cover_fallback} on the cover, ${counts.not_scored} not scored)`);
  console.log(`  same-name rule: ${sameName.suggestions} suggestion(s) on ${sameName.items} item(s) not made (${sameName.items_with_people_tags} item(s) have people's tags; ${sameName.low_bar_suggestions} at the judging bar)`);
  for (const l of lenses) {
    const p = perLens[l.id];
    console.log(`  ${l.id.padEnd(10)} pictures ${pct(p.picture.rate)} · videos ${pct(p.video.rate)} have a suggestion · role view ${pct(roleView[l.id].rate)}`);
  }
  if (report.over_25.length) console.log(`  fire rate > 25 %: ${report.over_25.join(', ')}`);
  console.log(`  never fire: ${report.never_firing.length} · near-duplicate pairs: ${dups.length} · to judge: ${judging.to_judge} pair(s) in ${judging.sheets.length} sheet(s)`);
  if (precision) {
    for (const l of lenses) {
      const r = precision.roles[l.id];
      console.log(`  ${l.id.padEnd(10)} shown to its role: strict ${pct(r.strict)} · lenient ${pct(r.lenient)} (judged ${r.judged}/${r.suggestions})`);
    }
  }
  console.log(`report: ${slash(path.join(outDir, 'report.md'))} · ${Math.round(performance.now() - T0)} ms`);
  return 0;
}

function judgeReadme(j, round) {
  return `# Judge sheets (private)

Blind sheets: no scores and no lens names. ${j.to_judge} item/tag pairs suggested at the low bar ${j.bar}
(lenses: ${j.lenses.join(', ')}); pairs already in the judgments folder are left out.

1. Open \`sheet-NN.json\`. For each item look at \`image\` (pictures) or \`contact\` / \`frames\` (videos).
2. For every tag listed, write a verdict in \`answers-NN.json\`:
   - \`yes\`: a user would happily accept this tag for the item;
   - \`partly\`: related, or true for only part of it;
   - \`no\`: wrong.
   Fill \`judge\` with your agent name; \`round\` is ${round}.
3. Save the filled file as \`E:/DP 2/qooti-tag-eval/judgments/<judge>-<lens>-r${round}-NN.json\`
   (never inside the git worktree), then re-run measure.mjs with
   \`--judgments "E:/DP 2/qooti-tag-eval/judgments"\`.

Judge the item as a person sees it. Unfilled entries (verdict "") are ignored.
`;
}

function renderMarkdown(r) {
  const L = [];
  L.push(`# Lens measurement`, '');
  L.push(`${r.generated_at} · signature \`${r.signature}\` · frames: ${r.frames_source.startsWith('embed') ? 'embed-frames (Node approximation)' : r.frames_source}`, '');
  L.push('| lens | role | version | bar picture | bar video | entries: scored + add-by-hand | sha256 |', '|---|---|---|---|---|---|---|');
  for (const l of r.lenses) L.push(`| ${l.id} | ${l.role} | ${l.version} | ${l.bar.picture} | ${l.bar.video} | ${l.scored} + ${l.add_by_hand} | ${l.sha256} |`);
  const c = r.counts;
  L.push('', `Items: ${c.items} · pictures ${c.pictures} (${c.pictures_with_vectors} with vectors) · videos ${c.videos} (${c.videos_with_frames} with frames, ${c.videos_one_frame} with one frame, ${c.videos_frames_failed} failed → ${c.videos_cover_fallback} scored on the cover, ${c.videos_no_frames_row} without frames yet) · scored ${c.scored}, not scored ${c.not_scored}.`, '');
  L.push(`Left out, as the app does: ${c.long_videos_left_out ?? 0} videos over ${c.max_video_secs} s (+0.5 s), ${c.no_length_videos_left_out ?? 0} videos whose length couldn't be measured.`, '');
  if (c.same_name) {
    const s = c.same_name;
    L.push(`Same-name rule: ${s.suggestions} suggestion(s) on ${s.items} item(s) not made, because the item has a people's tag with the concept's name (${s.items_with_people_tags} item(s) have people's tags; ${s.low_bar_suggestions} at the judging bar)${s.dropped.length ? `: ${s.dropped.map((d) => `${d.concept} on ${d.item}`).join(', ')}` : ''}.`, '');
  }
  L.push('## Coverage per lens (at its own bars)', '', 'Role view: only that lens on, §0c display rule (own entries for the item\'s media, plus borrowed tags whose design entry covers it).', '');
  L.push('| lens | pictures with a suggestion | videos with a suggestion | role view: items with a visible suggestion | avg visible | first question: own / borrowed |', '|---|---|---|---|---|---|');
  for (const l of r.lenses) {
    const p = r.per_lens[l.id], v = r.role_view[l.id];
    L.push(`| ${l.id} | ${p.picture.items_with_suggestion}/${p.picture.items} (${pct(p.picture.rate)}) | ${p.video.items_with_suggestion}/${p.video.items} (${pct(p.video.rate)}) | ${v.items_with_visible}/${v.items} (${pct(v.rate)}) | ${fx(v.avg_visible)} | ${v.first_is_own} / ${v.first_is_borrowed} |`);
  }
  L.push('', `## Entries (one row per lens entry; fire rate over the scored items whose media the entry covers; ⚠ above ${FIRE_FLAG * 100} %; "shared" = the tag has entries in other lenses too)`, '', '| lens | concept | label | media | shared | pictures | videos | rate | mean p | at low bar |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const s of r.entries) L.push(`| ${s.lens} | ${s.id} | ${s.label} | ${s.media}${s.aspect ? ` ${s.aspect[0]}–${s.aspect[1]}` : ''} | ${s.shared ? 'yes' : ''} | ${s.fires.picture} | ${s.fires.video} | ${pct(s.rate)}${s.flag ? ' ⚠' : ''} | ${fx(s.mean_score)} | ${s.low_bar_fires} |`);
  L.push('', `Add-by-hand entries, never suggested (${r.add_by_hand.length}): ${r.add_by_hand.map((h) => `${h.lens}/${h.id}`).join(', ') || 'none'}`);
  L.push('', `Never fire at their lens's bar (${r.never_firing.length}): ${r.never_firing.join(', ') || 'none'}`);
  L.push('', `Never fire even at the low bar (${r.never_firing_low_bar.length}): ${r.never_firing_low_bar.join(', ') || 'none'}`);
  L.push('', `## Near-duplicate pairs inside each media pool (Pearson r ≥ ${DUP_R} of the probabilities the two members get in that pool)`, '');
  if (!r.near_duplicates.length) L.push('none');
  else {
    L.push('| media | pool | a | b | r | items | text cos |', '|---|---|---|---|---|---|---|');
    for (const d of r.near_duplicates) L.push(`| ${d.media} | ${d.pool} | ${d.a_lens}.${d.a}${d.anchor === d.a ? ' (base)' : ''} | ${d.b_lens}.${d.b}${d.anchor === d.b ? ' (base)' : ''} | ${d.r} | ${d.items} | ${d.text_cos} |`);
  }
  L.push('', '## Out of domain', '', 'Proxy (no labels): share of items where the specialist fires, by media and aspect.', '');
  for (const [lid, g] of Object.entries(r.out_of_domain.proxy)) {
    L.push(`- **${lid}**: ${Object.entries(g).map(([k, v]) => `${k} ${v.fired}/${v.items} (${pct(v.rate)})`).join(' · ')}`);
  }
  if (r.out_of_domain.labelled) {
    L.push('', 'Labelled out-of-domain items (target ≤ 5 %):', '');
    for (const [lid, v] of Object.entries(r.out_of_domain.labelled)) L.push(`- **${lid}**: ${v.fired}/${v.out_of_domain_items} (${pct(v.rate)})`);
  }
  const j = r.judging;
  L.push('', '## Judging', '', `Low bar ${j.bar} · lenses ${j.lenses.join(', ')} · ${j.pairs} pairs, ${j.already_judged} already judged, ${j.to_judge} to judge in ${j.sheets.length} sheet(s).`);
  if (r.precision) {
    const s = r.precision.stats;
    L.push('', `## Precision (judgments: ${s.unique} pairs from ${s.files} file(s); ${s.conflicts} same-round disagreements resolved to the lower verdict)`, '');
    for (const [lid, kinds] of Object.entries(r.precision.per_lens)) {
      for (const [kind, v] of Object.entries(kinds)) {
        L.push(`**${lid} · ${kind} rule** (population ${v.population})`, '', '| bar | suggestions | judged | strict | lenient | coverage |', '|---|---|---|---|---|---|');
        for (const row of v.rows) L.push(`| ${row.bar}${row.current ? ' (current)' : ''} | ${row.suggestions} | ${row.judged} | ${pct(row.strict)} | ${pct(row.lenient)} | ${pct(row.coverage)} |`);
        L.push('');
      }
    }
    L.push('Shown to each role (its lens alone on, §0c display rule incl. borrows, at current bars):', '');
    for (const [lid, t] of Object.entries(r.precision.roles)) L.push(`- **${lid}**: strict ${pct(t.strict)} · lenient ${pct(t.lenient)} · judged ${t.judged} of ${t.suggestions}`);
    L.push('', '| lens | concept | media | current: judged/suggested | strict | lenient |', '|---|---|---|---|---|---|');
    for (const v of r.precision.per_entry) L.push(`| ${v.lens} | ${v.concept} | ${v.media} | ${v.current.judged}/${v.current.suggestions} | ${pct(v.current.strict)} | ${pct(v.current.lenient)} |`);
  }
  L.push('', `_Timing: ${JSON.stringify(r.timing_ms)}_`, '');
  return L.join('\n');
}

runMain(import.meta.url, main);
