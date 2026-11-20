// Tag suggestions from Tag lenses (spec: qooti 2.0/MD/qooti-tag-lens-spec.md §4.1, §5, §6.3):
// the scorer, the single write path, answers, the scoring signature, status counts and the
// one-time upgrade step.
//
// Vectors are made once by the CLIP indexer (clip.rs): one per picture, 8 to 32 per video. The
// scorer only reads them, so installing or updating a lens re-scores the library in milliseconds.
// Every installed lens is scored, on or off: turning a lens on or off only filters what the page
// shows. Anchored scoring (the 2026-11-16 study's S5): the base lens is scored on its own, and
// each specialist over the base concepts plus its own, so the base output never depends on what
// else is installed and specialists never compete with each other. Pools are per item media
// (spec §0c): only the scored entries that cover it take part, and a tag's entries in several
// lenses cover disjoint media, so one pool at most can suggest it on an item.
// scripts/lenses/lens-score.mjs mirrors §5 for the measuring tools.
//
// Each item's suggestions live in `inspirations.lens_suggestions`. Never in `auto_tag_confidence`:
// older qooti versions (1.2.2) show every key there as a tag name ("web_design") and make tags of
// them on Add, so that column is emptied at every start, and tags they made are given back their
// lens tag or a readable name (adopt_older_build_tags).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::lenses::{self, lock_db, Catalogue, Concept, I18n, InstallError, InstallReport, Lens, Media, Origin};
use crate::AppState;

/// `inspirations.auto_tag_model` of suggestions written here.
pub const SCORE_MODEL: &str = "lens-1";
/// The scorer version: 2 since the same-name rule and the video length rule (spec §0b.1–3), 3
/// since the shared-tag model (spec §0c: entries per media, add-by-hand entries never scored), 4
/// since the video rule of 2026-11-20 (R45: one frame per second, a 45 % share, videos up to 60 s).
const SIG_PREFIX: &str = "lens-score-4|clip-b32-q8|";
/// Items per write transaction; the database is released between chunks.
pub const CHUNK: usize = 500;
const PICTURE_MAX: usize = 3;
const VIDEO_MAX: usize = 2;
/// Preferences (strings).
pub const PREF_SWITCH: &str = "tag_recommendations_enabled";
pub const PREF_ROLE: &str = "user_role";
pub const PREF_LAST_CHECK: &str = "lens_last_check";
const MIGRATED_KEY: &str = "lens_v1_migrated";
const STATUS_GAP: Duration = Duration::from_millis(500);

/// Videos longer than this are left out of tag suggestions entirely (owner decision 0.11): the
/// indexer reads no frames of them, they're never scored (not even from their cover), never keep
/// suggestions and don't count in the status totals. The one place this lives in Rust; the tools
/// mirror it (scripts/lenses `--max-video-secs`), and it is part of the signature, so changing it
/// re-scores the library. 30 until the owner's decision of 2026-11-20 (R45).
pub const MAX_TAG_VIDEO_SECS: u32 = 60;
/// A clip of up to 60.5 s still counts as "60 seconds".
const VIDEO_SECS_SLACK: f64 = 0.5;

/// The longest video, in seconds, that can have tag suggestions (MAX_TAG_VIDEO_SECS + slack).
pub fn max_tag_video_secs() -> f64 { MAX_TAG_VIDEO_SECS as f64 + VIDEO_SECS_SLACK }

/// A video this long gets no tag suggestions. An unknown length isn't "too long" here: the
/// indexer measures a missing length before it reads any frames (and a video whose length can't
/// be found at all is left out by `known_length`). Keep it false for None, or the indexer would
/// measure the same video again every round.
pub fn too_long_for_tags(duration_secs: Option<f64>) -> bool {
    duration_secs.is_some_and(|d| d > max_tag_video_secs())
}

/// A video's length is known when it is a number above 0; NULL or ≤ 0 means unknown.
pub fn known_length(duration_secs: Option<f64>) -> Option<f64> {
    duration_secs.filter(|d| d.is_finite() && *d > 0.0)
}

/// SQL over the inspirations alias `a`: the item can have tag suggestions once its vectors are
/// read: a picture, or a video whose length is known and at most `max_tag_video_secs()` (spec
/// §0.11, §0b.1). A video whose length isn't known never can; before the indexer has looked at
/// it, it only counts as waiting. `?{p}` must be bound to `max_tag_video_secs()`.
fn taggable_sql(a: &str, p: usize) -> String {
    format!("({a}.type != 'video' OR ({a}.duration_secs > 0 AND {a}.duration_secs <= ?{p}))")
}

/// SQL: a video of unknown length (NULL or ≤ 0) — waiting while it has no clip_frames row
/// (frames alias `f`), never taggable once the indexer stored one.
fn unknown_length_sql(a: &str) -> String {
    format!("({a}.type = 'video' AND ({a}.duration_secs IS NULL OR {a}.duration_secs <= 0))")
}

// ── Scoring (spec §5) ─────────────────────────────────────────────────────────

/// An item's vectors as the scorer sees them.
#[derive(Clone, Debug)]
pub enum Vectors {
    /// One vector, scored with the picture rule: a picture, a video with one readable frame,
    /// or a video whose frames couldn't be read (its cover).
    One(Vec<f32>),
    /// Two or more frame vectors: the video rule.
    Frames(Vec<Vec<f32>>),
}

#[derive(Clone, Debug)]
pub struct ItemInput {
    pub id: String,
    /// `Picture` (image, gif) or `Video`.
    pub media: Media,
    /// width / height (inspirations.aspect_ratio)
    pub aspect: f64,
    pub vectors: Vectors,
}

/// One pool (§5.1): the base pool B_m, or a specialist pool P_S,m = B_m ∪ S's scored entries that
/// cover m. A pool only suggests its own entries; in a specialist pool the base entries stand for
/// "it's something else". A pool without own entries suggests nothing (on videos, design's).
struct Pool<'a> {
    lens: &'a Lens,
    own: Vec<&'a Concept>,
    with_base: bool,
}

/// The pools for one media kind, base pool first.
struct Plan<'a> {
    base: Vec<&'a Concept>,
    pools: Vec<Pool<'a>>,
}

impl<'a> Plan<'a> {
    fn new(cat: &'a Catalogue, m: Media) -> Plan<'a> {
        let Some(base_lens) = cat.scoring_base() else { return Plan { base: Vec::new(), pools: Vec::new() } };
        let eligible = |l: &'a Lens| -> Vec<&'a Concept> { l.concepts.iter().filter(|c| c.covers(m)).collect() };
        let base = eligible(base_lens);
        let mut pools = vec![Pool { lens: base_lens, own: base.clone(), with_base: false }];
        for s in cat.scoring_specialists() {
            pools.push(Pool { lens: s, own: eligible(s), with_base: true });
        }
        Plan { base, pools }
    }
}

/// Scores items against one catalogue (build once per chunk).
pub struct Scorer<'a> {
    picture: Plan<'a>,
    video: Plan<'a>,
}

impl<'a> Scorer<'a> {
    pub fn new(cat: &'a Catalogue) -> Scorer<'a> {
        Scorer { picture: Plan::new(cat, Media::Picture), video: Plan::new(cat, Media::Video) }
    }

    /// §5.2–§5.4 for one item: every pool merged into {concept id → score}, before the
    /// answered/owned filter (a tag's entries cover disjoint media, so one pool decides it).
    pub fn score(&self, item: &ItemInput) -> Vec<(String, f64)> {
        let out: Vec<(String, f64)> = self.score_by_lens(item).into_iter().flat_map(|(_, s)| s).collect();
        debug_assert!(out.iter().enumerate().all(|(i, (id, _))| out[..i].iter().all(|(o, _)| o != id)), "a concept from two pools: {out:?}");
        out
    }

    /// The same per pool, in pool order (the base lens first): (lens id, its suggestions).
    pub fn score_by_lens(&self, item: &ItemInput) -> Vec<(String, Vec<(String, f64)>)> {
        let plan = if item.media == Media::Video { &self.video } else { &self.picture };
        if plan.pools.is_empty() { return Vec::new(); }
        match &item.vectors {
            Vectors::One(v) => picture_rule(plan, v, item.aspect),
            Vectors::Frames(f) if f.is_empty() => Vec::new(),
            Vectors::Frames(f) if f.len() == 1 => picture_rule(plan, &f[0], item.aspect),
            Vectors::Frames(f) => video_rule(plan, f, item.aspect),
        }
    }
}

fn dot(a: &[f32], b: &[f32]) -> f64 { a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum() }

/// logit = 100 · cos (all vectors are L2-normalised, so cos = dot).
fn logits(concepts: &[&Concept], v: &[f32]) -> Vec<f64> { concepts.iter().map(|c| 100.0 * dot(&c.vec, v)).collect() }

/// Softmax, subtracting the maximum first.
fn softmax(l: &[f64]) -> Vec<f64> {
    let max = l.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let e: Vec<f64> = l.iter().map(|x| (x - max).exp()).collect();
    let sum: f64 = e.iter().sum();
    e.into_iter().map(|x| x / sum).collect()
}

/// A pool's probabilities for one vector, and where the pool's own concepts start in them.
fn pool_probs(pool: &Pool, base_logits: &[f64], v: &[f32]) -> (Vec<f64>, usize) {
    if !pool.with_base { return (softmax(base_logits), 0); }   // the base pool: its own concepts are the base
    let mut l = base_logits.to_vec();
    l.extend(logits(&pool.own, v));
    (softmax(&l), base_logits.len())
}

/// The aspect gate: a concept with an `aspect` range needs the item's width/height inside it.
fn aspect_ok(c: &Concept, aspect: f64) -> bool { c.aspect.map_or(true, |(lo, hi)| aspect >= lo && aspect <= hi) }

/// §5.2: per pool, its own concepts with p ≥ bar.picture, best first, at most 3; afterwards the
/// aspect gate drops concepts whose range doesn't hold the item's aspect ratio. One row per pool.
fn picture_rule(plan: &Plan, v: &[f32], aspect: f64) -> Vec<(String, Vec<(String, f64)>)> {
    let base_logits = logits(&plan.base, v);
    let mut out = Vec::with_capacity(plan.pools.len());
    for pool in &plan.pools {
        if pool.own.is_empty() { out.push((pool.lens.id.clone(), Vec::new())); continue; }   // suggests nothing
        let (p, off) = pool_probs(pool, &base_logits, v);
        let mut picks: Vec<(&Concept, f64)> = pool.own.iter().enumerate()
            .map(|(i, c)| (*c, p[off + i]))
            .filter(|(_, p)| *p >= pool.lens.bar_picture)
            .collect();
        // Stable sort: equal scores keep file order (as lens-score.mjs does).
        picks.sort_by(|a, b| b.1.total_cmp(&a.1));
        picks.truncate(PICTURE_MAX);
        picks.retain(|(c, _)| aspect_ok(c, aspect));
        out.push((pool.lens.id.clone(), picks.into_iter().map(|(c, p)| (c.id.clone(), p)).collect()));
    }
    out
}

/// The share of a video's frames a concept must top, in percent (owner decision 2026-11-20, R45;
/// 50 % before).
const VIDEO_SHARE_PCT: usize = 45;

/// How many of `n` frames a concept must top: ceil(0.45 · n), in whole numbers (8 → 4, 15 → 7,
/// 20 → 9, 21 → 10, 32 → 15). lens-score.mjs framesNeeded mirrors it.
pub(crate) fn frames_needed(n: usize) -> usize {
    (n * VIDEO_SHARE_PCT).div_ceil(100)
}

/// §5.3: every frame votes for its top concept in the pool. An own concept is suggested when it
/// tops at least `frames_needed(n)` frames (45 %) and its mean p over the frames it won is ≥
/// bar.video; ranked by frames won, then mean p; at most 2; the score is the mean p. The aspect
/// gate applies as for pictures (format concepts describe the item, whatever its media). One row
/// per pool.
fn video_rule(plan: &Plan, frames: &[Vec<f32>], aspect: f64) -> Vec<(String, Vec<(String, f64)>)> {
    let need = frames_needed(frames.len());
    let base_logits: Vec<Vec<f64>> = frames.iter().map(|v| logits(&plan.base, v)).collect();
    let mut out = Vec::with_capacity(plan.pools.len());
    for pool in &plan.pools {
        if pool.own.is_empty() { out.push((pool.lens.id.clone(), Vec::new())); continue; }   // suggests nothing
        let mut wins = vec![0usize; pool.own.len()];
        let mut psum = vec![0f64; pool.own.len()];
        for (v, bl) in frames.iter().zip(&base_logits) {
            let (p, off) = pool_probs(pool, bl, v);
            // The first of equal maxima wins the frame.
            let mut top = 0;
            for i in 1..p.len() { if p[i] > p[top] { top = i; } }
            if !p.is_empty() && top >= off {
                wins[top - off] += 1;
                psum[top - off] += p[top];
            }
        }
        let mut picks: Vec<(&Concept, usize, f64)> = (0..pool.own.len())
            .filter(|&i| wins[i] > 0 && wins[i] >= need)
            .map(|i| (pool.own[i], wins[i], psum[i] / wins[i] as f64))
            .filter(|(_, _, mean)| *mean >= pool.lens.bar_video)
            .collect();
        picks.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.total_cmp(&a.2)));   // stable: ties keep file order
        picks.truncate(VIDEO_MAX);
        picks.retain(|(c, _, _)| aspect_ok(c, aspect));
        out.push((pool.lens.id.clone(), picks.into_iter().map(|(c, _, mean)| (c.id.clone(), mean)).collect()));
    }
    out
}

/// The first 16 hex chars of sha256("lens-score-4|clip-b32-q8|maxvid=60|" + sorted "<id>@<sha256>"
/// joined by ","), over every INSTALLED lens (on or off). Items whose `auto_tag_sig` differs are stale.
pub fn signature(cat: &Catalogue) -> String {
    let mut parts: Vec<String> = cat.lenses.iter().map(|l| format!("{}@{}", l.id, l.sha256)).collect();
    parts.sort();
    let text = format!("{SIG_PREFIX}maxvid={MAX_TAG_VIDEO_SECS}|{}", parts.join(","));
    hex::encode(Sha256::digest(text.as_bytes()))[..16].to_string()
}

// ── Reading vectors ───────────────────────────────────────────────────────────

/// clip_frames.emb (n × 512 f16) → n renormalised vectors.
fn frames_from_blob(b: &[u8], n: usize) -> Option<Vec<Vec<f32>>> {
    if n == 0 || b.len() != n * lenses::DIM * 2 { return None; }
    Some(lenses::decode_f16(b).chunks_exact(lenses::DIM).map(|c| {
        let mut v = c.to_vec();
        lenses::normalize(&mut v);
        v
    }).collect())
}

/// What the scorer needs for `ids`. Items without usable vectors are left out (not scored yet):
/// pictures without a CLIP vector, videos whose frames weren't read yet, and videos whose frames
/// failed (n = 0) and that have no cover vector either. Videos over the length limit, and videos
/// whose length isn't known, are always left out, cover included (§0.11, §0b.1). Frame rows of
/// either schedule are read (clip.rs FRAMES_TAG, FRAMES_TAG_8): 8 frames read before 2026-11-20
/// keep a video scored until the indexer has read it again.
pub fn load_inputs(conn: &Connection, ids: &[String]) -> rusqlite::Result<Vec<ItemInput>> {
    let model = crate::clip::MODEL_TAG;
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "SELECT i.id, i.type, i.aspect_ratio, e.model, e.emb, f.model, f.n, f.emb, i.duration_secs
             FROM inspirations i
             LEFT JOIN clip_embeddings e ON e.id = i.id
             LEFT JOIN clip_frames f ON f.id = i.id
             WHERE i.id IN ({})",
            vec!["?"; chunk.len()].join(","));
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<f64>>(2)?,
            r.get::<_, Option<String>>(3)?, r.get::<_, Option<Vec<u8>>>(4)?,
            r.get::<_, Option<String>>(5)?, r.get::<_, Option<i64>>(6)?, r.get::<_, Option<Vec<u8>>>(7)?,
            r.get::<_, Option<f64>>(8)?,
        )))?;
        for row in rows {
            let (id, kind, aspect, e_model, e_emb, f_model, f_n, f_emb, duration) = row?;
            let cover = if e_model.as_deref() == Some(model) { e_emb.as_deref().and_then(crate::clip::from_blob) } else { None };
            let (media, vectors) = match kind.as_str() {
                "image" | "gif" => match cover { Some(v) => (Media::Picture, Vectors::One(v)), None => continue },
                "video" => {
                    // §0.11 / §0b.1: a known length within the limit, or nothing (not even the cover).
                    match known_length(duration) { Some(d) if d <= max_tag_video_secs() => {}, _ => continue }
                    // frames not read yet: wait for the indexer
                    if !f_model.as_deref().is_some_and(crate::clip::is_frames_model) { continue; }
                    let n = f_n.unwrap_or(0).max(0) as usize;
                    match f_emb.as_deref().and_then(|b| frames_from_blob(b, n)) {
                        Some(mut f) if f.len() == 1 => (Media::Video, Vectors::One(f.remove(0))),
                        Some(f) => (Media::Video, Vectors::Frames(f)),
                        // n = 0: the frames couldn't be read; the cover, with the picture rule.
                        None => match cover { Some(v) => (Media::Video, Vectors::One(v)), None => continue },
                    }
                }
                _ => continue,
            };
            out.push(ItemInput { id, media, aspect: aspect.unwrap_or(1.0), vectors });
        }
    }
    Ok(out)
}

/// Items to (re)score: `auto_tag_sig` NULL or different from `sig`, with vectors, and for videos a
/// known length within the limit. Newest first.
pub fn stale_ids(conn: &Connection, sig: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT i.id FROM inspirations i
         LEFT JOIN clip_embeddings e ON e.id = i.id AND e.model = ?2
         LEFT JOIN clip_frames f ON f.id = i.id AND {}
         WHERE (i.auto_tag_sig IS NULL OR i.auto_tag_sig != ?1)
           AND {}
           AND ((i.type IN ('image','gif') AND e.id IS NOT NULL)
             OR (i.type = 'video' AND f.id IS NOT NULL AND (f.n > 0 OR e.id IS NOT NULL)))
         ORDER BY i.created_at DESC", crate::clip::frames_row_sql("f"), taggable_sql("i", 3)))?;
    let ids = stmt.query_map(params![sig, crate::clip::MODEL_TAG, max_tag_video_secs()], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(ids)
}

/// Videos that can't have suggestions never keep any (§0.11, §0b.1): those over the length limit,
/// and those whose length the indexer couldn't find (unknown length with a clip_frames row).
/// Clears every suggestion field (scores, collection hints, status, model, signature) of the ones
/// that still hold any. Returns the ids it cleared.
pub fn clear_untaggable_videos(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let which = format!(
        "i.type = 'video'
         AND (i.duration_secs > ?1
              OR ({} AND EXISTS (SELECT 1 FROM clip_frames f WHERE f.id = i.id AND {})))
         AND (i.lens_suggestions IS NOT NULL OR i.auto_tag_status IS NOT NULL
              OR i.auto_tag_model IS NOT NULL OR i.auto_tag_sig IS NOT NULL)", unknown_length_sql("i"), crate::clip::frames_row_sql("f"));
    let max = max_tag_video_secs();
    let ids: Vec<String> = {
        let mut stmt = tx.prepare(&format!("SELECT i.id FROM inspirations i WHERE {which} ORDER BY i.id"))?;
        let ids = stmt.query_map(params![max], |r| r.get(0))?.collect::<Result<_, _>>()?;
        ids
    };
    if !ids.is_empty() {
        tx.execute(
            &format!("UPDATE inspirations SET lens_suggestions = NULL, auto_tag_status = NULL, auto_tag_model = NULL,
                        auto_tag_sig = NULL WHERE id IN (SELECT i.id FROM inspirations i WHERE {which})"),
            params![max],
        )?;
    }
    tx.commit()?;
    Ok(ids)
}

// ── The single write path (spec §5.4) ────────────────────────────────────────

/// The same-name key of a tag name or a concept label (spec §0b.2): trimmed, lower-cased, with
/// ‘ ’ ʻ ʼ ` folded to ' (lenses::name_key; the lens checks compare labels with it too).
pub(crate) fn name_key(s: &str) -> String {
    lenses::name_key(s)
}

/// Merge fresh scores with what may not change: concepts answered for the item, concepts it
/// already has and concepts named like one of its people's tags (`same_name`) are dropped;
/// collection hints (`col:<tag_id>`) already stored are kept unless answered or the item already
/// has that tag.
fn merged_json(
    scores: &[(String, f64)],
    answered: &HashSet<String>,
    owned_tags: &HashSet<String>,
    owned_concepts: &HashSet<String>,
    same_name: &dyn Fn(&str) -> bool,
    current: Option<&str>,
) -> String {
    let mut map = serde_json::Map::new();
    for (cid, p) in scores {
        if answered.contains(cid) || owned_concepts.contains(cid) || same_name(cid) { continue; }
        map.insert(cid.clone(), serde_json::json!((p * 10_000.0).round() / 10_000.0));
    }
    let existing: serde_json::Map<String, serde_json::Value> =
        current.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
    for (k, v) in existing {
        if let Some(tag) = k.strip_prefix("col:") {
            if !answered.contains(&k) && !owned_tags.contains(tag) { map.insert(k, v); }
        }
    }
    serde_json::Value::Object(map).to_string()
}

/// Write one chunk of results in one IMMEDIATE transaction: `lens_suggestions` = the merged
/// map, `auto_tag_status = 'done'`, `auto_tag_model = 'lens-1'`, `auto_tag_sig = sig` (never
/// `auto_tag_confidence`: older versions show its keys as tag names; the status tells them the
/// item is done, so they don't tag it themselves). Answers
/// and tags are read inside the transaction, so an answer given while the chunk was being scored
/// still wins. A concept is never written to an item that has a people's tag (source user or
/// import) whose `name_key` equals that of the concept's English or Uzbek label in `cat` (spec
/// §0b.2). Returns the ids written (items deleted meanwhile are skipped).
pub fn write_results(conn: &Connection, results: &[(String, Vec<(String, f64)>)], sig: &str, cat: &Catalogue) -> rusqlite::Result<Vec<String>> {
    let labels: HashMap<&str, [String; 2]> = cat.lenses.iter().flat_map(|l| l.concepts.iter())
        .map(|c| (c.id.as_str(), [name_key(&c.label.en), name_key(&c.label.uz)]))
        .collect();
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let mut written = Vec::with_capacity(results.len());
    {
        let mut q_answered = tx.prepare_cached("SELECT concept_id FROM tag_answers WHERE inspiration_id = ?1")?;
        let mut q_owned = tx.prepare_cached(
            "SELECT it.tag_id, t.concept_id, t.name, t.source FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id
             WHERE it.inspiration_id = ?1")?;
        let mut q_current = tx.prepare_cached("SELECT lens_suggestions FROM inspirations WHERE id = ?1")?;
        let mut update = tx.prepare_cached(
            "UPDATE inspirations SET lens_suggestions = ?2, auto_tag_status = 'done', auto_tag_model = ?3, auto_tag_sig = ?4
             WHERE id = ?1")?;
        for (id, scores) in results {
            let answered: HashSet<String> = q_answered.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            let mut owned_tags = HashSet::new();
            let mut owned_concepts = HashSet::new();
            let mut people_names: HashSet<String> = HashSet::new();
            for row in q_owned.query_map([id], |r| Ok((
                r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?,
            )))? {
                let (tag, concept, name, source) = row?;
                if let (Some(name), Some("user" | "import")) = (name, source.as_deref()) { people_names.insert(name_key(&name)); }
                owned_tags.insert(tag);
                if let Some(c) = concept { owned_concepts.insert(c); }
            }
            let same_name = |cid: &str| !people_names.is_empty()
                && labels.get(cid).is_some_and(|[en, uz]| people_names.contains(en) || people_names.contains(uz));
            let current: Option<String> = q_current.query_row([id], |r| r.get(0)).optional()?.flatten();
            let json = merged_json(scores, &answered, &owned_tags, &owned_concepts, &same_name, current.as_deref());
            if update.execute(params![id, json, SCORE_MODEL, sig])? > 0 { written.push(id.clone()); }
        }
    }
    tx.commit()?;
    Ok(written)
}

/// Read, score and write `ids` in one go on one connection (tests and tools; the app goes
/// through `score_items`, which releases the database while it computes).
pub fn score_chunk(conn: &Connection, cat: &Catalogue, ids: &[String]) -> rusqlite::Result<Vec<String>> {
    let inputs = load_inputs(conn, ids)?;
    let scorer = Scorer::new(cat);
    let results: Vec<(String, Vec<(String, f64)>)> = inputs.iter().map(|it| (it.id.clone(), scorer.score(it))).collect();
    write_results(conn, &results, &signature(cat), cat)
}

// ── Running it (spec §5.5) ────────────────────────────────────────────────────

/// One scoring run at a time (the indexer, start-up and commands all call in).
static SCORING: Mutex<()> = Mutex::new(());
static WARNED_NO_BASE: AtomicBool = AtomicBool::new(false);

pub fn suggestions_enabled(conn: &Connection) -> bool {
    conn.query_row("SELECT value FROM preferences WHERE key = ?1", params![PREF_SWITCH], |r| r.get::<_, Option<String>>(0))
        .optional().ok().flatten().flatten().as_deref() == Some("true")
}

/// The master switch, `tag_recommendations_enabled == 'true'`.
pub fn suggestions_on(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let db = lock_db(&state);
    suggestions_enabled(&db)
}

fn score_locked(app: &AppHandle, ids: &[String]) {
    let state = app.state::<AppState>();
    for chunk in ids.chunks(CHUNK) {
        let (cat, inputs) = {
            let db = lock_db(&state);
            if !suggestions_enabled(&db) { return; }
            let cat = lenses::catalogue(&db);
            if cat.scoring_base().is_none() {
                if !WARNED_NO_BASE.swap(true, Ordering::Relaxed) {
                    log::warn!(target: "Lens", "no base lens installed: nothing to score");
                }
                return;
            }
            match load_inputs(&db, chunk) {
                Ok(inputs) => (cat, inputs),
                Err(e) => { log::error!(target: "Lens", "couldn't read vectors: {e}"); return; }
            }
        };
        // Scored with the database released; answers given meanwhile are applied at write time.
        let scorer = Scorer::new(&cat);
        let results: Vec<(String, Vec<(String, f64)>)> = inputs.iter().map(|it| (it.id.clone(), scorer.score(it))).collect();
        let written = {
            let db = lock_db(&state);
            match write_results(&db, &results, &signature(&cat), &cat) {
                Ok(w) => w,
                Err(e) => { log::error!(target: "Lens", "couldn't write suggestions: {e}"); return; }
            }
        };
        if !written.is_empty() {
            if let Err(e) = app.emit("autotag:scored", serde_json::json!({ "ids": written })) {
                log::warn!(target: "Lens", "autotag:scored not sent: {e}");
            }
        }
        // No lens:status per chunk: a status recounts the whole library while holding the
        // database. The indexer sends one per round (round_done), a scoring run one at its end.
    }
}

/// Score these items now (the indexer calls this after storing their vectors). Does nothing while
/// tag suggestions are off. Blocking; releases the database between chunks of 500.
pub fn score_items(app: &AppHandle, ids: &[String]) {
    if ids.is_empty() { return; }
    let _run = SCORING.lock().unwrap_or_else(|e| e.into_inner());
    score_locked(app, ids);
}

/// §0.11 / §0b.1 for the whole library: clear what videos that can't have suggestions still hold
/// (over the length limit, or a length the indexer couldn't find) and tell the page
/// (`autotag:scored`). Runs whatever the switch says. Call without holding the database.
pub fn forget_untaggable_videos(app: &AppHandle) {
    let cleared = {
        let state = app.state::<AppState>();
        let db = lock_db(&state);
        clear_untaggable_videos(&db)
    };
    match cleared {
        Ok(ids) if !ids.is_empty() => {
            log::info!(target: "Lens", "cleared the suggestions of {} videos (over {MAX_TAG_VIDEO_SECS} s or no length)", ids.len());
            if let Err(e) = app.emit("autotag:scored", serde_json::json!({ "ids": ids })) {
                log::warn!(target: "Lens", "autotag:scored not sent: {e}");
            }
        }
        Ok(_) => {}
        Err(e) => log::warn!(target: "Lens", "couldn't clear the suggestions of untaggable videos: {e}"),
    }
}

/// Score every stale item (start-up, after a lens install, `retag_all`, switch turned on), then
/// send one `lens:status` (only while Settings watches it). Blocking: call it on a background thread.
pub fn score_stale(app: &AppHandle) {
    let _run = SCORING.lock().unwrap_or_else(|e| e.into_inner());
    score_stale_locked(app);
    emit_status(app);
}

fn score_stale_locked(app: &AppHandle) {
    forget_untaggable_videos(app);
    let ids = {
        let state = app.state::<AppState>();
        let db = lock_db(&state);
        if !suggestions_enabled(&db) { return; }
        let cat = lenses::catalogue(&db);
        if cat.scoring_base().is_none() { return; }
        match stale_ids(&db, &signature(&cat)) {
            Ok(ids) => ids,
            Err(e) => { log::error!(target: "Lens", "couldn't find stale items: {e}"); return; }
        }
    };
    if ids.is_empty() { return; }
    let t0 = Instant::now();
    score_locked(app, &ids);
    log::info!(target: "Lens", "scored {} items in {} ms", ids.len(), t0.elapsed().as_millis());
}

fn spawn_score_stale(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || score_stale(&app));
}

/// For `set_setting`: tag suggestions were just turned on → wake the indexer (video frames) and
/// score what's stale.
pub fn suggestions_turned_on(app: &AppHandle) {
    crate::clip::wake();
    spawn_score_stale(app);
}

// ── Status ────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LensStatus {
    /// The master switch.
    pub enabled: bool,
    /// Pictures and videos that can have suggestions (items whose picture can't be read are left
    /// out, and so are videos over 60 s or whose length couldn't be found), plus videos the
    /// indexer hasn't looked at yet and can read now (VideosNotNow).
    pub total: i64,
    /// Of those, scored against the installed lenses as they are now.
    pub scored: i64,
    /// Videos whose frames haven't been read yet (also those whose length isn't known yet), not
    /// counting the ones the indexer can't read now.
    pub waiting_videos: i64,
    /// `lens_last_check` (unix seconds), if set.
    pub last_check: Option<i64>,
    /// Lens id → items with at least one open suggestion that lens shows on the item's media
    /// (spec §0c: its own entries that cover it, and the ones it borrows whose base entry does).
    pub per_lens: BTreeMap<String, i64>,
}

/// The videos without frame vectors that the indexer can't read now (clip::videos_not_now). They
/// aren't work left: while they count, Settings would say "Looking through your library" with a
/// bar that never fills (review R1).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VideosNotNow {
    /// Not reached this launch (a missing file, a drive that isn't connected): nothing stored,
    /// the next start tries again.
    pub skipped: Vec<String>,
    /// ffmpeg wasn't found: no video without frame vectors can be read or measured.
    pub no_ffmpeg: bool,
}

/// The status as `lens_status` sends it. `not_now`: the videos the indexer can't read now; they
/// count nowhere until it can.
pub fn status_with(conn: &Connection, cat: &Catalogue, not_now: &VideosNotNow) -> rusqlite::Result<LensStatus> {
    let model = crate::clip::MODEL_TAG;
    // Videos over the length limit don't count anywhere (§0.11), and neither do videos whose
    // length the indexer couldn't find (§0b.1); one of unknown length it hasn't looked at yet is
    // waiting. A video without frame vectors that can't be read now isn't waiting: it counts
    // nowhere until it can be read. Frame rows of either schedule count as read (clip.rs): a
    // video read again one frame per second isn't waiting meanwhile.
    let skipped = serde_json::Value::from(not_now.skipped.clone()).to_string();
    let (total, scored, waiting_videos): (i64, i64, i64) = conn.query_row(&format!(
        "SELECT
           COALESCE(SUM(CASE WHEN i.type IN ('image','gif') THEN (e.model IS NULL OR e.model != 'failed')
                             ELSE (f.id IS NULL OR f.n > 0 OR e.model = ?1) END), 0),
           COALESCE(SUM(CASE WHEN i.auto_tag_sig IS NOT ?2 THEN 0
                             WHEN i.type IN ('image','gif') THEN e.model = ?1
                             ELSE (f.id IS NOT NULL AND (f.n > 0 OR e.model = ?1)) END), 0),
           COALESCE(SUM(i.type = 'video' AND f.id IS NULL), 0)
         FROM inspirations i
         LEFT JOIN clip_embeddings e ON e.id = i.id
         LEFT JOIN clip_frames f ON f.id = i.id AND {}
         WHERE i.type IN ('image','gif','video') AND ({} OR ({} AND f.id IS NULL))
           AND NOT (i.type = 'video' AND f.id IS NULL AND (?4 OR i.id IN (SELECT value FROM json_each(?5))))",
        crate::clip::frames_row_sql("f"), taggable_sql("i", 3), unknown_length_sql("i")),
        params![model, signature(cat), max_tag_video_secs(), not_now.no_ffmpeg, skipped],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let last_check = conn.query_row("SELECT value FROM preferences WHERE key = ?1", params![PREF_LAST_CHECK], |r| r.get::<_, Option<String>>(0))
        .optional()?.flatten().and_then(|v| v.trim().parse::<i64>().ok());

    // Per lens, the keys it shows on [pictures, videos] (spec §0c display rule, Catalogue::shows).
    let shows: Vec<(&str, [HashSet<&str>; 2])> = cat.lenses.iter().map(|l| {
        let keys = |m: Media| -> HashSet<&str> {
            l.concepts.iter().map(|c| c.id.as_str()).chain(l.borrows.iter().map(|b| b.as_str()))
                .filter(|k| cat.shows(l, k, m)).collect()
        };
        (l.id.as_str(), [keys(Media::Picture), keys(Media::Video)])
    }).collect();
    let mut per_lens: BTreeMap<String, i64> = cat.lenses.iter().map(|l| (l.id.clone(), 0)).collect();
    let mut stmt = conn.prepare(&format!(
        "SELECT i.type, i.lens_suggestions FROM inspirations i
         WHERE i.lens_suggestions IS NOT NULL AND i.lens_suggestions NOT IN ('', '{{}}') AND {}",
        taggable_sql("i", 1)))?;
    for row in stmt.query_map(params![max_tag_video_secs()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (kind, conf) = row?;
        let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&conf) else { continue };
        let media = if kind == "video" { 1 } else { 0 };
        for (lens, sets) in &shows {
            if map.keys().any(|k| sets[media].contains(k.as_str())) {
                *per_lens.entry(lens.to_string()).or_default() += 1;
            }
        }
    }
    Ok(LensStatus { enabled: suggestions_enabled(conn), total, scored, waiting_videos, last_check, per_lens })
}

static STATUS_LAST: Mutex<Option<Instant>> = Mutex::new(None);
static STATUS_PENDING: AtomicBool = AtomicBool::new(false);
/// Settings › Library › Tag lens is on screen (`lens_status_watch`). `lens:status` is only built
/// and sent while it is: each status recounts the whole library while holding the database
/// (about 130 ms on 20,000 items). The `lens_status` command always answers.
static WATCHING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq, Eq)]
enum StatusSend { Now, After(Duration), Skip }

/// The gate in front of `lens:status`: nothing while nobody watches; otherwise at most one per
/// STATUS_GAP, and a call inside the gap asks for one trailing emit when the gap ends.
fn status_send(watching: bool, last: &mut Option<Instant>, now: Instant) -> StatusSend {
    if !watching { return StatusSend::Skip; }
    match *last {
        Some(t) if now.duration_since(t) < STATUS_GAP => StatusSend::After(STATUS_GAP - now.duration_since(t)),
        _ => { *last = Some(now); StatusSend::Now }
    }
}

fn send_status(app: &AppHandle) {
    let not_now = crate::clip::videos_not_now();   // read before the database is taken: the two locks never nest
    let status = {
        let state = app.state::<AppState>();
        let db = lock_db(&state);
        let cat = lenses::catalogue(&db);
        status_with(&db, &cat, &not_now)
    };
    match status {
        Ok(s) => { if let Err(e) = app.emit("lens:status", &s) { log::warn!(target: "Lens", "lens:status not sent: {e}"); } }
        Err(e) => log::warn!(target: "Lens", "status unavailable: {e}"),
    }
}

/// Emit `lens:status` while Settings watches it (`lens_status_watch`), at most twice a second; a
/// call inside the gap schedules one trailing emit so the last state always arrives. Does
/// nothing while nobody watches. Call without holding the database.
pub fn emit_status(app: &AppHandle) {
    let send = {
        let mut last = STATUS_LAST.lock().unwrap_or_else(|e| e.into_inner());
        status_send(WATCHING.load(Ordering::Acquire), &mut last, Instant::now())
    };
    match send {
        StatusSend::Skip => {}
        StatusSend::Now => send_status(app),
        StatusSend::After(d) => {
            if STATUS_PENDING.swap(true, Ordering::AcqRel) { return; }   // a trailing emit is already queued
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(d);
                STATUS_PENDING.store(false, Ordering::Release);
                emit_status(&app);
            });
        }
    }
}

/// The indexer finished a round (a batch of pictures, or of videos): one `lens:status`, only
/// while Settings watches it and tag suggestions are on.
pub fn round_done(app: &AppHandle) {
    if WATCHING.load(Ordering::Acquire) && suggestions_on(app) { emit_status(app); }
}

// ── Answers and tags ──────────────────────────────────────────────────────────

/// A tag as the page sees it (same JSON shape as commands::Tag with `concept_id` and `labels`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TagOut {
    pub id: String,
    pub name: String,
    pub source: String,
    pub created_at: i64,
    pub usage_count: i64,
    pub concept_id: Option<String>,
    /// The concept's labels (tags with a concept only): a lens tag shows the one in the current
    /// language; a people's tag that stands for a concept shows its own name (one name, one tag).
    pub labels: Option<I18n>,
}

pub fn load_tag(conn: &Connection, tag_id: &str) -> rusqlite::Result<Option<TagOut>> {
    conn.query_row(
        "SELECT t.id, t.name, t.source, t.created_at, COALESCE(u.count, 0), t.concept_id, c.labels_json
         FROM tags t
         LEFT JOIN tag_usage_counts u ON u.tag_id = t.id
         LEFT JOIN concepts c ON c.id = t.concept_id
         WHERE t.id = ?1",
        params![tag_id],
        |r| Ok(TagOut {
            id: r.get(0)?, name: r.get(1)?, source: r.get(2)?, created_at: r.get(3)?, usage_count: r.get(4)?,
            concept_id: r.get(5)?, labels: r.get::<_, Option<String>>(6)?.as_deref().and_then(lenses::parse_labels),
        }),
    ).optional()
}

// ── The stored name of a lens tag ─────────────────────────────────────────────
// This version shows a lens tag by its concept's label in the app's language and finds it by
// `concept_id`, never by its name. Older versions (qooti 1.2.2) show `tags.name` exactly as stored
// (filter chips, the detail panel, the tag picker, Settings › Tags), and their collection hints and
// Add go by it. So a lens tag is stored under its concept's English label, never an id (until
// 2026-11-19 it was 'lens:<concept id>', spec §4): readable there, and 1.2.2's Add finds the lens
// tag by that name instead of making a tag of its own. tags.name is UNIQUE, and one name must be
// one tag: a people's tag with the label as its name is the lens tag (one name, one tag, below);
// while another tag has it (by the same-name key), the lens tag is stored as "<label> (Tag lens)",
// then "<label> (Tag lens 2)", …

/// What a lens tag's stored name is made from: its concept's English label (without
/// underscores), or a readable form of the id when the concept has no label.
fn lens_tag_base(conn: &Connection, concept_id: &str) -> rusqlite::Result<String> {
    let labels: Option<String> = conn
        .query_row("SELECT labels_json FROM concepts WHERE id = ?1", params![concept_id], |r| r.get(0))
        .optional()?;
    Ok(lens_tag_base_from(labels.as_deref(), concept_id))
}

fn lens_tag_base_from(labels_json: Option<&str>, concept_id: &str) -> String {
    let en = labels_json.and_then(lenses::parse_labels).map(|l| readable_label(l.en.trim())).unwrap_or_default();
    if en.is_empty() || en.to_lowercase().starts_with("lens:") { readable_name(concept_id) } else { en }
}

/// The names a lens tag may be stored under, best first: the base, "<base> (Tag lens)",
/// "<base> (Tag lens 2)", … (endless).
fn lens_tag_names(base: &str) -> impl Iterator<Item = String> + '_ {
    std::iter::once(base.to_string())
        .chain(std::iter::once(format!("{base} (Tag lens)")))
        .chain((2u64..).map(move |n| format!("{base} (Tag lens {n})")))
}

/// The first of `lens_tag_names(base)` whose same-name key isn't in `taken`.
fn first_free_name(base: &str, taken: &HashSet<String>) -> String {
    lens_tag_names(base).find(|n| !taken.contains(&name_key(n))).unwrap_or_else(|| base.to_string())
}

/// The same-name keys of every tag's stored name, but `except`'s.
fn taken_names(conn: &Connection, except: Option<&str>) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare_cached("SELECT id, name FROM tags")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = HashSet::new();
    for row in rows {
        let (id, name) = row?;
        if Some(id.as_str()) != except { out.insert(name_key(&name)); }
    }
    Ok(out)
}

/// The tag of a concept: `source = 'lens'`, `concept_id` set, stored under a readable name (see
/// above). Found by `concept_id`; else the people's tag named like it becomes it (one name, one
/// tag, below); else made (one per concept). Used by answers, by pack import and when the tags of
/// older versions are adopted.
pub fn ensure_concept_tag(conn: &Connection, concept_id: &str) -> rusqlite::Result<String> {
    let found: Option<String> = conn
        .query_row("SELECT id FROM tags WHERE concept_id = ?1 ORDER BY created_at, id LIMIT 1", params![concept_id], |r| r.get(0))
        .optional()?;
    if let Some(id) = found { return Ok(id); }
    let base = lens_tag_base(conn, concept_id)?;
    match peoples_tag_for(&peoples_tags_named(conn, &name_key(&base))?, concept_id) {
        Peoples::One(id) => {
            become_concept_tag(conn, &id, concept_id)?;
            return Ok(id);
        }
        Peoples::None => {}
        apart => log::info!(target: "Lens", "the tag of '{concept_id}' stays apart from people's tags with its name ({})", apart.why()),
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = first_free_name(&base, &taken_names(conn, None)?);
    conn.execute(
        "INSERT INTO tags (id, name, source, created_at, concept_id) VALUES (?1, ?2, 'lens', ?3, ?4)",
        params![id, name, lenses::now_ms(), concept_id],
    )?;
    conn.execute("INSERT OR IGNORE INTO tag_usage_counts (tag_id, count) VALUES (?1, 0)", params![id])?;
    Ok(id)
}

/// At every start (adopt_older_build_tags, after join_same_name_tags): every lens tag stored under
/// the name older versions should show. The lens tags are taken in a fixed order (tags of live
/// concepts first, then the oldest), and each gets the first of its names (lens_tag_names) that no
/// other tag, and no lens tag before it, has. So the names only depend on what the library holds,
/// and settle on the next start: the 'lens:<id>' names an earlier build stored, a label a new lens
/// version changed, a name a people's tag has taken or given back. A people's tag that stands for a
/// concept (one name, one tag) keeps its name. On any other start nothing is written (one read).
/// Ids, links, counts and answers never change. Returns how many lens tags were renamed.
pub fn name_lens_tags(conn: &Connection) -> rusqlite::Result<usize> {
    let plan = |conn: &Connection| -> rusqlite::Result<Vec<(String, String)>> {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.concept_id, c.labels_json, t.source IN ('user', 'import')
             FROM tags t LEFT JOIN concepts c ON c.id = t.concept_id
             ORDER BY COALESCE(c.active, 0) DESC, t.created_at, t.id")?;
        let rows: Vec<(String, String, Option<String>, Option<String>, bool)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<Result<_, _>>()?;
        let mut taken: HashSet<String> = rows.iter().filter(|r| r.2.is_none() || r.4).map(|r| name_key(&r.1)).collect();
        let mut renames = Vec::new();
        for (id, name, concept, labels, people) in &rows {
            if *people { continue; }
            let Some(cid) = concept else { continue };
            let want = first_free_name(&lens_tag_base_from(labels.as_deref(), cid), &taken);
            taken.insert(name_key(&want));
            if want != *name { renames.push((id.clone(), want)); }
        }
        Ok(renames)
    };
    if plan(conn)?.is_empty() { return Ok(0); }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let renames = plan(&tx)?;
    // Two steps, so a lens tag can take a name another one gives up in the same run (UNIQUE)
    for (id, _) in &renames { tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![id, format!("\u{1}{id}")])?; }
    for (id, name) in &renames { tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![id, name])?; }
    tx.commit()?;
    Ok(renames.len())
}

/// A people's tag is about to be made with `name` (commands::create_tag, a pack import): a lens
/// tag stored under that name (by the same-name key) moves to its next free name first, so the
/// people's tag gets the name exactly as given and older versions never show one name twice.
/// (A lens tag whose label is that name becomes the people's tag instead: lens_tag_for_peoples_name.)
/// Returns how many lens tags moved.
pub(crate) fn make_room_for_name(conn: &Connection, name: &str) -> rusqlite::Result<usize> {
    make_room_except(conn, name, None)
}

/// make_room_for_name, leaving the lens tag `except` where it is.
fn make_room_except(conn: &Connection, name: &str, except: Option<&str>) -> rusqlite::Result<usize> {
    let key = name_key(name);
    if key.is_empty() { return Ok(0); }
    let holders: Vec<(String, String)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT id, name, concept_id FROM tags WHERE concept_id IS NOT NULL AND source NOT IN ('user', 'import')")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, stored, concept) = row?;
            if name_key(&stored) == key && Some(id.as_str()) != except { out.push((id, concept)); }
        }
        out
    };
    for (id, concept) in &holders {
        let mut taken = taken_names(conn, Some(id))?;
        taken.insert(key.clone());
        let fresh = first_free_name(&lens_tag_base(conn, concept)?, &taken);
        conn.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![id, fresh])?;
    }
    Ok(holders.len())
}

// ── One name, one tag (owner, 2026-11-20) ─────────────────────────────────────
// A lens tag and a people's tag (source user or import) whose names have one same-name key are one
// tag. The lens tag's name is the one it is stored under: its concept's English label
// (lens_tag_base). The people's tag is that tag: it keeps its id, its name as typed and its
// source, and gets the concept (concept_id). It stays a people's tag: shown by its own name in
// both languages (lenses.js tagLabel), never swept or renamed, asked about before Settings deletes
// it, and a pack carries it by its own name and source with its concept. Where they meet:
// - at every start, before the stored names are set (join_same_name_tags), and after a lens update
//   installed while the app runs (tags_after_install): a lens tag joins the people's tag with its
//   name, with its items, count and collection-hint answers, and goes;
// - on Add (ensure_concept_tag): that people's tag becomes the concept's tag instead of a new one;
// - when a people's tag is made with a lens tag's name (commands::create_tag, a pack import): the
//   lens tag becomes that people's tag, in place (lens_tag_for_peoples_name).
// Not when the people's tag already stands for another concept, or two people's tags have the name:
// they stay apart, the lens tag is stored as "<label> (Tag lens)", and a count is logged. A tag
// with a concept is asked about by the lenses, never by a collection hint (apply_collection_hints),
// so when a people's tag gets one, its hints leave the items (settle_concept_tag): a card never
// asks one tag twice.

/// The people's tags (source user or import) whose name has the same-name key `key`, oldest first:
/// (id, concept_id).
fn peoples_tags_named(conn: &Connection, key: &str) -> rusqlite::Result<Vec<(String, Option<String>)>> {
    if key.is_empty() { return Ok(Vec::new()); }
    let mut stmt = conn.prepare_cached(
        "SELECT id, name, concept_id FROM tags WHERE source IN ('user', 'import') ORDER BY created_at, id")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, concept) = row?;
        if name_key(&name) == key { out.push((id, concept)); }
    }
    Ok(out)
}

/// Whether the people's tags named like a concept's tag are its tag.
#[derive(Debug, PartialEq, Eq)]
enum Peoples {
    /// The one people's tag with that name, standing for no other concept: it is the concept's tag.
    One(String),
    /// No people's tag has that name.
    None,
    /// Two or more people's tags have that name: they stay apart.
    TwoNamed,
    /// The one people's tag with that name stands for another concept: they stay apart.
    OtherConcept,
}

impl Peoples {
    fn why(&self) -> &'static str {
        match self {
            Peoples::TwoNamed => "two people's tags have it",
            Peoples::OtherConcept => "a people's tag with it stands for another tag",
            Peoples::One(_) | Peoples::None => "",
        }
    }
}

/// `people` = peoples_tags_named(the name of `concept_id`'s tag).
fn peoples_tag_for(people: &[(String, Option<String>)], concept_id: &str) -> Peoples {
    match people {
        [] => Peoples::None,
        [(id, None)] => Peoples::One(id.clone()),
        [(id, Some(c))] if c == concept_id => Peoples::One(id.clone()),
        [_] => Peoples::OtherConcept,
        _ => Peoples::TwoNamed,
    }
}

/// Every item's collection hint for `tag_id` (`col:<tag_id>`) leaves its map. Returns how many items.
fn remove_hints(conn: &Connection, tag_id: &str) -> rusqlite::Result<usize> {
    let key = format!("col:{tag_id}");
    if parse_key(&key).is_none() { return Ok(0); }   // no such key is ever stored (parse_key)
    conn.execute(
        "UPDATE inspirations SET lens_suggestions = json_remove(lens_suggestions, ?1)
         WHERE json_valid(lens_suggestions) AND json_type(lens_suggestions, ?1) IS NOT NULL",
        params![format!("$.\"{key}\"")],
    )
}

/// Run `f` as one unit: all of its writes, or none of them when it fails. A SAVEPOINT works inside a
/// caller's transaction (answer_with, the start's adoption) and outside one (a pack import), where it
/// is the transaction itself. So a failure, or the app closing, between two of the writes never
/// leaves half of a change (a people's tag standing for a concept while its collection hints stay).
fn all_or_nothing<T>(conn: &Connection, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
    conn.execute_batch("SAVEPOINT one_name_step")?;
    let done = f(conn).and_then(|v| conn.execute_batch("RELEASE one_name_step").map(|_| v));
    if done.is_err() {
        if let Err(e) = conn.execute_batch("ROLLBACK TO one_name_step; RELEASE one_name_step") {
            log::warn!(target: "Lens", "a tag change couldn't be undone after it failed: {e}");
        }
    }
    done
}

/// The people's tag `tag_id`, which stands for no concept, becomes the tag of `concept_id` (one
/// name, one tag), as one unit: it gets the concept (settle_concept_tag follows).
pub(crate) fn become_concept_tag(conn: &Connection, tag_id: &str, concept_id: &str) -> rusqlite::Result<()> {
    all_or_nothing(conn, |conn| {
        conn.execute("UPDATE tags SET concept_id = ?2 WHERE id = ?1", params![tag_id, concept_id])?;
        settle_concept_tag(conn, tag_id, concept_id)
    })
}

/// `tag_id` has just become the tag of `concept_id` (one name, one tag): the concept's question
/// leaves the items that have the tag, and the tag's collection hints leave every item.
fn settle_concept_tag(conn: &Connection, tag_id: &str, concept_id: &str) -> rusqlite::Result<()> {
    if lenses::valid_concept_id(concept_id) {
        conn.execute(
            "UPDATE inspirations SET lens_suggestions = json_remove(lens_suggestions, ?2)
             WHERE id IN (SELECT inspiration_id FROM inspiration_tags WHERE tag_id = ?1)
               AND json_valid(lens_suggestions) AND json_type(lens_suggestions, ?2) IS NOT NULL",
            params![tag_id, format!("$.\"{concept_id}\"")],
        )?;
    }
    remove_hints(conn, tag_id)?;
    Ok(())
}

/// What join_same_name_tags did, and what it left apart (counts only, for the log).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Joined {
    /// Lens tags that joined the people's tag with their name.
    pub joined: usize,
    /// Item links that moved with them (a link the people's tag already had doesn't count).
    pub links: usize,
    /// Lens tags left apart because two or more people's tags have their name.
    pub two_named: usize,
    /// Lens tags left apart because the people's tag with their name stands for another concept.
    pub other_concept: usize,
}

/// At every start, before the stored names are set (adopt_older_build_tags): each lens tag whose
/// name (its concept's English label, by the same-name key) one people's tag has joins that
/// people's tag (join_lens_tag). The lens tags are taken in name_lens_tags' order (live concepts
/// first, then the oldest), so of two lens tags with one name, the live concept's gets the people's
/// tag and the other stays apart. One IMMEDIATE transaction for all of them; a library with nothing
/// to join costs one read and writes nothing, so the next start finds nothing to do.
pub fn join_same_name_tags(conn: &Connection) -> rusqlite::Result<Joined> {
    let plan = |conn: &Connection| -> rusqlite::Result<(Vec<(String, String, String)>, Joined)> {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.concept_id, c.labels_json, t.source IN ('user', 'import')
             FROM tags t LEFT JOIN concepts c ON c.id = t.concept_id
             ORDER BY COALESCE(c.active, 0) DESC, t.created_at, t.id")?;
        let rows: Vec<(String, String, Option<String>, Option<String>, bool)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<Result<_, _>>()?;
        let mut people: HashMap<String, Vec<(String, Option<String>)>> = HashMap::new();
        for (id, name, concept, _, is_people) in &rows {
            if *is_people { people.entry(name_key(name)).or_default().push((id.clone(), concept.clone())); }
        }
        let mut joins = Vec::new();
        let mut left = Joined::default();
        for (id, _, concept, labels, is_people) in &rows {
            if *is_people { continue; }
            let Some(cid) = concept else { continue };
            let Some(named) = people.get_mut(&name_key(&lens_tag_base_from(labels.as_deref(), cid))) else { continue };
            match peoples_tag_for(named, cid) {
                Peoples::One(p) => {
                    // From now on it stands for this concept: another lens tag with the name stays apart
                    for entry in named.iter_mut().filter(|e| e.0 == p) { entry.1 = Some(cid.clone()); }
                    joins.push((id.clone(), p, cid.clone()));
                }
                Peoples::None => {}
                Peoples::TwoNamed => left.two_named += 1,
                Peoples::OtherConcept => left.other_concept += 1,
            }
        }
        Ok((joins, left))
    };
    let (joins, left) = plan(conn)?;
    if joins.is_empty() { return Ok(left); }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let (joins, mut done) = plan(&tx)?;
    for (lens, people, cid) in &joins {
        done.links += join_lens_tag(&tx, lens, people, cid)?;
        done.joined += 1;
    }
    tx.commit()?;
    Ok(done)
}

/// The lens tag `lens` of `concept_id` joins the people's tag `people`, inside the caller's
/// transaction. The people's tag gets the concept and keeps its id, name and source; it gets the
/// lens tag's items (a link it already has isn't made twice; the item's questions that ask that
/// name go, as when a tag is linked) and the answers to the lens tag's collection hints (an answer
/// the item already gave the people's tag's hint stays), and its count is set from its links. The
/// lens tag's hints, and now the people's tag's own, leave the items (settle_concept_tag); answers to
/// the concept itself are keyed by the concept and stay as they are. Then the lens tag goes, with its
/// links and count. Returns how many links were new.
fn join_lens_tag(tx: &Connection, lens: &str, people: &str, concept_id: &str) -> rusqlite::Result<usize> {
    tx.execute("UPDATE tags SET concept_id = ?2 WHERE id = ?1", params![people, concept_id])?;
    let items: Vec<String> = {
        let mut stmt = tx.prepare("SELECT inspiration_id FROM inspiration_tags WHERE tag_id = ?1 ORDER BY inspiration_id")?;
        let rows = stmt.query_map(params![lens], |r| r.get(0))?.collect::<Result<_, _>>()?;
        rows
    };
    let mut moved = 0;
    for item in &items {
        if tx.execute("INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES (?1, ?2)", params![item, people])? > 0 {
            moved += 1;
            drop_questions_named_like(tx, item, people)?;
        }
    }
    tx.execute("UPDATE OR IGNORE tag_answers SET concept_id = 'col:' || ?2 WHERE concept_id = 'col:' || ?1", params![lens, people])?;
    tx.execute("DELETE FROM tag_answers WHERE concept_id = 'col:' || ?1", params![lens])?;
    remove_hints(tx, lens)?;
    tx.execute("DELETE FROM inspiration_tags WHERE tag_id = ?1", params![lens])?;
    tx.execute("DELETE FROM tag_usage_counts WHERE tag_id = ?1", params![lens])?;
    tx.execute("DELETE FROM tags WHERE id = ?1", params![lens])?;
    tx.execute(
        "INSERT OR REPLACE INTO tag_usage_counts (tag_id, count) SELECT ?1, COUNT(*) FROM inspiration_tags WHERE tag_id = ?1",
        params![people],
    )?;
    settle_concept_tag(tx, people, concept_id)?;
    Ok(moved)
}

/// A people's tag is about to be made with `name` and `source` (commands::create_tag, a pack
/// import). When no people's tag has that name yet (by the same-name key) and a lens tag's name
/// (its concept's English label) is that name, the lens tag becomes the people's tag, in place:
/// stored as `name`, with `source`, keeping its id, concept, items, count and answers, so whatever
/// points at it stays right. Of two such lens tags, the live concept's, then the oldest. Returns its
/// id, or None: then the caller makes the people's tag (make_room_for_name first).
pub(crate) fn lens_tag_for_peoples_name(conn: &Connection, name: &str, source: &str) -> rusqlite::Result<Option<String>> {
    let key = name_key(name);
    if key.is_empty() || !peoples_tags_named(conn, &key)?.is_empty() { return Ok(None); }
    let found: Option<String> = {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.concept_id, c.labels_json FROM tags t LEFT JOIN concepts c ON c.id = t.concept_id
             WHERE t.concept_id IS NOT NULL AND t.source NOT IN ('user', 'import')
             ORDER BY COALESCE(c.active, 0) DESC, t.created_at, t.id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))?;
        let mut found = None;
        for row in rows {
            let (id, cid, labels) = row?;
            if name_key(&lens_tag_base_from(labels.as_deref(), &cid)) == key { found = Some(id); break; }
        }
        found
    };
    let Some(id) = found else { return Ok(None) };
    // Another lens tag stored under that name (a label changed since) moves on: names are UNIQUE.
    // One unit, so a failure never leaves a lens tag moved for a people's tag that wasn't made.
    all_or_nothing(conn, |conn| {
        make_room_except(conn, name, Some(&id))?;
        conn.execute("UPDATE tags SET name = ?2, source = ?3 WHERE id = ?1", params![id, name, source])
    })?;
    Ok(Some(id))
}

/// Link a tag to an item; bumps tag_usage_counts only when the link is new.
fn link_tag(conn: &Connection, inspiration_id: &str, tag_id: &str) -> rusqlite::Result<()> {
    let added = conn.execute(
        "INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES (?1, ?2)",
        params![inspiration_id, tag_id],
    )?;
    if added > 0 {
        conn.execute(
            "INSERT INTO tag_usage_counts (tag_id, count) VALUES (?1, 1) ON CONFLICT(tag_id) DO UPDATE SET count = count + 1",
            params![tag_id],
        )?;
    }
    Ok(())
}

enum Key<'a> { Concept(&'a str), Col(&'a str) }

/// A suggestion key: a concept id, or `col:<tag_id>` for a collection hint.
fn parse_key(key: &str) -> Option<Key<'_>> {
    match key.strip_prefix("col:") {
        Some(tag) if (1..=64).contains(&tag.len())
            && tag.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')) => Some(Key::Col(tag)),
        Some(_) => None,
        None if lenses::valid_concept_id(key) => Some(Key::Concept(key)),
        None => None,
    }
}

/// Remove one suggestion key from an item's map. The key holds only [a-z0-9_] or
/// col:[A-Za-z0-9._-] (parse_key), so it can sit inside the JSON path.
fn remove_key(conn: &Connection, inspiration_id: &str, key: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE inspirations SET lens_suggestions = json_remove(lens_suggestions, ?2)
         WHERE id = ?1 AND json_valid(lens_suggestions)",
        params![inspiration_id, format!("$.\"{key}\"")],
    )
}

// ── The same-name rule when a tag is linked (spec §0b.2) ─────────────────────
// write_results keeps a concept off an item that has a people's tag of the same name, but only
// for the items it scores, and linking a tag doesn't make an item stale. So the rule also runs
// whenever a tag is linked (answer_with, commands::tag_item) and when collection hints are
// written (commands::apply_collection_hints): a card never asks a name its item already has, and
// Add never gives an item the same name twice.

/// The name keys of a concept: its English and Uzbek labels, from its `concepts` row (placeholder
/// and retired concepts count too). Empty when the concept isn't known.
fn concept_name_keys(conn: &Connection, concept_id: &str) -> rusqlite::Result<HashSet<String>> {
    let labels: Option<String> = conn
        .query_row("SELECT labels_json FROM concepts WHERE id = ?1", params![concept_id], |r| r.get(0))
        .optional()?;
    Ok(labels.as_deref().and_then(lenses::parse_labels)
        .map(|l| [name_key(&l.en), name_key(&l.uz)].into_iter().filter(|k| !k.is_empty()).collect())
        .unwrap_or_default())
}

/// A tag as the same-name rule sees it.
enum Named {
    /// A people's tag (source user or import): the name_key of its name.
    People(String),
    /// A lens tag: the name keys of its concept's two labels.
    Lens(HashSet<String>),
    /// Anything else (an old suggestion tag, a tag that doesn't exist): nothing to compare.
    Other,
}

fn tag_named(conn: &Connection, tag_id: &str) -> rusqlite::Result<Named> {
    let row: Option<(String, String, Option<String>)> = conn
        .query_row("SELECT name, source, concept_id FROM tags WHERE id = ?1", params![tag_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    Ok(match row {
        Some((_, _, Some(cid))) => Named::Lens(concept_name_keys(conn, &cid)?),
        Some((name, source, None)) if source == "user" || source == "import" => {
            let key = name_key(&name);
            if key.is_empty() { Named::Other } else { Named::People(key) }
        }
        _ => Named::Other,
    })
}

/// Whether adding `key` would give the item a name it already has: a lens question whose English
/// or Uzbek label is the name of one of its people's tags (as write_results judges it), or a
/// collection hint whose people's tag has the name of one of its other tags (a lens tag by either
/// label, or a people's tag).
fn has_the_name_already(conn: &Connection, inspiration_id: &str, key: &Key) -> rusqlite::Result<bool> {
    let (asks, hinted) = match key {
        Key::Concept(cid) => (concept_name_keys(conn, cid)?, None),
        Key::Col(tag) => match tag_named(conn, tag)? {
            Named::People(n) => (HashSet::from([n]), Some(*tag)),
            _ => return Ok(false),
        },
    };
    if asks.is_empty() { return Ok(false); }
    let tags: Vec<String> = conn
        .prepare_cached("SELECT tag_id FROM inspiration_tags WHERE inspiration_id = ?1")?
        .query_map(params![inspiration_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for tag in tags.iter().filter(|t| Some(t.as_str()) != hinted) {
        let names = match tag_named(conn, tag)? {
            Named::People(n) => HashSet::from([n]),
            Named::Lens(n) if hinted.is_some() => n,   // a lens tag never stops another concept (write_results doesn't either)
            _ => continue,
        };
        if !names.is_disjoint(&asks) { return Ok(true); }
    }
    Ok(false)
}

/// A collection hint for `tag_id` would ask the item a name it already has (commands::apply_collection_hints).
pub(crate) fn hint_name_taken(conn: &Connection, inspiration_id: &str, tag_id: &str) -> rusqlite::Result<bool> {
    has_the_name_already(conn, inspiration_id, &Key::Col(tag_id))
}

/// `tag_id` was just linked to the item: its stored questions that ask the name this tag gives it
/// leave the map. A people's tag takes the lens questions whose English or Uzbek label is its name
/// and the hints of other people's tags with that name; a lens tag takes the hints of people's
/// tags named like either label of its concept. Each key leaves with json_remove, so the rest of
/// the map, and the item's status, model and signature, stay as they are. Returns the keys removed.
pub(crate) fn drop_questions_named_like(conn: &Connection, inspiration_id: &str, tag_id: &str) -> rusqlite::Result<Vec<String>> {
    let (names, people) = match tag_named(conn, tag_id)? {
        Named::People(n) => (HashSet::from([n]), true),
        Named::Lens(n) if !n.is_empty() => (n, false),
        _ => return Ok(Vec::new()),
    };
    let current: Option<String> = conn
        .query_row("SELECT lens_suggestions FROM inspirations WHERE id = ?1", params![inspiration_id], |r| r.get(0))
        .optional()?.flatten();
    let Some(map) = current.and_then(|s| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s).ok()) else {
        return Ok(Vec::new());
    };
    let mut gone = Vec::new();
    for key in map.keys() {
        let asks = match parse_key(key) {
            Some(Key::Concept(cid)) if people => concept_name_keys(conn, cid)?,
            Some(Key::Col(t)) if t != tag_id => match tag_named(conn, t)? {
                Named::People(n) => HashSet::from([n]),
                _ => continue,
            },
            _ => continue,
        };
        if !asks.is_disjoint(&names) { gone.push(key.clone()); }
    }
    for key in &gone { remove_key(conn, inspiration_id, key)?; }
    Ok(gone)
}

/// Spec §6.3 `answer_suggestion`, in one transaction: record the answer; for `added`, find or
/// create the concept tag (or, for `col:<tag_id>`, take that existing tag), link it and bump its
/// count; remove the key from the item's suggestions, and with it any other question that asks
/// the name just linked (spec §0b.2, drop_questions_named_like). Never touches auto_tag_status,
/// _model or _sig. Returns the linked tag for `added`, None for `dismissed`.
/// Adding links nothing, keeps no answer, removes the key and returns None (contract C4: the page
/// then drops the question) when the hint's tag was deleted meanwhile, or when the item already
/// has the name the question asks (a card read before that tag was linked).
/// The answer keeps the concept's primary lens (`answer_shown_with` with no lens).
pub fn answer_with(conn: &Connection, inspiration_id: &str, key: &str, answer: &str) -> Result<Option<TagOut>, String> {
    answer_shown_with(conn, inspiration_id, key, answer, None)
}

/// `answer_with`, from a card: `shown_by` is the lens that showed the question there (the display
/// rule of spec §0c picks it per media). `tag_answers.lens_id` keeps it when it names an installed
/// lens, otherwise the concept's primary lens (NULL for a pack's stand-in and for `col:` keys).
pub fn answer_shown_with(conn: &Connection, inspiration_id: &str, key: &str, answer: &str, shown_by: Option<&str>) -> Result<Option<TagOut>, String> {
    let db = |e: rusqlite::Error| e.to_string();
    if answer != "added" && answer != "dismissed" { return Err(format!("unknown answer '{answer}'")); }
    let kind = parse_key(key).ok_or_else(|| format!("bad suggestion key '{key}'"))?;
    let added = answer == "added";
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db)?;
    let exists = tx.query_row("SELECT 1 FROM inspirations WHERE id = ?1", params![inspiration_id], |_| Ok(()))
        .optional().map_err(db)?.is_some();
    if !exists { return Err("unknown item".into()); }
    let lens_id: Option<String> = match kind {
        Key::Concept(cid) => {
            let lens: Option<String> = tx.query_row("SELECT lens_id FROM concepts WHERE id = ?1", params![cid], |r| r.get(0))
                .optional().map_err(db)?;
            if added && lens.is_none() { return Err(format!("unknown concept '{cid}'")); }
            let shown: Option<String> = match shown_by.filter(|l| lenses::valid_lens_id(l)) {
                Some(l) => tx.query_row("SELECT id FROM lenses WHERE id = ?1", params![l], |r| r.get(0)).optional().map_err(db)?,
                None => None,
            };
            shown.or(lens.filter(|l| !l.is_empty()))
        }
        Key::Col(tag) => {
            let known = tx.query_row("SELECT 1 FROM tags WHERE id = ?1", params![tag], |_| Ok(())).optional().map_err(db)?.is_some();
            if added && !known {
                remove_key(&tx, inspiration_id, key).map_err(db)?;
                tx.commit().map_err(db)?;
                return Ok(None);
            }
            None
        }
    };
    if added && has_the_name_already(&tx, inspiration_id, &kind).map_err(db)? {
        remove_key(&tx, inspiration_id, key).map_err(db)?;
        tx.commit().map_err(db)?;
        return Ok(None);
    }
    tx.execute(
        "INSERT INTO tag_answers (inspiration_id, concept_id, answer, lens_id, answered_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(inspiration_id, concept_id) DO UPDATE SET
           answer = excluded.answer, lens_id = excluded.lens_id, answered_at = excluded.answered_at",
        params![inspiration_id, key, answer, lens_id, lenses::now_ms()],
    ).map_err(db)?;
    let linked = if added {
        let tag_id = match kind { Key::Concept(cid) => ensure_concept_tag(&tx, cid).map_err(db)?, Key::Col(tag) => tag.to_string() };
        link_tag(&tx, inspiration_id, &tag_id).map_err(db)?;
        Some(tag_id)
    } else { None };
    remove_key(&tx, inspiration_id, key).map_err(db)?;
    if let Some(tag_id) = &linked { drop_questions_named_like(&tx, inspiration_id, tag_id).map_err(db)?; }
    let tag = match linked { Some(id) => load_tag(&tx, &id).map_err(db)?, None => None };
    tx.commit().map_err(db)?;
    Ok(tag)
}

/// Turn on only `role`'s lens, remember the role and turn tag suggestions on, atomically.
pub fn apply_role_with(conn: &Connection, role: &str) -> rusqlite::Result<usize> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let n = tx.execute("UPDATE lenses SET enabled = CASE WHEN id = ?1 THEN 1 ELSE 0 END", params![role])?;
    let on = tx.query_row("SELECT COUNT(*) FROM lenses WHERE id = ?1", params![role], |r| r.get::<_, i64>(0))?;
    tx.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)", params![PREF_ROLE, role])?;
    tx.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, 'true')", params![PREF_SWITCH])?;
    tx.commit()?;
    if on == 0 { log::warn!(target: "Lens", "role '{role}' chosen but its lens isn't installed"); }
    Ok(n)
}

// ── Commands (spec §6.3) ──────────────────────────────────────────────────────

fn emit_changed(app: &AppHandle) {
    if let Err(e) = app.emit("lens:changed", serde_json::json!({})) {
        log::warn!(target: "Lens", "lens:changed not sent: {e}");
    }
}

/// The role step's answer: enables only that role's lens, sets `user_role`, turns tag
/// suggestions on, wakes the indexer and emits `lens:changed`. Roles: motion, design, thumbnail.
#[tauri::command]
pub fn apply_role(role: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if !lenses::LENS_ORDER.contains(&role.as_str()) { return Err(format!("unknown role '{role}'")); }
    apply_role_with(&lock_db(&state), &role).map_err(|e| e.to_string())?;
    emit_changed(&app);
    suggestions_turned_on(&app);
    Ok(())
}

/// One lens file fetched from the catalogue: its text, and the size, SHA-256, lens id and version
/// its index entry gave.
#[derive(Clone, Debug, Deserialize)]
pub struct LensUpload {
    pub text: String,
    pub sha256: String,
    pub size: u64,
    pub id: String,
    pub version: i64,
}

/// The request first (at most 3 files, 768 KB in all: `invalid`), then each file's size and
/// SHA-256 (`checksum`), then every rule, the file's id and version against its index entry and
/// the three known lenses (`invalid`), then `min_app` (`too_new`).
pub fn check_uploads(files: &[LensUpload], app_version: &str) -> Result<Vec<Lens>, InstallError> {
    if files.len() > lenses::MAX_UPLOAD_FILES {
        return Err(InstallError::Invalid(format!("{} files (at most {})", files.len(), lenses::MAX_UPLOAD_FILES)));
    }
    let total: usize = files.iter().map(|f| f.text.len()).sum();
    if total > lenses::MAX_UPLOAD_BYTES {
        return Err(InstallError::Invalid(format!("{total} bytes in all (at most {})", lenses::MAX_UPLOAD_BYTES)));
    }
    for f in files {
        if f.text.len() as u64 != f.size {
            return Err(InstallError::Checksum(format!("{} bytes, index says {}", f.text.len(), f.size)));
        }
        if !lenses::sha256_hex(f.text.as_bytes()).eq_ignore_ascii_case(f.sha256.trim()) {
            return Err(InstallError::Checksum("sha256 differs from the index".into()));
        }
    }
    let parsed: Vec<Lens> = files.iter().map(|f| lenses::parse_lens(&f.text, false)).collect::<Result<_, _>>()
        .map_err(InstallError::Invalid)?;
    for (l, f) in parsed.iter().zip(files) {
        if l.id != f.id || l.version != f.version {
            return Err(InstallError::Invalid(format!("the file holds {} v{}, its index entry says {} v{}", l.id, l.version, f.id, f.version)));
        }
        if !lenses::LENS_ORDER.contains(&l.id.as_str()) {
            return Err(InstallError::Invalid(format!("lens '{}' isn't one qooti installs", l.id)));
        }
    }
    if let Some(app) = lenses::parse_version(app_version) {
        for l in &parsed {
            if let Some(min) = l.min_app.as_deref().and_then(lenses::parse_version) {
                if min > app { return Err(InstallError::TooNew(format!("{} needs qooti {}", l.id, l.min_app.as_deref().unwrap_or("?")))); }
            }
        }
    }
    Ok(parsed)
}

/// Install catalogue files all-or-nothing → `{installed:[ids], unchanged:[ids]}`, or the error
/// code `invalid` / `checksum` / `too_new` (`failed` if the database refused the write).
/// Re-scores afterwards and emits `lens:changed` when something was installed.
#[tauri::command]
pub fn install_lenses(files: Vec<LensUpload>, app: AppHandle, state: State<AppState>) -> Result<InstallReport, String> {
    let refuse = |e: InstallError| { log::warn!(target: "Lens", "lens update refused: {e}"); e.code().to_string() };
    let parsed = check_uploads(&files, &app.package_info().version.to_string()).map_err(refuse)?;
    let pairs: Vec<(Lens, &str)> = parsed.into_iter().zip(files.iter().map(|f| f.text.as_str())).collect();
    let report = install_catalogue_with(&lock_db(&state), &pairs).map_err(refuse)?;
    if !report.installed.is_empty() {
        emit_changed(&app);
        spawn_score_stale(&app);
    }
    Ok(report)
}

/// install_lenses on one connection: the files all or nothing (lenses::install), then, when
/// something was installed, the tags it concerns (tags_after_install).
pub fn install_catalogue_with(conn: &Connection, files: &[(Lens, &str)]) -> Result<InstallReport, InstallError> {
    let report = lenses::install(conn, files, Origin::Catalogue)?;
    if !report.installed.is_empty() {
        if let Err(e) = tags_after_install(conn) {
            log::warn!(target: "Lens", "tags not joined or named after the lens update (next start tries again): {e}");
        }
    }
    Ok(report)
}

/// A lens version installed while the app runs can change a label: a lens tag's name may now be a
/// people's tag's, or a stored name may follow the new label or be free again. The same two steps
/// as every start (adopt_older_build_tags), so the page never shows two tags with one name until the
/// next start: each lens tag joins the people's tag with its name (join_same_name_tags), then every
/// lens tag left gets its stored name (name_lens_tags). Both read once and write nothing when there
/// is nothing to do. Returns what was joined and how many lens tags were renamed (logged).
pub fn tags_after_install(conn: &Connection) -> rusqlite::Result<(Joined, usize)> {
    let joined = join_same_name_tags(conn)?;
    if joined.joined + joined.two_named + joined.other_concept > 0 {
        log::info!(target: "Lens", "after the lens update, one name, one tag: {} lens tags joined people's tags ({} links); kept apart: {} \
            named like two people's tags, {} named like a people's tag of another tag", joined.joined, joined.links, joined.two_named, joined.other_concept);
    }
    let renamed = name_lens_tags(conn)?;
    if renamed > 0 { log::info!(target: "Lens", "after the lens update: {renamed} lens tags renamed"); }
    Ok((joined, renamed))
}

/// `{enabled, total, scored, waiting_videos, last_check, per_lens:{id: items_with_open_suggestions}}`
#[tauri::command]
pub fn lens_status(state: State<AppState>) -> Result<LensStatus, String> {
    let not_now = crate::clip::videos_not_now();
    let db = lock_db(&state);
    let cat = lenses::catalogue(&db);
    status_with(&db, &cat, &not_now).map_err(|e| e.to_string())
}

/// Settings › Library › Tag lens came on screen (`on = true`) or left it (`false`). Rust sends
/// `lens:status` only while it is on screen; turning it on sends one straight away, so the page
/// can't miss a run that ended just before (contract C2).
#[tauri::command]
pub fn lens_status_watch(on: bool, app: AppHandle) {
    let was = WATCHING.swap(on, Ordering::AcqRel);
    if on && !was { std::thread::spawn(move || emit_status(&app)); }
}

/// One item's stored suggestions, as the grid reads them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SuggestionMap {
    /// `lens_suggestions` as stored: a JSON object {concept id or `col:<tag id>`: score}, or null
    /// (the page keeps it in the item's `auto_tag_confidence` field, commands::Inspiration).
    pub conf: Option<String>,
    /// `auto_tag_model` (`lens-1` once the lenses scored the item).
    pub model: Option<String>,
}

/// At most this many ids per `get_suggestion_maps` call.
pub const MAX_MAP_IDS: usize = 1000;

/// `ids` → their stored suggestion maps; ids of items that don't exist are left out. More than
/// MAX_MAP_IDS ids: the error `too_many`.
pub fn suggestion_maps_with(conn: &Connection, ids: &[String]) -> Result<BTreeMap<String, SuggestionMap>, String> {
    if ids.len() > MAX_MAP_IDS { return Err("too_many".into()); }
    let mut out = BTreeMap::new();
    for chunk in ids.chunks(CHUNK) {
        let sql = format!("SELECT id, lens_suggestions, auto_tag_model FROM inspirations WHERE id IN ({})",
            vec!["?"; chunk.len()].join(","));
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| Ok((
            r.get::<_, String>(0)?, SuggestionMap { conf: r.get(1)?, model: r.get(2)? },
        ))).map_err(|e| e.to_string())?;
        for row in rows {
            let (id, map) = row.map_err(|e| e.to_string())?;
            out.insert(id, map);
        }
    }
    Ok(out)
}

/// `{[id]: {conf, model}}` for up to 1000 items in one call (the grid refreshes its cards'
/// questions with it after `autotag:scored`; contract C1).
#[tauri::command]
pub fn get_suggestion_maps(ids: Vec<String>, state: State<AppState>) -> Result<BTreeMap<String, SuggestionMap>, String> {
    if ids.len() > MAX_MAP_IDS { return Err("too_many".into()); }
    suggestion_maps_with(&lock_db(&state), &ids)
}

/// Add or dismiss one suggestion. `key` is a concept id or `col:<tag_id>`; `answer` is `added` or
/// `dismissed`; `lensId` (optional, null when unknown) is the lens that showed it on the card.
/// Returns the linked tag for `added`, null for `dismissed`.
#[tauri::command]
pub fn answer_suggestion(inspiration_id: String, key: String, answer: String, lens_id: Option<String>, state: State<AppState>) -> Result<Option<TagOut>, String> {
    answer_shown_with(&lock_db(&state), &inspiration_id, &key, &answer, lens_id.as_deref())
}

/// The detail picker's manual add of a concept: the same as answering `added`.
#[tauri::command]
pub fn add_concept_tag(inspiration_id: String, concept_id: String, state: State<AppState>) -> Result<TagOut, String> {
    if !lenses::valid_concept_id(&concept_id) { return Err(format!("bad concept id '{concept_id}'")); }
    answer_with(&lock_db(&state), &inspiration_id, &concept_id, "added")?.ok_or_else(|| "tag not linked".to_string())
}

/// Clear every item's signature and re-score (instant for items that already have vectors).
/// Returns how many items were cleared.
#[tauri::command]
pub fn retag_all(app: AppHandle, state: State<AppState>) -> Result<usize, String> {
    let n = lock_db(&state)
        .execute("UPDATE inspirations SET auto_tag_sig = NULL WHERE auto_tag_sig IS NOT NULL", [])
        .map_err(|e| e.to_string())?;
    spawn_score_stale(&app);
    Ok(n)
}

/// Wake the indexer (new items were added or imported).
#[tauri::command]
pub fn tagging_wake() {
    crate::clip::wake();
}

// ── One-time upgrade step (spec §4.1) ─────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub enum Upgrade {
    AlreadyDone,
    /// The backup couldn't be written: nothing was changed; the next launch tries again.
    BackupFailed(String),
    Done { tags: usize, links: usize, backup: Option<PathBuf> },
}

/// Write `bytes` to `path` so they are on the disk, not only in the OS cache, before the caller
/// goes on: written to `part`, forced to disk (sync_all), then renamed. Syncing before the rename
/// is what counts: if a crash loses the rename, the .part file still holds everything. The
/// rename itself is then flushed too, as far as the OS allows (best effort).
fn write_durably(part: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    {
        let mut f = std::fs::File::create(part)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(part, path)?;
    #[cfg(windows)]
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) { let _ = f.sync_all(); }
    #[cfg(not(windows))]
    if let Some(dir) = path.parent() { if let Ok(d) = std::fs::File::open(dir) { let _ = d.sync_all(); } }
    Ok(())
}

/// The old suggestion column, `auto_tag_confidence`: this version never reads it (its suggestions
/// are in `lens_suggestions`), and qooti 1.2.2 shows every key in it as a tag name ("web_design")
/// and makes a tag of it on Add. At every start it is emptied on every row, so an older version
/// opening the library shows no suggestions instead of ids. auto_tag_status, _model and _sig stay
/// as this version set them: 1.2.2 doesn't start its own tagger on items scored here. Only machine
/// output changes; tags never do. Returns how many items changed.
pub fn clear_legacy_suggestions(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("UPDATE inspirations SET auto_tag_confidence = NULL WHERE auto_tag_confidence IS NOT NULL", [])
}

// ── Tags an older version made from suggestion keys ───────────────────────────

/// What `adopt_older_build_tags` changed (counts only, for the log).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct OlderTags {
    /// Tags that became their concept's lens tag, or joined the tag that already had their name.
    pub merged: usize,
    /// Tags that got a readable name.
    pub renamed: usize,
    /// Item links that moved with them (a link the item already had doesn't count).
    pub links: usize,
    /// Lens tags given the name older versions show (name_lens_tags).
    pub lens_names: usize,
    /// Lens tags that joined the people's tag with their name (join_same_name_tags).
    pub joined: usize,
}

/// A name for a tag that isn't one: underscores (and runs of spaces) become one space, the first
/// letter upper case ("dark_ui" → "Dark ui").
fn readable_name(name: &str) -> String {
    let words: Vec<&str> = name.split(|c: char| c == '_' || c.is_whitespace()).filter(|w| !w.is_empty()).collect();
    let joined = words.join(" ");
    let mut chars = joined.chars();
    match chars.next() { Some(c) => c.to_uppercase().chain(chars).collect(), None => String::new() }
}

/// The tags older builds left that would show an id, made proper tags at every start (cheap when
/// there are none). qooti 1.2.2 shows each key of `auto_tag_confidence` as a tag name and its Add
/// makes a `model` tag of it ("icons", "web_design"); an earlier build of this version stored lens
/// tags as 'lens:<id>'. Each tag with source `model`, and each other tag that isn't a people's tag
/// (source user or import) or a lens tag and has an underscore or the prefix `lens:` in its name:
/// - a name equal (any case, with or without `lens:`) to a concept id this library knows
///   (installed, or retired: its row keeps the labels) is merged into that concept's lens tag,
///   made the way Add makes it if it doesn't exist: its items get the lens tag and an `added`
///   answer, as Add gives them, unless an item already has a people's tag with that name (spec
///   §0b.2); the question leaves the item. A tag named 'lens:<id>' whose concept has no tag yet
///   simply becomes that tag;
/// - a name equal to an old vocabulary id (tag_vocab) gets that entry's English label;
/// - any other name with an underscore or `lens:` gets `readable_name`.
/// A new name that a concept's label or another tag already has joins that tag instead. Links
/// (never twice), collection-hint answers and counts move with a merge. People's tags are never
/// renamed or merged away. Waits for the one-time step (`lens_v1_migrated`), which backs up and
/// removes the old suggestion tags itself. Then each lens tag joins the people's tag with its name
/// (join_same_name_tags: one name, one tag), and every lens tag left gets the stored name older
/// versions show (name_lens_tags).
pub fn adopt_older_build_tags(conn: &Connection) -> rusqlite::Result<OlderTags> {
    // The names are set even when the adoption failed (its transaction left nothing behind; the
    // next start tries it again)
    let adopted = adopt_tags_with_ids(conn);
    let joined = join_same_name_tags(conn);
    if let Ok(j) = &joined {
        if j.joined + j.two_named + j.other_concept > 0 {
            log::info!(target: "Lens", "one name, one tag: {} lens tags joined people's tags ({} links); kept apart: {} \
                named like two people's tags, {} named like a people's tag of another tag", j.joined, j.links, j.two_named, j.other_concept);
        }
    }
    let named = name_lens_tags(conn);
    let mut done = adopted?;
    done.joined = joined?.joined;
    done.lens_names = named?;
    Ok(done)
}

fn adopt_tags_with_ids(conn: &Connection) -> rusqlite::Result<OlderTags> {
    let mut done = OlderTags::default();
    let migrated: Option<String> = conn
        .query_row("SELECT value FROM schema_meta WHERE key = ?1", params![MIGRATED_KEY], |r| r.get(0)).optional()?;
    if migrated.as_deref() != Some("1") { return Ok(done); }
    // Only the tags with something to change (a model tag named like no concept and no old
    // vocabulary id, without an underscore, stays as it is): nothing to do is one read
    let vocab = table_exists(conn, "tag_vocab")?;
    let sql = format!(
        "SELECT t.id, t.name FROM tags t WHERE t.concept_id IS NULL AND t.source NOT IN ('user', 'import')
           AND (instr(t.name, '_') > 0 OR lower(trim(t.name)) LIKE 'lens:%'
                OR (t.source = 'model' AND (lower(trim(t.name)) IN (SELECT id FROM concepts){})))
         ORDER BY t.name, t.id",
        if vocab { " OR lower(trim(t.name)) IN (SELECT lower(id) FROM tag_vocab)" } else { "" });
    let candidates = |conn: &Connection| -> rusqlite::Result<Vec<(String, String)>> {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
        rows
    };
    if candidates(conn)?.is_empty() { return Ok(done); }

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    for (tag_id, name) in candidates(&tx)? {
        let lower = name.trim().to_lowercase();
        let lens_named = lower.starts_with("lens:");
        let key = if lens_named { lower["lens:".len()..].trim().to_string() } else { lower };
        let concept = lenses::valid_concept_id(&key) && !concept_name_keys(&tx, &key)?.is_empty();
        if concept {
            let owner: Option<String> = tx
                .query_row("SELECT id FROM tags WHERE concept_id = ?1 LIMIT 1", params![key], |r| r.get(0))
                .optional()?;
            if lens_named && owner.is_none() {
                // A lens tag an earlier build stored without concept_id: it is that concept's tag
                // (its name is set with the others', below)
                tx.execute("UPDATE tags SET concept_id = ?2, source = 'lens' WHERE id = ?1", params![tag_id, key])?;
            } else {
                done.links += merge_tag(&tx, &tag_id, Target::Concept(&key))?;
            }
            done.merged += 1;
            continue;
        }
        let label: Option<String> = if vocab {
            tx.query_row("SELECT labels_json FROM tag_vocab WHERE lower(id) = ?1", params![key], |r| r.get::<_, String>(0))
                .optional()?
                .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
                .and_then(|v| v["en"].as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
        } else { None };
        let new_name = match label {
            Some(l) => readable_label(&l),
            None if lens_named => readable_name(&key),
            None if name.contains('_') => readable_name(&name),
            None => continue,
        };
        if new_name.is_empty() || new_name == name { continue; }
        let wanted = name_key(&new_name);
        // A concept whose label is that name: its lens tag
        let by_label: Option<String> = {
            let mut stmt = tx.prepare_cached("SELECT id, labels_json FROM concepts WHERE active = 1 ORDER BY id")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut found = None;
            for row in rows {
                let (id, labels) = row?;
                if lenses::parse_labels(&labels).is_some_and(|l| name_key(&l.en) == wanted || name_key(&l.uz) == wanted) {
                    found = Some(id);
                    break;
                }
            }
            found
        };
        if let Some(cid) = by_label {
            done.links += merge_tag(&tx, &tag_id, Target::Concept(&cid))?;
            done.merged += 1;
            continue;
        }
        // Another tag with that name (any case; a people's tag keeps its own name), people's tags
        // first: also one that stands for a concept (one name, one tag), whose name stays its own
        // when a new lens version changes the concept's label
        let same: Option<String> = {
            let mut stmt = tx.prepare_cached(
                "SELECT id, name FROM tags WHERE (concept_id IS NULL OR source IN ('user', 'import')) AND id != ?1
                 ORDER BY source IN ('user', 'import') DESC, id")?;
            let rows = stmt.query_map(params![tag_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut found = None;
            for row in rows {
                let (id, other) = row?;
                if name_key(&other) == wanted { found = Some(id); break; }
            }
            found
        };
        match same {
            Some(target) => { done.links += merge_tag(&tx, &tag_id, Target::Tag(&target))?; done.merged += 1; }
            None => {
                // A lens tag stored under that name (a label since changed) moves on: names are UNIQUE
                make_room_for_name(&tx, &new_name)?;
                tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![tag_id, new_name])?;
                done.renamed += 1;
            }
        }
    }
    tx.commit()?;
    Ok(done)
}

/// An old vocabulary label as a tag name: as it is, without underscores.
fn readable_label(label: &str) -> String {
    if label.contains('_') { readable_name(label) } else { label.to_string() }
}

/// Where `merge_tag` moves a tag's links: an existing tag, or a concept's lens tag.
enum Target<'a> { Tag(&'a str), Concept(&'a str) }

/// Move `from`'s links into `into` (inside the caller's transaction) and delete `from`. A concept's
/// lens tag is given the way Add gives it: not to an item that already has a people's tag with
/// that name (spec §0b.2), with an `added` answer (an earlier answer stays), and its question
/// leaves the item; the lens tag is made (ensure_concept_tag) only when an item gets it. An
/// existing tag that stands for a concept (one name, one tag) takes that concept's question off
/// the items it gets. Answers to collection hints of `from` move with its links; its hints leave
/// the items. Returns how many links were new.
fn merge_tag(tx: &Connection, from: &str, into: Target) -> rusqlite::Result<usize> {
    let items: Vec<String> = {
        let mut stmt = tx.prepare("SELECT inspiration_id FROM inspiration_tags WHERE tag_id = ?1 ORDER BY inspiration_id")?;
        let rows = stmt.query_map(params![from], |r| r.get(0))?.collect::<Result<_, _>>()?;
        rows
    };
    let (concept, mut to) = match into { Target::Tag(t) => (None, Some(t.to_string())), Target::Concept(c) => (Some(c), None) };
    let lens: Option<String> = match concept {
        Some(cid) => tx.query_row("SELECT NULLIF(lens_id, '') FROM concepts WHERE id = ?1", params![cid], |r| r.get(0))
            .optional()?.flatten(),
        None => None,
    };
    let mut moved = 0;
    for item in &items {
        if let Some(cid) = concept {
            if has_the_name_already(tx, item, &Key::Concept(cid))? { continue; }
            if to.is_none() { to = Some(ensure_concept_tag(tx, cid)?); }
            tx.execute(
                "INSERT INTO tag_answers (inspiration_id, concept_id, answer, lens_id, answered_at) VALUES (?1, ?2, 'added', ?3, ?4)
                 ON CONFLICT(inspiration_id, concept_id) DO NOTHING",
                params![item, cid, lens, lenses::now_ms()],
            )?;
            remove_key(tx, item, cid)?;
        }
        let Some(to) = to.as_deref() else { continue };
        moved += tx.execute("INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES (?1, ?2)", params![item, to])?;
        drop_questions_named_like(tx, item, to)?;
    }
    if let Some(to) = &to {
        tx.execute("UPDATE OR IGNORE tag_answers SET concept_id = 'col:' || ?2 WHERE concept_id = 'col:' || ?1", params![from, to])?;
    }
    tx.execute("DELETE FROM tag_answers WHERE concept_id = 'col:' || ?1", params![from])?;
    if parse_key(&format!("col:{from}")).is_some() {
        tx.execute(
            "UPDATE inspirations SET lens_suggestions = json_remove(lens_suggestions, ?1)
             WHERE json_valid(lens_suggestions) AND json_type(lens_suggestions, ?1) IS NOT NULL",
            params![format!("$.\"col:{from}\"")],
        )?;
    }
    tx.execute("DELETE FROM inspiration_tags WHERE tag_id = ?1", params![from])?;
    tx.execute("DELETE FROM tag_usage_counts WHERE tag_id = ?1", params![from])?;
    tx.execute("DELETE FROM tags WHERE id = ?1", params![from])?;
    if let Some(to) = &to {
        tx.execute(
            "INSERT OR REPLACE INTO tag_usage_counts (tag_id, count) SELECT ?1, COUNT(*) FROM inspiration_tags WHERE tag_id = ?1",
            params![to],
        )?;
        // An existing tag that stands for a concept (a people's tag that is a concept's tag: one
        // name, one tag): the items it now has aren't asked about that concept any more, as on Add
        if concept.is_none() {
            let stands_for: Option<String> = tx
                .query_row("SELECT concept_id FROM tags WHERE id = ?1", params![to], |r| r.get(0))
                .optional()?.flatten();
            if let Some(cid) = stands_for { settle_concept_tag(tx, to, &cid)?; }
        }
    }
    Ok(moved)
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", params![name], |_| Ok(()))
        .optional().map(|r| r.is_some())
}

/// Back up the tags made from the old suggestions (`source = 'model'`) with their links and
/// counts, then — in one transaction — delete them, clear every item's suggestion fields, empty
/// tag_vocab and mark the step done (`schema_meta.lens_v1_migrated = 1`). Tags people made
/// (user, import) are kept. When the backup can't be written nothing changes. Idempotent.
pub fn upgrade_once_with(conn: &Connection, backup_dir: &Path, unix: i64) -> Result<Upgrade, String> {
    let db = |e: rusqlite::Error| e.to_string();
    let done: Option<String> = conn.query_row("SELECT value FROM schema_meta WHERE key = ?1", params![MIGRATED_KEY], |r| r.get(0))
        .optional().map_err(db)?;
    if done.as_deref() == Some("1") { return Ok(Upgrade::AlreadyDone); }

    // 1. Back up first.
    let mut tags: Vec<serde_json::Value> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.source, t.created_at, COALESCE(u.count, 0) FROM tags t
             LEFT JOIN tag_usage_counts u ON u.tag_id = t.id WHERE t.source = 'model' ORDER BY t.name").map_err(db)?;
        let mut links = conn.prepare("SELECT inspiration_id FROM inspiration_tags WHERE tag_id = ?1 ORDER BY inspiration_id").map_err(db)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                                                 r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))).map_err(db)?;
        for row in rows {
            let (id, name, source, created_at, usage_count) = row.map_err(db)?;
            let items: Vec<String> = links.query_map(params![id], |r| r.get(0)).map_err(db)?.collect::<Result<_, _>>().map_err(db)?;
            tags.push(serde_json::json!({ "id": id, "name": name, "source": source, "created_at": created_at,
                                          "usage_count": usage_count, "inspiration_ids": items }));
        }
    }
    let link_count: usize = tags.iter().map(|t| t["inspiration_ids"].as_array().map_or(0, |a| a.len())).sum();
    let backup = if tags.is_empty() { None } else {
        let doc = serde_json::json!({ "kind": "qooti-model-tags", "created_at": unix, "tags": tags });
        let path = backup_dir.join(format!("model-tags-{unix}.json"));
        let part = backup_dir.join(format!("model-tags-{unix}.json.part"));
        let written = std::fs::create_dir_all(backup_dir)
            .and_then(|_| write_durably(&part, &path, &serde_json::to_vec_pretty(&doc).unwrap_or_default()));
        if let Err(e) = written {
            let _ = std::fs::remove_file(&part);
            return Ok(Upgrade::BackupFailed(e.to_string()));
        }
        Some(path)
    };

    // 2. Delete the old data, and 3. mark it done — one transaction, only once the backup is on disk.
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db)?;
    tx.execute("DELETE FROM inspiration_tags WHERE tag_id IN (SELECT id FROM tags WHERE source = 'model')", []).map_err(db)?;
    tx.execute("DELETE FROM tag_usage_counts WHERE tag_id IN (SELECT id FROM tags WHERE source = 'model')", []).map_err(db)?;
    tx.execute("DELETE FROM tags WHERE source = 'model'", []).map_err(db)?;
    tx.execute(
        "UPDATE inspirations SET auto_tag_confidence = NULL, lens_suggestions = NULL, auto_tag_status = NULL, auto_tag_model = NULL,
           auto_tag_sig = NULL
         WHERE auto_tag_confidence IS NOT NULL OR lens_suggestions IS NOT NULL OR auto_tag_status IS NOT NULL
            OR auto_tag_model IS NOT NULL OR auto_tag_sig IS NOT NULL",
        [],
    ).map_err(db)?;
    if table_exists(&tx, "tag_vocab").map_err(db)? { tx.execute("DELETE FROM tag_vocab", []).map_err(db)?; }
    tx.execute("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?1, '1')", params![MIGRATED_KEY]).map_err(db)?;
    tx.commit().map_err(db)?;
    Ok(Upgrade::Done { tags: tags.len(), links: link_count, backup })
}

/// The one-time upgrade step at start-up (after `app.manage(AppState)`; before `score_stale`).
/// The backup goes to `<app_data>/backups/model-tags-<unix>.json`.
pub fn upgrade_once(app: &AppHandle) {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d.join("backups"),
        Err(e) => { log::warn!(target: "Lens", "upgrade step skipped (no app data folder): {e}"); return; }
    };
    let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let state = app.state::<AppState>();
    let db = lock_db(&state);
    let result = upgrade_once_with(&db, &dir, unix);
    match result {
        Ok(Upgrade::AlreadyDone) => {}
        Ok(Upgrade::Done { tags, links, backup }) => log::info!(target: "Lens",
            "upgrade: removed {tags} suggestion tags ({links} links), backup {:?}", backup),
        Ok(Upgrade::BackupFailed(e)) => log::warn!(target: "Lens", "upgrade step postponed, backup failed: {e}"),
        Err(e) => log::error!(target: "Lens", "upgrade step failed (will retry next start): {e}"),
    }
    // Tags older builds left that would show an id, and the stored names of lens tags (counts only).
    match adopt_older_build_tags(&db) {
        Ok(r) if r == OlderTags::default() => {}
        Ok(OlderTags { merged, renamed, links, lens_names, joined }) => log::info!(target: "Lens",
            "tags from an older version: {merged} merged, {renamed} renamed, {links} links moved; {joined} lens tags joined \
             people's tags of their name; {lens_names} lens tags renamed"),
        Err(e) => log::warn!(target: "Lens", "tags from an older version not fixed (next start tries again): {e}"),
    }
    // Independent of the step above (which waits for its backup): the old column holds nothing.
    match clear_legacy_suggestions(&db) {
        Ok(0) => {}
        Ok(n) => log::info!(target: "Lens", "cleared the old suggestion column of {n} items"),
        Err(e) => log::warn!(target: "Lens", "couldn't clear the old suggestion column: {e}"),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lenses::testkit::*;
    use crate::lenses::{Role, DEFAULT_BAR_PICTURE, DEFAULT_BAR_VIDEO};

    fn concept(lens: &str, id: &str, media: Media, aspect: Option<(f64, f64)>, vec: Vec<f32>) -> Concept {
        Concept {
            id: id.into(), lens_id: lens.into(), label: I18n { en: id.into(), uz: id.into() }, group: None, suggest: true,
            media, aspect, prompts: vec![format!("{id} a"), format!("{id} b")], vec,
        }
    }

    fn lens(id: &str, role: Role, concepts: Vec<Concept>) -> Lens {
        Lens {
            id: id.into(), version: 1, role, name: I18n { en: id.into(), uz: id.into() }, summary: I18n { en: id.into(), uz: id.into() },
            bar_picture: DEFAULT_BAR_PICTURE, bar_video: DEFAULT_BAR_VIDEO, borrows: vec![], concepts, template: None,
            min_app: None, placeholder: false, sha256: format!("sha-{id}"),
        }
    }

    /// base `design` (d0..d11), specialists `motion` (m0..m7, m7 video-only) and `thumbnail` (t0..t7).
    fn three_lenses() -> (Lens, Lens, Lens) {
        let d = lens("design", Role::Base, (0..12).map(|i| concept("design", &format!("d{i}"), Media::Any, None, unit(1000 + i))).collect());
        let m = lens("motion", Role::Specialist, (0..8).map(|i| concept("motion", &format!("m{i}"),
            if i == 7 { Media::Video } else { Media::Any }, None, unit(2000 + i))).collect());
        let t = lens("thumbnail", Role::Specialist, (0..8).map(|i| concept("thumbnail", &format!("t{i}"), Media::Any, None, unit(3000 + i))).collect());
        (d, m, t)
    }

    /// Pictures and videos pulled towards random concepts, so plenty of them get suggestions.
    fn items(cat: &Catalogue) -> Vec<ItemInput> {
        let all: Vec<&Concept> = cat.lenses.iter().flat_map(|l| l.concepts.iter()).collect();
        (0..240u64).map(|s| {
            let target = &all[(s as usize * 7) % all.len()].vec;
            let near = |k: u64| mix(&unit(50_000 + s * 31 + k), target, 0.15 + (s % 5) as f32 * 0.1);
            if s % 3 == 0 {
                ItemInput { id: format!("v{s}"), media: Media::Video, aspect: 1.0, vectors: Vectors::Frames((0..8).map(near).collect()) }
            } else {
                ItemInput { id: format!("p{s}"), media: Media::Picture, aspect: 1.0, vectors: Vectors::One(near(0)) }
            }
        }).collect()
    }

    fn only<'a>(out: &'a [(String, f64)], prefix: char) -> Vec<&'a (String, f64)> {
        out.iter().filter(|(id, _)| id.starts_with(prefix)).collect()
    }

    #[test]
    fn base_output_is_identical_whatever_else_is_installed() {
        let (d, m, t) = three_lenses();
        let full = Catalogue::from_lenses(vec![d.clone(), m.clone(), t.clone()]);
        let alone = Catalogue::from_lenses(vec![d.clone()]);
        let with_m = Catalogue::from_lenses(vec![d.clone(), m.clone()]);
        let (sf, sa, sm) = (Scorer::new(&full), Scorer::new(&alone), Scorer::new(&with_m));
        let mut fired = 0;
        for it in items(&full) {
            let a = sa.score(&it);
            assert!(a.iter().all(|(id, _)| id.starts_with('d')));
            assert_eq!(only(&sf.score(&it), 'd'), a.iter().collect::<Vec<_>>(), "{}", it.id);
            assert_eq!(only(&sm.score(&it), 'd'), a.iter().collect::<Vec<_>>(), "{}", it.id);
            fired += a.len();
        }
        assert!(fired > 50, "the test needs base suggestions to compare ({fired})");
    }

    #[test]
    fn specialists_are_independent() {
        let (d, m, t) = three_lenses();
        let full = Catalogue::from_lenses(vec![d.clone(), m.clone(), t.clone()]);
        let dm = Catalogue::from_lenses(vec![d.clone(), m.clone()]);
        let dt = Catalogue::from_lenses(vec![d.clone(), t.clone()]);
        let (sf, sm, st) = (Scorer::new(&full), Scorer::new(&dm), Scorer::new(&dt));
        let (mut m_fired, mut t_fired) = (0, 0);
        for it in items(&full) {
            let f = sf.score(&it);
            assert_eq!(only(&f, 'm'), only(&sm.score(&it), 'm'), "{}", it.id);
            assert_eq!(only(&f, 't'), only(&st.score(&it), 't'), "{}", it.id);
            m_fired += only(&f, 'm').len();
            t_fired += only(&f, 't').len();
        }
        assert!(m_fired > 10 && t_fired > 10, "{m_fired} {t_fired}");
    }

    #[test]
    fn video_only_concepts_never_reach_pictures() {
        let (d, m, t) = three_lenses();
        let m7 = m.concepts[7].vec.clone();
        let cat = Catalogue::from_lenses(vec![d, m, t]);
        let s = Scorer::new(&cat);
        let pic = ItemInput { id: "p".into(), media: Media::Picture, aspect: 1.0, vectors: Vectors::One(m7.clone()) };
        assert!(!s.score(&pic).iter().any(|(id, _)| id == "m7"));
        // The same vector on a video: m7 wins every frame.
        let vid = ItemInput { id: "v".into(), media: Media::Video, aspect: 1.0, vectors: Vectors::Frames(vec![m7.clone(); 8]) };
        assert!(s.score(&vid).iter().any(|(id, _)| id == "m7"));
        // …and with the picture rule (one frame, or the cover).
        let one = ItemInput { id: "v1".into(), media: Media::Video, aspect: 1.0, vectors: Vectors::One(m7) };
        assert!(s.score(&one).iter().any(|(id, _)| id == "m7"));
        // Picture-only concepts never reach videos either.
        let mut d = three_lenses().0;
        d.concepts[0].media = Media::Picture;
        let d0 = d.concepts[0].vec.clone();
        let cat = Catalogue::from_lenses(vec![d]);
        let s = Scorer::new(&cat);
        let vid = ItemInput { id: "v".into(), media: Media::Video, aspect: 1.0, vectors: Vectors::Frames(vec![d0.clone(); 8]) };
        assert!(!s.score(&vid).iter().any(|(id, _)| id == "d0"));
        let pic = ItemInput { id: "p".into(), media: Media::Picture, aspect: 1.0, vectors: Vectors::One(d0) };
        assert!(s.score(&pic).iter().any(|(id, _)| id == "d0"));
    }

    #[test]
    fn aspect_gate() {
        let mut d = three_lenses().0;
        d.concepts[0].aspect = Some((1.7, 1.8));
        let v = d.concepts[0].vec.clone();
        let cat = Catalogue::from_lenses(vec![d]);
        let s = Scorer::new(&cat);
        let at = |aspect: f64, vectors: Vectors| s.score(&ItemInput { id: "x".into(), media: Media::Picture, aspect, vectors });
        assert!(at(1.77, Vectors::One(v.clone())).iter().any(|(id, _)| id == "d0"));
        assert!(at(1.7, Vectors::One(v.clone())).iter().any(|(id, _)| id == "d0"), "inclusive");
        assert!(!at(1.0, Vectors::One(v.clone())).iter().any(|(id, _)| id == "d0"));
        assert!(!at(f64::NAN, Vectors::One(v.clone())).iter().any(|(id, _)| id == "d0"));
        let video = |aspect: f64| s.score(&ItemInput { id: "x".into(), media: Media::Video, aspect, vectors: Vectors::Frames(vec![v.clone(); 8]) });
        assert!(video(1.77).iter().any(|(id, _)| id == "d0"));
        assert!(video(0.56).is_empty());

        // The gate comes after the top 3: with a low bar, five concepts pass, the best is gated,
        // and two remain (the 4th and 5th don't move up).
        let base = unit(77);
        let mut d = lens("design", Role::Base, (0..5).map(|i| concept("design", &format!("d{i}"), Media::Any, None,
            mix(&base, &unit(700 + i), 0.02 + 0.01 * i as f32))).chain((0..5).map(|i|
            concept("design", &format!("x{i}"), Media::Any, None, unit(800 + i)))).collect());
        d.bar_picture = 0.05;
        d.concepts[0].aspect = Some((3.0, 4.0));
        let cat = Catalogue::from_lenses(vec![d]);
        let out = Scorer::new(&cat).score(&ItemInput { id: "x".into(), media: Media::Picture, aspect: 1.0, vectors: Vectors::One(base) });
        let ids: Vec<&str> = out.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["d1", "d2"], "{out:?}");
    }

    #[test]
    fn video_majority_rule() {
        // A near twin of d0 keeps d0's share of each frame moderate (about 0.6).
        let mut d = three_lenses().0;
        let twin = mix(&d.concepts[0].vec, &unit(9999), 0.02);
        d.concepts.push(concept("design", "d_twin", Media::Any, None, twin));
        let a = d.concepts[0].vec.clone();
        let b = d.concepts[1].vec.clone();
        let other = |k: u64| unit(60_000 + k);
        let vid = |frames: Vec<Vec<f32>>| ItemInput { id: "v".into(), media: Media::Video, aspect: 1.0, vectors: Vectors::Frames(frames) };
        let ids = |out: Vec<(String, f64)>| -> Vec<String> { out.into_iter().map(|(id, _)| id).collect() };

        let cat = Catalogue::from_lenses(vec![d.clone()]);
        let s = Scorer::new(&cat);
        // 4 of 8 frames is enough (ceil(8 · 0.45) = 4)…
        let four: Vec<Vec<f32>> = (0..8).map(|i| if i < 4 { a.clone() } else { other(i) }).collect();
        assert!(ids(s.score(&vid(four))).contains(&"d0".to_string()));
        // …3 of 8 isn't, even when the rest is split.
        let three: Vec<Vec<f32>> = (0..8).map(|i| if i < 3 { a.clone() } else { other(i) }).collect();
        assert!(!ids(s.score(&vid(three))).contains(&"d0".to_string()));
        // 3 frames d0 and 5 frames d1: only d1.
        let split: Vec<Vec<f32>> = (0..8).map(|i| if i < 3 { a.clone() } else { b.clone() }).collect();
        assert_eq!(ids(s.score(&vid(split))), vec!["d1".to_string()]);
        // The score is the mean p over the frames won.
        let out = s.score(&vid(vec![a.clone(); 8]));
        let p_one = s.score(&ItemInput { id: "p".into(), media: Media::Picture, aspect: 1.0, vectors: Vectors::One(a.clone()) });
        let mean = out.iter().find(|(id, _)| id == "d0").unwrap().1;
        assert!((mean - p_one.iter().find(|(id, _)| id == "d0").unwrap().1).abs() < 1e-9);
        assert!(mean > 0.4 && mean < 0.9, "{mean}");

        // A mean p under bar.video isn't suggested, however many frames it won.
        let mut strict = d.clone();
        strict.bar_video = 0.95;
        let cat = Catalogue::from_lenses(vec![strict]);
        let s = Scorer::new(&cat);
        assert!(!ids(s.score(&vid(vec![a.clone(); 8]))).contains(&"d0".to_string()));
        // n = 1 uses the picture rule (bar.picture 0.30), so the same frame is suggested.
        assert!(ids(s.score(&vid(vec![a.clone()]))).contains(&"d0".to_string()));
        // At most 2 per pool: two frames, two winners (ceil(2 · 0.45) = 1).
        let mut loose = d.clone();
        loose.bar_video = 0.05;
        let cat = Catalogue::from_lenses(vec![loose]);
        let out = ids(Scorer::new(&cat).score(&vid(vec![a.clone(), b.clone()])));
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn video_share_rule_is_45_percent() {
        // Owner decision 2026-11-20 (R45): a concept must top ceil(0.45 · n) of the n frames (half
        // before). At 8 frames that is 4, as before.
        for (n, need) in [(1, 1), (2, 1), (3, 2), (4, 2), (8, 4), (9, 5), (10, 5), (15, 7), (20, 9), (21, 10), (31, 14), (32, 15)] {
            assert_eq!(frames_needed(n), need, "n = {n}");
        }
        assert_eq!(frames_needed(8), (8 + 1) / 2);
        // The measuring run's formula (vidadapt sim.mjs: Math.ceil(n · 0.45 − 1e-9)) gives the same.
        for n in 1..=200usize { assert_eq!(frames_needed(n), (0.45 * n as f64 - 1e-9).ceil() as usize, "n = {n}"); }
        let d = three_lenses().0;
        let (a, b) = (d.concepts[0].vec.clone(), d.concepts[1].vec.clone());
        let cat = Catalogue::from_lenses(vec![d]);
        let s = Scorer::new(&cat);
        // k frames of d0 and the rest d1: d0 is suggested from frames_needed(n) on, not one frame earlier
        let has_d0 = |n: usize, k: usize| -> bool {
            let frames: Vec<Vec<f32>> = (0..n).map(|i| if i < k { a.clone() } else { b.clone() }).collect();
            s.score(&ItemInput { id: "v".into(), media: Media::Video, aspect: 1.0, vectors: Vectors::Frames(frames) })
                .iter().any(|(id, _)| id == "d0")
        };
        for (n, need) in [(8, 4), (15, 7), (20, 9), (21, 10), (32, 15)] {
            assert!(has_d0(n, need), "{need} of {n}");
            assert!(!has_d0(n, need - 1), "{} of {n}", need - 1);
        }
        // Where the share changed things: 9 of 20 frames (45 %) is enough now, 10 was needed before.
        assert!(has_d0(20, 9) && (20 + 1) / 2 == 10);
    }

    // ── Database-level ──

    /// Videos get a known length of 10 s (set_duration / clear_duration change it).
    fn add_item(conn: &Connection, id: &str, kind: &str, aspect: f64, created: i64) {
        conn.execute("INSERT INTO inspirations (id, type, stored_path, aspect_ratio, duration_secs, created_at, updated_at)
                      VALUES (?1, ?2, 'x', ?3, CASE WHEN ?2 = 'video' THEN 10.0 END, ?4, ?4)",
            params![id, kind, aspect, created]).unwrap();
    }
    fn clear_duration(conn: &Connection, id: &str) {
        conn.execute("UPDATE inspirations SET duration_secs = NULL WHERE id = ?1", params![id]).unwrap();
    }
    fn add_vec(conn: &Connection, id: &str, v: &[f32]) {
        let blob: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        conn.execute("INSERT OR REPLACE INTO clip_embeddings (id, model, emb) VALUES (?1, 'clip-b32-q8', ?2)", params![id, blob]).unwrap();
    }
    /// Frame vectors as the indexer stores them now (one per second: clip::FRAMES_TAG).
    fn add_frames(conn: &Connection, id: &str, frames: &[Vec<f32>]) {
        add_frames_as(conn, id, frames, crate::clip::FRAMES_TAG);
    }
    fn add_frames_as(conn: &Connection, id: &str, frames: &[Vec<f32>], model: &str) {
        let blob: Vec<u8> = frames.iter().flat_map(|v| lenses::encode_f16(v)).collect();
        conn.execute("INSERT OR REPLACE INTO clip_frames (id, model, n, emb) VALUES (?1, ?2, ?3, ?4)",
            params![id, model, frames.len() as i64, blob]).unwrap();
    }
    fn conf(conn: &Connection, id: &str) -> serde_json::Map<String, serde_json::Value> {
        let s: Option<String> = conn.query_row("SELECT lens_suggestions FROM inspirations WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        s.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    fn setup() -> (Connection, Catalogue) {
        let conn = test_db();
        install_texts(&conn, &standard_texts(1)).unwrap();
        let cat = Catalogue::load(&conn);
        (conn, cat)
    }
    fn concept_vec(cat: &Catalogue, id: &str) -> Vec<f32> {
        cat.lenses.iter().flat_map(|l| l.concepts.iter()).find(|c| c.id == id).unwrap().vec.clone()
    }

    #[test]
    fn scores_from_stored_vectors_and_falls_back_for_videos() {
        let (conn, cat) = setup();
        let d_one = concept_vec(&cat, "d_one");
        add_item(&conn, "pic", "image", 1.0, 1);
        add_vec(&conn, "pic", &d_one);
        add_item(&conn, "vid8", "video", 1.0, 2);
        add_frames(&conn, "vid8", &vec![d_one.clone(); 8]);
        add_item(&conn, "vid1", "video", 1.0, 3);
        add_frames(&conn, "vid1", &[d_one.clone()]);
        add_item(&conn, "vid0_cover", "video", 1.0, 4);        // frames failed, cover exists: its known length allows the cover
        add_frames(&conn, "vid0_cover", &[]);
        add_vec(&conn, "vid0_cover", &d_one);
        add_item(&conn, "vid0_bare", "video", 1.0, 5);         // frames failed, no cover: never scored
        add_frames(&conn, "vid0_bare", &[]);
        add_item(&conn, "vid_wait", "video", 1.0, 6);          // frames not read yet: wait, even with a cover
        add_vec(&conn, "vid_wait", &d_one);
        add_item(&conn, "pic_wait", "image", 1.0, 7);          // no vector yet
        add_item(&conn, "vid0_nolen", "video", 1.0, 8);        // no length even after measuring (n = 0): never,
        clear_duration(&conn, "vid0_nolen");                    // not even from its cover (§0b.1)
        add_frames(&conn, "vid0_nolen", &[]);
        add_vec(&conn, "vid0_nolen", &d_one);

        let sig = signature(&cat);
        let stale = stale_ids(&conn, &sig).unwrap();
        assert_eq!(stale, vec!["vid0_cover", "vid1", "vid8", "pic"]);
        let written = score_chunk(&conn, &cat, &stale).unwrap();
        assert_eq!(written.len(), 4);
        for id in ["pic", "vid8", "vid1", "vid0_cover"] {
            assert!(conf(&conn, id).contains_key("d_one"), "{id}");
            let (status, model, s): (String, String, String) = conn.query_row(
                "SELECT auto_tag_status, auto_tag_model, auto_tag_sig FROM inspirations WHERE id = ?1", [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            assert_eq!((status.as_str(), model.as_str(), s.as_str()), ("done", "lens-1", sig.as_str()));
        }
        assert!(stale_ids(&conn, &sig).unwrap().is_empty(), "nothing stale after scoring");
        let never: Vec<String> = ["vid0_bare", "vid_wait", "pic_wait", "vid0_nolen"].iter().map(|s| s.to_string()).collect();
        assert!(score_chunk(&conn, &cat, &never).unwrap().is_empty());
        assert!(conf(&conn, "vid0_nolen").is_empty(), "no cover fallback without a length");
        // A new lens version changes the signature: everything is stale again.
        let mut v2 = standard_texts(2);
        v2.truncate(1);
        install_texts(&conn, &v2).unwrap();
        let cat2 = Catalogue::load(&conn);
        assert_ne!(signature(&cat2), sig);
        assert_eq!(stale_ids(&conn, &signature(&cat2)).unwrap().len(), 4);
    }

    #[test]
    fn answers_never_change_status_model_or_sig() {
        let (conn, _) = setup();
        add_item(&conn, "a", "image", 1.0, 1);
        add_item(&conn, "b", "image", 1.0, 2);
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('t1', 'moodboard', 'user', 0)", []).unwrap();
        conn.execute(r#"UPDATE inspirations SET auto_tag_status = 'done', auto_tag_model = 'lens-1', auto_tag_sig = 'abc',
                        lens_suggestions = '{"d_one":0.5,"m_one":0.4,"col:t1":0.8}' WHERE id = 'a'"#, []).unwrap();
        let state = |id: &str| -> (String, String, String) { conn.query_row(
            "SELECT auto_tag_status, auto_tag_model, auto_tag_sig FROM inspirations WHERE id = ?1", [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap() };
        let before = state("a");

        let tag = answer_with(&conn, "a", "d_one", "added").unwrap().unwrap();
        assert_eq!((tag.name.as_str(), tag.source.as_str(), tag.concept_id.as_deref()), ("L d one", "lens", Some("d_one")),
            "stored under its English label: older versions show tags.name as it is");
        assert_eq!(tag.labels.as_ref().map(|l| l.en.as_str()), Some("L d one"));
        assert_eq!(tag.usage_count, 1);
        assert_eq!(answer_with(&conn, "a", "m_one", "dismissed").unwrap(), None);
        let linked = answer_with(&conn, "a", "col:t1", "added").unwrap().unwrap();
        assert_eq!((linked.id.as_str(), linked.name.as_str()), ("t1", "moodboard"));
        assert_eq!(state("a"), before, "status, model and sig untouched");
        assert!(conf(&conn, "a").is_empty(), "answered keys removed");
        let answers: Vec<(String, String, Option<String>)> = conn.prepare(
            "SELECT concept_id, answer, lens_id FROM tag_answers WHERE inspiration_id = 'a' ORDER BY concept_id").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(answers, vec![
            ("col:t1".into(), "added".into(), None),
            ("d_one".into(), "added".into(), Some("design".into())),
            ("m_one".into(), "dismissed".into(), Some("motion".into())),
        ]);
        // Answering again doesn't double-count; the concept keeps one tag across items.
        answer_with(&conn, "a", "d_one", "added").unwrap();
        let again = answer_with(&conn, "b", "d_one", "added").unwrap().unwrap();
        assert_eq!(again.id, tag.id);
        assert_eq!(again.usage_count, 2);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM tags WHERE concept_id = 'd_one'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // Status of an item without suggestions isn't created either.
        let (s, m): (Option<String>, Option<String>) = conn.query_row(
            "SELECT auto_tag_status, auto_tag_model FROM inspirations WHERE id = 'b'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((s, m), (None, None));
        // Bad input.
        assert!(answer_with(&conn, "a", "d_one", "maybe").is_err());
        assert!(answer_with(&conn, "a", "nope_concept", "added").is_err());
        assert!(answer_with(&conn, "a", "Bad Key", "added").is_err());
        assert!(answer_with(&conn, "a", "col:\"x", "dismissed").is_err());
        assert!(answer_with(&conn, "missing", "d_one", "added").is_err());
        assert!(answer_with(&conn, "a", "col:gone", "dismissed").unwrap().is_none(), "dismissing a stale hint is fine");
    }

    #[test]
    fn lens_tags_are_stored_under_their_label() {
        // DS-1 / UI-1: older versions show a lens tag's stored name as it is. It is the concept's
        // English label; "<label> (Tag lens)" while another tag has that name (by the same-name
        // key) and isn't the one people's tag with it (that one is the lens tag: one name, one
        // tag); at the next start it follows a changed label, gets the plain label back once it is
        // free, and two lens tags can trade names. Ids, links and counts never change.
        let (conn, _) = setup();
        add_item(&conn, "a", "image", 1.0, 1);
        let stored = |id: &str| -> String { conn.query_row("SELECT name FROM tags WHERE id = ?1", [id], |r| r.get(0)).unwrap() };
        // A tag an older version made (not a people's tag) has m_one's label as its name
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('u1', 'L m one', 'extension', 0)", []).unwrap();
        let d_one = ensure_concept_tag(&conn, "d_one").unwrap();
        let m_one = ensure_concept_tag(&conn, "m_one").unwrap();
        assert_eq!((stored(&d_one), stored(&m_one)), ("L d one".to_string(), "L m one (Tag lens)".to_string()));
        assert_eq!(ensure_concept_tag(&conn, "d_one").unwrap(), d_one, "found by concept_id");
        link_tag(&conn, "a", &d_one).unwrap();
        // The dev build's name, and two people's tags with d_one's name in other cases (made by an
        // older version): two people's tags with one name stay apart from the lens tag
        let t_one = dev_build_lens_tag(&conn, "t_one");
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('u2', ' l D ONE ', 'import', 0), ('u3', 'L D one', 'user', 0)", []).unwrap();
        assert_eq!(join_same_name_tags(&conn).unwrap(), Joined { two_named: 1, ..Joined::default() });
        assert_eq!(name_lens_tags(&conn).unwrap(), 2);
        assert_eq!((stored(&d_one), stored(&m_one), stored(&t_one)),
                   ("L d one (Tag lens)".to_string(), "L m one (Tag lens)".to_string(), "L t one".to_string()));
        assert_eq!(name_lens_tags(&conn).unwrap(), 0, "settled: the next start writes nothing");
        // The tag "L m one" goes: m_one's tag gets the plain label back
        conn.execute("DELETE FROM tags WHERE id = 'u1'", []).unwrap();
        assert_eq!(name_lens_tags(&conn).unwrap(), 1);
        assert_eq!(stored(&m_one), "L m one");
        // A new lens version changes labels; two tags trade names in one run (tags.name is UNIQUE)
        let d_two = ensure_concept_tag(&conn, "d_two").unwrap();
        conn.execute_batch(r#"
            UPDATE concepts SET labels_json = '{"en":"L d two","uz":"U d two"}' WHERE id = 'd_one';
            UPDATE concepts SET labels_json = '{"en":"L m one","uz":"U m one"}' WHERE id = 'd_two';
            UPDATE concepts SET labels_json = '{"en":"New_label","uz":"Yangi"}' WHERE id = 'm_one';"#).unwrap();
        assert_eq!(name_lens_tags(&conn).unwrap(), 3);
        let names = [&d_one, &d_two, &m_one].map(|id| stored(id));
        assert_eq!(names, ["L d two".to_string(), "L m one".to_string(), "New label".to_string()], "no underscore even from a label");
        // Every tag is the same tag: ids, concepts, links and counts
        assert_eq!(rows(&conn, "SELECT concept_id FROM tags WHERE concept_id IS NOT NULL ORDER BY concept_id"), vec!["d_one", "d_two", "m_one", "t_one"]);
        assert_eq!(rows(&conn, "SELECT tag_id FROM inspiration_tags"), vec![d_one.clone()]);
        assert_eq!(load_tag(&conn, &d_one).unwrap().unwrap().usage_count, 1);
        conn.execute(r#"UPDATE concepts SET labels_json = '{"en":"New label","uz":"Yangi"}' WHERE id = 'm_one'"#, []).unwrap();
        assert_eq!(name_lens_tags(&conn).unwrap(), 0, "the same name");
        // Tags an earlier build stored as 'lens:<id>' without concept_id: one becomes its concept's
        // tag, another joins the tag its concept already has.
        conn.execute_batch("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('lens_v1_migrated', '1');
            INSERT INTO tags (id, name, source, created_at) VALUES ('old_t_two', 'lens:t_two', 'lens', 0), ('old_d_one', 'Lens:D_one', 'model', 0);
            INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('a', 'old_t_two');").unwrap();
        add_item(&conn, "b", "image", 1.0, 2);
        link_tag(&conn, "b", "old_d_one").unwrap();
        let older = adopt_older_build_tags(&conn).unwrap();
        assert_eq!(older, OlderTags { merged: 2, renamed: 0, links: 1, lens_names: 1, joined: 0 }, "{older:?}");
        assert_eq!(rows(&conn, "SELECT name || '|' || source || '|' || concept_id FROM tags WHERE id = 'old_t_two'"), vec!["L t two|lens|t_two"]);
        assert_eq!(rows(&conn, "SELECT COUNT(*) FROM tags WHERE id = 'old_d_one'"), vec!["Integer(0)"]);
        assert_eq!(rows(&conn, "SELECT tag_id FROM inspiration_tags WHERE inspiration_id = 'b'"), vec![d_one.clone()]);
        assert_eq!(ids_on_screen(&conn), Vec::<String>::new());
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default());
    }

    #[test]
    fn one_name_one_tag_joins_at_start() {
        // The owner's case (2026-11-20): their own tag "ui" and the lens tag of the concept labelled
        // "UI", stored "UI (Tag lens)" while both existed, showed as two "UI" chips. Here: the people's
        // tag "l d one" and the lens tag of d_one ("L d one"). At the next start they are one tag:
        // the people's tag, which keeps its id, name and source, gets the concept, the lens tag's
        // items (b only once), its count and its collection-hint answers; the lens tag goes. A
        // second start writes nothing.
        let (conn, _) = setup();
        for (k, id) in ["a", "b", "c", "d", "e"].iter().enumerate() { add_item(&conn, id, "image", 1.0, k as i64); }
        conn.execute_batch(r#"
            INSERT INTO tags (id, name, source, created_at) VALUES ('mine', 'l d one', 'user', 5), ('other', 'moodboard', 'user', 6);
            INSERT INTO tags (id, name, source, created_at, concept_id) VALUES ('lt', 'L d one (Tag lens)', 'lens', 7, 'd_one');
            INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('a', 'mine'), ('b', 'mine'), ('b', 'lt'), ('c', 'lt'), ('a', 'other');
            INSERT INTO tag_answers (inspiration_id, concept_id, answer, lens_id, answered_at) VALUES
                ('d', 'col:lt', 'dismissed', NULL, 1), ('a', 'col:lt', 'added', NULL, 2), ('a', 'col:mine', 'dismissed', NULL, 3),
                ('c', 'd_one', 'added', 'design', 4);
            UPDATE inspirations SET lens_suggestions = '{"col:lt":0.6,"m_one":0.4}' WHERE id = 'd';
            UPDATE inspirations SET lens_suggestions = '{"d_one":0.5,"t_one":0.3}' WHERE id = 'a';
            UPDATE inspirations SET lens_suggestions = '{"col:mine":0.7,"d_one":0.4}' WHERE id = 'e';"#).unwrap();
        conn.execute_batch(crate::db::RECOUNT_ALL_TAGS).unwrap();
        let m_one = ensure_concept_tag(&conn, "m_one").unwrap();   // a lens tag no people's tag is named like
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        let keys = |id: &str| -> Vec<String> { let mut k: Vec<String> = conf(&conn, id).keys().cloned().collect(); k.sort(); k };

        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags { joined: 1, ..OlderTags::default() });
        let one = load_tag(&conn, "mine").unwrap().unwrap();
        assert_eq!((one.name.as_str(), one.source.as_str(), one.concept_id.as_deref(), one.usage_count), ("l d one", "user", Some("d_one"), 3));
        assert_eq!(one.labels.map(|l| (l.en, l.uz)), Some(("L d one".to_string(), "U d one".to_string())), "it carries the concept's labels (search finds it by them; the page shows its own name)");
        assert_eq!(rows(&conn, "SELECT inspiration_id FROM inspiration_tags WHERE tag_id = 'mine' ORDER BY 1"), vec!["a", "b", "c"]);
        for sql in ["SELECT COUNT(*) FROM tags WHERE id = 'lt'", "SELECT COUNT(*) FROM inspiration_tags WHERE tag_id = 'lt'",
                    "SELECT COUNT(*) FROM tag_usage_counts WHERE tag_id = 'lt'", "SELECT COUNT(*) FROM tag_answers WHERE concept_id = 'col:lt'"] {
            assert_eq!(count(sql), 0, "{sql}");
        }
        // The answers to its hints moved (a's own answer to the people's tag's hint stays); the
        // concept's own answers are keyed by the concept and stay
        assert_eq!(rows(&conn, "SELECT inspiration_id, concept_id, answer FROM tag_answers ORDER BY 1, 2"),
                   vec!["a|col:mine|dismissed", "c|d_one|added", "d|col:mine|dismissed"]);
        // Its hint and the people's tag's hint left the maps (a tag with a concept is asked about by
        // the lenses); a doesn't ask about the tag it has; e still may (it doesn't have it)
        assert_eq!(keys("d"), vec!["m_one"]);
        assert_eq!(keys("a"), vec!["t_one"]);
        assert_eq!(keys("e"), vec!["d_one"]);
        // Everything else as it was: the other people's tag, the other lens tag, their names
        assert_eq!(rows(&conn, "SELECT id || '|' || name || '|' || source || '|' || COALESCE(concept_id, '') FROM tags ORDER BY id"),
                   vec![format!("{m_one}|L m one|lens|m_one"), "mine|l d one|user|d_one".to_string(), "other|moodboard|user|".to_string()]);
        assert_eq!(rows(&conn, "SELECT inspiration_id FROM inspiration_tags WHERE tag_id = 'other'"), vec!["a"]);
        // The next start finds nothing to do
        let n = changes(&conn);
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default());
        assert_eq!(join_same_name_tags(&conn).unwrap(), Joined::default());
        assert_eq!(changes(&conn), n);
        // Add finds it by its concept
        assert_eq!(ensure_concept_tag(&conn, "d_one").unwrap(), "mine");
        let added = answer_with(&conn, "e", "d_one", "added").unwrap().unwrap();
        assert_eq!((added.id.as_str(), added.usage_count), ("mine", 4));
        assert!(keys("e").is_empty());
    }

    #[test]
    fn adding_a_suggestion_links_the_peoples_tag_with_its_name() {
        // The owner's own "ui" and a lens tag labelled "UI" that no item has yet: Add, the picker's
        // add (add_concept_tag) and tag_item link the people's tag, which then stands for the
        // concept. No lens tag of its own is made, and the start has nothing to join.
        let conn = test_db();
        let mut d = lens_value("design", "base", 1, &[tc("d_ui", unit(1)), tc("d_two", unit(2))], &[]);
        d["concepts"][0]["label"] = serde_json::json!({ "en": "UI", "uz": "UI" });
        install_texts(&conn, &[d.to_string()]).unwrap();
        for (k, id) in ["a", "b", "c"].iter().enumerate() { add_item(&conn, id, "image", 1.0, k as i64); }
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('ui', 'ui', 'user', 0)", []).unwrap();
        link_tag(&conn, "a", "ui").unwrap();
        conn.execute_batch(r#"
            UPDATE inspirations SET lens_suggestions = '{"d_ui":0.6,"d_two":0.4}' WHERE id = 'b';
            UPDATE inspirations SET lens_suggestions = '{"col:ui":0.7,"d_ui":0.5}' WHERE id = 'c';"#).unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };

        let tag = answer_with(&conn, "b", "d_ui", "added").unwrap().unwrap();
        assert_eq!((tag.id.as_str(), tag.name.as_str(), tag.source.as_str(), tag.concept_id.as_deref(), tag.usage_count),
                   ("ui", "ui", "user", Some("d_ui"), 2));
        assert_eq!(tag.labels.map(|l| l.en), Some("UI".to_string()));
        assert_eq!(count("SELECT COUNT(*) FROM tags"), 1, "no lens tag of its own");
        assert_eq!(conf(&conn, "b").keys().cloned().collect::<Vec<_>>(), vec!["d_two"]);
        assert_eq!(conf(&conn, "c").keys().cloned().collect::<Vec<_>>(), vec!["d_ui"], "its collection hint went: the lens asks about it");
        // The picker's add and tag_item find it by its concept
        assert_eq!(ensure_concept_tag(&conn, "d_ui").unwrap(), "ui");
        crate::commands::tag_item(&conn, "c", "ui").unwrap();
        assert_eq!(load_tag(&conn, "ui").unwrap().unwrap().usage_count, 3);
        assert!(conf(&conn, "c").is_empty());
        assert_eq!(rows(&conn, "SELECT inspiration_id, concept_id, answer FROM tag_answers ORDER BY 1"), vec!["b|d_ui|added", "c|d_ui|added"]);
        // The start has nothing to join or rename: the people's tag keeps its name
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default());
        assert_eq!(rows(&conn, "SELECT name || '|' || source || '|' || concept_id FROM tags"), vec!["ui|user|d_ui"]);
    }

    #[test]
    fn tags_with_one_name_stay_apart_when_they_cant_be_one() {
        // Two people's tags with the lens tag's name, or the one with it already standing for another
        // concept: no join; the lens tag is "<label> (Tag lens)"; only counts are logged; the people's
        // tags stay exactly as they are, and nothing is written at the next start.
        let (conn, _) = setup();
        conn.execute_batch("
            INSERT INTO tags (id, name, source, created_at) VALUES ('u1', 'L d one', 'user', 0), ('u2', ' l d ONE', 'import', 1);
            INSERT INTO tags (id, name, source, created_at, concept_id) VALUES ('u3', 'L d two', 'user', 2, 'd_three');").unwrap();
        let stored = |id: &str| -> String { conn.query_row("SELECT name FROM tags WHERE id = ?1", [id], |r| r.get(0)).unwrap() };
        let d_one = ensure_concept_tag(&conn, "d_one").unwrap();
        let d_two = ensure_concept_tag(&conn, "d_two").unwrap();
        assert!(!["u1", "u2", "u3"].contains(&d_one.as_str()) && !["u1", "u2", "u3"].contains(&d_two.as_str()), "lens tags of their own");
        assert_eq!((stored(&d_one), stored(&d_two)), ("L d one (Tag lens)".to_string(), "L d two (Tag lens)".to_string()));
        assert_eq!(join_same_name_tags(&conn).unwrap(), Joined { two_named: 1, other_concept: 1, ..Joined::default() });
        let n = changes(&conn);
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default());
        assert_eq!(changes(&conn), n, "nothing written");
        assert_eq!(rows(&conn, "SELECT id || '|' || name || '|' || COALESCE(concept_id, '') FROM tags WHERE source IN ('user', 'import') ORDER BY id"),
                   vec!["u1|L d one|", "u2| l d ONE|", "u3|L d two|d_three"]);
        // Of two lens tags with one label (a retired concept kept its label), the live concept's
        // joins the people's tag; the other one stays apart
        conn.execute(r#"INSERT INTO concepts (id, lens_id, labels_json, media, vec, active, updated_at)
                        VALUES ('d_old', 'design', '{"en":"L t one","uz":"U d old"}', 'any', x'', 0, 0)"#, []).unwrap();
        let old = ensure_concept_tag(&conn, "d_old").unwrap();
        let t_one = ensure_concept_tag(&conn, "t_one").unwrap();
        assert_eq!((stored(&old), stored(&t_one)), ("L t one".to_string(), "L t one (Tag lens)".to_string()));
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('u4', 'l t one', 'user', 9)", []).unwrap();
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags { joined: 1, lens_names: 1, ..OlderTags::default() });
        assert_eq!(rows(&conn, "SELECT concept_id FROM tags WHERE id = 'u4'"), vec!["t_one"]);
        assert_eq!(rows(&conn, &format!("SELECT COUNT(*) FROM tags WHERE id = '{t_one}'")), vec!["Integer(0)"]);
        assert_eq!(stored(&old), "L t one (Tag lens)", "the retired concept's tag stays apart");
        assert_eq!(join_same_name_tags(&conn).unwrap(), Joined { two_named: 1, other_concept: 2, ..Joined::default() });
    }

    #[test]
    fn older_tags_join_a_peoples_tag_that_stands_for_a_relabelled_concept() {
        // DS-ON-3: the people's tags "L d one" and "l t one" became d_one's and t_one's tags (Add,
        // path 2); a new lens version relabelled both concepts. An older version left 'L_d_one' and
        // 'l_t_one', whose readable names are those people's names: they join the people's tags
        // (one name, one tag), which keep their ids, names, sources and concepts. Before, the
        // adoption looked only at tags without a concept, renamed them to the taken name and failed
        // on UNIQUE(tags.name) at every start ('l t one' against 'L t one' left two tags with one
        // name instead).
        let (conn, _) = setup();
        for (k, id) in ["a", "b", "c"].iter().enumerate() { add_item(&conn, id, "image", 1.0, k as i64); }
        conn.execute_batch(r#"
            INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('lens_v1_migrated', '1');
            INSERT INTO tags (id, name, source, created_at) VALUES ('mine', 'L d one', 'user', 5), ('mine2', 'l t one', 'user', 6);
            INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('a', 'mine'), ('a', 'mine2');"#).unwrap();
        assert_eq!(answer_with(&conn, "b", "d_one", "added").unwrap().unwrap().id, "mine");
        assert_eq!(answer_with(&conn, "b", "t_one", "added").unwrap().unwrap().id, "mine2");
        conn.execute_batch(r#"
            UPDATE concepts SET labels_json = '{"en":"Something else","uz":"Boshqa"}' WHERE id = 'd_one';
            UPDATE concepts SET labels_json = '{"en":"Other thing","uz":"Boshqa narsa"}' WHERE id = 't_one';
            INSERT INTO tags (id, name, source, created_at) VALUES ('old1', 'L_d_one', 'model', 9), ('old2', 'l_t_one', 'model', 10);
            INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('c', 'old1'), ('c', 'old2'), ('a', 'old1');"#).unwrap();
        conn.execute_batch(crate::db::RECOUNT_ALL_TAGS).unwrap();
        // c didn't have the two tags yet, so its card may ask about their concepts
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"d_one":0.6,"t_one":0.5,"d_two":0.3}' WHERE id = 'c'"#, []).unwrap();

        let older = adopt_older_build_tags(&conn).unwrap();
        assert_eq!((older.merged, older.renamed, older.links), (2, 0, 2), "{older:?}");
        assert_eq!(rows(&conn, "SELECT id || '|' || name || '|' || source || '|' || COALESCE(concept_id, '') FROM tags ORDER BY id"),
                   vec!["mine|L d one|user|d_one", "mine2|l t one|user|t_one"]);
        assert_eq!(rows(&conn, "SELECT tag_id || '|' || inspiration_id FROM inspiration_tags ORDER BY 1"),
                   vec!["mine2|a", "mine2|b", "mine2|c", "mine|a", "mine|b", "mine|c"], "c's links moved, a's only once");
        assert_eq!((load_tag(&conn, "mine").unwrap().unwrap().usage_count, load_tag(&conn, "mine2").unwrap().unwrap().usage_count), (3, 3));
        assert_eq!(conf(&conn, "c").keys().cloned().collect::<Vec<_>>(), vec!["d_two"], "c has both tags now: their questions went");
        let n = changes(&conn);
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default(), "the next start finds nothing");
        assert_eq!(changes(&conn), n);
    }

    #[test]
    fn a_peoples_tag_becomes_a_concepts_tag_in_one_step() {
        // DS-ON-4: Add's path 2 (the one people's tag with the concept's name becomes its tag) is
        // two or three writes. Outside a transaction (a pack import) a failure between them, here
        // the clean-up of the tag's collection hints, used to leave the tag standing for the concept
        // with its hints in place for good. Now it is one unit: all or nothing, in or out of a
        // transaction; and a people's tag made from a lens tag (path 3) likewise.
        let (conn, _) = setup();
        for (k, id) in ["y", "z"].iter().enumerate() { add_item(&conn, id, "image", 1.0, k as i64); }
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('u', 'L d one', 'user', 0)", []).unwrap();
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"col:u":0.8,"d_two":0.3}' WHERE id = 'z'"#, []).unwrap();
        let state = |conn: &Connection| (rows(conn, "SELECT COALESCE(concept_id, '-') FROM tags WHERE id = 'u'"), conf(conn, "z"));
        let before = state(&conn);
        conn.execute_batch("CREATE TEMP TRIGGER boom BEFORE UPDATE OF lens_suggestions ON main.inspirations BEGIN SELECT RAISE(ABORT, 'disk I/O'); END;").unwrap();
        assert!(ensure_concept_tag(&conn, "d_one").is_err());
        assert_eq!(state(&conn), before, "nothing of it stays");
        assert!(conn.is_autocommit(), "no transaction left open");
        // Inside a caller's transaction: the caller's own writes stay theirs to keep or drop
        {
            let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
            tx.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('w', 'moodboard', 'user', 1)", []).unwrap();
            assert!(ensure_concept_tag(&tx, "d_one").is_err());
            assert_eq!(rows(&tx, "SELECT COUNT(*) FROM tags WHERE id = 'w'"), vec!["Integer(1)"], "the caller's write is still there");
            assert_eq!(state(&tx), before);
            tx.commit().unwrap();
        }
        conn.execute_batch("DROP TRIGGER temp.boom;").unwrap();
        assert_eq!(ensure_concept_tag(&conn, "d_one").unwrap(), "u");
        assert_eq!(state(&conn).0, vec!["d_one"]);
        assert!(!conf(&conn, "z").contains_key("col:u"), "its hint went with it");
        // Path 3: a lens tag stored under the name moves on, then the people's tag is made from the
        // lens tag whose label it is; a failure of the second write takes back the first
        let d_two = ensure_concept_tag(&conn, "d_two").unwrap();
        let t_one = ensure_concept_tag(&conn, "t_one").unwrap();
        conn.execute("UPDATE tags SET name = 'L t one (Tag lens)' WHERE id = ?1", [&t_one]).unwrap();
        conn.execute("UPDATE tags SET name = 'L t one' WHERE id = ?1", [&d_two]).unwrap();   // stored under t_one's label
        let names = |conn: &Connection| rows(conn, "SELECT id || '|' || name || '|' || source FROM tags ORDER BY id");
        let named = names(&conn);
        conn.execute_batch("CREATE TEMP TRIGGER boom2 BEFORE UPDATE OF source ON main.tags BEGIN SELECT RAISE(ABORT, 'disk I/O'); END;").unwrap();
        assert!(lens_tag_for_peoples_name(&conn, "l t one", "user").is_err());
        assert_eq!(names(&conn), named, "the lens tag that moved on is back under its name");
        assert!(conn.is_autocommit());
        conn.execute_batch("DROP TRIGGER temp.boom2;").unwrap();
        assert_eq!(lens_tag_for_peoples_name(&conn, "l t one", "user").unwrap().as_deref(), Some(t_one.as_str()));
        assert_eq!(rows(&conn, &format!("SELECT name || '|' || source || '|' || concept_id FROM tags WHERE id = '{t_one}'")), vec!["l t one|user|t_one"]);
        assert_eq!(rows(&conn, &format!("SELECT name FROM tags WHERE id = '{d_two}'")), vec!["L d two"]);
    }

    #[test]
    fn a_lens_update_while_the_app_runs_joins_and_names_tags() {
        // R3: a lens version installed while the app runs (install_lenses) changes labels. A lens
        // tag whose new label is a people's tag's name joins it at once, as at a start, and a lens
        // tag whose label changed gets its new stored name: the page never shows two tags with one
        // name until the next start. The next start then has nothing to do.
        let (conn, _) = setup();
        for (k, id) in ["a", "b", "c"].iter().enumerate() { add_item(&conn, id, "image", 1.0, k as i64); }
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('dm', 'dark-mode', 'user', 0)", []).unwrap();
        link_tag(&conn, "a", "dm").unwrap();
        let d_two = answer_with(&conn, "b", "d_two", "added").unwrap().unwrap().id;
        let d_three = answer_with(&conn, "c", "d_three", "added").unwrap().unwrap().id;
        // design v2: d_two is labelled like the people's tag, d_three gets a new label
        let mut d = lens_value("design", "base", 2, &[tc("d_one", unit(1)), tc("d_two", unit(2)), tc("d_three", unit(3))], &[]);
        d["concepts"][1]["label"] = serde_json::json!({ "en": "Dark-Mode", "uz": "Tungi rejim" });
        d["concepts"][2]["label"] = serde_json::json!({ "en": "Night photo", "uz": "Tungi surat" });
        let text = d.to_string();
        let pairs = vec![(lenses::parse_lens(&text, false).unwrap(), text.as_str())];
        let report = install_catalogue_with(&conn, &pairs).unwrap();
        assert_eq!(report.installed, vec!["design".to_string()]);
        assert_eq!(rows(&conn, "SELECT id || '|' || name || '|' || source || '|' || COALESCE(concept_id, '') FROM tags ORDER BY source, id"),
                   vec![format!("{d_three}|Night photo|lens|d_three"), "dm|dark-mode|user|d_two".to_string()]);
        assert_eq!(rows(&conn, "SELECT inspiration_id FROM inspiration_tags WHERE tag_id = 'dm' ORDER BY 1"), vec!["a", "b"]);
        assert_eq!(rows(&conn, &format!("SELECT COUNT(*) FROM tags WHERE id = '{d_two}'")), vec!["Integer(0)"]);
        assert_eq!(load_tag(&conn, "dm").unwrap().unwrap().usage_count, 2);
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default(), "the next start finds nothing");
        // Installing the same version again installs nothing
        assert!(install_catalogue_with(&conn, &pairs).unwrap().installed.is_empty());
    }

    #[test]
    fn adding_a_hint_whose_tag_is_gone_drops_the_question() {
        // Contract C4: the tag behind `col:gone` was deleted meanwhile. Add returns null (the page
        // removes the row), the key leaves the item, nothing is linked and no answer is kept.
        let (conn, _) = setup();
        add_item(&conn, "a", "image", 1.0, 1);
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"col:gone":0.8,"d_one":0.5}' WHERE id = 'a'"#, []).unwrap();
        assert_eq!(answer_with(&conn, "a", "col:gone", "added").unwrap(), None);
        let c = conf(&conn, "a");
        assert!(!c.contains_key("col:gone") && c.contains_key("d_one"), "{c:?}");
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM tag_answers"), 0, "no answer for a tag that doesn't exist");
        assert_eq!(count("SELECT COUNT(*) FROM inspiration_tags"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM tags WHERE id = 'gone'"), 0, "nothing made up");
        // Again (a second click): still fine, still nothing.
        assert_eq!(answer_with(&conn, "a", "col:gone", "added").unwrap(), None);
        assert_eq!(count("SELECT COUNT(*) FROM tag_answers"), 0);
    }

    #[test]
    fn answered_and_owned_concepts_are_never_written_back() {
        let (conn, cat) = setup();
        // Between d_one and t_one: the base pool suggests d_one, the thumbnail pool t_one.
        let v = mix(&concept_vec(&cat, "d_one"), &concept_vec(&cat, "t_one"), 0.5);
        add_item(&conn, "a", "image", 1.0, 1);
        add_vec(&conn, "a", &v);
        let ids = vec!["a".to_string()];
        score_chunk(&conn, &cat, &ids).unwrap();
        let c = conf(&conn, "a");
        assert!(c.contains_key("d_one") && c.contains_key("t_one"), "{c:?}");

        answer_with(&conn, "a", "d_one", "dismissed").unwrap();
        let t = ensure_concept_tag(&conn, "t_one").unwrap();
        link_tag(&conn, "a", &t).unwrap();   // the item has t_one through the picker, not an answer
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"d_one":0.9,"t_one":0.9}' WHERE id = 'a'"#, []).unwrap();
        conn.execute("UPDATE inspirations SET auto_tag_sig = NULL", []).unwrap();
        score_chunk(&conn, &cat, &ids).unwrap();
        let c = conf(&conn, "a");
        assert!(!c.contains_key("d_one") && !c.contains_key("t_one"), "{c:?}");
    }

    #[test]
    fn collection_hints_survive_a_rescore() {
        let (conn, cat) = setup();
        add_item(&conn, "a", "image", 1.0, 1);
        add_vec(&conn, "a", &concept_vec(&cat, "d_two"));
        for t in ["t1", "t2", "t3"] {
            conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES (?1, ?1, 'user', 0)", [t]).unwrap();
        }
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"col:t1":0.8,"col:t2":0.7,"col:t3":0.75,"old_concept":0.5}' WHERE id = 'a'"#, []).unwrap();
        // Answered while being scored (the key is still there), and owned.
        conn.execute("INSERT INTO tag_answers (inspiration_id, concept_id, answer, answered_at) VALUES ('a', 'col:t2', 'dismissed', 0)", []).unwrap();
        link_tag(&conn, "a", "t3").unwrap();
        score_chunk(&conn, &cat, &["a".to_string()]).unwrap();
        let c = conf(&conn, "a");
        assert_eq!(c.get("col:t1").and_then(|v| v.as_f64()), Some(0.8));
        assert!(!c.contains_key("col:t2") && !c.contains_key("col:t3") && !c.contains_key("old_concept"), "{c:?}");
        assert!(c.contains_key("d_two"), "{c:?}");
    }

    #[test]
    fn signature_covers_installed_lenses_only() {
        let (d, m, t) = three_lenses();
        let a = signature(&Catalogue::from_lenses(vec![d.clone(), m.clone(), t.clone()]));
        let b = signature(&Catalogue::from_lenses(vec![t.clone(), d.clone(), m.clone()]));
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        let expected = hex::encode(Sha256::digest(b"lens-score-4|clip-b32-q8|maxvid=60|design@sha-design,motion@sha-motion,thumbnail@sha-thumbnail"));
        assert_eq!(a, expected[..16]);
        // Version 4 since the video rule of 2026-11-20 (R45): every item is re-scored once.
        // lens-score.test.mjs pins the same value.
        assert_eq!(a, "9f0638fe4bb271b9");
        let v3 = hex::encode(Sha256::digest(b"lens-score-3|clip-b32-q8|maxvid=30|design@sha-design,motion@sha-motion,thumbnail@sha-thumbnail"));
        assert_eq!(&v3[..16], "360269d284e2710a", "version 3's (PORT-NOTES §7.5)");
        assert_ne!(a, v3[..16]);
        assert_ne!(a, signature(&Catalogue::from_lenses(vec![d, m])));
    }

    fn set_duration(conn: &Connection, id: &str, secs: f64) {
        conn.execute("UPDATE inspirations SET duration_secs = ?2 WHERE id = ?1", params![id, secs]).unwrap();
    }

    #[test]
    fn videos_over_60_seconds_are_left_out_entirely() {
        // 30 s until the owner's decision of 2026-11-20 (R45), with the same 0.5 s of slack.
        assert_eq!(MAX_TAG_VIDEO_SECS, 60);
        assert_eq!(max_tag_video_secs(), 60.5);
        assert!(!too_long_for_tags(None) && !too_long_for_tags(Some(30.51)) && !too_long_for_tags(Some(45.0)));
        assert!(!too_long_for_tags(Some(60.0)) && !too_long_for_tags(Some(60.5)));
        assert!(too_long_for_tags(Some(60.51)) && too_long_for_tags(Some(600.0)));
        let (conn, cat) = setup();
        let d_one = concept_vec(&cat, "d_one");
        add_item(&conn, "v30", "video", 1.0, 1);    set_duration(&conn, "v30", 60.4);   // "60 seconds": in
        add_frames(&conn, "v30", &vec![d_one.clone(); 32]);
        add_item(&conn, "vnull", "video", 1.0, 2);  clear_duration(&conn, "vnull");      // length unknown after the indexer
        add_frames(&conn, "vnull", &vec![d_one.clone(); 8]);                             // looked: out (§0b.1)
        add_item(&conn, "vlong", "video", 1.0, 3);  set_duration(&conn, "vlong", 61.0);  // frames from another build
        add_frames(&conn, "vlong", &vec![d_one.clone(); 32]);
        add_item(&conn, "vcover", "video", 1.0, 4); set_duration(&conn, "vcover", 95.0); // no cover fallback either
        add_frames(&conn, "vcover", &[]);
        add_vec(&conn, "vcover", &d_one);
        add_item(&conn, "vwait", "video", 1.0, 5);  set_duration(&conn, "vwait", 75.0);  // never waited for
        add_item(&conn, "vnew", "video", 1.0, 6);   set_duration(&conn, "vnew", 12.0);   // waiting for frames
        add_item(&conn, "vunk", "video", 1.0, 7);   clear_duration(&conn, "vunk");       // waiting: its length is found first
        add_item(&conn, "vzero", "video", 1.0, 8);  set_duration(&conn, "vzero", 0.0);   // 0 is "unknown" too: waiting

        let sig = signature(&cat);
        let stale = stale_ids(&conn, &sig).unwrap();
        assert_eq!(stale, vec!["v30"]);
        let all: Vec<String> = ["v30", "vnull", "vlong", "vcover", "vunk", "vzero"].iter().map(|s| s.to_string()).collect();
        let mut loaded: Vec<String> = load_inputs(&conn, &all).unwrap().into_iter().map(|i| i.id).collect();
        loaded.sort();
        assert_eq!(loaded, vec!["v30"]);
        let mut written = score_chunk(&conn, &cat, &all).unwrap();
        written.sort();
        assert_eq!(written, vec!["v30"]);
        assert!(conf(&conn, "vlong").is_empty() && conf(&conn, "vcover").is_empty() && conf(&conn, "vnull").is_empty());

        // Status: v30, vnew, vunk and vzero count; the last three are waiting for the indexer.
        let st = status_with(&conn, &cat, &VideosNotNow::default()).unwrap();
        assert_eq!((st.total, st.scored, st.waiting_videos), (4, 1, 3));

        // Suggestions a video that can't have any still holds (scores, collection hints) are
        // cleared: over the limit, or no length after the indexer looked. A waiting one keeps them.
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"d_one":0.5,"col:t1":0.8}', auto_tag_status = 'done',
                        auto_tag_model = 'lens-1', auto_tag_sig = 'x' WHERE id IN ('vlong', 'v30', 'vnull', 'vunk')"#, []).unwrap();
        assert_eq!(clear_untaggable_videos(&conn).unwrap(), vec!["vlong".to_string(), "vnull".to_string()]);
        for id in ["vlong", "vnull"] {
            let (c, s, m, g): (Option<String>, Option<String>, Option<String>, Option<String>) = conn.query_row(
                "SELECT lens_suggestions, auto_tag_status, auto_tag_model, auto_tag_sig FROM inspirations WHERE id = ?1", [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
            assert_eq!((c, s, m, g), (None, None, None, None), "{id}");
        }
        assert!(conf(&conn, "v30").contains_key("col:t1"), "short videos keep theirs");
        assert!(conf(&conn, "vunk").contains_key("col:t1"), "a waiting video keeps its until the indexer looked");
        assert!(clear_untaggable_videos(&conn).unwrap().is_empty(), "nothing left the second time");
        let per_lens = status_with(&conn, &cat, &VideosNotNow::default()).unwrap().per_lens;
        assert_eq!(per_lens.get("design"), Some(&1), "only videos of a known length within the limit count");
    }

    #[test]
    fn frames_read_with_8_frames_stay_scored_until_read_again() {
        // R45 (2026-11-20): rows written before carry the model tag alone (8 frames, whatever the
        // length). They are scored in place, with the new rule, until the indexer has read the
        // video again one frame per second (clip.rs old_schedule_with); the status never counts
        // them as waiting. A row of an unknown kind is "not read yet".
        let (conn, cat) = setup();
        let d_one = concept_vec(&cat, "d_one");
        let d_two = concept_vec(&cat, "d_two");
        add_item(&conn, "old20", "video", 1.0, 1); set_duration(&conn, "old20", 20.4);
        add_frames_as(&conn, "old20", &vec![d_one.clone(); 8], crate::clip::FRAMES_TAG_8);
        // 21 frames, d_one tops 10 (ceil(0.45 · 21) = 10): suggested; 9 of 21: not (d_two tops the rest)
        let mix = |k: usize| -> Vec<Vec<f32>> { (0..21).map(|i| if i < k { d_one.clone() } else { d_two.clone() }).collect() };
        add_item(&conn, "new10", "video", 1.0, 2); set_duration(&conn, "new10", 20.4); add_frames(&conn, "new10", &mix(10));
        add_item(&conn, "new9", "video", 1.0, 3);  set_duration(&conn, "new9", 20.4);  add_frames(&conn, "new9", &mix(9));
        add_item(&conn, "odd", "video", 1.0, 4);   add_frames_as(&conn, "odd", &vec![d_one.clone(); 8], "clip-b99");
        add_item(&conn, "m45", "video", 1.0, 5);   set_duration(&conn, "m45", 45.0);   // 30–60 s, not read yet: waiting
        let stale = stale_ids(&conn, &signature(&cat)).unwrap();
        assert_eq!(stale, vec!["new9", "new10", "old20"]);
        let inputs = load_inputs(&conn, &stale).unwrap();
        let n_of = |id: &str| match &inputs.iter().find(|i| i.id == id).unwrap().vectors { Vectors::Frames(f) => f.len(), Vectors::One(_) => 1 };
        assert_eq!((n_of("old20"), n_of("new10"), n_of("new9")), (8, 21, 21));
        assert!(load_inputs(&conn, &["odd".to_string()]).unwrap().is_empty(), "another kind of row: not read yet");
        score_chunk(&conn, &cat, &stale).unwrap();
        assert!(conf(&conn, "old20").contains_key("d_one"), "8 frames, 8 won");
        assert!(conf(&conn, "new10").contains_key("d_one"), "10 of 21");
        assert!(!conf(&conn, "new9").contains_key("d_one"), "9 of 21");
        let st = status_with(&conn, &cat, &VideosNotNow::default()).unwrap();
        assert_eq!((st.total, st.scored, st.waiting_videos), (5, 3, 2), "odd and m45 wait; old20 doesn't");
        // The indexer reads old20 again: 21 frames replace the 8; scored again (score_items), and
        // it stays out of the stale list until the lenses or the rule change.
        add_frames(&conn, "old20", &vec![d_one.clone(); 21]);
        score_chunk(&conn, &cat, &["old20".to_string()]).unwrap();
        assert!(conf(&conn, "old20").contains_key("d_one"));
        assert!(stale_ids(&conn, &signature(&cat)).unwrap().is_empty());
        assert_eq!(status_with(&conn, &cat, &VideosNotNow::default()).unwrap().waiting_videos, 2);
        // Clearing what untaggable videos hold looks at rows of both kinds
        clear_duration(&conn, "old20");
        add_frames_as(&conn, "old20", &[], crate::clip::FRAMES_TAG_8);
        assert_eq!(clear_untaggable_videos(&conn).unwrap(), vec!["old20".to_string()]);
    }

    #[test]
    fn videos_the_indexer_cant_read_now_are_not_work_left() {
        // Review R1: a video without frame vectors that the indexer couldn't reach (nothing is
        // stored for it) counted as waiting for good, so Settings said "Looking through your
        // library · 1 of 2" with a bar that never filled; every such video too while ffmpeg is missing.
        let (conn, cat) = setup();
        let d_one = concept_vec(&cat, "d_one");
        let working = |s: &LensStatus| s.total > 0 && s.scored < s.total;   // settings.js isLensWorking
        add_item(&conn, "p1", "image", 1.0, 1);  add_vec(&conn, "p1", &d_one);
        add_item(&conn, "gone", "video", 1.0, 2);                                   // 10 s, no frames yet
        add_item(&conn, "unk", "video", 1.0, 3); clear_duration(&conn, "unk");      // length not measured yet
        add_item(&conn, "v8", "video", 1.0, 4);  add_frames(&conn, "v8", &vec![d_one.clone(); 8]);
        add_item(&conn, "v0", "video", 1.0, 5);  add_frames(&conn, "v0", &[]);      // frames failed: its cover
        add_vec(&conn, "v0", &d_one);
        score_chunk(&conn, &cat, &stale_ids(&conn, &signature(&cat)).unwrap()).unwrap();
        let st = status_with(&conn, &cat, &VideosNotNow::default()).unwrap();
        assert_eq!((st.total, st.scored, st.waiting_videos), (5, 3, 2));
        assert!(working(&st), "both videos can be read: work left");
        // The indexer couldn't reach "gone" this launch: it counts nowhere. "unk" still waits.
        let st = status_with(&conn, &cat, &VideosNotNow { skipped: vec!["gone".into()], no_ffmpeg: false }).unwrap();
        assert_eq!((st.total, st.scored, st.waiting_videos), (4, 3, 1));
        let st = status_with(&conn, &cat, &VideosNotNow { skipped: vec!["gone".into(), "unk".into()], no_ffmpeg: false }).unwrap();
        assert_eq!((st.total, st.scored, st.waiting_videos), (3, 3, 0));
        assert!(!working(&st), "the line ends on 'Made on this computer'");
        // No ffmpeg: no video without frame vectors can be read or measured.
        let st = status_with(&conn, &cat, &VideosNotNow { skipped: vec![], no_ffmpeg: true }).unwrap();
        assert_eq!((st.total, st.scored, st.waiting_videos), (3, 3, 0));
        // Videos with a clip_frames row count as before, whatever the indexer can do now.
        let st = status_with(&conn, &cat, &VideosNotNow { skipped: vec!["v8".into(), "v0".into()], no_ffmpeg: true }).unwrap();
        assert_eq!((st.total, st.scored), (3, 3));
    }

    #[test]
    fn status_counts() {
        let (conn, cat) = setup();
        let d_one = concept_vec(&cat, "d_one");
        add_item(&conn, "p1", "image", 1.0, 1); add_vec(&conn, "p1", &d_one);
        add_item(&conn, "p2", "image", 1.0, 2);                                   // waiting
        add_item(&conn, "p3", "gif", 1.0, 3);
        conn.execute("INSERT INTO clip_embeddings (id, model, emb) VALUES ('p3', 'failed', x'')", []).unwrap();   // unreadable: left out
        add_item(&conn, "v1", "video", 1.0, 4); add_frames(&conn, "v1", &vec![d_one.clone(); 8]);
        add_item(&conn, "v2", "video", 1.0, 5);                                   // frames not read yet
        add_item(&conn, "v3", "video", 1.0, 6); add_frames(&conn, "v3", &[]);     // failed, no cover: left out
        add_item(&conn, "l1", "link", 1.0, 7);
        conn.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES ('lens_last_check', '1763460000')", []).unwrap();
        let st = status_with(&conn, &cat, &VideosNotNow::default()).unwrap();
        assert_eq!((st.total, st.scored, st.waiting_videos, st.enabled), (4, 0, 1, false));
        assert_eq!(st.last_check, Some(1_763_460_000));
        score_chunk(&conn, &cat, &stale_ids(&conn, &signature(&cat)).unwrap()).unwrap();
        let st = status_with(&conn, &cat, &VideosNotNow::default()).unwrap();
        assert_eq!((st.total, st.scored), (4, 2));
        // d_one is a design concept that motion borrows.
        assert_eq!(st.per_lens.get("design"), Some(&2));
        assert_eq!(st.per_lens.get("motion"), Some(&2));
        assert_eq!(st.per_lens.get("thumbnail"), Some(&0));
        let json = serde_json::to_value(&st).unwrap();
        for k in ["enabled", "total", "scored", "waiting_videos", "last_check", "per_lens"] { assert!(json.get(k).is_some(), "{k}"); }
    }

    #[test]
    fn apply_role_turns_on_only_that_lens_and_the_switch() {
        let (conn, _) = setup();
        conn.execute("UPDATE lenses SET enabled = 1 WHERE id = 'thumbnail'", []).unwrap();
        apply_role_with(&conn, "motion").unwrap();
        let on: Vec<String> = conn.prepare("SELECT id FROM lenses WHERE enabled = 1").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(on, vec!["motion".to_string()]);
        assert!(suggestions_enabled(&conn));
        let role: String = conn.query_row("SELECT value FROM preferences WHERE key = 'user_role'", [], |r| r.get(0)).unwrap();
        assert_eq!(role, "motion");
    }

    /// An upload as lenses.js sends it: the file and its index entry.
    fn upload(text: &str, id: &str, version: i64) -> LensUpload {
        LensUpload { sha256: lenses::sha256_hex(text.as_bytes()), size: text.len() as u64, text: text.into(), id: id.into(), version }
    }

    #[test]
    fn uploads_are_checked_before_anything_is_installed() {
        let text = standard_texts(1).remove(0);
        let good = LensUpload { sha256: lenses::sha256_hex(text.as_bytes()).to_uppercase(), ..upload(&text, "design", 1) };
        assert_eq!(check_uploads(&[good.clone()], "1.2.3").unwrap().len(), 1);
        let wrong_size = LensUpload { size: 3, ..good.clone() };
        assert_eq!(check_uploads(&[wrong_size], "1.2.3").unwrap_err().code(), "checksum");
        let wrong_sha = LensUpload { sha256: "0".repeat(64), ..good.clone() };
        assert_eq!(check_uploads(&[wrong_sha], "1.2.3").unwrap_err().code(), "checksum");
        assert_eq!(check_uploads(&[good.clone()], "1.2.2").unwrap_err().code(), "too_new");
        let bad = text.replace("\"format\":2", "\"format\":3");
        assert_eq!(check_uploads(&[good, upload(&bad, "design", 1)], "1.2.3").unwrap_err().code(), "invalid");
    }

    #[test]
    fn uploads_must_match_their_index_entry_and_stay_small() {
        let [d, m, t]: [String; 3] = standard_texts(1).try_into().unwrap();
        let set = [upload(&d, "design", 1), upload(&m, "motion", 1), upload(&t, "thumbnail", 1)];
        assert_eq!(check_uploads(&set, "1.2.3").unwrap().len(), 3);
        // The file must be the lens and version its index entry names.
        let err = |files: &[LensUpload]| check_uploads(files, "1.2.3").unwrap_err().code();
        assert_eq!(err(&[upload(&d, "motion", 1)]), "invalid", "another lens than the entry says");
        assert_eq!(err(&[upload(&d, "design", 2)]), "invalid", "another version than the entry says");
        // At most 3 files per install…
        assert_eq!(err(&[set[0].clone(), set[1].clone(), set[2].clone(), set[0].clone()]), "invalid");
        // …and 768 KB in all (each file can be valid and under 256 KB on its own).
        let padded = |id: &str, role: &str, cid: &str, seed: u64| -> String {
            let mut v = lens_value(id, role, 1, &[tc(cid, unit(seed))], &[]);
            v["text_model"] = serde_json::json!("x".repeat(lenses::MAX_FILE_BYTES - 4_000));
            v.to_string()
        };
        let big = [padded("design", "base", "d_one", 1), padded("motion", "specialist", "m_one", 2),
                   padded("thumbnail", "specialist", "t_one", 3)];
        assert!(big.iter().all(|t| t.len() <= lenses::MAX_FILE_BYTES && lenses::parse_lens(t, false).is_ok()));
        let big_set = [upload(&big[0], "design", 1), upload(&big[1], "motion", 1), upload(&big[2], "thumbnail", 1)];
        assert!(big.iter().map(|t| t.len()).sum::<usize>() <= lenses::MAX_UPLOAD_BYTES, "three full files fit");
        assert_eq!(check_uploads(&big_set, "1.2.3").unwrap().len(), 3);
        let over = format!("{}{}", big[0], " ".repeat(lenses::MAX_UPLOAD_BYTES));
        assert_eq!(err(&[upload(&over, "design", 1)]), "invalid", "over 768 KB in all");
        // Only the three known lenses, each with its role.
        let promo = lens_text("promo", "specialist", 1, &[tc("p_one", unit(9))], &[]);
        assert_eq!(err(&[upload(&d, "design", 1), upload(&promo, "promo", 1)]), "invalid");
        let base_motion = lens_text("motion", "base", 1, &[tc("m_one", unit(11))], &[]);
        assert_eq!(err(&[upload(&base_motion, "motion", 1)]), "invalid");
        let huge = lens_text("design", "base", lenses::MAX_VERSION + 1, &[tc("d_one", unit(1))], &[]);
        assert_eq!(err(&[upload(&huge, "design", lenses::MAX_VERSION + 1)]), "invalid");
    }

    #[test]
    fn suggestion_maps_for_many_items_in_one_call() {
        let conn = test_db();
        add_item(&conn, "a", "image", 1.0, 1);
        add_item(&conn, "b", "video", 1.0, 2);
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"d_one":0.5,"col:t1":0.8}', auto_tag_model = 'lens-1' WHERE id = 'a'"#, []).unwrap();
        let ids: Vec<String> = ["a", "b", "gone"].iter().map(|s| s.to_string()).collect();
        let maps = suggestion_maps_with(&conn, &ids).unwrap();
        assert_eq!(maps.keys().collect::<Vec<_>>(), vec!["a", "b"], "unknown ids are left out");
        assert_eq!(maps["a"], SuggestionMap { conf: Some(r#"{"d_one":0.5,"col:t1":0.8}"#.into()), model: Some("lens-1".into()) });
        assert_eq!(maps["b"], SuggestionMap { conf: None, model: None });
        let json = serde_json::to_value(&maps).unwrap();
        assert_eq!(json["a"]["conf"], r#"{"d_one":0.5,"col:t1":0.8}"#, "the stored text, as it is");
        assert!(json["b"]["conf"].is_null() && json["b"]["model"].is_null());
        // Up to 1000 ids per call (read in chunks), more is refused.
        let many: Vec<String> = (0..MAX_MAP_IDS).map(|i| if i == 999 { "a".to_string() } else { format!("x{i}") }).collect();
        assert_eq!(suggestion_maps_with(&conn, &many).unwrap().len(), 1);
        let too_many: Vec<String> = (0..=MAX_MAP_IDS).map(|i| format!("x{i}")).collect();
        assert_eq!(suggestion_maps_with(&conn, &too_many).unwrap_err(), "too_many");
    }

    #[test]
    fn a_concept_named_like_a_people_tag_is_never_suggested() {
        // Spec §0b.2: compared trimmed, in any case, with ‘ ’ ʻ ʼ ` read as '.
        let conn = test_db();
        let mut d = lens_value("design", "base", 1, &[tc("d_one", unit(1)), tc("d_two", unit(2)), tc("d_song", unit(3))], &[]);
        d["concepts"][2]["label"] = serde_json::json!({ "en": "Music video", "uz": "Qo\u{2018}shiq" });
        install_texts(&conn, &[d.to_string()]).unwrap();
        let cat = Catalogue::load(&conn);
        let tag = |id: &str, name: &str, source: &str| {
            conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES (?1, ?2, ?3, 0)", params![id, name, source]).unwrap();
        };
        tag("t_en", "  l D ONE ", "user");                 // the English label, other case and spaces
        tag("t_uz", "qo'shiq", "import");                    // the Uzbek label typed with a plain '
        tag("t_model", "L d two", "model");                  // an old suggestion tag: not a people's tag
        let items = [("a", "d_one", "t_en"), ("b", "d_song", "t_uz"), ("c", "d_two", "t_model"), ("d", "d_one", "")];
        for (k, (id, concept, t)) in items.iter().enumerate() {
            add_item(&conn, id, "image", 1.0, k as i64);
            add_vec(&conn, id, &concept_vec(&cat, concept));
            if !t.is_empty() { link_tag(&conn, id, t).unwrap(); }
        }
        let ids: Vec<String> = items.iter().map(|(id, ..)| id.to_string()).collect();
        assert_eq!(score_chunk(&conn, &cat, &ids).unwrap().len(), 4);
        assert!(!conf(&conn, "a").contains_key("d_one"), "{:?}", conf(&conn, "a"));
        assert!(!conf(&conn, "b").contains_key("d_song"), "{:?}", conf(&conn, "b"));
        assert!(conf(&conn, "c").contains_key("d_two"), "model tags don't count");
        assert!(conf(&conn, "d").contains_key("d_one"), "items without the tag still get it");
        assert_eq!(name_key(" Qo\u{2019}SHIQ\u{02BC} "), "qo'shiq'");
    }

    #[test]
    fn old_suggestion_maps_are_cleared_at_every_start() {
        // The old column holds nothing after a start, whoever wrote it (qooti 1.2.2 shows its keys
        // as tag names): this version's suggestions are in lens_suggestions and stay, and so do
        // the status, model and signature this version set (1.2.2 doesn't re-tag those items).
        let conn = test_db();
        for (k, id) in ["legacy", "dev_build", "scored", "broken", "none"].iter().enumerate() {
            add_item(&conn, id, "image", 1.0, k as i64);
        }
        conn.execute_batch(r#"
            UPDATE inspirations SET auto_tag_confidence = '{"minimal":0.8}', auto_tag_status = 'done', auto_tag_model = 'clip-vit-base-patch32' WHERE id = 'legacy';
            UPDATE inspirations SET auto_tag_confidence = '{"web_design":0.6,"col:t1":0.8}', auto_tag_status = 'done', auto_tag_model = 'lens-1', auto_tag_sig = 'old' WHERE id = 'dev_build';
            UPDATE inspirations SET lens_suggestions = '{"web_design":0.6}', auto_tag_status = 'done', auto_tag_model = 'lens-1', auto_tag_sig = 's' WHERE id = 'scored';
            UPDATE inspirations SET auto_tag_confidence = 'not json', auto_tag_status = 'processing' WHERE id = 'broken';
        "#).unwrap();
        assert_eq!(clear_legacy_suggestions(&conn).unwrap(), 3);
        let row = |id: &str| -> Vec<Option<String>> { conn.query_row(
            "SELECT auto_tag_confidence, lens_suggestions, auto_tag_status, auto_tag_model, auto_tag_sig FROM inspirations WHERE id = ?1", [id],
            |r| (0..5usize).map(|i| r.get(i)).collect()).unwrap() };
        let s = |v: &str| Some(v.to_string());
        assert_eq!(row("legacy"), vec![None, None, s("done"), s("clip-vit-base-patch32"), None]);
        assert_eq!(row("dev_build"), vec![None, None, s("done"), s("lens-1"), s("old")]);
        assert_eq!(row("scored"), vec![None, s(r#"{"web_design":0.6}"#), s("done"), s("lens-1"), s("s")], "this version's suggestions stay");
        assert_eq!(row("broken"), vec![None, None, s("processing"), None, None]);
        assert_eq!(row("none"), vec![None, None, None, None, None]);
        assert_eq!(clear_legacy_suggestions(&conn).unwrap(), 0, "nothing the second time");
    }

    #[test]
    fn lens_status_is_sent_only_while_watched_and_at_most_twice_a_second() {
        let t0 = Instant::now();
        let mut last = None;
        // Nobody watching: nothing is built or sent, and the gap isn't used up.
        assert_eq!(status_send(false, &mut last, t0), StatusSend::Skip);
        assert_eq!(last, None);
        // Watching: the first goes out now; one inside the gap waits for its end.
        assert_eq!(status_send(true, &mut last, t0), StatusSend::Now);
        assert_eq!(status_send(true, &mut last, t0 + Duration::from_millis(200)), StatusSend::After(Duration::from_millis(300)));
        assert_eq!(status_send(true, &mut last, t0 + STATUS_GAP), StatusSend::Now);
        assert_eq!(status_send(false, &mut last, t0 + STATUS_GAP * 3), StatusSend::Skip);
    }

    #[test]
    fn upgrade_removes_model_tags_keeps_people_tags_and_runs_once() {
        let conn = test_db();
        for (id, k) in [("a", 1), ("b", 2)] { add_item(&conn, id, "image", 1.0, k); }
        conn.execute_batch(r#"
            INSERT INTO tags (id, name, source, created_at) VALUES ('m1', 'sunset', 'model', 0), ('u1', 'moodboard', 'user', 0), ('i1', 'from pack', 'import', 0);
            INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('a', 'm1'), ('b', 'm1'), ('a', 'u1'), ('b', 'i1');
            INSERT OR REPLACE INTO tag_usage_counts (tag_id, count) VALUES ('m1', 2), ('u1', 1), ('i1', 1);
            UPDATE inspirations SET auto_tag_status = 'done', auto_tag_model = 'clip-vit-base-patch32', auto_tag_confidence = '{"sunset":0.8}', auto_tag_sig = 'x',
                lens_suggestions = '{"d_one":0.5}';
            INSERT INTO tag_vocab (id, labels_json, prompts_json) VALUES ('sunset', '{}', '[]');
        "#).unwrap();
        let dir = std::env::temp_dir().join(format!("qooti-upgrade-{}", uuid::Uuid::new_v4()));
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };

        // A backup that can't be written changes nothing.
        let blocker = std::env::temp_dir().join(format!("qooti-upgrade-file-{}", uuid::Uuid::new_v4()));
        std::fs::write(&blocker, b"x").unwrap();
        assert!(matches!(upgrade_once_with(&conn, &blocker.join("backups"), 1).unwrap(), Upgrade::BackupFailed(_)));
        assert_eq!(count("SELECT COUNT(*) FROM tags"), 3);
        assert_eq!(count("SELECT COUNT(*) FROM schema_meta WHERE key = 'lens_v1_migrated'"), 0);
        let _ = std::fs::remove_file(&blocker);
        // The old suggestion tags wait for their backup: they are never adopted before it.
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default());
        assert_eq!(count("SELECT COUNT(*) FROM tags WHERE source = 'model'"), 1);

        let r = upgrade_once_with(&conn, &dir, 1_763_460_000).unwrap();
        let Upgrade::Done { tags, links, backup } = r else { panic!("{r:?}") };
        assert_eq!((tags, links), (1, 2));
        let backup = backup.unwrap();
        assert_eq!(backup.file_name().unwrap(), "model-tags-1763460000.json");
        assert!(!dir.join("model-tags-1763460000.json.part").exists(), "written to disk, then renamed");
        let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(&backup).unwrap()).unwrap();
        assert_eq!(doc["tags"][0]["name"], "sunset");
        assert_eq!(doc["tags"][0]["usage_count"], 2);
        assert_eq!(doc["tags"][0]["inspiration_ids"], serde_json::json!(["a", "b"]));

        assert_eq!(count("SELECT COUNT(*) FROM tags WHERE source = 'model'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM tags WHERE id IN ('u1', 'i1')"), 2);
        assert_eq!(count("SELECT COUNT(*) FROM inspiration_tags"), 2);
        assert_eq!(count("SELECT COUNT(*) FROM tag_usage_counts WHERE tag_id = 'm1'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM inspirations WHERE auto_tag_status IS NOT NULL OR auto_tag_model IS NOT NULL
                          OR auto_tag_confidence IS NOT NULL OR lens_suggestions IS NOT NULL OR auto_tag_sig IS NOT NULL"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM tag_vocab"), 0);

        // Idempotent: the second run does nothing, even to model tags that appear later (one named
        // like no concept and without an underscore stays as it is after the adoption step too).
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('m2', 'later', 'model', 0)", []).unwrap();
        assert_eq!(upgrade_once_with(&conn, &dir, 1_763_460_001).unwrap(), Upgrade::AlreadyDone);
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default());
        assert_eq!(count("SELECT COUNT(*) FROM tags WHERE id = 'm2' AND name = 'later'"), 1);
        assert!(!dir.join("model-tags-1763460001.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upgrade_on_a_fresh_library_needs_no_backup() {
        let conn = test_db();
        let dir = std::env::temp_dir().join(format!("qooti-upgrade-{}", uuid::Uuid::new_v4()));
        assert_eq!(upgrade_once_with(&conn, &dir, 5).unwrap(), Upgrade::Done { tags: 0, links: 0, backup: None });
        assert!(!dir.exists());
        assert_eq!(upgrade_once_with(&conn, &dir, 6).unwrap(), Upgrade::AlreadyDone);
    }

    #[test]
    fn chunks_write_everything() {
        let (conn, cat) = setup();
        let d_two = concept_vec(&cat, "d_two");
        let n = CHUNK + 37;
        for i in 0..n { let id = format!("i{i:04}"); add_item(&conn, &id, "image", 1.0, i as i64); add_vec(&conn, &id, &d_two); }
        let ids = stale_ids(&conn, &signature(&cat)).unwrap();
        assert_eq!(ids.len(), n);
        assert_eq!(load_inputs(&conn, &ids).unwrap().len(), n, "inputs load across IN-list chunks");
        let mut written = 0;
        for c in ids.chunks(CHUNK) { written += score_chunk(&conn, &cat, c).unwrap().len(); }
        assert_eq!(written, n);
        let done: i64 = conn.query_row("SELECT COUNT(*) FROM inspirations WHERE auto_tag_status = 'done'", [], |r| r.get(0)).unwrap();
        assert_eq!(done as usize, n);
    }

    // ── The shared-tag model (spec §0c; PORT-NOTES §7 test vectors) ──

    /// The tools' valid fixtures as a catalogue (every scored entry's vector is a basis vector e_k).
    fn fixture_catalogue() -> Catalogue {
        Catalogue::from_lenses(valid_fixture_texts().iter().map(|t| lenses::parse_lens(t, false).unwrap()).collect())
    }

    fn vectors_doc() -> serde_json::Value { serde_json::from_str(&fixture_text("shared-tag-vectors.json")).unwrap() }

    #[test]
    fn shared_tag_vectors_scoring() {
        // S1–S9 (shared-tag-vectors.json `scoring`): an item vector puts the case's weights on the
        // basis indices and is L2-normalised; a video has `count` equal frames, or its cover.
        let doc = vectors_doc();
        let cat = fixture_catalogue();
        let scorer = Scorer::new(&cat);
        let basis = &doc["basis"];
        let vector = |weights: &serde_json::Value| -> Vec<f32> {
            let mut v = vec![0f32; lenses::DIM];
            for (k, w) in weights.as_object().unwrap() { v[basis[k.as_str()].as_u64().unwrap() as usize] = w.as_f64().unwrap() as f32; }
            lenses::normalize(&mut v);
            v
        };
        let cases = doc["scoring"].as_array().unwrap();
        assert!(!cases.is_empty());
        for (i, case) in cases.iter().enumerate() {
            let (item, name) = (&case["item"], format!("S{} ({})", i + 1, case["name"].as_str().unwrap_or("")));
            let video = item["kind"] == "video";
            let vectors = if !video { Vectors::One(vector(&item["vector"])) } else {
                match item["frames"]["count"].as_u64().unwrap() as usize {
                    0 => Vectors::One(vector(&item["cover"])),   // frames failed: the cover, with the picture rule
                    n => Vectors::Frames(vec![vector(&item["frames"]["vector"]); n]),
                }
            };
            let media = if video { Media::Video } else { Media::Picture };
            let got = scorer.score_by_lens(&ItemInput { id: format!("s{}", i + 1), media, aspect: item["aspect"].as_f64().unwrap(), vectors });
            let want = case["expect"]["byLens"].as_object().unwrap();
            for (lens, list) in want {
                let have = got.iter().find(|(l, _)| l == lens).map(|(_, s)| s.clone()).unwrap_or_default();
                let list: Vec<(&str, f64)> = list.as_array().unwrap().iter().map(|p| (p[0].as_str().unwrap(), p[1].as_f64().unwrap())).collect();
                assert_eq!(have.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), list.iter().map(|(k, _)| *k).collect::<Vec<_>>(), "{name}: {lens}");
                for ((k, a), (_, b)) in have.iter().zip(&list) { assert!((a - b).abs() <= 1e-3, "{name}: {lens} {k} {a} (want {b})"); }
            }
            assert!(got.iter().all(|(l, _)| want.contains_key(l)), "{name}: {got:?}");
        }
    }

    #[test]
    fn shared_tag_signature() {
        // PORT-NOTES §7.5 (shared-tag-vectors.json `signature`).
        let doc = vectors_doc();
        for case in doc["signature"].as_array().unwrap() {
            assert_eq!(case["maxvid"].as_u64(), Some(MAX_TAG_VIDEO_SECS as u64));
            let installed: Vec<Lens> = case["installed"].as_array().unwrap().iter().map(|l| {
                let id = l["id"].as_str().unwrap();
                Lens { sha256: l["sha256"].as_str().unwrap().into(), ..lens(id, if id == "design" { Role::Base } else { Role::Specialist }, vec![]) }
            }).collect();
            let want = hex::encode(Sha256::digest(case["text"].as_str().unwrap().as_bytes()));
            assert_eq!(signature(&Catalogue::from_lenses(installed)), want[..16]);
        }
        assert_eq!(&hex::encode(Sha256::digest(doc["signature"][0]["text"].as_str().unwrap().as_bytes()))[..16], "59cb0a10d7208cfa");   // lens-score-4, maxvid=60 (R45; version 3: 6a9e44cccf8424bd)
    }

    #[test]
    fn per_lens_counts_follow_media() {
        // Settings' "{n} items have suggestions" per lens counts what the lens shows on each item's
        // media (spec §0c), on the valid fixtures. [motion, design, thumbnail]:
        let cases = [
            ("image", "d_type", [1, 1, 0]),    // design's picture entry, which motion borrows
            ("video", "d_type", [1, 0, 0]),    // motion's own video entry; design's covers pictures only
            ("video", "t_face", [0, 0, 0]),    // thumbnail's entry covers pictures only
            ("video", "d_photo", [0, 1, 1]),   // design's `any` entry, which thumbnail borrows
        ];
        for (kind, key, want) in cases {
            let conn = test_db();
            install_texts(&conn, &valid_fixture_texts()).unwrap();
            add_item(&conn, "x", kind, 1.0, 1);
            conn.execute("UPDATE inspirations SET lens_suggestions = ?1 WHERE id = 'x'", params![format!("{{\"{key}\":0.5}}")]).unwrap();
            let per = status_with(&conn, &Catalogue::load(&conn), &VideosNotNow::default()).unwrap().per_lens;
            assert_eq!([per["motion"], per["design"], per["thumbnail"]], want, "{kind} {key}");
        }
    }

    #[test]
    fn add_by_hand_entries_never_score() {
        // Valid fixtures: d_brand is added by hand in design and thumbnail, m_meme in motion.
        let cat = fixture_catalogue();
        for m in [Media::Picture, Media::Video] {
            let plan = Plan::new(&cat, m);
            let members: Vec<&Concept> = plan.base.iter().chain(plan.pools.iter().flat_map(|p| p.own.iter())).copied().collect();
            assert!(!members.is_empty() && members.iter().all(|c| c.suggest && c.vec.len() == lenses::DIM), "{m:?}");
            assert!(!members.iter().any(|c| c.id == "d_brand" || c.id == "m_meme"), "{m:?}");
        }
        // Wherever an item points, a hand entry is never suggested.
        let s = Scorer::new(&cat);
        for k in 0..40usize {
            let mut e = vec![0f32; lenses::DIM];
            e[k] = 1.0;
            for it in [
                ItemInput { id: "p".into(), media: Media::Picture, aspect: 1.0, vectors: Vectors::One(e.clone()) },
                ItemInput { id: "v".into(), media: Media::Video, aspect: 1.0, vectors: Vectors::Frames(vec![e.clone(); 8]) },
                ItemInput { id: "r".into(), media: Media::Picture, aspect: 1.0, vectors: Vectors::One(mix(&unit(7000 + k as u64), &e, 0.5)) },
            ] {
                assert!(s.score(&it).iter().all(|(id, _)| id != "d_brand" && id != "m_meme"), "e{k}");
            }
        }
        // Design for pictures only (decision 12): on videos its pool is empty and suggests nothing,
        // and a specialist's video pool holds only its own entries.
        let d = lens_text("design", "base", 1, &[tc_media("d_one", "picture", unit(1)), tc_media("d_two", "picture", unit(2))], &[]);
        let m = lens_text("motion", "specialist", 1, &[tc_media("m_one", "video", unit(11)), tc_media("m_two", "video", unit(12)), tc_hand("m_hand")], &[]);
        let cat = Catalogue::from_lenses([d, m].iter().map(|t| lenses::parse_lens(t, false).unwrap()).collect());
        assert!(Plan::new(&cat, Media::Video).base.is_empty());
        let s = Scorer::new(&cat);
        let video = |v: Vec<f32>| ItemInput { id: "v".into(), media: Media::Video, aspect: 1.0, vectors: Vectors::Frames(vec![v; 8]) };
        let rows = s.score_by_lens(&video(unit(1)));
        assert_eq!(rows.iter().map(|(l, _)| l.as_str()).collect::<Vec<_>>(), vec!["design", "motion"]);
        assert!(rows[0].1.is_empty(), "design suggests nothing on a video: {rows:?}");
        let rows = s.score_by_lens(&video(unit(11)));
        assert!(rows[0].1.is_empty() && rows[1].1.iter().any(|(id, _)| id == "m_one"), "{rows:?}");
        let pic = ItemInput { id: "p".into(), media: Media::Picture, aspect: 1.0, vectors: Vectors::One(unit(1)) };
        assert_eq!(s.score(&pic).first().map(|(id, _)| id.as_str()), Some("d_one"), "motion has nothing for pictures");
    }

    #[test]
    fn answer_records_the_showing_lens() {
        let conn = test_db();
        install_texts(&conn, &valid_fixture_texts()).unwrap();
        add_item(&conn, "a", "image", 1.0, 1);
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('t1', 'moodboard', 'user', 0)", []).unwrap();
        let lens_of = |key: &str| -> Option<String> { conn.query_row(
            "SELECT lens_id FROM tag_answers WHERE inspiration_id = 'a' AND concept_id = ?1", [key], |r| r.get(0)).unwrap() };
        // The card's lens: motion shows d_type on a picture by borrowing design's entry.
        answer_shown_with(&conn, "a", "d_type", "dismissed", Some("motion")).unwrap();
        assert_eq!(lens_of("d_type").as_deref(), Some("motion"));
        answer_shown_with(&conn, "a", "d_type", "dismissed", Some("design")).unwrap();
        assert_eq!(lens_of("d_type").as_deref(), Some("design"));
        // No lens, or one that isn't installed: the concept's primary lens.
        for shown in [Some("nope"), Some("Bad Id"), None] {
            answer_shown_with(&conn, "a", "d_type", "dismissed", shown).unwrap();
            assert_eq!(lens_of("d_type").as_deref(), Some("motion"), "{shown:?}");
            answer_shown_with(&conn, "a", "d_logo", "dismissed", shown).unwrap();
            assert_eq!(lens_of("d_logo").as_deref(), Some("design"), "{shown:?}");
        }
        // Collection hints have no lens.
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"col:t1":0.8}' WHERE id = 'a'"#, []).unwrap();
        assert!(answer_shown_with(&conn, "a", "col:t1", "added", Some("motion")).unwrap().is_some());
        assert_eq!(lens_of("col:t1"), None);
        // answer_with, as before (an add-by-hand tag here).
        let tag = answer_with(&conn, "a", "m_meme", "added").unwrap().unwrap();
        assert_eq!((tag.concept_id.as_deref(), tag.labels.map(|l| l.en)), (Some("m_meme"), Some("Meme".to_string())));
        assert_eq!(lens_of("m_meme").as_deref(), Some("motion"));
    }

    #[test]
    fn removed_concepts_keep_their_tags() {
        // PORT-PLAN §2.4: a concept no lens has any more stays a lens tag with its stored names.
        let (conn, _) = setup();
        add_item(&conn, "a", "image", 1.0, 1);
        add_item(&conn, "b", "image", 1.0, 2);
        let tag = answer_with(&conn, "a", "m_three", "added").unwrap().unwrap();
        assert_eq!(answer_with(&conn, "a", "m_two", "dismissed").unwrap(), None);
        let m2 = lens_text("motion", "specialist", 2, &[tc("m_one", unit(11)), tc("m_four", unit(14))], &["d_one"]);
        install_texts(&conn, &[m2]).unwrap();
        let cat = Catalogue::load(&conn);
        assert_storage_matches(&conn);
        let (lens, labels, active): (String, String, i64) = conn.query_row(
            "SELECT lens_id, labels_json, active FROM concepts WHERE id = 'm_three'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((lens.as_str(), active), ("motion", 0));
        assert_eq!(lenses::parse_labels(&labels).map(|l| l.en), Some("L m three".to_string()));
        // The tag keeps its link, its names in both languages and the answers.
        let t = load_tag(&conn, &tag.id).unwrap().unwrap();
        assert_eq!((t.usage_count, t.labels.map(|l| l.uz)), (1, Some("U m three".to_string())));
        let answers: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tag_answers WHERE inspiration_id = 'a' AND concept_id IN ('m_two', 'm_three')", [], |r| r.get(0)).unwrap();
        assert_eq!(answers, 2);
        // It can still be added to another item (the picker lists the library's own tags).
        crate::commands::tag_item(&conn, "b", &tag.id).unwrap();
        assert_eq!(load_tag(&conn, &tag.id).unwrap().unwrap().usage_count, 2);
        let listed = lenses::list_concepts_with(&conn, &cat).unwrap();
        let row = listed.iter().find(|c| c.id == "m_three").unwrap();
        assert!(!row.active && row.entries.is_empty() && row.borrowed_by.is_empty() && row.labels.en == "L m three");
        // Scoring never writes them again, not even to items at their old directions.
        for (id, k, v) in [("c", 3, unit(12)), ("d", 4, unit(13))] { add_item(&conn, id, "image", 1.0, k); add_vec(&conn, id, &v); }
        assert_eq!(score_chunk(&conn, &cat, &["c".to_string(), "d".to_string()]).unwrap().len(), 2);
        for id in ["c", "d"] {
            let c = conf(&conn, id);
            assert!(!c.contains_key("m_two") && !c.contains_key("m_three"), "{id}: {c:?}");
        }
    }

    // ── Upgrading a library to the shared-tag model (PORT-PLAN §2.3) ──

    /// The bundled lenses, parsed: the migration tests read what to expect from them (D21).
    fn bundled_lenses() -> Vec<Lens> { lenses::BUNDLED.iter().map(|(_, t)| lenses::parse_lens(t, true).unwrap()).collect() }

    /// Every row of a query as one text (columns joined by "|"), for before/after comparisons.
    fn rows(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.column_count();
        let out = stmt.query_map([], |r| (0..n).map(|i| Ok(match r.get_ref(i)? {
            rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
            v => format!("{v:?}"),
        })).collect::<rusqlite::Result<Vec<String>>>().map(|v| v.join("|"))).unwrap().map(|r| r.unwrap()).collect();
        out
    }

    fn changes(conn: &Connection) -> i64 { conn.query_row("SELECT total_changes()", [], |r| r.get(0)).unwrap() }

    /// A lens tag the way the dev build (and spec §4 until 2026-11-19) stored it: named
    /// 'lens:<concept id>'. Its id is `lt_<concept id>`.
    fn dev_build_lens_tag(conn: &Connection, concept_id: &str) -> String {
        let id = format!("lt_{concept_id}");
        conn.execute("INSERT INTO tags (id, name, source, created_at, concept_id) VALUES (?1, 'lens:' || ?2, 'lens', 0, ?2)",
            params![id, concept_id]).unwrap();
        conn.execute("INSERT OR IGNORE INTO tag_usage_counts (tag_id, count) VALUES (?1, 0)", params![id]).unwrap();
        id
    }

    /// What older versions show (qooti 1.2.2 shows tags.name as stored) and what this one shows
    /// (a lens tag's labels): every such text of a tag that isn't a people's own and reads as an id
    /// ("_" or the prefix "lens:"), as "<tag id>: <text>".
    fn ids_on_screen(conn: &Connection) -> Vec<String> {
        let reads_as_id = |s: &str| s.contains('_') || s.trim().to_lowercase().starts_with("lens:");
        rows(conn, "SELECT t.id, t.name, COALESCE(c.labels_json, '') FROM tags t LEFT JOIN concepts c ON c.id = t.concept_id
                    WHERE t.source NOT IN ('user', 'import') ORDER BY t.id").iter().flat_map(|row| {
            let mut f = row.splitn(3, '|');
            let (id, name, labels) = (f.next().unwrap_or(""), f.next().unwrap_or(""), f.next().unwrap_or(""));
            let mut shown = vec![name.to_string()];
            if let Some(l) = lenses::parse_labels(labels) { shown.extend([l.en, l.uz]); }
            shown.into_iter().filter(|s| reads_as_id(s)).map(|s| format!("{id}: {s}")).collect::<Vec<_>>()
        }).collect()
    }

    #[test]
    fn migration_fresh() {
        // (a) A new library: the bundled lenses and their entries at the first start.
        let conn = test_db();
        let bundled = bundled_lenses();
        assert_eq!(lenses::install_bundled(&conn).unwrap().installed.len(), bundled.len());
        let dir = std::env::temp_dir().join(format!("qooti-fresh-{}", uuid::Uuid::new_v4()));
        assert_eq!(upgrade_once_with(&conn, &dir, 1).unwrap(), Upgrade::Done { tags: 0, links: 0, backup: None });
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        let ids: HashSet<&str> = bundled.iter().flat_map(|l| l.concepts.iter().map(|c| c.id.as_str())).collect();
        assert_eq!(count("SELECT COUNT(*) FROM concept_entries"), bundled.iter().map(|l| l.concepts.len() as i64).sum::<i64>());
        assert_eq!(count("SELECT COUNT(*) FROM concepts WHERE active = 1"), ids.len() as i64);
        assert_eq!(count("SELECT COUNT(*) FROM concepts"), ids.len() as i64);
        assert_storage_matches(&conn);
        let version: String = conn.query_row("SELECT value FROM schema_meta WHERE key = 'version'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, "36");
    }

    #[test]
    fn migration_from_1_2_2() {
        // (b) A qooti 1.2.2 library: schema 35, no lens tables or crop columns, an old suggestion
        // tag, a people's tag and old suggestion fields.
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "DROP TABLE concept_entries; DROP TABLE lenses; DROP TABLE concepts; DROP TABLE tag_answers; DROP TABLE clip_frames;
             DROP INDEX idx_tags_concept; ALTER TABLE tags DROP COLUMN concept_id;
             ALTER TABLE inspirations DROP COLUMN auto_tag_sig; ALTER TABLE inspirations DROP COLUMN lens_suggestions;
             DROP INDEX idx_ins_original_hash; ALTER TABLE inspirations DROP COLUMN original_path;
             ALTER TABLE inspirations DROP COLUMN original_hash; ALTER TABLE inspirations DROP COLUMN crop_rect;
             UPDATE schema_meta SET value = '35' WHERE key = 'version';").unwrap();
        for (id, kind, k) in [("a", "image", 1), ("b", "video", 2)] { add_item(&conn, id, kind, 1.0, k); }
        conn.execute_batch(r#"
            INSERT INTO tags (id, name, source, created_at) VALUES ('m1', 'sunset', 'model', 0), ('u1', 'moodboard', 'user', 0);
            INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('a', 'm1'), ('a', 'u1'), ('b', 'u1');
            INSERT OR REPLACE INTO tag_usage_counts (tag_id, count) VALUES ('m1', 1), ('u1', 2);
            INSERT INTO tag_vocab (id, labels_json, prompts_json) VALUES ('sunset', '{}', '[]');
            UPDATE inspirations SET auto_tag_status = 'done', auto_tag_model = 'clip-vit-base-patch32', auto_tag_confidence = '{"sunset":0.8}' WHERE id = 'a';
        "#).unwrap();
        crate::db::migrate(&conn).unwrap();
        assert_eq!(lenses::install_bundled(&conn).unwrap().installed.len(), lenses::BUNDLED.len());
        let dir = std::env::temp_dir().join(format!("qooti-122-{}", uuid::Uuid::new_v4()));
        let up = upgrade_once_with(&conn, &dir, 1).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(up, Upgrade::Done { tags: 1, links: 1, .. }), "{up:?}");
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        for t in ["lenses", "concepts", "concept_entries", "tag_answers", "clip_frames"] {
            assert_eq!(count(&format!("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '{t}'")), 1, "{t}");
        }
        assert_eq!(count("SELECT COUNT(*) FROM tags WHERE source = 'model'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM inspiration_tags WHERE tag_id = 'u1'"), 2, "the people's tag keeps its links");
        assert_eq!(count("SELECT count FROM tag_usage_counts WHERE tag_id = 'u1'"), 2);
        assert_eq!(count("SELECT COUNT(*) FROM tag_vocab"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM inspirations WHERE auto_tag_confidence IS NOT NULL OR auto_tag_model IS NOT NULL"), 0);
        assert_storage_matches(&conn);
        let version: String = conn.query_row("SELECT value FROM schema_meta WHERE key = 'version'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, "36");
        // The items are then scored with the bundled lenses.
        let cat = Catalogue::load(&conn);
        let first = |m: Media| cat.lenses.iter().flat_map(|l| l.concepts.iter()).find(|c| c.covers(m)).unwrap().vec.clone();
        add_vec(&conn, "a", &first(Media::Picture));
        add_frames(&conn, "b", &vec![first(Media::Video); 8]);
        let stale = stale_ids(&conn, &signature(&cat)).unwrap();
        assert_eq!(stale.len(), 2);
        assert_eq!(score_chunk(&conn, &cat, &stale).unwrap().len(), 2);
        assert!(!conf(&conn, "a").is_empty() && !conf(&conn, "b").is_empty());
        assert_eq!(count("SELECT COUNT(*) FROM inspirations WHERE auto_tag_confidence IS NOT NULL"), 0, "scores go to lens_suggestions only");
    }

    /// The owner's library before this change: schema 36 with the lens v1 tables, design v2 /
    /// motion v1 / thumbnail v1 installed the v1 way (one concepts row per id with its home lens,
    /// media and vector). The stand-ins come from the bundled files, each version below the bundled
    /// one: design = the bundled design's scored entries, all for `any` media, plus mascot; motion =
    /// kinetic_type (videos), glass, screencast and map, borrowing mascot and a design tag; thumbnail
    /// = the bundled file. No lens_suggestions column yet (the suggestions were in
    /// auto_tag_confidence). Returns the old files (design, motion, thumbnail).
    fn lens_v1_library(conn: &Connection) -> Vec<String> {
        conn.execute_batch("DROP TABLE IF EXISTS concept_entries; DELETE FROM schema_meta WHERE key = 'lens_entries_sync';
                            ALTER TABLE inspirations DROP COLUMN lens_suggestions;").unwrap();
        let text_of = |id: &str| lenses::BUNDLED.iter().find(|(i, _)| *i == id).unwrap().1;
        let version_of = |id: &str| lenses::parse_lens(text_of(id), true).unwrap().version;
        assert!(version_of("design") > 1 && version_of("motion") > 1, "the bundled design and motion must be newer than the stand-ins");
        let mut design: serde_json::Value = serde_json::from_str(text_of("design")).unwrap();
        design["version"] = serde_json::json!(version_of("design") - 1);
        let mut entries: Vec<serde_json::Value> = design["concepts"].as_array().unwrap().iter()
            .filter(|c| c["suggest"] != serde_json::json!(false)).cloned().collect();
        for c in &mut entries { c["media"] = serde_json::json!("any"); }
        let borrowed = entries[0]["id"].as_str().unwrap().to_string();
        entries.push(serde_json::json!({ "id": "mascot", "label": { "en": "Mascot", "uz": "Maskot" }, "media": "any",
            "prompts": ["a cartoon brand mascot", "a friendly mascot character"], "vec": lenses::encode_vec(&unit(901)) }));
        design["concepts"] = serde_json::json!(entries);
        let motion = lens_text("motion", "specialist", version_of("motion") - 1,
            &[tc_media("kinetic_type", "video", unit(902)), tc("glass", unit(903)), tc("screencast", unit(904)), tc("map", unit(905))],
            &["mascot", &borrowed]);
        let old = vec![design.to_string(), motion, text_of("thumbnail").to_string()];
        for text in &old {
            let l = lenses::parse_lens(text, true).unwrap();
            conn.execute("INSERT INTO lenses (id, version, sha256, origin, role, file_json, prev_json, enabled, installed_at, updated_at)
                          VALUES (?1, ?2, ?3, 'bundled', ?4, ?5, NULL, ?6, 1, 1)",
                params![l.id, l.version, l.sha256, l.role.as_str(), text, (l.id == "motion") as i64]).unwrap();
            for c in &l.concepts {
                let blob: Vec<u8> = c.vec.iter().flat_map(|x| x.to_le_bytes()).collect();
                conn.execute("INSERT OR IGNORE INTO concepts (id, lens_id, labels_json, media, aspect_json, vec, active, updated_at)
                              VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1)",
                    params![c.id, l.id, serde_json::to_string(&c.label).unwrap(), c.media.as_str(),
                            c.aspect.map(|(lo, hi)| serde_json::json!([lo, hi]).to_string()), blob]).unwrap();
            }
        }
        conn.execute_batch("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('lens_v1_migrated', '1');
            INSERT OR REPLACE INTO preferences (key, value) VALUES ('user_role', 'motion'), ('tag_recommendations_enabled', 'true');").unwrap();
        old
    }

    #[test]
    fn migration_from_lens_v1_schema_36() {
        // (c) The owner's library is upgraded in place: the bundled design and motion install
        // together, every tag keeps its name and links, answers stay, and everything is re-scored.
        let conn = test_db();
        let old = lens_v1_library(&conn);
        let old_lenses: Vec<Lens> = old.iter().map(|t| lenses::parse_lens(t, true).unwrap()).collect();
        let old_sig = {
            let mut parts: Vec<String> = old_lenses.iter().map(|l| format!("{}@{}", l.id, l.sha256)).collect();
            parts.sort();
            hex::encode(Sha256::digest(format!("lens-score-2|clip-b32-q8|maxvid={MAX_TAG_VIDEO_SECS}|{}", parts.join(",")).as_bytes()))[..16].to_string()
        };
        let bundled = Catalogue::from_lenses(bundled_lenses());
        // A design tag the bundled lenses share with another lens (it moves to the primary lens).
        let shared: Option<String> = old_lenses[0].concepts.iter().map(|c| c.id.clone()).find(|id| bundled.entries_of(id).len() > 1);
        let pic = bundled.base().unwrap().concepts.iter().find(|c| c.covers(Media::Picture)).unwrap().vec.clone();
        let vid = bundled.lenses.iter().flat_map(|l| l.concepts.iter()).find(|c| c.covers(Media::Video)).unwrap().vec.clone();
        add_item(&conn, "p1", "image", 1.0, 1); add_vec(&conn, "p1", &pic);
        add_item(&conn, "p2", "image", 1.0, 2); add_vec(&conn, "p2", &unit(903));
        add_item(&conn, "v1", "video", 1.0, 3); add_frames(&conn, "v1", &vec![vid; 8]);
        add_item(&conn, "v2", "video", 1.0, 4); add_frames(&conn, "v2", &vec![unit(902); 8]);
        conn.execute(r#"UPDATE inspirations SET auto_tag_sig = ?1, auto_tag_model = 'lens-1', auto_tag_status = 'done',
                        auto_tag_confidence = '{"mascot":0.5,"kinetic_type":0.4,"glass":0.3}'"#, params![old_sig]).unwrap();
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('u1', 'moodboard', 'user', 0)", []).unwrap();
        link_tag(&conn, "p1", "u1").unwrap();
        let mut linked = vec![("p1", "mascot".to_string()), ("v2", "kinetic_type".to_string())];
        linked.extend(shared.iter().map(|s| ("p1", s.clone())));
        // The dev build's lens tags: named 'lens:<id>' (what qooti 1.2.2 showed)
        for (item, cid) in &linked { let t = dev_build_lens_tag(&conn, cid); link_tag(&conn, item, &t).unwrap(); }
        conn.execute("INSERT INTO tag_answers (inspiration_id, concept_id, answer, lens_id, answered_at) VALUES ('p2', 'glass', 'dismissed', 'motion', 1)", []).unwrap();
        if let Some(s) = &shared {
            conn.execute("INSERT INTO tag_answers (inspiration_id, concept_id, answer, lens_id, answered_at) VALUES ('p1', ?1, 'added', 'design', 1)", [s]).unwrap();
        }
        assert_eq!(ids_on_screen(&conn).len(), linked.len(), "before: 1.2.2 shows every lens tag as lens:<id>");
        let kept = |conn: &Connection| -> Vec<Vec<String>> { [
            "SELECT id, source, concept_id FROM tags ORDER BY id",
            "SELECT id, name FROM tags WHERE concept_id IS NULL ORDER BY id",
            "SELECT inspiration_id, tag_id FROM inspiration_tags ORDER BY 1, 2",
            "SELECT tag_id, count FROM tag_usage_counts ORDER BY 1",
            "SELECT inspiration_id, concept_id, answer, lens_id, answered_at FROM tag_answers ORDER BY 1, 2",
            "SELECT id, enabled FROM lenses ORDER BY id",
            "SELECT key, value FROM preferences ORDER BY key",
        ].iter().map(|sql| rows(conn, sql)).collect() };
        let before = kept(&conn);

        crate::db::migrate(&conn).unwrap();
        let report = lenses::install_bundled(&conn).unwrap();
        let dir = std::env::temp_dir().join(format!("qooti-v36-{}", uuid::Uuid::new_v4()));
        assert_eq!(upgrade_once_with(&conn, &dir, 1).unwrap(), Upgrade::AlreadyDone);
        // The lens tags get the names older versions show: their English labels (DS-1 / UI-1)
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags { lens_names: linked.len(), ..OlderTags::default() });
        assert_eq!(ids_on_screen(&conn), Vec::<String>::new());
        for (_, cid) in &linked {
            let (name, labels): (String, String) = conn.query_row(
                "SELECT t.name, c.labels_json FROM tags t JOIN concepts c ON c.id = t.concept_id WHERE t.id = ?1",
                [format!("lt_{cid}")], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            assert_eq!(name, lenses::parse_labels(&labels).unwrap().en, "{cid}");
        }
        let cat = Catalogue::load(&conn);
        let sig = signature(&cat);
        assert_ne!(sig, old_sig);
        let stale = stale_ids(&conn, &sig).unwrap();
        assert_eq!(stale.len(), 4, "every item with vectors is stale");
        assert_eq!(score_chunk(&conn, &cat, &stale).unwrap().len(), 4);

        // The lenses whose bundled version is higher installed, together.
        let mut want: Vec<String> = old_lenses.iter().filter(|o| bundled.get(&o.id).is_some_and(|b| b.version > o.version)).map(|o| o.id.clone()).collect();
        let mut got = report.installed.clone();
        want.sort();
        got.sort();
        assert_eq!(got, want);
        let version: String = conn.query_row("SELECT value FROM schema_meta WHERE key = 'version'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, "36");
        assert_storage_matches(&conn);
        // Concepts no bundled lens has stay inactive with their names and last lens.
        for (id, home) in [("mascot", "design"), ("kinetic_type", "motion"), ("glass", "motion")] {
            let (lens, labels, active): (String, String, i64) = conn.query_row(
                "SELECT lens_id, labels_json, active FROM concepts WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            assert!(lenses::parse_labels(&labels).is_some_and(|l| !l.en.is_empty() && !l.uz.is_empty()), "{id}");
            if cat.entries_of(id).is_empty() { assert_eq!((lens.as_str(), active), (home, 0), "{id}"); } else { assert_eq!(active, 1, "{id}"); }
        }
        if let Some(s) = &shared {
            let lens: String = conn.query_row("SELECT lens_id FROM concepts WHERE id = ?1", [s], |r| r.get(0)).unwrap();
            assert_eq!(Some(lens.as_str()), cat.primary_lens(s).map(|l| l.id.as_str()), "{s}");
        }
        // Tags (ids, sources, concepts; the names of all but lens tags), links, counts, answers,
        // the lens switches and the preferences are as they were.
        assert_eq!(kept(&conn), before);
        // Every item was scored with the new lenses; only keys a lens shows on its media.
        for id in ["p1", "p2", "v1", "v2"] {
            let s: Option<String> = conn.query_row("SELECT auto_tag_sig FROM inspirations WHERE id = ?1", [id], |r| r.get(0)).unwrap();
            assert_eq!(s.as_deref(), Some(sig.as_str()), "{id}");
            let media = if id.starts_with('v') { Media::Video } else { Media::Picture };
            for k in conf(&conn, id).keys().filter(|k| !k.starts_with("col:")) {
                assert!(cat.lenses.iter().any(|l| cat.shows(l, k, media)), "{id}: {k}");
            }
        }
        assert!(!conf(&conn, "v1").is_empty(), "the video has the new suggestions");
        // The next start writes nothing.
        let n = changes(&conn);
        crate::db::migrate(&conn).unwrap();
        lenses::install_bundled(&conn).unwrap();
        assert_eq!(upgrade_once_with(&conn, &dir, 2).unwrap(), Upgrade::AlreadyDone);
        assert_eq!(adopt_older_build_tags(&conn).unwrap(), OlderTags::default());
        assert!(stale_ids(&conn, &sig).unwrap().is_empty());
        assert_eq!(changes(&conn), n);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The app's start on one connection, in the order of lib.rs: migrate, the bundled lenses, the
    /// upgrade step (upgrade_once: the one-time step, the tags an older version made, the old
    /// column), then scoring what is stale.
    fn start_like_the_app(conn: &Connection) -> (OlderTags, usize) {
        crate::db::migrate(conn).unwrap();
        lenses::install_bundled(conn).unwrap();
        let backups = std::env::temp_dir().join(format!("qooti-start-{}", uuid::Uuid::new_v4()));
        upgrade_once_with(conn, &backups, 1).unwrap();
        let _ = std::fs::remove_dir_all(&backups);
        let older = adopt_older_build_tags(conn).unwrap();
        clear_legacy_suggestions(conn).unwrap();
        clear_untaggable_videos(conn).unwrap();
        let cat = Catalogue::load(conn);
        let stale = stale_ids(conn, &signature(&cat)).unwrap();
        let written = score_chunk(conn, &cat, &stale).unwrap().len();
        (older, written)
    }

    #[test]
    fn older_build_tags_become_lens_tags() {
        // The owner's library on 2026-11-19: the dev build (schema 36, lens v1) had written lens keys
        // into auto_tag_confidence; qooti 1.2.2 then opened it, showed those keys as tag names and its
        // Add made tags of them (source model): "icons", "Icons", "illustration", "web_design", and
        // "kinetic_type" (a tag the new lenses no longer have). Plus an old vocabulary id "dark_ui",
        // another tag with an underscore, people's own tags ("my_tag" stays exactly as it is) and an
        // old model tag named like nothing ("later").
        let conn = test_db();
        lens_v1_library(&conn);
        let bundled = Catalogue::from_lenses(bundled_lenses());
        let pic = |id: &str| bundled.entries_of(id).iter().find(|(_, c)| c.covers(Media::Picture)).map(|(_, c)| c.vec.clone()).unwrap();
        for (id, kind, k) in [("p1", "image", 1), ("p2", "image", 2), ("p3", "image", 3), ("p4", "image", 4), ("v1", "video", 5)] {
            add_item(&conn, id, kind, 1.0, k);
        }
        add_vec(&conn, "p1", &pic("icons"));
        add_vec(&conn, "p2", &pic("illustration"));
        add_vec(&conn, "p3", &pic("web_design"));
        add_frames(&conn, "v1", &vec![unit(902); 8]);
        conn.execute_batch(r#"
            UPDATE inspirations SET auto_tag_status = 'done', auto_tag_model = 'lens-1', auto_tag_sig = 'lens-score-2-sig',
                auto_tag_confidence = '{"web_design":0.6,"icons":0.5,"col:u_my":0.4}' WHERE id IN ('p1', 'p2', 'p3', 'v1');
            UPDATE inspirations SET auto_tag_status = 'done', auto_tag_model = 'clip-vit-base-patch32',
                auto_tag_confidence = '{"dark_ui":0.7}' WHERE id = 'p4';
            INSERT INTO tags (id, name, source, created_at) VALUES
                ('m_icons', 'icons', 'model', 0), ('m_icons2', 'Icons', 'model', 0), ('m_ill', 'illustration', 'model', 0),
                ('m_web', 'web_design', 'model', 0), ('m_kin', 'kinetic_type', 'model', 0), ('m_dark', 'dark_ui', 'model', 0),
                ('m_later', 'later', 'model', 0), ('x_neon', 'neon_glow', 'extension', 0),
                ('u_my', 'my_tag', 'user', 0), ('u_ill', 'Illustration', 'user', 0), ('i_pack', 'from_pack', 'import', 0);
            INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES
                ('p1', 'm_icons'), ('p2', 'm_icons'), ('p3', 'm_icons2'), ('p1', 'm_ill'), ('p2', 'm_ill'), ('p3', 'm_web'),
                ('v1', 'm_kin'), ('p4', 'm_dark'), ('p4', 'x_neon'), ('p4', 'm_later'),
                ('p1', 'u_my'), ('p2', 'u_ill'), ('p4', 'i_pack');
            INSERT INTO tag_vocab (id, labels_json, prompts_json) VALUES ('dark_ui', '{"en":"Dark UI","uz":"Qorong‘i UI"}', '[]');
            INSERT INTO tag_answers (inspiration_id, concept_id, answer, lens_id, answered_at) VALUES ('p3', 'web_design', 'dismissed', 'design', 7);
        "#).unwrap();
        // p2 already had the lens tag Icons (the dev build's Add: stored as 'lens:icons')
        let icons = dev_build_lens_tag(&conn, "icons");
        link_tag(&conn, "p2", &icons).unwrap();
        conn.execute_batch(crate::db::RECOUNT_ALL_TAGS).unwrap();
        let people = |conn: &Connection| rows(conn,
            "SELECT t.id, t.name, t.source, COALESCE(u.count, 0), (SELECT group_concat(inspiration_id) FROM inspiration_tags WHERE tag_id = t.id)
             FROM tags t LEFT JOIN tag_usage_counts u ON u.tag_id = t.id WHERE t.source IN ('user', 'import') ORDER BY t.id");
        let people_before = people(&conn);

        let (older, written) = start_like_the_app(&conn);
        // Links: p1 icons, p3 Icons, p1 illustration, p3 web_design, v1 kinetic_type (p2 had the lens
        // tag Icons already, and its own "Illustration"). The dev build's 'lens:icons' gets its label.
        assert_eq!(older, OlderTags { merged: 5, renamed: 2, links: 5, lens_names: 1, joined: 0 },
            "icons, Icons, illustration, web_design, kinetic_type; dark_ui, neon_glow; lens:icons");
        assert_eq!(written, 4, "every item with vectors is scored again");
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        let tags_of = |item: &str| -> Vec<String> { rows(&conn, &format!(
            "SELECT t.name FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id WHERE it.inspiration_id = '{item}' ORDER BY t.name")) };

        // The suggestion tags are lens tags now: one per concept, with the items, an `added` answer
        // each, and the right counts, stored under their English labels (what 1.2.2 shows). The
        // people's "Illustration" has illustration's label as its name, so it is that tag (one
        // name, one tag): it keeps its name and source and gets p1.
        assert_eq!(count("SELECT COUNT(*) FROM tags WHERE id IN ('m_icons', 'm_icons2', 'm_ill', 'm_web', 'm_kin')"), 0);
        assert_eq!(tags_of("p1"), vec!["Icons", "Illustration", "my_tag"]);
        assert_eq!(tags_of("p2"), vec!["Icons", "Illustration"]);
        assert_eq!(tags_of("p3"), vec!["Icons", "Website"]);
        assert_eq!(tags_of("v1"), vec!["L kinetic type"]);
        assert_eq!(tags_of("p4"), vec!["Dark UI", "Neon glow", "from_pack", "later"]);
        for (cid, name, source, n) in [("icons", "Icons", "lens", 3), ("illustration", "Illustration", "user", 2),
                                       ("web_design", "Website", "lens", 1), ("kinetic_type", "L kinetic type", "lens", 1)] {
            assert_eq!(rows(&conn, &format!("SELECT name || '|' || source FROM tags WHERE concept_id = '{cid}'")), vec![format!("{name}|{source}")], "{cid}");
            assert_eq!(count(&format!("SELECT u.count FROM tags t JOIN tag_usage_counts u ON u.tag_id = t.id WHERE t.concept_id = '{cid}'")), n, "{cid}");
        }
        assert_eq!(count("SELECT COUNT(*) FROM tags WHERE id = 'lt_icons'"), 1, "the dev build's tag, renamed in place");
        let answers = rows(&conn, "SELECT inspiration_id, concept_id, answer FROM tag_answers ORDER BY 1, 2");
        assert_eq!(answers, vec!["p1|icons|added", "p1|illustration|added", "p2|icons|added", "p2|illustration|added", "p3|icons|added",
                                 "p3|web_design|dismissed", "v1|kinetic_type|added"],
            "Add's answers (p2's own Illustration is illustration's tag by then); the earlier answer stays");
        // The renamed ones keep their id and items; people's tags keep their ids, names and sources,
        // and only "Illustration" changed: it stands for illustration now and has p1 too.
        assert_eq!(rows(&conn, "SELECT id, name, source FROM tags WHERE id IN ('m_dark', 'x_neon', 'm_later') ORDER BY id"),
            vec!["m_dark|Dark UI|model", "m_later|later|model", "x_neon|Neon glow|extension"]);
        let others = |all: Vec<String>| -> Vec<String> { all.into_iter().filter(|r| !r.starts_with("u_ill|")).collect() };
        assert_eq!(others(people(&conn)), others(people_before.clone()), "my_tag and from_pack untouched");
        assert_eq!(rows(&conn, "SELECT id, name, source, concept_id FROM tags WHERE id = 'u_ill'"), vec!["u_ill|Illustration|user|illustration"]);
        assert_eq!(rows(&conn, "SELECT inspiration_id FROM inspiration_tags WHERE tag_id = 'u_ill' ORDER BY 1"), vec!["p1", "p2"]);

        // Nothing an older version or this one shows is an id: the old column is empty everywhere,
        // the status this version set stays (1.2.2 doesn't tag those items again), and no tag but
        // a people's own shows "_" or "lens:", neither its stored name (what 1.2.2 shows) nor, for
        // a lens tag, its labels (what this version shows).
        assert_eq!(count("SELECT COUNT(*) FROM inspirations WHERE auto_tag_confidence IS NOT NULL"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM inspirations WHERE auto_tag_status = 'done'"), 5);
        assert_eq!(rows(&conn, "SELECT auto_tag_model FROM inspirations WHERE id = 'p4'"), vec!["clip-vit-base-patch32"]);
        let cat = Catalogue::load(&conn);
        assert_eq!(ids_on_screen(&conn), Vec::<String>::new());
        for id in rows(&conn, "SELECT id FROM tags WHERE concept_id IS NOT NULL ORDER BY id") {
            assert!(load_tag(&conn, &id).unwrap().unwrap().labels.is_some(), "lens tag {id} without labels");
        }
        // The new suggestions are in lens_suggestions, and never what the item has.
        for (item, has) in [("p1", "icons"), ("p2", "icons"), ("p3", "web_design")] {
            assert!(!conf(&conn, item).contains_key(has), "{item}: {has}");
        }
        assert!(stale_ids(&conn, &signature(&cat)).unwrap().is_empty());

        // The next start changes nothing.
        let n = changes(&conn);
        assert_eq!(start_like_the_app(&conn), (OlderTags::default(), 0));
        assert_eq!(changes(&conn), n);

        // 1.2.2 opens the library again and adds "icons" to p4 from a stale card: the next start
        // gives p4 the lens tag and empties the old column again.
        conn.execute_batch(r#"
            UPDATE inspirations SET auto_tag_confidence = '{"icons":0.5}' WHERE id = 'p4';
            INSERT INTO tags (id, name, source, created_at) VALUES ('m_again', 'icons', 'model', 0);
            INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('p4', 'm_again');"#).unwrap();
        assert_eq!(start_like_the_app(&conn).0, OlderTags { merged: 1, renamed: 0, links: 1, lens_names: 0, joined: 0 });
        assert!(tags_of("p4").contains(&"Icons".to_string()));
        assert_eq!(count("SELECT COUNT(*) FROM inspirations WHERE auto_tag_confidence IS NOT NULL"), 0);
    }

    /// qooti 1.2.2 on a library, with its own SQL (v1.2.2 commands.rs list_tags,
    /// apply_collection_tag_suggestions; grid.js applySuggestion): the tag names it shows, and its
    /// collection hints written into auto_tag_confidence (keys = tag names, as it shows them).
    fn names_1_2_2_shows(conn: &Connection) -> Vec<String> {
        rows(conn, "SELECT t.name FROM tags t LEFT JOIN tag_usage_counts u ON u.tag_id = t.id ORDER BY COALESCE(u.count, 0) DESC, t.name")
    }
    fn collection_hints_1_2_2(conn: &Connection) -> Vec<String> {
        rows(conn, "WITH
            col_tagged AS (SELECT ci.collection_id, COUNT(DISTINCT ci.inspiration_id) AS cnt FROM collection_items ci
                           JOIN inspiration_tags it ON it.inspiration_id = ci.inspiration_id GROUP BY ci.collection_id HAVING cnt >= 3),
            tag_freq AS (SELECT ci.collection_id, t.name AS tag_name, COUNT(DISTINCT ci.inspiration_id) AS freq FROM collection_items ci
                         JOIN inspiration_tags it ON it.inspiration_id = ci.inspiration_id JOIN tags t ON t.id = it.tag_id
                         GROUP BY ci.collection_id, t.name),
            dominant AS (SELECT tf.collection_id, tf.tag_name, CAST(tf.freq AS REAL) / ct.cnt AS confidence FROM tag_freq tf
                         JOIN col_tagged ct ON ct.collection_id = tf.collection_id WHERE CAST(tf.freq AS REAL) / ct.cnt >= 0.70)
            SELECT DISTINCT i.id || '|' || d.tag_name FROM dominant d JOIN collection_items ci ON ci.collection_id = d.collection_id
            JOIN inspirations i ON i.id = ci.inspiration_id
            WHERE NOT EXISTS (SELECT 1 FROM inspiration_tags it WHERE it.inspiration_id = i.id)
            ORDER BY 1")
    }

    #[test]
    fn qooti_1_2_2_shows_lens_tags_by_their_label_and_adds_them_by_name() {
        // DS-1 / UI-1: the owner opens the library with the installed qooti 1.2.2 again. It shows
        // tags.name as stored (filter chips, detail panel, picker, Settings › Tags), writes its
        // collection hints with tag names as keys, and its Add links the tag with that name (any
        // case) or makes a `model` tag of it. Lens tags are stored under their English labels, so
        // 1.2.2 shows words, never ids, and its Add finds the lens tag itself.
        let conn = test_db();
        lens_v1_library(&conn);
        for (id, k) in [("p1", 1), ("p2", 2), ("p3", 3), ("p4", 4)] { add_item(&conn, id, "image", 1.0, k); }
        // The dev build's lens tags (lens:<id>) and a people's tag named like one of their labels
        for (item, cid) in [("p1", "ui_design"), ("p2", "ui_design"), ("p3", "ui_design"), ("p1", "web_design"), ("p2", "poster")] {
            let t = conn.query_row("SELECT id FROM tags WHERE concept_id = ?1", [cid], |r| r.get::<_, String>(0)).optional().unwrap()
                .unwrap_or_else(|| dev_build_lens_tag(&conn, cid));
            link_tag(&conn, item, &t).unwrap();
        }
        conn.execute_batch("INSERT INTO tags (id, name, source, created_at) VALUES ('u_poster', 'poster', 'user', 0);
            INSERT INTO collections (id, name, created_at, updated_at) VALUES ('col', 'Client', 0, 0);
            INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES ('col', 'p1', 0), ('col', 'p2', 0), ('col', 'p3', 0), ('col', 'p4', 0);").unwrap();
        conn.execute_batch(crate::db::RECOUNT_ALL_TAGS).unwrap();
        let before = names_1_2_2_shows(&conn);
        assert!(before.iter().any(|n| n == "lens:ui_design"), "the dev build's names: {before:?}");

        let (older, _) = start_like_the_app(&conn);
        // The people's "poster" and the lens tag Poster are one tag (one name, one tag): the people's
        // one, with p2; the other two lens tags get their labels
        assert_eq!((older.joined, older.lens_names), (1, 2));
        let shown = names_1_2_2_shows(&conn);
        assert_eq!(shown, vec!["UI", "Website", "poster"], "1.2.2's tag list: one name, once");
        assert_eq!(rows(&conn, "SELECT id, source, concept_id FROM tags WHERE name = 'poster'"), vec!["u_poster|user|poster"]);
        assert_eq!(rows(&conn, "SELECT tag_id FROM inspiration_tags WHERE inspiration_id = 'p2' ORDER BY 1"), vec!["lt_ui_design", "u_poster"]);
        assert!(shown.iter().all(|n| !n.contains('_') && !n.to_lowercase().starts_with("lens:")));
        // Its collection hint for p4 (3 of the 4 items have UI) is a word
        assert_eq!(collection_hints_1_2_2(&conn), vec!["p4|UI"]);
        // Its Add on that hint finds the lens tag by name (any case) and links it: no tag of its own
        let tags_before = rows(&conn, "SELECT id FROM tags ORDER BY id");
        let found = rows(&conn, "SELECT id FROM tags WHERE lower(name) = lower('UI')");
        assert_eq!(found, vec!["lt_ui_design"]);
        conn.execute("INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES ('p4', 'lt_ui_design')", []).unwrap();
        assert_eq!(rows(&conn, "SELECT id FROM tags ORDER BY id"), tags_before);
        // The next start of this version keeps all of it: the lens tag on p4, the same names
        assert_eq!(start_like_the_app(&conn).0, OlderTags::default());
        assert_eq!(rows(&conn, "SELECT tag_id FROM inspiration_tags WHERE inspiration_id = 'p4'"), vec!["lt_ui_design"]);
        assert_eq!(ids_on_screen(&conn), Vec::<String>::new());
    }

    #[test]
    fn the_scorer_never_writes_the_old_column() {
        // auto_tag_confidence is what qooti 1.2.2 shows as tag names. Scoring, answers, adds, the
        // same-name rule and clearing untaggable videos all use lens_suggestions and leave it as it
        // is (collection hints and crop: commands.rs and crop.rs tests); only the start empties it.
        let (conn, cat) = setup();
        let (d_one, t_one) = (concept_vec(&cat, "d_one"), concept_vec(&cat, "t_one"));
        add_item(&conn, "a", "image", 1.0, 1); add_vec(&conn, "a", &mix(&d_one, &t_one, 0.5));
        add_item(&conn, "b", "image", 1.0, 2); add_vec(&conn, "b", &d_one);
        add_item(&conn, "v", "video", 1.0, 3); set_duration(&conn, "v", 90.0); add_frames(&conn, "v", &vec![d_one.clone(); 8]);
        conn.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('t1', 'moodboard', 'user', 0), ('t2', 'L t one', 'user', 0)", []).unwrap();
        const OLD: &str = r#"{"web_design":0.5}"#;
        conn.execute("UPDATE inspirations SET auto_tag_confidence = ?1", [OLD]).unwrap();
        let ids: Vec<String> = ["a", "b", "v"].iter().map(|s| s.to_string()).collect();
        assert_eq!(score_chunk(&conn, &cat, &ids).unwrap().len(), 2, "the long video is never scored");
        assert!(conf(&conn, "a").contains_key("d_one") && conf(&conn, "a").contains_key("t_one"), "{:?}", conf(&conn, "a"));
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = json_set(lens_suggestions, '$."col:t1"', 0.8) WHERE id = 'a'"#, []).unwrap();
        answer_with(&conn, "a", "d_one", "added").unwrap().unwrap();
        answer_with(&conn, "a", "col:t1", "added").unwrap().unwrap();
        answer_shown_with(&conn, "b", "d_one", "dismissed", Some("design")).unwrap();
        link_tag(&conn, "a", "t2").unwrap();
        drop_questions_named_like(&conn, "a", "t2").unwrap();   // the person's "L t one" takes the t_one question
        let left = conf(&conn, "a");
        assert!(!left.contains_key("d_one") && !left.contains_key("t_one") && !left.contains_key("col:t1"), "{left:?}");
        conn.execute(r#"UPDATE inspirations SET lens_suggestions = '{"d_one":0.5}', auto_tag_status = 'done' WHERE id = 'v'"#, []).unwrap();
        assert_eq!(clear_untaggable_videos(&conn).unwrap(), vec!["v".to_string()]);
        conn.execute("UPDATE inspirations SET auto_tag_sig = NULL", []).unwrap();
        score_chunk(&conn, &cat, &ids).unwrap();
        let old = rows(&conn, "SELECT COALESCE(auto_tag_confidence, 'NULL') FROM inspirations ORDER BY id");
        assert_eq!(old, vec![OLD, OLD, OLD], "never written");
        assert!(rows(&conn, "SELECT lens_suggestions FROM inspirations WHERE id = 'b'").iter().all(|m| !m.contains("d_one")), "the dismissal holds");
        // The start empties it, and leaves the rest alone.
        let rest = rows(&conn, "SELECT id, COALESCE(lens_suggestions, ''), COALESCE(auto_tag_status, ''), COALESCE(auto_tag_sig, '') FROM inspirations ORDER BY id");
        assert_eq!(clear_legacy_suggestions(&conn).unwrap(), 3);
        assert_eq!(rows(&conn, "SELECT COUNT(*) FROM inspirations WHERE auto_tag_confidence IS NOT NULL"), vec!["Integer(0)"]);
        assert_eq!(rows(&conn, "SELECT id, COALESCE(lens_suggestions, ''), COALESCE(auto_tag_status, ''), COALESCE(auto_tag_sig, '') FROM inspirations ORDER BY id"), rest);
    }

    /// The isolated E2E stage's check (PORT-PLAN §5.4) on a COPY of a real schema-36 library with the
    /// lens v1 tables (never the live file): the start-up steps of the app (migrate, the bundled
    /// lenses, the upgrade step, the tags an older version made, the old column, scoring what is
    /// stale), then the C-checks. Prints counts only.
    ///   QOOTI_DB_COPY=<copy> cargo test --lib real_v36_copy_upgrades_in_place -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_v36_copy_upgrades_in_place() {
        let conn = Connection::open(std::env::var("QOOTI_DB_COPY").expect("QOOTI_DB_COPY")).unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        let meta = |key: &str| -> Option<String> { conn.query_row("SELECT value FROM schema_meta WHERE key = ?1", [key], |r| r.get(0)).optional().unwrap() };
        assert_eq!(meta("version").as_deref(), Some("36"), "a schema-36 library");
        let counts = |conn: &Connection| -> Vec<String> { [
            "SELECT 'tags ' || source || ' ' || COUNT(*) FROM tags GROUP BY source ORDER BY source",
            "SELECT 'concept tags ' || COUNT(*) FROM tags WHERE concept_id IS NOT NULL",
            "SELECT 'links ' || COUNT(*) FROM inspiration_tags",
            "SELECT 'usage rows ' || COUNT(*) || ', total ' || COALESCE(SUM(count), 0) FROM tag_usage_counts",
            "SELECT 'answers ' || answer || ' ' || COUNT(*) FROM tag_answers GROUP BY answer ORDER BY answer",
        ].iter().flat_map(|sql| rows(conn, sql)).collect() };
        let switches = |conn: &Connection| -> Vec<String> {
            let mut v = rows(conn, "SELECT 'lens ' || id || ' on ' || enabled FROM lenses ORDER BY id");
            v.extend(rows(conn, "SELECT key || ' ' || COALESCE(value, '') FROM preferences WHERE key IN ('user_role', 'tag_recommendations_enabled') ORDER BY key"));
            v
        };
        let (before, switches_before) = (counts(&conn), switches(&conn));
        let old_ids: std::collections::BTreeSet<String> = rows(&conn, "SELECT file_json FROM lenses").iter()
            .filter_map(|t| lenses::parse_lens(t, true).ok()).flat_map(|l| l.concepts.into_iter().map(|c| c.id)).collect();
        println!("before: {before:?}; {switches_before:?}; lenses {:?}; {} concept ids in the installed files; concepts {} ({} active)",
            rows(&conn, "SELECT id || ' v' || version FROM lenses ORDER BY id"), old_ids.len(),
            count("SELECT COUNT(*) FROM concepts"), count("SELECT COUNT(*) FROM concepts WHERE active = 1"));
        // What adopt_older_build_tags may change: the tags an older version made; everything else stays.
        const OLDER: &str = "t.concept_id IS NULL AND t.source NOT IN ('user', 'import')
                             AND (t.source = 'model' OR instr(t.name, '_') > 0 OR lower(trim(t.name)) LIKE 'lens:%')";
        let kept = |conn: &Connection| -> Vec<Vec<String>> { [
            "SELECT id, name, source FROM tags WHERE source IN ('user', 'import') ORDER BY id".to_string(),
            "SELECT it.inspiration_id, it.tag_id FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id
             WHERE t.source IN ('user', 'import') ORDER BY 1, 2".to_string(),
        ].iter().map(|sql| rows(conn, sql)).collect() };
        let lens_links = |conn: &Connection| -> HashSet<String> { rows(conn,
            "SELECT it.inspiration_id || '|' || it.tag_id FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id WHERE t.concept_id IS NOT NULL")
            .into_iter().collect() };
        let answers = |conn: &Connection| -> HashSet<String> { rows(conn,
            "SELECT inspiration_id, concept_id, answer, COALESCE(lens_id, ''), answered_at FROM tag_answers").into_iter().collect() };
        let older_ids: HashSet<String> = rows(&conn, &format!("SELECT t.id FROM tags t WHERE {OLDER}")).into_iter().collect();
        let older_links = count(&format!("SELECT COUNT(*) FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id WHERE {OLDER}"));
        let older_items: HashSet<String> = rows(&conn, &format!(
            "SELECT DISTINCT it.inspiration_id FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id WHERE {OLDER}")).into_iter().collect();
        let (kept_before, lens_links_before, answers_before) = (kept(&conn), lens_links(&conn), answers(&conn));
        // One name, one tag (2026-11-20): every tag with its name, source, concept and items
        type TagRow = (String, String, Option<String>, HashSet<String>);
        let tag_rows = |conn: &Connection| -> HashMap<String, TagRow> {
            let mut out: HashMap<String, TagRow> = HashMap::new();
            let mut stmt = conn.prepare("SELECT t.id, t.name, t.source, t.concept_id, it.inspiration_id FROM tags t
                                         LEFT JOIN inspiration_tags it ON it.tag_id = t.id").unwrap();
            let all = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                                                 r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))).unwrap();
            for row in all {
                let (id, name, source, concept, item) = row.unwrap();
                let entry = out.entry(id).or_insert_with(|| (name, source, concept, HashSet::new()));
                if let Some(i) = item { entry.3.insert(i); }
            }
            out
        };
        let is_people = |source: &str| source == "user" || source == "import";
        let tags_before = tag_rows(&conn);
        println!("tags an older version made: {} ({older_links} links); old suggestion column filled on {} items; {} tag names or labels shown as ids",
            older_ids.len(), count("SELECT COUNT(*) FROM inspirations WHERE auto_tag_confidence IS NOT NULL"), ids_on_screen(&conn).len());

        // The app's start: db::init → migrate; install_bundled; upgrade_once (the one-time step, the
        // tags an older version made, the old column); score_stale.
        let start = |conn: &Connection| -> (lenses::InstallReport, Upgrade, OlderTags, usize, usize) {
            crate::db::migrate(conn).unwrap();
            let report = lenses::install_bundled(conn).unwrap();
            let backups = std::env::temp_dir().join(format!("qooti-v36-copy-{}", uuid::Uuid::new_v4()));
            let upgrade = upgrade_once_with(conn, &backups, 1).unwrap();
            let _ = std::fs::remove_dir_all(&backups);
            let older = adopt_older_build_tags(conn).unwrap();
            clear_legacy_suggestions(conn).unwrap();
            clear_untaggable_videos(conn).unwrap();
            let cat = Catalogue::load(conn);
            let stale = stale_ids(conn, &signature(&cat)).unwrap();
            let mut written = 0;
            for c in stale.chunks(CHUNK) { written += score_chunk(conn, &cat, c).unwrap().len(); }
            (report, upgrade, older, stale.len(), written)
        };
        let (report, upgrade, older, stale, written) = start(&conn);
        let cat = Catalogue::load(&conn);
        let sig = signature(&cat);
        println!("installed {:?}, unchanged {:?}; upgrade {upgrade:?}; older-version tags {older:?}; scored {written} of {stale} stale; sig {sig}",
            report.installed, report.unchanged);

        let bundled = bundled_lenses();
        let ids: HashSet<&str> = bundled.iter().flat_map(|l| l.concepts.iter().map(|c| c.id.as_str())).collect();
        let entries: i64 = bundled.iter().map(|l| l.concepts.len() as i64).sum();
        let mut versions: Vec<String> = bundled.iter().map(|l| format!("{} v{}", l.id, l.version)).collect();
        versions.sort();
        let c1 = meta("version").as_deref() == Some("36") && count("SELECT COUNT(*) FROM concept_entries") == entries && meta("lens_entries_sync").is_some();
        let c2 = rows(&conn, "SELECT id || ' v' || version FROM lenses ORDER BY id") == versions && switches(&conn) == switches_before;
        let retired: Vec<&String> = old_ids.iter().filter(|id| !ids.contains(id.as_str())).collect();
        let retired_ok = retired.iter().all(|id| conn.query_row("SELECT active, labels_json FROM concepts WHERE id = ?1", [id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).optional().unwrap()
            .is_some_and(|(active, labels)| active == 0 && lenses::parse_labels(&labels).is_some()));
        let c3 = count("SELECT COUNT(*) FROM concepts WHERE active = 1") == ids.len() as i64 && retired_ok;
        let after = counts(&conn);
        // One name, one tag: the people's tags that became their concept's tag (no concept before,
        // one now), and the lens tags that joined them (gone, their concept on such a people's tag)
        let tags_after = tag_rows(&conn);
        let became: HashMap<String, String> = tags_after.iter()
            .filter(|(id, a)| is_people(&a.1) && tags_before.get(*id).is_some_and(|b| b.2.is_none()))
            .filter_map(|(id, a)| a.2.clone().map(|c| (id.clone(), c))).collect();
        let joined: HashMap<String, String> = tags_before.iter()
            .filter(|(id, b)| !is_people(&b.1) && !tags_after.contains_key(*id))
            .filter_map(|(id, b)| b.2.as_ref().and_then(|c| became.iter().find(|(_, pc)| *pc == c)).map(|(p, _)| (id.clone(), p.clone())))
            .collect();
        // People's tags keep their ids, names, sources and links; a new link is on an item an older
        // version's tag or a lens tag that joined it had. Lens links and answers only grow, by what
        // the older version's tags brought (their links, an answer each), and a joined lens tag's
        // links and hint answers are its people's tag's now; those older tags are gone or readable.
        // Without such tags or joins, every count is as it was.
        let (lens_links_after, answers_after) = (lens_links(&conn), answers(&conn));
        let moved_hint = |row: &String| older_ids.iter().chain(joined.keys()).any(|id| row.contains(&format!("|col:{id}|")));
        let older_left = count(&format!("SELECT COUNT(*) FROM tags t WHERE {OLDER}
              AND (instr(t.name, '_') > 0 OR lower(trim(t.name)) LIKE 'lens:%' OR lower(trim(t.name)) IN (SELECT id FROM concepts))"));
        let people_links_ok = tags_before.iter().filter(|(_, b)| is_people(&b.1)).all(|(id, b)| {
            let Some(a) = tags_after.get(id) else { return false };
            let from_joined: HashSet<&String> = joined.iter().filter(|(_, p)| *p == id).flat_map(|(l, _)| tags_before[l].3.iter()).collect();
            b.3.is_subset(&a.3) && a.3.difference(&b.3).all(|i| older_items.contains(i) || from_joined.contains(i))
        });
        let translated: HashSet<String> = lens_links_before.iter().map(|link| {
            let (item, tag) = link.split_once('|').unwrap_or((link.as_str(), ""));
            format!("{item}|{}", joined.get(tag).map(String::as_str).unwrap_or(tag))
        }).collect();
        let joined_own: i64 = became.keys().filter(|p| joined.values().any(|v| v == *p)).map(|p| tags_before[p].3.len() as i64).sum();
        let c4 = kept(&conn)[0] == kept_before[0]
            && people_links_ok
            && translated.is_subset(&lens_links_after)
            && lens_links_after.len() as i64 - translated.len() as i64 <= older_links + joined_own
            && answers_before.iter().filter(|a| !moved_hint(a)).all(|a| answers_after.contains(a))
            && older_left == 0
            && (!older_ids.is_empty() || !joined.is_empty() || after == before);
        let unnamed = rows(&conn, "SELECT c.labels_json FROM tags t LEFT JOIN concepts c ON c.id = t.concept_id WHERE t.concept_id IS NOT NULL")
            .iter().filter(|l| lenses::parse_labels(l).is_none()).count();
        let c5 = unnamed == 0;
        let active: HashSet<String> = rows(&conn, "SELECT id FROM concepts WHERE active = 1").into_iter().collect();
        let mut outside = 0;
        let scored_maps = rows(&conn, &format!("SELECT lens_suggestions FROM inspirations WHERE auto_tag_sig = '{sig}' AND lens_suggestions IS NOT NULL"));
        for text in &scored_maps {
            let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(text) else { outside += 1; continue };
            outside += map.keys().filter(|k| !k.starts_with("col:") && !active.contains(k.as_str())).count();
        }
        let c6 = stale_ids(&conn, &sig).unwrap().is_empty() && outside == 0;
        let n = changes(&conn);
        let again = start(&conn);
        let c7 = changes(&conn) == n && again.0.installed.is_empty() && again.2 == OlderTags::default() && again.4 == 0;
        // Nothing an older version or this one shows is an id: the old column is empty, and no tag
        // but a people's own (shown as typed) has a stored name (what qooti 1.2.2 shows, also as
        // its collection hints) or, for a lens tag, a label (what this version shows) with "_" or
        // the prefix "lens:" (DS-1 / UI-1).
        let underscored = ids_on_screen(&conn).len();
        let c8 = count("SELECT COUNT(*) FROM inspirations WHERE auto_tag_confidence IS NOT NULL") == 0 && underscored == 0;
        // One name, one tag (2026-11-20): no lens tag is left that one people's tag of its name could
        // be; each people's tag that became a concept's tag is that concept's only tag, holds what it
        // and the lens tags that joined it held, and is counted right; every other people's tag keeps
        // its concept (none, mostly). Counts only.
        let mut left = [0usize; 3];   // could still join, two people's tags, another concept
        for (_, a) in tags_after.iter().filter(|(_, a)| !is_people(&a.1)) {
            let Some(cid) = &a.2 else { continue };
            let labels: Option<String> = conn.query_row("SELECT labels_json FROM concepts WHERE id = ?1", [cid], |r| r.get(0)).optional().unwrap();
            match peoples_tag_for(&peoples_tags_named(&conn, &name_key(&lens_tag_base_from(labels.as_deref(), cid))).unwrap(), cid) {
                Peoples::One(_) => left[0] += 1,
                Peoples::TwoNamed => left[1] += 1,
                Peoples::OtherConcept => left[2] += 1,
                Peoples::None => {}
            }
        }
        let became_ok = became.iter().all(|(p, c)| {
            let a = &tags_after[p];
            let mut want = tags_before[p].3.clone();
            for (l, _) in joined.iter().filter(|(_, jp)| *jp == p) { want.extend(tags_before[l].3.iter().cloned()); }
            let counted: i64 = conn.query_row("SELECT COALESCE((SELECT count FROM tag_usage_counts WHERE tag_id = ?1), -1)", [p], |r| r.get(0)).unwrap();
            want.is_subset(&a.3) && counted == a.3.len() as i64
                && tags_after.values().filter(|t| t.2.as_deref() == Some(c.as_str())).count() == 1
        });
        let concepts_kept = tags_before.iter().filter(|(id, b)| is_people(&b.1) && !became.contains_key(*id))
            .all(|(id, b)| tags_after.get(id).is_some_and(|a| a.2 == b.2));
        let new_links: usize = became.keys().map(|p| tags_after[p].3.len() - tags_before[p].3.len()).sum();
        let tag_lens = |tags: &HashMap<String, TagRow>| tags.values().filter(|t| t.0.contains("(Tag lens")).count();
        let c9 = left[0] == 0 && became_ok && concepts_kept;
        println!("after: {after:?}; {:?}; concepts {} ({} active), {} retired ids (all inactive with labels: {retired_ok}); {} concept tags without labels; {} scored maps, {outside} keys outside the active tags; lens links +{}, answers +{}; {underscored} tag names or labels shown as ids",
            switches(&conn), count("SELECT COUNT(*) FROM concepts"), active.len(), retired.len(), unnamed, scored_maps.len(),
            lens_links_after.len() as i64 - lens_links_before.len() as i64, answers_after.len() as i64 - answers_before.len() as i64);
        println!("one name, one tag: {} lens tags joined people's tags; {} people's tags became their concept's tag (+{new_links} items); \
                  kept apart: {} named like two people's tags, {} named like a people's tag of another tag; could still join: {}; \
                  '(Tag lens)' names {} → {}", joined.len(), became.len(), left[1], left[2], left[0], tag_lens(&tags_before), tag_lens(&tags_after));
        println!("C1 {c1} · C2 {c2} · C3 {c3} · C4 {c4} · C5 {c5} · C6 {c6} · C7 {c7} · C8 {c8} · C9 {c9}");
        assert!(c1 && c2 && c3 && c4 && c5 && c6 && c7 && c8 && c9);
    }

    /// On a COPY of a real library (never the live file): the schema upgrade, the bundled lenses,
    /// the one-time clean-up and a full scoring run from the stored vectors, dumped so the tools'
    /// mirror (scripts/lenses/lens-score.mjs) can be compared with it. QOOTI_FRAMES optionally
    /// loads video frame vectors made by scripts/lenses/embed-frames.mjs into clip_frames first.
    ///   QOOTI_DB_COPY=<copy> [QOOTI_FRAMES=<frame-vectors.json>] [QOOTI_DUMP=<out.json>]
    ///   cargo test --lib real_library_copy_scores -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_copy_scores() {
        use base64::Engine;
        let conn = Connection::open(std::env::var("QOOTI_DB_COPY").expect("QOOTI_DB_COPY")).unwrap();
        crate::db::migrate(&conn).unwrap();
        let report = lenses::install_bundled(&conn).unwrap();
        let backups = std::env::temp_dir().join(format!("qooti-real-copy-{}", uuid::Uuid::new_v4()));
        let upgrade = upgrade_once_with(&conn, &backups, 1).unwrap();
        let _ = std::fs::remove_dir_all(&backups);
        if let Ok(file) = std::env::var("QOOTI_FRAMES") {
            let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
            let items = doc["items"].as_object().expect("a frame-vectors.json");
            for (id, it) in items {
                let n = it["n"].as_i64().unwrap_or(0);
                let emb = base64::engine::general_purpose::STANDARD.decode(it["f16"].as_str().unwrap_or("")).unwrap();
                assert_eq!(emb.len() as i64, n * lenses::DIM as i64 * 2, "frames of {}", &id[..8.min(id.len())]);
                conn.execute("INSERT OR REPLACE INTO clip_frames (id, model, n, emb) VALUES (?1, ?2, ?3, ?4)",
                    params![id, crate::clip::FRAMES_TAG, n, emb]).unwrap();
            }
            println!("frames loaded for {} videos", items.len());
        }
        let long = clear_untaggable_videos(&conn).unwrap();
        let cat = Catalogue::load(&conn);
        let sig = signature(&cat);
        let ids = stale_ids(&conn, &sig).unwrap();
        let mut written = 0;
        for c in ids.chunks(CHUNK) { written += score_chunk(&conn, &cat, c).unwrap().len(); }
        let status = status_with(&conn, &cat, &VideosNotNow::default()).unwrap();
        println!("installed {:?}, unchanged {:?}; upgrade: {}", report.installed, report.unchanged,
            match upgrade { Upgrade::Done { tags, links, .. } => format!("removed {tags} suggestion tags ({links} links)"), u => format!("{u:?}") });
        println!("sig {sig}; scored {written} of {} stale; long videos cleared {}; status total {} scored {} waiting_videos {} per_lens {:?}",
            ids.len(), long.len(), status.total, status.scored, status.waiting_videos, status.per_lens);
        assert_eq!(written, ids.len());
        if let Ok(out) = std::env::var("QOOTI_DUMP") {
            // For the parity checks (PORT-PLAN §5.3): the stored maps and each item's media, the tag
            // ids (collection hints), the list JSON the page gets and the status.
            let mut dump = serde_json::Map::new();
            let mut kinds = serde_json::Map::new();
            let mut stmt = conn.prepare("SELECT id, lens_suggestions, type FROM inspirations WHERE auto_tag_sig = ?1").unwrap();
            for row in stmt.query_map([&sig], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?))).unwrap() {
                let (id, conf, kind) = row.unwrap();
                kinds.insert(id.clone(), serde_json::json!(if kind == "video" { "video" } else { "picture" }));
                dump.insert(id, conf.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_else(|| serde_json::json!({})));
            }
            let tag_ids = rows(&conn, "SELECT id FROM tags ORDER BY id");
            let lists = serde_json::json!({
                "lenses": lenses::list_lenses_with(&conn, &cat).unwrap(),
                "concepts": lenses::list_concepts_with(&conn, &cat).unwrap(),
            });
            std::fs::write(out, serde_json::to_vec(&serde_json::json!({
                "sig": sig, "items": dump, "kinds": kinds, "tag_ids": tag_ids, "lists": lists, "status": status,
            })).unwrap()).unwrap();
        }
    }
}
