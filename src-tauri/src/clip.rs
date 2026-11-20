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
//
// Tag lens (spec §6.2): while tag suggestions are on, the same indexer also reads one frame per
// second (8 to 32, frames::frame_count) of every video up to 60 s (tagging::MAX_TAG_VIDEO_SECS;
// longer ones get no frames at all) with frames.rs, embeds them in memory with the same
// preprocessing and session, and stores them as f16 in `clip_frames`; tagging.rs then scores the
// new vectors. Pictures are embedded whatever the setting, because Find similar needs them.
//
// Frame schedules (owner decision 2026-11-20, R45). `clip_frames.model` says how a row's frames
// were taken: FRAMES_TAG (one per second, 8–32) for rows written from now on, FRAMES_TAG_8 (the
// model tag alone) for rows written before, 8 frames whatever the length. Both are read and scored.
// A row of the 8-frame kind whose video is longer than 8 s (where the schedules differ) is read
// again once, in place (`old_schedule_with`): its 8 vectors keep the video scored until the new
// ones replace them. Pictures and `clip_embeddings` keep MODEL_TAG.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use once_cell::sync::{Lazy, OnceCell};
use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};
use crate::AppState;

/// Stored with each embedding; a different model later simply re-indexes.
pub const MODEL_TAG: &str = "clip-b32-q8";
const FAILED_TAG: &str = "failed";   // item couldn't be decoded — don't retry every cycle
/// `clip_frames.model` of frame rows read one per second (8–32, frames::frame_count): the model
/// tag plus the schedule. Every row is written with it.
pub const FRAMES_TAG: &str = "clip-b32-q8@fps1";
/// `clip_frames.model` of rows written before 2026-11-20: 8 frames, whatever the length. Still
/// read and scored; the ones of videos over 8 s are read again once (`old_schedule_with`).
pub const FRAMES_TAG_8: &str = MODEL_TAG;

/// SQL: frame row alias `f` holds this model's vectors, with either schedule.
pub(crate) fn frames_row_sql(f: &str) -> String {
    format!("{f}.model IN ('{FRAMES_TAG}', '{FRAMES_TAG_8}')")
}

/// A `clip_frames.model` whose vectors the scorer reads (either schedule).
pub(crate) fn is_frames_model(model: &str) -> bool {
    model == FRAMES_TAG || model == FRAMES_TAG_8
}
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
// Purely visual on purpose: tags, titles and detected objects never influence the result.

static SESSION: OnceCell<Mutex<ort::session::Session>> = OnceCell::new();
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// Pause between videos (background work stays gentle), and how many videos one round reads
/// before new pictures get a turn again.
const VIDEO_PAUSE: Duration = Duration::from_millis(150);
const VIDEOS_PER_ROUND: i64 = 4;
/// How long the indexer waits after the model couldn't be downloaded. wake() doesn't shorten it:
/// every save calls wake(), and each try downloads up to 89 MB again from the start.
const MODEL_RETRY: Duration = Duration::from_secs(30 * 60);

pub fn ensure_table(db: &rusqlite::Connection) {
    if let Err(e) = create_tables(db) {
        log::error!(target: "Clip", "couldn't create the embedding tables: {e}");
    }
}

/// `clip_embeddings`: one vector per picture (and per video cover). `clip_frames`: up to 32
/// frame vectors per video for tag suggestions, as f16 (n × 512 × 2 bytes), with the schedule
/// they were taken with in `model` (FRAMES_TAG, FRAMES_TAG_8); n = 0 marks a video whose frames
/// couldn't be read (it falls back to its cover, and is read again once per launch) or whose
/// length couldn't be found (it gets no suggestions).
pub fn create_tables(db: &rusqlite::Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS clip_embeddings (
             id    TEXT PRIMARY KEY,
             model TEXT NOT NULL,
             emb   BLOB NOT NULL
         );
         CREATE TABLE IF NOT EXISTS clip_frames (
             id    TEXT PRIMARY KEY,
             model TEXT NOT NULL,
             n     INTEGER NOT NULL,
             emb   BLOB NOT NULL
         );",
    )
}

// Wake signal: cuts the indexer's idle wait short (tagging_wake, tag suggestions turned on).
static WAKE: Mutex<bool> = Mutex::new(false);
static WAKE_CV: Condvar = Condvar::new();

/// Wake the indexer now instead of at the end of its idle wait.
pub fn wake() {
    *WAKE.lock().unwrap_or_else(|e| e.into_inner()) = true;
    WAKE_CV.notify_all();
}

/// Sleep for `d`, or until `wake()` is called.
fn idle(d: Duration) {
    let woken = WAKE.lock().unwrap_or_else(|e| e.into_inner());
    let mut woken = match WAKE_CV.wait_timeout_while(woken, d, |w| !*w) {
        Ok((g, _)) => g,
        Err(e) => e.into_inner().0,
    };
    *woken = false;
}

/// Sleep until `deadline`, even when `wake()` is called meanwhile (the wake is used up). For the
/// back-offs that new items mustn't cut short.
fn idle_until(deadline: Instant) {
    loop {
        let now = Instant::now();
        if now >= deadline { return; }
        idle(deadline - now);
    }
}

/// The wait after the database refused a write, growing while it keeps refusing (a full disk, a
/// read-only or locked database): 30 s, 1 min, 2 min, 4 min, 8 min, then 15 min.
fn write_backoff(failures: u32) -> Duration {
    let secs = 30u64 << failures.saturating_sub(1).min(5);
    Duration::from_secs(secs.min(15 * 60))
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
    let img = image::ImageReader::open(path).map_err(|e| e.to_string())?
        .with_guessed_format().map_err(|e| e.to_string())?
        .decode().map_err(|e| e.to_string())?;
    embed_image(session, &img)
}

fn embed_image(session: &mut ort::session::Session, img: &image::DynamicImage) -> Result<Vec<f32>, String> {
    use ort::value::Tensor;
    let input = Tensor::from_array((vec![1_i64, 3, SIZE as i64, SIZE as i64], preprocess(img)))
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

/// L2-normalised CLIP embedding of an encoded image held in memory (a video frame), with the
/// same preprocessing and session as files. Needs the model downloaded.
pub fn embed_bytes(app: &AppHandle, bytes: &[u8]) -> Result<Vec<f32>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let s = session(app)?;
    let mut s = s.lock().unwrap_or_else(|e| e.into_inner());
    embed_image(&mut s, &img)
}

fn to_blob(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

pub(crate) fn from_blob(b: &[u8]) -> Option<Vec<f32>> {
    if b.len() != DIM * 4 { return None; }
    Some(b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// What storing one picture's vector came to.
#[derive(Debug, PartialEq, Eq)]
enum Stored {
    Written,
    /// The item shows another file now (a crop or a restore removed the old vector meanwhile), or
    /// is gone: nothing written, and the new file is embedded in a later round.
    Dropped,
    /// The database refused the write.
    Failed,
}

/// Store one picture's vector (or "failed" when it couldn't be read), made from `path`.
fn store(app: &AppHandle, id: &str, path: &str, result: Result<Vec<f32>, String>) -> Stored {
    let state = app.state::<AppState>();
    let db = crate::lenses::lock_db(&state);
    let (model, blob) = match result {
        Ok(v) => (MODEL_TAG, to_blob(&v)),
        Err(e) => { log::debug!(target: "Clip", "embed failed id={id} err={e}"); (FAILED_TAG, Vec::new()) }
    };
    match store_with(&db, id, path, model, &blob) {
        Ok(0) => { log::debug!(target: "Clip", "id={id} shows another file now: its old vector was dropped"); Stored::Dropped }
        Ok(_) => Stored::Written,
        Err(e) => { log::warn!(target: "Clip", "couldn't store the vector of id={id}: {e}"); Stored::Failed }
    }
}

/// Write a vector only while the item still shows `path`, the file it was made from (a video: its
/// cover, as `pending` reads it). → rows written: 0 when the item changed or is gone.
fn store_with(conn: &Connection, id: &str, path: &str, model: &str, blob: &[u8]) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT OR REPLACE INTO clip_embeddings (id, model, emb)
         SELECT id, ?2, ?3 FROM inspirations
         WHERE id = ?1 AND (CASE WHEN type = 'video' THEN thumbnail_path ELSE stored_path END) = ?4",
        params![id, model, blob, path],
    )
}

/// Store a video's frame vectors as f16 (n × 512 × 2 bytes), tagged FRAMES_TAG. An empty list
/// stores n = 0: the frames couldn't be read (the item falls back to its cover), or the video's
/// length couldn't be found (it gets no suggestions at all). False when the database refused the
/// write.
fn store_frames(app: &AppHandle, id: &str, frames: &[Vec<f32>]) -> bool {
    let state = app.state::<AppState>();
    let db = crate::lenses::lock_db(&state);
    match store_frames_with(&db, id, frames) {
        Ok(_) => true,
        Err(e) => { log::warn!(target: "Clip", "couldn't store the frames of id={id}: {e}"); false }
    }
}

fn store_frames_with(conn: &Connection, id: &str, frames: &[Vec<f32>]) -> rusqlite::Result<usize> {
    let blob: Vec<u8> = frames.iter().flat_map(|v| crate::lenses::encode_f16(v)).collect();
    conn.execute(
        "INSERT OR REPLACE INTO clip_frames (id, model, n, emb) VALUES (?1, ?2, ?3, ?4)",
        params![id, FRAMES_TAG, frames.len() as i64, blob],
    )
}

/// Videos with no frame vectors yet (no row of either schedule), newest first: (id, file, stored
/// duration). Videos known to be over the tag-suggestion length limit never are (§0.11); ones of
/// unknown length are, and `index_video` measures them first. `skipped` (videos not tried this
/// launch, with nothing stored) are left out, so they can't come back every round.
fn pending_videos_with(conn: &Connection, n: i64, skipped: &HashSet<String>) -> Vec<PendingVideo> {
    let skipped = serde_json::Value::from(skipped.iter().cloned().collect::<Vec<String>>()).to_string();
    let Ok(mut stmt) = conn.prepare(&format!(
        "SELECT i.id, i.stored_path, i.duration_secs
         FROM inspirations i
         LEFT JOIN clip_frames f ON f.id = i.id AND {}
         WHERE i.type = 'video' AND f.id IS NULL
           AND (i.duration_secs IS NULL OR i.duration_secs <= ?2)
           AND i.id NOT IN (SELECT value FROM json_each(?3))
         ORDER BY i.created_at DESC LIMIT ?1", frames_row_sql("f"))
    ) else { return vec![] };
    stmt.query_map(params![n, crate::tagging::max_tag_video_secs(), skipped], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map(|it| it.flatten().collect())
        .unwrap_or_default()
}

fn pending_videos(app: &AppHandle, n: i64, skipped: &HashSet<String>) -> Vec<PendingVideo> {
    let state = app.state::<AppState>();
    let db = crate::lenses::lock_db(&state);
    pending_videos_with(&db, n, skipped)
}

/// Videos whose frames couldn't be read (n = 0) although their length is known and within the
/// limit, newest first. Each gets one more try per launch, so a busy PC (every frame timed out)
/// or a drive that was unplugged doesn't mark a video failed for good, and a file that really
/// can't be read costs one quick try per start. The try happens in place: the n = 0 row (and the
/// suggestions from the cover) stays until a new result replaces it, so the status never counts
/// these videos as waiting meanwhile. A video whose length couldn't be found isn't tried again:
/// it can't have suggestions (§0b.1), and measuring it can take 2 minutes of ffmpeg. Rows of
/// either schedule count: a second try reads with today's.
fn failed_frames_with(conn: &Connection) -> Vec<PendingVideo> {
    let Ok(mut stmt) = conn.prepare(&format!(
        "SELECT i.id, i.stored_path, i.duration_secs
         FROM clip_frames f JOIN inspirations i ON i.id = f.id
         WHERE {} AND f.n = 0 AND i.type = 'video'
           AND i.duration_secs > 0 AND i.duration_secs <= ?1
         ORDER BY i.created_at DESC", frames_row_sql("f"))
    ) else { return vec![] };
    stmt.query_map(params![crate::tagging::max_tag_video_secs()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map(|it| it.flatten().collect())
        .unwrap_or_default()
}

/// Videos whose frames were read with the 8-frame schedule (FRAMES_TAG_8, before 2026-11-20)
/// although today's would take more: a known length over MIN_FRAMES seconds (frame_count(d) > 8
/// exactly when d > 8) and within the limit. Newest first. Up to 8 s both schedules take the
/// same 8 frames, so those rows stay as they are. Each is read again once, in place: its 8
/// vectors keep it scored meanwhile, and the new row (FRAMES_TAG) takes it off this list for good,
/// however many frames it got. A read that gets no frame leaves the row (`index_video`), so the
/// next start tries again; one that can't reach the file too. Rows whose frames failed (n = 0)
/// are failed_frames_with's.
fn old_schedule_with(conn: &Connection) -> Vec<PendingVideo> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT i.id, i.stored_path, i.duration_secs
         FROM clip_frames f JOIN inspirations i ON i.id = f.id
         WHERE f.model = ?1 AND f.n > 0 AND i.type = 'video'
           AND i.duration_secs > ?2 AND i.duration_secs <= ?3
         ORDER BY i.created_at DESC"
    ) else { return vec![] };
    let min = crate::frames::MIN_FRAMES as f64;
    stmt.query_map(params![FRAMES_TAG_8, min, crate::tagging::max_tag_video_secs()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map(|it| it.flatten().collect())
        .unwrap_or_default()
}

// What the video step can't do now, for the status (tagging::status_with, review R1): videos
// without frame vectors that it couldn't reach this launch (a missing file, a drive that isn't
// connected: nothing was stored for them and the next start tries again), and whether ffmpeg is
// missing (then no video without frame vectors can be read). Neither counts as work left, so
// Settings doesn't say "Looking through your library" for good.
static SKIPPED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static NO_FFMPEG: AtomicBool = AtomicBool::new(false);

/// The videos the indexer can't read now (see SKIPPED), for tagging::status_with.
pub fn videos_not_now() -> crate::tagging::VideosNotNow {
    let skipped = SKIPPED.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
    crate::tagging::VideosNotNow { skipped, no_ffmpeg: NO_FFMPEG.load(Ordering::Acquire) }
}

/// Keep a length ffmpeg measured for an item saved without one, so it is measured only once.
/// False when the database refused the write.
fn store_duration(app: &AppHandle, id: &str, secs: f64) -> bool {
    let state = app.state::<AppState>();
    let db = crate::lenses::lock_db(&state);
    match db.execute(
        "UPDATE inspirations SET duration_secs = ?2 WHERE id = ?1 AND (duration_secs IS NULL OR duration_secs <= 0)",
        params![id, secs],
    ) {
        Ok(_) => true,
        Err(e) => { log::warn!(target: "Clip", "couldn't store the length of id={id}: {e}"); false }
    }
}

/// What reading one video came to.
#[derive(Debug, PartialEq, Eq)]
enum VideoOutcome {
    /// Frame vectors stored (maybe none: n = 0 when no frame could be read, tried again at the
    /// next start); score it now.
    Stored,
    /// It can't have suggestions: over the length limit (no clip_frames row: its stored length
    /// keeps it out of the queue), or no length even after reading every packet (n = 0 stored).
    Untaggable,
    /// Not tried, nothing stored: the file isn't reachable now (a drive that isn't connected,
    /// say). Tried again at the next start; until then it isn't work left (videos_not_now).
    Skipped,
    /// A second read (`again`: failed frames, or the 8-frame schedule) that got no frame: the row
    /// it has stays as it is, and the next start tries again.
    Unchanged,
    /// The database refused a write.
    WriteFailed,
}

/// Read one video's frames (one per second, 8–32), embed them in memory and store the vectors
/// (never the frames). Only files in the folders the window may load from are read. The length
/// decides first (§0.11, §0b.1): a missing one is found with ffmpeg (the header, else by reading
/// every packet) and stored; a video over the limit gets no frames and no clip_frames row; a video
/// whose length can't be found gets n = 0 and no suggestions at all. `again`: the video already
/// has a row (failed frames, or the 8-frame schedule) that is read again in place; when no frame
/// can be read, that row stays (`Unchanged`) instead of becoming n = 0.
fn index_video(app: &AppHandle, ffmpeg: &Path, id: &str, path: &str, duration: Option<f64>, again: bool) -> VideoOutcome {
    if !app.asset_protocol_scope().is_allowed(path) || !Path::new(path).is_file() {
        log::debug!(target: "Clip", "video id={id} can't be reached now: it is tried again at the next start");
        return VideoOutcome::Skipped;
    }
    let mut duration = crate::tagging::known_length(duration);
    if duration.is_none() {
        duration = crate::frames::find_duration(ffmpeg, path);
        if let Some(d) = duration {
            if !store_duration(app, id, d) { return VideoOutcome::WriteFailed; }
        }
    }
    let Some(d) = duration else {
        log::debug!(target: "Clip", "video id={id}: its length can't be found, so no tag suggestions");
        if !store_frames(app, id, &[]) { return VideoOutcome::WriteFailed; }
        crate::tagging::forget_untaggable_videos(app);   // e.g. collection hints it got before
        return VideoOutcome::Untaggable;
    };
    if crate::tagging::too_long_for_tags(Some(d)) {
        log::debug!(target: "Clip", "video id={id} is over {} s: no tag suggestions", crate::tagging::MAX_TAG_VIDEO_SECS);
        crate::tagging::forget_untaggable_videos(app);   // e.g. collection hints it got before its length was known
        return VideoOutcome::Untaggable;
    }
    let jpegs = crate::frames::extract_frames(ffmpeg, path, Some(d));
    let mut vectors = Vec::with_capacity(jpegs.len());
    for jpg in &jpegs {
        match embed_bytes(app, jpg) {
            Ok(v) => vectors.push(v),
            Err(e) => log::debug!(target: "Clip", "frame embed failed id={id} err={e}"),
        }
    }
    if vectors.is_empty() {
        if again {
            log::debug!(target: "Clip", "no frames for id={id} on a second read: its row stays until the next start tries again");
            return VideoOutcome::Unchanged;
        }
        log::debug!(target: "Clip", "no frames for id={id}: its cover is used until the next start tries again");
    }
    if !store_frames(app, id, &vectors) { return VideoOutcome::WriteFailed; }
    VideoOutcome::Stored
}

/// Items that don't have a current embedding yet (newest first): images/GIFs, and videos
/// once their thumbnail exists (embedded from the thumbnail — used by recommendations;
/// Find similar stays images-only).
fn pending(app: &AppHandle, n: i64) -> Vec<(String, String)> {
    let state = app.state::<AppState>();
    let Ok(db) = state.db.lock() else { return vec![] };
    let Ok(mut stmt) = db.prepare(
        "SELECT i.id, CASE WHEN i.type = 'video' THEN i.thumbnail_path ELSE i.stored_path END
         FROM inspirations i
         LEFT JOIN clip_embeddings e ON e.id = i.id AND e.model IN (?1, ?2)
         WHERE e.id IS NULL
           AND (i.type IN ('image', 'gif') OR (i.type = 'video' AND i.thumbnail_path IS NOT NULL))
         ORDER BY i.created_at DESC LIMIT ?3"
    ) else { return vec![] };
    stmt.query_map(params![MODEL_TAG, FAILED_TAG, n], |r| Ok((r.get(0)?, r.get(1)?)))
        .map(|it| it.flatten().collect())
        .unwrap_or_default()
}

/// What one indexer round came to.
#[derive(Debug, PartialEq, Eq)]
enum Round {
    /// Something was looked at: go straight on to the next round.
    Worked,
    /// Nothing to do (or nothing that can be done now): idle.
    Nothing,
    /// The database refused a write: back off.
    WriteFailed,
}

/// A batch of up to 16 pictures without a vector: embed, store, score, one status.
fn picture_round(app: &AppHandle) -> Round {
    let batch = pending(app, 16);
    if batch.is_empty() { return Round::Nothing; }
    let t0 = Instant::now();
    let n = batch.len();
    let mut stored = Vec::with_capacity(n);
    let mut round = Round::Worked;
    for (id, path) in batch {
        let r = embed_file(app, &path);
        let ok = r.is_ok();
        match store(app, &id, &path, r) {
            Stored::Failed => { round = Round::WriteFailed; break; }
            Stored::Written if ok => stored.push(id),
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(15));   // stay polite to the UI
    }
    log::debug!(target: "Clip", "indexed {n} in {} ms", t0.elapsed().as_millis());
    crate::tagging::score_items(app, &stored);   // no-op while suggestions are off
    crate::tagging::round_done(app);
    round
}

/// A video for the indexer: (id, file, stored duration).
type PendingVideo = (String, String, Option<f64>);

/// The indexer's video queue, for one launch.
#[derive(Default)]
struct VideoQueue {
    /// The videos read again in place this launch, loaded at the first video round: first those
    /// whose frames failed (n = 0, failed_frames_with), then those read with the 8-frame schedule
    /// (old_schedule_with). Each leaves the list when tried.
    retry: Option<VecDeque<PendingVideo>>,
    /// ffmpeg wasn't found: look again only after this (each look logs and starts a process).
    next_ffmpeg_look: Option<Instant>,
}

/// How long the video step rests when ffmpeg can't be found.
const NO_FFMPEG_RETRY: Duration = Duration::from_secs(30 * 60);

/// Up to 4 videos (newest first): those without frame vectors, then the second reads (failed
/// frames, then the 8-frame schedule). Length, frames, score, one status. A round can't spin on
/// the same videos: each one is stored, left out of later rounds (SKIPPED) or, for a second read,
/// taken off the list. While ffmpeg is missing nothing is read, and the videos it would read
/// don't count as work left.
fn video_round(app: &AppHandle, queue: &mut VideoQueue) -> Round {
    if queue.retry.is_none() {
        let state = app.state::<AppState>();
        let (failed, old) = {
            let db = crate::lenses::lock_db(&state);
            (failed_frames_with(&db), old_schedule_with(&db))
        };
        if !failed.is_empty() { log::info!(target: "Clip", "{} videos whose frames failed get another try", failed.len()); }
        if !old.is_empty() { log::info!(target: "Clip", "{} videos read with 8 frames are read again, one frame per second", old.len()); }
        queue.retry = Some(failed.into_iter().chain(old).collect());
    }
    if NO_FFMPEG.load(Ordering::Acquire) && queue.next_ffmpeg_look.is_some_and(|t| Instant::now() < t) { return Round::Nothing; }
    let skipped = SKIPPED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut videos: Vec<(PendingVideo, bool)> = pending_videos(app, VIDEOS_PER_ROUND, &skipped)
        .into_iter().map(|v| (v, false)).collect();
    if let Some(retry) = queue.retry.as_mut() {
        while (videos.len() as i64) < VIDEOS_PER_ROUND {
            let Some(v) = retry.pop_front() else { break };
            videos.push((v, true));
        }
    }
    if videos.is_empty() { return Round::Nothing; }
    let Some(ffmpeg) = crate::commands::ffmpeg_binary(app) else {
        // Nothing stored: the videos wait until ffmpeg is there again (second tries go back on
        // the list), and meanwhile the status doesn't count them (videos_not_now).
        put_back(queue, videos);
        queue.next_ffmpeg_look = Some(Instant::now() + NO_FFMPEG_RETRY);
        if !NO_FFMPEG.swap(true, Ordering::AcqRel) {
            log::warn!(target: "Clip", "no ffmpeg: video frames wait");
            crate::tagging::round_done(app);
        }
        return Round::Nothing;
    };
    queue.next_ffmpeg_look = None;
    NO_FFMPEG.store(false, Ordering::Release);
    let mut rest = videos.into_iter();
    while let Some(((id, path, duration), again)) = rest.next() {
        let t0 = Instant::now();
        let outcome = index_video(app, &ffmpeg, &id, &path, duration, again);
        log::debug!(target: "Clip", "video id={id}{}: {outcome:?} in {} ms", if again { " (second read)" } else { "" }, t0.elapsed().as_millis());
        match outcome {
            // A second read that can't reach the file keeps its row (and the suggestions made from it)
            VideoOutcome::Skipped => { if !again { SKIPPED.lock().unwrap_or_else(|e| e.into_inner()).insert(id); } continue; }
            VideoOutcome::WriteFailed => {
                // After the back-off: new videos are still without frames; second tries go back.
                put_back(queue, std::iter::once(((id, path, duration), again)).chain(rest).collect());
                crate::tagging::round_done(app);
                return Round::WriteFailed;
            }
            VideoOutcome::Stored => crate::tagging::score_items(app, std::slice::from_ref(&id)),
            VideoOutcome::Untaggable | VideoOutcome::Unchanged => {}
        }
        std::thread::sleep(VIDEO_PAUSE);
    }
    crate::tagging::round_done(app);
    Round::Worked
}

/// The second tries among `videos` go back to the front of the list, in their order.
fn put_back(queue: &mut VideoQueue, videos: Vec<(PendingVideo, bool)>) {
    let retry = queue.retry.get_or_insert_with(VecDeque::new);
    for (v, _) in videos.into_iter().filter(|(_, again)| *again).rev() { retry.push_front(v); }
}

/// Background indexer: downloads the model (once), then embeds un-indexed items a few
/// at a time, forever — new imports get picked up within ~30 s (at once after `wake()`).
/// Offline-safe: a failed download is retried after 30 minutes (new items don't shorten that);
/// "Find similar" uses the fingerprint ranking meanwhile. Pictures come first; while tag
/// suggestions are on, videos without frame vectors follow (newest first), and every stored
/// vector is scored right away. When the database refuses a write, it backs off (30 s, growing).
pub fn start_indexer(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        idle(Duration::from_secs(40));   // let boot work finish first
        let mut logged_done = false;
        let mut next_model_try = Instant::now();
        let mut write_failures: u32 = 0;
        let mut videos = VideoQueue::default();
        loop {
            if !model_ready(&app) {
                idle_until(next_model_try);
                if let Err(e) = ensure_model(&app) {
                    log::warn!(target: "Clip", "model unavailable: {e}");
                    next_model_try = Instant::now() + MODEL_RETRY;
                    continue;
                }
            }
            let round = match picture_round(&app) {
                Round::Nothing if crate::tagging::suggestions_on(&app) => video_round(&app, &mut videos),
                round => round,
            };
            match round {
                Round::Worked => { write_failures = 0; logged_done = false; continue; }
                Round::WriteFailed => {
                    write_failures += 1;
                    let wait = write_backoff(write_failures);
                    log::warn!(target: "Clip", "the library refused a write; trying again in {} s", wait.as_secs());
                    idle_until(Instant::now() + wait);
                    continue;
                }
                Round::Nothing => {}
            }
            if !logged_done { log::info!(target: "Clip", "library indexed"); logged_done = true; }
            // Drop vectors of deleted items, then idle until new ones arrive.
            if let Ok(db) = app.state::<AppState>().db.lock() {
                for table in ["clip_embeddings", "clip_frames"] {
                    if let Err(e) = db.execute(&format!("DELETE FROM {table} WHERE id NOT IN (SELECT id FROM inspirations)"), []) {
                        log::warn!(target: "Clip", "couldn't clean {table}: {e}");
                    }
                }
            }
            idle(Duration::from_secs(30));
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

/// Ranking score + tier for one candidate, or None if it doesn't look similar enough to
/// show. `z` is the candidate's standing against the focus's library-wide background
/// (None for tiny libraries → fixed cut-offs). Colour only reorders; it never admits.
fn score_and_tier(cos: f32, z: Option<f32>, colour: f32) -> Option<(f32, u8)> {
    if cos < FLOOR { return None; }
    let tier = match z {
        Some(z) if z >= Z_STRONG => 0,
        Some(z) if z >= Z_RELATED => 1,
        Some(_) => return None,
        None if cos >= ABS_STRONG => 0,
        None if cos >= ABS_RELATED => 1,
        None => return None,
    };
    Some((cos + COLOUR_WEIGHT * colour, tier))
}

/// Rank items that look like `focus_id`: CLIP image-embedding cosine + a colour-palette
/// nudge — appearance only, never tags or titles. Returns (id, tier) best-first — tier 0 clearly similar, tier 1
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
            if store(app, focus_id, &focus_path, Ok(v.clone())) == Stored::Written {
                // The indexer won't see it again, so score its tag suggestions here (off this thread).
                let (app2, id) = (app.clone(), focus_id.to_string());
                std::thread::spawn(move || crate::tagging::score_items(&app2, &[id]));
            }
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
        score_and_tier(cos, z, colour).map(|(s, t)| (t, s, id))
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
    use std::collections::HashMap;

    #[test]
    fn blob_round_trip() {
        let v: Vec<f32> = (0..DIM).map(|i| i as f32 / DIM as f32).collect();
        assert_eq!(from_blob(&to_blob(&v)).unwrap(), v);
        assert!(from_blob(&[0u8; 12]).is_none());
    }

    #[test]
    fn a_vector_lands_only_on_the_file_it_was_made_from() {
        let conn = crate::lenses::testkit::test_db();
        conn.execute_batch(
            "INSERT INTO inspirations (id, type, stored_path, created_at, updated_at) VALUES ('p', 'image', 'p.png', 0, 0);
             INSERT INTO inspirations (id, type, stored_path, thumbnail_path, created_at, updated_at)
                 VALUES ('v', 'video', 'v.mp4', 'v_thumb.jpg', 0, 0);",
        ).unwrap();
        let blob = to_blob(&vec![0.5; DIM]);
        let model_of = |id: &str| -> Option<String> {
            conn.query_row("SELECT model FROM clip_embeddings WHERE id = ?1", [id], |r| r.get(0)).ok()
        };
        assert_eq!(store_with(&conn, "p", "p.png", MODEL_TAG, &blob).unwrap(), 1);
        assert_eq!(model_of("p").as_deref(), Some(MODEL_TAG));
        // The indexer read the file, then a crop gave the item a new one and removed its vector…
        conn.execute_batch("UPDATE inspirations SET stored_path = 'p_crop_1.png' WHERE id = 'p';
                            DELETE FROM clip_embeddings WHERE id = 'p';").unwrap();
        // …so the old picture's vector (or its failure) is dropped: Find similar and tag
        // suggestions wait for the new file's
        assert_eq!(store_with(&conn, "p", "p.png", MODEL_TAG, &blob).unwrap(), 0);
        assert_eq!(store_with(&conn, "p", "p.png", FAILED_TAG, &[]).unwrap(), 0);
        assert_eq!(model_of("p"), None);
        assert_eq!(store_with(&conn, "p", "p_crop_1.png", MODEL_TAG, &blob).unwrap(), 1);
        assert_eq!(model_of("p").as_deref(), Some(MODEL_TAG));
        // A video's vector is made from its cover
        assert_eq!(store_with(&conn, "v", "v_thumb.jpg", MODEL_TAG, &blob).unwrap(), 1);
        assert_eq!(store_with(&conn, "v", "v.mp4", MODEL_TAG, &blob).unwrap(), 0);
        // An item that's gone gets nothing
        assert_eq!(store_with(&conn, "gone", "gone.png", MODEL_TAG, &blob).unwrap(), 0);
        assert_eq!(model_of("gone"), None);
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
        assert_eq!(score_and_tier(0.70, Some(2.4), 0.5).map(|s| s.1), Some(0));
        assert_eq!(score_and_tier(0.70, Some(1.8), 0.5).map(|s| s.1), Some(1));
        assert_eq!(score_and_tier(0.70, Some(1.2), 1.0), None);   // unremarkable for this focus
        assert_eq!(score_and_tier(0.54, Some(3.0), 1.0), None);   // under the absolute floor
        // Tiny libraries: fixed cut-offs.
        assert_eq!(score_and_tier(0.72, None, 0.5).map(|s| s.1), Some(0));
        assert_eq!(score_and_tier(0.62, None, 0.5).map(|s| s.1), Some(1));
        assert_eq!(score_and_tier(0.58, None, 0.5), None);
        // Colour reorders but never admits a candidate that doesn't look alike.
        let (a, _) = score_and_tier(0.70, Some(2.5), 0.0).unwrap();
        let (b, _) = score_and_tier(0.70, Some(2.5), 1.0).unwrap();
        assert!(b > a);
        assert_eq!(score_and_tier(0.70, Some(1.0), 1.0), None);
    }

    #[test]
    fn a_wake_doesnt_cut_a_back_off_short() {
        // Every save calls wake(). idle() returns at the first wake: that is what ended the
        // 30-minute wait after a failed model download. idle_until() keeps waiting.
        let waker = std::thread::spawn(|| {
            for _ in 0..3 { std::thread::sleep(Duration::from_millis(60)); wake(); }
        });
        let t0 = Instant::now();
        idle(Duration::from_millis(400));
        let early = t0.elapsed();
        assert!(early < Duration::from_millis(300), "idle returns at a wake ({early:?})");
        let t1 = Instant::now();
        idle_until(t1 + Duration::from_millis(400));
        assert!(t1.elapsed() >= Duration::from_millis(400), "{:?}", t1.elapsed());
        waker.join().unwrap();
        idle_until(Instant::now());   // a deadline already passed returns at once
    }

    #[test]
    fn write_back_off_grows_to_fifteen_minutes() {
        let secs: Vec<u64> = (1..=8).map(|k| write_backoff(k).as_secs()).collect();
        assert_eq!(secs, vec![30, 60, 120, 240, 480, 900, 900, 900]);
        assert_eq!((write_backoff(0).as_secs(), write_backoff(u32::MAX).as_secs()), (30, 900));
    }

    #[test]
    fn the_video_queue_leaves_out_skipped_videos_and_retries_failed_ones_in_place() {
        let conn = crate::lenses::testkit::test_db();
        for (id, created, dur) in [("a", 1, Some(10.0)), ("b", 2, None), ("c", 3, Some(75.0)), ("d", 4, Some(0.0)), ("e", 5, Some(20.0))] {
            conn.execute("INSERT INTO inspirations (id, type, stored_path, duration_secs, created_at, updated_at)
                          VALUES (?1, 'video', ?1, ?2, ?3, ?3)", params![id, dur, created]).unwrap();
        }
        let ids = |skipped: &HashSet<String>| -> Vec<String> { pending_videos_with(&conn, 10, skipped).into_iter().map(|v| v.0).collect() };
        assert_eq!(ids(&HashSet::new()), vec!["e", "d", "b", "a"], "newest first; never one over 60 s; 0 is an unknown length");
        let skipped: HashSet<String> = ["e", "b"].iter().map(|s| s.to_string()).collect();
        assert_eq!(ids(&skipped), vec!["d", "a"], "videos not tried this launch don't come back every round");
        assert_eq!(pending_videos_with(&conn, 1, &skipped).len(), 1, "the limit applies after leaving them out");
        // Stored frames take a video out of the queue (rows of either schedule), failed ones
        // (n = 0) too, and so does a length that couldn't be found (b: n = 0 with no length).
        conn.execute("INSERT INTO clip_frames (id, model, n, emb) VALUES ('a', ?1, 0, x''), ('d', ?3, 1, ?2), ('b', ?3, 0, x''), ('e', ?3, 0, x'')",
            params![FRAMES_TAG_8, vec![0u8; DIM * 2], FRAMES_TAG]).unwrap();
        assert!(ids(&HashSet::new()).is_empty());
        // Review R1: the second tries are read in place, newest first. Nothing is deleted at start,
        // so meanwhile the status still counts them as done (their cover), not as waiting. A
        // video whose length couldn't be found isn't tried again (§0b.1; up to 2 min of ffmpeg).
        // Failed rows of both schedules get their try (a: written before 2026-11-20).
        let again: Vec<String> = failed_frames_with(&conn).into_iter().map(|v| v.0).collect();
        assert_eq!(again, vec!["e", "a"]);
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM clip_frames", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 4);
        let durations: Vec<Option<f64>> = failed_frames_with(&conn).into_iter().map(|v| v.2).collect();
        assert_eq!(durations, vec![Some(20.0), Some(10.0)], "read at their stored length: nothing to measure");
        assert!(old_schedule_with(&conn).is_empty(), "failed rows are failed_frames_with's, not read twice");
    }

    #[test]
    fn frame_rows_say_their_schedule() {
        assert!(FRAMES_TAG.starts_with(MODEL_TAG) && FRAMES_TAG != MODEL_TAG, "the same model, another schedule");
        assert_eq!(FRAMES_TAG_8, MODEL_TAG, "rows written before 2026-11-20 carry the model tag alone");
        assert!(is_frames_model(FRAMES_TAG) && is_frames_model(FRAMES_TAG_8));
        assert!(!is_frames_model(FAILED_TAG) && !is_frames_model("clip-b32-q8@fps2") && !is_frames_model(""));
        assert_eq!(frames_row_sql("f"), "f.model IN ('clip-b32-q8@fps1', 'clip-b32-q8')");
        // old_schedule_with picks videos over MIN_FRAMES seconds: exactly where the schedules differ
        for d in [0.5, 4.0, 7.999, 8.0, 8.0001, 8.5, 12.0, 30.5, 45.0, 60.5] {
            assert_eq!(crate::frames::frame_count(d) > crate::frames::MIN_FRAMES, d > crate::frames::MIN_FRAMES as f64, "{d}");
        }
    }

    #[test]
    fn rows_read_with_8_frames_are_read_again_once() {
        // Owner decision 2026-11-20 (R45): one frame per second. A video whose stored frames were
        // read with the 8-frame schedule is read again when today's takes more (over 8 s), once.
        let conn = crate::lenses::testkit::test_db();
        let blob = |n: usize| vec![0u8; n * DIM * 2];
        let mut created = 0;
        let mut video = |id: &str, dur: Option<f64>, row: Option<(&str, usize)>| {
            created += 1;
            conn.execute("INSERT INTO inspirations (id, type, stored_path, duration_secs, created_at, updated_at)
                          VALUES (?1, 'video', ?1, ?2, ?3, ?3)", params![id, dur, created]).unwrap();
            if let Some((model, n)) = row {
                conn.execute("INSERT INTO clip_frames (id, model, n, emb) VALUES (?1, ?2, ?3, ?4)", params![id, model, n as i64, blob(n)]).unwrap();
            }
        };
        video("s7", Some(7.5), Some((FRAMES_TAG_8, 8)));      // up to 8 s: the same 8 frames either way
        video("s8", Some(8.0), Some((FRAMES_TAG_8, 8)));
        video("o9", Some(8.5), Some((FRAMES_TAG_8, 8)));      // 9 frames now
        video("o20", Some(20.4), Some((FRAMES_TAG_8, 8)));    // 21 frames now
        video("opart", Some(25.0), Some((FRAMES_TAG_8, 6)));  // two of its 8 frames had failed
        video("ofail", Some(12.0), Some((FRAMES_TAG_8, 0)));  // failed: the second try, not this list
        video("olong", Some(75.0), Some((FRAMES_TAG_8, 8)));  // over the limit: never read
        video("onolen", None, Some((FRAMES_TAG_8, 8)));       // no length: never tagged, never read
        video("n21", Some(20.4), Some((FRAMES_TAG, 21)));     // already one per second
        video("npart", Some(20.4), Some((FRAMES_TAG, 19)));   // one per second, two frames failed: done
        video("m40", Some(40.0), None);                       // 30–60 s: read for the first time
        let ids = |v: Vec<PendingVideo>| -> Vec<String> { v.into_iter().map(|v| v.0).collect() };
        assert_eq!(ids(old_schedule_with(&conn)), vec!["opart", "o20", "o9"], "newest first");
        assert_eq!(ids(failed_frames_with(&conn)), vec!["ofail"]);
        assert_eq!(ids(pending_videos_with(&conn, 10, &HashSet::new())), vec!["m40"], "an 8-frame row isn't 'no frames'");
        // A read that got no frame (index_video: Unchanged) or couldn't reach the file writes
        // nothing: the row stays, listed for the next start (the list is loaded once per launch).
        assert_eq!(ids(old_schedule_with(&conn)).len(), 3);
        // A new row ends it for good, whatever it got: all 21 frames, or fewer when some failed
        // (o9: 5 of 9). Rows are written with today's schedule.
        let v = vec![0.5f32; DIM];
        store_frames_with(&conn, "o20", &vec![v.clone(); 21]).unwrap();
        store_frames_with(&conn, "o9", &vec![v.clone(); 5]).unwrap();
        assert_eq!(ids(old_schedule_with(&conn)), vec!["opart"]);
        let row = |id: &str| -> (String, i64) { conn.query_row("SELECT model, n FROM clip_frames WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap() };
        assert_eq!(row("o20"), (FRAMES_TAG.to_string(), 21));
        assert_eq!(row("o9"), (FRAMES_TAG.to_string(), 5));
        store_frames_with(&conn, "opart", &vec![v; 25]).unwrap();
        assert!(old_schedule_with(&conn).is_empty());
        assert!(pending_videos_with(&conn, 10, &HashSet::new()).iter().all(|p| p.0 == "m40"), "nothing else comes back");
        // A failed second try writes n = 0 with today's schedule (a first read that got nothing too)
        store_frames_with(&conn, "ofail", &[]).unwrap();
        assert_eq!(row("ofail"), (FRAMES_TAG.to_string(), 0));
        assert_eq!(ids(failed_frames_with(&conn)), vec!["ofail"], "still one more try per launch, as before");
        assert!(old_schedule_with(&conn).is_empty());
    }

    #[test]
    fn second_tries_that_werent_read_go_back_in_order() {
        let v = |id: &str| (id.to_string(), format!("{id}.mp4"), Some(5.0));
        let mut queue = VideoQueue { retry: Some(VecDeque::from([v("z")])), next_ffmpeg_look: None };
        // A round of two new videos and two second tries that couldn't run (no ffmpeg, a refused write)
        put_back(&mut queue, vec![(v("n1"), false), (v("x"), true), (v("n2"), false), (v("y"), true)]);
        let left: Vec<String> = queue.retry.unwrap().into_iter().map(|v| v.0).collect();
        assert_eq!(left, vec!["x", "y", "z"], "new videos come back by themselves: they still have no frames");
        let mut empty = VideoQueue::default();
        put_back(&mut empty, vec![(v("x"), true)]);
        assert_eq!(empty.retry.map(|r| r.len()), Some(1));
    }

    /// Frame parity with the Node tools (task: same vectors from the app as from
    /// scripts/lenses/embed-frames.mjs). For every video in QOOTI_FRAMES (the eval kit's
    /// frames/frame-vectors.json) within the length limit that has a copy in QOOTI_VIDEOS (read-only copies
    /// named `<inspiration id>.<ext>`), read its frames with frames::extract_frames at the length
    /// Node used and embed them as the indexer does (embed_bytes: image::load_from_memory, preprocess,
    /// this module's session), then compare each frame vector with Node's: cosine, both through f16
    /// as clip_frames stores them. With QOOTI_FRAME_JPEGS (the eval kit's frames folder) the JPEG
    /// bytes ffmpeg made are compared too, which tells ffmpeg apart from decoding and the model.
    ///   QOOTI_CLIP_MODEL=<onnx> QOOTI_FRAMES=<frame-vectors.json> QOOTI_VIDEOS=<dir> [QOOTI_FRAME_JPEGS=<dir>]
    ///   cargo test --lib clip::tests::frame_vectors_match_the_node_tools -- --ignored --nocapture
    #[test]
    #[ignore]
    fn frame_vectors_match_the_node_tools() {
        use base64::Engine;
        let model = std::env::var("QOOTI_CLIP_MODEL").expect("QOOTI_CLIP_MODEL");
        let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(std::env::var("QOOTI_FRAMES").expect("QOOTI_FRAMES")).unwrap()).unwrap();
        let dir = PathBuf::from(std::env::var("QOOTI_VIDEOS").expect("QOOTI_VIDEOS"));
        let jpeg_dir = std::env::var("QOOTI_FRAME_JPEGS").ok().map(PathBuf::from);
        #[cfg(windows)] let name = "ffmpeg-x86_64-pc-windows-msvc.exe";
        #[cfg(target_os = "macos")] let name = "ffmpeg-aarch64-apple-darwin";
        #[cfg(not(any(windows, target_os = "macos")))] let name = "ffmpeg-x86_64-unknown-linux-gnu";
        let ff = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name);
        let files: HashMap<String, PathBuf> = std::fs::read_dir(&dir).unwrap().flatten()
            .filter_map(|e| Some((e.path().file_stem()?.to_str()?.to_string(), e.path()))).collect();
        let mut s = build_session(Path::new(&model)).unwrap();
        let mut cos_all: Vec<(f64, String, u64)> = Vec::new();
        let (mut videos, mut no_copy, mut jpeg_same, mut jpeg_diff, mut f16_same) = (0, 0, 0, 0, 0);
        let t0 = Instant::now();
        for (id, it) in doc["items"].as_object().expect("a frame-vectors.json") {
            let n = it["n"].as_u64().unwrap_or(0) as usize;
            let Some(dur) = it["duration"].as_f64() else { continue };
            if it["long"].as_bool() == Some(true) || n == 0 || dur > crate::tagging::max_tag_video_secs() { continue; }
            let Some(file) = files.get(id) else { no_copy += 1; continue };
            let short = &id[..8.min(id.len())];
            let slots: Vec<u64> = it["slots"].as_array().unwrap().iter().filter_map(|v| v.as_u64()).collect();
            let blob = base64::engine::general_purpose::STANDARD.decode(it["f16"].as_str().unwrap()).unwrap();
            let node: Vec<Vec<f32>> = crate::lenses::decode_f16(&blob).chunks_exact(DIM)
                .map(|c| { let mut v = c.to_vec(); crate::lenses::normalize(&mut v); v }).collect();
            let jpegs = crate::frames::extract_frames(&ff, file.to_str().unwrap(), Some(dur));
            assert_eq!((jpegs.len(), node.len()), (n, n), "frames of {short}");
            for (k, jpg) in jpegs.iter().enumerate() {
                if let Some(jd) = &jpeg_dir {
                    match std::fs::read(jd.join(id).join(format!("f{}.jpg", slots[k]))) {
                        Ok(b) if b == *jpg => jpeg_same += 1,
                        _ => jpeg_diff += 1,
                    }
                }
                let v = embed_image(&mut s, &image::load_from_memory(jpg).unwrap()).unwrap();
                let ours = crate::lenses::encode_f16(&v);
                if ours[..] == blob[k * DIM * 2..(k + 1) * DIM * 2] { f16_same += 1; }
                let mut v16 = crate::lenses::decode_f16(&ours);
                crate::lenses::normalize(&mut v16);
                let cos: f64 = v16.iter().zip(&node[k]).map(|(a, b)| *a as f64 * *b as f64).sum();
                cos_all.push((cos, short.to_string(), slots[k]));
            }
            videos += 1;
        }
        assert!(videos > 0, "no video copies found in {}", dir.display());
        cos_all.sort_by(|a, b| a.0.total_cmp(&b.0));
        let c: Vec<f64> = cos_all.iter().map(|x| x.0).collect();
        let pick = |q: f64| c[((c.len() - 1) as f64 * q).round() as usize];
        println!("{videos} videos ({no_copy} listed without a copy), {} frames in {} s", c.len(), t0.elapsed().as_secs());
        println!("cosine min {:.7} · p5 {:.7} · median {:.7} · mean {:.7} · below 0.999: {}",
            c[0], pick(0.05), pick(0.5), c.iter().sum::<f64>() / c.len() as f64, c.iter().filter(|x| **x < 0.999).count());
        println!("f16 vectors bit-identical to Node's (what clip_frames stores): {f16_same} of {}", c.len());
        if jpeg_dir.is_some() { println!("JPEG bytes identical to Node's: {jpeg_same}, different: {jpeg_diff}"); }
        for (cos, id, slot) in cos_all.iter().take(8) { println!("  {cos:.7}  {id} f{slot}"); }
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

    /// Tag lens video path with the real model: 8 ffmpeg frames (a 6 s clip) → embedded in memory → f16 blob
    /// (what clip_frames stores) → decoded. Needs the bundled ffmpeg.
    /// QOOTI_CLIP_MODEL=<onnx> cargo test clip::tests::frames_embed_in_memory -- --ignored --nocapture
    #[test]
    #[ignore]
    fn frames_embed_in_memory() {
        let model = std::env::var("QOOTI_CLIP_MODEL").expect("QOOTI_CLIP_MODEL");
        #[cfg(windows)] let name = "ffmpeg-x86_64-pc-windows-msvc.exe";
        #[cfg(target_os = "macos")] let name = "ffmpeg-aarch64-apple-darwin";
        #[cfg(not(any(windows, target_os = "macos")))] let name = "ffmpeg-x86_64-unknown-linux-gnu";
        let ff = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name);
        let dir = std::env::temp_dir().join(format!("qooti-clipframes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("clip.mp4");
        let made = crate::frames::low_priority_command(&ff)
            .args(["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=duration=6:size=640x360:rate=25",
                   "-pix_fmt", "yuv420p", "-y"]).arg(&video).status().unwrap();
        assert!(made.success());
        let jpegs = crate::frames::extract_frames(&ff, video.to_str().unwrap(), None);
        assert_eq!(jpegs.len(), crate::frames::MIN_FRAMES);
        let mut s = build_session(Path::new(&model)).unwrap();
        let t0 = std::time::Instant::now();
        let vecs: Vec<Vec<f32>> = jpegs.iter()
            .map(|b| embed_image(&mut s, &image::load_from_memory(b).unwrap()).unwrap())
            .collect();
        println!("embedded {} frames in {} ms", vecs.len(), t0.elapsed().as_millis());
        let blob: Vec<u8> = vecs.iter().flat_map(|v| crate::lenses::encode_f16(v)).collect();
        assert_eq!(blob.len(), vecs.len() * DIM * 2);
        let back = crate::lenses::decode_f16(&blob);
        for (i, v) in vecs.iter().enumerate() {
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 1e-3, "norm {norm}");
            let mut b = back[i * DIM..(i + 1) * DIM].to_vec();
            crate::lenses::normalize(&mut b);
            let cos: f32 = v.iter().zip(&b).map(|(x, y)| x * y).sum();
            assert!(cos > 0.9999, "f16 round trip cos {cos}");
        }
        let first_last: f32 = vecs[0].iter().zip(&vecs[7]).map(|(x, y)| x * y).sum();
        println!("cos(frame 1, frame 8) = {first_last:.4}");
        assert!(first_last > 0.6, "frames of one clip should look alike ({first_last})");
        let _ = std::fs::remove_dir_all(&dir);
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
