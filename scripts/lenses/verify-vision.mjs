#!/usr/bin/env node
// How close is the Node CLIP path to the app's Rust vectors?
//
// Checks that the vision model file Node uses is the app's (sha256 == clip.rs MODEL_SHA256),
// then embeds a deterministic sample of pictures from the DB copy and compares each with its
// stored clip_embeddings vector (cosine). Four Node preprocessing paths are compared:
//   app-decoder – native/clip-preprocess: the app's own `image` decode + clip.rs preprocess
//                 (what embed-frames uses by default); onnxruntime-node does the rest
//   rust-port   – clip.rs `preprocess` ported to JS, on sharp's (libjpeg-turbo) decode
//   vips-cubic  – libvips Catmull-Rom resize to short side 224, centre crop
//   vips-lanczos3 – libvips Lanczos-3 resize, centre crop
// The q8 model turns ±1-level pixel differences into ~0.985 cosines, so only the app-decoder path
// reproduces the Rust vectors (measured: median 1.0000).
// Output: ids as their first 8 characters only, plus numbers (spec §11).
//
//   node scripts/lenses/verify-vision.mjs [--n 20] [--db <copy>] [--cache <dir>] [--out <file.json>]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, runMain } from './lib/args.mjs';
import { DB_COPY, HF_CACHE, ROOT, slash } from './lib/paths.mjs';
import { openReadOnly } from './lib/db.mjs';
import { decodeF32, dot } from './lib/f16.mjs';
import { loadVisionEncoder, VISION_FILE, sha256File, modelFile } from './lib/models.mjs';
import { decodeRGB, preprocessRust, preprocessSharp } from './lib/image.mjs';
import { ensureHelper, rustTensors } from './lib/native.mjs';

function rustModelSha() {
  const src = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'clip.rs'), 'utf8');
  const m = src.match(/MODEL_SHA256:\s*&str\s*=\s*"([0-9a-f]{64})"/);
  return m ? m[1] : null;
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, mean: +mean.toFixed(4), median: +s[Math.floor(s.length / 2)].toFixed(4), min: +s[0].toFixed(4), max: +s[s.length - 1].toFixed(4) };
};

async function main(argv) {
  const a = parseArgs(argv, { options: ['n', 'db', 'cache', 'out', 'threads'], flags: ['help'] });
  if (a.help) { console.log('usage: node scripts/lenses/verify-vision.mjs [--n 20] [--db <copy>] [--cache <dir>] [--out <file.json>]'); return 0; }
  const n = Number(a.n || 20);
  const cache = a.cache || HF_CACHE;

  const vision = await loadVisionEncoder(cache, { threads: Number(a.threads || 2), log: console.log });
  const nodeSha = vision.files[VISION_FILE].sha256;
  const appSha = rustModelSha();
  console.log(`vision model used by Node: ${slash(modelFile(VISION_FILE, cache))}`);
  console.log(`  sha256 ${nodeSha}`);
  console.log(`  clip.rs MODEL_SHA256 ${appSha} → ${nodeSha === appSha ? 'SAME FILE' : 'DIFFERENT'}`);

  const db = await openReadOnly(a.db || DB_COPY);
  const rows = db.prepare(`SELECT i.id, i.stored_path AS path, e.emb FROM inspirations i
    JOIN clip_embeddings e ON e.id = i.id AND e.model = 'clip-b32-q8'
    WHERE i.type IN ('image','gif') ORDER BY i.id`).all();
  // Deterministic spread over the id order.
  const step = Math.max(1, Math.floor(rows.length / n));
  const sample = [];
  for (let i = 0; i < rows.length && sample.length < n; i += step) sample.push(rows[i]);

  const out = { model: { node_sha256: nodeSha, app_sha256: appSha, same: nodeSha === appSha }, items: [] };
  const per = { 'app-decoder': [], 'rust-port': [], 'vips-cubic': [], 'vips-lanczos3': [] };
  const helper = ensureHelper({ log: console.log });
  const appTensors = helper ? rustTensors(helper, sample.map((r) => r.path)) : sample.map(() => null);
  for (const [i, r] of sample.entries()) {
    const stored = decodeF32(r.emb);
    const rec = { item: r.id.slice(0, 8) };
    try {
      const t0 = performance.now();
      if (appTensors[i]) rec['app-decoder'] = +dot(await vision.embed(appTensors[i]), stored).toFixed(4);
      const img = await decodeRGB(r.path);
      rec.icc = img.icc; rec.alpha = img.hadAlpha; rec.short_side = Math.min(img.width, img.height);
      const v1 = await vision.embed(preprocessRust(img));
      rec['rust-port'] = +dot(v1, stored).toFixed(4);
      const v2 = await vision.embed(await preprocessSharp(r.path, 'cubic'));
      rec['vips-cubic'] = +dot(v2, stored).toFixed(4);
      const v3 = await vision.embed(await preprocessSharp(r.path, 'lanczos3'));
      rec['vips-lanczos3'] = +dot(v3, stored).toFixed(4);
      rec.ms = Math.round(performance.now() - t0);
      for (const k of Object.keys(per)) if (rec[k] != null) per[k].push(rec[k]);
    } catch (e) {
      rec.error = String(e.message || e).slice(0, 120);
    }
    out.items.push(rec);
    console.log(JSON.stringify(rec));
  }
  out.summary = Object.fromEntries(Object.entries(per).filter(([, v]) => v.length).map(([k, v]) => [k, stats(v)]));
  console.log('summary (cosine Node vs stored Rust vector):');
  for (const [k, s] of Object.entries(out.summary)) console.log(`  ${k.padEnd(14)} mean ${s.mean}  median ${s.median}  min ${s.min}  max ${s.max}  (n=${s.n})`);
  if (a.out) { fs.mkdirSync(path.dirname(a.out), { recursive: true }); fs.writeFileSync(a.out, JSON.stringify(out, null, 2) + '\n'); }
  return nodeSha === appSha ? 0 : 1;
}

runMain(import.meta.url, main);
