// On-device recommendations: a taste-aware home feed and the "More to explore" shelves.
//
// Taste = the CLIP image embeddings (clip.rs) of what the user has recently opened,
// saved, added to collections or enhanced, weighted by recency. Everything is local.
//
// Home feed ("qootify"): still a fresh shuffle on every launch — the user asked for that
// — but a *weighted* one. Items that look like current interests, new saves and
// long-forgotten items come up more often, and near-identical images are kept apart so
// the feed stays varied. The shuffle is keyed by a per-launch seed, so the order is
// stable within a session (an import or delete no longer reshuffles the grid).
//
// Shelves: "Because you opened …" (visual matches for the last one or two opened items —
// appearance only, the same rule as Find similar) and "Forgotten gems" (saved a while
// ago, not opened since, matching current taste). Recommendations only ever come from
// the ids the caller passes in, i.e. what the user can already see (free-plan pool).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use crate::{AppState, clip};

const DAY_MS: i64 = 86_400_000;
const HALF_LIFE_DAYS: f64 = 14.0;        // a signal from two weeks ago counts half
const MAX_ANCHORS: usize = 24;

// Feed weights (every item keeps a base weight of 1, so nothing is ever hidden).
const W_TASTE: f32 = 2.0;                // looks like what you've been into lately
const W_FRESH: f32 = 0.8;                // saved in the last week
const W_FORGOTTEN: f32 = 0.6;            // saved 30+ days ago, not opened for 60+ days
const SPREAD_WINDOW: usize = 8;          // ~ a row or two of the masonry
const SPREAD_MAX_COS: f32 = 0.92;        // closer than this = near-duplicate → keep apart
const SPREAD_HEAD: usize = 600;          // only the part of the feed people actually scroll through
const SPREAD_QUEUE: usize = 32;          // max items held back at once

// Shelves (same visual-similarity rule as Find similar).
const SHELF_FLOOR: f32 = 0.55;
const SHELF_Z: f32 = 1.6;
const SHELF_DUPLICATE: f32 = 0.97;       // the same picture again isn't a recommendation
const SHELF_SIZE: usize = 12;

#[derive(Clone)]
pub struct Anchor { pub id: String, pub emb: Vec<f32>, pub weight: f32 }

pub struct Candidate {
    pub id: String,
    pub emb: Option<Vec<f32>>,
    pub created_at: i64,
    pub last_viewed_at: Option<i64>,
}

fn dot(a: &[f32], b: &[f32]) -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() }

fn decay(now: i64, t: i64) -> f64 {
    let days = (now - t).max(0) as f64 / DAY_MS as f64;
    0.5f64.powf(days / HALF_LIFE_DAYS)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Per-launch random seed: a new shuffle every time the app opens, the same one within it.
fn session_seed() -> u64 {
    static SEED: OnceLock<u64> = OnceLock::new();
    *SEED.get_or_init(|| {
        let b = *uuid::Uuid::new_v4().as_bytes();
        u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
    })
}

/// Deterministic uniform (0, 1) for (seed, id).
fn unit_rand(seed: u64, id: &str) -> f64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;                       // FNV-1a
    for b in id.bytes() { h ^= b as u64; h = h.wrapping_mul(0x0100_0000_01b3); }
    let mut z = seed ^ h;                                        // splitmix64 finaliser
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^= z >> 31;
    (((z >> 11) as f64) / (1u64 << 53) as f64).clamp(1e-12, 1.0 - 1e-12)
}

/// The user's current interests: recently opened, saved, collected and enhanced items,
/// each weighted by recency, strongest `MAX_ANCHORS` that have an embedding.
pub fn build_anchors(db: &Connection, now: i64) -> Vec<Anchor> {
    let mut w: HashMap<String, f64> = HashMap::new();
    let mut add = |sql: &str, f: &dyn Fn(i64, i64) -> f64| {
        if let Ok(mut stmt) = db.prepare(sql) {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))) {
                for (id, t, n) in rows.flatten() { *w.entry(id).or_default() += f(t, n); }
            }
        }
    };
    // Opened in the detail view — the most direct signal; repeat opens count a bit more.
    add("SELECT id, last_viewed_at, COALESCE(view_count, 0) FROM inspirations
         WHERE last_viewed_at IS NOT NULL ORDER BY last_viewed_at DESC LIMIT 60",
        &|t, n| 1.0 * decay(now, t) * (1.0 + 0.5 * (1.0 + n as f64).ln()));
    // Saved recently.
    add("SELECT id, created_at, 0 FROM inspirations ORDER BY created_at DESC LIMIT 60",
        &|t, _| 0.7 * decay(now, t));
    // Added to a collection.
    add("SELECT inspiration_id, MAX(created_at), 0 FROM collection_items
         GROUP BY inspiration_id ORDER BY 2 DESC LIMIT 60",
        &|t, _| 1.0 * decay(now, t));
    // Enhanced — cared enough to upscale it.
    add("SELECT id, updated_at, 0 FROM inspirations WHERE enhanced_path IS NOT NULL
         ORDER BY updated_at DESC LIMIT 30",
        &|t, _| 0.5 * decay(now, t));

    let mut ranked: Vec<(String, f64)> = w.into_iter().filter(|(_, v)| *v > 1e-4).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));

    let mut out = Vec::new();
    let Ok(mut stmt) = db.prepare("SELECT emb FROM clip_embeddings WHERE id = ?1 AND model = ?2") else { return out };
    for (id, weight) in ranked {
        if out.len() >= MAX_ANCHORS { break; }
        let emb: Option<Vec<u8>> = stmt.query_row(params![id, clip::MODEL_TAG], |r| r.get(0)).ok();
        if let Some(v) = emb.as_deref().and_then(clip::from_blob) {
            out.push(Anchor { id, emb: v, weight: weight as f32 });
        }
    }
    out
}

/// Pool rows (only the given ids) with their embedding, if indexed.
pub fn load_candidates(db: &Connection, ids: &[String]) -> Vec<Candidate> {
    let want: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    let mut by_id: HashMap<String, Candidate> = HashMap::new();
    if let Ok(mut stmt) = db.prepare(
        "SELECT i.id, i.created_at, i.last_viewed_at, e.emb FROM inspirations i
         LEFT JOIN clip_embeddings e ON e.id = i.id AND e.model = ?1"
    ) {
        if let Ok(rows) = stmt.query_map([clip::MODEL_TAG], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, Option<Vec<u8>>>(3)?,
        ))) {
            for (id, created_at, last_viewed_at, emb) in rows.flatten() {
                if !want.contains(id.as_str()) { continue; }
                let emb = emb.as_deref().and_then(clip::from_blob);
                by_id.insert(id.clone(), Candidate { id, emb, created_at, last_viewed_at });
            }
        }
    }
    // Keep the caller's order (unknown ids are dropped).
    ids.iter().filter_map(|id| by_id.remove(id)).collect()
}

/// How strongly an item matches the user's interests: its best match among the anchors
/// (so several interests coexist instead of averaging into mush), nudged by anchor weight.
fn affinity(emb: &[f32], anchors: &[Anchor], self_id: &str) -> Option<f32> {
    let wmax = anchors.iter().map(|a| a.weight).fold(0.0f32, f32::max).max(1e-6);
    anchors.iter().filter(|a| a.id != self_id)
        .map(|a| dot(emb, &a.emb) * (0.85 + 0.15 * a.weight / wmax))
        .reduce(f32::max)
}

fn is_forgotten(c: &Candidate, now: i64) -> bool {
    now - c.created_at > 30 * DAY_MS && c.last_viewed_at.map_or(true, |t| now - t > 60 * DAY_MS)
}

/// Taste score per candidate, 0..1 (z-score of affinity within the pool, clipped to 0..3σ).
fn taste_scores(cands: &[Candidate], anchors: &[Anchor]) -> Vec<f32> {
    let aff: Vec<Option<f32>> = cands.iter()
        .map(|c| c.emb.as_deref().and_then(|e| affinity(e, anchors, &c.id)))
        .collect();
    let vals: Vec<f32> = aff.iter().flatten().copied().collect();
    if vals.len() < 2 { return vec![0.0; cands.len()]; }
    let n = vals.len() as f32;
    let mean = vals.iter().sum::<f32>() / n;
    let sd = (vals.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n).sqrt().max(1e-6);
    aff.iter().map(|a| a.map_or(0.0, |v| ((v - mean) / sd).clamp(0.0, 3.0) / 3.0)).collect()
}

/// Sampling weight per candidate (≥ 1, so every item can still appear).
pub fn feed_weights(cands: &[Candidate], anchors: &[Anchor], now: i64) -> Vec<f32> {
    let taste = taste_scores(cands, anchors);
    cands.iter().zip(taste).map(|(c, t)| {
        let age_days = (now - c.created_at).max(0) as f32 / DAY_MS as f32;
        let fresh = (1.0 - age_days / 7.0).max(0.0);
        let forgotten = if is_forgotten(c, now) { 1.0 } else { 0.0 };
        1.0 + W_TASTE * t + W_FRESH * fresh + W_FORGOTTEN * forgotten
    }).collect()
}

/// Weighted shuffle (Efraimidis–Spirakis: key = ln(u) / w, larger first) keyed by `seed`,
/// then look-alikes spread apart. Returns indices into `cands`.
pub fn order_feed(cands: &[Candidate], weights: &[f32], seed: u64) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..cands.len()).collect();
    let keys: Vec<f64> = cands.iter().zip(weights)
        .map(|(c, w)| unit_rand(seed, &c.id).ln() / (*w as f64).max(1e-6))
        .collect();
    idx.sort_by(|&a, &b| keys[b].total_cmp(&keys[a]));
    spread_lookalikes(idx, cands)
}

/// Keep near-identical images out of the same stretch of the feed: an item that is a
/// near-duplicate of one of the last `SPREAD_WINDOW` placed items waits (in order) until
/// it no longer clashes. Items without an embedding never clash. Only the first
/// `SPREAD_HEAD` positions are spread (bounded work on huge libraries); the rest keeps
/// the shuffled order.
fn spread_lookalikes(order: Vec<usize>, cands: &[Candidate]) -> Vec<usize> {
    let clashes = |i: usize, out: &[usize]| -> bool {
        let Some(e) = cands[i].emb.as_deref() else { return false };
        out.iter().rev().take(SPREAD_WINDOW)
            .any(|&j| cands[j].emb.as_deref().is_some_and(|f| dot(e, f) > SPREAD_MAX_COS))
    };
    let mut out: Vec<usize> = Vec::with_capacity(order.len());
    let mut waiting: VecDeque<usize> = VecDeque::new();
    let mut rest = order.into_iter();
    for i in rest.by_ref() {
        if let Some(p) = waiting.iter().position(|&d| !clashes(d, &out)) {
            out.push(waiting.remove(p).unwrap());
        }
        if clashes(i, &out) && waiting.len() < SPREAD_QUEUE { waiting.push_back(i); } else { out.push(i); }
        if out.len() >= SPREAD_HEAD { break; }
    }
    // Still waiting at the end: insert each at the earliest spot with no look-alike within
    // the window on either side (appending would just stack them together at the bottom).
    let fits_at = |i: usize, out: &[usize], at: usize| -> bool {
        let Some(e) = cands[i].emb.as_deref() else { return true };
        let lo = at.saturating_sub(SPREAD_WINDOW);
        let hi = (at + SPREAD_WINDOW).min(out.len());
        !out[lo..hi].iter().any(|&j| cands[j].emb.as_deref().is_some_and(|f| dot(e, f) > SPREAD_MAX_COS))
    };
    while let Some(d) = waiting.pop_front() {
        match (0..=out.len()).find(|&at| fits_at(d, &out, at)) {
            Some(at) => out.insert(at, d),
            None => out.push(d),
        }
    }
    out.extend(rest);
    out
}

/// "Because you opened …": the pool items that look like `pivot` (same relative rule as
/// Find similar), best first, excluding exact duplicates and `skip`.
fn shelf_like(pivot: &[f32], pivot_id: &str, cands: &[Candidate], skip: &HashSet<String>) -> Vec<usize> {
    let scored: Vec<(usize, f32)> = cands.iter().enumerate()
        .filter(|(_, c)| c.id != pivot_id)
        .filter_map(|(i, c)| c.emb.as_deref().map(|e| (i, dot(pivot, e))))
        .collect();
    if scored.len() < 8 { return vec![]; }
    let n = scored.len() as f32;
    let mean = scored.iter().map(|s| s.1).sum::<f32>() / n;
    let sd = (scored.iter().map(|s| (s.1 - mean).powi(2)).sum::<f32>() / n).sqrt().max(1e-6);
    let mut keep: Vec<(usize, f32)> = scored.into_iter()
        .filter(|(i, c)| *c >= SHELF_FLOOR && *c < SHELF_DUPLICATE && (c - mean) / sd >= SHELF_Z && !skip.contains(&cands[*i].id))
        .collect();
    keep.sort_by(|a, b| b.1.total_cmp(&a.1));
    keep.into_iter().take(SHELF_SIZE).map(|(i, _)| i).collect()
}

/// Shelf descriptors: (kind, pivot id, item ids).
pub fn explore(db: &Connection, cands: &[Candidate], anchors: &[Anchor], now: i64) -> Vec<(String, Option<String>, Vec<String>)> {
    let mut out = Vec::new();
    let pos: HashMap<&str, usize> = cands.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect();
    let mut used: HashSet<String> = HashSet::new();

    // 1) Because you opened — the last one or two opened items that are in the pool, have
    //    an embedding, and aren't look-alikes of each other.
    let recent: Vec<String> = db.prepare(
        "SELECT id FROM inspirations WHERE last_viewed_at IS NOT NULL ORDER BY last_viewed_at DESC LIMIT 20"
    ).and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0)).map(|r| r.flatten().collect())).unwrap_or_default();
    let mut pivots: Vec<usize> = Vec::new();
    for id in recent {
        if pivots.len() >= 2 { break; }
        let Some(&i) = pos.get(id.as_str()) else { continue };
        let Some(e) = cands[i].emb.as_deref() else { continue };
        if pivots.iter().any(|&p| cands[p].emb.as_deref().is_some_and(|f| dot(e, f) > 0.85)) { continue; }
        pivots.push(i);
    }
    for p in pivots {
        let pe = cands[p].emb.clone().unwrap_or_default();
        let items = shelf_like(&pe, &cands[p].id, cands, &used);
        if items.len() >= 3 {
            let ids: Vec<String> = items.iter().map(|&i| cands[i].id.clone()).collect();
            used.extend(ids.iter().cloned());
            used.insert(cands[p].id.clone());
            out.push(("because".to_string(), Some(cands[p].id.clone()), ids));
        }
    }

    // 2) Forgotten gems — saved a while ago, not opened since; the ones that match current
    //    taste first (random order if there's no taste signal yet).
    let taste = taste_scores(cands, anchors);
    let seed = session_seed();
    let mut gems: Vec<(usize, f64)> = cands.iter().enumerate()
        .filter(|(_, c)| is_forgotten(c, now) && !used.contains(&c.id))
        .map(|(i, c)| (i, taste[i] as f64 + 0.15 * unit_rand(seed ^ 0x5eed, &c.id)))
        .collect();
    gems.sort_by(|a, b| b.1.total_cmp(&a.1));
    if gems.len() >= 4 {
        out.push(("forgotten".to_string(), None,
            gems.into_iter().take(SHELF_SIZE).map(|(i, _)| cands[i].id.clone()).collect()));
    }
    out
}

// ── Session cache of the feed's taste profile ────────────────────────────────────
// Computed on the first feed request of a launch (and retried until the library has
// embeddings), then reused — so the feed order stays stable for the whole session.
static FEED_ANCHORS: OnceLock<Mutex<Option<Vec<Anchor>>>> = OnceLock::new();

fn feed_anchors(db: &Connection, now: i64) -> Vec<Anchor> {
    let cell = FEED_ANCHORS.get_or_init(|| Mutex::new(None));
    let mut g = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(a) = g.as_ref() { return a.clone(); }
    let a = build_anchors(db, now);
    if a.len() >= 3 { *g = Some(a.clone()); }
    a
}

/// Home feed order for the given ids (the grid passes what it's about to show).
#[tauri::command]
pub async fn taste_order(app: AppHandle, ids: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now = now_ms();
        let state = app.state::<AppState>();
        let (cands, anchors) = {
            let db = state.db.lock().map_err(|_| "db lock".to_string())?;
            (load_candidates(&db, &ids), feed_anchors(&db, now))
        };
        let t0 = std::time::Instant::now();
        let weights = feed_weights(&cands, &anchors, now);
        let order = order_feed(&cands, &weights, session_seed());
        log::info!(target: "Reco", "taste_order items={} anchors={} in {:?}", cands.len(), anchors.len(), t0.elapsed());
        Ok(order.into_iter().map(|i| cands[i].id.clone()).collect())
    }).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct RecoSection {
    kind: String,                                   // "because" | "forgotten"
    pivot: Option<crate::commands::Inspiration>,    // the item "because you opened"
    items: Vec<crate::commands::Inspiration>,
}

/// "More to explore" shelves, built only from the given (visible) ids.
#[tauri::command]
pub async fn more_to_explore(app: AppHandle, ids: Vec<String>) -> Result<Vec<RecoSection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now = now_ms();
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|_| "db lock".to_string())?;
        let cands = load_candidates(&db, &ids);
        let anchors = build_anchors(&db, now);   // live: reflects what was opened this session
        let shelves = explore(&db, &cands, &anchors, now);
        let mut want: Vec<String> = Vec::new();
        for (_, p, items) in &shelves { want.extend(p.iter().cloned()); want.extend(items.iter().cloned()); }
        let mut rows = crate::commands::inspirations_by_ids(&db, &want);
        let sections: Vec<RecoSection> = shelves.into_iter().map(|(kind, p, items)| RecoSection {
            kind,
            pivot: p.and_then(|id| rows.get(&id).cloned()),
            items: items.iter().filter_map(|id| rows.remove(id)).collect(),
        }).collect();
        log::info!(target: "Reco", "more_to_explore pool={} sections={}", cands.len(), sections.len());
        Ok(sections)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: &[f32]) -> Vec<f32> { let n = dot(v, v).sqrt(); v.iter().map(|x| x / n).collect() }
    fn cand(id: &str, emb: Option<Vec<f32>>, age_days: i64, viewed_days_ago: Option<i64>, now: i64) -> Candidate {
        Candidate { id: id.into(), emb, created_at: now - age_days * DAY_MS, last_viewed_at: viewed_days_ago.map(|d| now - d * DAY_MS) }
    }

    #[test]
    fn unit_rand_is_deterministic_and_in_range() {
        assert_eq!(unit_rand(7, "abc"), unit_rand(7, "abc"));
        assert_ne!(unit_rand(7, "abc"), unit_rand(8, "abc"));
        for k in 0..1000 { let u = unit_rand(k, "x"); assert!(u > 0.0 && u < 1.0); }
    }

    #[test]
    fn decay_halves_every_half_life() {
        let now = 1_000 * DAY_MS;
        assert!((decay(now, now) - 1.0).abs() < 1e-9);
        assert!((decay(now, now - 14 * DAY_MS) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn heavier_items_lead_more_often() {
        let now = 1_000 * DAY_MS;
        let cands: Vec<Candidate> = (0..20).map(|i| cand(&format!("i{i}"), None, 10, Some(1), now)).collect();
        let mut w = vec![1.0f32; 20];
        w[5] = 3.0;
        let mut top5 = 0;
        for seed in 0..2000u64 {
            let o = order_feed(&cands, &w, seed);
            if o.iter().position(|&i| i == 5).unwrap() < 5 { top5 += 1; }
        }
        // Uniform would put it in the top 5 a quarter of the time; weight 3 makes it far likelier.
        assert!(top5 > 900, "top5={top5}");
    }

    #[test]
    fn lookalikes_are_spread_apart() {
        let now = 1_000 * DAY_MS;
        // Three identical images first, then 30 distinct ones (one-hot in 40 dims).
        let onehot = |k: usize| { let mut v = vec![0.0f32; 40]; v[k] = 1.0; v };
        let mut cands: Vec<Candidate> = (0..3).map(|k| cand(&format!("a{k}"), Some(onehot(0)), 10, None, now)).collect();
        for k in 0..30 { cands.push(cand(&format!("o{k}"), Some(onehot(k + 1)), 10, None, now)); }
        let spread = spread_lookalikes((0..cands.len()).collect(), &cands);
        let mut pos: Vec<usize> = ["a0", "a1", "a2"].iter().map(|n| spread.iter().position(|&i| cands[i].id == *n).unwrap()).collect();
        pos.sort();
        assert!(pos[1] - pos[0] >= SPREAD_WINDOW && pos[2] - pos[1] >= SPREAD_WINDOW, "{pos:?}");
        assert_eq!(spread.len(), cands.len());
        // Even when there's no room to separate them fully, nothing is lost.
        let tight: Vec<Candidate> = (0..5).map(|k| cand(&format!("t{k}"), Some(onehot(0)), 10, None, now)).collect();
        assert_eq!(spread_lookalikes((0..5).collect(), &tight).len(), 5);
    }

    #[test]
    fn taste_boosts_matching_items_and_fresh_and_forgotten() {
        let now = 1_000 * DAY_MS;
        let liked = unit(&[1.0, 0.1, 0.0]);
        let anchors = vec![Anchor { id: "anchor".into(), emb: liked.clone(), weight: 1.0 }];
        let mut cands = vec![
            cand("match", Some(unit(&[1.0, 0.0, 0.0])), 20, Some(1), now),
            cand("fresh", Some(unit(&[0.0, 1.0, 0.0])), 1, Some(1), now),
            cand("forgotten", Some(unit(&[0.0, 0.0, 1.0])), 200, None, now),
        ];
        for k in 0..6 { cands.push(cand(&format!("other{k}"), Some(unit(&[0.0, 0.5, 0.5 + k as f32 * 0.1])), 20, Some(1), now)); }
        let w = feed_weights(&cands, &anchors, now);
        let other = w[3];
        assert!(w[0] > other + 1.0, "taste {w:?}");
        assert!(w[1] > other + 0.5, "fresh {w:?}");
        assert!(w[2] > other + 0.4, "forgotten {w:?}");
    }

    #[test]
    fn large_library_with_many_duplicates_stays_bounded() {
        let now = 1_000 * DAY_MS;
        // 20k items in 64 dims; every third one is a copy of the same picture.
        let onehot = |k: usize| { let mut v = vec![0.0f32; 64]; v[k % 64] = 1.0; v };
        let cands: Vec<Candidate> = (0..20_000).map(|k| {
            let emb = if k % 3 == 0 { onehot(0) } else { unit(&(0..64).map(|d| ((k * 31 + d * 17) % 97) as f32 + 1.0).collect::<Vec<_>>()) };
            cand(&format!("i{k}"), Some(emb), 10, None, now)
        }).collect();
        let anchors = vec![Anchor { id: "a".into(), emb: onehot(5), weight: 1.0 }];
        let t = std::time::Instant::now();
        let w = feed_weights(&cands, &anchors, now);
        let o = order_feed(&cands, &w, 1);
        eprintln!("20k items ordered in {:?}", t.elapsed());
        assert_eq!(o.len(), cands.len());
        let mut seen = vec![false; cands.len()];
        for &i in &o { assert!(!seen[i]); seen[i] = true; }
    }

    /// Offline evaluation on a real library: writes the anchors, the first 60 feed items
    /// and the shelves to $QOOTI_RECO_OUT (JSON) for contact-sheet review.
    /// QOOTI_DB=<qooti.db> QOOTI_RECO_OUT=<file> cargo test reco::tests::dump_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn dump_real() {
        let db = Connection::open_with_flags(std::env::var("QOOTI_DB").unwrap(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let now = now_ms();
        let ids: Vec<String> = db.prepare("SELECT id FROM inspirations").unwrap()
            .query_map([], |r| r.get(0)).unwrap().flatten().collect();
        let cands = load_candidates(&db, &ids);
        let anchors = build_anchors(&db, now);
        let w = feed_weights(&cands, &anchors, now);
        let order = order_feed(&cands, &w, 42);
        let shelves = explore(&db, &cands, &anchors, now);
        let j = serde_json::json!({
            "anchors": anchors.iter().map(|a| serde_json::json!({"id": a.id, "w": a.weight})).collect::<Vec<_>>(),
            "feed": order.iter().take(60).map(|&i| serde_json::json!({"id": cands[i].id, "w": w[i]})).collect::<Vec<_>>(),
            "shelves": shelves.iter().map(|(k, p, items)| serde_json::json!({"kind": k, "pivot": p, "items": items})).collect::<Vec<_>>(),
        });
        std::fs::write(std::env::var("QOOTI_RECO_OUT").unwrap(), serde_json::to_string_pretty(&j).unwrap()).unwrap();
        println!("pool={} anchors={} shelves={}", cands.len(), anchors.len(), shelves.len());
    }
}
