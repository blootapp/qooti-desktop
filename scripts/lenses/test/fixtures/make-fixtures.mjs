#!/usr/bin/env node
// Regenerates the test fixtures (run it after changing the rules, then commit the output):
//   node scripts/lenses/test/fixtures/make-fixtures.mjs
//
// valid/src/*.json            three tiny lens sources that pass every rule, with the §0c shared-tag
//                             model in them: the tag d_type has a design entry for pictures and a
//                             motion entry for videos (motion also borrows design's), d_brand is an
//                             add-by-hand tag in design and thumbnail, m_meme one in motion, and some
//                             motion entries carry a group
// valid/built/*.json          the same lenses "built" with basis vectors instead of CLIP vectors:
//                             each scored entry is a unit vector e_k (BASIS), so tests can place items exactly
// invalid/<case>.json         one rule violation each (a whole lens file that replaces its valid twin)
// invalid/cases.json          [{name, kind: source|built, target, expect: {level, code}}]
// shared-tag-vectors.json     hand-written inputs → expected outputs for the scorer, the display
//                             rule, the picker and the signature (the app's Rust and JS must give
//                             the same; see PORT-NOTES.md). test/lens-score.test.mjs checks them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeBuilt, serialize } from '../../build.mjs';
import { encodeF16, toBase64 } from '../../lib/f16.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Basis index of every scored fixture entry (its vector is e_k). Keyed by concept id, or by
 * `<lens>/<id>` where one tag has entries in two lenses (the two entries have different vectors).
 */
export const BASIS = {
  d_poster: 0, d_logo: 1, d_photo: 2, d_story: 3, d_dark: 4, d_type: 5,
  m_green: 10, m_screen: 11, m_render: 12, 'motion/d_type': 13,
  t_face: 20, t_thumb: 21,
};
/** The basis index of a lens's entry. */
export const basisOf = (lensId, conceptId) => BASIS[`${lensId}/${conceptId}`] ?? BASIS[conceptId] ?? 30;

const concept = (id, en, uz, media, prompts, extra = {}) => ({ id, label: { en, uz }, media, ...extra, prompts });
/** An add-by-hand entry (§0c): in the tag picker, never scored. */
const hand = (id, en, uz, extra = {}) => ({ id, label: { en, uz }, ...extra, suggest: false });
const TECHNIQUES = { en: 'Techniques', uz: 'Usullar' };
const EDUCATION = { en: 'Education', uz: 'Ta’lim' };
const SOCIAL = { en: 'Social', uz: 'Ijtimoiy' };

export const SOURCES = {
  design: {
    id: 'design', version: 1, role: 'base',
    name: { en: 'Graphic designer / Social media post designer', uz: 'Grafik dizayner / SMM post dizayneri' },
    summary: { en: 'Posters, layouts, logos', uz: 'Afishalar, maketlar, logotiplar' },
    bar: { picture: 0.3, video: 0.2 },
    concepts: [
      concept('d_poster', 'Poster', 'Afisha', 'any', ['a printed poster', 'a graphic poster design']),
      concept('d_logo', 'Logo', 'Logotip', 'any', ['a logo mark', 'a brand logo']),
      concept('d_photo', 'Photo', 'Foto', 'any', ['a candid photo', 'a portrait photograph']),
      concept('d_story', 'Story', 'Storis', 'any', ['a vertical story post', 'a phone story layout'], { aspect: [0.5, 0.6] }),
      concept('d_dark', 'Dark mood', 'Qorong‘i', 'any', ['a dark moody scene', 'a low key image']),
      concept('d_type', 'Typography', 'Tipografika', 'picture', ['a font specimen', 'expressive lettering']),
      hand('d_brand', 'Branding', 'Brending'),
    ],
  },
  motion: {
    id: 'motion', version: 1, role: 'specialist',
    name: { en: 'Video editor / Motion designer', uz: 'Videomontajchi / Motion dizayner' },
    summary: { en: 'Film looks, titles, screen recordings', uz: 'Kino uslubi, titrlar, ekran yozuvlari' },
    bar: { picture: 0.3, video: 0.2 },
    borrows: ['d_dark', 'd_type'],
    concepts: [
      concept('m_green', 'Green screen', 'Yashil ekran', 'any', ['a green screen backdrop', 'a chroma key studio'], { group: TECHNIQUES }),
      concept('m_screen', 'Screen capture', 'Ekran yozuvi', 'video', ['a screen recording', 'a software screen capture'], { group: EDUCATION }),
      concept('m_render', '3D render', '3D render', 'any', ['a 3D render', 'a glossy rendered object']),
      // The shared tag: motion's own entry covers videos; design's (borrowed above) covers pictures.
      concept('d_type', 'Typography', 'Tipografika', 'video', ['animated title text', 'a kinetic typography video'], { group: TECHNIQUES }),
      hand('m_meme', 'Meme', 'Mem', { group: SOCIAL }),
    ],
  },
  thumbnail: {
    id: 'thumbnail', version: 1, role: 'specialist',
    name: { en: 'YouTube thumbnail designer', uz: 'YouTube muqova dizayneri' },
    summary: { en: 'Faces, big text, bold contrast', uz: 'Yuzlar, katta matn, kuchli kontrast' },
    bar: { picture: 0.3, video: 0.2 },
    borrows: ['d_photo'],
    concepts: [
      concept('t_face', 'Face', 'Yuz', 'picture', ['a shocked face', 'a surprised person']),
      concept('t_thumb', 'Thumbnail', 'Muqova', 'picture', ['a youtube thumbnail', 'a clickbait thumbnail'], { aspect: [1.6, 1.95] }),
      // An add-by-hand tag shared with design: entries of one id, no media, never scored.
      hand('d_brand', 'Branding', 'Brending'),
    ],
  },
};

export function basisVec(k, scale = 1) {
  const v = new Float64Array(512);
  v[k] = scale;
  return toBase64(encodeF16(v));
}

export function buildFixture(src) {
  const vecs = new Map(src.concepts.filter((c) => c.suggest !== false).map((c) => [c.id, basisVec(basisOf(src.id, c.id))]));
  return composeBuilt(src, { vecs, minApp: '1.2.3', updatedAt: '2026-11-18', textModel: 'test fixture: basis vectors e_k' });
}

/** A fourth, valid-looking specialist with an id the app doesn't know (it never installs it). */
function promo(o, built = false) {
  o.id = 'promo';
  o.role = 'specialist';
  o.borrows = [];
  o.concepts = [concept('p_banner', 'Banner', 'Banner', 'any', ['a promotional banner', 'an advertising banner'])];
  if (built) o.concepts[0].vec = basisVec(30);
  return o;
}

/** `n` scored motion entries with unique ids, labels and prompts. */
const scoredMany = (n) => Array.from({ length: n }, (_, i) => concept(`m_c${i}`, `Motion ${i}`, `Harakat ${i}`, 'any', [`motion prompt ${i} one`, `motion prompt ${i} two`]));
/** `n` add-by-hand motion entries. */
const handMany = (n) => Array.from({ length: n }, (_, i) => hand(`m_h${i}`, `Hand ${i}`, `Qo‘lda ${i}`));
const at = (o, id) => o.concepts.find((c) => c.id === id);

/**
 * [name, kind, base lens, mutate(obj) → obj, expect level, expect code, target file name?]
 * The fixture replaces the base lens's file, or is added as `file` next to the valid ones.
 */
function cases() {
  const C = [];
  const add = (name, kind, lens, mutate, level, code, file) => C.push({ name, kind, lens, mutate, level, code, file });
  const S = 'source', B = 'built';
  // File level
  add('lens-id-pattern', S, 'motion', (o) => { o.id = 'Motion'; return o; }, 'error', 'lens.id');
  add('lens-filename', S, 'motion', (o) => { o.id = 'motion2'; return o; }, 'error', 'lens.filename');
  add('lens-unknown-id', S, 'motion', (o) => promo(o), 'error', 'lens.unknown_id', 'promo.json');
  add('lens-version-zero', S, 'motion', (o) => { o.version = 0; return o; }, 'error', 'lens.version');
  add('lens-version-float', S, 'motion', (o) => { o.version = 1.5; return o; }, 'error', 'lens.version');
  add('lens-version-too-high', S, 'motion', (o) => { o.version = 100001; return o; }, 'error', 'lens.version');
  add('lens-role-unknown', S, 'motion', (o) => { o.role = 'expert'; return o; }, 'error', 'lens.role');
  add('lens-role-for-id', S, 'motion', (o) => { o.role = 'base'; delete o.borrows; return o; }, 'error', 'lens.role_for_id');
  add('catalogue-two-bases', S, 'motion', (o) => { o.role = 'base'; delete o.borrows; return o; }, 'error', 'catalogue.base');
  add('catalogue-no-base', S, 'design', (o) => { o.role = 'specialist'; return o; }, 'error', 'catalogue.base');
  add('lens-unknown-key', S, 'motion', (o) => { o.notes = 'x'; return o; }, 'error', 'lens.unknown_key');
  add('source-has-build-key', S, 'motion', (o) => { o.format = 2; return o; }, 'error', 'lens.unknown_key');
  add('concept-unknown-key', S, 'motion', (o) => { o.concepts[0].promts = ['x y']; return o; }, 'error', 'concept.unknown_key');
  add('source-has-vec', S, 'motion', (o) => { o.concepts[0].vec = basisVec(10); return o; }, 'error', 'concept.unknown_key');
  // Text fields
  add('name-too-long', S, 'motion', (o) => { o.name.en = 'N'.repeat(49); return o; }, 'error', 'text.length');
  add('summary-too-long', S, 'motion', (o) => { o.summary.uz = 's'.repeat(61); return o; }, 'error', 'text.length');
  add('label-too-long', S, 'motion', (o) => { o.concepts[0].label.en = 'L'.repeat(25); return o; }, 'error', 'text.length');
  add('label-long-warning', S, 'motion', (o) => { o.concepts[0].label.en = 'Green screen xx'; return o; }, 'warning', 'text.label_long');
  add('text-empty', S, 'motion', (o) => { o.concepts[0].label.en = ''; return o; }, 'error', 'text.empty');
  add('text-not-string', S, 'motion', (o) => { o.concepts[0].label.uz = 5; return o; }, 'error', 'text.type');
  add('text-missing-language', S, 'motion', (o) => { delete o.summary.uz; return o; }, 'error', 'text.type');
  add('text-trim', S, 'motion', (o) => { o.concepts[0].label.en = ' Green screen'; return o; }, 'error', 'text.trim');
  add('text-nfc', S, 'motion', (o) => { o.summary.en = 'Café titles'; return o; }, 'error', 'text.nfc');   // e + combining acute: not NFC
  add('text-angle', S, 'motion', (o) => { o.concepts[0].label.en = '<b>Green</b>'; return o; }, 'error', 'text.angle');
  add('text-control-cc', S, 'motion', (o) => { o.concepts[0].label.en = 'Green\u0007screen'; return o; }, 'error', 'text.control');
  add('text-format-cf', S, 'motion', (o) => { o.concepts[0].label.en = 'Green​screen'; return o; }, 'error', 'text.control');   // zero-width space (Cf)
  add('uz-ascii-apostrophe', S, 'design', (o) => { o.concepts[4].label.uz = "Qorong'i"; return o; }, 'error', 'text.uz_apostrophe');
  add('uz-backtick', S, 'design', (o) => { o.concepts[4].label.uz = 'Qorong`i'; return o; }, 'error', 'text.uz_apostrophe');
  add('uz-modifier-turned-comma', S, 'design', (o) => { o.concepts[4].label.uz = 'Qorongʻi'; return o; }, 'error', 'text.uz_apostrophe');
  add('uz-modifier-apostrophe', S, 'design', (o) => { o.concepts[4].label.uz = 'Maʼlumot'; return o; }, 'error', 'text.uz_apostrophe');
  // Group (§0c): optional {en, uz}, text rules apply
  add('group-not-object', S, 'motion', (o) => { o.concepts[0].group = 'Techniques'; return o; }, 'error', 'text.pair');
  add('group-too-long', S, 'motion', (o) => { o.concepts[0].group = { en: 'G'.repeat(25), uz: 'Usullar' }; return o; }, 'error', 'text.length');
  add('group-uz-apostrophe', S, 'motion', (o) => { o.concepts[1].group = { en: 'Education', uz: "Ta'lim" }; return o; }, 'error', 'text.uz_apostrophe');
  add('group-missing-language', S, 'motion', (o) => { o.concepts[0].group = { en: 'Techniques' }; return o; }, 'error', 'text.type');
  // Concepts
  add('concept-id-pattern', S, 'motion', (o) => { o.concepts[0].id = 'Green-Screen'; return o; }, 'error', 'concept.id');
  add('concept-dup-in-lens', S, 'motion', (o) => { o.concepts[1].id = 'm_green'; return o; }, 'error', 'dup.concept_id');
  add('shared-twice-in-one-lens', S, 'motion', (o) => {
    // A lens has one entry per tag, even for other media.
    o.concepts.push(concept('d_type', 'Typography', 'Tipografika', 'picture', ['a lettering poster', 'a typeface poster']));
    o.borrows = ['d_dark'];
    return o;
  }, 'error', 'dup.concept_id');
  add('concepts-none', S, 'motion', (o) => { o.concepts = []; o.borrows = []; return o; }, 'error', 'lens.concept_count');
  add('scored-81', S, 'motion', (o) => { o.concepts = scoredMany(81); o.borrows = []; return o; }, 'error', 'lens.scored_count');
  add('entries-121', S, 'motion', (o) => { o.concepts = [...scoredMany(80), ...handMany(41)]; o.borrows = []; return o; }, 'error', 'lens.concept_count');
  add('lens-no-scored-warning', S, 'thumbnail', (o) => { o.concepts = [hand('t_face', 'Face', 'Yuz'), hand('d_brand', 'Branding', 'Brending')]; return o; }, 'warning', 'lens.no_scored');
  add('prompts-one', S, 'motion', (o) => { o.concepts[0].prompts = ['a green screen backdrop']; return o; }, 'error', 'concept.prompt_count');
  add('prompts-nine', S, 'motion', (o) => { o.concepts[0].prompts = Array.from({ length: 9 }, (_, i) => `green screen take ${i}`); return o; }, 'error', 'concept.prompt_count');
  add('prompts-five-warning', S, 'motion', (o) => { o.concepts[0].prompts = Array.from({ length: 5 }, (_, i) => `green screen take ${i}`); return o; }, 'warning', 'concept.prompt_many');
  add('prompt-nine-words', S, 'motion', (o) => { o.concepts[0].prompts[0] = 'one two three four five six seven eight nine'; return o; }, 'error', 'concept.prompt_words');
  add('prompt-seven-words-warning', S, 'motion', (o) => { o.concepts[0].prompts[0] = 'a person standing in front of greenery'; return o; }, 'warning', 'concept.prompt_long');
  add('prompt-empty', S, 'motion', (o) => { o.concepts[0].prompts[0] = '   '; return o; }, 'error', 'concept.prompt_type');
  add('prompt-trim', S, 'motion', (o) => { o.concepts[0].prompts[0] = 'a green screen backdrop '; return o; }, 'error', 'concept.prompt_trim');
  add('prompt-braces', S, 'motion', (o) => { o.concepts[0].prompts[0] = 'a {p} backdrop'; return o; }, 'error', 'concept.prompt_chars');
  add('prompt-dup-across-lenses', S, 'motion', (o) => { o.concepts[0].prompts[0] = 'A  Printed poster'; return o; }, 'error', 'dup.prompt');
  add('prompt-dup-in-concept', S, 'motion', (o) => { o.concepts[0].prompts[1] = o.concepts[0].prompts[0]; return o; }, 'error', 'dup.prompt');
  add('prompt-dup-shared-tag', S, 'motion', (o) => { at(o, 'd_type').prompts[0] = 'a font specimen'; return o; }, 'error', 'dup.prompt');
  add('prompt-too-many-chars', S, 'motion', (o) => { o.concepts[0].prompts[0] = Array.from({ length: 8 }, () => 'x'.repeat(23)).join(' '); return o; }, 'error', 'concept.prompt_length');
  // 8 words, 138 characters with the template, but 119 CLIP tokens (digits split every letter).
  add('prompt-too-many-tokens', S, 'motion', (o) => { o.concepts[0].prompts[0] = Array.from({ length: 8 }, () => 'q1z9x8k7w6v5j4').join(' '); return o; }, 'error', 'concept.prompt_tokens');
  // Labels (§0c: unique per language except entries of one id; an EN label is never another tag's UZ label)
  add('label-dup-en', S, 'motion', (o) => { o.concepts[0].label.en = 'POSTER'; return o; }, 'error', 'dup.label');
  add('label-dup-uz', S, 'motion', (o) => { o.concepts[0].label.uz = 'afisha'; return o; }, 'error', 'dup.label');
  add('label-dup-apostrophe', S, 'motion', (o) => { at(o, 'm_render').label.uz = 'Qorong’i'; return o; }, 'error', 'dup.label');
  add('label-cross-language', S, 'motion', (o) => { o.concepts[0].label.en = 'Afisha'; return o; }, 'error', 'dup.label_cross');
  // Shared tags (§0c)
  add('shared-label-differs', S, 'motion', (o) => { at(o, 'd_type').label.en = 'Type'; return o; }, 'error', 'shared.label');
  add('shared-label-uz-differs', S, 'thumbnail', (o) => { at(o, 'd_brand').label.uz = 'Brend'; return o; }, 'error', 'shared.label');
  add('shared-group-differs', S, 'design', (o) => { at(o, 'd_type').group = { en: 'Lettering', uz: 'Harflar' }; return o; }, 'error', 'shared.group');
  add('shared-media-overlap-pictures', S, 'thumbnail', (o) => {
    o.concepts.push(concept('d_logo', 'Logo', 'Logotip', 'picture', ['a logo on a thumbnail', 'a channel logo badge']));
    return o;
  }, 'error', 'shared.media_overlap');
  add('shared-media-overlap-videos', S, 'thumbnail', (o) => {
    o.concepts.push(concept('d_type', 'Typography', 'Tipografika', 'video', ['bold thumbnail lettering', 'a text heavy thumbnail']));
    return o;
  }, 'error', 'shared.media_overlap');
  add('shared-id-label-and-media', S, 'motion', (o) => { o.concepts[0].id = 'd_poster'; return o; }, 'error', 'shared.label');
  // Add-by-hand entries (§0c): no prompts, vec, media or aspect; suggest is a boolean
  add('hand-has-prompts', S, 'design', (o) => { at(o, 'd_brand').prompts = ['a brand identity', 'a brand book']; return o; }, 'error', 'concept.hand_field');
  add('hand-has-media', S, 'design', (o) => { at(o, 'd_brand').media = 'picture'; return o; }, 'error', 'concept.hand_field');
  add('hand-has-aspect', S, 'design', (o) => { at(o, 'd_brand').aspect = [1, 2]; return o; }, 'error', 'concept.hand_field');
  add('suggest-not-boolean', S, 'motion', (o) => { o.concepts[0].suggest = 'no'; return o; }, 'error', 'concept.suggest');
  add('media-unknown', S, 'motion', (o) => { o.concepts[0].media = 'image'; return o; }, 'error', 'concept.media');
  add('media-missing', S, 'motion', (o) => { delete o.concepts[0].media; return o; }, 'error', 'concept.media');
  add('aspect-reversed', S, 'thumbnail', (o) => { o.concepts[1].aspect = [1.95, 1.6]; return o; }, 'error', 'concept.aspect');
  add('aspect-zero', S, 'thumbnail', (o) => { o.concepts[1].aspect = [0, 1.6]; return o; }, 'error', 'concept.aspect');
  add('aspect-one-value', S, 'thumbnail', (o) => { o.concepts[1].aspect = [1.6]; return o; }, 'error', 'concept.aspect');
  add('about-not-text', S, 'motion', (o) => { o.concepts[0].about = { en: 5 }; return o; }, 'error', 'concept.about');
  // Borrows + bar
  add('borrows-unknown', S, 'motion', (o) => { o.borrows = ['d_nope']; return o; }, 'error', 'borrows.unknown');
  add('borrows-own-concept', S, 'motion', (o) => { o.borrows = ['m_green']; return o; }, 'error', 'borrows.unknown');
  add('borrows-by-base', S, 'design', (o) => { o.borrows = ['d_logo']; return o; }, 'error', 'lens.borrows');
  add('borrows-twice', S, 'motion', (o) => { o.borrows = ['d_dark', 'd_dark']; return o; }, 'error', 'lens.borrows');
  add('borrow-own-overlap', S, 'motion', (o) => { at(o, 'd_type').media = 'any'; return o; }, 'error', 'borrows.overlap');
  add('borrows-hand-warning', S, 'thumbnail', (o) => { o.borrows = ['d_photo', 'd_brand']; return o; }, 'warning', 'borrows.hand');
  add('bar-too-low', S, 'motion', (o) => { o.bar.picture = 0.04; return o; }, 'error', 'lens.bar');
  add('bar-too-high', S, 'motion', (o) => { o.bar.video = 0.96; return o; }, 'error', 'lens.bar');
  add('bar-missing', S, 'motion', (o) => { delete o.bar; return o; }, 'error', 'lens.bar');
  // Built files
  add('built-format', B, 'motion', (o) => { o.format = 1; return o; }, 'error', 'built.format');
  add('built-model', B, 'motion', (o) => { o.model = 'clip-b16'; return o; }, 'error', 'built.model');
  add('built-template', B, 'motion', (o) => { o.template = 'This is a photo'; return o; }, 'error', 'built.template');
  add('built-min-app', B, 'motion', (o) => { o.min_app = '1.2'; return o; }, 'error', 'built.min_app');
  add('built-updated-at', B, 'motion', (o) => { o.updated_at = '18.11.2026'; return o; }, 'error', 'built.updated_at');
  add('built-text-model', B, 'motion', (o) => { o.text_model = ''; return o; }, 'error', 'built.text_model');
  add('built-placeholder-warning', B, 'motion', (o) => { o.placeholder = true; return o; }, 'warning', 'built.placeholder');
  add('built-unknown-id', B, 'motion', (o) => promo(o, true), 'error', 'lens.unknown_id', 'qooti-lens-promo.json');
  add('built-version-too-high', B, 'motion', (o) => { o.version = 100001; return o; }, 'error', 'lens.version');
  add('built-same-version', B, 'motion', (o) => { o.concepts[0].label.en = 'Green screens'; return o; }, 'error', 'built.same_version');
  add('built-hand-has-vec', B, 'design', (o) => { at(o, 'd_brand').vec = basisVec(30); return o; }, 'error', 'concept.hand_field');
  add('built-shared-media-overlap', B, 'motion', (o) => { at(o, 'd_type').media = 'picture'; return o; }, 'error', 'shared.media_overlap');
  add('vec-not-base64', B, 'motion', (o) => { o.concepts[0].vec = 'not base64!'; return o; }, 'error', 'vec.base64');
  add('vec-511-values', B, 'motion', (o) => { o.concepts[0].vec = toBase64(encodeF16(new Float64Array(511).fill(1 / Math.sqrt(511)))); return o; }, 'error', 'vec.length');
  add('vec-nan', B, 'motion', (o) => { const v = new Float64Array(512); v[10] = 1; v[3] = NaN; o.concepts[0].vec = toBase64(encodeF16(v)); return o; }, 'error', 'vec.finite');
  add('vec-infinity', B, 'motion', (o) => { const v = new Float64Array(512); v[10] = 1; v[3] = 1e6; o.concepts[0].vec = toBase64(encodeF16(v)); return o; }, 'error', 'vec.finite');
  add('vec-norm-low', B, 'motion', (o) => { o.concepts[0].vec = basisVec(10, 0.97); return o; }, 'error', 'vec.norm');
  add('vec-norm-high', B, 'motion', (o) => { o.concepts[0].vec = basisVec(10, 1.03); return o; }, 'error', 'vec.norm');
  add('vec-missing', B, 'motion', (o) => { delete o.concepts[0].vec; return o; }, 'error', 'vec.base64');
  add('built-borrows-unknown', B, 'thumbnail', (o) => { o.borrows = ['d_nope']; return o; }, 'error', 'borrows.unknown');
  return C;
}

/**
 * Hand-written test vectors for the shared-tag model, on the valid built fixtures (every scored
 * entry is a basis vector e_k, see `basis`). An item vector is given as {basis key: weight}: put
 * the weights on those indices of a 512-vector, then L2-normalise it. Scores are compared with a
 * tolerance of 1e-3 (the app's f32 vectors and 4-decimal storage give slightly different digits).
 */
export const SHARED_TAG_VECTORS = {
  about: 'Inputs → expected outputs of the §0c shared-tag model. Lenses: valid/built/qooti-lens-{design,motion,thumbnail}.json (bars 0.30 pictures / 0.20 videos). Item vectors: {basis key: weight} on a 512-vector, then L2-normalised. Scores within 1e-3.',
  lenses: ['valid/built/qooti-lens-design.json', 'valid/built/qooti-lens-motion.json', 'valid/built/qooti-lens-thumbnail.json'],
  scoring: [
    { name: 'design scores the shared tag d_type on pictures; motion\'s picture pool only sees it as "something else"',
      item: { kind: 'picture', aspect: 1, vector: { d_type: 1 } },
      expect: { rule: 'picture', byLens: { design: [['d_type', 1]], motion: [], thumbnail: [] } } },
    { name: 'motion\'s video entry of d_type never reaches pictures',
      item: { kind: 'picture', aspect: 1, vector: { 'motion/d_type': 1 } },
      expect: { rule: 'picture', byLens: { design: [], motion: [], thumbnail: [] } } },
    { name: 'motion scores d_type on videos (video rule); design decides its own entries there',
      item: { kind: 'video', aspect: 1, duration: 12, frames: { count: 8, vector: { 'motion/d_type': 1, d_dark: 0.2 } } },
      expect: { rule: 'video', byLens: { design: [['d_dark', 1]], motion: [['d_type', 1]], thumbnail: [] } } },
    { name: 'design\'s picture-only entry is in no video pool',
      item: { kind: 'video', aspect: 1, duration: 12, frames: { count: 8, vector: { d_type: 1, d_dark: 0.2 } } },
      expect: { rule: 'video', byLens: { design: [['d_dark', 1]], motion: [], thumbnail: [] } } },
    { name: 'a video with one frame uses the picture rule over the VIDEO pools',
      item: { kind: 'video', aspect: 1, duration: 12, frames: { count: 1, vector: { 'motion/d_type': 1 } } },
      expect: { rule: 'frame1', byLens: { design: [], motion: [['d_type', 1]], thumbnail: [] } } },
    { name: 'failed frames (n = 0): the cover, scored with the VIDEO pools',
      item: { kind: 'video', aspect: 1, duration: 12, frames: { count: 0 }, cover: { 'motion/d_type': 1 } },
      expect: { rule: 'cover', byLens: { design: [], motion: [['d_type', 1]], thumbnail: [] } } },
    { name: 'a cover in design\'s picture direction finds nothing on a video',
      item: { kind: 'video', aspect: 1, duration: 12, frames: { count: 0 }, cover: { d_type: 1 } },
      expect: { rule: 'cover', byLens: { design: [], motion: [], thumbnail: [] } } },
    { name: 'base entries split a specialist pool: the anchor d_type takes half of motion\'s picture pool',
      item: { kind: 'picture', aspect: 1, vector: { d_type: 1, m_green: 1 } },
      expect: { rule: 'picture', byLens: { design: [['d_type', 1]], motion: [['m_green', 0.5]], thumbnail: [] } } },
    { name: 'thumbnail covers no video: its video pool suggests nothing',
      item: { kind: 'video', aspect: 1.78, duration: 12, frames: { count: 8, vector: { t_face: 1, d_logo: 0.3 } } },
      expect: { rule: 'video', byLens: { design: [['d_logo', 1]], motion: [], thumbnail: [] } },
      note: 'thumbnail\'s t_face entry is picture-only, so no video pool holds it; design\'s d_logo wins every frame (in motion\'s pool too, as an anchor, so motion gets no vote). Avoid vectors where a pool is exactly uniform: eight additions of 1/5 give a mean of 0.19999999999999998, just under a 0.20 bar.' },
  ],
  display: [
    { name: 'motion on, picture: borrowed tags whose design entry covers pictures, plus own entries covering pictures',
      kind: 'picture', enabled: ['motion'], scores: { d_type: 0.6, d_dark: 0.5, m_green: 0.4, d_poster: 0.8, t_face: 0.7 },
      expect: [['d_type', 'motion', 'borrow'], ['d_dark', 'motion', 'borrow'], ['m_green', 'motion', 'own']] },
    { name: 'design on, picture',
      kind: 'picture', enabled: ['design'], scores: { d_type: 0.6, d_dark: 0.5, m_green: 0.4, d_poster: 0.8, t_face: 0.7 },
      expect: [['d_poster', 'design', 'own'], ['d_type', 'design', 'own'], ['d_dark', 'design', 'own']] },
    { name: 'thumbnail on, picture: d_type is not borrowed by thumbnail',
      kind: 'picture', enabled: ['thumbnail'], scores: { t_face: 0.7, d_photo: 0.3, d_type: 0.6 },
      expect: [['t_face', 'thumbnail', 'own'], ['d_photo', 'thumbnail', 'borrow']] },
    { name: 'motion + design on, picture: a key ranks with the FIRST lens that shows it, so motion\'s borrows come before design\'s own',
      kind: 'picture', enabled: ['design', 'motion'], scores: { d_type: 0.6, d_dark: 0.5, m_green: 0.4, d_poster: 0.8 },
      expect: [['d_type', 'motion', 'borrow'], ['d_dark', 'motion', 'borrow'], ['m_green', 'motion', 'own']] },
    { name: 'all three on, picture: d_photo is shown by thumbnail (borrow) before design; col: hints last',
      kind: 'picture', enabled: ['motion', 'thumbnail', 'design'], colTags: ['7'], scores: { d_type: 0.6, t_face: 0.7, d_photo: 0.9, d_poster: 0.8, 'col:7': 0.95 },
      expect: [['d_type', 'motion', 'borrow'], ['d_photo', 'thumbnail', 'borrow'], ['t_face', 'thumbnail', 'own']] },
    { name: 'motion on, video: motion\'s own d_type entry covers videos; at most 2 on a video',
      kind: 'video', enabled: ['motion'], scores: { d_type: 0.6, m_screen: 0.5, d_dark: 0.7 },
      expect: [['d_dark', 'motion', 'borrow'], ['d_type', 'motion', 'own']] },
    { name: 'design on, video: design\'s d_type entry covers pictures only, so d_type is hidden',
      kind: 'video', enabled: ['design'], scores: { d_type: 0.6, d_poster: 0.5, d_dark: 0.4 },
      expect: [['d_poster', 'design', 'own'], ['d_dark', 'design', 'own']] },
    { name: 'thumbnail on, video: its picture-only entries are hidden; a borrowed tag whose design entry covers videos shows',
      kind: 'video', enabled: ['thumbnail'], scores: { t_face: 0.9, d_photo: 0.8 },
      expect: [['d_photo', 'thumbnail', 'borrow']] },
    { name: 'add-by-hand tags, unknown keys and a video-only entry on a picture never show',
      kind: 'picture', enabled: ['motion', 'thumbnail', 'design'], scores: { d_brand: 0.99, m_meme: 0.98, ghost: 0.97, m_screen: 0.96 },
      expect: [] },
    { name: 'suggestions off: nothing shows',
      kind: 'picture', enabled: ['motion'], on: false, scores: { m_green: 0.9 },
      expect: [] },
    { name: 'equal rank and score: by key',
      kind: 'picture', enabled: ['motion'], scores: { m_render: 0.5, m_green: 0.5 },
      expect: [['m_green', 'motion', 'own'], ['m_render', 'motion', 'own']] },
    { name: 'col: hints show only while their tag exists, after every lens key',
      kind: 'picture', enabled: ['design'], colTags: ['7'], scores: { 'col:7': 0.9, 'col:8': 0.95, d_logo: 0.1 },
      expect: [['d_logo', 'design', 'own'], ['col:7', null, 'col']] },
  ],
  picker: [
    { enabled: ['motion'], expect: ['m_green', 'm_screen', 'm_render', 'd_type', 'm_meme', 'd_dark'] },
    { enabled: ['design'], expect: ['d_poster', 'd_logo', 'd_photo', 'd_story', 'd_dark', 'd_type', 'd_brand'] },
    { enabled: ['thumbnail'], expect: ['t_face', 't_thumb', 'd_brand', 'd_photo'] },
    { enabled: ['thumbnail', 'motion'], expect: ['m_green', 'm_screen', 'm_render', 'd_type', 'm_meme', 'd_dark', 't_face', 't_thumb', 'd_brand', 'd_photo'] },
    { enabled: [], expect: [] },
  ],
  signature: [
    { installed: [{ id: 'thumbnail', sha256: 'cc' }, { id: 'design', sha256: 'aa' }, { id: 'motion', sha256: 'bb' }], maxvid: 60,
      text: 'lens-score-4|clip-b32-q8|maxvid=60|design@aa,motion@bb,thumbnail@cc' },
  ],
};

function main() {
  const valid = path.join(here, 'valid');
  const invalid = path.join(here, 'invalid');
  fs.rmSync(valid, { recursive: true, force: true });
  fs.rmSync(invalid, { recursive: true, force: true });
  fs.mkdirSync(path.join(valid, 'src'), { recursive: true });
  fs.mkdirSync(path.join(valid, 'built'), { recursive: true });
  fs.mkdirSync(invalid, { recursive: true });
  for (const [id, src] of Object.entries(SOURCES)) {
    fs.writeFileSync(path.join(valid, 'src', `${id}.json`), serialize(src));
    fs.writeFileSync(path.join(valid, 'built', `qooti-lens-${id}.json`), serialize(buildFixture(src)));
  }
  const manifest = [];
  for (const c of cases()) {
    const base = c.kind === 'source' ? clone(SOURCES[c.lens]) : buildFixture(SOURCES[c.lens]);
    const obj = c.mutate(base);
    const file = `${c.name}.json`;
    fs.writeFileSync(path.join(invalid, file), serialize(obj));
    manifest.push({ name: c.name, kind: c.kind, file, target: c.file || (c.kind === 'source' ? `${c.lens}.json` : `qooti-lens-${c.lens}.json`), expect: { level: c.level, code: c.code } });
  }
  fs.writeFileSync(path.join(invalid, 'cases.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  const entries = Object.values(SOURCES).flatMap((l) => l.concepts.map((c) => (c.suggest === false
    ? { lens: l.id, id: c.id, suggest: false }
    : { lens: l.id, id: c.id, media: c.media, ...(c.aspect ? { aspect: c.aspect } : {}), basis: basisOf(l.id, c.id) })));
  const basis = Object.fromEntries(Object.entries(BASIS));
  fs.writeFileSync(path.join(here, 'shared-tag-vectors.json'), `${JSON.stringify({ ...SHARED_TAG_VECTORS, basis, entries, borrows: Object.fromEntries(Object.values(SOURCES).filter((l) => l.borrows).map((l) => [l.id, l.borrows])) }, null, 1)}\n`);
  console.log(`fixtures: 3 valid sources, 3 valid built files, ${manifest.length} invalid cases, ${SHARED_TAG_VECTORS.scoring.length + SHARED_TAG_VECTORS.display.length + SHARED_TAG_VECTORS.picker.length} shared-tag vectors`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
