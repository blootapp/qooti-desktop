#!/usr/bin/env node
// Lens build — spec §2.2. Checks lenses/src/*.json, embeds every prompt with the CLIP text
// encoder (Xenova/clip-vit-base-patch32, q8, template "This is a photo of {p}"), and writes
//   src-tauri/lenses/qooti-lens-<id>.json                     bundled copy (Rust include_str!)
//   lenses/dist/qooti-lens-<id>-<version>-<sha12>.json        publish copy (same bytes)
//   lenses/dist/qooti-lenses.json                             catalogue index
//
// Concept vector: embed each prompt (template applied), L2-normalise each, average, L2-normalise,
// store as 512 little-endian f16 in base64. Deterministic: fixed key order, 2-space JSON, trailing
// newline, one prompt per encoder run on one thread; `updated_at` only moves when the content
// changes; the index serial only moves when an entry changes.
// Shared tags (spec §0c): an add-by-hand entry ("suggest": false) is written without prompts, vec
// or media (it's never scored); `group` and `suggest` are carried through as the source has them.
//
//   node scripts/lenses/build.mjs                  build all lenses (any error stops everything)
//   node scripts/lenses/build.mjs --lens motion    build one lens; problems in other sources are warnings
//   node scripts/lenses/build.mjs --index-only     rewrite the dist copies + index from the bundled files
//   options: --cache <dir>   model cache (default E:/DP 2/qooti-tag-eval/hf-cache)
//            --date YYYY-MM-DD   updated_at for changed lenses (default: today, local time)
//            --min-app 1.2.3     min_app for every built lens (default 1.2.3)
//            --dry-run           check + embed, write nothing
//            --allow-same-version  write a changed lens without a higher version (see below)
//            --src-dir / --bundled-dir / --dist-dir   other folders (tests)
//
// A lens whose built file would change needs a higher `version` than the bundled file it replaces:
// the app installs a lens only when its version is higher, so a change kept at the same version
// never reaches computers that already have it. The build refuses that ("content changed: bump the
// version") and writes nothing, unless the bundled file is a placeholder or --allow-same-version
// is given (only for a version no one has installed yet, e.g. before the first release).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, runMain } from './lib/args.mjs';
import { SRC_DIR, BUNDLED_DIR, DIST_DIR, HF_CACHE, slash } from './lib/paths.mjs';
import { encodeF16, toBase64, decodeF16 } from './lib/f16.mjs';
import { LENS_ORDER, isScored } from './lens-score.mjs';
import {
  FORMAT, MODEL, TEMPLATE, MAX_FILE_BYTES, checkSources, checkBuilt, checkLensObject, printIssues, sha256, versionBumpProblem,
} from './check.mjs';

export const DEFAULT_MIN_APP = '1.2.3';

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const lensRank = (id) => { const i = LENS_ORDER.indexOf(id); return i < 0 ? LENS_ORDER.length : i; };

/** Average of L2-normalised prompt vectors, normalised again (spec §2.2). */
export function averageUnit(vectors) {
  const dim = vectors[0].length;
  const sum = new Float64Array(dim);
  for (const v of vectors) {
    let s = 0;
    for (let i = 0; i < dim; i++) s += v[i] * v[i];
    const n = Math.sqrt(s) || 1;
    for (let i = 0; i < dim; i++) sum[i] += v[i] / n;
  }
  let s = 0;
  for (let i = 0; i < dim; i++) s += sum[i] * sum[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < dim; i++) sum[i] /= n;
  return sum;
}

/**
 * Built lens object with the canonical key order. `vecs`: concept id → base64 vec (scored entries
 * only). Entry keys: id, label, group?, suggest?, then for a scored entry media, aspect?, prompts,
 * about?, vec, and for an add-by-hand entry ("suggest": false) only about? (spec §0c: no prompts,
 * vec or media). `group` and `suggest` are copied as the source gives them, so an entry without
 * them builds exactly as before.
 */
export function composeBuilt(src, { vecs, minApp, updatedAt, textModel }) {
  const about = (a) => {
    const o = {};
    if (a.en !== undefined) o.en = a.en;
    if (a.uz !== undefined) o.uz = a.uz;
    return o;
  };
  const out = {
    format: FORMAT,
    id: src.id,
    version: src.version,
    role: src.role,
    min_app: minApp,
    updated_at: updatedAt,
    model: MODEL,
    template: TEMPLATE,
    text_model: textModel,
    name: { en: src.name.en, uz: src.name.uz },
    summary: { en: src.summary.en, uz: src.summary.uz },
    bar: { picture: src.bar.picture, video: src.bar.video },
    borrows: [...(src.borrows || [])],
    concepts: src.concepts.map((c) => {
      const o = { id: c.id, label: { en: c.label.en, uz: c.label.uz } };
      if (c.group !== undefined) o.group = { en: c.group.en, uz: c.group.uz };
      if (c.suggest !== undefined) o.suggest = c.suggest;
      if (!isScored(c)) {
        if (c.about !== undefined) o.about = about(c.about);
        return o;
      }
      o.media = c.media;
      if (c.aspect !== undefined) o.aspect = [c.aspect[0], c.aspect[1]];
      o.prompts = [...c.prompts];
      if (c.about !== undefined) o.about = about(c.about);
      o.vec = vecs.get(c.id);
      return o;
    }),
  };
  return out;
}

export const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
export const distName = (id, version, sha) => `qooti-lens-${id}-${version}-${sha.slice(0, 12)}.json`;

/**
 * The version-bump guard: may `nextText` (a freshly built lens) replace the bundled `prevText`?
 * Returns null when it may (nothing built yet, no change, a higher version, a placeholder, or an
 * unreadable old file), else why not ("content changed: bump the version …").
 */
export function versionGuard(prevText, nextText) {
  if (prevText == null || prevText === nextText) return null;
  let prev, next;
  try { prev = JSON.parse(prevText); next = JSON.parse(nextText); } catch { return null; }
  if (!prev || typeof prev !== 'object' || prev.placeholder === true) return null;
  return versionBumpProblem(prev.version, next && next.version);
}

/**
 * Rewrites lenses/dist from the bundled files: one dist copy per bundled lens (same bytes), stale
 * dist copies of those lenses removed, and the index. Returns the index object.
 */
export function writeIndex({ bundledDir = BUNDLED_DIR, distDir = DIST_DIR, date = today(), dryRun = false, log = console.log } = {}) {
  const files = fs.existsSync(bundledDir) ? fs.readdirSync(bundledDir).filter((f) => /^qooti-lens-[a-z][a-z0-9_]*\.json$/.test(f)) : [];
  const entries = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(bundledDir, f));
    let d;
    try { d = JSON.parse(buf.toString('utf8')); } catch { log(`  skip ${f}: not valid JSON`); continue; }
    if (!d || typeof d.id !== 'string' || !Number.isInteger(d.version)) { log(`  skip ${f}: no id/version`); continue; }
    if (d.placeholder === true) { log(`  skip ${f}: placeholder (never published)`); continue; }
    const sha = sha256(buf);
    const file = distName(d.id, d.version, sha);
    entries.push({ id: d.id, version: d.version, file, size: buf.length, sha256: sha, min_app: d.min_app, buf });
  }
  entries.sort((a, b) => lensRank(a.id) - lensRank(b.id) || a.id.localeCompare(b.id));
  const indexFile = path.join(distDir, 'qooti-lenses.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { prev = null; }
  const lenses = entries.map(({ buf, ...e }) => e);
  const same = prev && Array.isArray(prev.lenses) && JSON.stringify(prev.lenses) === JSON.stringify(lenses);
  const dateSerial = Number(date.replace(/-/g, '')) * 100;
  const serial = same && Number.isInteger(prev.serial) ? prev.serial : Math.max((Number.isInteger(prev?.serial) ? prev.serial : 0) + 1, dateSerial);
  const index = { format: FORMAT, serial, updated_at: same && prev.updated_at ? prev.updated_at : date, lenses };
  if (!dryRun) {
    for (const e of entries) {
      const target = path.join(distDir, e.file);
      if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== e.sha256) writeAtomic(target, e.buf);
      if (fs.existsSync(distDir)) {
        for (const old of fs.readdirSync(distDir)) {
          if (old !== e.file && old.startsWith(`qooti-lens-${e.id}-`) && /-\d+-[0-9a-f]{12}\.json$/.test(old)) {
            // Only this lens's own stale copies (never another lens's files).
            const rest = old.slice(`qooti-lens-${e.id}-`.length);
            if (/^\d+-[0-9a-f]{12}\.json$/.test(rest)) fs.rmSync(path.join(distDir, old));
          }
        }
      }
    }
    if (!same || !fs.existsSync(indexFile)) writeAtomic(indexFile, serialize(index));
  }
  return { index, changed: !same };
}

async function main(argv) {
  const a = parseArgs(argv, {
    flags: ['index-only', 'dry-run', 'allow-same-version', 'help'],
    options: ['lens', 'cache', 'date', 'min-app', 'src-dir', 'bundled-dir', 'dist-dir'],
  });
  if (a.help) { console.log('usage: node scripts/lenses/build.mjs [--lens <id>] [--index-only] [--cache <dir>] [--date YYYY-MM-DD] [--min-app 1.2.3] [--dry-run] [--allow-same-version]'); return 0; }
  const srcDir = path.resolve(a['src-dir'] || SRC_DIR);
  const bundledDir = path.resolve(a['bundled-dir'] || BUNDLED_DIR);
  const distDir = path.resolve(a['dist-dir'] || DIST_DIR);
  const date = a.date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must be YYYY-MM-DD');
  const minApp = a['min-app'] || DEFAULT_MIN_APP;
  if (!/^\d+\.\d+\.\d+$/.test(minApp)) throw new Error('--min-app must look like 1.2.3');
  const focus = a.lens ? a.lens.split(',').map((s) => s.trim()).filter(Boolean) : null;

  if (a['index-only']) {
    const { index, changed } = writeIndex({ bundledDir, distDir, date, dryRun: a['dry-run'] });
    console.log(`index: ${index.lenses.length} lenses, serial ${index.serial}${changed ? ' (changed)' : ' (unchanged)'}`);
    for (const e of index.lenses) console.log(`  ${e.id} v${e.version} ${e.file} ${e.size} B`);
    return 0;
  }

  const { loadTextEncoder } = await import('./lib/models.mjs');
  const t0 = performance.now();
  const enc = await loadTextEncoder(a.cache || HF_CACHE, { log: console.log });
  console.log(`text model: ${enc.textModel}`);

  // 1. Check the sources (real tokenizer). Errors stop the build before anything is written.
  const { issues, entries } = checkSources({ srcDir, focus, countTokens: enc.tokens });
  const errors = issues.filter((i) => i.level === 'error');
  console.log(`check sources: ${entries.length} file(s), ${errors.length} error(s), ${issues.length - errors.length} warning(s)`);
  printIssues(issues);
  if (focus) {
    for (const id of focus) if (!entries.some((e) => e.data.id === id)) errors.push({ code: 'build.missing', msg: `no source for ${id} in ${slash(srcDir)}` });
  }
  if (errors.length) {
    console.error(`build stopped: fix the error(s) above${focus ? ` in ${focus.join(', ')}` : ''}`);
    return 1;
  }
  const targets = entries.filter((e) => !focus || focus.includes(e.data.id))
    .sort((x, y) => lensRank(x.data.id) - lensRank(y.data.id));

  // 2. Embed every target lens first; nothing is written until all of them pass.
  const planned = [];
  for (const e of targets) {
    const src = e.data;
    const t1 = performance.now();
    const vecs = new Map();
    let prompts = 0;
    for (const c of src.concepts) {
      if (!isScored(c)) continue;   // an add-by-hand entry is never scored: nothing to embed
      const pv = [];
      for (const p of c.prompts) { pv.push(await enc.embed(TEMPLATE.replace('{p}', p))); prompts++; }
      const unit = averageUnit(pv);
      const bytes = encodeF16(unit);
      const back = decodeF16(bytes);
      const norm = Math.sqrt(back.reduce((s, x) => s + x * x, 0));
      if (!(norm >= 0.999 && norm <= 1.001)) throw new Error(`${src.id}.${c.id}: f16 vector norm ${norm} (expected ~1)`);
      vecs.set(c.id, toBase64(bytes));
    }
    const bundledFile = path.join(bundledDir, `qooti-lens-${src.id}.json`);
    let prevText = null;
    try { prevText = fs.readFileSync(bundledFile, 'utf8'); } catch { prevText = null; }
    let updatedAt = date;
    if (prevText) {
      try {
        const prev = JSON.parse(prevText);
        const probe = serialize(composeBuilt(src, { vecs, minApp, updatedAt: prev.updated_at, textModel: enc.textModel }));
        if (probe === prevText) updatedAt = prev.updated_at;
      } catch { /* rebuild from scratch */ }
    }
    const built = composeBuilt(src, { vecs, minApp, updatedAt, textModel: enc.textModel });
    const text = serialize(built);
    const size = Buffer.byteLength(text, 'utf8');
    if (size > MAX_FILE_BYTES) throw new Error(`${src.id}: built file is ${size} bytes (max ${MAX_FILE_BYTES}); fewer concepts or shorter text`);
    const own = { list: [], error(code, l, w, m) { this.list.push({ level: 'error', code, where: w, msg: m }); }, warn() {} };
    checkLensObject(own, built, { kind: 'built', file: bundledFile, bytes: size, countTokens: null });
    if (own.list.length) { printIssues(own.list); throw new Error(`${src.id}: the built file fails its own checks`); }
    planned.push({ src, prompts, size, text, bundledFile, sha: sha256(Buffer.from(text, 'utf8')), changed: text !== prevText, guard: versionGuard(prevText, text), ms: performance.now() - t1 });
  }

  // 3. The version-bump guard, then write.
  const refused = planned.filter((p) => p.guard);
  if (refused.length && !a['allow-same-version']) {
    for (const p of refused) console.error(`  ERROR built.same_version   ${p.src.id}: ${p.guard} (lenses/src/${p.src.id}.json, or --allow-same-version if no one has v${p.src.version} yet)`);
    console.error(`build stopped: nothing written${a['dry-run'] ? ' (dry run)' : ''}`);
    return 1;
  }
  for (const p of refused) console.log(`  warn  ${p.src.id} changed at v${p.src.version} (--allow-same-version): computers that already have v${p.src.version} keep the old file`);
  for (const p of planned) {
    if (!a['dry-run'] && p.changed) writeAtomic(p.bundledFile, p.text);
    const scored = p.src.concepts.filter(isScored).length;
    const hand = p.src.concepts.length - scored;
    console.log(`built ${p.src.id} v${p.src.version}: ${scored} scored entries${hand ? ` + ${hand} add-by-hand` : ''}, ${p.prompts} prompts, ${p.size} B, sha256 ${p.sha.slice(0, 12)}…, ${p.changed ? 'written' : 'unchanged'}${a['dry-run'] ? ' (dry run)' : ''} [${Math.round(p.ms)} ms]`);
  }

  // 4. Dist copies + index from every bundled lens, then check what Rust would install.
  const { index, changed } = writeIndex({ bundledDir, distDir, date, dryRun: a['dry-run'] });
  console.log(`index: ${index.lenses.map((x) => `${x.id} v${x.version}`).join(', ') || '(empty)'} · serial ${index.serial}${changed ? ' (changed)' : ''}`);
  if (!a['dry-run']) {
    const built = checkBuilt({ bundledDir, distDir, srcDir, focus });
    const be = built.issues.filter((i) => i.level === 'error');
    console.log(`check built: ${built.entries.length} bundled file(s), ${be.length} error(s), ${built.issues.length - be.length} warning(s)`);
    // Text warnings were already printed for the sources; show only what's new.
    const seen = new Set(issues.map((i) => `${i.code}|${i.where}`));
    printIssues(built.issues.filter((i) => i.level === 'error' || !seen.has(`${i.code}|${i.where}`)));
    if (be.length) return 1;
  }
  console.log(`done in ${Math.round(performance.now() - t0)} ms`);
  return 0;
}

runMain(import.meta.url, main);
