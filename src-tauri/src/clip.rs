// "Find similar" — visual-similarity embeddings from the CLIP ViT-B/32 image encoder.
//
// The fingerprint ranking (dHash + 16×16 grayscale, still used by the Duplicates view)
// detects near-duplicates: it measures where an image is light or dark, not what it
// shows, and ignores colour — so any picture with a similar light/dark layout came back
// as "similar". CLIP maps an image's content and style to 512 numbers; the cosine
// between two embeddings is what "looks alike" should mean. Evaluated on a real
// 359-item library before shipping (arch §53): e.g. an engraved banknote portrait now
// returns banknote portraits instead of a price tag, a traffic cone and UI mockups.
//
// Model: Xenova/clip-vit-base-patch32 `onnx/vision_model_quantized.onnx` (q8, 89 MB),
// run natively on the statically-linked onnxruntime (like enhancer.rs), CPU only — its
// dynamic-quantisation ops don't suit DirectML/CoreML. Downloaded once into app-data
// (SHA-256 pinned); a background indexer then embeds the library a few images at a
// time. Embeddings live in their own table, created with IF NOT EXISTS, so this needs
// no SCHEMA_VERSION bump.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use once_cell::sync::OnceCell;
use rusqlite::params;
use tauri::{AppHandle, Manager};
use crate::AppState;

/// Stored with each embedding; a different model later simply re-indexes.
pub const MODEL_TAG: &str = "clip-b32-q8";
const FAILED_TAG: &str = "failed";   // item couldn't be decoded — don't retry every cycle
const MODEL_FILE: &str = "clip-vit-base-patch32-vision-q8.onnx";
const MODEL_SHA256: &str = "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299";
const MODEL_SOURCES: [&str; 2] = [
    "https://api.bloot.app/download/clip-vit-base-patch32-vision-q8.onnx",   // R2 mirror (optional)
    "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx",
];

pub const DIM: usize = 512;
const SIZE: u32 = 224;
const MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const STD:  [f32; 3] = [0.268_629_54, 0.261_302_6, 0.275_777_1];

// Ranking. How similar two images "look" is judged relative to the focus image's own
// background: z = (cosine − mean) / std over the whole library. Absolute cosines drift
// by image type — dark UI screenshots all sit ~0.75 from each other — so a fixed cut-off
// either floods dense clusters or starves sparse ones. Calibrated on a real 359-item
// library (arch §53): z ≥ 2.0 was consistently a genuine match, 1.6–2.0 loosely related.
// Median result per image: ~4 strong + ~11 related (instead of 60 mostly-unrelated tiles).
const Z_STRONG: f32 = 2.0;         // tier 0 — shown at full strength
const Z_RELATED: f32 = 1.6;        // tier 1 — shown dimmed; below this: not shown
const FLOOR: f32 = 0.55;           // never show anything under this cosine (unrelated ≈ 0.51)
const MIN_FOR_Z: usize = 30;       // tiny libraries: too few items for a stable mean/std…
const ABS_STRONG: f32 = 0.70;      // …so use fixed cut-offs instead
const ABS_RELATED: f32 = 0.60;
const COLOUR_WEIGHT: f32 = 0.15;   // palette similarity nudges the order toward the same mood
const TAG_BOOST: f32 = 0.03;       // per tag the user shares between the two items…
const TAG_BOOST_MAX: f32 = 0.06;   // …capped, so tags only break near-ties

static SESSION: OnceCell<Mutex<ort::session::Session>> = OnceCell::new();
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

pub fn ensure_table(db: &rusqlite::Connection) {
    let _ = db.execute_batch(
        "CREATE TABLE IF NOT EXISTS clip_embeddings (
             id    TEXT PRIMARY KEY,
             model TEXT NOT NULL,
             emb   BLOB NOT NULL
         );",
    );
}

fn model_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("models").join(MODEL_FILE))
}

pub fn model_ready(app: &AppHandle) -> bool {
    model_path(app).is_some_and(|p| p.exists())
}

/// Download (once) and verify the model. Blocking; serialised.
pub fn ensure_model(app: &AppHandle) -> Result<PathBuf, String> {
    let path = model_path(app).ok_or("no app_data_dir")?;
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if path.exists() { return Ok(path); }
    let dir = path.parent().ok_or("bad path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let part = path.with_extension("part");
    let mut last_err = String::from("no source");
    for url in MODEL_SOURCES {
        log::info!(target: "Clip", "downloading model from {url}");
        match crate::js_runtime::fetch_verified(url, &part, MODEL_SHA256, &|_| {}) {
            Ok(bytes) => {
                std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
                log::info!(target: "Clip", "model ready ({} MB)", bytes / 1_048_576);
                return Ok(path);
            }
            Err(e) => { log::info!(target: "Clip", "source failed: {e}"); last_err = e; }
        }
    }
    let _ = std::fs::remove_file(&part);
    Err(last_err)
}

fn build_session(path: &Path) -> Result<ort::session::Session, String> {
    use ort::session::{Session, builder::GraphOptimizationLevel};
    use ort::execution_providers::CPUExecutionProvider;
    Session::builder().map_err(|e| e.to_string())?
        .with_execution_providers([CPUExecutionProvider::default().build()]).map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| e.to_string())?
        .with_intra_threads(2).map_err(|e| e.to_string())?   // background work: leave cores for the UI
        .commit_from_file(path).map_err(|e| e.to_string())
}

fn session(app: &AppHandle) -> Result<&'static Mutex<ort::session::Session>, String> {
    SESSION.get_or_try_init(|| {
        let path = model_path(app).filter(|p| p.exists()).ok_or("model not downloaded")?;
        let s = build_session(&path)?;
        log::info!(target: "Clip", "onnxruntime session ready");
        Ok::<_, String>(Mutex::new(s))
    })
}

/// CLIP preprocessing: shortest side → 224 (bicubic), centre-crop 224×224, scale to
/// [0,1], normalise with CLIP's mean/std, channel-first. Matches the reference
/// (transformers.js CLIPFeatureExtractor) closely enough for ranking (cosine > 0.99).
fn preprocess(img: &image::DynamicImage) -> Vec<f32> {
    use image::imageops::FilterType;
    let (w, h) = (img.width().max(1), img.height().max(1));
    let scale = SIZE as f32 / w.min(h) as f32;
    let nw = ((w as f32 * scale).round() as u32).max(SIZE);
    let nh = ((h as f32 * scale).round() as u32).max(SIZE);
    // Big photos: a fast pre-shrink first so the bicubic pass stays cheap.
    let resized = if w.min(h) > SIZE * 4 {
        img.thumbnail(nw * 2, nh * 2).resize_exact(nw, nh, FilterType::CatmullRom)
    } else {
        img.resize_exact(nw, nh, FilterType::CatmullRom)
    }.to_rgb8();
    let (x0, y0) = ((nw - SIZE) / 2, (nh - SIZE) / 2);
    let plane = (SIZE * SIZE) as usize;
    let mut data = vec![0f32; 3 * plane];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let p = resized.get_pixel(x0 + x, y0 + y);
            let i = (y * SIZE + x) as usize;
            for c in 0..3 { data[c * plane + i] = (p[c] as f32 / 255.0 - MEAN[c]) / STD[c]; }
        }
    }
    data
}

fn embed_with(session: &mut ort::session::Session, path: &str) -> Result<Vec<f32>, String> {
    use ort::value::Tensor;
    let img = image::ImageReader::open(path).map_err(|e| e.to_string())?
        .with_guessed_format().map_err(|e| e.to_string())?
        .decode().map_err(|e| e.to_string())?;
    let input = Tensor::from_array((vec![1_i64, 3, SIZE as i64, SIZE as i64], preprocess(&img)))
        .map_err(|e| e.to_string())?;
    let outputs = session.run(ort::inputs!["pixel_values" => input]).map_err(|e| e.to_string())?;
    let (_shape, data) = outputs["image_embeds"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if data.len() != DIM { return Err(format!("unexpected embedding size {}", data.len())); }
    let mut v = data.to_vec();
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter_mut().for_each(|x| *x /= n);
    Ok(v)
}

/// L2-normalised CLIP embedding of an image file. Needs the model downloaded.
pub fn embed_file(app: &AppHandle, path: &str) -> Result<Vec<f32>, String> {
    let s = session(app)?;
    let mut s = s.lock().unwrap_or_else(|e| e.into_inner());
    embed_with(&mut s, path)
}

fn to_blob(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

fn from_blob(b: &[u8]) -> Option<Vec<f32>> {
    if b.len() != DIM * 4 { return None; }
    Some(b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

fn store(app: &AppHandle, id: &str, result: Result<Vec<f32>, String>) {
    let state = app.state::<AppState>();
    let Ok(db) = state.db.lock() else { return };
    let (model, blob) = match result {
        Ok(v) => (MODEL_TAG, to_blob(&v)),
        Err(e) => { log::debug!(target: "Clip", "embed failed id={id} err={e}"); (FAILED_TAG, Vec::new()) }
    };
    let _ = db.execute(
        "INSERT OR REPLACE INTO clip_embeddings (id, model, emb) VALUES (?1, ?2, ?3)",
        params![id, model, blob],
    );
}

/// Images/GIFs that don't have a current embedding yet (newest first).
fn pending(app: &AppHandle, n: i64) -> Vec<(String, String)> {
    let state = app.state::<AppState>();
    let Ok(db) = state.db.lock() else { return vec![] };
    let Ok(mut stmt) = db.prepare(
        "SELECT i.id, i.stored_path FROM inspirations i
         LEFT JOIN clip_embeddings e ON e.id = i.id AND e.model IN (?1, ?2)
         WHERE e.id IS NULL AND i.type IN ('image', 'gif')
         ORDER BY i.created_at DESC LIMIT ?3"
    ) else { return vec![] };
    stmt.query_map(params![MODEL_TAG, FAILED_TAG, n], |r| Ok((r.get(0)?, r.get(1)?)))
        .map(|it| it.flatten().collect())
        .unwrap_or_default()
}

/// Background indexer: downloads the model (once), then embeds un-indexed items a few
/// at a time, forever — new imports get picked up within ~30 s. Offline-safe: a failed
/// download is retried later; "Find similar" uses the fingerprint ranking meanwhile.
pub fn start_indexer(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(40));   // let boot work finish first
        let mut logged_done = false;
        loop {
            if !model_ready(&app) {
                if let Err(e) = ensure_model(&app) {
                    log::warn!(target: "Clip", "model unavailable: {e}");
                    std::thread::sleep(Duration::from_secs(30 * 60));
                    continue;
                }
            }
            let batch = pending(&app, 16);
            if batch.is_empty() {
                if !logged_done { log::info!(target: "Clip", "library indexed"); logged_done = true; }
                // Drop embeddings of deleted items, then idle until new ones arrive.
                if let Ok(db) = app.state::<AppState>().db.lock() {
                    let _ = db.execute("DELETE FROM clip_embeddings WHERE id NOT IN (SELECT id FROM inspirations)", []);
                }
                std::thread::sleep(Duration::from_secs(30));
                continue;
            }
            logged_done = false;
            let t0 = std::time::Instant::now();
            let n = batch.len();
            for (id, path) in batch {
                let r = embed_file(&app, &path);
                store(&app, &id, r);
                std::thread::sleep(Duration::from_millis(15));   // stay polite to the UI
            }
            log::debug!(target: "Clip", "indexed {n} in {} ms", t0.elapsed().as_millis());
        }
    });
}

// ── Ranking ───────────────────────────────────────────────────────────────────

fn hex_to_lab(h: &str) -> Option<[f32; 3]> {
    let h = h.trim().trim_start_matches('#');
    if h.len() != 6 { return None; }
    let c = |k: usize| u8::from_str_radix(&h[k..k + 2], 16).ok().map(|v| v as f32 / 255.0);
    let lin = |v: f32| if v > 0.04045 { ((v + 0.055) / 1.055).powf(2.4) } else { v / 12.92 };
    let (r, g, b) = (lin(c(0)?), lin(c(2)?), lin(c(4)?));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y =  0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    Some([116.0 * f(y) - 16.0, 500.0 * (f(x) - f(y)), 200.0 * (f(y) - f(z))])
}

fn palette_lab(json: Option<&str>) -> Vec<[f32; 3]> {
    json.and_then(|j| serde_json::from_str::<Vec<String>>(j).ok())
        .map(|v| v.iter().filter_map(|h| hex_to_lab(h)).collect())
        .unwrap_or_default()
}

/// 0..1 — how close two palettes are (symmetric mean nearest-colour ΔE; 0 at ΔE ≥ 50).
/// Unknown palettes are neutral (0.5).
fn colour_similarity(a: &[[f32; 3]], b: &[[f32; 3]]) -> f32 {
    if a.is_empty() || b.is_empty() { return 0.5; }
    let de = |p: &[f32; 3], q: &[f32; 3]| ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt();
    let nearest = |xs: &[[f32; 3]], ys: &[[f32; 3]]| -> f32 {
        xs.iter().map(|x| ys.iter().map(|y| de(x, y)).fold(f32::MAX, f32::min)).sum::<f32>() / xs.len() as f32
    };
    let d = (nearest(a, b) + nearest(b, a)) / 2.0;
    (1.0 - d / 50.0).clamp(0.0, 1.0)
}

/// Ranking score + tier for one candidate, or None if it isn't similar enough to show.
/// `z` is the candidate's standing against the focus's library-wide background (None for
/// tiny libraries → fixed cut-offs).
fn score_and_tier(cos: f32, z: Option<f32>, colour: f32, shared_tags: u32) -> Option<(f32, u8)> {
    if cos < FLOOR { return None; }
    let tier = match z {
        Some(z) if z >= Z_STRONG => 0,
        Some(z) if z >= Z_RELATED => 1,
        Some(_) => return None,
        None if cos >= ABS_STRONG => 0,
        None if cos >= ABS_RELATED => 1,
        None => return None,
    };
    let score = cos + COLOUR_WEIGHT * colour + (TAG_BOOST * shared_tags as f32).min(TAG_BOOST_MAX);
    Some((score, tier))
}

/// Rank items visually similar to `focus_id`: CLIP cosine + a colour-palette nudge + a
/// small shared-tag boost. Returns (id, tier) best-first — tier 0 clearly similar, tier 1
/// loosely related (the canvas dims those); weaker items aren't returned at all.
/// None when embeddings can't be used yet (model not downloaded, the focus can't be
/// embedded, or most of the library isn't indexed) — the caller then falls back to the
/// fingerprint ranking.
pub fn rank_similar(app: &AppHandle, focus_id: &str, limit: usize) -> Option<Vec<(String, u8)>> {
    let state = app.state::<AppState>();

    let (focus_path, focus_palette, focus_blob): (String, Option<String>, Option<Vec<u8>>) = {
        let db = state.db.lock().ok()?;
        db.query_row(
            "SELECT i.stored_path, i.palette, e.emb FROM inspirations i
             LEFT JOIN clip_embeddings e ON e.id = i.id AND e.model = ?2
             WHERE i.id = ?1 AND i.type IN ('image', 'gif')",
            params![focus_id, MODEL_TAG],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).ok()?
    };
    let focus = match focus_blob.as_deref().and_then(from_blob) {
        Some(v) => v,
        None => {
            // Not indexed yet (e.g. just imported): embed it now if the model is here.
            if !model_ready(app) { return None; }
            let v = embed_file(app, &focus_path).ok()?;
            store(app, focus_id, Ok(v.clone()));
            v
        }
    };

    let (cands, total): (Vec<(String, Option<String>, Vec<f32>)>, i64) = {
        let db = state.db.lock().ok()?;
        let total: i64 = db.query_row(
            "SELECT COUNT(*) FROM inspirations WHERE type IN ('image', 'gif')", [], |r| r.get(0),
        ).unwrap_or(0);
        let mut stmt = db.prepare(
            "SELECT i.id, i.palette, e.emb FROM inspirations i
             JOIN clip_embeddings e ON e.id = i.id AND e.model = ?2
             WHERE i.type IN ('image', 'gif') AND i.id != ?1"
        ).ok()?;
        let rows = stmt.query_map(params![focus_id, MODEL_TAG], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Vec<u8>>(2)?,
        ))).ok()?;
        let cands = rows.flatten().filter_map(|(id, pal, b)| from_blob(&b).map(|v| (id, pal, v))).collect();
        (cands, total)
    };
    // Still indexing a big library: a partial ranking would miss most matches.
    let embedded = cands.len() as i64 + 1;
    if embedded < 200 && (embedded as f64) < total as f64 * 0.6 {
        log::info!(target: "Clip", "rank_similar: index {embedded}/{total} — using fingerprints");
        return None;
    }

    let shared_tags: HashMap<String, u32> = {
        let db = state.db.lock().ok()?;
        let mut m = HashMap::new();
        if let Ok(mut stmt) = db.prepare(
            "SELECT it2.inspiration_id, COUNT(*) FROM inspiration_tags it1
             JOIN inspiration_tags it2 ON it1.tag_id = it2.tag_id
             WHERE it1.inspiration_id = ?1 AND it2.inspiration_id != ?1
             GROUP BY it2.inspiration_id"
        ) {
            if let Ok(it) = stmt.query_map([focus_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))) {
                for (cid, n) in it.flatten() { m.insert(cid, n); }
            }
        }
        m
    };

    // Cosine to every candidate, then the focus's background (mean/std) for z-scores.
    let coss: Vec<f32> = cands.iter()
        .map(|(_, _, v)| focus.iter().zip(v.iter()).map(|(a, b)| a * b).sum())
        .collect();
    let background = (coss.len() >= MIN_FOR_Z).then(|| {
        let n = coss.len() as f32;
        let mean = coss.iter().sum::<f32>() / n;
        let sd = (coss.iter().map(|c| (c - mean).powi(2)).sum::<f32>() / n).sqrt().max(1e-6);
        (mean, sd)
    });
    let focus_lab = palette_lab(focus_palette.as_deref());
    let mut scored: Vec<(u8, f32, String)> = cands.into_iter().zip(coss).filter_map(|((id, pal, _), cos)| {
        let z = background.map(|(mean, sd)| (cos - mean) / sd);
        let colour = colour_similarity(&focus_lab, &palette_lab(pal.as_deref()));
        let tags = shared_tags.get(&id).copied().unwrap_or(0);
        score_and_tier(cos, z, colour, tags).map(|(s, t)| (t, s, id))
    }).collect();
    // Clear matches first (best first), then the looser ones.
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.total_cmp(&a.1)));
    scored.truncate(limit);
    log::info!(target: "Clip", "rank_similar focus={focus_id} strong={} related={}",
        scored.iter().filter(|s| s.0 == 0).count(), scored.iter().filter(|s| s.0 == 1).count());
    Some(scored.into_iter().map(|(t, _, id)| (id, t)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_round_trip() {
        let v: Vec<f32> = (0..DIM).map(|i| i as f32 / DIM as f32).collect();
        assert_eq!(from_blob(&to_blob(&v)).unwrap(), v);
        assert!(from_blob(&[0u8; 12]).is_none());
    }

    #[test]
    fn colour_similarity_behaves() {
        let red = palette_lab(Some(r##"["#ff0000","#cc0000"]"##));
        let red2 = palette_lab(Some(r##"["#ee1111","#bb0000"]"##));
        let blue = palette_lab(Some(r##"["#0000ff","#000088"]"##));
        assert!((colour_similarity(&red, &red) - 1.0).abs() < 1e-4);
        assert!(colour_similarity(&red, &red2) > 0.8);
        assert!(colour_similarity(&red, &blue) < 0.1);
        assert_eq!(colour_similarity(&red, &[]), 0.5);
    }

    #[test]
    fn tiers_and_cutoff() {
        // Relative tiers.
        assert_eq!(score_and_tier(0.70, Some(2.4), 0.5, 0).map(|s| s.1), Some(0));
        assert_eq!(score_and_tier(0.70, Some(1.8), 0.5, 0).map(|s| s.1), Some(1));
        assert_eq!(score_and_tier(0.70, Some(1.2), 1.0, 5), None);   // unremarkable for this focus
        assert_eq!(score_and_tier(0.54, Some(3.0), 1.0, 5), None);   // under the absolute floor
        // Tiny libraries: fixed cut-offs.
        assert_eq!(score_and_tier(0.72, None, 0.5, 0).map(|s| s.1), Some(0));
        assert_eq!(score_and_tier(0.62, None, 0.5, 0).map(|s| s.1), Some(1));
        assert_eq!(score_and_tier(0.58, None, 0.5, 0), None);
        // Tag boost is capped.
        let (a, _) = score_and_tier(0.7, Some(2.5), 0.0, 2).unwrap();
        let (b, _) = score_and_tier(0.7, Some(2.5), 0.0, 9).unwrap();
        assert!((a - b).abs() < 1e-6);
    }

    /// Fidelity check against a canonical CLIP reference: PIL anti-aliased bicubic
    /// preprocessing (what CLIP was trained with) → the same ONNX model via onnxruntime.
    /// (transformers.js is NOT a valid reference: in Node its "bicubic" is an un-antialiased
    /// affine resample, ~0.07 mean pixel error vs PIL; this pipeline is ~0.002.)
    /// Run with: QOOTI_CLIP_MODEL=<onnx> QOOTI_CLIP_REF=<dir with items.json + reference.json>
    ///           cargo test clip::tests::matches_reference -- --ignored --nocapture
    #[test]
    #[ignore]
    fn matches_reference() {
        let model = std::env::var("QOOTI_CLIP_MODEL").expect("QOOTI_CLIP_MODEL");
        let dir = std::env::var("QOOTI_CLIP_REF").expect("QOOTI_CLIP_REF");
        let items: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/items.json")).unwrap()).unwrap();
        let refs: HashMap<String, Vec<f32>> = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/reference.json")).unwrap()).unwrap();
        let mut s = build_session(Path::new(&model)).unwrap();
        let (mut n, mut worst, mut sum) = (0, 1.0f32, 0.0f32);
        for it in &items {
            let id = it["id"].as_str().unwrap();
            let Some(r) = refs.get(id) else { continue };
            let v = embed_with(&mut s, it["path"].as_str().unwrap()).unwrap();
            let cos: f32 = v.iter().zip(r.iter()).map(|(a, b)| a * b).sum();
            worst = worst.min(cos); sum += cos; n += 1;
        }
        println!("compared {n}: mean cosine {:.4}, worst {:.4}", sum / n as f32, worst);
        // Measured: mean 0.986, worst 0.974. The residual is the q8 model's dynamic
        // activation quantisation differing across onnxruntime builds (input tensors match
        // PIL to ~0.002); a preprocessing bug shows up as 0.8–0.9.
        assert!(n >= 50 && sum / n as f32 > 0.98 && worst > 0.96, "embeddings drift from the canonical reference");
    }

    /// Dump this pipeline's embeddings for every image in QOOTI_CLIP_REF/items.json to
    /// rust_embeddings.json (used to re-run the ranking evaluation on what ships).
    #[test]
    #[ignore]
    fn dump_library() {
        let model = std::env::var("QOOTI_CLIP_MODEL").expect("QOOTI_CLIP_MODEL");
        let dir = std::env::var("QOOTI_CLIP_REF").expect("QOOTI_CLIP_REF");
        let items: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/items.json")).unwrap()).unwrap();
        let mut s = build_session(Path::new(&model)).unwrap();
        let mut out: HashMap<String, Vec<f32>> = HashMap::new();
        let t0 = std::time::Instant::now();
        for it in &items {
            if let Ok(v) = embed_with(&mut s, it["path"].as_str().unwrap()) { out.insert(it["id"].as_str().unwrap().to_string(), v); }
        }
        println!("embedded {} of {} in {} ms", out.len(), items.len(), t0.elapsed().as_millis());
        std::fs::write(format!("{dir}/rust_embeddings.json"), serde_json::to_string(&out).unwrap()).unwrap();
    }
}
