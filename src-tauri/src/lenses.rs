// Tag lens files (spec: qooti 2.0/MD/qooti-tag-lens-spec.md §2–§4 and §6.1).
//
// A lens is one downloadable tag list of entries. Each scored entry carries its CLIP text vector,
// computed once when the lens is built (scripts/lenses/build.mjs), so the app never embeds text.
// One tag (one concept id, one name) may have an entry in several lenses, each for its own media;
// an add-by-hand entry ("suggest": false) is never scored (spec §0c). This module parses and
// validates lens files (the same rules as scripts/lenses/check.mjs), installs a set of files
// all-or-nothing, keeps the three lenses that ship inside the app current, and holds the parsed
// lenses in memory for the scorer (tagging.rs).
//
// Tables (ensure_schema: from db::migrate and at every start):
//   lenses           one row per installed lens: the file itself, the previous file, on/off
//   concepts         one row per concept id ever installed: its labels, its primary lens and
//                    whether an installed lens has it. Rows are never deleted, so the label of a
//                    concept tag always resolves, even after a lens update drops the concept.
//   concept_entries  one row per (concept id, lens id) of the installed lenses, rebuilt from them
//   tag_answers      what the user said about a suggestion on an item (added / dismissed)
// plus tags.concept_id, inspirations.auto_tag_sig, inspirations.lens_suggestions (the scorer's
// suggestions per item; tagging.rs) and clip_frames (clip.rs).

use std::collections::{HashMap, HashSet};
use std::ops::RangeInclusive;
use std::sync::{Arc, RwLock};

use base64::Engine;
use once_cell::sync::OnceCell;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

pub const FORMAT: i64 = 2;
/// Lens vectors live in the same space as the picture vectors clip.rs stores.
pub const MODEL: &str = crate::clip::MODEL_TAG;
pub const DIM: usize = crate::clip::DIM;
pub const MAX_FILE_BYTES: usize = 256 * 1024;
/// One catalogue install takes at most this many files, together at most 768 KB (spec §0b.5).
pub const MAX_UPLOAD_FILES: usize = 3;
pub const MAX_UPLOAD_BYTES: usize = MAX_UPLOAD_FILES * MAX_FILE_BYTES;
/// The highest lens version a file may have, so one bad file can't block every later update.
pub const MAX_VERSION: i64 = 100_000;
/// The fixed order lenses are shown in everywhere (owner decision 0.2). Never a weight. Also
/// the only lenses the catalogue may install (spec §0b.5).
pub const LENS_ORDER: [&str; 3] = ["motion", "design", "thumbnail"];

/// The role each of the three lenses must have: `design` is the base, the others are
/// specialists (spec §2.1). None for any other id.
pub fn required_role(id: &str) -> Option<Role> {
    match id {
        "design" => Some(Role::Base),
        "motion" | "thumbnail" => Some(Role::Specialist),
        _ => None,
    }
}
pub const DEFAULT_BAR_PICTURE: f64 = 0.30;
pub const DEFAULT_BAR_VIDEO: f64 = 0.20;

/// Entries per lens, add-by-hand ones included (spec §0c).
const MAX_ENTRIES: usize = 120;
/// Scored entries per lens.
const MAX_SCORED: usize = 80;
const LABEL_MAX: usize = 24;
const GROUP_MAX: usize = 24;
const NAME_MAX: usize = 48;
const SUMMARY_MAX: usize = 60;
const PROMPTS_PER_CONCEPT: RangeInclusive<usize> = 2..=8;
const WORDS_PER_PROMPT: RangeInclusive<usize> = 1..=8;
/// Rust's stand-in for "fits 77 CLIP tokens" (the Node checker uses the real tokenizer).
const PROMPT_CHARS_MAX: usize = 200;
const BAR_RANGE: RangeInclusive<f64> = 0.05..=0.95;
const NORM_RANGE: RangeInclusive<f64> = 0.98..=1.02;

/// The lenses built into this app version (written by scripts/lenses/build.mjs).
pub const BUNDLED: [(&str, &str); 3] = [
    ("motion",    include_str!("../lenses/qooti-lens-motion.json")),
    ("design",    include_str!("../lenses/qooti-lens-design.json")),
    ("thumbnail", include_str!("../lenses/qooti-lens-thumbnail.json")),
];

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct I18n {
    pub en: String,
    pub uz: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role { Base, Specialist }

impl Role {
    pub fn as_str(self) -> &'static str {
        match self { Role::Base => "base", Role::Specialist => "specialist" }
    }
}

/// A concept's `media`, and an item's media kind (`Picture` for images/GIFs, `Video` for videos).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Media { Any, Picture, Video }

impl Media {
    pub fn as_str(self) -> &'static str {
        match self { Media::Any => "any", Media::Picture => "picture", Media::Video => "video" }
    }
    /// A concept may be suggested for an item of kind `m` when its media is `any` or `m`.
    pub fn eligible_for(self, m: Media) -> bool { self == Media::Any || self == m }
}

/// One entry of one lens (spec §0c): the lens's description of a tag. Entries of one concept id in
/// other lenses carry the same labels and cover other media.
#[derive(Clone, Debug)]
pub struct Concept {
    pub id: String,
    pub lens_id: String,
    pub label: I18n,
    /// The owner's heading; carried, not shown yet.
    pub group: Option<I18n>,
    /// False for an add-by-hand entry ("suggest": false): in the picker and search, never scored.
    pub suggest: bool,
    /// Meaningful only when `suggest` (Media::Any otherwise): ask `covers`.
    pub media: Media,
    /// Width/height range (inclusive) the item's aspect ratio must fall in.
    pub aspect: Option<(f64, f64)>,
    /// Empty for an add-by-hand entry.
    pub prompts: Vec<String>,
    /// L2-normalised CLIP text vector (f16 in the file; renormalised after decoding). Empty for an
    /// add-by-hand entry.
    pub vec: Vec<f32>,
}

impl Concept {
    /// The entry takes part in scoring items of media `m`: scored, with media `any` or `m`.
    pub fn covers(&self, m: Media) -> bool { self.suggest && self.media.eligible_for(m) }
}

#[derive(Clone, Debug)]
pub struct Lens {
    pub id: String,
    pub version: i64,
    pub role: Role,
    pub name: I18n,
    pub summary: I18n,
    pub bar_picture: f64,
    pub bar_video: f64,
    pub borrows: Vec<String>,
    pub concepts: Vec<Concept>,
    pub template: Option<String>,
    pub min_app: Option<String>,
    /// A stand-in bundled while the real lens wasn't built yet. Never scored; only accepted
    /// from the app itself, never from the catalogue.
    pub placeholder: bool,
    /// Lower-case hex SHA-256 of the file text.
    pub sha256: String,
}

#[derive(Deserialize)]
struct RawBar {
    #[serde(default)] picture: Option<f64>,
    #[serde(default)] video: Option<f64>,
}

#[derive(Deserialize)]
struct RawConcept {
    id: String,
    label: I18n,
    #[serde(default)] group: Option<I18n>,
    #[serde(default)] suggest: Option<bool>,
    #[serde(default)] prompts: Option<Vec<String>>,
    #[serde(default)] media: Option<String>,
    #[serde(default)] aspect: Option<Vec<f64>>,
    #[serde(default)] vec: Option<String>,
}

/// An integer, also when written as a whole JSON number like `1.0` (Number.isInteger in the Node checker).
fn de_int<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let n = serde_json::Number::deserialize(d)?;
    n.as_i64()
        .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15).map(|f| f as i64))
        .ok_or_else(|| serde::de::Error::custom("expected an integer"))
}

#[derive(Deserialize)]
struct RawLens {
    #[serde(deserialize_with = "de_int")]
    format: i64,
    id: String,
    #[serde(deserialize_with = "de_int")]
    version: i64,
    role: String,
    name: I18n,
    summary: I18n,
    #[serde(default)] bar: Option<RawBar>,
    #[serde(default)] borrows: Vec<String>,
    concepts: Vec<RawConcept>,
    model: String,
    #[serde(default)] template: Option<String>,
    #[serde(default)] min_app: Option<String>,
    #[serde(default)] placeholder: Option<bool>,
}

// ── Validation (spec §2.3) ────────────────────────────────────────────────────

/// `^[a-z][a-z0-9_]{1,max_rest}$`
fn valid_id(s: &str, max_rest: usize) -> bool {
    let b = s.as_bytes();
    (2..=max_rest + 1).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}
pub fn valid_lens_id(s: &str) -> bool { valid_id(s, 31) }
pub fn valid_concept_id(s: &str) -> bool { valid_id(s, 39) }

/// Unicode general category Cf (format characters).
fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// Characters NFC never keeps as they are: combining marks (they belong composed with the letter
/// before them), conjoining Hangul jamo, and the singletons / composition exclusions NFC replaces.
/// Exact for Latin and Cyrillic text — what lens labels use; the Node checker runs the full
/// `normalize('NFC')` comparison.
fn breaks_nfc(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0483..=0x0489 | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF
        | 0xFE20..=0xFE2F | 0x3099..=0x309A
        | 0x1100..=0x11FF | 0xA960..=0xA97F | 0xD7B0..=0xD7FF
        | 0x0374 | 0x037E | 0x0387 | 0x1F71 | 0x1F73 | 0x1F75 | 0x1F77 | 0x1F79 | 0x1F7B | 0x1F7D
        | 0x1FBB | 0x1FBE | 0x1FC9 | 0x1FCB | 0x1FD3 | 0x1FDB | 0x1FE3 | 0x1FEB | 0x1FEE | 0x1FEF
        | 0x1FF9 | 0x1FFB | 0x1FFD | 0x2000 | 0x2001 | 0x2126 | 0x212A | 0x212B | 0x2329 | 0x232A
        | 0x0958..=0x095F | 0x09DC | 0x09DD | 0x09DF | 0x0A33 | 0x0A36 | 0x0A59..=0x0A5B | 0x0A5E
        | 0x0B5C | 0x0B5D | 0x0F43 | 0x0F4D | 0x0F52 | 0x0F57 | 0x0F5C | 0x0F69 | 0x0F73
        | 0x0F75..=0x0F79 | 0x0F81 | 0x0F93 | 0x0F9D | 0x0FA2 | 0x0FA7 | 0x0FAC | 0x0FB9
        | 0x2ADC | 0xF900..=0xFAFF | 0xFB1D | 0xFB1F | 0xFB2A..=0xFB36 | 0xFB38..=0xFB3C | 0xFB3E
        | 0xFB40 | 0xFB41 | 0xFB43 | 0xFB44 | 0xFB46..=0xFB4E | 0x1D15E..=0x1D164
        | 0x1D1BB..=0x1D1C0 | 0x2F800..=0x2FA1F)
}

/// name / summary / label text, in one language.
fn check_text(what: &str, s: &str, max: usize, uzbek: bool) -> Result<(), String> {
    if s.is_empty() || s.trim() != s {
        return Err(format!("{what}: must be non-empty, without spaces at either end"));
    }
    let n = s.chars().count();
    if n > max { return Err(format!("{what}: {n} characters (at most {max})")); }
    if s.contains('<') || s.contains('>') { return Err(format!("{what}: contains < or >")); }
    // Shown as it is: a word with an underscore reads as an internal id (check.mjs text.underscore)
    if s.contains('_') { return Err(format!("{what}: contains _")); }
    if let Some(c) = s.chars().find(|&c| c.is_control() || is_format_char(c)) {
        return Err(format!("{what}: contains the control/format character U+{:04X}", c as u32));
    }
    if let Some(c) = s.chars().find(|&c| breaks_nfc(c)) {
        return Err(format!("{what}: not NFC (U+{:04X})", c as u32));
    }
    if uzbek {
        if let Some(c) = s.chars().find(|c| matches!(c, '\'' | '`' | '\u{02BB}' | '\u{02BC}')) {
            return Err(format!("{what}: Uzbek text uses U+{:04X}; write o‘/g‘ with U+2018 and the tutuq with U+2019", c as u32));
        }
    }
    Ok(())
}

fn check_i18n(what: &str, t: &I18n, max: usize) -> Result<(), String> {
    check_text(&format!("{what} (en)"), &t.en, max, false)?;
    check_text(&format!("{what} (uz)"), &t.uz, max, true)
}

/// "1.2.3" (an optional "-pre" / "+build" suffix is ignored).
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.split(|c| c == '-' || c == '+').next()?;
    let mut it = core.split('.').map(|p| if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) { None } else { p.parse::<u64>().ok() });
    let v = (it.next()??, it.next()??, it.next()??);
    if it.next().is_some() { return None; }
    Some(v)
}

pub fn sha256_hex(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }

/// Parse and validate one lens file (every per-file rule of spec §2.3 and §0c). The rules that need
/// the whole set of lenses (one base, shared tags, labels/prompts unique across lenses, `borrows`)
/// are checked by `install`. `allow_placeholder` is true only for the files bundled in the app.
pub fn parse_lens(text: &str, allow_placeholder: bool) -> Result<Lens, String> {
    if text.len() > MAX_FILE_BYTES {
        return Err(format!("file is {} bytes (at most {MAX_FILE_BYTES})", text.len()));
    }
    let raw: RawLens = serde_json::from_str(text).map_err(|e| format!("not a lens file: {e}"))?;
    if raw.format != FORMAT { return Err(format!("format {} (want {FORMAT})", raw.format)); }
    if !valid_lens_id(&raw.id) { return Err(format!("bad lens id '{}'", raw.id)); }
    let lid = raw.id.clone();
    if raw.version < 1 || raw.version > MAX_VERSION {
        return Err(format!("{lid}: version {} (1–{MAX_VERSION})", raw.version));
    }
    let role = match raw.role.as_str() {
        "base" => Role::Base,
        "specialist" => Role::Specialist,
        r => return Err(format!("{lid}: role '{r}' (base or specialist)")),
    };
    if let Some(want) = required_role(&lid).filter(|want| *want != role) {
        return Err(format!("{lid}: role '{}' (this lens is the {} lens)", raw.role, want.as_str()));
    }
    if raw.model != MODEL { return Err(format!("{lid}: model '{}' (want {MODEL})", raw.model)); }
    let placeholder = raw.placeholder.unwrap_or(false);
    if placeholder && !allow_placeholder {
        return Err(format!("{lid}: placeholder lenses only come with the app"));
    }
    check_i18n(&format!("{lid} name"), &raw.name, NAME_MAX)?;
    check_i18n(&format!("{lid} summary"), &raw.summary, SUMMARY_MAX)?;

    let (bar_picture, bar_video) = match &raw.bar {
        None => (DEFAULT_BAR_PICTURE, DEFAULT_BAR_VIDEO),
        Some(b) => (b.picture.unwrap_or(DEFAULT_BAR_PICTURE), b.video.unwrap_or(DEFAULT_BAR_VIDEO)),
    };
    for (what, v) in [("picture", bar_picture), ("video", bar_video)] {
        if !BAR_RANGE.contains(&v) { return Err(format!("{lid}: bar.{what} {v} (0.05–0.95)")); }
    }
    if let Some(t) = &raw.template {
        if !t.contains("{p}") { return Err(format!("{lid}: template has no {{p}}")); }
    }
    if let Some(v) = &raw.min_app {
        if parse_version(v).is_none() { return Err(format!("{lid}: min_app '{v}' isn't a version")); }
    }
    if role == Role::Base && !raw.borrows.is_empty() {
        return Err(format!("{lid}: only specialist lenses borrow concepts"));
    }
    let mut borrows: Vec<String> = Vec::new();
    for b in &raw.borrows {
        if !valid_concept_id(b) { return Err(format!("{lid}: bad borrowed concept id '{b}'")); }
        if !borrows.contains(b) { borrows.push(b.clone()); }
    }
    if raw.concepts.is_empty() || raw.concepts.len() > MAX_ENTRIES {
        return Err(format!("{lid}: {} entries (1–{MAX_ENTRIES})", raw.concepts.len()));
    }
    // Add-by-hand entries don't count here. A lens without scored entries is valid (it never suggests).
    let scored = raw.concepts.iter().filter(|c| c.suggest != Some(false)).count();
    if scored > MAX_SCORED { return Err(format!("{lid}: {scored} scored entries (at most {MAX_SCORED})")); }

    let mut concepts = Vec::with_capacity(raw.concepts.len());
    let mut seen: HashSet<String> = HashSet::new();
    for c in raw.concepts {
        let cid = c.id;
        if !valid_concept_id(&cid) { return Err(format!("{lid}: bad concept id '{cid}'")); }
        if !seen.insert(cid.clone()) { return Err(format!("{lid}: concept '{cid}' appears twice")); }
        let what = format!("{lid}/{cid}");
        check_i18n(&format!("{what} label"), &c.label, LABEL_MAX)?;
        if let Some(g) = &c.group { check_i18n(&format!("{what} group"), g, GROUP_MAX)?; }
        if c.suggest == Some(false) {
            // An add-by-hand entry is never scored: nothing to embed, no media to cover.
            let given = [("prompts", c.prompts.is_some()), ("media", c.media.is_some()), ("aspect", c.aspect.is_some()), ("vec", c.vec.is_some())];
            if let Some((k, _)) = given.iter().find(|(_, has)| *has) {
                return Err(format!("{what}: an add-by-hand entry has no {k}"));
            }
            concepts.push(Concept { id: cid, lens_id: lid.clone(), label: c.label, group: c.group, suggest: false,
                media: Media::Any, aspect: None, prompts: Vec::new(), vec: Vec::new() });
            continue;
        }
        let prompts = c.prompts.unwrap_or_default();
        if !PROMPTS_PER_CONCEPT.contains(&prompts.len()) {
            return Err(format!("{what}: {} prompts (2–8)", prompts.len()));
        }
        for p in &prompts {
            if p.is_empty() || p.trim() != p { return Err(format!("{what}: empty or padded prompt")); }
            let words = p.split_whitespace().count();
            if !WORDS_PER_PROMPT.contains(&words) { return Err(format!("{what}: prompt '{p}' has {words} words (1–8)")); }
            let full = match &raw.template { Some(t) => t.replace("{p}", p), None => p.clone() };
            if full.chars().count() > PROMPT_CHARS_MAX {
                return Err(format!("{what}: prompt '{p}' is too long with the template"));
            }
        }
        let media = match c.media.as_deref().unwrap_or("any") {
            "any" => Media::Any,
            "picture" => Media::Picture,
            "video" => Media::Video,
            m => return Err(format!("{what}: media '{m}' (any, picture or video)")),
        };
        let aspect = match c.aspect {
            None => None,
            Some(a) if a.len() == 2 && a.iter().all(|x| x.is_finite()) && a[0] > 0.0 && a[0] <= a[1] => Some((a[0], a[1])),
            Some(a) => return Err(format!("{what}: aspect {a:?} (want [min, max] with 0 < min ≤ max)")),
        };
        let vec = decode_vec(c.vec.as_deref().ok_or_else(|| format!("{what}: no vec"))?).map_err(|e| format!("{what}: {e}"))?;
        concepts.push(Concept { id: cid, lens_id: lid.clone(), label: c.label, group: c.group, suggest: true, media, aspect, prompts, vec });
    }
    // The cross-lens rules below catch duplicate labels and prompts inside one file too.
    check_set(&[&Lens {
        id: lid.clone(), version: raw.version, role: Role::Base, name: raw.name.clone(), summary: raw.summary.clone(),
        bar_picture, bar_video, borrows: Vec::new(), concepts: concepts.clone(), template: None, min_app: None,
        placeholder, sha256: String::new(),
    }])?;

    Ok(Lens {
        id: lid, version: raw.version, role, name: raw.name, summary: raw.summary, bar_picture, bar_video,
        borrows, concepts, template: raw.template, min_app: raw.min_app, placeholder,
        sha256: sha256_hex(text.as_bytes()),
    })
}

/// The same-name key of a tag name or a label (spec §0b.2): trimmed, lower-cased, with ‘ ’ ʻ ʼ `
/// folded to '. Compared in Rust, not SQL: SQLite's LOWER() only knows ASCII. Two labels with one
/// key are one name. scripts/lenses/lens-score.mjs nameKey mirrors it.
pub fn name_key(s: &str) -> String {
    crate::commands::fold_apostrophes(&s.trim().to_lowercase())
}

/// Prompts are compared ignoring case and spacing (check.mjs normPrompt).
fn prompt_key(p: &str) -> String { p.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase() }

/// The rules that span every installed lens (spec §2.3 + §0c): exactly one base; a lens lists a
/// concept id once, and the entries of one id across lenses (a shared tag) carry identical labels,
/// agree on `group` where they give one and cover disjoint media (at most one scored entry for
/// pictures and one for videos); labels unique per language across different ids (by `name_key`)
/// and no English label equal to another id's Uzbek one; prompts unique across the set, also between
/// the entries of one id (ignoring case and spacing); `borrows` name base entries, and a lens that
/// also owns a borrowed id covers other media with it. scripts/lenses/check.mjs checkCatalogue
/// mirrors it.
pub fn check_set(lenses: &[&Lens]) -> Result<(), String> {
    let bases: Vec<&&Lens> = lenses.iter().filter(|l| l.role == Role::Base).collect();
    if bases.len() != 1 {
        return Err(format!("{} base lenses installed (exactly one needed)", bases.len()));
    }
    // Each id's entries (lens id, entry) in the order of the set, and the ids in first-seen order.
    let mut ids: Vec<&str> = Vec::new();
    let mut entries: HashMap<&str, Vec<(&str, &Concept)>> = HashMap::new();
    let mut en: HashMap<String, &str> = HashMap::new();
    let mut uz: HashMap<String, &str> = HashMap::new();
    let mut prompts: HashMap<String, (&str, &str)> = HashMap::new();
    for l in lenses {
        let mut in_lens: HashSet<&str> = HashSet::new();
        for c in &l.concepts {
            if !in_lens.insert(&c.id) { return Err(format!("concept '{}' is in '{}' twice", c.id, l.id)); }
            let list = entries.entry(c.id.as_str()).or_default();
            if list.is_empty() { ids.push(&c.id); }
            list.push((l.id.as_str(), c));
            for (map, text, lang) in [(&mut en, &c.label.en, "English"), (&mut uz, &c.label.uz, "Uzbek")] {
                if let Some(other) = map.insert(name_key(text), &c.id).filter(|o| *o != c.id) {
                    return Err(format!("'{other}' and '{}' share the {lang} label '{text}'", c.id));
                }
            }
            for p in &c.prompts {
                if let Some((ol, oc)) = prompts.insert(prompt_key(p), (l.id.as_str(), c.id.as_str())) {
                    return Err(format!("'{ol}/{oc}' and '{}/{}' share the prompt '{p}'", l.id, c.id));
                }
            }
        }
    }
    for id in &ids {
        let list = &entries[id];
        let (first_lens, first) = list[0];
        // One tag, one name: the app keeps one label pair per concept id.
        if let Some((l, _)) = list.iter().find(|(_, c)| c.label != first.label) {
            return Err(format!("'{id}' has other labels in '{l}' than in '{first_lens}'"));
        }
        let mut groups = list.iter().filter_map(|(l, c)| c.group.as_ref().map(|g| (*l, g)));
        if let Some((gl, g)) = groups.next() {
            if let Some((l, _)) = groups.find(|(_, o)| *o != g) {
                return Err(format!("'{id}' has another group in '{l}' than in '{gl}'"));
            }
        }
        for m in [Media::Picture, Media::Video] {
            let covering: Vec<&str> = list.iter().filter(|(_, c)| c.covers(m)).map(|(l, _)| *l).collect();
            if covering.len() > 1 {
                return Err(format!("'{id}': its entries in {covering:?} all cover {}s (at most one may)", m.as_str()));
            }
        }
        // A name points to one tag in both languages (search and the same-name rule match EN and UZ).
        if let Some(other) = uz.get(&name_key(&first.label.en)).filter(|o| *o != id) {
            return Err(format!("the English label of '{id}' is the Uzbek label of '{other}'"));
        }
    }
    let base = bases[0];
    for l in lenses {
        for b in &l.borrows {
            let Some(be) = base.concepts.iter().find(|c| c.id == *b) else {
                return Err(format!("{} borrows '{b}', which isn't a concept of the base lens", l.id));
            };
            let own = l.concepts.iter().find(|c| c.id == *b);
            if own.is_some_and(|c| [Media::Picture, Media::Video].iter().any(|&m| c.covers(m) && be.covers(m))) {
                return Err(format!("{} borrows '{b}' and has its own entry for the same media", l.id));
            }
        }
    }
    Ok(())
}

// ── Vectors ───────────────────────────────────────────────────────────────────

/// IEEE-754 binary16 bits → f32 (exact).
pub fn f16_to_f32(h: u16) -> f32 {
    let sign = ((h as u32) & 0x8000) << 16;
    let exp = ((h >> 10) & 0x1f) as u32;
    let frac = (h & 0x03ff) as u32;
    let bits = match exp {
        0 if frac == 0 => sign,
        0 => {
            // Subnormal: shift the fraction up until its leading bit becomes the implicit one.
            let (mut e, mut f) = (-14i32, frac);
            while f & 0x0400 == 0 { f <<= 1; e -= 1; }
            sign | (((e + 127) as u32) << 23) | ((f & 0x03ff) << 13)
        }
        0x1f => sign | 0x7f80_0000 | (frac << 13),
        _ => sign | ((exp + 112) << 23) | (frac << 13),
    };
    f32::from_bits(bits)
}

/// f32 → IEEE-754 binary16 bits, rounding to nearest even (same as scripts/lenses/lib/f16.mjs).
pub fn f32_to_f16(x: f32) -> u16 {
    let bits = x.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32;
    let mant = bits & 0x007f_ffff;
    if exp == 0xff { return sign | 0x7c00 | if mant != 0 { 0x0200 } else { 0 }; }
    let e = exp - 127 + 15;
    if e >= 0x1f { return sign | 0x7c00; }
    if e <= 0 {
        if e < -10 { return sign; }
        let m = mant | 0x0080_0000;
        let shift = (14 - e) as u32;
        let mut h = m >> shift;
        let rem = m & ((1u32 << shift) - 1);
        let half = 1u32 << (shift - 1);
        if rem > half || (rem == half && h & 1 == 1) { h += 1; }
        return sign | h as u16;
    }
    let mut h = ((e as u32) << 10) | (mant >> 13);
    let rem = mant & 0x1fff;
    if rem > 0x1000 || (rem == 0x1000 && h & 1 == 1) { h += 1; }
    sign | h as u16
}

/// Little-endian f16 bytes (lens `vec`, clip_frames.emb).
pub fn encode_f16(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|&x| f32_to_f16(x).to_le_bytes()).collect() }

pub fn decode_f16(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(2).map(|c| f16_to_f32(u16::from_le_bytes([c[0], c[1]]))).collect()
}

/// L2-normalise in place (computed in f64). Zero vectors stay zero.
pub fn normalize(v: &mut [f32]) {
    let n = v.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>().sqrt();
    if n > 0.0 { v.iter_mut().for_each(|x| *x = (*x as f64 / n) as f32); }
}

/// A concept `vec`: base64 of 512 little-endian f16 values with an L2 norm in [0.98, 1.02],
/// renormalised after decoding.
pub fn decode_vec(b64: &str) -> Result<Vec<f32>, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "vec isn't base64".to_string())?;
    if bytes.len() != DIM * 2 { return Err(format!("vec has {} bytes (want {})", bytes.len(), DIM * 2)); }
    let mut v = decode_f16(&bytes);
    if v.iter().any(|x| !x.is_finite()) { return Err("vec has a value that isn't a finite number".into()); }
    let norm = v.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>().sqrt();
    if !NORM_RANGE.contains(&norm) { return Err(format!("vec length is {norm:.4} (want 1)")); }
    normalize(&mut v);
    Ok(v)
}

pub fn encode_vec(v: &[f32]) -> String { base64::engine::general_purpose::STANDARD.encode(encode_f16(v)) }

fn f32_blob(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

// ── Schema ────────────────────────────────────────────────────────────────────

const TABLES_SQL: &str = "
CREATE TABLE IF NOT EXISTS lenses (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, sha256 TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('bundled','catalogue')), role TEXT NOT NULL,
  file_json TEXT NOT NULL, prev_json TEXT, enabled INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY, lens_id TEXT NOT NULL, labels_json TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT 'any', aspect_json TEXT, vec BLOB NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tag_answers (
  inspiration_id TEXT NOT NULL REFERENCES inspirations(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  answer TEXT NOT NULL CHECK(answer IN ('added','dismissed')),
  lens_id TEXT, answered_at INTEGER NOT NULL,
  PRIMARY KEY (inspiration_id, concept_id));";

/// Spec §0c storage: the entries of the installed lenses, one row per (concept id, lens id), with
/// `position` in its file. Derived data that `sync_concepts` rebuilds from the files (the scorer
/// reads the same entries from the parsed files), so no foreign keys. media and vec are NULL for
/// an add-by-hand entry (suggest 0).
const ENTRIES_SQL: &str = "
CREATE TABLE IF NOT EXISTS concept_entries (
  concept_id TEXT NOT NULL, lens_id TEXT NOT NULL, position INTEGER NOT NULL,
  suggest INTEGER NOT NULL CHECK(suggest IN (0,1)),
  media TEXT CHECK(media IN ('any','picture','video')), aspect_json TEXT, group_json TEXT, vec BLOB,
  PRIMARY KEY (concept_id, lens_id));";

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<Result<_, _>>()?;
    Ok(cols.iter().any(|c| c.eq_ignore_ascii_case(column)))
}

/// `ALTER TABLE … ADD COLUMN` only when PRAGMA table_info shows the column is missing.
fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> rusqlite::Result<()> {
    if has_column(conn, table, column)? { return Ok(()); }
    // A missing table makes this fail with "no such table", which the caller logs.
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))
}

/// `inspirations.lens_suggestions`: each item's suggestions, `{concept id or col:<tag id>: score}`
/// (tagging.rs writes them). Not in `auto_tag_confidence`, whose keys older qooti versions show as
/// tag names. The column starts empty, so in the same transaction every signature is cleared: the
/// next scoring run fills it.
fn add_suggestions_column(conn: &Connection) -> rusqlite::Result<()> {
    if has_column(conn, "inspirations", "lens_suggestions")? { return Ok(()); }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    tx.execute_batch("ALTER TABLE inspirations ADD COLUMN lens_suggestions TEXT")?;
    if has_column(&tx, "inspirations", "auto_tag_sig")? {
        tx.execute("UPDATE inspirations SET auto_tag_sig = NULL WHERE auto_tag_sig IS NOT NULL", [])?;
    }
    tx.commit()
}

/// `add_suggestions_column`, tried once more after a moment when the database was busy (another
/// connection held its lock past the busy timeout). Not optional: every item query selects
/// `lens_suggestions` (commands.rs list_inspirations and the others), so while the column is
/// missing they fail and the grid stays empty. That is logged as an error; the next start adds it.
fn ensure_suggestions_column(conn: &Connection) -> rusqlite::Result<()> {
    let result = once_more_if_busy(|| add_suggestions_column(conn), std::time::Duration::from_millis(250));
    if let Err(e) = &result {
        log::error!(target: "Lens",
            "inspirations.lens_suggestions is missing ({e}): every item query needs it, so the grid stays empty until a start adds it");
    }
    result
}

/// SQLITE_BUSY or SQLITE_LOCKED: another connection holds a lock (the database itself is fine).
fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(e.sqlite_error_code(), Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
}

/// Run `f`; when the database was busy, wait `pause` and run it once more.
fn once_more_if_busy<T>(mut f: impl FnMut() -> rusqlite::Result<T>, pause: std::time::Duration) -> rusqlite::Result<T> {
    match f() {
        Err(e) if is_busy(&e) => {
            log::warn!(target: "Lens", "database busy ({e}): trying once more");
            std::thread::sleep(pause);
            f()
        }
        other => other,
    }
}

/// Every lens table and column (spec §4). Safe to run at every start; each step is attempted,
/// failures are logged, and the first one is returned.
pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    let mut first: Option<rusqlite::Error> = None;
    let mut step = |what: &str, r: rusqlite::Result<()>| {
        if let Err(e) = r {
            log::error!(target: "Lens", "schema step '{what}' failed: {e}");
            first.get_or_insert(e);
        }
    };
    step("tables", conn.execute_batch(TABLES_SQL));
    step("concept_entries", conn.execute_batch(ENTRIES_SQL));
    step("tags.concept_id", add_column(conn, "tags", "concept_id", "TEXT"));
    step("idx_tags_concept", conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_tags_concept ON tags(concept_id)"));
    step("inspirations.auto_tag_sig", add_column(conn, "inspirations", "auto_tag_sig", "TEXT"));
    step("inspirations.lens_suggestions", ensure_suggestions_column(conn));
    step("clip tables", crate::clip::create_tables(conn));
    match first { Some(e) => Err(e), None => Ok(()) }
}

// ── Install ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin { Bundled, Catalogue }

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self { Origin::Bundled => "bundled", Origin::Catalogue => "catalogue" }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct InstallReport {
    pub installed: Vec<String>,
    pub unchanged: Vec<String>,
}

#[derive(Debug)]
pub enum InstallError {
    /// A file breaks a rule of spec §2.3 (alone or together with the installed lenses).
    Invalid(String),
    /// Size or SHA-256 doesn't match what the catalogue index promised.
    Checksum(String),
    /// The file needs a newer app (`min_app`).
    TooNew(String),
    /// The database refused the write; nothing was installed.
    Failed(String),
}

impl InstallError {
    /// The error code the page sees: `invalid`, `checksum`, `too_new` or `failed`.
    pub fn code(&self) -> &'static str {
        match self {
            InstallError::Invalid(_) => "invalid",
            InstallError::Checksum(_) => "checksum",
            InstallError::TooNew(_) => "too_new",
            InstallError::Failed(_) => "failed",
        }
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::Invalid(m) | InstallError::Checksum(m) | InstallError::TooNew(m) | InstallError::Failed(m) => {
                write!(f, "{}: {m}", self.code())
            }
        }
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Installed lenses as stored: id → (version, parsed file if it still parses).
fn installed(conn: &Connection) -> rusqlite::Result<HashMap<String, (i64, Option<Lens>)>> {
    let mut stmt = conn.prepare("SELECT id, version, file_json FROM lenses")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, version, text) = row?;
        let parsed = match parse_lens(&text, true) {
            Ok(l) => Some(l),
            Err(e) => { log::error!(target: "Lens", "installed lens '{id}' doesn't parse: {e}"); None }
        };
        out.insert(id, (version, parsed));
    }
    Ok(out)
}

/// Install a set of parsed files all-or-nothing, in one IMMEDIATE transaction. A file is
/// installed when its lens is missing (or stored unreadable) or the file's version is higher; a
/// real file also replaces a placeholder of any version, and a placeholder never replaces a real
/// lens. Otherwise the file is reported unchanged. Never downgrades. The
/// set that would result must pass `check_set`, or nothing changes. The previous file is kept
/// in `prev_json`, the on/off flag is kept, and `sync_concepts` stores the set's entries in the
/// same transaction: concepts a new version drops stay in `concepts` with `active = 0`, unless
/// another installed lens still has them. A concept row that was only a stand-in (lens_id '', made
/// by a pack import for a concept no lens here had) becomes the real one. The catalogue may only
/// install the three known lenses. Reloads the in-memory cache after a change.
pub fn install(conn: &Connection, files: &[(Lens, &str)], origin: Origin) -> Result<InstallReport, InstallError> {
    let db_err = |e: rusqlite::Error| InstallError::Failed(e.to_string());
    let mut ids = HashSet::new();
    if let Some((l, _)) = files.iter().find(|(l, _)| !ids.insert(l.id.as_str())) {
        return Err(InstallError::Invalid(format!("lens '{}' given twice", l.id)));
    }
    if origin == Origin::Catalogue {
        if let Some((l, _)) = files.iter().find(|(l, _)| !LENS_ORDER.contains(&l.id.as_str())) {
            return Err(InstallError::Invalid(format!("lens '{}' isn't one of {LENS_ORDER:?}", l.id)));
        }
    }
    let current = installed(conn).map_err(db_err)?;
    let mut report = InstallReport::default();
    let mut todo: Vec<&(Lens, &str)> = Vec::new();
    for f in files {
        let new = &f.0;
        let take = match current.get(&new.id) {
            // Missing, or stored but no longer readable: install.
            None | Some((_, None)) => true,
            Some((version, Some(old))) => {
                if new.placeholder && !old.placeholder { false }
                else { new.version > *version || (old.placeholder && !new.placeholder) }
            }
        };
        if take { todo.push(f) } else { report.unchanged.push(new.id.clone()) }
    }
    if todo.is_empty() { return Ok(report); }

    // The set after this install must still hold together.
    let replaced: HashSet<&str> = todo.iter().map(|f| f.0.id.as_str()).collect();
    let mut set: Vec<&Lens> = current.iter()
        .filter(|(id, _)| !replaced.contains(id.as_str()))
        .filter_map(|(_, (_, parsed))| parsed.as_ref())
        .collect();
    set.extend(todo.iter().map(|f| &f.0));
    check_set(&set).map_err(InstallError::Invalid)?;

    let now = now_ms();
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db_err)?;
    for (lens, text) in todo.iter().map(|f| (&f.0, f.1)) {
        tx.execute(
            "INSERT INTO lenses (id, version, sha256, origin, role, file_json, prev_json, enabled, installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 0, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, sha256 = excluded.sha256,
               origin = excluded.origin, role = excluded.role, prev_json = lenses.file_json,
               file_json = excluded.file_json, updated_at = excluded.updated_at",
            params![lens.id, lens.version, lens.sha256, origin.as_str(), lens.role.as_str(), text, now],
        ).map_err(db_err)?;
        report.installed.push(lens.id.clone());
    }
    // Entries and concept rows from the whole set (one tag may be in several lenses).
    sync_concepts(&tx, &set, now).map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    for l in todo.iter().map(|f| &f.0) {
        if l.placeholder { log::warn!(target: "Lens", "installed a PLACEHOLDER for lens '{}' — build the real one", l.id); }
        if !l.concepts.iter().any(|c| c.suggest) { log::warn!(target: "Lens", "lens '{}' has no scored entries: it never suggests anything", l.id); }
    }
    log::info!(target: "Lens", "installed {:?} ({}), unchanged {:?}", report.installed, origin.as_str(), report.unchanged);
    reload_cache(conn);
    Ok(report)
}

/// Install the lenses bundled in the app when they're missing or the bundled version is higher.
/// Never downgrades a catalogue install. Call at every start; it makes sure the tables exist,
/// always leaves the in-memory cache freshly loaded, and brings the stored entries in line with
/// the installed lenses (`sync_catalogue`: nothing to do on most starts).
pub fn install_bundled(conn: &Connection) -> Result<InstallReport, InstallError> {
    if let Err(e) = ensure_schema(conn) {
        log::error!(target: "Lens", "lens tables not ready: {e}");
    }
    let r = install_bundled_files(conn);
    let cat = reload_cache(conn);
    match sync_catalogue(conn, &cat) {
        Ok(s) if !s.skipped => log::info!(target: "Lens", "stored {} lens entries ({} tags changed, {} retired)", s.entries, s.concepts, s.retired),
        Ok(_) => {}
        Err(e) => log::error!(target: "Lens", "lens entries not stored: {e}"),
    }
    r
}

fn install_bundled_files(conn: &Connection) -> Result<InstallReport, InstallError> {
    let mut files = Vec::with_capacity(BUNDLED.len());
    for (id, text) in BUNDLED {
        match parse_lens(text, true) {
            Ok(l) if l.id == id => files.push((l, text)),
            Ok(l) => log::error!(target: "Lens", "bundled file for '{id}' holds lens '{}'", l.id),
            Err(e) => log::error!(target: "Lens", "bundled lens '{id}' is invalid: {e}"),
        }
    }
    let r = install(conn, &files, Origin::Bundled);
    if let Err(e) = &r { log::error!(target: "Lens", "bundled lenses not installed: {e}"); }
    r
}

// ── Stored entries (spec §0c storage) ─────────────────────────────────────────

/// schema_meta: the fingerprint of the lens set `concept_entries` was last rebuilt from.
const SYNC_KEY: &str = "lens_entries_sync";

/// What `sync_concepts` did. `concepts`: concept rows added or changed; `retired`: rows that went
/// inactive because no installed lens has them any more.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncReport { pub skipped: bool, pub entries: usize, pub concepts: usize, pub retired: usize }

/// The first 16 hex chars of sha256("entries-1|" + the sorted "<lens id>@<sha256>" joined by ",").
pub fn set_fingerprint(set: &[&Lens]) -> String {
    let mut parts: Vec<String> = set.iter().map(|l| format!("{}@{}", l.id, l.sha256)).collect();
    parts.sort();
    hex::encode(Sha256::digest(format!("entries-1|{}", parts.join(",")).as_bytes()))[..16].to_string()
}

/// Store `set` (every installed lens) inside the caller's transaction: each (concept id, lens id)
/// in `concept_entries`; one `concepts` row per id with the labels of its primary entry (the first
/// lens in LENS_ORDER that has it), that lens and active = 1, changed only when it differs; rows no
/// installed lens has go inactive and keep their labels (a pack's stand-in, lens_id '', stays as it
/// is); the set's fingerprint. The legacy `concepts` columns media, aspect_json and vec are only
/// written for a new row ('any', NULL, x''): nothing reads them.
pub fn sync_concepts(tx: &Connection, set: &[&Lens], now: i64) -> rusqlite::Result<SyncReport> {
    let mut lenses: Vec<&Lens> = set.to_vec();
    lenses.sort_by(|a, b| order_index(&a.id).cmp(&order_index(&b.id)).then_with(|| a.id.cmp(&b.id)));
    let mut report = SyncReport::default();
    tx.execute("DELETE FROM concept_entries", [])?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO concept_entries (concept_id, lens_id, position, suggest, media, aspect_json, group_json, vec)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")?;
        for l in &lenses {
            for (i, c) in l.concepts.iter().enumerate() {
                let group = c.group.as_ref().map(|g| serde_json::to_string(g).unwrap_or_default());
                let (media, aspect, vec) = if c.suggest {
                    (Some(c.media.as_str()), c.aspect.map(|(lo, hi)| serde_json::json!([lo, hi]).to_string()), Some(f32_blob(&c.vec)))
                } else { (None, None, None) };
                insert.execute(params![c.id, l.id, i as i64, c.suggest as i64, media, aspect, group, vec])?;
                report.entries += 1;
            }
        }
        let mut upsert = tx.prepare(
            "INSERT INTO concepts (id, lens_id, labels_json, media, aspect_json, vec, active, updated_at)
             VALUES (?1, ?2, ?3, 'any', NULL, x'', 1, ?4)
             ON CONFLICT(id) DO UPDATE SET lens_id = excluded.lens_id, labels_json = excluded.labels_json,
               active = 1, updated_at = excluded.updated_at
             WHERE concepts.lens_id IS NOT excluded.lens_id OR concepts.labels_json IS NOT excluded.labels_json
                OR concepts.active IS NOT 1")?;
        let mut seen: HashSet<&str> = HashSet::new();
        for l in &lenses {
            for c in l.concepts.iter().filter(|c| seen.insert(&c.id)) {
                let labels = serde_json::to_string(&c.label).unwrap_or_default();
                report.concepts += upsert.execute(params![c.id, l.id, labels, now])?;
            }
        }
    }
    report.retired = tx.execute(
        "UPDATE concepts SET active = 0, updated_at = ?1 WHERE active != 0 AND id NOT IN (SELECT concept_id FROM concept_entries)",
        params![now])?;
    tx.execute("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?1, ?2)", params![SYNC_KEY, set_fingerprint(set)])?;
    warn_retired_names(tx)?;
    Ok(report)
}

/// A retired tag named like a live one (two tags, one name) is kept as it is; the log says so.
fn warn_retired_names(conn: &Connection) -> rusqlite::Result<()> {
    let mut live: HashMap<String, String> = HashMap::new();
    let mut retired: Vec<(String, I18n)> = Vec::new();
    let mut stmt = conn.prepare("SELECT id, labels_json, active FROM concepts")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))? {
        let (id, labels, active) = row?;
        let Some(l) = parse_labels(&labels) else { continue };
        if active != 0 { for t in [&l.en, &l.uz] { live.insert(name_key(t), id.clone()); } } else { retired.push((id, l)); }
    }
    let clashes: Vec<String> = retired.iter()
        .filter_map(|(id, l)| [&l.en, &l.uz].into_iter().find_map(|t| live.get(&name_key(t))).map(|o| format!("{id} ~ {o}")))
        .collect();
    if !clashes.is_empty() { log::warn!(target: "Lens", "retired tags named like live ones (both kept): {}", clashes.join(", ")); }
    Ok(())
}

/// At every start (install_bundled): bring `concept_entries` and the concept rows in line with the
/// installed lenses `cat`, in one IMMEDIATE transaction. Skipped when the stored fingerprint is
/// `cat`'s and the row count matches (most starts), and when nothing is installed (lenses that
/// couldn't be read must not retire every tag).
pub fn sync_catalogue(conn: &Connection, cat: &Catalogue) -> rusqlite::Result<SyncReport> {
    let set: Vec<&Lens> = cat.lenses.iter().collect();
    let entries: usize = set.iter().map(|l| l.concepts.len()).sum();
    if set.is_empty() { return Ok(SyncReport { skipped: true, ..SyncReport::default() }); }
    let stored: Option<String> = conn
        .query_row("SELECT value FROM schema_meta WHERE key = ?1", params![SYNC_KEY], |r| r.get(0)).optional()?;
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM concept_entries", [], |r| r.get(0))?;
    if stored.as_deref() == Some(set_fingerprint(&set).as_str()) && rows == entries as i64 {
        return Ok(SyncReport { skipped: true, entries, ..SyncReport::default() });
    }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let report = sync_concepts(&tx, &set, now_ms())?;
    tx.commit()?;
    Ok(report)
}

// ── In-memory catalogue ───────────────────────────────────────────────────────

/// Position in the fixed lens order (unknown ids after the known ones).
pub fn order_index(id: &str) -> usize { LENS_ORDER.iter().position(|x| *x == id).unwrap_or(LENS_ORDER.len()) }

/// The installed lenses, parsed, in the fixed order.
#[derive(Clone, Debug, Default)]
pub struct Catalogue {
    pub lenses: Vec<Lens>,
}

impl Catalogue {
    pub fn from_lenses(mut lenses: Vec<Lens>) -> Catalogue {
        lenses.sort_by(|a, b| order_index(&a.id).cmp(&order_index(&b.id)).then_with(|| a.id.cmp(&b.id)));
        Catalogue { lenses }
    }

    /// Read every installed lens from the database (rows that no longer parse are logged and left out).
    pub fn load(conn: &Connection) -> Catalogue {
        match installed(conn) {
            Ok(m) => Catalogue::from_lenses(m.into_values().filter_map(|(_, l)| l).collect()),
            Err(e) => { log::error!(target: "Lens", "couldn't read the installed lenses: {e}"); Catalogue::default() }
        }
    }

    pub fn get(&self, id: &str) -> Option<&Lens> { self.lenses.iter().find(|l| l.id == id) }

    /// The base lens, unless it is a placeholder (then nothing is scored).
    pub fn scoring_base(&self) -> Option<&Lens> { self.lenses.iter().find(|l| l.role == Role::Base && !l.placeholder) }

    /// Specialists that are scored (placeholders never are).
    pub fn scoring_specialists(&self) -> impl Iterator<Item = &Lens> {
        self.lenses.iter().filter(|l| l.role == Role::Specialist && !l.placeholder)
    }

    /// The base lens, placeholder or not.
    pub fn base(&self) -> Option<&Lens> { self.lenses.iter().find(|l| l.role == Role::Base) }

    /// Every entry of concept `id` (one per lens at most), in lens order.
    pub fn entries_of(&self, id: &str) -> Vec<(&Lens, &Concept)> {
        self.lenses.iter().filter_map(|l| l.concepts.iter().find(|c| c.id == id).map(|c| (l, c))).collect()
    }

    /// The primary lens of a concept id: the first in lens order that has an entry for it.
    pub fn primary_lens(&self, id: &str) -> Option<&Lens> { self.entries_of(id).first().map(|(l, _)| *l) }

    /// The specialists that borrow concept `id`, in lens order.
    pub fn borrowers(&self, id: &str) -> Vec<&Lens> {
        self.lenses.iter().filter(|l| l.role == Role::Specialist && l.borrows.iter().any(|b| b == id)).collect()
    }

    /// Spec §0c display rule: `lens` shows `key` on items of media `m` when its own entry for the key
    /// covers `m`, or when it is a specialist that borrows the key and the base's entry covers `m`.
    /// lenses.js and scripts/lenses/lens-score.mjs shownBy apply the same rule.
    pub fn shows(&self, lens: &Lens, key: &str, m: Media) -> bool {
        lens.concepts.iter().any(|c| c.id == key && c.covers(m))
            || (lens.role == Role::Specialist && lens.borrows.iter().any(|b| b == key)
                && self.base().is_some_and(|b| b.concepts.iter().any(|c| c.id == key && c.covers(m))))
    }
}

static CACHE: OnceCell<RwLock<Option<Arc<Catalogue>>>> = OnceCell::new();

fn cache_cell() -> &'static RwLock<Option<Arc<Catalogue>>> { CACHE.get_or_init(|| RwLock::new(None)) }

/// The cached catalogue, loaded from `conn` on first use.
pub fn catalogue(conn: &Connection) -> Arc<Catalogue> {
    if let Some(c) = cache_cell().read().unwrap_or_else(|e| e.into_inner()).as_ref() { return c.clone(); }
    reload_cache(conn)
}

/// Re-read the installed lenses into the cache (done after every install).
pub fn reload_cache(conn: &Connection) -> Arc<Catalogue> {
    let c = Arc::new(Catalogue::load(conn));
    *cache_cell().write().unwrap_or_else(|e| e.into_inner()) = Some(c.clone());
    c
}

/// `concepts.labels_json` → labels (for the Tag shape).
pub fn parse_labels(json: &str) -> Option<I18n> { serde_json::from_str(json).ok() }

// ── Listing + commands ────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LensInfo {
    pub id: String,
    pub role: String,
    pub version: i64,
    pub enabled: bool,
    pub origin: String,
    pub name: I18n,
    pub summary: I18n,
    /// When this lens was last installed or updated (unix milliseconds).
    pub updated_at: i64,
    pub concepts: Vec<String>,
    pub borrows: Vec<String>,
}

/// One entry of a concept in an installed lens, as the page sees it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EntryInfo {
    pub lens_id: String,
    /// "any", "picture" or "video"; None for an add-by-hand entry.
    pub media: Option<String>,
    pub suggest: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ConceptInfo {
    pub id: String,
    /// The primary lens (the first in lens order with an entry); a retired concept keeps its last
    /// one, a pack's stand-in has ''.
    pub lens_id: String,
    pub labels: I18n,
    /// The first entry's group that gives one.
    pub group: Option<I18n>,
    pub active: bool,
    /// Its entries in the installed lenses, in lens order (empty when no lens has it any more).
    pub entries: Vec<EntryInfo>,
    /// The specialists that borrow it, in lens order.
    pub borrowed_by: Vec<String>,
}

pub fn list_lenses_with(conn: &Connection, cat: &Catalogue) -> rusqlite::Result<Vec<LensInfo>> {
    let mut stmt = conn.prepare("SELECT id, version, origin, enabled, updated_at FROM lenses")?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?,
    )))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, version, origin, enabled, updated_at) = row?;
        let Some(l) = cat.get(&id) else { continue };
        out.push(LensInfo {
            id, role: l.role.as_str().into(), version, enabled: enabled != 0, origin,
            name: l.name.clone(), summary: l.summary.clone(), updated_at,
            concepts: l.concepts.iter().map(|c| c.id.clone()).collect(), borrows: l.borrows.clone(),
        });
    }
    out.sort_by(|a, b| order_index(&a.id).cmp(&order_index(&b.id)).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

pub fn list_concepts_with(conn: &Connection, cat: &Catalogue) -> rusqlite::Result<Vec<ConceptInfo>> {
    // Concepts with entries by their primary entry (lens order, then file order); the others
    // (kept for their labels) last.
    let mut position: HashMap<&str, (usize, usize)> = HashMap::new();
    for (li, l) in cat.lenses.iter().enumerate() {
        for (ci, c) in l.concepts.iter().enumerate() { position.entry(c.id.as_str()).or_insert((li, ci)); }
    }
    let mut stmt = conn.prepare("SELECT id, lens_id, labels_json, active FROM concepts")?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?,
    )))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, lens_id, labels_json, active) = row?;
        let Some(labels) = parse_labels(&labels_json) else {
            log::warn!(target: "Lens", "concept '{id}' has unreadable labels");
            continue;
        };
        let found = cat.entries_of(&id);
        let entries = found.iter().map(|(l, c)| EntryInfo {
            lens_id: l.id.clone(), media: c.suggest.then(|| c.media.as_str().to_string()), suggest: c.suggest,
        }).collect();
        let group = found.iter().find_map(|(_, c)| c.group.clone());
        let borrowed_by = cat.borrowers(&id).iter().map(|l| l.id.clone()).collect();
        out.push(ConceptInfo { id, lens_id, labels, group, active: active != 0, entries, borrowed_by });
    }
    out.sort_by(|a, b| {
        let pa = position.get(a.id.as_str()).copied().unwrap_or((usize::MAX, 0));
        let pb = position.get(b.id.as_str()).copied().unwrap_or((usize::MAX, 0));
        pa.cmp(&pb).then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

pub(crate) fn lock_db<'a>(state: &'a AppState) -> std::sync::MutexGuard<'a, Connection> {
    state.db.lock().unwrap_or_else(|e| e.into_inner())
}

/// `[{id, role, version, enabled, origin, name:{en,uz}, summary:{en,uz}, updated_at, concepts:[id],
/// borrows:[id]}]` in the fixed order motion, design, thumbnail.
#[tauri::command]
pub fn list_lenses(state: State<AppState>) -> Result<Vec<LensInfo>, String> {
    let db = lock_db(&state);
    let cat = catalogue(&db);
    list_lenses_with(&db, &cat).map_err(|e| e.to_string())
}

/// `[{id, lens_id, labels:{en,uz}, group:{en,uz}|null, active, entries:[{lens_id, media, suggest}],
/// borrowed_by:[lens ids]}]`: every concept row, retired ones included (entries `[]`). `media` is
/// null for an add-by-hand entry. The page applies the display rule (spec §0c) from these.
#[tauri::command]
pub fn list_concepts(state: State<AppState>) -> Result<Vec<ConceptInfo>, String> {
    let db = lock_db(&state);
    let cat = catalogue(&db);
    list_concepts_with(&db, &cat).map_err(|e| e.to_string())
}

/// Turn a lens on or off. A display filter only: nothing is re-scored.
#[tauri::command]
pub fn set_lens_enabled(id: String, enabled: bool, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let n = lock_db(&state)
        .execute("UPDATE lenses SET enabled = ?2 WHERE id = ?1", params![id, enabled as i64])
        .map_err(|e| e.to_string())?;
    if n == 0 { return Err(format!("unknown lens '{id}'")); }
    if let Err(e) = app.emit("lens:changed", serde_json::json!({})) {
        log::warn!(target: "Lens", "lens:changed not sent: {e}");
    }
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Builders shared with tagging.rs tests.
#[cfg(test)]
pub(crate) mod testkit {
    use super::*;

    pub fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    /// Deterministic pseudo-random unit vector.
    pub fn unit(seed: u64) -> Vec<f32> {
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut v: Vec<f32> = (0..DIM).map(|_| {
            s ^= s << 13; s ^= s >> 7; s ^= s << 17;
            ((s >> 11) as f64 / (1u64 << 53) as f64 - 0.5) as f32
        }).collect();
        normalize(&mut v);
        v
    }

    /// `a` moved towards `b`: unit((1 - t)·a + t·b).
    pub fn mix(a: &[f32], b: &[f32], t: f32) -> Vec<f32> {
        let mut v: Vec<f32> = a.iter().zip(b).map(|(x, y)| (1.0 - t) * x + t * y).collect();
        normalize(&mut v);
        v
    }

    #[derive(Clone)]
    pub struct TC {
        pub id: String,
        pub media: &'static str,
        pub aspect: Option<(f64, f64)>,
        pub vec: Vec<f32>,
        /// False: an add-by-hand entry (no prompts, media, aspect or vec in the file).
        pub suggest: bool,
        pub group: Option<I18n>,
        /// The entry's prompts; empty: made from the id ("photo …", "picture …", or for a video
        /// entry "video …", "clip …", so a tag's picture and video entries differ).
        pub prompts: Vec<String>,
    }

    pub fn tc(id: &str, vec: Vec<f32>) -> TC {
        TC { id: id.into(), media: "any", aspect: None, vec, suggest: true, group: None, prompts: Vec::new() }
    }
    /// An entry for one media.
    pub fn tc_media(id: &str, media: &'static str, vec: Vec<f32>) -> TC { TC { media, ..tc(id, vec) } }
    /// An add-by-hand entry ("suggest": false).
    pub fn tc_hand(id: &str) -> TC { TC { suggest: false, ..tc(id, Vec::new()) } }

    /// A valid built lens file as JSON. Labels and prompts are derived from the concept id (labels
    /// never hold an underscore: `d_one` is "L d one" / "U d one").
    pub fn lens_value(id: &str, role: &str, version: i64, concepts: &[TC], borrows: &[&str]) -> serde_json::Value {
        let concepts: Vec<serde_json::Value> = concepts.iter().map(|c| {
            let words = c.id.replace('_', " ");
            let mut v = serde_json::json!({
                "id": c.id,
                "label": { "en": format!("L {words}"), "uz": format!("U {words}") },
            });
            if let Some(g) = &c.group { v["group"] = serde_json::json!(g); }
            if !c.suggest {
                v["suggest"] = serde_json::json!(false);
                return v;
            }
            v["prompts"] = serde_json::json!(match (c.prompts.is_empty(), c.media) {
                (false, _) => c.prompts.clone(),
                (true, "video") => vec![format!("video {words}"), format!("clip {words}")],
                (true, _) => vec![format!("photo {words}"), format!("picture {words}")],
            });
            v["media"] = serde_json::json!(c.media);
            v["vec"] = serde_json::json!(encode_vec(&c.vec));
            if let Some((lo, hi)) = c.aspect { v["aspect"] = serde_json::json!([lo, hi]); }
            v
        }).collect();
        serde_json::json!({
            "format": 2, "id": id, "version": version, "role": role,
            "name": { "en": format!("Lens {id}"), "uz": format!("Lens {id} uz") },
            "summary": { "en": "Test summary", "uz": "Sinov tavsifi" },
            "bar": { "picture": 0.30, "video": 0.20 },
            "borrows": borrows,
            "min_app": "1.2.3", "updated_at": "2026-11-18",
            "model": "clip-b32-q8", "template": "This is a photo of {p}",
            "text_model": "test",
            "concepts": concepts,
        })
    }

    pub fn lens_text(id: &str, role: &str, version: i64, concepts: &[TC], borrows: &[&str]) -> String {
        lens_value(id, role, version, concepts, borrows).to_string()
    }

    /// Install texts as catalogue files.
    pub fn install_texts(conn: &Connection, texts: &[String]) -> Result<InstallReport, InstallError> {
        let files: Vec<(Lens, &str)> = texts.iter().map(|t| (parse_lens(t, true).unwrap(), t.as_str())).collect();
        install(conn, &files, Origin::Catalogue)
    }

    /// A base lens `design` + specialists `motion` and `thumbnail`, three concepts each.
    pub fn standard_texts(version: i64) -> Vec<String> {
        vec![
            lens_text("design", "base", version, &[tc("d_one", unit(1)), tc("d_two", unit(2)), tc("d_three", unit(3))], &[]),
            lens_text("motion", "specialist", version, &[tc("m_one", unit(11)), tc("m_two", unit(12)), tc("m_three", unit(13))], &["d_one"]),
            lens_text("thumbnail", "specialist", version, &[tc("t_one", unit(21)), tc("t_two", unit(22)), tc("t_three", unit(23))], &[]),
        ]
    }

    /// A file of the lens tools' fixtures (scripts/lenses/test/fixtures), read at test time.
    pub fn fixture_text(rel: &str) -> String {
        let path = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/lenses/test/fixtures")).join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// The three valid built fixtures (design, motion, thumbnail; spec §0c shared tags, add-by-hand
    /// entries and groups). Every scored entry's vector is a basis vector e_k.
    pub fn valid_fixture_texts() -> Vec<String> {
        ["design", "motion", "thumbnail"].iter().map(|id| fixture_text(&format!("valid/built/qooti-lens-{id}.json"))).collect()
    }

    /// The stored entries are the installed lenses' (spec §0c storage): `concept_entries` holds every
    /// entry of `Catalogue::load`; every id with an entry has an active row with its primary entry's
    /// labels and lens; every other row is inactive; the set's fingerprint is stored.
    pub fn assert_storage_matches(conn: &Connection) {
        let cat = Catalogue::load(conn);
        type Row = (String, String, i64, i64, Option<String>, Option<String>, Option<String>, Option<i64>);
        let mut want: Vec<Row> = cat.lenses.iter().flat_map(|l| l.concepts.iter().enumerate().map(move |(i, c)| (
            c.id.clone(), l.id.clone(), i as i64, c.suggest as i64,
            c.suggest.then(|| c.media.as_str().to_string()),
            c.aspect.filter(|_| c.suggest).map(|(lo, hi)| serde_json::json!([lo, hi]).to_string()),
            c.group.as_ref().map(|g| serde_json::to_string(g).unwrap()),
            c.suggest.then(|| (c.vec.len() * 4) as i64),
        ))).collect();
        let mut stmt = conn.prepare(
            "SELECT concept_id, lens_id, position, suggest, media, aspect_json, group_json, length(vec) FROM concept_entries").unwrap();
        let mut got: Vec<Row> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))
            .unwrap().map(|r| r.unwrap()).collect();
        want.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        got.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        assert_eq!(got, want, "concept_entries = the installed entries");
        let mut stmt = conn.prepare("SELECT id, lens_id, labels_json, active FROM concepts").unwrap();
        let rows: Vec<(String, String, String, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap().map(|r| r.unwrap()).collect();
        let ids: HashSet<&str> = cat.lenses.iter().flat_map(|l| l.concepts.iter().map(|c| c.id.as_str())).collect();
        for id in &ids {
            let (lens, entry) = cat.entries_of(id)[0];
            let row = rows.iter().find(|r| r.0 == *id).unwrap_or_else(|| panic!("no concepts row for '{id}'"));
            assert_eq!((row.1.as_str(), row.3), (lens.id.as_str(), 1), "'{id}': primary lens, active");
            assert_eq!(parse_labels(&row.2).as_ref(), Some(&entry.label), "'{id}': the primary entry's labels");
        }
        for row in rows.iter().filter(|r| !ids.contains(r.0.as_str())) {
            assert_eq!(row.3, 0, "'{}' has no entry, so it is inactive", row.0);
        }
        let set: Vec<&Lens> = cat.lenses.iter().collect();
        let stored: Option<String> = conn.query_row("SELECT value FROM schema_meta WHERE key = ?1", params![SYNC_KEY], |r| r.get(0)).optional().unwrap();
        assert_eq!(stored, Some(set_fingerprint(&set)), "fingerprint");
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use serde_json::{json, Value};

    fn base_value() -> Value { lens_value("design", "base", 1, &[tc("d_one", unit(1)), tc("d_two", unit(2))], &[]) }

    fn rejects(v: &Value, why: &str) {
        let text = v.to_string();
        assert!(parse_lens(&text, false).is_err(), "should reject: {why}");
    }

    #[test]
    fn f16_round_trip() {
        for (x, bits) in [(0.0f32, 0x0000u16), (1.0, 0x3C00), (-2.0, 0xC000), (0.5, 0x3800), (65504.0, 0x7BFF),
                          (6.103_515_6e-5, 0x0400), (5.960_464_5e-8, 0x0001), (f32::INFINITY, 0x7C00), (1.0e6, 0x7C00)] {
            assert_eq!(f32_to_f16(x), bits, "{x}");
            if x.is_finite() && x.abs() <= 65504.0 { assert_eq!(f16_to_f32(bits), x); }
        }
        assert!(f16_to_f32(0x7E00).is_nan());
        assert_eq!(f16_to_f32(0x8000).to_bits(), (-0.0f32).to_bits());
        // Every finite half survives f16 → f32 → f16 exactly.
        for h in 0u16..=0xFFFF {
            let x = f16_to_f32(h);
            if x.is_finite() { assert_eq!(f32_to_f16(x), h, "{h:#06x}"); }
        }
        // Rounding: halfway between two halves goes to the even one.
        assert_eq!(f32_to_f16(1.0 + 2f32.powi(-11)), 0x3C00);
        assert_eq!(f32_to_f16(1.0 + 3.0 * 2f32.powi(-11)), 0x3C02);
        // A unit vector through the file format.
        let v = unit(7);
        let back = decode_vec(&encode_vec(&v)).unwrap();
        let cos: f64 = v.iter().zip(&back).map(|(a, b)| *a as f64 * *b as f64).sum();
        assert!(cos > 0.99999, "cos {cos}");
        let norm: f64 = back.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }

    #[test]
    fn accepts_a_good_file() {
        let l = parse_lens(&base_value().to_string(), false).unwrap();
        assert_eq!(l.id, "design");
        assert_eq!(l.role, Role::Base);
        assert_eq!(l.concepts.len(), 2);
        assert_eq!(l.sha256.len(), 64);
        assert!((l.bar_picture - 0.30).abs() < 1e-12);
        // Optional fields may be left out; Uzbek may use ‘ and ’.
        let mut v = base_value();
        v.as_object_mut().unwrap().remove("bar");
        v["concepts"][0].as_object_mut().unwrap().remove("media");
        v["name"]["uz"] = json!("Grafik dizayner o‘g‘il ma’no");
        let l = parse_lens(&v.to_string(), false).unwrap();
        assert_eq!((l.bar_picture, l.bar_video), (DEFAULT_BAR_PICTURE, DEFAULT_BAR_VIDEO));
        assert_eq!(l.concepts[0].media, Media::Any);
        // Whole numbers written as 1.0 / 2.0 are integers (as for the Node checker).
        let mut v = base_value();
        v["version"] = json!(3.0);
        v["format"] = json!(2.0);
        assert_eq!(parse_lens(&v.to_string(), false).unwrap().version, 3);
        // Spec §0c: an add-by-hand entry (no prompts, media, aspect or vec) and a group.
        let mut v = lens_value("motion", "specialist", 1, &[tc("m_one", unit(11)), tc_hand("m_hand")], &[]);
        v["concepts"][0]["group"] = json!({ "en": "Techniques", "uz": "Usullar" });
        v["concepts"][1]["group"] = json!({ "en": "Social", "uz": "Ijtimoiy" });
        let l = parse_lens(&v.to_string(), false).unwrap();
        assert!(l.concepts[0].suggest && l.concepts[0].covers(Media::Picture) && l.concepts[0].covers(Media::Video));
        assert_eq!(l.concepts[0].group, Some(I18n { en: "Techniques".into(), uz: "Usullar".into() }));
        let hand = &l.concepts[1];
        assert!(!hand.suggest && hand.prompts.is_empty() && hand.vec.is_empty() && hand.aspect.is_none());
        assert!(!hand.covers(Media::Picture) && !hand.covers(Media::Video), "an add-by-hand entry covers nothing");
        assert_eq!(hand.group.as_ref().map(|g| g.en.as_str()), Some("Social"));
        // "suggest": true written out is an ordinary scored entry; a lens of add-by-hand entries only is valid.
        v["concepts"][0]["suggest"] = json!(true);
        assert!(parse_lens(&v.to_string(), false).unwrap().concepts[0].suggest);
        assert!(parse_lens(&lens_text("thumbnail", "specialist", 1, &[tc_hand("t_hand")], &[]), false).is_ok());
    }

    #[test]
    fn rejects_each_bad_case() {
        let set = |path: &[&str], val: Value| -> Value {
            let mut v = base_value();
            let mut cur = &mut v;
            for (i, k) in path.iter().enumerate() {
                if i + 1 == path.len() {
                    if let Ok(idx) = k.parse::<usize>() { cur[idx] = val.clone(); } else { cur[*k] = val.clone(); }
                    break;
                }
                cur = if let Ok(idx) = k.parse::<usize>() { &mut cur[idx] } else { &mut cur[*k] };
            }
            v
        };
        // File level.
        rejects(&set(&["format"], json!(1)), "format 1");
        rejects(&set(&["id"], json!("Design")), "upper-case id");
        rejects(&set(&["id"], json!("d")), "one-letter id");
        rejects(&set(&["id"], json!("a".repeat(33))), "33-char id");
        rejects(&set(&["id"], json!("9design")), "id starting with a digit");
        rejects(&set(&["version"], json!(0)), "version 0");
        rejects(&set(&["version"], json!(1.5)), "fractional version");
        rejects(&set(&["version"], json!("1")), "string version");
        rejects(&set(&["version"], json!(MAX_VERSION + 1)), "version over the cap");
        rejects(&set(&["version"], json!(i64::MAX)), "version i64::MAX");
        assert_eq!(parse_lens(&set(&["version"], json!(MAX_VERSION)).to_string(), false).unwrap().version, MAX_VERSION);
        rejects(&set(&["role"], json!("other")), "unknown role");
        // Each of the three lenses has its fixed role: design is the base, the others specialists.
        rejects(&set(&["role"], json!("specialist")), "design as a specialist");
        rejects(&lens_value("motion", "base", 1, &[tc("m_x", unit(9))], &[]), "motion as the base");
        rejects(&lens_value("thumbnail", "base", 1, &[tc("t_x", unit(9))], &[]), "thumbnail as the base");
        assert!(parse_lens(&lens_value("thumbnail", "specialist", 1, &[tc("t_x", unit(9))], &[]).to_string(), false).is_ok());
        rejects(&set(&["model"], json!("clip-l14")), "other model");
        rejects(&set(&["template"], json!("A photo")), "template without {p}");
        rejects(&set(&["min_app"], json!("soon")), "min_app not a version");
        // Text fields.
        rejects(&set(&["name", "en"], json!("")), "empty name");
        rejects(&set(&["name", "en"], json!(" Designer")), "padded name");
        rejects(&set(&["name", "en"], json!("<b>Designer</b>")), "markup in name");
        rejects(&set(&["summary", "en"], json!("Bell\u{0007}")), "control character");
        rejects(&set(&["summary", "en"], json!("Zero\u{200B}width")), "format character");
        rejects(&set(&["summary", "en"], json!("Cafe\u{0301}")), "decomposed (not NFC)");
        rejects(&set(&["name", "uz"], json!("Grafik dizayner o'g'il")), "ASCII apostrophe in Uzbek");
        rejects(&set(&["name", "uz"], json!("Grafik `dizayner")), "backtick in Uzbek");
        rejects(&set(&["name", "uz"], json!("Grafik o\u{02BB}g\u{02BB}il")), "modifier letter turned comma");
        rejects(&set(&["name", "uz"], json!("ma\u{02BC}no")), "modifier letter apostrophe");
        rejects(&set(&["concepts", "0", "label", "en"], json!("x".repeat(25))), "label over 24");
        rejects(&set(&["name", "en"], json!("x".repeat(49))), "name over 48");
        rejects(&set(&["summary", "uz"], json!("x".repeat(61))), "summary over 60");
        // Concepts.
        rejects(&set(&["concepts", "0", "id"], json!("Bad-Id")), "bad concept id");
        rejects(&set(&["concepts", "0", "id"], json!(format!("a{}", "b".repeat(40)))), "41-char concept id");
        rejects(&set(&["concepts", "1", "id"], json!("d_one")), "duplicate concept id");
        rejects(&set(&["concepts"], json!([])), "no concepts");
        // At most 80 scored entries, and 120 in all with the add-by-hand ones (spec §0c).
        let scored_81: Vec<TC> = (0..81).map(|i| tc(&format!("c_{i}"), unit(100 + i))).collect();
        rejects(&lens_value("design", "base", 1, &scored_81, &[]), "81 scored entries");
        let mut most: Vec<TC> = (0..80).map(|i| tc(&format!("c_{i}"), unit(100 + i))).collect();
        most.extend((0..40).map(|i| tc_hand(&format!("h_{i}"))));
        assert_eq!(parse_lens(&lens_text("design", "base", 1, &most, &[]), false).unwrap().concepts.len(), 120);
        most.push(tc_hand("h_40"));
        rejects(&lens_value("design", "base", 1, &most, &[]), "121 entries");
        // Add-by-hand entries have no prompts, media, aspect or vec; suggest is a boolean.
        let hand = |key: &str, val: Value| -> Value {
            let mut v = lens_value("design", "base", 1, &[tc("d_one", unit(1)), tc_hand("d_hand")], &[]);
            v["concepts"][1][key] = val;
            v
        };
        rejects(&hand("prompts", json!(["a brand book", "a brand identity"])), "add-by-hand entry with prompts");
        rejects(&hand("media", json!("picture")), "add-by-hand entry with media");
        rejects(&hand("aspect", json!([1.0, 2.0])), "add-by-hand entry with aspect");
        rejects(&hand("vec", json!(encode_vec(&unit(5)))), "add-by-hand entry with vec");
        rejects(&set(&["concepts", "0", "suggest"], json!("no")), "suggest not a boolean");
        rejects(&set(&["concepts", "0", "suggest"], json!(0)), "suggest a number");
        // Groups: {en, uz}, the text rules, at most 24 characters.
        rejects(&set(&["concepts", "0", "group"], json!("Techniques")), "group not an object");
        rejects(&set(&["concepts", "0", "group"], json!({ "en": "Techniques" })), "group without Uzbek");
        rejects(&set(&["concepts", "0", "group"], json!({ "en": "G".repeat(25), "uz": "Usullar" })), "group over 24");
        rejects(&set(&["concepts", "0", "group"], json!({ "en": "Education", "uz": "Ta'lim" })), "ASCII apostrophe in an Uzbek group");
        rejects(&set(&["concepts", "0", "group"], json!({ "en": " Techniques", "uz": "Usullar" })), "padded group");
        rejects(&set(&["concepts", "0", "prompts"], json!(["only one"])), "one prompt");
        rejects(&set(&["concepts", "0", "prompts"], json!(["a b", "c d", "e f", "g h", "i j", "k l", "m n", "o p", "q r"])), "nine prompts");
        rejects(&set(&["concepts", "0", "prompts"], json!(["one two three four five six seven eight nine", "fine"])), "nine-word prompt");
        rejects(&set(&["concepts", "0", "prompts"], json!(["", "fine"])), "empty prompt");
        rejects(&set(&["concepts", "0", "prompts"], json!([" padded", "fine"])), "padded prompt");
        rejects(&set(&["concepts", "0", "prompts"], json!([format!("long {}", "x".repeat(190)), "fine"])), "prompt over 200 chars with the template");
        rejects(&set(&["concepts", "0", "prompts"], json!(["Same Thing", "same thing"])), "duplicate prompt");
        rejects(&set(&["concepts", "0", "prompts"], json!(["same  thing", "Same thing"])), "duplicate prompt, other spacing");
        rejects(&set(&["concepts", "1", "prompts"], json!(["photo d one", "other"])), "prompt shared by two concepts");
        rejects(&set(&["concepts", "1", "label", "en"], json!("l D ONE")), "label shared by two concepts (case-insensitive)");
        rejects(&set(&["concepts", "1", "label", "uz"], json!("U d one")), "Uzbek label shared");
        rejects(&set(&["concepts", "1", "label", "en"], json!("U d one")), "English label equal to another concept's Uzbek one");
        let mut v = base_value();
        v["concepts"][0]["label"]["uz"] = json!("Qo\u{2018}shiq");
        v["concepts"][1]["label"]["uz"] = json!("Qo\u{2019}shiq");
        rejects(&v, "Uzbek labels that differ only in the apostrophe");
        // A concept's own English and Uzbek labels may be the same.
        let mut v = base_value();
        v["concepts"][0]["label"] = json!({ "en": "Minimal", "uz": "Minimal" });
        assert!(parse_lens(&v.to_string(), false).is_ok());
        rejects(&set(&["concepts", "0", "media"], json!("audio")), "unknown media");
        rejects(&set(&["concepts", "0", "aspect"], json!([2.0, 1.0])), "aspect min above max");
        rejects(&set(&["concepts", "0", "aspect"], json!([0.0, 1.0])), "aspect min zero");
        rejects(&set(&["concepts", "0", "aspect"], json!([1.0, 1.5, 2.0])), "three aspect numbers");
        // Vectors.
        let short = base64::engine::general_purpose::STANDARD.encode(encode_f16(&unit(1)[..511]));
        rejects(&set(&["concepts", "0", "vec"], json!(short)), "511 values");
        rejects(&set(&["concepts", "0", "vec"], json!("not base64!")), "bad base64");
        let mut nan = unit(1);
        nan[3] = f32::NAN;
        rejects(&set(&["concepts", "0", "vec"], json!(encode_vec(&nan))), "NaN");
        let mut inf = unit(1);
        inf[3] = f32::INFINITY;
        rejects(&set(&["concepts", "0", "vec"], json!(encode_vec(&inf))), "infinity");
        let half: Vec<f32> = unit(1).iter().map(|x| x * 0.5).collect();
        rejects(&set(&["concepts", "0", "vec"], json!(encode_vec(&half))), "norm 0.5");
        let long: Vec<f32> = unit(1).iter().map(|x| x * 1.05).collect();
        rejects(&set(&["concepts", "0", "vec"], json!(encode_vec(&long))), "norm 1.05");
        // bar, borrows, size, placeholder.
        rejects(&set(&["bar", "picture"], json!(0.01)), "bar under 0.05");
        rejects(&set(&["bar", "video"], json!(0.99)), "bar over 0.95");
        rejects(&set(&["borrows"], json!(["d_one"])), "a base lens that borrows");
        rejects(&lens_value("motion", "specialist", 1, &[tc("m_x", unit(9))], &["Bad Id"]), "bad borrowed id");
        rejects(&set(&["text_model"], json!("x".repeat(MAX_FILE_BYTES))), "file over 256 KB");
        rejects(&set(&["placeholder"], json!(true)), "placeholder from the catalogue");
        assert!(parse_lens(&set(&["placeholder"], json!(true)).to_string(), true).is_ok(), "placeholder bundled");
        // Missing required fields.
        for key in ["format", "id", "version", "role", "name", "summary", "concepts", "model"] {
            let mut v = base_value();
            v.as_object_mut().unwrap().remove(key);
            rejects(&v, &format!("missing {key}"));
        }
        let mut v = base_value();
        v["concepts"][0].as_object_mut().unwrap().remove("vec");
        rejects(&v, "concept without vec");
    }

    #[test]
    fn set_rules_span_all_lenses() {
        let conn = test_db();
        // No base at all.
        let lone = lens_text("motion", "specialist", 1, &[tc("m_one", unit(11))], &[]);
        assert!(matches!(install_texts(&conn, &[lone]), Err(InstallError::Invalid(_))), "no base");
        // Two bases (a known lens can't be a second base any more, so an id the catalogue
        // doesn't take, through the app's own install).
        let b1 = lens_text("design", "base", 1, &[tc("d_one", unit(1))], &[]);
        let b2 = lens_text("extra", "base", 1, &[tc("t_one", unit(2))], &[]);
        let two: Vec<(Lens, &str)> = [&b1, &b2].iter().map(|t| (parse_lens(t, true).unwrap(), t.as_str())).collect();
        assert!(matches!(install(&conn, &two, Origin::Bundled), Err(InstallError::Invalid(_))), "two bases");
        // The same concept id in two lenses (a shared tag) whose entries both cover every media.
        let dup = lens_text("motion", "specialist", 1, &[TC { prompts: vec!["motion d one".into(), "moving d one".into()], ..tc("d_one", unit(11)) }], &[]);
        assert!(matches!(install_texts(&conn, &[b1.clone(), dup]), Err(InstallError::Invalid(_))), "shared id, overlapping media");
        // …with other labels or another group: one tag has one name.
        let mut v = lens_value("motion", "specialist", 1, &[tc_media("d_one", "video", unit(11))], &[]);
        v["concepts"][0]["label"]["en"] = json!("L d ONE");
        let pic = lens_text("design", "base", 1, &[tc_media("d_one", "picture", unit(1))], &[]);
        assert!(matches!(install_texts(&conn, &[pic.clone(), v.to_string()]), Err(InstallError::Invalid(_))), "shared id, other label");
        let mut v = lens_value("motion", "specialist", 1, &[tc_media("d_one", "video", unit(11))], &[]);
        v["concepts"][0]["group"] = json!({ "en": "Techniques", "uz": "Usullar" });
        let mut p = lens_value("design", "base", 1, &[tc_media("d_one", "picture", unit(1))], &[]);
        p["concepts"][0]["group"] = json!({ "en": "Lettering", "uz": "Harflar" });
        assert!(matches!(install_texts(&conn, &[p.to_string(), v.to_string()]), Err(InstallError::Invalid(_))), "shared id, other group");
        // …or the same prompt in both entries.
        let same = TC { prompts: vec!["photo d one".into(), "clip d one".into()], ..tc_media("d_one", "video", unit(11)) };
        assert!(matches!(install_texts(&conn, &[pic.clone(), lens_text("motion", "specialist", 1, &[same], &[])]), Err(InstallError::Invalid(_))), "shared id, same prompt");
        // A specialist that owns an entry for a tag it borrows covers other media with it.
        let both = lens_text("motion", "specialist", 1, &[TC { prompts: vec!["motion d one".into(), "moving d one".into()], ..tc("d_one", unit(11)) }], &["d_one"]);
        assert!(matches!(install_texts(&conn, &[pic.clone(), both]), Err(InstallError::Invalid(_))), "borrowed and owned for the same media");
        // The same label in two lenses (case-insensitive), per language.
        let mut v = lens_value("motion", "specialist", 1, &[tc("m_one", unit(11))], &[]);
        v["concepts"][0]["label"]["en"] = json!("l D ONE");
        assert!(matches!(install_texts(&conn, &[b1.clone(), v.to_string()]), Err(InstallError::Invalid(_))), "shared label");
        let mut v = lens_value("motion", "specialist", 1, &[tc("m_one", unit(11))], &[]);
        v["concepts"][0]["label"]["uz"] = json!("u d one");
        assert!(matches!(install_texts(&conn, &[b1.clone(), v.to_string()]), Err(InstallError::Invalid(_))), "shared Uzbek label");
        // The same prompt in two lenses.
        let mut v = lens_value("motion", "specialist", 1, &[tc("m_one", unit(11))], &[]);
        v["concepts"][0]["prompts"][0] = json!("Photo d one");
        assert!(matches!(install_texts(&conn, &[b1.clone(), v.to_string()]), Err(InstallError::Invalid(_))), "shared prompt");
        // Borrowing something that isn't a base concept.
        let m = lens_text("motion", "specialist", 1, &[tc("m_one", unit(11))], &["d_nope"]);
        assert!(matches!(install_texts(&conn, &[b1.clone(), m]), Err(InstallError::Invalid(_))), "bad borrow");
        // Nothing of the above got in.
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM lenses", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        // A shared tag whose entries cover other media installs (spec §0c): design describes it for
        // pictures, motion owns it for videos and borrows design's for pictures.
        let vid = lens_text("motion", "specialist", 1, &[tc_media("d_one", "video", unit(11)), tc("m_one", unit(12))], &["d_one"]);
        let other = test_db();
        assert_eq!(install_texts(&other, &[pic, vid]).unwrap().installed.len(), 2, "disjoint media");
        let count = |sql: &str| -> i64 { other.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries WHERE concept_id = 'd_one'"), 2);
        assert_eq!(count("SELECT COUNT(*) FROM concepts WHERE id = 'd_one' AND lens_id = 'motion' AND active = 1"), 1, "one tag, primary lens motion");
        // A good pair installs.
        let m = lens_text("motion", "specialist", 1, &[tc("m_one", unit(11))], &["d_one"]);
        assert_eq!(install_texts(&conn, &[b1, m]).unwrap().installed.len(), 2);
    }

    #[test]
    fn install_is_all_or_nothing() {
        let conn = test_db();
        let [d, m, t]: [String; 3] = standard_texts(1).try_into().unwrap();
        // A broken specialist (its entry for the base's concept covers the same media) stops the whole set.
        let bad = lens_text("thumbnail", "specialist", 1, &[TC { prompts: vec!["thumb d two".into(), "cover d two".into()], ..tc("d_two", unit(30)) }], &[]);
        assert!(matches!(install_texts(&conn, &[d.clone(), m.clone(), bad]), Err(InstallError::Invalid(_))));
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM lenses"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM concepts"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries"), 0);

        let r = install_texts(&conn, &[d.clone(), m.clone(), t.clone()]).unwrap();
        assert_eq!(r.installed.len(), 3);
        assert_eq!(count("SELECT COUNT(*) FROM concepts WHERE active = 1"), 9);
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries"), 9);
        assert_storage_matches(&conn);

        // An update where one file is fine and one breaks a cross-lens rule changes nothing.
        let [d2, _, _]: [String; 3] = standard_texts(2).try_into().unwrap();
        let m2_bad = lens_text("motion", "specialist", 2, &[tc("t_one", unit(40))], &[]);
        assert!(install_texts(&conn, &[d2.clone(), m2_bad]).is_err());
        assert_eq!(count("SELECT COUNT(*) FROM lenses WHERE version = 1"), 3);
        assert_eq!(count("SELECT COUNT(*) FROM lenses WHERE prev_json IS NOT NULL"), 0);

        // Dropping a concept a specialist borrows breaks the set too.
        let d2_no_borrowed = lens_text("design", "base", 2, &[tc("d_two", unit(2)), tc("d_three", unit(3))], &[]);
        assert!(install_texts(&conn, &[d2_no_borrowed]).is_err());
        assert_eq!(count("SELECT COUNT(*) FROM lenses WHERE version = 1"), 3);
        assert_storage_matches(&conn);
    }

    #[test]
    fn updates_keep_prev_json_and_enabled_never_downgrade_and_keep_concepts() {
        let conn = test_db();
        let v1 = standard_texts(1);
        install_texts(&conn, &v1).unwrap();
        conn.execute("UPDATE lenses SET enabled = 1 WHERE id = 'motion'", []).unwrap();

        // v2 of motion drops m_three and adds m_four.
        let m2 = lens_text("motion", "specialist", 2, &[tc("m_one", unit(11)), tc("m_two", unit(12)), tc("m_four", unit(14))], &["d_one"]);
        let r = install_texts(&conn, &[m2.clone()]).unwrap();
        assert_eq!(r, InstallReport { installed: vec!["motion".into()], unchanged: vec![] });
        let (version, enabled, prev, file): (i64, i64, String, String) = conn.query_row(
            "SELECT version, enabled, prev_json, file_json FROM lenses WHERE id = 'motion'", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!((version, enabled), (2, 1));
        assert_eq!(prev, v1[1]);
        assert_eq!(file, m2);
        let active = |id: &str| -> i64 { conn.query_row("SELECT active FROM concepts WHERE id = ?1", [id], |r| r.get(0)).unwrap() };
        assert_eq!(active("m_three"), 0, "dropped concepts stay, inactive");
        assert_eq!(active("m_four"), 1);

        // Same or lower versions are unchanged, from the catalogue or the app.
        let unchanged = InstallReport { installed: vec![], unchanged: vec!["motion".into()] };
        assert_eq!(install_texts(&conn, &[v1[1].clone()]).unwrap(), unchanged, "older");
        assert_eq!(install_texts(&conn, &[m2.clone()]).unwrap(), unchanged, "same version");
        let files = vec![(parse_lens(&v1[1], true).unwrap(), v1[1].as_str())];
        assert_eq!(install(&conn, &files, Origin::Bundled).unwrap().installed.len(), 0, "bundled never downgrades");
        let v: i64 = conn.query_row("SELECT version FROM lenses WHERE id = 'motion'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
    }

    #[test]
    fn duplicate_files_in_one_call_are_refused() {
        let conn = test_db();
        let v = standard_texts(1);
        assert!(matches!(install_texts(&conn, &[v[0].clone(), v[0].clone()]), Err(InstallError::Invalid(_))));
    }

    #[test]
    fn real_bundled_file_replaces_a_placeholder_of_the_same_version() {
        let conn = test_db();
        let mut ph = lens_value("design", "base", 1, &[tc("ph_one", unit(50))], &[]);
        ph["placeholder"] = json!(true);
        let ph = ph.to_string();
        install(&conn, &[(parse_lens(&ph, true).unwrap(), ph.as_str())], Origin::Bundled).unwrap();
        assert!(Catalogue::load(&conn).scoring_base().is_none(), "placeholders are never scored");
        let real = lens_text("design", "base", 1, &[tc("d_one", unit(1))], &[]);
        let r = install(&conn, &[(parse_lens(&real, true).unwrap(), real.as_str())], Origin::Bundled).unwrap();
        assert_eq!(r.installed, vec!["design".to_string()]);
        assert!(Catalogue::load(&conn).scoring_base().is_some());
        // …and a placeholder never replaces a real lens.
        let mut ph2 = lens_value("design", "base", 5, &[tc("ph_one", unit(50))], &[]);
        ph2["placeholder"] = json!(true);
        let ph2 = ph2.to_string();
        let r = install(&conn, &[(parse_lens(&ph2, true).unwrap(), ph2.as_str())], Origin::Bundled).unwrap();
        assert!(r.installed.is_empty());
    }

    #[test]
    fn unreadable_rows_and_placeholders_give_way_to_real_files() {
        let conn = test_db();
        // A stored row that no longer parses counts as missing, whatever its version.
        conn.execute("INSERT INTO lenses (id, version, sha256, origin, role, file_json, enabled, installed_at, updated_at)
                      VALUES ('design', 9, 'x', 'catalogue', 'base', '{broken', 1, 0, 0)", []).unwrap();
        let real = lens_text("design", "base", 1, &[tc("d_one", unit(1))], &[]);
        assert_eq!(install_texts(&conn, &[real]).unwrap().installed, vec!["design".to_string()]);
        let enabled: i64 = conn.query_row("SELECT enabled FROM lenses WHERE id = 'design'", [], |r| r.get(0)).unwrap();
        assert_eq!(enabled, 1, "the on/off flag survives");
        // A catalogue file replaces a placeholder too, even at the same version.
        let mut ph = lens_value("motion", "specialist", 1, &[tc("ph_m", unit(60))], &[]);
        ph["placeholder"] = json!(true);
        let ph = ph.to_string();
        install(&conn, &[(parse_lens(&ph, true).unwrap(), ph.as_str())], Origin::Bundled).unwrap();
        let real_m = lens_text("motion", "specialist", 1, &[tc("m_one", unit(11))], &[]);
        assert_eq!(install_texts(&conn, &[real_m]).unwrap().installed, vec!["motion".to_string()]);
        assert!(!Catalogue::load(&conn).get("motion").unwrap().placeholder);
    }

    #[test]
    fn the_catalogue_installs_only_the_three_known_lenses() {
        let conn = test_db();
        let d = lens_text("design", "base", 1, &[tc("d_one", unit(1))], &[]);
        let promo = lens_text("promo", "specialist", 1, &[tc("p_one", unit(2))], &[]);
        assert!(parse_lens(&promo, false).is_ok(), "a valid file in itself");
        assert!(matches!(install_texts(&conn, &[d.clone(), promo.clone()]), Err(InstallError::Invalid(_))));
        assert!(matches!(install_texts(&conn, &[promo]), Err(InstallError::Invalid(_))));
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM lenses", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "nothing installed");
        assert_eq!(install_texts(&conn, &[d]).unwrap().installed, vec!["design".to_string()]);
    }

    #[test]
    fn a_stored_file_over_the_version_cap_gives_way_to_the_bundled_copy() {
        // A file with a huge version installed before the cap existed: nothing newer could ever
        // replace it. It no longer parses, so the bundled copy takes its place at the next start.
        let conn = test_db();
        let poisoned = lens_text("design", "base", i64::MAX, &[tc("d_one", unit(1))], &[]);
        conn.execute("INSERT INTO lenses (id, version, sha256, origin, role, file_json, enabled, installed_at, updated_at)
                      VALUES ('design', ?1, 'x', 'catalogue', 'base', ?2, 1, 0, 0)", params![i64::MAX, poisoned]).unwrap();
        let r = install_bundled(&conn).unwrap();
        assert!(r.installed.contains(&"design".to_string()), "{r:?}");
        let bundled = parse_lens(BUNDLED[1].1, true).unwrap();
        let (version, origin, enabled, file, prev): (i64, String, i64, String, String) = conn.query_row(
            "SELECT version, origin, enabled, file_json, prev_json FROM lenses WHERE id = 'design'", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap();
        assert_eq!((version, origin.as_str(), enabled), (bundled.version, "bundled", 1));
        assert_eq!(file, BUNDLED[1].1);
        assert_eq!(prev, poisoned);
        assert_eq!(Catalogue::load(&conn).get("design").map(|l| l.version), Some(bundled.version));
    }

    #[test]
    fn installing_a_lens_turns_its_stand_in_concepts_into_real_ones() {
        // Pack import keeps a lens tag whose concept no lens here has, with a stand-in row
        // (lens_id '', the pack's name as label, no vector, inactive).
        let conn = test_db();
        for (id, name) in [("d_one", "Pack name"), ("zz_waiting", "Still waiting")] {
            conn.execute("INSERT INTO concepts (id, lens_id, labels_json, media, aspect_json, vec, active, updated_at)
                          VALUES (?1, '', ?2, 'any', NULL, x'', 0, 0)",
                params![id, json!({ "en": name, "uz": name }).to_string()]).unwrap();
        }
        install_texts(&conn, &standard_texts(1)).unwrap();
        let row = |id: &str| -> (String, String, i64, usize) { conn.query_row(
            "SELECT lens_id, labels_json, active, length(vec) FROM concepts WHERE id = ?1", [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap() };
        let (lens, labels, active, _) = row("d_one");
        assert_eq!((lens.as_str(), active), ("design", 1));
        assert_eq!(parse_labels(&labels).unwrap().en, "L d one");
        let vec_len: usize = conn.query_row(
            "SELECT length(vec) FROM concept_entries WHERE concept_id = 'd_one' AND lens_id = 'design'", [], |r| r.get(0)).unwrap();
        assert_eq!(vec_len, DIM * 4, "the real vector, in its entry");
        // A lens update that drops concepts never touches a stand-in.
        let m2 = lens_text("motion", "specialist", 2, &[tc("m_one", unit(11))], &["d_one"]);
        install_texts(&conn, &[m2]).unwrap();
        let (lens, labels, active, vec_len) = row("zz_waiting");
        assert_eq!((lens.as_str(), active, vec_len), ("", 0, 0));
        assert_eq!(parse_labels(&labels).unwrap().en, "Still waiting");
        let listed = list_concepts_with(&conn, &Catalogue::load(&conn)).unwrap();
        let waiting = listed.iter().find(|c| c.id == "zz_waiting").unwrap();
        assert!(!waiting.active && waiting.entries.is_empty() && waiting.borrowed_by.is_empty());
        assert_storage_matches(&conn);
        // Nothing scores from a stand-in: the scorer reads the installed files only.
        assert!(Catalogue::load(&conn).lenses.iter().all(|l| l.concepts.iter().all(|c| c.id != "zz_waiting")));
    }

    #[test]
    fn bundled_lenses_parse_and_install_together() {
        let mut parsed = Vec::new();
        for (id, text) in BUNDLED {
            let l = parse_lens(text, true).unwrap_or_else(|e| panic!("bundled lens '{id}': {e}"));
            assert_eq!(l.id, id);
            if l.placeholder { eprintln!("note: bundled lens '{id}' is still a placeholder"); }
            parsed.push(l);
        }
        // What to expect comes from the files (their content changes; nothing here is hardcoded).
        let entries: usize = parsed.iter().map(|l| l.concepts.len()).sum();
        let mut per_id: HashMap<&str, i64> = HashMap::new();
        for c in parsed.iter().flat_map(|l| l.concepts.iter()) { *per_id.entry(c.id.as_str()).or_default() += 1; }
        let hand = parsed.iter().flat_map(|l| l.concepts.iter()).filter(|c| !c.suggest).count();
        let shared = per_id.values().filter(|n| **n > 1).count();
        eprintln!("bundled: {entries} entries, {} tags, {shared} shared, {hand} add-by-hand; versions {:?}",
            per_id.len(), parsed.iter().map(|l| (l.id.as_str(), l.version)).collect::<Vec<_>>());
        let conn = test_db();
        let r = install_bundled(&conn).unwrap();
        assert_eq!(r.installed.len(), 3, "{r:?}");
        let cat = Catalogue::load(&conn);
        assert_eq!(cat.lenses.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), LENS_ORDER.to_vec());
        assert_eq!(cat.get("design").map(|l| l.role), Some(Role::Base));
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries"), entries as i64);
        assert_eq!(count("SELECT COUNT(*) FROM concepts WHERE active = 1"), per_id.len() as i64);
        for (id, n) in per_id.iter().filter(|(_, n)| **n > 1) {
            let rows: i64 = conn.query_row("SELECT COUNT(*) FROM concept_entries WHERE concept_id = ?1", [id], |r| r.get(0)).unwrap();
            assert_eq!(rows, *n, "'{id}' has an entry in {n} lenses");
        }
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries WHERE suggest = 0 AND media IS NULL AND vec IS NULL"), hand as i64);
        assert_storage_matches(&conn);
        // A second start changes nothing.
        reload_cache(&conn);
        let changes = |conn: &Connection| -> i64 { conn.query_row("SELECT total_changes()", [], |r| r.get(0)).unwrap() };
        let before = changes(&conn);
        let r = install_bundled(&conn).unwrap();
        assert!(r.installed.is_empty() && r.unchanged.len() == 3);
        assert_eq!(changes(&conn), before, "nothing written");
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let conn = test_db();
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        let cols = |t: &str| -> Vec<String> {
            let mut s = conn.prepare(&format!("PRAGMA table_info({t})")).unwrap();
            s.query_map([], |r| r.get::<_, String>(1)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert!(cols("tags").contains(&"concept_id".to_string()));
        assert!(cols("inspirations").contains(&"auto_tag_sig".to_string()));
        assert!(cols("inspirations").contains(&"lens_suggestions".to_string()));
        for t in ["lenses", "concepts", "concept_entries", "tag_answers", "clip_frames", "clip_embeddings"] {
            assert!(!cols(t).is_empty(), "{t}");
        }
    }

    #[test]
    fn the_suggestions_column_arrives_with_a_rescore() {
        // A library from before lens_suggestions: the column comes at the next start, in the same
        // step every signature is cleared (the new column is empty), and only that once.
        let conn = test_db();
        conn.execute_batch(
            "INSERT INTO inspirations (id, type, stored_path, created_at, updated_at, auto_tag_sig, auto_tag_status, auto_tag_confidence)
                 VALUES ('a', 'image', 'x', 0, 0, 'old-sig', 'done', '{\"web_design\":0.5}');
             ALTER TABLE inspirations DROP COLUMN lens_suggestions;").unwrap();
        let row = |conn: &Connection| -> (Option<String>, Option<String>, Option<String>) { conn.query_row(
            "SELECT auto_tag_sig, auto_tag_status, auto_tag_confidence FROM inspirations WHERE id = 'a'", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap() };
        ensure_schema(&conn).unwrap();
        assert!(has_column(&conn, "inspirations", "lens_suggestions").unwrap());
        assert_eq!(row(&conn), (None, Some("done".into()), Some(r#"{"web_design":0.5}"#.into())),
            "the signature goes (re-score), the rest stays for tagging.rs");
        conn.execute("UPDATE inspirations SET auto_tag_sig = 'new-sig', lens_suggestions = '{}'", []).unwrap();
        ensure_schema(&conn).unwrap();
        assert_eq!(row(&conn).0.as_deref(), Some("new-sig"), "only when the column was added");
        // The empty-grid gotcha: the item queries select the column right after migrate.
        let fresh = Connection::open_in_memory().unwrap();
        crate::db::migrate(&fresh).unwrap();
        assert!(has_column(&fresh, "inspirations", "lens_suggestions").unwrap());
    }

    #[test]
    fn a_busy_database_is_tried_once_more_for_the_suggestions_column() {
        // DS-2: every item query selects lens_suggestions, so adding it isn't optional. When the
        // database is busy (another connection holds the write lock past the busy timeout) the
        // step is tried once more; when it stays busy that is reported, and the next start adds it.
        let busy = || rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY), None);
        let mut calls = 0;
        let r: rusqlite::Result<i32> = once_more_if_busy(|| { calls += 1; if calls == 1 { Err(busy()) } else { Ok(7) } }, std::time::Duration::ZERO);
        assert_eq!((r.unwrap(), calls), (7, 2), "busy once: the second try counts");
        let mut calls = 0;
        let r: rusqlite::Result<i32> = once_more_if_busy(|| { calls += 1; Err(rusqlite::Error::InvalidQuery) }, std::time::Duration::ZERO);
        assert!(r.is_err());
        assert_eq!(calls, 1, "only a busy database is tried again");

        // Two connections to one file; the other one holds the write lock all along.
        let dir = std::env::temp_dir().join(format!("qooti-busy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("qooti.db");
        let conn = Connection::open(&path).unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch("ALTER TABLE inspirations DROP COLUMN lens_suggestions;").unwrap();
        conn.busy_timeout(std::time::Duration::ZERO).unwrap();
        let other = Connection::open(&path).unwrap();
        other.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let err = ensure_suggestions_column(&conn).unwrap_err();
        assert!(is_busy(&err), "{err}");
        assert!(ensure_schema(&conn).is_err(), "ensure_schema reports it");
        assert!(!has_column(&conn, "inspirations", "lens_suggestions").unwrap());
        // Why it is an error: without the column the item queries fail (an empty grid)
        assert!(conn.prepare("SELECT id, lens_suggestions FROM inspirations").is_err());
        other.execute_batch("COMMIT;").unwrap();
        // The next start
        ensure_schema(&conn).unwrap();
        assert!(has_column(&conn, "inspirations", "lens_suggestions").unwrap());
        assert!(conn.prepare("SELECT id, lens_suggestions FROM inspirations").is_ok());
        drop((conn, other));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn labels_never_hold_an_underscore() {
        // Every name the app shows from a lens file (tag labels, groups, lens names and summaries)
        // is refused with "_": shown as it is, it would read as an internal id (check.mjs text.underscore).
        let mut cases: Vec<(Value, &str)> = Vec::new();
        for (path, text) in [
            (vec!["concepts", "0", "label", "en"], "Web_design"),
            (vec!["concepts", "0", "label", "uz"], "Veb_sayt"),
            (vec!["name", "en"], "Graphic_designer"),
            (vec!["summary", "uz"], "Posterlar_SMD"),
        ] {
            let mut v = base_value();
            let mut cur = &mut v;
            for k in &path[..path.len() - 1] {
                cur = if let Ok(i) = k.parse::<usize>() { &mut cur[i] } else { &mut cur[*k] };
            }
            cur[*path.last().unwrap()] = json!(text);
            cases.push((v, text));
        }
        let mut v = base_value();
        v["concepts"][1]["group"] = json!({ "en": "Social_media", "uz": "Ijtimoiy" });
        cases.push((v, "Social_media"));
        for (v, text) in cases {
            let err = parse_lens(&v.to_string(), false).unwrap_err();
            assert!(err.contains("contains _"), "{text}: {err}");
        }
        // Spaces, hyphens and ‘ ’ are fine; the concept id itself keeps its underscore.
        let mut v = base_value();
        v["concepts"][0]["label"] = json!({ "en": "Web design", "uz": "Veb-sayt o‘yin" });
        let l = parse_lens(&v.to_string(), false).unwrap();
        assert_eq!(l.concepts[0].id, "d_one");
        // The bundled lenses pass.
        for (id, text) in BUNDLED { assert!(parse_lens(text, true).is_ok(), "{id}"); }
    }

    #[test]
    fn lists_in_fixed_order_with_borrowers() {
        let conn = test_db();
        install_texts(&conn, &standard_texts(1)).unwrap();
        conn.execute("UPDATE lenses SET enabled = 1 WHERE id = 'thumbnail'", []).unwrap();
        let cat = Catalogue::load(&conn);
        let lenses = list_lenses_with(&conn, &cat).unwrap();
        assert_eq!(lenses.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), vec!["motion", "design", "thumbnail"]);
        assert_eq!(lenses[0].borrows, vec!["d_one".to_string()]);
        assert_eq!(lenses[0].concepts, vec!["m_one", "m_two", "m_three"]);
        assert!(lenses[2].enabled && !lenses[0].enabled);
        assert!(lenses[1].updated_at > 0);
        let concepts = list_concepts_with(&conn, &cat).unwrap();
        assert_eq!(concepts.len(), 9);
        assert_eq!(concepts[0].id, "m_one");
        let d_one = concepts.iter().find(|c| c.id == "d_one").unwrap();
        assert_eq!(d_one.entries, vec![EntryInfo { lens_id: "design".into(), media: Some("any".into()), suggest: true }]);
        assert_eq!(d_one.borrowed_by, vec!["motion".to_string()]);
        assert_eq!((d_one.lens_id.as_str(), d_one.labels.en.as_str(), d_one.group.is_none()), ("design", "L d one", true));
        let json = serde_json::to_value(&lenses[0]).unwrap();
        for k in ["id", "role", "version", "enabled", "origin", "name", "summary", "updated_at", "concepts", "borrows"] {
            assert!(json.get(k).is_some(), "{k}");
        }
        // The row shape the page reads (PORT-PLAN §3.4).
        let json = serde_json::to_value(d_one).unwrap();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        for k in ["id", "lens_id", "labels", "group", "active", "entries", "borrowed_by"] { assert!(keys.contains(&k), "{k}"); }
        assert_eq!(keys.len(), 7, "{keys:?}");
        assert!(json["group"].is_null());
        assert_eq!(json["entries"], json!([{ "lens_id": "design", "media": "any", "suggest": true }]));
    }

    #[test]
    fn valid_fixtures_install_together() {
        // The tools' three valid lenses (spec §0c): d_type is a tag with a design entry for pictures
        // and a motion entry for videos (motion borrows design's), d_brand is added by hand in design
        // and thumbnail, m_meme in motion, and some motion entries have a group.
        let texts = valid_fixture_texts();
        let raw: Vec<Value> = texts.iter().map(|t| serde_json::from_str(t).unwrap()).collect();
        let entries: usize = raw.iter().map(|v| v["concepts"].as_array().unwrap().len()).sum();
        let ids: HashSet<&str> = raw.iter().flat_map(|v| v["concepts"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap())).collect();
        let conn = test_db();
        assert_eq!(install_texts(&conn, &texts).unwrap().installed.len(), 3);
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries"), entries as i64);
        assert_eq!(count("SELECT COUNT(*) FROM concepts WHERE active = 1"), ids.len() as i64);
        assert_storage_matches(&conn);
        let cat = Catalogue::load(&conn);
        let listed = list_concepts_with(&conn, &cat).unwrap();
        let row = |id: &str| listed.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("{id}"));
        let entry = |lens: &str, media: Option<&str>, suggest: bool| EntryInfo { lens_id: lens.into(), media: media.map(str::to_string), suggest };
        let d_type = row("d_type");
        assert_eq!(d_type.entries, vec![entry("motion", Some("video"), true), entry("design", Some("picture"), true)]);
        assert_eq!((d_type.lens_id.as_str(), d_type.borrowed_by.clone()), ("motion", vec!["motion".to_string()]));
        assert_eq!(d_type.group.as_ref().map(|g| g.en.as_str()), Some("Techniques"), "the group motion's entry gives");
        let d_brand = row("d_brand");
        assert_eq!(d_brand.entries, vec![entry("design", None, false), entry("thumbnail", None, false)]);
        assert_eq!((d_brand.lens_id.as_str(), d_brand.active), ("design", true));
        let m_meme = row("m_meme");
        assert_eq!(m_meme.entries, vec![entry("motion", None, false)]);
        assert_eq!(m_meme.group, Some(I18n { en: "Social".into(), uz: "Ijtimoiy".into() }));
        assert_eq!(row("d_photo").borrowed_by, vec!["thumbnail".to_string()]);
        // Lens rows list every entry, add-by-hand ones included, in file order.
        let lenses = list_lenses_with(&conn, &cat).unwrap();
        for (l, v) in lenses.iter().zip(["motion", "design", "thumbnail"]) { assert_eq!(l.id, v); }
        let motion_ids: Vec<&str> = raw[1]["concepts"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(lenses[0].concepts, motion_ids);
        // Each tag is one row, in its primary entry's order.
        assert_eq!(listed.len(), ids.len());
        assert_eq!(listed.iter().take(5).map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["m_green", "m_screen", "m_render", "d_type", "m_meme"]);
    }

    #[test]
    fn catalogue_shows_per_media() {
        // Spec §0c display rule on the valid fixtures: a lens shows a key on a media with its own
        // entry covering it, or (a specialist) by borrowing it while design's entry covers it.
        let conn = test_db();
        install_texts(&conn, &valid_fixture_texts()).unwrap();
        let cat = Catalogue::load(&conn);
        let all: Vec<&str> = {
            let mut v: Vec<&str> = cat.lenses.iter().flat_map(|l| l.concepts.iter().map(|c| c.id.as_str()).chain(l.borrows.iter().map(|b| b.as_str()))).collect();
            v.sort();
            v.dedup();
            v
        };
        let shown = |lens: &str, m: Media| -> Vec<&str> {
            let l = cat.get(lens).unwrap();
            all.iter().copied().filter(|k| cat.shows(l, k, m)).collect()
        };
        let sorted = |mut v: Vec<&'static str>| { v.sort(); v };
        assert_eq!(shown("motion", Media::Picture), sorted(vec!["d_type", "d_dark", "m_green", "m_render"]));
        assert_eq!(shown("thumbnail", Media::Picture), sorted(vec!["t_face", "t_thumb", "d_photo"]));
        assert_eq!(shown("design", Media::Picture), sorted(vec!["d_poster", "d_logo", "d_photo", "d_story", "d_dark", "d_type"]));
        assert_eq!(shown("motion", Media::Video), sorted(vec!["d_type", "d_dark", "m_green", "m_screen", "m_render"]));
        assert_eq!(shown("design", Media::Video), sorted(vec!["d_poster", "d_logo", "d_photo", "d_story", "d_dark"]));
        assert_eq!(shown("thumbnail", Media::Video), vec!["d_photo"]);
        // How motion shows d_type: by borrowing design's on pictures, with its own entry on videos.
        let motion = cat.get("motion").unwrap();
        assert!(!motion.concepts.iter().any(|c| c.id == "d_type" && c.covers(Media::Picture)));
        assert!(motion.concepts.iter().any(|c| c.id == "d_type" && c.covers(Media::Video)));
        assert_eq!(cat.primary_lens("d_type").map(|l| l.id.as_str()), Some("motion"));
        assert_eq!(cat.primary_lens("d_brand").map(|l| l.id.as_str()), Some("design"));
        assert_eq!(cat.borrowers("d_dark").iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), vec!["motion"]);
        assert_eq!(cat.base().map(|l| l.id.as_str()), Some("design"));
        assert!(cat.entries_of("nope").is_empty() && cat.primary_lens("nope").is_none());
    }

    /// A source case of the tools as a built file: the build-only fields, and a vec for every scored
    /// entry (the valid fixture's for the same lens and id, else a made-up unit vector).
    fn built_from_source(obj: &mut Value, lens: &str, vecs: &HashMap<(String, String), Value>) {
        let Some(o) = obj.as_object_mut() else { return };
        for (k, v) in [("format", json!(2)), ("model", json!(MODEL)), ("template", json!("This is a photo of {p}")),
                       ("min_app", json!("1.2.3")), ("updated_at", json!("2026-11-18")), ("text_model", json!("test"))] {
            o.insert(k.into(), v);
        }
        for c in o.get_mut("concepts").and_then(|c| c.as_array_mut()).into_iter().flatten().filter_map(|c| c.as_object_mut()) {
            if c.get("suggest") == Some(&json!(false)) || c.contains_key("vec") { continue; }
            let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let seed = id.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
            let vec = vecs.get(&(lens.to_string(), id)).cloned().unwrap_or_else(|| json!(encode_vec(&unit(seed))));
            c.insert("vec".into(), vec);
        }
    }

    /// Parse every file, then install them on a fresh database. Err: the reason it was refused.
    fn try_install(texts: &[String], origin: Origin) -> Result<InstallReport, String> {
        let mut files = Vec::new();
        for t in texts { files.push((parse_lens(t, origin == Origin::Bundled)?, t.as_str())); }
        install(&test_db(), &files, origin).map_err(|e| e.to_string())
    }

    #[test]
    fn fixture_validation_cases() {
        // PORT-NOTES §7.6: the tools' one-rule-broken files (invalid/cases.json), each in place of its
        // valid twin (or added next to them), go through parse_lens and an install from the catalogue.
        // Rust refuses every error case except the ones only Node checks; warnings install.
        const NODE_ONLY: [&str; 15] = [
            "lens-filename", "source-has-vec", "source-has-build-key", "prompt-too-many-tokens", "built-same-version",
            "lens-unknown-id", "media-missing", "bar-missing", "borrows-twice", "prompt-braces", "about-not-text",
            "lens-unknown-key", "concept-unknown-key", "built-updated-at", "built-text-model",
        ];
        const PLACEHOLDER: &str = "built-placeholder-warning";
        let valid: Vec<(String, String)> = ["design", "motion", "thumbnail"].iter()
            .map(|id| { let f = format!("qooti-lens-{id}.json"); let t = fixture_text(&format!("valid/built/{f}")); (f, t) }).collect();
        let mut vecs: HashMap<(String, String), Value> = HashMap::new();
        for (_, t) in &valid {
            let v: Value = serde_json::from_str(t).unwrap();
            for c in v["concepts"].as_array().unwrap().iter().filter(|c| c.get("vec").is_some()) {
                vecs.insert((v["id"].as_str().unwrap().to_string(), c["id"].as_str().unwrap().to_string()), c["vec"].clone());
            }
        }
        let cases: Value = serde_json::from_str(&fixture_text("invalid/cases.json")).unwrap();
        let cases = cases.as_array().unwrap();
        let names: HashSet<&str> = cases.iter().map(|c| c["name"].as_str().unwrap()).collect();
        for n in NODE_ONLY.iter().chain([&PLACEHOLDER]) { assert!(names.contains(n), "cases.json has no '{n}'"); }
        let (mut refused, mut installed, mut node_only) = (0, 0, 0);
        let mut wrong = Vec::new();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let target = case["target"].as_str().unwrap();
            let source = case["kind"] == "source";
            let lens = target.trim_start_matches("qooti-lens-").trim_end_matches(".json");
            let mut obj: Value = serde_json::from_str(&fixture_text(&format!("invalid/{}", case["file"].as_str().unwrap()))).unwrap();
            if source { built_from_source(&mut obj, lens, &vecs); }
            let file = format!("qooti-lens-{lens}.json");
            let mut texts: Vec<String> = valid.iter().filter(|(f, _)| *f != file).map(|(_, t)| t.clone()).collect();
            texts.push(obj.to_string());
            let outcome = try_install(&texts, Origin::Catalogue);
            let level = case["expect"]["level"].as_str().unwrap();
            println!("{name:32} {level:7} {}", match &outcome { Ok(r) => format!("installs {:?}", r.installed), Err(e) => format!("refused: {e}") });
            if NODE_ONLY.contains(&name) { node_only += 1; continue; }
            if name == PLACEHOLDER {
                // A placeholder only comes with the app.
                let bundled = try_install(&texts, Origin::Bundled);
                if outcome.is_ok() || bundled.as_ref().map(|r| r.installed.len()) != Ok(3) { wrong.push(format!("{name}: {outcome:?} / bundled {bundled:?}")); }
                continue;
            }
            match (level, &outcome) {
                ("error", Err(_)) => refused += 1,
                ("warning", Ok(r)) if r.installed.len() == 3 => installed += 1,
                _ => wrong.push(format!("{name} ({level}): {outcome:?}")),
            }
        }
        println!("{} cases: {refused} refused, {installed} warnings installed, the placeholder from the app only, {node_only} Node-only", cases.len());
        assert!(wrong.is_empty(), "{wrong:#?}");
        assert_eq!(node_only, NODE_ONLY.len());
        assert_eq!(refused + installed + node_only + 1, cases.len());
    }

    #[test]
    fn sync_is_idempotent() {
        let conn = test_db();
        install_bundled(&conn).unwrap();
        let cat = Catalogue::load(&conn);
        let changes = |conn: &Connection| -> i64 { conn.query_row("SELECT total_changes()", [], |r| r.get(0)).unwrap() };
        let before = changes(&conn);
        assert!(sync_catalogue(&conn, &cat).unwrap().skipped, "the install stored the same set");
        assert_eq!(changes(&conn), before);
        let entries: i64 = cat.lenses.iter().map(|l| l.concepts.len() as i64).sum();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        // Rows gone missing: the next start stores them again.
        conn.execute("DELETE FROM concept_entries", []).unwrap();
        install_bundled(&conn).unwrap();
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries"), entries);
        assert_storage_matches(&conn);
        // A table gone missing comes back with migrate, and its rows at the next start.
        conn.execute_batch("DROP TABLE concept_entries").unwrap();
        crate::db::migrate(&conn).unwrap();
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries"), 0);
        let r = sync_catalogue(&conn, &Catalogue::load(&conn)).unwrap();
        assert!(!r.skipped && r.entries as i64 == entries && r.concepts == 0 && r.retired == 0, "{r:?}");
        assert_storage_matches(&conn);
        // Another set (a changed fingerprint) is stored again too; nothing installed: nothing changes.
        conn.execute("UPDATE schema_meta SET value = 'x' WHERE key = ?1", [SYNC_KEY]).unwrap();
        assert!(!sync_catalogue(&conn, &Catalogue::load(&conn)).unwrap().skipped);
        let before = changes(&conn);
        assert!(sync_catalogue(&conn, &Catalogue::default()).unwrap().skipped);
        assert_eq!(changes(&conn), before);
        assert_storage_matches(&conn);
    }

    /// The list JSON the page gets for the valid fixtures, for the web side's display check
    /// (PORT-PLAN §5.3):
    ///   QOOTI_LIST_DUMP=<out.json> cargo test --lib dump_fixture_lists -- --ignored
    #[test]
    #[ignore]
    fn dump_fixture_lists() {
        let conn = test_db();
        install_texts(&conn, &valid_fixture_texts()).unwrap();
        let cat = Catalogue::load(&conn);
        let doc = json!({ "lenses": list_lenses_with(&conn, &cat).unwrap(), "concepts": list_concepts_with(&conn, &cat).unwrap() });
        let out = std::env::var("QOOTI_LIST_DUMP").expect("QOOTI_LIST_DUMP");
        std::fs::write(&out, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
        println!("wrote {} lenses and {} concepts to {out}", doc["lenses"].as_array().unwrap().len(), doc["concepts"].as_array().unwrap().len());
    }

    #[test]
    fn versions_compare() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.10.0-beta.1"), Some((1, 10, 0)));
        assert!(parse_version("1.2").is_none() && parse_version("1.2.x").is_none() && parse_version("1.2.3.4").is_none());
        assert!(parse_version("1.2.10") > parse_version("1.2.9"));
    }
}
