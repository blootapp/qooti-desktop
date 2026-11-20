#!/usr/bin/env node
// Video frame vectors for tuning lenses before the Rust indexer exists (spec §9).
//
// Mirrors src-tauri/src/frames.rs: one frame per second of the clip, at least 8 and at most 32
// (`frameCount`; owner decision 2026-11-20, R45; 8 for every video before), at the middle of n
// equal slices of the clip without its first and last 4 %, each grabbed by the bundled ffmpeg
// with exactly the indexer's arguments (224 px short side, mjpeg q2, -threads 1, low priority); a
// missing duration is probed with `ffmpeg -i`, and when the header has none either, measured by
// reading every packet (`measureDuration`); frames that fail are skipped (fewer than n; n = 0
// means the item falls back to its cover, or, with no length at all, is never tagged). Entries
// made with the 8-frame schedule (no `schedule` field) of videos over 8 s are done again, as the
// indexer reads those rows again (clip.rs old_schedule_with); a new entry is never redone for
// frames that failed. Each frame is embedded with the app's vision q8 model (same file, sha256-checked)
// after the clip.rs preprocessing — for these frames that is a centre crop, since the image
// crate copies instead of resampling an image that is already 224 px on its short side.
//
// Decoder (--decoder): `rust` (default) decodes + preprocesses each frame with the app's own
// code (native/clip-preprocess, built once with cargo --offline); Node's onnxruntime then gives
// the Rust vectors (pictures: median cosine 1.0000 against clip_embeddings). `sharp` decodes with
// libjpeg-turbo instead: the q8 model turns its ±1-level pixel differences into cosines of ~0.985
// and flips roughly 1 suggestion set in 7 near the bars — a fallback only.
//
// Output (private, never copy it out of the eval folder):
//   <out>/frame-vectors.json        {items: {<inspiration id>: {n, slots, times, f16, schedule, …}}}
//   <out>/<inspiration id>/f<slot>.jpg   the frame JPEGs (as ffmpeg produced them)
//   <out>/<inspiration id>/contact.jpg   all frames in a grid (4 columns up to 8 frames, else 8), for judging
//
//   node scripts/lenses/embed-frames.mjs [--db <copy>] [--out <dir>] [--force] [--only <id8,…>]
//        [--limit N] [--concurrency 3] [--cache <hf cache>] [--ffmpeg <exe>] [--decoder rust|sharp]
//        [--max-video-secs 60]
// A change of decoder or model re-embeds everything; otherwise only new videos are done.
// Like the indexer (clip.rs, spec §0.11), videos longer than --max-video-secs (+0.5 s) get no
// frames: a missing length is probed first. Entries made before for long videos are kept in the
// store (measure.mjs leaves those videos out anyway). Infinity reads every video.
// A length measured here (the DB copy had none) is kept in the entry's `duration`, as the app
// keeps it in duration_secs; a long one is stored as {long: true, duration, n: 0} so measure.mjs
// can leave that video out. An entry with n = 0 and no duration is a video whose length couldn't
// be measured: the app never tags it (not even from its cover).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, runMain } from './lib/args.mjs';
import { DB_COPY, FRAMES_DIR, HF_CACHE, FFMPEG, slash } from './lib/paths.mjs';
import { openReadOnly } from './lib/db.mjs';
import { encodeF16, toBase64 } from './lib/f16.mjs';
import { loadVisionEncoder, VISION_FILE, sha256File } from './lib/models.mjs';
import { decodeRGB, preprocessRust } from './lib/image.mjs';
import { ensureHelper, rustTensorsAsync } from './lib/native.mjs';
import { MAX_TAG_VIDEO_SECS, tooLongForTags } from './lens-score.mjs';

/** frames.rs MIN_FRAMES / MAX_FRAMES: one frame per second of the clip, at least 8, at most 32. */
export const MIN_FRAMES = 8;
export const MAX_FRAMES = 32;
/** The schedule of entries made here (`schedule` on each entry); entries without one were made
 *  with 8 frames whatever the length. */
export const SCHEDULE = 'fps1';
/** clip.rs FRAMES_TAG / FRAMES_TAG_8: `clip_frames.model` of rows read one per second, and of rows
 *  read with 8 frames before 2026-11-20. measure.mjs reads both. */
export const FRAMES_TAG = 'clip-b32-q8@fps1';
export const FRAMES_TAG_8 = 'clip-b32-q8';
export const PIPELINES = {
  rust: 'frames.rs-args+clip-preprocess(image-0.25.10)+onnxruntime-node',
  sharp: 'frames.rs-args+sharp-decode+clip.rs-preprocess-port+onnxruntime-node',
};
const FRAME_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 15_000;
/** Reading every packet of a long file takes a while; a run cut off by this counts as "no length". */
const MEASURE_TIMEOUT_MS = 120_000;

/** frames.rs frame_count: one frame per second, rounded up, 8 to 32 (2 s → 8, 20.4 s → 21,
 *  45 s → 32); a length that isn't a number above 0 gives 8. */
export function frameCount(dur) {
  if (!(Number.isFinite(dur) && dur > 0)) return MIN_FRAMES;
  return Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, Math.ceil(dur)));
}

/** frames.rs frame_times: the middle of n equal slices without the first and last 4 %. */
export const frameTimes = (dur, n = frameCount(dur)) => Array.from({ length: n }, (_, i) => dur * (0.04 + 0.92 * (i + 0.5) / n));

/**
 * Does this store entry still need reading (beyond --force)? None yet; a video once measured as
 * too long that the limit now lets in; or frames read with the 8-frame schedule (no `schedule`) of
 * a video over 8 s, where today's takes more — like clip.rs old_schedule_with, only entries with
 * frames (n > 0); a failed one (n = 0) isn't tried again here. An entry made with today's
 * schedule is done, however many of its frames failed.
 */
export function needsReading(entry, maxVideoSecs) {
  if (!entry) return true;
  if (entry.long) return !tooLongForTags(entry.duration, maxVideoSecs);
  return entry.schedule !== SCHEDULE && entry.n > 0 && frameCount(entry.duration) > MIN_FRAMES;
}

/**
 * Rust `format!("{t:.3}")`: correctly rounded, exact ties to even. JS toFixed rounds exact ties
 * up; a double sits exactly on a 3-decimal tie only when it is an odd multiple of 1/16.
 */
export function fmtTime(t) {
  if (Number.isInteger(t * 16) && !Number.isInteger(t * 8)) {
    const k = Math.floor(t * 1000);
    return ((k % 2 === 0 ? k : k + 1) / 1000).toFixed(3);
  }
  return t.toFixed(3);
}

/** frames.rs grab_frame arguments, verbatim. */
export function grabArgs(video, t) {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-ss', fmtTime(t), '-i', video,
    '-frames:v', '1', '-vf', "scale='if(gte(iw,ih),-2,224)':'if(gte(iw,ih),224,-2)'",
    '-threads', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
}

function run(ffmpeg, args, { timeoutMs, capture }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { stdio: ['ignore', capture === 'stdout' ? 'pipe' : 'ignore', capture === 'stderr' ? 'pipe' : 'ignore'], windowsHide: true });
    } catch { resolve(null); return; }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const chunks = [];
    const stream = capture === 'stdout' ? child.stdout : child.stderr;
    stream.on('data', (c) => chunks.push(c));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code, bytes: Buffer.concat(chunks) });
    });
  });
}

export async function grabFrame(ffmpeg, video, t) {
  const r = await run(ffmpeg, grabArgs(video, t), { timeoutMs: FRAME_TIMEOUT_MS, capture: 'stdout' });
  return r && r.code === 0 && r.bytes.length > 100 ? r.bytes : null;
}

export function parseDuration(text) {
  const i = text.indexOf('Duration:');
  if (i < 0) return null;
  const rest = text.slice(i + 'Duration:'.length);
  const end = rest.indexOf(',');
  if (end < 0) return null;
  const parts = rest.slice(0, end).trim().split(':').map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return null;
  const s = parts[0] * 3600 + parts[1] * 60 + parts[2];
  return s > 0 ? s : null;
}

export async function probeDuration(ffmpeg, video) {
  const r = await run(ffmpeg, ['-nostdin', '-hide_banner', '-threads', '1', '-i', video], { timeoutMs: PROBE_TIMEOUT_MS, capture: 'stderr' });
  return r ? parseDuration(r.bytes.toString('utf8')) : null;
}

/** The last `out_time_us` of a finished `-progress` report, in seconds; null if it didn't finish. */
export function parseProgressDuration(text) {
  if (!/^progress=end\s*$/m.test(text)) return null;
  let last = null;
  for (const m of text.matchAll(/^out_time_us=(\d+)\s*$/gm)) last = Number(m[1]);
  const s = last == null ? null : last / 1e6;
  return Number.isFinite(s) && s > 0 ? s : null;
}

/**
 * The length of a video whose header has none (a WebM recorded in a browser says "Duration: N/A"):
 * ffmpeg reads every packet of the first video stream without decoding it and reports where it
 * ended. A failed or cut-off run gives null. This mirrors the indexer's measurement (the video
 * rule; keep it in step with src-tauri/src/frames.rs).
 */
export async function measureDuration(ffmpeg, video) {
  const r = await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', video,
    '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'], { timeoutMs: MEASURE_TIMEOUT_MS, capture: 'stdout' });
  return r && r.code === 0 ? parseProgressDuration(r.bytes.toString('utf8')) : null;
}

/** The header's length, else the measured one, else null (the app then never tags the video). */
export async function findDuration(ffmpeg, video) {
  return (await probeDuration(ffmpeg, video)) ?? (await measureDuration(ffmpeg, video));
}

/** frames.rs extract_frames → [{slot, t, jpg}] (failed frames skipped). */
export async function extractFrames(ffmpeg, video, duration) {
  let dur = Number.isFinite(duration) && duration > 0 ? duration : await findDuration(ffmpeg, video);
  if (!dur) return { dur: null, frames: [] };
  const frames = [];
  const times = frameTimes(dur);
  for (let slot = 0; slot < times.length; slot++) {
    const jpg = await grabFrame(ffmpeg, video, times[slot]);
    if (jpg) frames.push({ slot, t: times[slot], jpg });
  }
  return { dur, frames };
}

async function contactSheet(frames, file) {
  const sharp = (await import('sharp')).default;
  const metas = await Promise.all(frames.map((f) => sharp(f.jpg).metadata()));
  const w = metas[0].width, h = metas[0].height;
  const cols = frames.length <= 8 ? 4 : 8, rows = Math.ceil(frames.length / cols);
  const tiles = await Promise.all(frames.map((f) => sharp(f.jpg).resize(w, h, { fit: 'cover' }).toBuffer()));
  await sharp({ create: { width: w * cols, height: h * rows, channels: 3, background: { r: 16, g: 16, b: 16 } } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * w, top: Math.floor(i / cols) * h })))
    .jpeg({ quality: 85 }).toFile(file);
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function loadFrameVectors(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ['force', 'help'], options: ['db', 'out', 'limit', 'concurrency', 'cache', 'ffmpeg', 'decoder', 'max-video-secs'], multi: ['only'] });
  if (a.help) { console.log(`usage: node scripts/lenses/embed-frames.mjs [--db <copy>] [--out <dir>] [--force] [--only <id8,…>] [--limit N] [--concurrency 3] [--decoder rust|sharp] [--max-video-secs ${MAX_TAG_VIDEO_SECS}]`); return 0; }
  const maxVideoSecs = a['max-video-secs'] != null ? Number(a['max-video-secs']) : MAX_TAG_VIDEO_SECS;
  if (!(maxVideoSecs > 0)) throw new Error('--max-video-secs must be a number of seconds above 0 (Infinity reads every video)');
  const outDir = path.resolve(a.out || FRAMES_DIR);
  const ffmpeg = a.ffmpeg || FFMPEG;
  if (!fs.existsSync(ffmpeg)) throw new Error(`ffmpeg not found: ${ffmpeg}`);
  const concurrency = Math.max(1, Number(a.concurrency || 3));
  const vectorsFile = path.join(outDir, 'frame-vectors.json');
  let decoder = a.decoder || 'rust';
  if (!PIPELINES[decoder]) throw new Error('--decoder must be rust or sharp');
  const helper = decoder === 'rust' ? ensureHelper({ log: console.log }) : null;
  if (decoder === 'rust' && !helper) {
    if (a.decoder) throw new Error('the clip-preprocess helper could not be built; use --decoder sharp (approximate)');
    console.log('WARNING: falling back to --decoder sharp: frame vectors only approximate the app (cosine ~0.985)');
    decoder = 'sharp';
  }
  const PIPELINE = PIPELINES[decoder];
  console.log(`decoder: ${decoder}${helper ? ` (${slash(helper)})` : ''}`);

  const vision = await loadVisionEncoder(a.cache || HF_CACHE, { log: console.log });
  const visionSha = vision.files[VISION_FILE].sha256;
  const ffmpegSha = sha256File(ffmpeg);
  const db = await openReadOnly(a.db || DB_COPY);
  let rows = db.prepare(`SELECT id, stored_path AS path, duration_secs AS dur, aspect_ratio AS aspect
    FROM inspirations WHERE type = 'video' ORDER BY created_at DESC`).all();
  db.close();
  if (a.only.length) rows = rows.filter((r) => a.only.some((p) => r.id.startsWith(p)));
  // §0.11: a stored length over the limit means no frames (an unknown one is probed below)
  const longKnown = rows.filter((r) => tooLongForTags(r.dur, maxVideoSecs)).length;
  rows = rows.filter((r) => !tooLongForTags(r.dur, maxVideoSecs));
  if (longKnown) console.log(`left out ${longKnown} videos longer than ${maxVideoSecs} s (+0.5 s), as the app does`);

  const prev = loadFrameVectors(vectorsFile);
  const store = prev && prev.format === 1 && prev.vision_sha256 === visionSha && prev.pipeline === PIPELINE
    ? prev : { format: 1, model: 'clip-b32-q8', vision_sha256: visionSha, pipeline: PIPELINE, items: {} };
  store.decoder = decoder;
  store.ffmpeg_sha256 = ffmpegSha;
  // A video once measured as too long is done again when the limit now lets it in, and one read
  // with 8 frames when today's schedule takes more (`needsReading`).
  const todo = rows.filter((r) => a.force || needsReading(store.items[r.id], maxVideoSecs));
  const limited = a.limit ? todo.slice(0, Number(a.limit)) : todo;
  const again = todo.filter((r) => store.items[r.id] && !store.items[r.id].long).length;
  console.log(`videos: ${rows.length} · already done: ${rows.length - todo.length} · to do now: ${limited.length}${again && !a.force ? ` (${again} read with 8 frames before)` : ''} · ffmpeg workers: ${concurrency}`);

  // Embedding runs one frame at a time (clean timings, no contention for the session).
  let chain = Promise.resolve();
  const embedSerial = (pixels) => {
    const p = chain.then(() => vision.embed(pixels));
    chain = p.catch(() => {});
    return p;
  };

  const t0 = performance.now();
  let done = 0, frameTotal = 0, failedItems = 0, partial = 0, extractMs = 0, embedMs = 0, longProbed = 0;
  let next = 0;
  const worker = async () => {
    while (next < limited.length) {
      const r = limited[next++];
      const dir = path.join(outDir, r.id);
      const te = performance.now();
      const exists = fs.existsSync(r.path);
      // Like clip.rs index_video: measure a missing length first; a video over the limit gets no frames
      let known = Number.isFinite(r.dur) && r.dur > 0 ? r.dur : null;
      if (known == null && exists) known = await findDuration(ffmpeg, r.path);
      if (tooLongForTags(known, maxVideoSecs)) {
        // The app stores the measured length and never reads frames; keep the length for measure.mjs.
        store.items[r.id] = { n: 0, long: true, slots: [], times: [], duration: known, f16: '' };
        longProbed++;
        continue;
      }
      const { dur, frames } = exists ? await extractFrames(ffmpeg, r.path, known) : { dur: null, frames: [] };
      const tExtract = performance.now() - te;
      const tm = performance.now();
      fs.rmSync(dir, { recursive: true, force: true });
      if (frames.length) fs.mkdirSync(dir, { recursive: true });
      const files = frames.map((f) => path.join(dir, `f${f.slot}.jpg`));
      frames.forEach((f, i) => fs.writeFileSync(files[i], f.jpg));
      let tensors;
      if (decoder === 'rust') {
        tensors = await rustTensorsAsync(helper, files);
      } else {
        tensors = [];
        for (const f of frames) {
          try { tensors.push(preprocessRust(await decodeRGB(f.jpg))); } catch { tensors.push(null); }
        }
      }
      const vecs = [];
      const kept = [];
      for (let i = 0; i < frames.length; i++) {
        if (!tensors[i]) { fs.rmSync(files[i], { force: true }); continue; }   // undecodable: skipped like a failed grab
        vecs.push(await embedSerial(tensors[i]));
        kept.push(frames[i]);
      }
      const tEmbed = performance.now() - tm;
      if (kept.length) {
        try { await contactSheet(kept, path.join(dir, 'contact.jpg')); } catch { /* judging aid only */ }
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const flat = new Float64Array(vecs.length * 512);
      vecs.forEach((v, i) => flat.set(v, i * 512));
      store.items[r.id] = {
        n: vecs.length,
        slots: kept.map((f) => f.slot),
        times: kept.map((f) => +f.t.toFixed(3)),
        duration: dur,
        f16: vecs.length ? toBase64(encodeF16(flat)) : '',
        schedule: SCHEDULE,
        ms: { extract: Math.round(tExtract), embed: Math.round(tEmbed) },
      };
      done++; frameTotal += vecs.length; extractMs += tExtract; embedMs += tEmbed;
      if (!vecs.length) failedItems++; else if (vecs.length < frameCount(dur)) partial++;
      if (done % 10 === 0 || done === limited.length) {
        store.updated_at = new Date().toISOString();
        writeAtomic(vectorsFile, JSON.stringify(store) + '\n');
        console.log(`  ${done}/${limited.length} videos · ${frameTotal} frames · ${Math.round((performance.now() - t0) / 1000)} s`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, limited.length || 1) }, worker));
  await chain;
  store.updated_at = new Date().toISOString();
  writeAtomic(vectorsFile, JSON.stringify(store) + '\n');
  const wall = performance.now() - t0;
  const all = Object.values(store.items);
  console.log(`done: ${done} videos in ${(wall / 1000).toFixed(1)} s wall · ${frameTotal} frames · failed (n=0): ${failedItems} · partial (some frames failed): ${partial}`);
  if (longProbed) console.log(`  ${longProbed} videos measured over ${maxVideoSecs} s (+0.5 s): no frames, as the app does`);
  if (done) console.log(`  per video: extract ${Math.round(extractMs / done)} ms (one ffmpeg run per frame, ${concurrency} videos in parallel) · embed ${Math.round(embedMs / done)} ms`);
  console.log(`store: ${all.length} videos (${all.filter((x) => x.n > 0).length} with frames, ${all.filter((x) => x.n === 0 && !x.long).length} failed, ${all.filter((x) => x.long).length} measured too long) → ${slash(vectorsFile)}`);
  return 0;
}

runMain(import.meta.url, main);
