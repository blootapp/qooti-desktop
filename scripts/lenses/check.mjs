#!/usr/bin/env node
// Lens file checker — spec §2.3 (the same rules the Rust installer applies), for the sources in
// lenses/src/*.json and the built files (src-tauri/lenses/*.json, lenses/dist/**).
// Errors exit 1; warnings are printed.
//
//   node scripts/lenses/check.mjs                 sources + built files
//   node scripts/lenses/check.mjs --src           sources only
//   node scripts/lenses/check.mjs --built         built files only (bundled, dist, index)
//   node scripts/lenses/check.mjs --lens motion   cross-lens problems caused by OTHER lenses are warnings
//   node scripts/lenses/check.mjs <file.json> …   just these files (source or built, auto-detected)
//   options: --cache <hf cache dir> (tokenizer) · --no-tokens (skip the 77-token check, with a warning)
//            --json (machine-readable result)
//
// Node is deliberately a little stricter than Rust (e.g. `bar` and `media` are required, prompt
// duplicates are compared case- and space-insensitively), so anything that passes here installs.
//
// Shared tags (spec §0c): one concept id may have an entry in several lenses. Its entries carry
// identical labels (and the same `group` wherever one is given), and its scored entries cover
// disjoint media: in the whole catalogue at most one entry covers pictures (media picture/any) and
// at most one covers videos (video/any). An add-by-hand entry ("suggest": false) has no prompts,
// vec, media or aspect. Per lens: at most 80 scored entries and 120 entries in all. Labels are
// unique per language across concepts (entries of one id share theirs), compared trimmed,
// lower-cased and with ‘ ’ ʻ ʼ ` read as ' (the app's same-name key); an English label may not be
// another concept's Uzbek label. A specialist may own an entry for a tag it borrows only when the
// two entries' media don't overlap.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs, runMain } from './lib/args.mjs';
import { SRC_DIR, BUNDLED_DIR, DIST_DIR, HF_CACHE, ROOT, slash } from './lib/paths.mjs';
import { decodeF16, fromBase64, isStrictBase64 } from './lib/f16.mjs';
import { LENS_ORDER, MEDIA_KINDS, isScored, covers, nameKey } from './lens-score.mjs';

export const FORMAT = 2;
export const MODEL = 'clip-b32-q8';
export const TEMPLATE = 'This is a photo of {p}';
export const MAX_FILE_BYTES = 256 * 1024;
export const LIMITS = Object.freeze({
  versionMax: 100000,   // lenses.rs parse_lens: a huge version would block every later update
  label: 24, labelWarn: 14, name: 48, summary: 60, group: 24,
  // conceptsMax counts every entry; scoredMax only the scored ones (add-by-hand entries are free)
  conceptsMin: 1, conceptsMax: 120, scoredMax: 80, promptsMin: 2, promptsMax: 8, promptsWarn: 4,
  wordsMin: 1, wordsMax: 8, wordsWarn: 6, tokens: 77, promptChars: 200,
  barMin: 0.05, barMax: 0.95, normMin: 0.98, normMax: 1.02, dim: 512,
});
/** Roles fixed by the owner (spec §0.2 / §2.1). */
export const KNOWN_ROLES = Object.freeze({ motion: 'specialist', design: 'base', thumbnail: 'specialist' });
const LENS_ID = /^[a-z][a-z0-9_]{1,31}$/;
const CONCEPT_ID = /^[a-z][a-z0-9_]{1,39}$/;
const MEDIA = new Set(['any', 'picture', 'video']);
const SOURCE_KEYS = ['id', 'version', 'role', 'name', 'summary', 'bar', 'borrows', 'concepts'];
const BUILD_KEYS = ['format', 'min_app', 'updated_at', 'model', 'template', 'text_model', 'placeholder'];
const CONCEPT_KEYS = ['id', 'label', 'group', 'suggest', 'prompts', 'media', 'aspect', 'about'];
/** What only a scored entry has: an add-by-hand entry ("suggest": false) carries none of these. */
const SCORING_KEYS = ['prompts', 'media', 'aspect', 'vec'];
const UZ_BAD = /['`ʻʼ]/;
const CONTROL = /[\p{Cc}\p{Cf}]/u;

const cps = (s) => [...s].length;
const words = (s) => s.trim().split(/\s+/).filter(Boolean);
const normPrompt = (s) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
/** Two labels are one name when these keys match (the app's same-name key, tagging.rs name_key). */
export const labelKey = (s) => nameKey(s.normalize('NFC'));
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class Issues {
  constructor() { this.list = []; }
  add(level, code, lenses, where, msg) { this.list.push({ level, code, lenses: [...new Set(lenses)].filter(Boolean), where, msg }); }
  error(code, lenses, where, msg) { this.add('error', code, lenses, where, msg); }
  warn(code, lenses, where, msg) { this.add('warning', code, lenses, where, msg); }
}

function checkText(issues, lens, where, value, lang, max, isLabel = false) {
  if (typeof value !== 'string') { issues.error('text.type', [lens], where, 'must be a string'); return; }
  if (!value.trim()) { issues.error('text.empty', [lens], where, 'must not be empty'); return; }
  if (value !== value.trim()) issues.error('text.trim', [lens], where, 'has leading or trailing spaces');
  if (value !== value.normalize('NFC')) issues.error('text.nfc', [lens], where, 'is not Unicode NFC');
  if (/[<>]/.test(value)) issues.error('text.angle', [lens], where, 'must not contain < or >');
  // Labels, groups, names and summaries are shown as they are: "web_design" reads as an internal id
  if (value.includes('_')) issues.error('text.underscore', [lens], where, 'must not contain _ (shown as it is, it reads as an id; use a space)');
  if (CONTROL.test(value)) issues.error('text.control', [lens], where, 'contains a control or format character (Cc/Cf)');
  if (lang === 'uz' && UZ_BAD.test(value)) {
    issues.error('text.uz_apostrophe', [lens], where, "Uzbek must use ‘ (U+2018) for o‘/g‘ and ’ (U+2019) for the tutuq, not ' ` ʻ ʼ");
  }
  const n = cps(value);
  if (n > max) issues.error('text.length', [lens], where, `${n} characters (max ${max})`);
  else if (isLabel && n > LIMITS.labelWarn) issues.warn('text.label_long', [lens], where, `${n} characters; the card slot fits about ${LIMITS.labelWarn}`);
}

function checkPair(issues, lens, where, value, max, isLabel = false) {
  if (!isObj(value)) { issues.error('text.pair', [lens], where, 'must be an object {en, uz}'); return; }
  for (const k of Object.keys(value)) if (k !== 'en' && k !== 'uz') issues.error('text.pair', [lens], `${where}.${k}`, 'unknown language key (only en, uz)');
  checkText(issues, lens, `${where}.en`, value.en, 'en', max, isLabel);
  checkText(issues, lens, `${where}.uz`, value.uz, 'uz', max, isLabel);
}

/** Decodes and checks a concept `vec`; returns the norm or null. */
export function checkVec(issues, lens, where, vec) {
  if (!isStrictBase64(vec)) { issues.error('vec.base64', [lens], where, 'must be standard padded base64'); return null; }
  const bytes = fromBase64(vec);
  if (bytes.length !== LIMITS.dim * 2) { issues.error('vec.length', [lens], where, `${bytes.length} bytes, expected ${LIMITS.dim * 2} (512 f16)`); return null; }
  const vals = decodeF16(bytes);
  let s = 0;
  for (const v of vals) {
    if (!Number.isFinite(v)) { issues.error('vec.finite', [lens], where, 'contains NaN or infinity'); return null; }
    s += v * v;
  }
  const norm = Math.sqrt(s);
  if (norm < LIMITS.normMin || norm > LIMITS.normMax) issues.error('vec.norm', [lens], where, `L2 norm ${norm.toFixed(4)} outside [${LIMITS.normMin}, ${LIMITS.normMax}]`);
  return norm;
}

/**
 * Checks one lens object. kind: 'source' | 'built'. Returns nothing; adds to `issues`.
 * opts.countTokens(text) → number (real CLIP tokenizer) or null to skip.
 */
export function checkLensObject(issues, data, { kind, file = '', bytes = null, countTokens = null }) {
  const label = file ? path.basename(file) : '(lens)';
  if (!isObj(data)) { issues.error('lens.json', [], label, 'top level must be a JSON object'); return; }
  const id = typeof data.id === 'string' ? data.id : null;
  const L = id || label;
  const allowed = new Set(kind === 'built' ? [...SOURCE_KEYS, ...BUILD_KEYS] : SOURCE_KEYS);
  for (const k of Object.keys(data)) {
    if (!allowed.has(k)) {
      issues.error('lens.unknown_key', [L], `${L}.${k}`, BUILD_KEYS.includes(k) ? 'build-only field in a source file' : 'unknown field');
    }
  }
  if (!id || !LENS_ID.test(id)) issues.error('lens.id', [L], `${L}.id`, 'must match ^[a-z][a-z0-9_]{1,31}$');
  if (id && file) {
    const base = path.basename(file);
    const ok = kind === 'source' ? base === `${id}.json`
      : base === `qooti-lens-${id}.json` || new RegExp(`^qooti-lens-${id}-\\d+-[0-9a-f]{12}\\.json$`).test(base);
    if (!ok) issues.error('lens.filename', [L], base, kind === 'source' ? `source file must be named ${id}.json` : `built file must be qooti-lens-${id}.json (bundled) or qooti-lens-${id}-<version>-<sha12>.json (dist)`);
  }
  if (!Number.isInteger(data.version) || data.version < 1 || data.version > LIMITS.versionMax) {
    issues.error('lens.version', [L], `${L}.version`, `must be an integer from 1 to ${LIMITS.versionMax}`);
  }
  if (data.role !== 'base' && data.role !== 'specialist') issues.error('lens.role', [L], `${L}.role`, 'must be "base" or "specialist"');
  else if (id && KNOWN_ROLES[id] && KNOWN_ROLES[id] !== data.role) issues.error('lens.role_for_id', [L], `${L}.role`, `the ${id} lens must be "${KNOWN_ROLES[id]}" (spec §2.1)`);
  // The app takes only these three from the catalogue and could never remove another one.
  if (id && !KNOWN_ROLES[id]) issues.error('lens.unknown_id', [L], `${L}.id`, `not one of the owner's lenses (${Object.keys(KNOWN_ROLES).join(', ')})`);
  checkPair(issues, L, `${L}.name`, data.name, LIMITS.name);
  checkPair(issues, L, `${L}.summary`, data.summary, LIMITS.summary);
  if (!isObj(data.bar)) issues.error('lens.bar', [L], `${L}.bar`, 'must be an object {picture, video}');
  else {
    for (const k of Object.keys(data.bar)) if (k !== 'picture' && k !== 'video') issues.error('lens.bar', [L], `${L}.bar.${k}`, 'unknown field');
    for (const k of ['picture', 'video']) {
      const v = data.bar[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < LIMITS.barMin || v > LIMITS.barMax) {
        issues.error('lens.bar', [L], `${L}.bar.${k}`, `must be a number in [${LIMITS.barMin}, ${LIMITS.barMax}]`);
      }
    }
  }
  if (data.borrows !== undefined) {
    if (!Array.isArray(data.borrows) || data.borrows.some((b) => typeof b !== 'string')) issues.error('lens.borrows', [L], `${L}.borrows`, 'must be an array of concept ids');
    else {
      if (data.role === 'base' && data.borrows.length) issues.error('lens.borrows', [L], `${L}.borrows`, 'only specialist lenses borrow');
      if (new Set(data.borrows).size !== data.borrows.length) issues.error('lens.borrows', [L], `${L}.borrows`, 'lists a concept twice');
    }
  }
  if (kind === 'built') {
    if (data.format !== FORMAT) issues.error('built.format', [L], `${L}.format`, `must be ${FORMAT}`);
    if (data.model !== MODEL) issues.error('built.model', [L], `${L}.model`, `must be "${MODEL}"`);
    if (typeof data.template !== 'string' || !data.template.includes('{p}')) issues.error('built.template', [L], `${L}.template`, 'must be a string containing {p}');
    else if (data.template !== TEMPLATE) issues.warn('built.template', [L], `${L}.template`, `differs from the standard "${TEMPLATE}"`);
    if (typeof data.min_app !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.min_app)) issues.error('built.min_app', [L], `${L}.min_app`, 'must be a version like 1.2.3');
    if (typeof data.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.updated_at)) issues.error('built.updated_at', [L], `${L}.updated_at`, 'must be YYYY-MM-DD');
    if (typeof data.text_model !== 'string' || !data.text_model.trim()) issues.error('built.text_model', [L], `${L}.text_model`, 'must name the text model used');
    if (bytes != null && bytes > MAX_FILE_BYTES) issues.error('built.size', [L], label, `${bytes} bytes (max ${MAX_FILE_BYTES})`);
    if (data.placeholder !== undefined) {
      if (typeof data.placeholder !== 'boolean') issues.error('built.placeholder', [L], `${L}.placeholder`, 'must be true or false');
      else if (data.placeholder) issues.warn('built.placeholder', [L], label, 'a stand-in the app bundles until the real lens is built (never scored, never published): run build.mjs');
    }
  }
  if (!Array.isArray(data.concepts)) { issues.error('lens.concepts', [L], `${L}.concepts`, 'must be an array'); return; }
  const n = data.concepts.length;
  if (n < LIMITS.conceptsMin || n > LIMITS.conceptsMax) issues.error('lens.concept_count', [L], `${L}.concepts`, `${n} entries (allowed ${LIMITS.conceptsMin}–${LIMITS.conceptsMax}, add-by-hand ones included)`);
  const scoredN = data.concepts.filter((c) => isObj(c) && isScored(c)).length;
  if (scoredN > LIMITS.scoredMax) issues.error('lens.scored_count', [L], `${L}.concepts`, `${scoredN} scored entries (at most ${LIMITS.scoredMax}; add-by-hand entries, "suggest": false, don't count)`);
  else if (n >= LIMITS.conceptsMin && scoredN === 0) issues.warn('lens.no_scored', [L], `${L}.concepts`, 'no scored entries: this lens never suggests anything (every entry is "suggest": false)');
  const template = kind === 'built' && typeof data.template === 'string' ? data.template : TEMPLATE;
  data.concepts.forEach((c, i) => {
    const cw = `${L}.concepts[${i}]${c && typeof c.id === 'string' ? ` (${c.id})` : ''}`;
    if (!isObj(c)) { issues.error('concept.type', [L], cw, 'must be an object'); return; }
    const ck = new Set(kind === 'built' ? [...CONCEPT_KEYS, 'vec'] : CONCEPT_KEYS);
    for (const k of Object.keys(c)) if (!ck.has(k)) issues.error('concept.unknown_key', [L], `${cw}.${k}`, k === 'vec' ? 'vec belongs in built files only' : 'unknown field');
    if (typeof c.id !== 'string' || !CONCEPT_ID.test(c.id)) issues.error('concept.id', [L], `${cw}.id`, 'must match ^[a-z][a-z0-9_]{1,39}$');
    checkPair(issues, L, `${cw}.label`, c.label, LIMITS.label, true);
    // The owner's heading (§0c): optional, text rules apply, not unique; carried through, unused for now.
    if (c.group !== undefined) checkPair(issues, L, `${cw}.group`, c.group, LIMITS.group);
    if (c.suggest !== undefined && typeof c.suggest !== 'boolean') {
      issues.error('concept.suggest', [L], `${cw}.suggest`, 'must be true or false (false = an add-by-hand tag: in the picker, never suggested)');
    }
    if (c.about !== undefined) {
      if (!isObj(c.about) || Object.entries(c.about).some(([k, v]) => !['en', 'uz'].includes(k) || typeof v !== 'string')) {
        issues.error('concept.about', [L], `${cw}.about`, 'must be an object with optional en/uz strings');
      }
    }
    if (!isScored(c)) {
      // An add-by-hand tag is never scored: nothing to embed, no media to cover.
      for (const k of SCORING_KEYS) {
        if (c[k] === undefined || (k === 'vec' && kind !== 'built')) continue;   // a source vec is already concept.unknown_key
        issues.error('concept.hand_field', [L], `${cw}.${k}`, `an add-by-hand tag ("suggest": false) has no ${k}: it is never scored`);
      }
      return;
    }
    if (!MEDIA.has(c.media)) issues.error('concept.media', [L], `${cw}.media`, 'must be "any", "picture" or "video"');
    if (c.aspect !== undefined) {
      const a = c.aspect;
      const ok = Array.isArray(a) && a.length === 2 && a.every((x) => typeof x === 'number' && Number.isFinite(x)) && a[0] > 0 && a[0] < a[1];
      if (!ok) issues.error('concept.aspect', [L], `${cw}.aspect`, 'must be [min, max] with 0 < min < max (width/height)');
    }
    if (!Array.isArray(c.prompts)) { issues.error('concept.prompts', [L], `${cw}.prompts`, 'must be an array of strings'); }
    else {
      const k = c.prompts.length;
      if (k < LIMITS.promptsMin || k > LIMITS.promptsMax) issues.error('concept.prompt_count', [L], `${cw}.prompts`, `${k} prompts (allowed ${LIMITS.promptsMin}–${LIMITS.promptsMax})`);
      else if (k > LIMITS.promptsWarn) issues.warn('concept.prompt_many', [L], `${cw}.prompts`, `${k} prompts (guideline: 2–${LIMITS.promptsWarn})`);
      c.prompts.forEach((p, j) => {
        const pw = `${cw}.prompts[${j}]`;
        if (typeof p !== 'string' || !p.trim()) { issues.error('concept.prompt_type', [L], pw, 'must be a non-empty string'); return; }
        if (p !== p.trim()) issues.error('concept.prompt_trim', [L], pw, 'has leading or trailing spaces');
        if (CONTROL.test(p) || /[<>{}]/.test(p)) issues.error('concept.prompt_chars', [L], pw, 'contains a control character, <, >, { or }');
        const w = words(p).length;
        if (w < LIMITS.wordsMin || w > LIMITS.wordsMax) issues.error('concept.prompt_words', [L], pw, `${w} words (allowed ${LIMITS.wordsMin}–${LIMITS.wordsMax})`);
        else if (w > LIMITS.wordsWarn) issues.warn('concept.prompt_long', [L], pw, `${w} words; 2–6 measured best`);
        const full = template.replace('{p}', p);
        if (cps(full) > LIMITS.promptChars) issues.error('concept.prompt_length', [L], pw, `template + prompt is ${cps(full)} characters (Rust allows ${LIMITS.promptChars})`);
        if (countTokens) {
          const t = countTokens(full);
          if (t > LIMITS.tokens) issues.error('concept.prompt_tokens', [L], pw, `template + prompt is ${t} CLIP tokens (max ${LIMITS.tokens})`);
        }
      });
    }
    if (kind === 'built') checkVec(issues, L, `${cw}.vec`, c.vec);
  });
}

/** The media of a raw entry as the app reads it (a missing media is 'any'), for messages. */
const mediaText = (c) => (c.media == null ? 'any' : String(c.media));

/**
 * Cross-lens rules over a set of lens objects (spec §2.3 + §0c): exactly one base; a lens lists a
 * concept id once; the entries of one id across lenses carry identical labels and agree on
 * `group` where they give one, and at most one scored entry covers each media; labels unique per
 * language across concepts (entries of one id excepted) and no English label equal to another
 * concept's Uzbek one; prompts unique across the catalogue; borrows name base concepts, and a lens
 * that also owns a borrowed tag covers other media with it.
 * opts.requireAll: complain when one of the owner's three lenses is missing.
 */
export function checkCatalogue(issues, lenses, { kind = 'source', requireAll = false } = {}) {
  const valid = lenses.filter((l) => isObj(l) && typeof l.id === 'string');
  const ids = new Map();
  for (const l of valid) {
    if (ids.has(l.id)) issues.error('catalogue.lens_dup', [l.id], l.id, 'two files define this lens');
    ids.set(l.id, l);
  }
  const bases = valid.filter((l) => l.role === 'base');
  // A missing base is the base lens's problem (focus mode on a specialist downgrades it).
  const BASE_ID = Object.keys(KNOWN_ROLES).find((k) => KNOWN_ROLES[k] === 'base');
  if (bases.length !== 1) {
    issues.error('catalogue.base', [...valid.map((l) => l.id), ...(bases.length ? [] : [BASE_ID])], kind === 'built' ? 'installed lenses' : 'sources',
      bases.length ? `${bases.length} base lenses (${bases.map((b) => b.id).join(', ')}); exactly one is required` : 'no base lens; exactly one is required (design)');
  }
  if (requireAll) for (const id of LENS_ORDER) if (!ids.has(id)) issues.error('catalogue.missing', [id], id, `lens ${id} is missing`);
  /** concept id → [{lens, c}]: its entries across the catalogue, at most one per lens. */
  const byId = new Map();
  const prompts = new Map();
  const labels = { en: new Map(), uz: new Map() };
  for (const l of valid) {
    if (!Array.isArray(l.concepts)) continue;
    const seenInLens = new Set();
    for (const c of l.concepts) {
      if (!isObj(c) || typeof c.id !== 'string') continue;
      if (seenInLens.has(c.id)) {
        issues.error('dup.concept_id', [l.id], `${l.id}.${c.id}`, 'concept id used twice in this lens (a lens has one entry per tag; another lens may have its own entry for it)');
        continue;
      }
      seenInLens.add(c.id);
      if (!byId.has(c.id)) byId.set(c.id, []);
      byId.get(c.id).push({ lens: l.id, c });
      if (Array.isArray(c.prompts)) {
        for (const p of c.prompts) {
          if (typeof p !== 'string') continue;
          const k = normPrompt(p);
          const o = prompts.get(k);
          if (o) issues.error('dup.prompt', [l.id, o.lens], `${l.id}.${c.id}`, `prompt "${p}" is also used by ${o.lens}.${o.concept} (prompts must be unique across the catalogue, ignoring case and spacing)`);
          else prompts.set(k, { lens: l.id, concept: c.id, p });
        }
      }
      if (isObj(c.label)) {
        for (const lang of ['en', 'uz']) {
          if (typeof c.label[lang] !== 'string') continue;
          const k = labelKey(c.label[lang]);
          const o = labels[lang].get(k);
          if (!o) labels[lang].set(k, { lens: l.id, concept: c.id, text: c.label[lang] });
          else if (o.concept !== c.id) {
            issues.error('dup.label', [l.id, o.lens], `${l.id}.${c.id}.label.${lang}`, `"${c.label[lang]}" is also the ${lang} label of ${o.lens}.${o.concept} (labels must be unique; case and ‘ ’ ' don't count)`);
          }
        }
      }
    }
  }
  // Shared tags: one id, one name, and one scored entry per media.
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    const first = list[0];
    for (const e of list.slice(1)) {
      for (const lang of ['en', 'uz']) {
        const a = isObj(first.c.label) ? first.c.label[lang] : undefined;
        const b = isObj(e.c.label) ? e.c.label[lang] : undefined;
        if (typeof a === 'string' && typeof b === 'string' && a !== b) {
          issues.error('shared.label', [first.lens, e.lens], `${e.lens}.${id}.label.${lang}`, `"${b}" differs from "${a}" in ${first.lens}: one tag has one name, so every entry of "${id}" carries the same labels`);
        }
      }
    }
    const grouped = list.filter((e) => isObj(e.c.group));
    for (const e of grouped.slice(1)) {
      const g = grouped[0];
      for (const lang of ['en', 'uz']) {
        if (g.c.group[lang] !== e.c.group[lang]) {
          issues.error('shared.group', [g.lens, e.lens], `${e.lens}.${id}.group.${lang}`, `"${e.c.group[lang]}" differs from "${g.c.group[lang]}" in ${g.lens}: entries of one tag that give a group give the same one`);
        }
      }
    }
    const overlaps = MEDIA_KINDS.map((m) => ({ m, cov: list.filter((e) => covers(e.c, m)) })).filter((x) => x.cov.length > 1);
    for (const { m, cov } of overlaps) {
      issues.error('shared.media_overlap', cov.map((e) => e.lens), id,
        `${cov.length} scored entries cover ${m}s (${cov.map((e) => `${e.lens}: ${mediaText(e.c)}`).join(', ')}); at most one entry in the whole catalogue may cover ${m}s, so give each lens other media or make one "suggest": false`);
    }
  }
  // A name belongs to one tag in both languages (search and the same-name rule match EN and UZ).
  for (const [k, en] of labels.en) {
    const uz = labels.uz.get(k);
    if (uz && uz.concept !== en.concept) {
      issues.error('dup.label_cross', [en.lens, uz.lens], `${en.lens}.${en.concept}.label.en`, `"${en.text}" is the Uzbek label of ${uz.lens}.${uz.concept}: an English label may not be another tag's Uzbek label`);
    }
  }
  const base = bases.length === 1 ? bases[0] : null;
  const baseEntries = new Map(base && Array.isArray(base.concepts) ? base.concepts.filter((c) => isObj(c) && typeof c.id === 'string').map((c) => [c.id, c]) : []);
  for (const l of valid) {
    if (l.role !== 'specialist' || !Array.isArray(l.borrows)) continue;
    const own = new Map((Array.isArray(l.concepts) ? l.concepts : []).filter((c) => isObj(c) && typeof c.id === 'string').map((c) => [c.id, c]));
    for (const b of l.borrows) {
      if (typeof b !== 'string') continue;
      if (!base) { issues.error('borrows.no_base', [l.id, BASE_ID], `${l.id}.borrows`, `can't check "${b}": no single base lens`); continue; }
      const be = baseEntries.get(b);
      if (!be) { issues.error('borrows.unknown', [l.id, base.id], `${l.id}.borrows`, `"${b}" is not a concept of the base lens ${base.id}`); continue; }
      if (!isScored(be)) issues.warn('borrows.hand', [l.id, base.id], `${l.id}.borrows`, `"${b}" is an add-by-hand tag in ${base.id} ("suggest": false): borrowing it only puts it in the tag picker, it is never suggested`);
      const mine = own.get(b);
      const overlap = mine ? MEDIA_KINDS.filter((m) => covers(be, m) && covers(mine, m)) : [];
      if (overlap.length) {
        issues.error('borrows.overlap', [l.id, base.id], `${l.id}.${b}`, `borrows "${b}" from ${base.id} (${mediaText(be)}) and also has its own entry for it (${mediaText(mine)}); both cover ${overlap.join(' and ')}s. Own a borrowed tag only for other media (e.g. own it for videos, borrow it for pictures)`);
      }
    }
  }
}

/** Reads + parses a JSON file; records a parse error as an issue. */
export function readLensFile(issues, file, kind) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { issues.error('lens.read', [], slash(file), `can't read: ${e.message}`); return null; }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) issues.error('lens.bom', [], path.basename(file), 'starts with a byte-order mark');
  let data;
  try { data = JSON.parse(text); } catch (e) {
    const guess = path.basename(file).replace(/^qooti-lens-/, '').replace(/(-\d+-[0-9a-f]{12})?\.json$/, '');
    issues.error('lens.json', [guess], path.basename(file), `invalid JSON: ${e.message}`);
    return null;
  }
  return { file, kind, text, bytes, data, sha256: sha256(Buffer.from(text, 'utf8')) };
}

const listJson = (dir, re = /\.json$/) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)) : []);

/** The non-built content of a lens (what the source defines), for stale-build detection. */
export function sourceView(l) {
  const out = {};
  for (const k of SOURCE_KEYS) if (l[k] !== undefined) out[k] = l[k];
  if (Array.isArray(out.concepts)) out.concepts = out.concepts.map((c) => { const { vec, ...rest } = c || {}; return rest; });
  if (Array.isArray(out.borrows) && !out.borrows.length) delete out.borrows;
  return out;
}
const canon = (x) => JSON.stringify(x, (k, v) => (isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]])) : v));

/**
 * A changed lens needs a higher version. The app installs a lens file only when its version is
 * higher than the installed one, so a change kept at the same version (or a lower one) never
 * reaches computers that already have that version. `builtVersion`: the current bundled file's;
 * `newVersion`: the changed content's. Returns the problem as text, or null when it's fine.
 */
export function versionBumpProblem(builtVersion, newVersion) {
  if (!Number.isInteger(builtVersion) || !Number.isInteger(newVersion)) return null;   // reported as lens.version
  if (newVersion > builtVersion) return null;
  return newVersion === builtVersion
    ? `content changed: bump the version (v${newVersion} is already built with other content, and apps that have v${newVersion} would never get the change)`
    : `content changed but v${newVersion} is lower than the built v${builtVersion}: bump the version above ${builtVersion}`;
}

/**
 * Checks the source folder. focus: lens id whose OWN problems stay errors while problems in or
 * caused by other lenses become warnings (parallel drafting). Returns {issues, entries}.
 */
export function checkSources({ srcDir = SRC_DIR, focus = null, countTokens = null, files = null } = {}) {
  const issues = new Issues();
  const entries = [];
  for (const f of files || listJson(srcDir)) {
    const e = readLensFile(issues, f, 'source');
    if (!e) continue;
    checkLensObject(issues, e.data, { kind: 'source', file: f, countTokens });
    entries.push(e);
  }
  if (!files && !entries.length && !issues.list.length) issues.warn('sources.none', [], slash(srcDir), 'no lens sources yet');
  if (focus && !files) {
    const own = Array.isArray(focus) ? focus : String(focus).split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of own) {
      if (!entries.some((e) => e.data && e.data.id === id)) issues.error('catalogue.missing', [id], slash(path.join(srcDir, `${id}.json`)), `no source for lens ${id}`);
    }
  }
  checkCatalogue(issues, entries.map((e) => e.data), { kind: 'source', requireAll: !focus && !files });
  return { issues: applyFocus(issues, focus), entries };
}

/** Built files: bundled copies, dist copies and the index, as Rust would install them. */
export function checkBuilt({ bundledDir = BUNDLED_DIR, distDir = DIST_DIR, srcDir = SRC_DIR, focus = null, countTokens = null } = {}) {
  const issues = new Issues();
  const bundled = [];
  for (const f of listJson(bundledDir, /^qooti-lens-.*\.json$/)) {
    const e = readLensFile(issues, f, 'built');
    if (!e) continue;
    checkLensObject(issues, e.data, { kind: 'built', file: f, bytes: e.bytes, countTokens });
    bundled.push(e);
  }
  for (const f of listJson(bundledDir)) {
    if (!/^qooti-lens-[a-z][a-z0-9_]*\.json$/.test(path.basename(f))) issues.warn('built.stray', [], slash(f), 'unexpected file in the bundled lens folder');
  }
  if (bundled.length) checkCatalogue(issues, bundled.map((e) => e.data), { kind: 'built' });
  // The app bundles all three (include_str!); a full check requires them, a focused one only notes it.
  for (const id of Object.keys(KNOWN_ROLES)) {
    if (bundled.some((e) => e.data.id === id)) continue;
    const msg = `src-tauri/lenses/qooti-lens-${id}.json is not built yet (run build.mjs --lens ${id})`;
    if (focus) issues.warn('built.missing', [id], id, msg); else issues.error('built.missing', [id], id, msg);
  }
  // Stale builds: the source changed after the last build. A change needs a higher version
  // (build.mjs refuses otherwise), except over a placeholder.
  for (const e of bundled) {
    const src = path.join(srcDir, `${e.data.id}.json`);
    if (!fs.existsSync(src)) { issues.warn('built.no_source', [e.data.id], slash(e.file), 'no matching source in lenses/src'); continue; }
    try {
      const s = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (canon(sourceView(s)) === canon(sourceView(e.data))) continue;
      const bump = e.data.placeholder === true ? null : versionBumpProblem(e.data.version, s.version);
      if (bump) issues.error('built.same_version', [e.data.id], slash(src), `${bump}; differs from ${path.basename(e.file)}`);
      else issues.warn('built.stale', [e.data.id], slash(e.file), `differs from lenses/src/${e.data.id}.json: run build.mjs --lens ${e.data.id}`);
    } catch { /* the source check reports broken sources */ }
  }
  // Dist copies + index.
  const indexFile = path.join(distDir, 'qooti-lenses.json');
  if (fs.existsSync(indexFile)) {
    let idx = null;
    try { idx = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (e) { issues.error('index.json', [], 'qooti-lenses.json', `invalid JSON: ${e.message}`); }
    if (idx) {
      if (idx.format !== FORMAT) issues.error('index.format', [], 'qooti-lenses.json', `format must be ${FORMAT}`);
      if (!Number.isInteger(idx.serial) || idx.serial < 1) issues.error('index.serial', [], 'qooti-lenses.json', 'serial must be an integer ≥ 1');
      if (typeof idx.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(idx.updated_at)) issues.error('index.updated_at', [], 'qooti-lenses.json', 'updated_at must be YYYY-MM-DD');
      if (!Array.isArray(idx.lenses)) issues.error('index.lenses', [], 'qooti-lenses.json', 'lenses must be an array');
      const listed = new Set();
      const listedIds = new Set();
      for (const ent of idx.lenses || []) {
        const w = `qooti-lenses.json › ${ent && ent.id}`;
        if (!isObj(ent) || typeof ent.file !== 'string' || !/^qooti-lens-[a-z][a-z0-9_]*-\d+-[0-9a-f]{12}\.json$/.test(ent.file)) { issues.error('index.entry', [], w, 'bad entry'); continue; }
        if (!KNOWN_ROLES[ent.id]) issues.error('index.unknown_id', [ent.id], w, `not one of the owner's lenses (${Object.keys(KNOWN_ROLES).join(', ')}): apps would never install it`);
        if (listedIds.has(ent.id)) issues.error('index.dup', [ent.id], w, 'this lens is listed twice');
        listedIds.add(ent.id);
        listed.add(ent.file);
        const f = path.join(distDir, ent.file);
        if (!fs.existsSync(f)) { issues.error('index.missing_file', [ent.id], w, `${ent.file} is not in lenses/dist`); continue; }
        const buf = fs.readFileSync(f);
        const sha = sha256(buf);
        if (ent.sha256 !== sha) issues.error('index.sha256', [ent.id], w, 'sha256 does not match the file');
        if (ent.size !== buf.length) issues.error('index.size', [ent.id], w, 'size does not match the file');
        if (!ent.file.endsWith(`-${sha.slice(0, 12)}.json`)) issues.error('index.name', [ent.id], w, 'file name hash does not match its sha256');
        let d = null;
        try { d = JSON.parse(buf.toString('utf8')); } catch { issues.error('index.file_json', [ent.id], w, 'dist file is not valid JSON'); }
        const twin = bundled.find((x) => x.data.id === ent.id && x.sha256 === sha);
        if (d && !twin) {
          // Same bytes as a checked bundled copy need no second pass; otherwise errors only.
          const errs = { error: (...x) => issues.error(...x), warn() {} };
          checkLensObject(errs, d, { kind: 'built', file: f, bytes: buf.length, countTokens: null });
        }
        if (d) {
          if (d.placeholder === true) issues.error('index.placeholder', [ent.id], w, 'a placeholder must never be published');
          if (d.id !== ent.id || d.version !== ent.version || d.min_app !== ent.min_app) issues.error('index.mismatch', [ent.id], w, 'id/version/min_app differ from the file');
          if (!ent.file.startsWith(`qooti-lens-${d.id}-${d.version}-`)) issues.error('index.name', [ent.id], w, 'file name does not match id and version');
        }
        const b = bundled.find((x) => x.data.id === ent.id);
        if (!b) issues.warn('index.not_bundled', [ent.id], w, 'listed in the index but no bundled copy');
        else if (b.sha256 !== sha) issues.error('index.bundled_differs', [ent.id], w, `bundled qooti-lens-${ent.id}.json differs from the dist copy: run build.mjs`);
      }
      for (const b of bundled) {
        if (b.data.placeholder === true) continue;
        if (!(idx.lenses || []).some((x) => x && x.id === b.data.id)) issues.error('index.unlisted', [b.data.id], 'qooti-lenses.json', `bundled lens ${b.data.id} is not in the index: run build.mjs --index-only`);
      }
      for (const f of listJson(distDir, /^qooti-lens-.*\.json$/)) {
        if (!listed.has(path.basename(f))) issues.warn('dist.unlisted', [], slash(f), 'not in the index (old build?)');
      }
    }
  } else if (bundled.length) {
    issues.warn('index.none', [], slash(indexFile), 'no catalogue index yet: run build.mjs');
  }
  return { issues: applyFocus(issues, focus), entries: bundled };
}

/**
 * In focus mode (`--lens a[,b]`), errors that involve any lens outside the focus become warnings,
 * so agents drafting different lenses at the same time don't block each other.
 */
export function applyFocus(issues, focus) {
  const list = Array.isArray(issues) ? issues : issues.list;
  if (!focus || (Array.isArray(focus) && !focus.length)) return list;
  const own = new Set(Array.isArray(focus) ? focus : String(focus).split(',').map((s) => s.trim()).filter(Boolean));
  return list.map((i) => {
    if (i.level !== 'error') return i;
    const others = i.lenses.length === 0 || i.lenses.some((l) => !own.has(l));
    return others ? { ...i, level: 'warning', msg: `${i.msg} [other lens or cross-lens: fix before the final full build]` } : i;
  });
}

export function printIssues(list, out = console) {
  for (const i of list) out[i.level === 'error' ? 'error' : 'log'](`  ${i.level === 'error' ? 'ERROR' : 'warn '} ${i.code.padEnd(22)} ${i.where}: ${i.msg}`);
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ['src', 'built', 'no-tokens', 'json', 'help'], options: ['lens', 'cache', 'src-dir', 'bundled-dir', 'dist-dir'] });
  if (a.help) {
    console.log('usage: node scripts/lenses/check.mjs [--src|--built] [--lens <id>] [--cache <dir>] [--no-tokens] [--json] [files…]');
    return 0;
  }
  let countTokens = null;
  const results = [];
  if (!a['no-tokens']) {
    const { loadTokenizer } = await import('./lib/models.mjs');
    try {
      const tok = await loadTokenizer(a.cache || HF_CACHE);
      countTokens = tok.count;
    } catch (e) {
      throw new Error(`the CLIP tokenizer could not be loaded (${e.message}); retry online once, or pass --no-tokens`);
    }
  }
  const tokenNote = countTokens ? [] : [{ level: 'warning', code: 'tokens.skipped', lenses: [], where: 'all prompts', msg: 'the 77-token check was skipped (--no-tokens)' }];
  if (a._.length) {
    const issues = new Issues();
    const objs = [];
    for (const f of a._) {
      const base = path.basename(f);
      const kind = /^qooti-lens-/.test(base) ? 'built' : 'source';
      const e = readLensFile(issues, path.resolve(f), kind);
      if (!e) continue;
      checkLensObject(issues, e.data, { kind, file: f, bytes: e.bytes, countTokens });
      objs.push(e.data);
    }
    if (objs.length > 1) checkCatalogue(issues, objs, { kind: 'source' });
    results.push({ name: 'files', list: [...applyFocus(issues, a.lens || null), ...tokenNote] });
  } else {
    const srcDir = a['src-dir'] || SRC_DIR;
    if (!a.built) {
      const r = checkSources({ srcDir, focus: a.lens || null, countTokens });
      results.push({ name: `sources (${slash(path.relative(ROOT, srcDir) || srcDir)}: ${r.entries.length} lens files)`, list: [...r.issues, ...tokenNote] });
    }
    if (!a.src) {
      const r = checkBuilt({ bundledDir: a['bundled-dir'] || BUNDLED_DIR, distDir: a['dist-dir'] || DIST_DIR, srcDir, focus: a.lens || null, countTokens: null });
      results.push({ name: `built (${r.entries.length} bundled lens files + dist)`, list: r.issues });
    }
  }
  let errors = 0, warnings = 0;
  for (const r of results) {
    errors += r.list.filter((i) => i.level === 'error').length;
    warnings += r.list.filter((i) => i.level !== 'error').length;
  }
  if (a.json) {
    console.log(JSON.stringify({ errors, warnings, results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`check ${r.name}`);
      if (!r.list.length) console.log('  ok');
      printIssues(r.list);
    }
    console.log(`${errors} error(s), ${warnings} warning(s)`);
  }
  return errors ? 1 : 0;
}

runMain(import.meta.url, main);
