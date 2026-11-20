use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicUsize, Ordering};
use image::GenericImageView;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use uuid::Uuid;

use crate::AppState;
use crate::vault;

/// Builds a `std::process::Command` that never flashes a console window on
/// Windows. Console child processes (yt-dlp, ffmpeg, taskkill, powershell…)
/// otherwise pop a CMD window because the GUI app has no console of its own.
/// CREATE_NO_WINDOW (0x0800_0000) suppresses it. No-op on other platforms.
pub fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

// ─── Active download PID registry (for cancellation) ──────────────
static ACTIVE_PIDS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
fn active_pids() -> &'static Mutex<HashMap<String, u32>> {
    ACTIVE_PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Download lifecycle sets. RUNNING: popped from the queue, not finished yet (it may be
// between yt-dlp processes — setting up YouTube, sleeping before a retry — so it can
// have no PID). CANCELLED: the user cancelled it; every later step bails out quietly.
// COMPLETED: reached `download:complete`; anything else refunds the free-plan quota.
static RUNNING_DOWNLOADS:   OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static CANCELLED_DOWNLOADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static COMPLETED_DOWNLOADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn running_downloads()   -> &'static Mutex<HashSet<String>> { RUNNING_DOWNLOADS.get_or_init(Default::default) }
fn cancelled_downloads() -> &'static Mutex<HashSet<String>> { CANCELLED_DOWNLOADS.get_or_init(Default::default) }
fn completed_downloads() -> &'static Mutex<HashSet<String>> { COMPLETED_DOWNLOADS.get_or_init(Default::default) }

fn is_cancelled(download_id: &str) -> bool {
    cancelled_downloads().lock().unwrap().contains(download_id)
}

/// Kill a download's whole process tree. Windows: `taskkill /T`, so the ffmpeg that
/// yt-dlp spawns to merge streams dies too (plain /PID orphaned it). Unix: yt-dlp runs
/// in its own process group (see `ytdlp_command`), so signalling the group does the same.
fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    { let _ = hidden_command("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).spawn(); }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: plain kill(2) on a pid (and its process group) we spawned.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = hidden_command("kill").args(["-s", "KILL", "--", &format!("-{pid}")]).spawn();
        let _ = hidden_command("kill").args(["-9", &pid.to_string()]).spawn();
    }
}

/// A yt-dlp invocation: no console window, unbuffered UTF-8 output, and (Unix) its own
/// process group so `kill_process_tree` reaches its ffmpeg child.
fn ytdlp_command(binary: &std::path::Path) -> std::process::Command {
    let mut cmd = hidden_command(binary);
    cmd.env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// Give back one free-plan download when a counted download didn't succeed (failed,
/// cancelled, or dropped from the queue). Quota is charged up front — so a burst of
/// requests can't overshoot the limit — and refunded here, so only successful
/// downloads use it up. Only touches today's counter.
fn refund_download_quota(app: &AppHandle, from_extension: bool) {
    let (count_key, date_key) = if from_extension {
        ("ext_dl_count", "ext_dl_date")
    } else {
        ("app_dl_count", "app_dl_date")
    };
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let state = app.state::<AppState>();
    let Ok(db) = state.db.lock() else { return };
    let date: String = db.query_row(
        "SELECT value FROM preferences WHERE key = ?1", [date_key], |r| r.get(0),
    ).unwrap_or_default();
    if date != today { return; }
    let used: u32 = db.query_row(
        "SELECT CAST(value AS INTEGER) FROM preferences WHERE key = ?1", [count_key], |r| r.get(0),
    ).unwrap_or(0);
    if used == 0 { return; }
    let _ = db.execute(
        "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)",
        params![count_key, (used - 1).to_string()],
    );
    log::info!(target: "Download", "quota_refunded key={count_key} used={}", used - 1);
}

/// The one way a download reports success. Drops the result if the user already
/// cancelled (so a cancelled download can never still land in the library), and
/// records the success so the queue keeps the quota charge.
fn emit_download_complete(app: &AppHandle, download_id: &str, paths: &[String], url: &str, ext_id: Option<&str>) {
    if is_cancelled(download_id) {
        for p in paths { let _ = std::fs::remove_file(p); }
        log::info!(target: "Download", "complete_after_cancel_dropped download_id={download_id}");
        return;
    }
    completed_downloads().lock().unwrap().insert(download_id.to_string());
    let _ = app.emit("download:complete", serde_json::json!({
        "download_id": download_id,
        "paths": paths,
        "url":   url,
    }));
    if let Some(eid) = ext_id { set_ext_progress(app, eid, 1.0, "", "finalizing", "Saving to library…"); }
}

/// The one way a download reports failure. Silent after a cancel — `cancel_download`
/// already told the UI, and a second (confusing) error would follow the kill.
fn emit_download_error(app: &AppHandle, download_id: &str, message: &str, ext_id: Option<&str>) {
    if is_cancelled(download_id) { return; }
    let _ = app.emit("download:error", serde_json::json!({
        "download_id": download_id,
        "message": message,
    }));
    if let Some(eid) = ext_id { set_ext_progress(app, eid, 0.0, "", "error", message); }
}

/// Progress event for a download stage that isn't byte progress (setting up YouTube,
/// retrying). `stage` is a stable key the UI translates (downloader.js); `speed`
/// carries an English label for older listeners and the browser extension.
fn emit_download_stage(app: &AppHandle, download_id: &str, stage: &str, label: &str, pct: f64, ext_id: Option<&str>) {
    let _ = app.emit("download:progress", serde_json::json!({
        "download_id": download_id,
        "pct":   pct,
        "speed": label,
        "stage": stage,
    }));
    if let Some(eid) = ext_id { set_ext_progress(app, eid, 0.0, label, "downloading", ""); }
}

// ─── .qooti file open (double-click / "Open with") ────────────────
// The .qooti file the app was launched with, captured once at startup so the
// frontend can pull it after it's ready to import. Subsequent opens (while the
// app runs) come through the single-instance callback / macOS Opened event.
static LAUNCH_FILE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
fn launch_file() -> &'static Mutex<Option<String>> {
    LAUNCH_FILE.get_or_init(|| Mutex::new(None))
}

/// First existing `*.qooti` path among the given CLI args.
pub fn qooti_path_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .find(|a| a.to_lowercase().ends_with(".qooti") && std::path::Path::new(a).is_file())
}

/// Stash the launch file (called once at startup from lib.rs).
pub fn set_launch_file(path: Option<String>) {
    *launch_file().lock().unwrap() = path;
}

/// Frontend pulls (and clears) the launch file on boot.
#[tauri::command]
pub fn take_launch_file() -> Option<String> {
    launch_file().lock().unwrap().take()
}

// ─── Download queue ───────────────────────────────────────────────
// Serial queue: at most one yt-dlp process at a time.  All download_url
// calls enqueue immediately and return a download_id; the queue is drained
// by try_start_next, which is called on every enqueue and after each
// download completes (success, error, or cancel).
const MAX_CONCURRENT: usize = 1;
static ACTIVE_DOWNLOADS: AtomicUsize = AtomicUsize::new(0);

struct DownloadRequest {
    app:         AppHandle,
    download_id: String,
    url:         String,
    quality:     String,
    tmp_dir:     std::path::PathBuf,
    ext_id:      Option<String>,
    /// A free-plan daily download was charged for this request (in-app counter, or
    /// the extension counter when it came from the extension). Refunded unless the
    /// download succeeds — see `refund_download_quota`.
    charged:     bool,
}

static DOWNLOAD_QUEUE: OnceLock<Mutex<VecDeque<DownloadRequest>>> = OnceLock::new();
fn download_queue() -> &'static Mutex<VecDeque<DownloadRequest>> {
    DOWNLOAD_QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

// ext_ids whose extension save was charged against the free extension quota
// (extension_server.rs). Midnight-queue replays aren't charged, so only these refund.
static CHARGED_EXT_IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn charged_ext_ids() -> &'static Mutex<HashSet<String>> { CHARGED_EXT_IDS.get_or_init(Default::default) }

/// Called by the extension server when it counts a save against today's quota.
pub fn mark_ext_quota_charged(ext_id: &str) {
    charged_ext_ids().lock().unwrap().insert(ext_id.to_string());
}

/// Attempt to pop one request from the queue and start it.
/// Uses compare_exchange(0 → 1) so only one caller wins the slot.
fn try_start_next() {
    if ACTIVE_DOWNLOADS
        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // A download is already running
    }
    let req = download_queue().lock().unwrap().pop_front();
    match req {
        Some(r) => {
            // Transition from "queued" (or default "pending") to "pending" now
            // that the slot is ours.  run_ytdlp will advance to "downloading"
            // once the process spawns successfully.
            if let Some(ref eid) = r.ext_id {
                set_ext_progress(&r.app, eid, 0.0, "", "pending", "");
            }
            running_downloads().lock().unwrap().insert(r.download_id.clone());
            std::thread::spawn(move || {
                let (app, id, charged, from_ext) = (r.app.clone(), r.download_id.clone(), r.charged, r.ext_id.is_some());
                run_ytdlp(r.app, r.download_id, r.url, r.quality, r.tmp_dir, r.ext_id);
                // All run_ytdlp exit paths (success, error, cancel, early-return) land here.
                let succeeded = completed_downloads().lock().unwrap().remove(&id);
                if charged && !succeeded { refund_download_quota(&app, from_ext); }
                running_downloads().lock().unwrap().remove(&id);
                cancelled_downloads().lock().unwrap().remove(&id);
                ACTIVE_DOWNLOADS.fetch_sub(1, Ordering::SeqCst);
                try_start_next();
            });
        }
        None => {
            // Queue was empty — release the slot we just acquired.
            ACTIVE_DOWNLOADS.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// Cancel a queued or running download. Returns false if it's unknown (already
/// finished). A running download is marked cancelled first, so whatever step it's in
/// — a yt-dlp run, a retry, the YouTube setup, a back-off sleep — stops quietly and
/// can't import anything afterwards.
fn cancel_download_by_id(app: &AppHandle, download_id: &str) -> bool {
    // Queued: just drop it.
    let queued = {
        let mut queue = download_queue().lock().unwrap();
        queue.iter().position(|r| r.download_id == download_id).and_then(|pos| queue.remove(pos))
    };
    if let Some(req) = queued {
        log::info!(target: "Download", "cancel_queued download_id={download_id}");
        app.state::<AppState>().ext_id_map.lock().unwrap().remove(download_id);
        if let Some(ref eid) = req.ext_id {
            set_ext_progress(app, eid, 0.0, "", "cancelled", "Cancelled");
        }
        if req.charged { refund_download_quota(app, req.ext_id.is_some()); }
        let _ = app.emit("download:error", serde_json::json!({
            "download_id": download_id,
            "message": "Cancelled",
        }));
        return true;
    }

    if !running_downloads().lock().unwrap().contains(download_id) { return false; }
    // Announce first, then mark: after the mark, run_ytdlp's own error/complete
    // events are suppressed, so this is the only outcome the UI sees.
    let _ = app.emit("download:error", serde_json::json!({
        "download_id": download_id,
        "message": "Cancelled",
    }));
    cancelled_downloads().lock().unwrap().insert(download_id.to_string());
    let pid = active_pids().lock().unwrap().remove(download_id);
    log::info!(target: "Download", "cancel_running pid={pid:?} download_id={download_id}");
    if let Some(pid) = pid { kill_process_tree(pid); }
    true
}

#[tauri::command]
pub fn cancel_download(download_id: String, app: AppHandle) -> Result<(), String> {
    cancel_download_by_id(&app, &download_id);
    Ok(())
}

// ─── Shared types ────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct AppInfo {
    pub platform: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Inspiration {
    pub id: String,
    pub r#type: String,
    pub title: Option<String>,
    pub source_url: Option<String>,
    pub source_platform: Option<String>,
    pub stored_path: String,
    pub thumbnail_path: Option<String>,
    pub aspect_ratio: f64,
    pub palette: Option<String>,
    pub ocr_text: String,
    pub ocr_status: Option<String>,
    pub ocr_language: Option<String>,
    pub file_hash: Option<String>,
    pub phash: Option<String>,
    pub phash_source: Option<String>,
    pub vault_id: Option<String>,
    pub mime_type: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub auto_tag_status: Option<String>,
    /// The item's tag suggestions: the `lens_suggestions` column (tagging.rs). The page reads them
    /// under this field's old JSON name, so its readers stay as they are. The old column
    /// `auto_tag_confidence` is never read: older versions show its keys as tag names.
    #[serde(rename = "auto_tag_confidence")]
    pub lens_suggestions: Option<String>,
    pub auto_tag_model: Option<String>,
    #[serde(default)]
    pub duration_secs: Option<f64>,
    #[serde(default)]
    pub collection_names: Option<String>,
    #[serde(default)]
    pub enhanced_path: Option<String>,
    /// The Tag lens scoring signature that wrote `lens_suggestions`: NULL while the item hasn't
    /// been scored with the installed lenses yet (tagging::signature).
    #[serde(default)]
    pub auto_tag_sig: Option<String>,
    /// The picture shows a crop made with Save, and its first original is kept: "Restore original"
    /// can bring it back (crop.rs). The paths themselves never go to the page.
    #[serde(default)]
    pub has_original: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub visible_on_home: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub preview_paths: Option<String>,
    #[serde(default)]
    pub item_count: i64,
    #[serde(default)]
    pub locked: bool,
}

/// A tag as the page sees it — the same shape as tagging::TagOut. A lens tag (source `lens`) has
/// a `concept_id`, and its visible name is `labels` in the app's language, never `name`. So has a
/// people's tag with a lens tag's name (one name, one tag: tagging.rs), which keeps its own name.
#[derive(Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub source: String,
    pub created_at: i64,
    pub usage_count: i64,
    #[serde(default)]
    pub concept_id: Option<String>,
    #[serde(default)]
    pub labels: Option<crate::lenses::I18n>,
}

/// Columns: id, name, source, created_at, usage_count, concept_id, concepts.labels_json.
fn row_to_tag(row: &rusqlite::Row) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: row.get(0)?, name: row.get(1)?, source: row.get(2)?, created_at: row.get(3)?, usage_count: row.get(4)?,
        concept_id: row.get(5)?,
        labels: row.get::<_, Option<String>>(6)?.as_deref().and_then(crate::lenses::parse_labels),
    })
}

#[derive(Serialize, Deserialize)]
pub struct Milestone {
    pub id: String,
    pub r#type: String,
    pub achieved_at: i64,
    pub certificate_shown: bool,
    pub shared: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    pub r#type: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub data: Option<String>,
    pub created_at: i64,
    pub read: bool,
}

#[derive(Serialize, Deserialize)]
pub struct DuplicatePair {
    pub id: String,
    pub inspiration_id_a: String,
    pub inspiration_id_b: String,
    pub match_type: String,
    pub similarity_score: f64,
    pub reviewed: bool,
    pub dismissed: bool,
    pub detected_at: i64,
}

#[derive(Serialize, Deserialize)]
pub struct LicenseCache {
    pub license_key: Option<String>,
    pub plan_type: Option<String>,
    pub expires_at: Option<i64>,
    pub last_validated_at: Option<i64>,
    pub device_fingerprint: Option<String>,
    pub revoked_at: Option<i64>,
}

#[derive(Serialize, Deserialize)]
pub struct OcrStats {
    pub total: i64,
    pub done: i64,
    pub pending: i64,
    pub failed: i64,
    pub skipped: i64,
}

#[derive(Serialize, Deserialize)]
pub struct VaultInfo {
    pub path: String,
    pub default_path: String,
    pub total_items: i64,
    pub size_bytes: u64,
    pub disk_free_bytes: u64,
    pub is_default: bool,
}

#[derive(Serialize, Deserialize)]
pub struct RelocateResult {
    pub new_path: String,
    pub files_moved: u64,
}

// ─── Import ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ImportResult {
    pub imported: Vec<Inspiration>,
    pub skipped:  Vec<String>,     // couldn't be imported (unsupported, unreadable, copy failed)
    /// Already in the library (same file bytes): the id of the item that's there, so the
    /// UI can say so and open it instead of looking like the import silently failed.
    pub existing: Vec<String>,
}

#[tauri::command]
pub fn import_files(
    paths: Vec<String>,
    import_source: Option<String>,
    app: AppHandle,
    state: State<AppState>,
) -> Result<ImportResult, String> {
    log::info!(target: "Import", "start count={}", paths.len());
    let src_label = import_source.as_deref().unwrap_or("file_import");
    let vault_path = vault::get_vault_path(&app).map_err(|e| e.to_string())?;
    vault::ensure_structure(&vault_path).map_err(|e| e.to_string())?;

    let mut imported = Vec::new();
    let mut skipped  = Vec::new();
    let mut existing = Vec::new();

    let probe_video = |p: &std::path::Path| video_meta(p, &app);
    for path_str in paths {
        match import_one(&state.db, &vault_path, &path_str, src_label, &probe_video)? {
            ImportOne::Imported(item) => imported.push(item),
            ImportOne::Existing(id)   => existing.push(id),
            ImportOne::Skipped        => skipped.push(path_str),
        }
    }

    log::info!(target: "Import", "done imported={} skipped={}", imported.len(), skipped.len());
    Ok(ImportResult { imported, skipped, existing })
}

/// What import_one did with one file.
pub(crate) enum ImportOne {
    Imported(Inspiration),
    /// Already in the library: the id of the item with the same bytes (its file, or the kept first
    /// original of a cropped picture).
    Existing(String),
    /// Couldn't be imported (unsupported, unreadable, copy failed).
    Skipped,
}

/// One file into the library: guard → read → hash → dedupe → copy into the vault → palette →
/// ratio → insert. import_files runs it for each file, and crop's "Save as copy" for its cut.
/// `probe_video` gives a video's length and shape (video_meta). A refused insert is an error.
pub(crate) fn import_one(
    db: &Mutex<rusqlite::Connection>,
    vault_path: &std::path::Path,
    path_str: &str,
    src_label: &str,
    probe_video: &dyn Fn(&std::path::Path) -> (Option<f64>, Option<f64>),
) -> Result<ImportOne, String> {
    let src = std::path::Path::new(path_str);

    let validated = match crate::media_guard::validate_path(src) {
        Ok(v)  => v,
        Err(e) => {
            log::warn!(target: "Import", "guard_rejected path={path_str:?} error={e}");
            return Ok(ImportOne::Skipped);
        }
    };
    let (file_type, subdir, mime) = (validated.db_type, validated.subdir, validated.mime);

    let content = match std::fs::read(src) {
        Ok(b) => b,
        Err(_) => return Ok(ImportOne::Skipped),
    };

    let hash = {
        let mut h = sha2::Sha256::new();
        h.update(&content);
        hex::encode(h.finalize())
    };

    // Exact duplicate: not imported again — reported as `existing` with the item's id. The first
    // original a cropped picture keeps counts too, so importing it again finds that item.
    {
        let db = db.lock().unwrap();
        let have: Option<String> = db.query_row(
            "SELECT id FROM inspirations WHERE file_hash = ?1 OR original_hash = ?1 LIMIT 1",
            params![hash],
            |r| r.get(0),
        ).ok();
        if let Some(id) = have {
            log::info!(target: "Import", "already_in_library path={path_str:?} id={id}");
            return Ok(ImportOne::Existing(id));
        }
    }

    let id = Uuid::new_v4().to_string();
    let dest_name = format!("{}.{}", id, validated.real_ext);
    let dest_path = vault_path.join(subdir).join(&dest_name);

    if std::fs::copy(src, &dest_path).is_err() {
        return Ok(ImportOne::Skipped);
    }

    let stored_path = dest_path.to_string_lossy().into_owned();
    let now = now_ms();

    // Videos have no pixels to OCR or sample for palette.
    let is_video     = file_type == "video";
    let ocr_status   = if is_video { Some("skipped") } else { None };
    let palette_json = if !is_video {
        let p = stored_path.clone();
        let colors = std::panic::catch_unwind(|| palette_from_path(&p, 5)).unwrap_or_default();
        if colors.is_empty() { None } else { serde_json::to_string(&colors).ok() }
    } else { None };
    let (duration, video_ratio) = if is_video { probe_video(&dest_path) } else { (None, None) };
    let aspect_ratio = new_item_ratio(is_video, &stored_path, video_ratio, validated.default_ratio);

    {
        let db = db.lock().unwrap();
        db.execute(
            "INSERT INTO inspirations \
             (id, type, stored_path, file_hash, mime_type, aspect_ratio, ocr_text, \
              ocr_status, palette, duration_secs, import_source, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,'',?7,?8,?9,?10,?11,?11)",
            params![id, file_type, stored_path, hash, mime, aspect_ratio, ocr_status, palette_json, duration, src_label, now],
        ).map_err(|e| e.to_string())?;
    }

    Ok(ImportOne::Imported(Inspiration {
        id,
        r#type: file_type.to_string(),
        title: None,
        source_url: None,
        source_platform: None,
        stored_path,
        thumbnail_path: None,
        aspect_ratio,
        palette: palette_json,
        ocr_text: String::new(),
        ocr_status: ocr_status.map(|s| s.to_string()),
        ocr_language: None,
        file_hash: Some(hash),
        phash: None,
        phash_source: None,
        vault_id: None,
        mime_type: Some(mime.to_string()),
        created_at: now,
        updated_at: now,
        auto_tag_status: None,
        lens_suggestions: None,
        auto_tag_model: None,
        duration_secs: duration,
        collection_names: None,
        enhanced_path: None,
        auto_tag_sig: None,
        has_original: false,
    }))
}

// ─── App ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        platform: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

// ─── Window controls ─────────────────────────────────────────────

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) {
    window.minimize().ok();
}

#[tauri::command]
pub fn window_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().ok();
    } else {
        window.maximize().ok();
    }
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) {
    window.close().ok();
}

#[tauri::command]
pub fn get_autostart() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
                KEY_READ,
            )
            .and_then(|key| key.get_value::<String, _>("qooti"))
            .is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        macos_launch_agent_path()
            .map(|p| p.exists())
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    false
}

#[tauri::command]
pub fn set_autostart(enabled: bool) {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        use winreg::RegKey;
        let Ok(run_key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
                KEY_SET_VALUE,
            )
        else { return };
        if enabled {
            if let Ok(exe) = std::env::current_exe() {
                // Quote the path: the Run value is parsed as a command line, so an
                // unquoted path with spaces (e.g. a username containing a space, like
                // "C:\Users\Windows 11\...\qooti.exe") fails to launch at login.
                let value = format!("\"{}\"", exe.to_string_lossy());
                let _ = run_key.set_value("qooti", &value);
            }
        } else {
            let _ = run_key.delete_value("qooti");
        }
    }
    #[cfg(target_os = "macos")]
    {
        let Some(plist_path) = macos_launch_agent_path() else { return };
        if enabled {
            let Ok(exe) = std::env::current_exe() else { return };
            let plist = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
                 <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
                 \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
                 <plist version=\"1.0\">\n\
                 <dict>\n\
                 \t<key>Label</key>\n\
                 \t<string>app.bloot.qooti</string>\n\
                 \t<key>ProgramArguments</key>\n\
                 \t<array>\n\
                 \t\t<string>{}</string>\n\
                 \t</array>\n\
                 \t<key>RunAtLoad</key>\n\
                 \t<true/>\n\
                 \t<key>KeepAlive</key>\n\
                 \t<false/>\n\
                 </dict>\n\
                 </plist>\n",
                exe.to_string_lossy()
            );
            if let Some(dir) = plist_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&plist_path, plist);
        } else {
            let _ = std::fs::remove_file(&plist_path);
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = enabled;
}

#[cfg(target_os = "macos")]
fn macos_launch_agent_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(std::path::Path::new(&home)
        .join("Library/LaunchAgents/app.bloot.qooti.plist"))
}

// ─── Settings ────────────────────────────────────────────────────

const SETTINGS_BLACKLIST: &[&str] = &["extension_connection_key", "extension_clients", "device_id"];
/// Readable but owned by the backend: `plan` comes from the verified licence ticket.
const SETTINGS_READ_ONLY: &[&str] = &["plan"];

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<HashMap<String, String>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare("SELECT key, value FROM preferences")
        .map_err(|e| e.to_string())?;

    let map: HashMap<String, String> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|(k, _)| !SETTINGS_BLACKLIST.contains(&k.as_str()))
        .collect();

    Ok(map)
}

#[tauri::command]
pub fn set_setting(key: String, value: String, state: State<AppState>, app: AppHandle) -> Result<(), String> {
    if SETTINGS_BLACKLIST.contains(&key.as_str()) || SETTINGS_READ_ONLY.contains(&key.as_str()) {
        return Err(format!("key '{key}' is not settable via this command"));
    }
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
    }
    // Tag suggestions switched: on → wake the indexer (video frames) and score what's stale;
    // either way Settings › Tag lens gets the new status.
    if key == crate::tagging::PREF_SWITCH {
        if value == "true" { crate::tagging::suggestions_turned_on(&app); } else { crate::tagging::emit_status(&app); }
    }
    // The tray menu follows the app's language at once
    if key == "language" {
        if let Some(tray) = app.try_state::<crate::TrayMenu>() {
            let (show, quit) = crate::tray_words(&value);
            let _ = tray.show.set_text(show);
            let _ = tray.quit.set_text(quit);
        }
    }
    Ok(())
}

/// Stable, random per-install identifier for license device-binding.
/// Generated once and persisted in `preferences.device_id` (blacklisted from the
/// generic settings get/set, so it never leaves the machine via export/sync).
/// This is a random UUID — NOT derived from any hardware — so we collect zero
/// hardware information while still giving each install a distinct identity.
#[tauri::command]
pub fn get_device_id(state: State<AppState>) -> Result<String, String> {
    let db = state.db.lock().unwrap();
    if let Ok(existing) = db.query_row(
        "SELECT value FROM preferences WHERE key = 'device_id'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }
    let id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT OR REPLACE INTO preferences (key, value) VALUES ('device_id', ?1)",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Coarse device label (OS family only — no hostname or serial) so the account's
/// device list is human-readable without collecting anything identifying.
#[tauri::command]
pub fn device_label() -> String {
    match std::env::consts::OS {
        "windows" => "Windows".to_string(),
        "macos"   => "macOS".to_string(),
        "linux"   => "Linux".to_string(),
        other     => other.to_string(),
    }
}

// ─── Inspirations ─────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ListInspirationsOpts {
    pub collection_id:  Option<String>,
    pub tag_ids:        Option<Vec<String>>,
    pub query:          Option<String>,
    #[serde(alias = "color")]
    pub color_filter:   Option<String>,
    pub color_tolerance: Option<String>, // "strict" | "normal" | "broad"
    pub media_types:    Option<Vec<String>>,
    pub sort:           Option<String>,  // "recent" → created_at DESC; None + no filters → RANDOM()
    pub page:           Option<u32>,
    pub limit:          Option<u32>,
    /// Only items that aren't in any collection (Collections page, "Not in a collection").
    pub uncollected:    Option<bool>,
}

/// Turn a raw user query into a safe FTS5 MATCH expression.
/// Each whitespace token that contains at least one alphanumeric char becomes a
/// double-quoted prefix term (`"tok"*`); internal quotes are escaped by doubling.
/// Tokens are space-joined → implicit AND. Returns "" when nothing usable
/// remains (e.g. all punctuation), in which case the caller skips the FTS term
/// entirely rather than issue an empty MATCH (which FTS5 rejects).
fn to_fts_query(q: &str) -> String {
    q.split_whitespace()
        .filter(|t| t.chars().any(|c| c.is_alphanumeric()))
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The apostrophes Uzbek is typed with (o‘, g‘ and the tutuq ’, also as ʻ ʼ or a backtick) all
/// search as the plain ', so "qo'shiq" finds "qo‘shiq" and the other way round. Also the rule's
/// last step for "the same tag name" (contract C7):
/// `fold_apostrophes(&name.trim().to_lowercase())`.
pub(crate) fn fold_apostrophes(s: &str) -> String {
    s.chars().map(|c| match c { '\u{2018}' | '\u{2019}' | '\u{02BB}' | '\u{02BC}' | '`' => '\'', c => c }).collect()
}

/// `fold_apostrophes(LOWER(expr))` in SQL.
fn fold_sql(expr: &str) -> String {
    format!("REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER({expr}), '\u{2018}', ''''), '\u{2019}', ''''), \
             '\u{02BB}', ''''), '\u{02BC}', ''''), '`', '''')")
}

/// Text search for list_inspirations: the condition and its `?` arguments, in order. Matches the
/// title and OCR text (through the FTS index) and the tags an item has: people's own tags by
/// their name, lens tags by their concept's label in either language (whatever the app's
/// language is; a people's tag that stands for a concept by both). Suggestions nobody accepted
/// never match (Tag lens spec §0.8).
fn search_condition(q: &str) -> (String, Vec<String>) {
    let like = format!("%{}%", fold_apostrophes(&q.to_lowercase()));
    let fts = to_fts_query(q);
    let mut ors: Vec<String> = Vec::with_capacity(2);
    let mut args: Vec<String> = Vec::with_capacity(4);
    if !fts.is_empty() {
        ors.push("rowid IN (SELECT rowid FROM inspirations_fts WHERE inspirations_fts MATCH ?)".into());
        args.push(fts);
    }
    ors.push(format!(
        "id IN (SELECT it.inspiration_id FROM inspiration_tags it \
                JOIN tags t ON t.id = it.tag_id \
                LEFT JOIN concepts c ON c.id = t.concept_id \
                WHERE ((t.concept_id IS NULL OR t.source IN ('user', 'import')) AND {name} LIKE ?) \
                   OR (t.concept_id IS NOT NULL AND json_valid(c.labels_json) AND ({en} LIKE ? OR {uz} LIKE ?)))",
        name = fold_sql("t.name"),
        en = fold_sql("json_extract(c.labels_json, '$.en')"),
        uz = fold_sql("json_extract(c.labels_json, '$.uz')"),
    ));
    args.extend([like.clone(), like.clone(), like]);
    (format!("({})", ors.join(" OR ")), args)
}

fn hex_to_rgb(hex: &str) -> Option<(i32, i32, i32)> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 { return None; }
    let r = i32::from_str_radix(&h[0..2], 16).ok()?;
    let g = i32::from_str_radix(&h[2..4], 16).ok()?;
    let b = i32::from_str_radix(&h[4..6], 16).ok()?;
    Some((r, g, b))
}

fn palette_has_color(palette_json: &str, target: (i32, i32, i32), threshold_sq: i32) -> bool {
    let colors: Vec<String> = serde_json::from_str(palette_json).unwrap_or_default();
    colors.iter().any(|c| {
        hex_to_rgb(c).map_or(false, |(r, g, b)| {
            let dr = target.0 - r; let dg = target.1 - g; let db = target.2 - b;
            dr*dr + dg*dg + db*db <= threshold_sq
        })
    })
}

#[tauri::command]
pub fn list_inspirations(
    opts: ListInspirationsOpts,
    state: State<AppState>,
) -> Result<Vec<Inspiration>, String> {
    let db = state.db.lock().unwrap();
    list_inspirations_with(&db, opts)
}

/// list_inspirations on one connection.
fn list_inspirations_with(db: &rusqlite::Connection, opts: ListInspirationsOpts) -> Result<Vec<Inspiration>, String> {
    let plan     = get_plan_from_db(db);
    let is_free  = is_free_plan(&plan);
    let per_page = opts.limit.unwrap_or(50) as usize;
    let page     = opts.page.unwrap_or(0) as usize;

    let mut wheres: Vec<String> = vec![];
    let mut args:   Vec<String> = vec![];

    // Collection filter
    if let Some(col_id) = &opts.collection_id {
        wheres.push("id IN (SELECT inspiration_id FROM collection_items WHERE collection_id = ?)".into());
        args.push(col_id.clone());
    }
    if opts.uncollected == Some(true) {
        wheres.push("id NOT IN (SELECT inspiration_id FROM collection_items)".into());
    }

    // Tag filter (AND: item must have ALL specified tags)
    if let Some(tag_ids) = &opts.tag_ids {
        if !tag_ids.is_empty() {
            let placeholders = tag_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            wheres.push(format!(
                "id IN (SELECT inspiration_id FROM inspiration_tags WHERE tag_id IN ({}) GROUP BY inspiration_id HAVING COUNT(DISTINCT tag_id) = {})",
                placeholders, tag_ids.len()
            ));
            for t in tag_ids { args.push(t.clone()); }
        }
    }

    // Media-type filter (Images = image+gif, Videos = video). Sent by the media
    // filter button next to the colour picker. Args pushed here so their order
    // stays collection → tag → media → query, matching the WHERE join order.
    if let Some(types) = &opts.media_types {
        if !types.is_empty() {
            let placeholders = types.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            wheres.push(format!("type IN ({})", placeholders));
            for ty in types { args.push(ty.clone()); }
        }
    }

    // Text search: title + OCR (via FTS5) + the tags items have (search_condition). Pushed
    // last, so its `?` arguments stay in step with the WHERE order.
    if let Some(q) = &opts.query {
        let (cond, q_args) = search_condition(q);
        wheres.push(cond);
        args.extend(q_args);
    }

    let where_clause = if wheres.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", wheres.join(" AND "))
    };

    // "recent" sort → newest first. Unfiltered home view → random (fresh every open).
    // Everything else (collection, tag, search, color filters) → newest first.
    let is_unfiltered = opts.collection_id.is_none()
        && opts.tag_ids.as_ref().map_or(true, |v| v.is_empty())
        && opts.query.is_none()
        && opts.color_filter.is_none()
        && opts.media_types.as_ref().map_or(true, |v| v.is_empty());
    let order_by = if opts.sort.as_deref() == Some("recent") {
        "created_at DESC"
    } else if is_unfiltered {
        "RANDOM()"
    } else {
        "created_at DESC"
    };

    let color_target = opts.color_filter.as_deref().and_then(hex_to_rgb);

    // ── Color-filtered path ──────────────────────────────────────────
    // Palette is JSON text, not directly queryable, so colour matching happens
    // in Rust. Two phases keep it cheap: (1) scan only id+palette across ALL
    // matching rows in display order — skipping the per-row collection_names
    // subquery — colour-filter, then paginate the surviving ids; (2) fetch full
    // rows for just that page. Replaces the old "fetch 5000 full rows and
    // post-filter" approach, which silently dropped matches past the 5000 cap.
    if let Some(target) = color_target {
        let threshold_sq = match opts.color_tolerance.as_deref().unwrap_or("normal") {
            "strict" => 3000,
            "broad"  => 50000,
            _        => 20000,
        };

        let cand_sql = format!(
            "SELECT id, palette FROM inspirations {} ORDER BY {}",
            where_clause, order_by
        );
        let matched_ids: Vec<String> = {
            let mut stmt = db.prepare(&cand_sql).map_err(|e| e.to_string())?;
            let ids = stmt
                .query_map(
                    rusqlite::params_from_iter(args.iter().map(|s| s.as_str())),
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .filter(|(_, palette)| {
                    palette.as_deref()
                        .map_or(false, |p| palette_has_color(p, target, threshold_sq))
                })
                .map(|(id, _)| id)
                .skip(page * per_page)
                .take(per_page)
                .collect();
            ids
        };

        if matched_ids.is_empty() {
            return Ok(vec![]);
        }

        // Fetch full rows (incl. collection_names) for just this page's ids.
        let placeholders = matched_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let full_sql = format!("{} WHERE id IN ({})", INSP_SELECT, placeholders);
        let mut by_id: HashMap<String, Inspiration> = {
            let mut stmt = db.prepare(&full_sql).map_err(|e| e.to_string())?;
            let map = stmt.query_map(
                rusqlite::params_from_iter(matched_ids.iter().map(|s| s.as_str())),
                row_to_inspiration,
            )
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .map(|i| (i.id.clone(), i))
            .collect();
            map
        };

        // WHERE id IN (...) doesn't preserve order — restore the matched order.
        let rows: Vec<Inspiration> =
            matched_ids.iter().filter_map(|id| by_id.remove(id)).collect();
        return Ok(rows);
    }

    // ── Normal path ──────────────────────────────────────────────────
    let (sql_limit, sql_offset) = if is_free {
        // Free plan: always return at most FREE_ITEM_LIMIT + FREE_ITEM_TEASER items,
        // starting from the beginning (no pagination for free users).
        ((FREE_ITEM_LIMIT + FREE_ITEM_TEASER) as i64, 0i64)
    } else {
        (per_page as i64, (page * per_page) as i64)
    };

    let sql = format!(
        "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, lens_suggestions, auto_tag_model,
                duration_secs,
                (SELECT json_group_array(c.name)
                 FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names, enhanced_path, auto_tag_sig, (original_path IS NOT NULL) AS has_original
         FROM inspirations
         {}
         ORDER BY {}
         LIMIT {} OFFSET {}",
        where_clause, order_by, sql_limit, sql_offset
    );

    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<Inspiration> = stmt
        .query_map(rusqlite::params_from_iter(args.iter().map(|s| s.as_str())), row_to_inspiration)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

#[tauri::command]
pub fn get_inspiration(id: String, state: State<AppState>) -> Result<Inspiration, String> {
    let db = state.db.lock().unwrap();
    load_inspiration(&db, &id).map_err(|e| e.to_string())
}

/// One item with everything the page shows, `auto_tag_sig` included (it tells "not scored yet"
/// apart from "scored, nothing to suggest"), and `has_original`.
pub(crate) fn load_inspiration(db: &rusqlite::Connection, id: &str) -> rusqlite::Result<Inspiration> {
    db.query_row(
        "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, lens_suggestions, auto_tag_model,
                duration_secs,
                (SELECT json_group_array(c.name)
                 FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names, enhanced_path, auto_tag_sig, (original_path IS NOT NULL) AS has_original
         FROM inspirations WHERE id = ?1",
        params![id],
        row_to_inspiration,
    )
}

#[tauri::command]
pub fn update_inspiration(id: String, title: Option<String>, palette: Option<String>, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let now = now_ms();
    if let Some(t) = title {
        db.execute("UPDATE inspirations SET title = ?1, updated_at = ?2 WHERE id = ?3", params![t, now, id]).map_err(|e| e.to_string())?;
    }
    if let Some(p) = palette {
        db.execute("UPDATE inspirations SET palette = ?1, updated_at = ?2 WHERE id = ?3", params![p, now, id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_inspiration(id: String, state: State<AppState>) -> Result<(), String> {
    delete_inspiration_with(&state.db, &id)
}

/// delete_inspiration on one database: the row, then the item's files — its file, its thumbnail,
/// the first original a cropped picture keeps, and the upscaled copy.
fn delete_inspiration_with(db: &Mutex<rusqlite::Connection>, id: &str) -> Result<(), String> {
    // Fetch file paths before touching the DB so we know what to clean up.
    let (stored_path, thumbnail_path, original_path, enhanced_path): (String, Option<String>, Option<String>, Option<String>) = {
        let db = db.lock().unwrap();
        db.query_row(
            "SELECT stored_path, thumbnail_path, original_path, enhanced_path FROM inspirations WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|e| e.to_string())?
    };

    {
        let db = db.lock().unwrap();
        delete_item_row(&db, id).map_err(|e| e.to_string())?;
    } // release DB lock before file I/O

    // Delete the main file — ignore "not found" (already gone is fine)
    if let Err(e) = std::fs::remove_file(&stored_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!(target: "Library", "delete_failed path={:?} error={e}", stored_path);
        }
    }

    // Delete the thumbnail only if it is a separate file
    if let Some(thumb) = thumbnail_path {
        if thumb != stored_path {
            if let Err(e) = std::fs::remove_file(&thumb) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(target: "Library", "delete_thumb_failed path={:?} error={e}", thumb);
                }
            }
        }
    }

    // The first original a cropped picture keeps, and the upscaled copy, go with the item
    for extra in [original_path, enhanced_path].into_iter().flatten() {
        if extra.is_empty() || extra == stored_path { continue; }
        if let Err(e) = std::fs::remove_file(&extra) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!(target: "Library", "delete_extra_failed path={:?} error={e}", extra);
            }
        }
    }

    Ok(())
}

/// Delete one item's row (its tag links, answers and collection places go with it, by cascade),
/// then tidy the tags it had.
fn delete_item_row(db: &rusqlite::Connection, id: &str) -> rusqlite::Result<()> {
    let tag_ids = query_ids(db, "SELECT tag_id FROM inspiration_tags WHERE inspiration_id = ?1", id)?;
    db.execute("DELETE FROM inspirations WHERE id = ?1", params![id])?;
    tidy_tags_after_delete(db, &tag_ids);
    Ok(())
}

/// Delete the rows of every item in a collection, then tidy the tags they had.
fn delete_collection_item_rows(db: &rusqlite::Connection, collection_id: &str) -> rusqlite::Result<()> {
    let tag_ids = query_ids(db,
        "SELECT DISTINCT it.tag_id FROM inspiration_tags it
         JOIN collection_items ci ON ci.inspiration_id = it.inspiration_id
         WHERE ci.collection_id = ?1",
        collection_id)?;
    db.execute(
        "DELETE FROM inspirations WHERE id IN (SELECT inspiration_id FROM collection_items WHERE collection_id = ?1)",
        params![collection_id],
    )?;
    tidy_tags_after_delete(db, &tag_ids);
    Ok(())
}

/// The ids a query with one `?1` parameter returns.
fn query_ids(db: &rusqlite::Connection, sql: &str, param: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = db.prepare(sql)?;
    let ids = stmt.query_map(params![param], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

/// After items were deleted, for the tags they had: a lens tag that no item has any more is
/// removed (tagging::ensure_concept_tag makes it again whenever it's needed), and every other
/// tag's count is set from the links that are left. People's own tags (source user / import) are
/// never removed, even when no item has them any more: tags can't be typed (Tag lens decision 6),
/// so a removed one could never be made again. Tags the deleted items didn't have are left alone.
/// Best effort: a failure is logged and the delete itself stands.
fn tidy_tags_after_delete(db: &rusqlite::Connection, tag_ids: &[String]) {
    let unique: HashSet<&String> = tag_ids.iter().collect();
    for id in unique {
        let dropped = db.execute(
            "DELETE FROM tags WHERE id = ?1 AND source = 'lens'
               AND NOT EXISTS (SELECT 1 FROM inspiration_tags WHERE tag_id = ?1)",
            params![id],
        );
        match dropped {
            Ok(0) => recount_tags(db, std::slice::from_ref(id)),
            Ok(_) => {
                // Its count goes by cascade; this covers a connection without foreign keys.
                if let Err(e) = db.execute("DELETE FROM tag_usage_counts WHERE tag_id = ?1", params![id]) {
                    log::warn!(target: "Tags", "count of a removed lens tag not cleared: {e}");
                }
            }
            Err(e) => log::warn!(target: "Tags", "unused lens tag not removed: {e}"),
        }
    }
}

// Saves a JPEG thumbnail (generated by the frontend canvas) to the vault's
// thumbnails/ directory and records the path in the DB. Called once per video
// item; subsequent renders use the stored path instead of decoding the video.
#[tauri::command]
pub fn save_thumbnail(
    id: String,
    bytes: Vec<u8>,
    app: AppHandle,
    state: State<AppState>,
) -> Result<String, String> {
    if bytes.is_empty() { return Err("empty bytes".into()); }
    let vault_path = vault::get_vault_path(&app).map_err(|e| e.to_string())?;
    let filename   = format!("{}_thumb.jpg", id);
    let thumb_path = vault_path.join("thumbnails").join(&filename);
    std::fs::write(&thumb_path, &bytes).map_err(|e| e.to_string())?;
    let path_str = thumb_path.to_string_lossy().into_owned();
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "UPDATE inspirations SET thumbnail_path = ?1, updated_at = strftime('%s','now') WHERE id = ?2",
            params![path_str, id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(path_str)
}

fn row_to_inspiration(row: &rusqlite::Row) -> rusqlite::Result<Inspiration> {
    Ok(Inspiration {
        id:                   row.get(0)?,
        r#type:               row.get(1)?,
        title:                row.get(2)?,
        source_url:           row.get(3)?,
        source_platform:      row.get(4)?,
        stored_path:          row.get(5)?,
        thumbnail_path:       row.get(6)?,
        aspect_ratio:         row.get(7)?,
        palette:              row.get(8)?,
        ocr_text:             row.get(9)?,
        ocr_status:           row.get(10)?,
        ocr_language:         row.get(11)?,
        file_hash:            row.get(12)?,
        phash:                row.get(13)?,
        phash_source:         row.get(14)?,
        vault_id:             row.get(15)?,
        mime_type:            row.get(16)?,
        created_at:           row.get(17)?,
        updated_at:           row.get(18)?,
        auto_tag_status:      row.get(19)?,
        lens_suggestions:     row.get(20)?,
        auto_tag_model:       row.get(21)?,
        duration_secs:        row.get(22).ok(),
        collection_names:     row.get(23).ok(),
        enhanced_path:        row.get("enhanced_path").ok(),
        // By name: None for the queries that don't select it
        auto_tag_sig:         row.get::<_, Option<String>>("auto_tag_sig").ok().flatten(),
        // By name: false for the lean queries (OCR / object claims) that don't select it
        has_original:         row.get::<_, Option<bool>>("has_original").ok().flatten().unwrap_or(false),
    })
}

#[tauri::command]
pub fn read_image_as_base64(path: String, app: AppHandle) -> Result<String, String> {
    // Same folders the window may load files from — never an arbitrary file.
    if !app.asset_protocol_scope().is_allowed(&path) {
        return Err("not allowed".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes))
}

// ─── OCR ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn claim_ocr_index_candidates(
    batch_size: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<Inspiration>, String> {
    let db = state.db.lock().unwrap();
    let size = batch_size.unwrap_or(10);

    db.execute_batch("BEGIN;").map_err(|e| e.to_string())?;

    let ids: Vec<String> = {
        let mut stmt = db
            .prepare(
                "SELECT id FROM inspirations
                 WHERE (ocr_status IS NULL OR ocr_status = 'processing') AND type IN ('image','gif')
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let result: Vec<String> = stmt
            .query_map(params![size], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        result
    };

    if ids.is_empty() {
        db.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }

    for id in &ids {
        db.execute(
            "UPDATE inspirations SET ocr_status = 'processing' WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }

    db.execute_batch("COMMIT;").map_err(|e| e.to_string())?;

    let placeholders: String = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");

    let sql = format!(
        "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, lens_suggestions, auto_tag_model,
                duration_secs
         FROM inspirations WHERE id IN ({})",
        placeholders
    );

    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<Inspiration> = {
        let r: Vec<Inspiration> = stmt
            .query_map(
                rusqlite::params_from_iter(ids.iter().map(|s| s.as_str())),
                row_to_inspiration,
            )
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        r
    };

    Ok(rows)
}

#[derive(Deserialize)]
pub struct OcrResult {
    pub id: String,
    pub ocr_text: String,
    pub ocr_language: Option<String>,
    pub status: String,
    /// The file that was read (the claim's stored_path). None from a page that doesn't send it.
    #[serde(default)]
    pub stored_path: Option<String>,
}

#[tauri::command]
pub fn finalize_ocr_index_result(result: OcrResult, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    finalize_ocr(&db, &result).map(|_| ()).map_err(|e| e.to_string())
}

/// Write one OCR result, only while the item still shows the file that was read: a crop or a
/// restore meanwhile reset its text (ocr_status NULL), and the words of the old picture must not
/// come back over the new one, nor mark it done (or failed) so it's never read. The next claim
/// reads the new file. → whether the result was written.
fn finalize_ocr(db: &rusqlite::Connection, result: &OcrResult) -> rusqlite::Result<bool> {
    let n = db.execute(
        "UPDATE inspirations SET ocr_text = ?1, ocr_language = ?2, ocr_status = ?3
         WHERE id = ?4 AND (?5 IS NULL OR stored_path = ?5)",
        params![result.ocr_text, result.ocr_language, result.status, result.id, result.stored_path],
    )?;
    if n == 0 && result.stored_path.is_some() {
        log::debug!(target: "OCR", "id={} shows another file now: the old text was dropped", result.id);
    }
    Ok(n > 0)
}

// ─── Object/content detection (for keyword search) ──────────────────────────
// Same claim/finalize shape as OCR: claim a batch of un-analysed images, mark them
// 'processing', hand them to the CLIP worker (JS), then write back the detected labels.
#[tauri::command]
pub fn claim_object_candidates(batch_size: Option<i64>, state: State<AppState>) -> Result<Vec<Inspiration>, String> {
    let db = state.db.lock().unwrap();
    let size = batch_size.unwrap_or(4);

    db.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
    let ids: Vec<String> = {
        let mut stmt = db.prepare(
            "SELECT id FROM inspirations
             WHERE (object_status IS NULL OR object_status = 'processing') AND type IN ('image','gif')
             LIMIT ?1",
        ).map_err(|e| e.to_string())?;
        let result: Vec<String> = stmt.query_map(params![size], |row| row.get(0))
            .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        result
    };
    if ids.is_empty() {
        db.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }
    for id in &ids {
        db.execute("UPDATE inspirations SET object_status = 'processing' WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    db.execute_batch("COMMIT;").map_err(|e| e.to_string())?;

    let placeholders: String = ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, lens_suggestions, auto_tag_model, duration_secs
         FROM inspirations WHERE id IN ({})", placeholders);
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<Inspiration> = stmt
        .query_map(rusqlite::params_from_iter(ids.iter().map(|s| s.as_str())), row_to_inspiration)
        .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[tauri::command]
pub fn finalize_object_result(id: String, object_tags: String, status: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE inspirations SET object_tags = ?1, object_status = ?2 WHERE id = ?3",
        params![object_tags, status, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reset_ocr_status_for_inspiration(id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE inspirations SET ocr_status = NULL, ocr_text = '' WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn queue_full_ocr_reindex(state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute_batch("UPDATE inspirations SET ocr_status = NULL, ocr_text = '' WHERE type IN ('image','gif')")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_ocr_index_stats(state: State<AppState>) -> Result<OcrStats, String> {
    let db = state.db.lock().unwrap();
    let total:   i64 = db.query_row("SELECT COUNT(*) FROM inspirations WHERE type IN ('image','gif')", [], |r| r.get(0)).unwrap_or(0);
    let done:    i64 = db.query_row("SELECT COUNT(*) FROM inspirations WHERE ocr_status = 'done'", [], |r| r.get(0)).unwrap_or(0);
    let pending: i64 = db.query_row("SELECT COUNT(*) FROM inspirations WHERE ocr_status IS NULL AND type IN ('image','gif')", [], |r| r.get(0)).unwrap_or(0);
    let failed:  i64 = db.query_row("SELECT COUNT(*) FROM inspirations WHERE ocr_status = 'failed'", [], |r| r.get(0)).unwrap_or(0);
    let skipped: i64 = db.query_row("SELECT COUNT(*) FROM inspirations WHERE ocr_status = 'skipped'", [], |r| r.get(0)).unwrap_or(0);
    Ok(OcrStats { total, done, pending, failed, skipped })
}

// ─── Tag suggestions ─────────────────────────────────────────────
// Scored in Rust from stored CLIP vectors (tagging.rs); lens files and their commands are in
// lenses.rs; video frames in frames.rs, read by the CLIP indexer (clip.rs).

// ─── File system ─────────────────────────────────────────────────

#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        hidden_command("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("reveal: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        hidden_command("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("reveal: {}", e))?;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .unwrap_or(std::path::Path::new("/"));
        hidden_command("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("reveal: {}", e))?;
    }
    Ok(())
}

// ─── Copy file to OS clipboard ───────────────────────────────────

#[tauri::command]
pub fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
        let script  = format!("set the clipboard to POSIX file \"{}\"", escaped);
        let out = hidden_command("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("copy_file_to_clipboard: {}", e))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    #[cfg(windows)]
    {
        // Use PowerShell + System.Windows.Forms to put the file on the clipboard
        // as a CF_HDROP (pasteable in Explorer with Ctrl+V).
        let escaped = path.replace('\'', "''");
        let script  = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $c = New-Object System.Collections.Specialized.StringCollection; \
             $c.Add('{}'); \
             [System.Windows.Forms.Clipboard]::SetFileDropList($c)",
            escaped
        );
        let out = hidden_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", &script])
            .output()
            .map_err(|e| format!("copy_file_to_clipboard: {}", e))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = path;
        return Err("copy to clipboard not supported on this platform".into());
    }
    Ok(())
}

// ─── File copy ───────────────────────────────────────────────────

#[tauri::command]
pub fn copy_file_to_folder(path: String, dest_dir: String) -> Result<String, String> {
    let src  = std::path::Path::new(&path);
    let name = src.file_name().ok_or_else(|| "invalid source path".to_string())?;
    let mut dest = std::path::Path::new(&dest_dir).join(name);
    // Resolve name conflicts: file.mp4 → file_1.mp4 → file_2.mp4 …
    if dest.exists() {
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext  = src.extension().and_then(|s| s.to_str()).unwrap_or("");
        let mut i = 1u32;
        loop {
            let new_name = if ext.is_empty() {
                format!("{}_{}", stem, i)
            } else {
                format!("{}_{}.{}", stem, i, ext)
            };
            dest = std::path::Path::new(&dest_dir).join(&new_name);
            if !dest.exists() { break; }
            i += 1;
            if i > 999 { return Err("too many name conflicts in destination folder".into()); }
        }
    }
    std::fs::copy(&path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

// ─── Collections ─────────────────────────────────────────────────

#[tauri::command]
pub fn list_collections(state: State<AppState>) -> Result<Vec<Collection>, String> {
    let db = state.db.lock().unwrap();
    let plan = get_plan_from_db(&db);
    let free = is_free_plan(&plan);
    let mut stmt = db.prepare(
        "SELECT c.id, c.name, c.visible_on_home, c.created_at, c.updated_at,
            (SELECT json_group_array(sub.path)
             FROM (SELECT COALESCE(i.thumbnail_path, i.stored_path) AS path
                   FROM collection_items ci
                   JOIN inspirations i ON i.id = ci.inspiration_id
                   WHERE ci.collection_id = c.id AND i.type IN ('image', 'gif', 'video')
                   ORDER BY CASE i.type WHEN 'image' THEN 0 WHEN 'gif' THEN 1 ELSE 2 END,
                            ci.created_at DESC LIMIT 3) AS sub
            ) AS preview_paths,
            (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
         FROM collections c ORDER BY c.created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<Collection> = stmt.query_map([], |row| Ok(Collection {
        id: row.get(0)?, name: row.get(1)?,
        visible_on_home: row.get::<_, i64>(2)? != 0,
        created_at: row.get(3)?, updated_at: row.get(4)?,
        preview_paths: row.get(5).ok(),
        item_count: row.get(6).unwrap_or(0),
        locked: false,
    })).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    if !free {
        return Ok(rows);
    }

    // On free plan: the 3 oldest collections (smallest created_at) are editable;
    // everything beyond that is locked (read-only).
    let mut sorted_by_age: Vec<i64> = rows.iter().map(|c| c.created_at).collect();
    sorted_by_age.sort_unstable();
    let cutoff = sorted_by_age.get(FREE_COLLECTION_LIMIT as usize).copied();

    Ok(rows.into_iter().map(|mut c| {
        if let Some(cut) = cutoff {
            c.locked = c.created_at >= cut;
        }
        c
    }).collect())
}

#[tauri::command]
pub fn create_collection(name: String, state: State<AppState>) -> Result<Collection, String> {
    let db = state.db.lock().unwrap();

    let plan = get_plan_from_db(&db);
    if is_free_plan(&plan) {
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM collections", [], |r| r.get(0)
        ).unwrap_or(0);
        if count >= FREE_COLLECTION_LIMIT as i64 {
            return Err("UPGRADE_REQUIRED:collections_limit".to_string());
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    db.execute("INSERT INTO collections (id, name, visible_on_home, created_at, updated_at) VALUES (?1,?2,1,?3,?3)", params![id, name, now]).map_err(|e| e.to_string())?;
    Ok(Collection { id, name, visible_on_home: true, created_at: now, updated_at: now, preview_paths: None, item_count: 0, locked: false })
}

#[tauri::command]
pub fn update_collection(id: String, name: Option<String>, visible_on_home: Option<bool>, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    // Renaming a locked collection is blocked; toggling visibility is always allowed.
    if name.is_some() && is_collection_locked(&db, &id) {
        return Err("UPGRADE_REQUIRED:collection_locked".to_string());
    }
    let now = now_ms();
    if let Some(n) = name {
        db.execute("UPDATE collections SET name = ?1, updated_at = ?2 WHERE id = ?3", params![n, now, id]).map_err(|e| e.to_string())?;
    }
    if let Some(v) = visible_on_home {
        db.execute("UPDATE collections SET visible_on_home = ?1, updated_at = ?2 WHERE id = ?3", params![v as i64, now, id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_collection(id: String, delete_items: bool, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let vault_path = if delete_items { vault::get_vault_path(&app).ok() } else { None };
    delete_collection_with(&state.db, vault_path.as_deref(), &id, delete_items)
}

/// delete_collection on one database; `vault_path` resolves relative thumbnail paths.
fn delete_collection_with(
    db: &Mutex<rusqlite::Connection>,
    vault_path: Option<&std::path::Path>,
    id: &str,
    delete_items: bool,
) -> Result<(), String> {
    if delete_items {
        // Collect every file of every item in this collection: the file, the thumbnail, the first
        // original a cropped picture keeps, and the upscaled copy
        let files: Vec<(String, Option<String>, Option<String>, Option<String>)> = {
            let db = db.lock().unwrap();
            let mut stmt = db.prepare(
                "SELECT i.stored_path, i.thumbnail_path, i.original_path, i.enhanced_path \
                 FROM inspirations i \
                 JOIN collection_items ci ON ci.inspiration_id = i.id \
                 WHERE ci.collection_id = ?1"
            ).map_err(|e| e.to_string())?;
            let rows: Vec<_> = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };

        // Delete inspiration records (collection_items cascade-delete automatically) and set the
        // counts of the tags they had (lens tags no item has any more are removed)
        {
            let db = db.lock().unwrap();
            delete_collection_item_rows(&db, id).map_err(|e| e.to_string())?;
        }

        // Remove physical files from disk (best-effort — ignore individual errors)
        for (stored, thumb, original, enhanced) in &files {
            std::fs::remove_file(stored).ok();
            if let Some(t) = thumb {
                // thumbnail_path may be relative to vault
                let abs = if std::path::Path::new(t).is_absolute() {
                    std::path::PathBuf::from(t)
                } else {
                    vault_path.map(|v| v.join(t)).unwrap_or_default()
                };
                std::fs::remove_file(&abs).ok();
            }
            for extra in [original, enhanced].into_iter().flatten() {
                if !extra.is_empty() && extra != stored { std::fs::remove_file(extra).ok(); }
            }
        }
    }

    let db = db.lock().unwrap();
    db.execute("DELETE FROM collections WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_collection(
    collection_id: String,
    save_path: String,
    state: State<AppState>,
) -> Result<(), String> {
    use zip::write::FileOptions;
    use zip::CompressionMethod;

    // Phase 1: gather all data (hold DB lock only during queries)
    let (col_name, items, tags_map, extras) = {
        let db = state.db.lock().unwrap();

        let col_name: String = db.query_row(
            "SELECT name FROM collections WHERE id = ?1",
            params![collection_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        let items: Vec<(String, Option<String>, String, Option<String>, String,
                        Option<String>, Option<String>, i64, Option<String>)> = {
            let mut stmt = db.prepare(
                "SELECT i.id, i.title, i.type, i.mime_type, i.stored_path,
                        i.source_url, i.source_platform, i.created_at, i.ocr_text
                 FROM collection_items ci
                 JOIN inspirations i ON i.id = ci.inspiration_id
                 WHERE ci.collection_id = ?1
                 ORDER BY ci.created_at DESC"
            ).map_err(|e| e.to_string())?;
            let rows: Vec<_> = stmt.query_map(params![collection_id], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok()).collect();
            rows
        };

        let tags_map = pack_tags(&db, Some(collection_id.as_str())).map_err(|e| e.to_string())?;

        let extras: HashMap<String, PackExtras> = items.iter()
            .filter_map(|it| pack_extras(&db, &it.0).map(|ex| (it.0.clone(), ex)))
            .collect();

        (col_name, items, tags_map, extras)
    }; // DB lock released

    // Phase 2: build manifest JSON
    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let mut manifest_items = Vec::new();
    let mut media_entries: Vec<(String, String)> = Vec::new();

    for (id, title, item_type, mime_type, stored_path,
         source_url, source_platform, created_at, ocr_text) in &items {
        let ext = std::path::Path::new(stored_path)
            .extension().and_then(|e| e.to_str()).unwrap_or("bin");
        let file_in_zip = format!("media/{}.{}", id, ext);
        let tags = tags_map.get(id).cloned().unwrap_or_default();

        let mut entry = serde_json::json!({
            "id": id, "type": item_type,
            "created_at": created_at, "file": file_in_zip,
        });
        pack_put_tags(&mut entry, tags);
        if let Some(v) = title          { entry["title"]           = serde_json::json!(v); }
        if let Some(v) = mime_type      { entry["mime_type"]        = serde_json::json!(v); }
        if let Some(v) = source_url     { entry["source_url"]       = serde_json::json!(v); }
        if let Some(v) = source_platform{ entry["source_platform"]  = serde_json::json!(v); }
        if let Some(v) = ocr_text       { entry["ocr_text"]         = serde_json::json!(v); }

        media_entries.push((file_in_zip, stored_path.clone()));
        if let Some(ex) = extras.get(id) { pack_attach_extras(&mut entry, id, ex, &mut media_entries); }
        manifest_items.push(entry);
    }

    let manifest = serde_json::json!({
        "version": PACK_MANIFEST_VERSION,
        "type": "qooti-collection-pack",
        "collection": { "name": col_name, "exported_at": exported_at },
        "items": manifest_items,
    });

    // Phase 3: build ZIP in memory
    let cursor = std::io::Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?.as_bytes()
    ).map_err(|e| e.to_string())?;

    for (zip_path, fs_path) in media_entries {
        match std::fs::read(&fs_path) {
            Ok(bytes) => {
                if zip.start_file(&zip_path, opts).is_ok() {
                    zip.write_all(&bytes).ok();
                }
            }
            Err(e) => log::warn!(target: "Export", "file_skipped path={fs_path} error={e}"),
        }
    }

    let zip_bytes = zip.finish().map_err(|e| e.to_string())?.into_inner();

    // Phase 4: obfuscate — XOR with rolling key so no standard tool can open it
    let obfuscated: Vec<u8> = zip_bytes.iter().enumerate()
        .map(|(i, &b)| b ^ QOOTI_PACK_KEY[i % QOOTI_PACK_KEY.len()])
        .collect();

    // Write: magic header + version byte + obfuscated payload
    let mut out = std::fs::File::create(&save_path).map_err(|e| e.to_string())?;
    out.write_all(QOOTI_PACK_MAGIC).map_err(|e| e.to_string())?;
    out.write_all(&obfuscated).map_err(|e| e.to_string())?;

    log::info!(target: "Export", "done collection={col_name:?} path={save_path:?}");
    Ok(())
}

// ─── .qooti pack format constants ────────────────────────────────
/// File starts with these 12 bytes. Breaks all standard ZIP/archive tools.
const QOOTI_PACK_MAGIC: &[u8] = b"QOOTIPACK\x01\x00\x00";
/// Rolling XOR key applied to the ZIP payload after the magic header.
const QOOTI_PACK_KEY: &[u8] = b"Qo0t!P4ck_S3cr3t_K3y_2024#XOR$";

// ─── Pack metadata (manifest v2) ─────────────────────────────────
// A pack carries everything qooti already worked out for each item — OCR text, colours,
// fingerprint, CLIP embedding, its tags (with where each tag came from), video length and
// shape, the video thumbnail and the AI-enhanced copy — so the computer that imports it
// doesn't redo OCR, palette extraction, hashing, embedding or thumbnails. Tag suggestions are
// not carried: the importing computer scores the items with its own lenses.
// v1 packs (no "meta") still import: those items are analysed as before.
const PACK_MANIFEST_VERSION: u32 = 2;

/// The name a pack gives a tag: a lens tag's English label (so other apps and older qooti read a
/// word, never `lens:<id>`; without a readable label, its id with spaces), any other tag its own
/// name: a people's tag (user, import) always, also one that stands for a concept (one name, one
/// tag). Over `tags t LEFT JOIN concepts c`.
const PACK_TAG_NAME_SQL: &str =
    "CASE WHEN t.concept_id IS NULL OR t.source IN ('user', 'import') THEN t.name \
          ELSE COALESCE(CASE WHEN json_valid(c.labels_json) THEN NULLIF(TRIM(json_extract(c.labels_json, '$.en')), '') END, \
                        REPLACE(t.concept_id, '_', ' ')) END";

/// One item's tags in a pack:
/// - `tags`: names. People's own tags by their name, lens tags by their English label;
/// - `tag_concepts`: {name: concept id} for the tags named in `tags` that stand for a concept. A
///   lens tag (`tag_sources` lens): the importing computer links its own tag of that concept. A
///   people's tag that stands for a concept (`tag_sources` user or import; one name, one tag): the
///   importing computer makes or links the people's tag by its name and source, and it stands for
///   that concept there too (import_pack_tags);
/// - `extra_concepts`: [concept id] for lens tags whose English label another tag of the item
///   already uses in `tags`: a people's tag with the same name (it keeps the name and its own
///   source), or a second lens tag with the same label. Importers link these as lens tags; older
///   apps ignore the field and still import every name in `tags`.
#[derive(Clone, Default)]
struct PackTags {
    names:    Vec<String>,
    concepts: serde_json::Map<String, serde_json::Value>,
    extra:    Vec<String>,
}

/// Tags of the items being exported (one collection, or the whole library), by item id.
fn pack_tags(db: &rusqlite::Connection, collection_id: Option<&str>) -> rusqlite::Result<HashMap<String, PackTags>> {
    let sql = format!(
        "SELECT it.inspiration_id, {PACK_TAG_NAME_SQL}, t.concept_id, t.source IN ('user', 'import')
         FROM inspiration_tags it
         JOIN tags t ON t.id = it.tag_id
         LEFT JOIN concepts c ON c.id = t.concept_id
         {}
         ORDER BY it.inspiration_id, 2",
        if collection_id.is_some() {
            "JOIN collection_items ci ON ci.inspiration_id = it.inspiration_id WHERE ci.collection_id = ?1"
        } else { "" });
    let mut stmt = db.prepare(&sql)?;
    let params: Vec<&str> = collection_id.into_iter().collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, bool>(3)?,
    )))?;
    let mut by_item: HashMap<String, Vec<(String, Option<String>, bool)>> = HashMap::new();
    for row in rows {
        let (item, name, concept, people) = row?;
        by_item.entry(item).or_default().push((name, concept, people));
    }
    let mut map: HashMap<String, PackTags> = HashMap::with_capacity(by_item.len());
    for (item, rows) in by_item {
        // Tags that aren't lens tags keep their names, whatever order the rows come in: people's
        // tags (also one that stands for a concept) and tags without a concept
        let own: HashSet<&str> = rows.iter().filter(|(_, c, p)| *p || c.is_none()).map(|(n, _, _)| n.as_str()).collect();
        let mut tags = PackTags::default();
        for (name, concept, people) in &rows {
            match concept {
                // A people's tag that stands for a concept: its own name, and its concept
                Some(c) if *people => {
                    if !tags.names.contains(name) { tags.names.push(name.clone()) }
                    tags.concepts.insert(name.clone(), c.clone().into());
                }
                None => if !tags.names.contains(name) { tags.names.push(name.clone()) },
                Some(c) if own.contains(name.as_str()) || tags.concepts.contains_key(name) => {
                    if !tags.extra.contains(c) { tags.extra.push(c.clone()) }
                }
                Some(c) => {
                    tags.names.push(name.clone());
                    tags.concepts.insert(name.clone(), c.clone().into());
                }
            }
        }
        map.insert(item, tags);
    }
    Ok(map)
}

/// Put an item's tags into its manifest entry: `tags`, and `tag_concepts` / `extra_concepts`
/// when it has lens tags.
fn pack_put_tags(entry: &mut serde_json::Value, tags: PackTags) {
    entry["tags"] = tags.names.into();
    if !tags.concepts.is_empty() { entry["tag_concepts"] = serde_json::Value::Object(tags.concepts); }
    if !tags.extra.is_empty() { entry["extra_concepts"] = tags.extra.into(); }
}

struct PackExtras {
    meta:        serde_json::Value,
    tag_sources: serde_json::Map<String, serde_json::Value>,
    thumb:       Option<String>,   // file on disk
    enhanced:    Option<String>,   // file on disk
}

fn pack_extras(db: &rusqlite::Connection, id: &str) -> Option<PackExtras> {
    use base64::Engine;
    let mut ex = db.query_row(
        "SELECT aspect_ratio, palette, ocr_status, ocr_language, phash, phash_source,
                object_tags, object_status, duration_secs, thumbnail_path, enhanced_path
         FROM inspirations WHERE id = ?1",
        params![id],
        |r| {
            let mut m = serde_json::Map::new();
            let mut put = |k: &str, v: Option<serde_json::Value>| { if let Some(v) = v { m.insert(k.into(), v); } };
            put("aspect_ratio",        r.get::<_, Option<f64>>(0)?.map(|v| v.into()));
            put("palette",             r.get::<_, Option<String>>(1)?.map(|v| v.into()));
            put("ocr_status",          r.get::<_, Option<String>>(2)?.map(|v| v.into()));
            put("ocr_language",        r.get::<_, Option<String>>(3)?.map(|v| v.into()));
            put("phash",               r.get::<_, Option<String>>(4)?.map(|v| v.into()));
            put("phash_source",        r.get::<_, Option<String>>(5)?.map(|v| v.into()));
            put("object_tags",         r.get::<_, Option<String>>(6)?.map(|v| v.into()));
            put("object_status",       r.get::<_, Option<String>>(7)?.map(|v| v.into()));
            put("duration_secs",       r.get::<_, Option<f64>>(8)?.map(|v| v.into()));
            Ok(PackExtras {
                meta: serde_json::Value::Object(m),
                tag_sources: serde_json::Map::new(),
                thumb:    r.get::<_, Option<String>>(9)?.filter(|p| std::path::Path::new(p).is_file()),
                enhanced: r.get::<_, Option<String>>(10)?.filter(|p| std::path::Path::new(p).is_file()),
            })
        },
    ).ok()?;
    if let Ok(emb) = db.query_row(
        "SELECT emb FROM clip_embeddings WHERE id = ?1 AND model = ?2",
        params![id, crate::clip::MODEL_TAG], |r| r.get::<_, Vec<u8>>(0),
    ) {
        ex.meta["clip"] = serde_json::json!({
            "model": crate::clip::MODEL_TAG,
            "emb": base64::engine::general_purpose::STANDARD.encode(emb),
        });
    }
    if let Ok(mut stmt) = db.prepare(&format!(
        "SELECT {PACK_TAG_NAME_SQL}, t.source, t.concept_id IS NOT NULL AND t.source NOT IN ('user', 'import')
         FROM inspiration_tags it
         JOIN tags t ON t.id = it.tag_id
         LEFT JOIN concepts c ON c.id = t.concept_id
         WHERE it.inspiration_id = ?1"
    )) {
        if let Ok(rows) = stmt.query_map(params![id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?))) {
            // A people's tag and a lens tag with the same name: the name is the people's tag's,
            // with its own source (the lens tag travels in extra_concepts, see pack_tags). A
            // people's tag that stands for a concept is a people's tag here too.
            for (name, source, lens) in rows.flatten() {
                if lens { ex.tag_sources.entry(name).or_insert_with(|| source.into()); }
                else { ex.tag_sources.insert(name, source.into()); }
            }
        }
    }
    Some(ex)
}

/// Add an item's extras to its manifest entry; queue the thumbnail / enhanced files.
fn pack_attach_extras(entry: &mut serde_json::Value, id: &str, ex: &PackExtras, media: &mut Vec<(String, String)>) {
    entry["meta"] = ex.meta.clone();
    if !ex.tag_sources.is_empty() { entry["tag_sources"] = serde_json::Value::Object(ex.tag_sources.clone()); }
    if let Some(p) = &ex.thumb {
        let ext = std::path::Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("jpg");
        let z = format!("thumbs/{id}.{ext}");
        entry["thumb"] = z.clone().into();
        media.push((z, p.clone()));
    }
    if let Some(p) = &ex.enhanced {
        let ext = std::path::Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("png");
        let z = format!("enhanced/{id}.{ext}");
        entry["enhanced"] = z.clone().into();
        media.push((z, p.clone()));
    }
}

/// An image file from a pack (thumbnail / enhanced copy): size-capped, and it must really
/// decode as an image — never trust the archive.
fn pack_read_image(archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, name: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut f = archive.by_name(name).ok()?;
    if f.size() > crate::media_guard::MAX_FILE_BYTES { return None; }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    image::guess_format(&buf).ok()?;
    image::load_from_memory(&buf).ok()?;
    Some(buf)
}

/// A string field from untrusted pack metadata, length-capped.
fn meta_str(meta: &serde_json::Value, key: &str, max: usize) -> Option<String> {
    meta.get(key)?.as_str().filter(|s| s.len() <= max).map(|s| s.to_string())
}

/// A status we can trust as "finished" — anything else means "analyse again here".
fn meta_status(meta: &serde_json::Value, key: &str, allowed: &[&str]) -> Option<String> {
    meta_str(meta, key, 32).filter(|s| allowed.contains(&s.as_str()))
}

/// One item's analysis results as read back from an untrusted pack. Every field is
/// checked; a missing or odd one is None and that step simply runs again on this computer.
/// Tag suggestions (auto_tag_*) are never taken from a pack, old or new: they start empty
/// and this computer's lenses score the item.
#[derive(Debug, Default, PartialEq)]
struct PackMeta {
    aspect_ratio:        Option<f64>,
    duration_secs:       Option<f64>,
    ocr_text:            String,
    ocr_status:          Option<String>,
    ocr_language:        Option<String>,
    palette:             Option<String>,
    phash:               Option<String>,
    object_tags:         Option<String>,
    object_status:       Option<String>,
    clip_emb:            Option<Vec<u8>>,
}

fn read_pack_meta(item: &serde_json::Value, is_video: bool) -> PackMeta {
    use base64::Engine;
    const DONE: &[&str] = &["done", "skipped", "failed", "error"];
    let meta = &item["meta"];

    let ocr_status = if is_video { Some("skipped".to_string()) } else { meta_status(meta, "ocr_status", DONE) };
    let object_status = meta_status(meta, "object_status", DONE);
    PackMeta {
        aspect_ratio:  meta["aspect_ratio"].as_f64().filter(|r| r.is_finite() && *r > 0.01 && *r < 100.0),
        duration_secs: meta["duration_secs"].as_f64().filter(|d| d.is_finite() && *d >= 0.0),
        // v1 packs carried ocr_text too, but import used to drop it
        ocr_text: item["ocr_text"].as_str().filter(|t| t.len() <= 200_000).unwrap_or("").replace('\r', ""),
        ocr_language: ocr_status.as_ref().and_then(|_| meta_str(meta, "ocr_language", 32)),
        ocr_status,
        // Only a short list of real hex colours
        palette: meta_str(meta, "palette", 4096)
            .filter(|p| serde_json::from_str::<Vec<String>>(p).map_or(false, |v| {
                !v.is_empty() && v.len() <= 16 && v.iter().all(|c| {
                    let h = c.trim_start_matches('#');
                    c.starts_with('#') && (h.len() == 6 || h.len() == 8) && h.chars().all(|ch| ch.is_ascii_hexdigit())
                })
            })),
        // Fingerprint for duplicate search, current format only
        phash: meta_str(meta, "phash", 2048)
            .filter(|_| meta["phash_source"].as_str() == Some(FP_VERSION))
            .filter(|ph| parse_fp(ph).is_some()),
        object_tags: object_status.as_ref().and_then(|_| meta_str(meta, "object_tags", 65_536)),
        object_status,
        // CLIP embedding (search by meaning, find similar): same model, right size, real numbers
        clip_emb: meta["clip"]["emb"].as_str()
            .filter(|_| meta["clip"]["model"].as_str() == Some(crate::clip::MODEL_TAG))
            .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
            .filter(|v| v.len() == crate::clip::DIM * 4)
            .filter(|v| v.chunks_exact(4).all(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]).is_finite())),
    }
}

#[tauri::command]
pub async fn export_all_items(
    save_path: String,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    // Phase 1: DB queries — fast, done while holding the lock briefly
    type Row = (String, Option<String>, String, Option<String>, String,
                Option<String>, Option<String>, i64, Option<String>);
    let (items, tags_map, extras): (Vec<Row>, HashMap<String, PackTags>, HashMap<String, PackExtras>) = {
        let db = state.db.lock().unwrap();

        let items: Vec<Row> = {
            let mut stmt = db.prepare(
                "SELECT id, title, type, mime_type, stored_path,
                        source_url, source_platform, created_at, ocr_text
                 FROM inspirations
                 ORDER BY created_at DESC"
            ).map_err(|e| e.to_string())?;
            let rows: Vec<_> = stmt.query_map([], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok()).collect();
            rows
        };

        let tags_map = pack_tags(&db, None).map_err(|e| e.to_string())?;

        let extras: HashMap<String, PackExtras> = items.iter()
            .filter_map(|it| pack_extras(&db, &it.0).map(|ex| (it.0.clone(), ex)))
            .collect();

        (items, tags_map, extras)
    }; // DB lock released before the heavy work begins

    // Phases 2–4: manifest + ZIP + XOR — all heavy I/O, run off the UI thread
    tauri::async_runtime::spawn_blocking(move || {
        use zip::write::FileOptions;
        use zip::CompressionMethod;

        let total = items.len() as u32;

        let exported_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let mut manifest_items = Vec::new();
        let mut media_entries: Vec<(String, String)> = Vec::new();

        for (id, title, item_type, mime_type, stored_path,
             source_url, source_platform, created_at, ocr_text) in &items {
            let ext = std::path::Path::new(stored_path)
                .extension().and_then(|e| e.to_str()).unwrap_or("bin");
            let file_in_zip = format!("media/{}.{}", id, ext);
            let tags = tags_map.get(id).cloned().unwrap_or_default();

            let mut entry = serde_json::json!({
                "id": id, "type": item_type,
                "created_at": created_at, "file": file_in_zip,
            });
            pack_put_tags(&mut entry, tags);
            if let Some(v) = title           { entry["title"]          = serde_json::json!(v); }
            if let Some(v) = mime_type       { entry["mime_type"]       = serde_json::json!(v); }
            if let Some(v) = source_url      { entry["source_url"]      = serde_json::json!(v); }
            if let Some(v) = source_platform { entry["source_platform"] = serde_json::json!(v); }
            if let Some(v) = ocr_text        { entry["ocr_text"]        = serde_json::json!(v); }

            media_entries.push((file_in_zip, stored_path.clone()));
            if let Some(ex) = extras.get(id) { pack_attach_extras(&mut entry, id, ex, &mut media_entries); }
            manifest_items.push(entry);
        }

        let manifest = serde_json::json!({
            "version": PACK_MANIFEST_VERSION,
            "type": "qooti-library-pack",
            "collection": { "name": "qooti Library", "exported_at": exported_at },
            "items": manifest_items,
        });

        let cursor = std::io::Cursor::new(Vec::<u8>::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

        zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
        zip.write_all(
            serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?.as_bytes()
        ).map_err(|e| e.to_string())?;

        for (zip_path, fs_path) in media_entries {
            match std::fs::read(&fs_path) {
                Ok(bytes) => {
                    if zip.start_file(&zip_path, opts).is_ok() {
                        zip.write_all(&bytes).ok();
                    }
                }
                Err(e) => log::warn!(target: "Export", "file_skipped path={fs_path} error={e}"),
            }
        }

        let zip_bytes = zip.finish().map_err(|e| e.to_string())?.into_inner();

        let obfuscated: Vec<u8> = zip_bytes.iter().enumerate()
            .map(|(i, &b)| b ^ QOOTI_PACK_KEY[i % QOOTI_PACK_KEY.len()])
            .collect();

        let mut out = std::fs::File::create(&save_path).map_err(|e| e.to_string())?;
        out.write_all(QOOTI_PACK_MAGIC).map_err(|e| e.to_string())?;
        out.write_all(&obfuscated).map_err(|e| e.to_string())?;

        log::info!(target: "Export", "export_all done items={total} path={save_path:?}");
        Ok(total)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn import_qooti_pack(
    path: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<ImportQooTiResult, String> {
    use std::io::Read;

    let vault_path = vault::get_vault_path(&app).map_err(|e| e.to_string())?;
    vault::ensure_structure(&vault_path).map_err(|e| e.to_string())?;

    // Decode the .qooti file
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    if raw.len() < QOOTI_PACK_MAGIC.len() || &raw[..QOOTI_PACK_MAGIC.len()] != QOOTI_PACK_MAGIC {
        return Err("Not a valid .qooti collection file".to_string());
    }
    let zip_bytes: Vec<u8> = raw[QOOTI_PACK_MAGIC.len()..]
        .iter().enumerate()
        .map(|(i, &b)| b ^ QOOTI_PACK_KEY[i % QOOTI_PACK_KEY.len()])
        .collect();

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    // Parse manifest
    let (col_name, items_meta): (String, Vec<serde_json::Value>) = {
        let mut f = archive.by_name("manifest.json")
            .map_err(|_| "manifest.json missing in pack".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        let name = v["collection"]["name"].as_str().unwrap_or("Imported Collection").to_string();
        let items = v["items"].as_array().cloned().unwrap_or_default();
        (name, items)
    };

    // Create collection
    let col_id = Uuid::new_v4().to_string();
    let now = now_ms();
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?1,?2,?3,?3)",
            params![col_id, col_name, now],
        ).map_err(|e| e.to_string())?;
    }

    let mut imported_count = 0u32;
    let mut skipped_count  = 0u32;
    let mut touched_tags: Vec<String> = Vec::new();
    let mut waiting_lens_tags = 0usize;

    for item_meta in &items_meta {
        let zip_file_path = match item_meta["file"].as_str() {
            Some(f) => f.to_string(),
            None    => { skipped_count += 1; continue; }
        };

        // Read media bytes from ZIP (size check before reading into memory)
        let media_bytes = {
            let mut f = match archive.by_name(&zip_file_path) {
                Ok(f)  => f,
                Err(_) => { skipped_count += 1; continue; }
            };
            if f.size() > crate::media_guard::MAX_FILE_BYTES {
                log::warn!(target: "Pack", "entry_too_large file={zip_file_path:?} size={}", f.size());
                skipped_count += 1;
                continue;
            }
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_err() { skipped_count += 1; continue; }
            buf
        };

        // Validate real content type from magic bytes — never trust the ZIP entry filename
        let validated = match crate::media_guard::validate_bytes(&media_bytes, &zip_file_path) {
            Ok(v)  => v,
            Err(e) => {
                log::warn!(target: "Pack", "guard_rejected file={zip_file_path:?} error={e}");
                skipped_count += 1;
                continue;
            }
        };
        let (file_type, subdir, mime) = (validated.db_type, validated.subdir, validated.mime);

        // Hash-based dedup (the first original a cropped picture keeps counts too)
        let hash = {
            let mut h = sha2::Sha256::new();
            h.update(&media_bytes);
            hex::encode(h.finalize())
        };
        {
            let db = state.db.lock().unwrap();
            let count: i64 = db.query_row(
                "SELECT COUNT(*) FROM inspirations WHERE file_hash = ?1 OR original_hash = ?1",
                params![hash], |r| r.get(0),
            ).unwrap_or(0);
            if count > 0 { skipped_count += 1; continue; }
        }

        // Write media to vault
        let item_id   = Uuid::new_v4().to_string();
        let dest_name = format!("{}.{}", item_id, validated.real_ext);
        let dest_path = vault_path.join(subdir).join(&dest_name);
        if std::fs::write(&dest_path, &media_bytes).is_err() { skipped_count += 1; continue; }
        let stored_path = dest_path.to_string_lossy().into_owned();

        // What the exporting computer already worked out (manifest v2)
        let is_video = file_type == "video";
        let PackMeta {
            aspect_ratio: meta_ratio, duration_secs: meta_duration, ocr_text, ocr_status, ocr_language,
            palette, phash, object_tags, object_status, clip_emb,
        } = read_pack_meta(item_meta, is_video);
        let phash_source = phash.as_ref().map(|_| FP_VERSION);

        // Video length + shape: ffprobe only when the pack didn't carry them
        let (duration, video_ratio) = if is_video && (meta_ratio.is_none() || meta_duration.is_none()) {
            video_meta(&dest_path, &app)
        } else { (meta_duration, None) };
        // A picture's own header wins over the pack's ratio: older qooti stored 1.0 for pictures
        // saved by link or by the browser extension, and a pack carries that along.
        let aspect_ratio = new_item_ratio(is_video, &stored_path, meta_ratio.or(video_ratio), validated.default_ratio);

        let palette_json = palette.or_else(|| if !is_video {
            let p = stored_path.clone();
            let colors = std::panic::catch_unwind(|| palette_from_path(&p, 5)).unwrap_or_default();
            if colors.is_empty() { None } else { serde_json::to_string(&colors).ok() }
        } else { None });

        // Video thumbnail
        let thumbnail_path = item_meta["thumb"].as_str()
            .and_then(|z| pack_read_image(&mut archive, z))
            .and_then(|bytes| {
                let dest = vault_path.join("thumbnails").join(format!("{item_id}_thumb.jpg"));
                std::fs::write(&dest, bytes).ok()?;
                Some(dest.to_string_lossy().into_owned())
            });

        // AI-enhanced copy, kept next to the original as the enhancer does
        let enhanced_path = item_meta["enhanced"].as_str()
            .and_then(|z| pack_read_image(&mut archive, z))
            .and_then(|bytes| {
                let dest = dest_path.with_file_name(format!("{item_id}_enhanced.png"));
                std::fs::write(&dest, bytes).ok()?;
                Some(dest.to_string_lossy().into_owned())
            });


        let title          = item_meta["title"].as_str().map(|s| s.to_string());
        let source_url     = item_meta["source_url"].as_str().map(|s| s.to_string());
        let source_platform = item_meta["source_platform"].as_str().map(|s| s.to_string());
        let created_at     = item_meta["created_at"].as_i64().unwrap_or(now);
        let mime_val       = item_meta["mime_type"].as_str().unwrap_or(mime);

        // Insert inspiration — batch_id = col_id groups all pack items under their collection.
        // Its auto-tag fields stay NULL: this computer's lenses score it.
        {
            let db = state.db.lock().unwrap();
            if db.execute(
                "INSERT INTO inspirations \
                 (id, type, title, stored_path, file_hash, mime_type, aspect_ratio, ocr_text, \
                  ocr_status, source_url, source_platform, palette, duration_secs, \
                  import_source, batch_id, created_at, updated_at, \
                  ocr_language, phash, phash_source, \
                  object_tags, object_status, thumbnail_path, enhanced_path) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?15,?8,?9,?10,?11,?12,'pack_import',?13,?14,?14, \
                         ?16,?17,?18,?19,?20,?21,?22)",
                params![item_id, file_type, title, stored_path, hash, mime_val, aspect_ratio,
                        ocr_status, source_url, source_platform, palette_json, duration, col_id, created_at,
                        ocr_text, ocr_language, phash, phash_source,
                        object_tags, object_status, thumbnail_path, enhanced_path],
            ).is_err() { skipped_count += 1; continue; }
            if let Some(emb) = &clip_emb {
                db.execute(
                    "INSERT OR REPLACE INTO clip_embeddings (id, model, emb) VALUES (?1, ?2, ?3)",
                    params![item_id, crate::clip::MODEL_TAG, emb],
                ).ok();
            }
        }

        // Add to collection
        {
            let db = state.db.lock().unwrap();
            db.execute(
                "INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES (?1,?2,?3)",
                params![col_id, item_id, now],
            ).ok();
        }

        // Restore tags
        {
            let db = state.db.lock().unwrap();
            let links = import_pack_tags(&db, &item_id, item_meta, now);
            touched_tags.extend(links.tag_ids);
            waiting_lens_tags += links.waiting;
        }

        imported_count += 1;
    }

    // tag_usage_counts of every tag the pack linked, from the links themselves
    if !touched_tags.is_empty() {
        let db = state.db.lock().unwrap();
        recount_tags(&db, &touched_tags);
    }
    if waiting_lens_tags > 0 {
        log::info!(target: "Pack", "{waiting_lens_tags} lens tags are of concepts no lens here has yet: kept, \
                                     and they take that lens's labels when it is installed");
    }
    // Pack items with a CLIP vector need no indexing, so the indexer won't score them: score
    // what's stale now (does nothing while tag suggestions are off). Videos get their frames read
    // by the indexer as usual.
    if imported_count > 0 {
        let app = app.clone();
        std::thread::spawn(move || crate::tagging::score_stale(&app));
    }

    log::info!(target: "Import", "qooti_pack_done collection={col_name:?} imported={imported_count} skipped={skipped_count}");
    Ok(ImportQooTiResult { collection_id: col_id, collection_name: col_name, imported_count, skipped_count })
}

/// What import_pack_tags linked for one item.
#[derive(Debug, Default)]
struct PackTagLinks {
    /// The tags linked (their counts are set afterwards, with recount_tags).
    tag_ids: Vec<String>,
    /// Lens tags linked to a concept no lens on this computer has yet (see pack_concept_tag).
    waiting: usize,
}

/// At most this many `extra_concepts` per item are read from a pack.
const PACK_MAX_EXTRA_CONCEPTS: usize = 64;

/// Link a pack item's tags (Tag lens spec §6.4; the pack format is described at PackTags).
/// - A name in `tags` with a `tag_concepts` entry is a lens tag: it links this computer's tag of
///   that concept. So does every id in `extra_concepts`.
/// - Unless `tag_sources` says the name is a people's tag (user or import) that stands for that
///   concept (one name, one tag): the people's tag is made or linked by its name, as below, and
///   stands for the concept here too (pack_peoples_concept).
/// - A concept no lens here has is kept, not dropped: pack_concept_tag makes a placeholder for it.
/// - Old suggestion tags (`tag_sources` = model) are skipped (decision 7), and so is any other
///   name with the prefix `lens:` (how an earlier build stored lens tags).
/// - Other names link the people's tag of the same name (any case; also one that stands for a
///   concept), or a tag without a concept of that name, or are created as `user` or `import` as
///   the pack says (`import` when it doesn't). A lens tag whose label is that name becomes that
///   people's tag (one name, one tag: tagging::lens_tag_for_peoples_name); a lens tag stored under
///   that name otherwise gives it up first (tagging::make_room_for_name): tag names are UNIQUE.
fn import_pack_tags(db: &rusqlite::Connection, item_id: &str, item_meta: &serde_json::Value, now: i64) -> PackTagLinks {
    let mut out = PackTagLinks::default();
    for tag_name in item_meta["tags"].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
        if tag_name.trim().is_empty() || tag_name.chars().count() > 200 { continue; }
        let concept = item_meta["tag_concepts"][tag_name].as_str().filter(|c| crate::lenses::valid_concept_id(c));
        let source = item_meta["tag_sources"][tag_name].as_str();
        let peoples = matches!(source, Some("user" | "import"));
        if let Some(concept) = concept.filter(|_| !peoples) {
            match pack_concept_tag(db, concept, Some(tag_name), now) {
                Ok((id, waiting)) => { out.waiting += waiting as usize; pack_link_tag(db, item_id, id, &mut out.tag_ids); }
                Err(e) => log::warn!(target: "Pack", "lens tag not linked: {e}"),
            }
            continue;
        }
        let source = source.unwrap_or("import");
        if source == "model" || tag_name.starts_with(LENS_TAG_PREFIX) { continue; }
        let Some(tag_id) = pack_peoples_tag(db, tag_name, source, now) else { continue };
        pack_link_tag(db, item_id, tag_id.clone(), &mut out.tag_ids);
        if let Some(concept) = concept {
            match pack_peoples_concept(db, &tag_id, concept, tag_name, now) {
                Ok((also, waiting)) => {
                    out.waiting += waiting as usize;
                    if let Some(other) = also { pack_link_tag(db, item_id, other, &mut out.tag_ids); }
                }
                Err(e) => log::warn!(target: "Pack", "tag's lens tag not linked: {e}"),
            }
        }
    }
    let extra = item_meta["extra_concepts"].as_array().into_iter().flatten()
        .take(PACK_MAX_EXTRA_CONCEPTS)
        .filter_map(|v| v.as_str())
        .filter(|c| crate::lenses::valid_concept_id(c));
    for concept in extra {
        match pack_concept_tag(db, concept, None, now) {
            Ok((id, waiting)) => {
                out.waiting += waiting as usize;
                pack_link_tag(db, item_id, id, &mut out.tag_ids);
            }
            Err(e) => log::warn!(target: "Pack", "lens tag not linked: {e}"),
        }
    }
    out
}

fn pack_link_tag(db: &rusqlite::Connection, item_id: &str, tag_id: String, linked: &mut Vec<String>) {
    match db.execute(
        "INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES (?1,?2)",
        params![item_id, tag_id],
    ) {
        Ok(_) => linked.push(tag_id),
        Err(e) => log::warn!(target: "Pack", "tag not linked: {e}"),
    }
}

/// The people's tag a pack names `name` with `source` (user or import; import for anything else):
/// the people's tag of that name (any case; also one that stands for a concept), or a tag without a
/// concept of that name, or the lens tag whose label is that name (it becomes this people's tag:
/// tagging::lens_tag_for_peoples_name), or a new one (a lens tag stored under the name gives it up
/// first: tagging::make_room_for_name). None when it couldn't be made (logged).
fn pack_peoples_tag(db: &rusqlite::Connection, name: &str, source: &str, now: i64) -> Option<String> {
    let existing: Option<String> = db.query_row(
        "SELECT id FROM tags WHERE LOWER(name) = LOWER(?1) AND (concept_id IS NULL OR source IN ('user', 'import'))
         ORDER BY source IN ('user', 'import') DESC, created_at, id LIMIT 1",
        params![name], |r| r.get(0),
    ).optional().ok().flatten();
    if existing.is_some() { return existing; }
    let source = if source == "user" { "user" } else { "import" };
    match crate::tagging::lens_tag_for_peoples_name(db, name, source) {
        Ok(Some(id)) => return Some(id),
        Ok(None) => {}
        Err(e) => { log::warn!(target: "Pack", "tag not created: {e}"); return None; }
    }
    let new_id = Uuid::new_v4().to_string();
    if let Err(e) = crate::tagging::make_room_for_name(db, name) {
        log::warn!(target: "Pack", "tag not created: {e}");
        return None;
    }
    if let Err(e) = db.execute(
        "INSERT INTO tags (id, name, source, created_at) VALUES (?1,?2,?3,?4)",
        params![new_id, name, source, now],
    ) {
        log::warn!(target: "Pack", "tag not created: {e}");
        return None;
    }
    Some(new_id)
}

/// A people's tag that stood for `concept` on the computer that made the pack (one name, one tag)
/// stands for it here too: `tag_id`, the people's tag this import found or made by its name,
/// becomes the concept's tag (tagging::become_concept_tag), even when a lens here labels the concept
/// differently, as on the other computer after a relabel. Unless the concept already has a tag here:
/// that tag is linked too, as a lens tag of the pack would be (the next start joins the two when
/// their names allow). Or `tag_id` stands for another concept here: the concept's own tag is linked,
/// kept apart. A concept no lens here has gets a placeholder named like the tag (as pack_concept_tag
/// does). Returns the other tag to link, if any, and whether the concept waits for its lens.
fn pack_peoples_concept(db: &rusqlite::Connection, tag_id: &str, concept: &str, name: &str, now: i64) -> rusqlite::Result<(Option<String>, bool)> {
    let waiting = pack_placeholder_concept(db, concept, Some(name), now)?;
    let owner: Option<String> = db
        .query_row("SELECT id FROM tags WHERE concept_id = ?1 ORDER BY created_at, id LIMIT 1", params![concept], |r| r.get(0))
        .optional()?;
    let mine: Option<String> = db
        .query_row("SELECT concept_id FROM tags WHERE id = ?1", params![tag_id], |r| r.get(0))
        .optional()?.flatten();
    match (owner, mine) {
        (Some(owner), _) if owner == tag_id => Ok((None, waiting)),
        (Some(owner), _) => Ok((Some(owner), waiting)),
        (None, None) => {
            crate::tagging::become_concept_tag(db, tag_id, concept)?;
            Ok((None, waiting))
        }
        (None, Some(_)) => Ok((Some(crate::tagging::ensure_concept_tag(db, concept)?), waiting)),
    }
}

/// This computer's lens tag for a concept a pack names. When no lens here has the concept (the
/// other computer had a newer lens, or a lens version this computer never got), a placeholder
/// concepts row is made first: lens_id '', the pack's name as its label in both languages, media
/// 'any', no vector, active 0. Nothing is scored from it and the detail picker doesn't offer it,
/// but the tag is a lens tag like any other. When a lens with that concept is installed later,
/// lenses::install fills in the real row (labels, vector, active = 1), so the tag then follows
/// the app's language. Returns the tag id, and whether its concept is still waiting for its lens.
fn pack_concept_tag(db: &rusqlite::Connection, concept: &str, name: Option<&str>, now: i64) -> rusqlite::Result<(String, bool)> {
    let waiting = pack_placeholder_concept(db, concept, name, now)?;
    Ok((crate::tagging::ensure_concept_tag(db, concept)?, waiting))
}

/// The placeholder concepts row pack_concept_tag describes, made when no lens here has `concept`.
/// Returns whether the concept is still waiting for its lens.
fn pack_placeholder_concept(db: &rusqlite::Connection, concept: &str, name: Option<&str>, now: i64) -> rusqlite::Result<bool> {
    let lens: Option<String> = db
        .query_row("SELECT lens_id FROM concepts WHERE id = ?1", params![concept], |r| r.get(0))
        .optional()?;
    if lens.is_none() {
        let label = name.map(str::trim)
            .filter(|n| !n.is_empty() && !n.starts_with(LENS_TAG_PREFIX))
            .map(str::to_string)
            .unwrap_or_else(|| label_from_concept_id(concept));
        db.execute(
            "INSERT OR IGNORE INTO concepts (id, lens_id, labels_json, media, aspect_json, vec, active, updated_at)
             VALUES (?1, '', ?2, 'any', NULL, ?3, 0, ?4)",
            params![concept, serde_json::json!({ "en": label, "uz": label }).to_string(), Vec::<u8>::new(), now],
        )?;
    }
    Ok(lens.as_deref().map_or(true, str::is_empty))
}

/// A readable stand-in label made from a concept id: 'green_screen' → 'Green screen'.
fn label_from_concept_id(id: &str) -> String {
    let words = id.replace('_', " ");
    let mut chars = words.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// Set the tag_usage_counts of `tag_ids` from their links. Counting the links themselves, rather
/// than adding and subtracting, keeps a count right when the same change arrives twice and heals
/// a count that was already wrong. Ids of tags that don't exist are skipped. Best effort: logged.
fn recount_tags(db: &rusqlite::Connection, tag_ids: &[String]) {
    let unique: HashSet<&String> = tag_ids.iter().collect();
    for id in unique {
        if let Err(e) = recount_tag(db, id) {
            log::warn!(target: "Tags", "tag count not updated: {e}");
        }
    }
}

/// One tag's tag_usage_counts from its links (nothing when the tag doesn't exist).
fn recount_tag(db: &rusqlite::Connection, tag_id: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO tag_usage_counts (tag_id, count)
         SELECT t.id, (SELECT COUNT(*) FROM inspiration_tags it WHERE it.tag_id = t.id) FROM tags t WHERE t.id = ?1",
        params![tag_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn get_collection_ids_for_inspiration(inspiration_id: String, state: State<AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT collection_id FROM collection_items WHERE inspiration_id = ?1"
    ).map_err(|e| e.to_string())?;
    let ids = stmt.query_map(params![inspiration_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

#[tauri::command]
pub fn add_to_collection(collection_id: String, inspiration_id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    if is_collection_locked(&db, &collection_id) {
        return Err("UPGRADE_REQUIRED:collection_locked".to_string());
    }
    db.execute("INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, created_at) VALUES (?1,?2,?3)", params![collection_id, inspiration_id, now_ms()]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_from_collection(collection_id: String, inspiration_id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    if is_collection_locked(&db, &collection_id) {
        return Err("UPGRADE_REQUIRED:collection_locked".to_string());
    }
    db.execute("DELETE FROM collection_items WHERE collection_id = ?1 AND inspiration_id = ?2", params![collection_id, inspiration_id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Tags ─────────────────────────────────────────────────────────

/// How an earlier build stored lens tags: `lens:<concept id>`. Lens tags are stored under their
/// label now (tagging::ensure_concept_tag), and no people's tag may be named like an id.
const LENS_TAG_PREFIX: &str = "lens:";

/// A tag id that can sit in a collection-hint key `col:<tag_id>` (and so in a JSON path): what
/// tagging::answer_suggestion accepts. Tag ids are UUIDs.
fn hint_safe_tag_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<Tag>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT t.id, t.name, t.source, t.created_at, COALESCE(u.count, 0) AS usage_count, t.concept_id, c.labels_json
         FROM tags t
         LEFT JOIN tag_usage_counts u ON u.tag_id = t.id
         LEFT JOIN concepts c ON c.id = t.concept_id
         ORDER BY usage_count DESC, t.name"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_tag).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[tauri::command]
pub fn get_tags_for_inspiration(inspiration_id: String, state: State<AppState>) -> Result<Vec<Tag>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT t.id, t.name, t.source, t.created_at, COALESCE(u.count, 0), t.concept_id, c.labels_json
         FROM tags t
         JOIN inspiration_tags it ON it.tag_id = t.id
         LEFT JOIN tag_usage_counts u ON u.tag_id = t.id
         LEFT JOIN concepts c ON c.id = t.concept_id
         WHERE it.inspiration_id = ?1
         ORDER BY t.name"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![inspiration_id], row_to_tag).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

/// Kept for internal and import use only: people can't type new tags any more (Tag lens
/// decision 6). Makes `user` or `import` tags; lens tags come from tagging::ensure_concept_tag,
/// and suggestion (`model`) tags are retired.
#[tauri::command]
pub fn create_tag(name: String, source: Option<String>, state: State<AppState>) -> Result<Tag, String> {
    let db = state.db.lock().unwrap();
    create_tag_with(&db, name, source)
}

/// create_tag on one connection. A lens tag whose label is the name becomes this people's tag,
/// with its items (one name, one tag: tagging::lens_tag_for_peoples_name); otherwise a lens tag
/// stored under the name gives it up first (tagging::make_room_for_name): tag names are UNIQUE,
/// and the people's tag keeps its name as given.
fn create_tag_with(db: &rusqlite::Connection, name: String, source: Option<String>) -> Result<Tag, String> {
    let src = source.unwrap_or_else(|| "user".to_string());
    if !matches!(src.as_str(), "user" | "import") {
        return Err(format!("tags with source '{src}' aren't made here"));
    }
    if name.trim().is_empty() || name.trim().to_lowercase().starts_with(LENS_TAG_PREFIX) {
        return Err("that tag name can't be used".into());
    }
    if let Some(id) = crate::tagging::lens_tag_for_peoples_name(db, &name, &src).map_err(|e| e.to_string())? {
        return db.query_row(
            "SELECT t.id, t.name, t.source, t.created_at, COALESCE(u.count, 0), t.concept_id, c.labels_json
             FROM tags t LEFT JOIN tag_usage_counts u ON u.tag_id = t.id LEFT JOIN concepts c ON c.id = t.concept_id
             WHERE t.id = ?1",
            params![id], row_to_tag,
        ).map_err(|e| e.to_string());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    crate::tagging::make_room_for_name(db, &name).map_err(|e| e.to_string())?;
    db.execute("INSERT INTO tags (id, name, source, created_at) VALUES (?1,?2,?3,?4)", params![id, name, src, now]).map_err(|e| e.to_string())?;
    db.execute("INSERT INTO tag_usage_counts (tag_id, count) VALUES (?1, 0)", params![id]).map_err(|e| e.to_string())?;
    Ok(Tag { id, name, source: src, created_at: now, usage_count: 0, concept_id: None, labels: None })
}

#[tauri::command]
pub fn delete_tag(id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM tags WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tag_inspiration(inspiration_id: String, tag_id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    tag_item(&db, &inspiration_id, &tag_id)
}

/// Link an existing tag to an item. A lens tag goes through the answer path, as with
/// add_concept_tag (the answer is kept and its suggestion leaves the item); for any other tag, a
/// collection hint for it (`col:<tag_id>`) leaves the item, which now has the tag. Either way the
/// tag's count is then set from its links (recount_tag), the same rule as untag_item, and the
/// item's other questions that ask the name it now has leave too (spec §0b.2: nothing re-scores
/// the item after a link, so write_results can't do it). A lens tag whose name the item already
/// has as a people's tag isn't linked (the picker doesn't offer it either): an error.
pub(crate) fn tag_item(db: &rusqlite::Connection, inspiration_id: &str, tag_id: &str) -> Result<(), String> {
    let concept: Option<String> = db
        .query_row("SELECT concept_id FROM tags WHERE id = ?1", params![tag_id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?.flatten();
    if let Some(cid) = concept {
        match crate::tagging::answer_with(db, inspiration_id, &cid, "added") {
            Ok(Some(tag)) => {
                if let Err(e) = recount_tag(db, &tag.id) {
                    log::warn!(target: "Tags", "tag count not updated: {e}");
                }
                return Ok(());
            }
            Ok(None) => return Err("the item already has a tag with that name".into()),
            Err(e) => log::warn!(target: "Tags", "lens tag linked without an answer: {e}"),
        }
    }
    db.execute(
        "INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES (?1,?2)",
        params![inspiration_id, tag_id],
    ).map_err(|e| e.to_string())?;
    if let Err(e) = recount_tag(db, tag_id) {
        log::warn!(target: "Tags", "tag count not updated: {e}");
    }
    if hint_safe_tag_id(tag_id) {
        let path = format!("$.\"col:{tag_id}\"");
        if let Err(e) = db.execute(
            "UPDATE inspirations SET lens_suggestions = json_remove(lens_suggestions, ?2)
             WHERE id = ?1
               AND CASE WHEN json_valid(lens_suggestions) THEN json_type(lens_suggestions, ?2) IS NOT NULL ELSE 0 END",
            params![inspiration_id, path],
        ) {
            log::warn!(target: "Tags", "collection hint not removed: {e}");
        }
    }
    if let Err(e) = crate::tagging::drop_questions_named_like(db, inspiration_id, tag_id) {
        log::warn!(target: "Tags", "questions with the same name not removed: {e}");
    }
    Ok(())
}

#[tauri::command]
pub fn untag_inspiration(inspiration_id: String, tag_id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    untag_item(&db, &inspiration_id, &tag_id).map_err(|e| e.to_string())
}

/// Remove a tag from an item. The tag's count is then set from the links that are left, so a
/// second untag of the same pair (a double click on ×) changes nothing. The tag itself stays,
/// even when no item has it any more.
fn untag_item(db: &rusqlite::Connection, inspiration_id: &str, tag_id: &str) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM inspiration_tags WHERE inspiration_id = ?1 AND tag_id = ?2",
        params![inspiration_id, tag_id],
    )?;
    recount_tag(db, tag_id)
}

// ─── OCR ──────────────────────────────────────────────────────────
// OCR moved to WASM (PP-OCRv4 via onnxruntime-web) in the frontend worker —
// see src/workers/ocr-worker.js and src/modules/ocr.js. The former native
// `rapidocr` sidecar (run_ocr / OcrSidecar / rapidocr_binary) and its ~200 MB
// bundled binary were removed. The DB-side OCR index commands
// (claim_ocr_index_candidates, finalize_ocr_index_result, get_ocr_index_stats,
// queue_full_ocr_reindex, reset_ocr_status_for_inspiration) remain in use.

// ─── Palette extraction (Rust-side, no canvas/CORS issues) ───────

/// Whether the window turns a picture of this format by its EXIF orientation. WebView2 does for a
/// JPEG and a PNG (its eXIf chunk) and shows a WebP as stored, whatever its EXIF says (checked in
/// Chromium 156). The shapes stored here and the frames crop.rs cuts follow the window.
pub(crate) fn exif_turns(format: image::ImageFormat) -> bool {
    matches!(format, image::ImageFormat::Jpeg | image::ImageFormat::Png)
}

/// Real aspect ratio (width/height) of an image as it is shown, read from the header and the
/// EXIF orientation only (no pixel decode — cheap). A JPEG or PNG stored on its side (orientation
/// 5–8) gets its turned shape, as the window and crop.rs show it; a WebP keeps its stored shape
/// (exif_turns). An EXIF block that can't be read means "not turned", never "no ratio". None on
/// failure or a zero dimension. Used so the masonry grid can lay images out at their native ratio
/// before they load.
pub(crate) fn image_aspect_ratio(path: &str) -> Option<f64> {
    use image::metadata::Orientation::{NoTransforms, Rotate270, Rotate270FlipH, Rotate90, Rotate90FlipH};
    use image::ImageDecoder;
    let reader = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let turns = reader.format().is_some_and(exif_turns);
    let mut dec = reader.into_decoder().ok()?;
    let (w, h) = dec.dimensions();
    if w == 0 || h == 0 { return None; }
    let turned = turns && matches!(dec.orientation().unwrap_or(NoTransforms), Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH);
    Some(if turned { h as f64 / w as f64 } else { w as f64 / h as f64 })
}

/// The aspect ratio a new item is stored with, the same rule for every way in (file import, link
/// download, browser extension, pack). A picture: its real size from the file header, else
/// `known` (a pack's value), else the format's default. A video: `known` (probed, or a pack's),
/// else the default. Real ratios drive the native-ratio masonry and the Tag lens shape rules
/// (the thumbnail lens's aspect gate).
fn new_item_ratio(is_video: bool, stored_path: &str, known: Option<f64>, default: f64) -> f64 {
    if is_video { known } else { image_aspect_ratio(stored_path).or(known) }.unwrap_or(default)
}

/// Preference that marks fix_picture_aspects_once as done.
const ASPECT_FIX_KEY: &str = "aspect_fix_v1";

/// Before 1.2.3, pictures and GIFs saved by link download or by the browser extension were stored
/// with aspect_ratio 1.0 whatever their real shape: the grid showed them square and the Tag lens
/// shape rules judged them square. Once per library (preference `aspect_fix_v1`): read the real
/// size of every picture and GIF still at 1.0 from its file and, where it differs by more than
/// 1 %, store it and clear auto_tag_sig, so the item is scored again. Never fails the boot:
/// problems are logged. Run it on the background thread, before tagging::score_stale.
pub fn fix_picture_aspects_once(app: &AppHandle) {
    let state = app.state::<AppState>();
    match fix_picture_aspects(&state.db) {
        Ok(r) if r.already_done => {}
        Ok(r) => {
            log::info!(target: "Boot", "picture_aspects_fixed checked={} fixed={} unreadable={} done={}",
                       r.checked, r.fixed, r.unreadable, r.marked_done);
            if r.fixed > 0 {
                // The masonry lays the grid out again with the real shapes (as after the old backfill)
                if let Err(e) = app.emit("grid:reload-ratios", ()) {
                    log::warn!(target: "Boot", "grid:reload-ratios not sent: {e}");
                }
            }
        }
        Err(e) => log::warn!(target: "Boot", "picture aspect fix skipped: {e}"),
    }
}

#[derive(Debug, Default, PartialEq)]
struct AspectFix {
    already_done: bool,
    /// Pictures and GIFs at 1.0 that were looked at.
    checked: usize,
    /// Ratios corrected (their signature cleared for re-scoring).
    fixed: usize,
    /// Files that couldn't be read (missing, or a format whose header can't be read).
    unreadable: usize,
    /// The preference was set: the step won't run again.
    marked_done: bool,
}

/// fix_picture_aspects_once on one database. Files are read with the database released; each
/// change is written under a short lock. The step is marked done unless every file is missing
/// (the library's drive may not be connected yet): then the next start tries again.
fn fix_picture_aspects(db: &Mutex<rusqlite::Connection>) -> Result<AspectFix, String> {
    let lock = || db.lock().unwrap_or_else(|e| e.into_inner());
    let rows: Vec<(String, String)> = {
        let conn = lock();
        let done = conn.query_row("SELECT 1 FROM preferences WHERE key = ?1", params![ASPECT_FIX_KEY], |_| Ok(()))
            .optional().map_err(|e| e.to_string())?.is_some();
        if done { return Ok(AspectFix { already_done: true, ..Default::default() }); }
        let mut stmt = conn.prepare(
            "SELECT id, stored_path FROM inspirations WHERE type IN ('image', 'gif') AND aspect_ratio = 1.0",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
        rows
    };
    let mut out = AspectFix { checked: rows.len(), ..Default::default() };
    let mut missing = 0usize;
    for (id, path) in &rows {
        match image_aspect_ratio(path) {
            Some(ratio) if (ratio - 1.0).abs() > 0.01 => {
                match lock().execute(
                    "UPDATE inspirations SET aspect_ratio = ?2, auto_tag_sig = NULL WHERE id = ?1 AND aspect_ratio = 1.0",
                    params![id, ratio],
                ) {
                    Ok(n) => out.fixed += n,
                    Err(e) => log::warn!(target: "Boot", "aspect ratio of id={id} not stored: {e}"),
                }
            }
            Some(_) => {}   // really square (within 1 %)
            None => {
                out.unreadable += 1;
                if !std::path::Path::new(path).exists() { missing += 1; }
            }
        }
    }
    if rows.is_empty() || missing < rows.len() {
        lock().execute("INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, 'true')", params![ASPECT_FIX_KEY])
            .map_err(|e| e.to_string())?;
        out.marked_done = true;
    }
    Ok(out)
}

/// One-time backfill: images imported before native-ratio support were all
/// stored with `aspect_ratio = 1.0`. Read each image's real dimensions and
/// update. Runs once (guarded by a preference flag), on a background thread so
/// it never blocks startup, and reads file headers OUTSIDE the DB lock so the UI
/// keeps responding. Emits `grid:reload-ratios` when it changes anything so the
/// masonry re-lays-out with the corrected ratios.
pub fn backfill_image_ratios_once(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<AppState>();

    // 1. Check the flag + collect (id, path) under a short lock.
    let rows: Vec<(String, String)> = {
        let db = match state.db.lock() { Ok(d) => d, Err(_) => return };
        let done = db.query_row(
            "SELECT COUNT(*) FROM preferences WHERE key = 'image_ratios_backfilled'",
            [], |r| r.get::<_, i64>(0),
        ).unwrap_or(0) > 0;
        if done { return; }
        let mut stmt = match db.prepare("SELECT id, stored_path FROM inspirations WHERE type = 'image'") {
            Ok(s) => s, Err(_) => return,
        };
        let mapped = match stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            Ok(m) => m, Err(_) => return,
        };
        mapped.filter_map(|r| r.ok()).collect()
    };

    // 2. Read dimensions (file I/O) WITHOUT the lock; write each change under a brief lock.
    let mut updated = 0i64;
    for (id, path) in rows {
        if let Some(ratio) = image_aspect_ratio(&path) {
            if let Ok(db) = state.db.lock() {
                // A new shape is scored again (the Tag lens shape rules read it)
                if db.execute(
                    "UPDATE inspirations SET aspect_ratio = ?1, auto_tag_sig = NULL WHERE id = ?2 AND ABS(aspect_ratio - ?1) > 0.001",
                    params![ratio, id],
                ).unwrap_or(0) > 0 {
                    updated += 1;
                }
            }
        }
    }

    // 3. Mark done + notify the grid if anything changed.
    if let Ok(db) = state.db.lock() {
        let _ = db.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES ('image_ratios_backfilled', 'true')",
            [],
        );
    }
    log::info!(target: "Boot", "image_ratios_backfilled updated={}", updated);
    if updated > 0 {
        use tauri::Emitter;
        let _ = app.emit("grid:reload-ratios", ());
    }
}

/// The narrowest and widest shapes (width / height) set_item_aspect stores.
const ASPECT_MIN: f64 = 0.05;
const ASPECT_MAX: f64 = 20.0;

/// A grid card measured its picture, thumbnail or video and found a shape that differs from the
/// stored one (crop spec A3, C3). The shape is stored when it differs by more than 1 %, with
/// auto_tag_sig cleared so the Tag lens shape rules look again; updated_at stays (a correction,
/// not an edit). True when it was stored; false when nothing changed or the id is unknown. A
/// shape outside 0.05–20 (or not a number): `bad_ratio`. While tag suggestions are on, the items
/// whose shape changed within about a second are scored again together (`autotag:scored`).
#[tauri::command]
pub fn set_item_aspect(id: String, ratio: f64, app: AppHandle, state: State<AppState>) -> Result<bool, String> {
    let (changed, rescore) = {
        let db = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let changed = set_aspect(&db, &id, ratio)?;
        (changed, changed && crate::tagging::suggestions_enabled(&db))
    };
    if rescore && queue_reshaped(id) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(1));
            crate::tagging::score_items(&app, &take_reshaped());
        });
    }
    Ok(changed)
}

/// set_item_aspect on one connection.
fn set_aspect(db: &rusqlite::Connection, id: &str, ratio: f64) -> Result<bool, String> {
    if !ratio.is_finite() || !(ASPECT_MIN..=ASPECT_MAX).contains(&ratio) {
        return Err("bad_ratio".into());
    }
    let n = db.execute(
        "UPDATE inspirations SET aspect_ratio = ?2, auto_tag_sig = NULL
         WHERE id = ?1 AND ABS(aspect_ratio - ?2) > 0.01 * ?2",
        params![id, ratio],
    ).map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Items whose shape set_item_aspect changed, waiting to be scored again together (Some while a
/// scoring run is booked).
static RESHAPED: Mutex<Option<Vec<String>>> = Mutex::new(None);

/// Add an item to the next re-scoring run. True when this booked the run (the caller starts it).
fn queue_reshaped(id: String) -> bool {
    let mut q = RESHAPED.lock().unwrap_or_else(|e| e.into_inner());
    match q.as_mut() {
        Some(ids) => { if !ids.contains(&id) { ids.push(id); } false }
        None => { *q = Some(vec![id]); true }
    }
}

/// The items booked for re-scoring; the next one queued books a new run.
fn take_reshaped() -> Vec<String> {
    RESHAPED.lock().unwrap_or_else(|e| e.into_inner()).take().unwrap_or_default()
}

// ─── Duplicate detection ─────────────────────────────────────────
// A fingerprint, taken after trimming a uniform frame (letterbox bars, a plain canvas
// margin) so a padded copy still lines up with the original:
//   • 64-bit dHash — coarse layout
//   • 16×16 grayscale signature (256 samples) — light/dark layout, compared by MAD
//   • 4×4 RGB signature (48 samples) — colour, so a recoloured variant isn't a copy
//   • aspect ratio of the trimmed picture
// Stored as "v3|<dhash 16hex>|<gray 512hex>|<rgb 96hex>|<aspect>"; phash_source FP_VERSION.
// The fingerprint only CONFIRMS a match — what a picture shows is judged by CLIP (see
// dup_match). v2 strings ("<dhash>:<gray>") are still parsed until the backfill redoes them.
const FP_VERSION: &str = "v3";

fn phash_from_path(path: &str) -> Option<String> {
    use image::imageops::FilterType::Triangle;
    let img = trim_uniform_border(image::open(path).ok()?);
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 { return None; }

    // dHash — 9×8 luma, compare each pixel to its right neighbour → 64 bits.
    let d = img.resize_exact(9, 8, Triangle).to_luma8();
    let mut dhash: u64 = 0;
    let mut i = 0u32;
    for y in 0..8u32 {
        for x in 0..8u32 {
            if d.get_pixel(x, y)[0] > d.get_pixel(x + 1, y)[0] { dhash |= 1u64 << i; }
            i += 1;
        }
    }

    let mut gray = String::with_capacity(512);
    for p in img.resize_exact(16, 16, Triangle).to_luma8().pixels() { gray.push_str(&format!("{:02x}", p[0])); }
    let mut rgb = String::with_capacity(96);
    for p in img.resize_exact(4, 4, Triangle).to_rgb8().pixels() {
        for c in p.0 { rgb.push_str(&format!("{c:02x}")); }
    }

    Some(format!("{FP_VERSION}|{dhash:016x}|{gray}|{rgb}|{:.4}", w as f64 / h as f64))
}

/// Crop a uniform frame around the picture: letterbox bars on a video still, a plain
/// margin around a design. Only when at least three corners share one colour (a real
/// frame, not artwork reaching the edge), and never below 40% of either side.
fn trim_uniform_border(img: image::DynamicImage) -> image::DynamicImage {
    let (w, h) = img.dimensions();
    if w < 16 || h < 16 { return img; }
    // Find the box on a small copy, then crop the full image.
    let scale = (256.0 / w.max(h) as f64).min(1.0);
    let sw = ((w as f64 * scale).round() as u32).max(8);
    let sh = ((h as f64 * scale).round() as u32).max(8);
    let small = img.resize_exact(sw, sh, image::imageops::FilterType::Triangle).to_rgb8();
    let px = |x: u32, y: u32| small.get_pixel(x, y).0;
    let corners = [px(0, 0), px(sw - 1, 0), px(0, sh - 1), px(sw - 1, sh - 1)];
    let close = |p: [u8; 3], q: [u8; 3]| p.iter().zip(q).map(|(a, b)| (*a as i32 - b as i32).abs()).sum::<i32>() <= 36;
    let Some(bg) = corners.iter().copied().find(|&c| corners.iter().filter(|&&o| close(c, o)).count() >= 3) else { return img };
    let line_is_bg = |count: u32, at: &dyn Fn(u32) -> [u8; 3]| (0..count).filter(|&k| close(at(k), bg)).count() * 100 >= count as usize * 98;

    let (mut top, mut bottom) = (0u32, sh - 1);
    while top < bottom && line_is_bg(sw, &|x| px(x, top)) { top += 1; }
    while bottom > top && line_is_bg(sw, &|x| px(x, bottom)) { bottom -= 1; }
    let rows = bottom - top + 1;
    let (mut left, mut right) = (0u32, sw - 1);
    while left < right && line_is_bg(rows, &|y| px(left, top + y)) { left += 1; }
    while right > left && line_is_bg(rows, &|y| px(right, top + y)) { right -= 1; }
    let cols = right - left + 1;
    if (cols == sw && rows == sh) || cols * 10 < sw * 4 || rows * 10 < sh * 4 { return img; }

    let x0 = (left as f64 / scale).floor() as u32;
    let y0 = (top as f64 / scale).floor() as u32;
    let x1 = (((right + 1) as f64 / scale).ceil() as u32).min(w);
    let y1 = (((bottom + 1) as f64 / scale).ceil() as u32).min(h);
    img.crop_imm(x0, y0, x1.saturating_sub(x0).max(1), y1.saturating_sub(y0).max(1))
}

struct Fp { dhash: u64, sig: Vec<u8>, rgb: Option<Vec<u8>>, aspect: Option<f64> }

fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 { return None; }
    (0..s.len()).step_by(2).map(|k| u8::from_str_radix(s.get(k..k + 2)?, 16).ok()).collect()
}

fn parse_fp(s: &str) -> Option<Fp> {
    if let Some(rest) = s.strip_prefix("v3|") {
        let mut parts = rest.split('|');
        let dhash = u64::from_str_radix(parts.next()?, 16).ok()?;
        let sig = hex_bytes(parts.next()?).filter(|v| v.len() == 256)?;
        let rgb = hex_bytes(parts.next()?).filter(|v| v.len() == 48)?;
        let aspect = parts.next()?.parse::<f64>().ok().filter(|a| *a > 0.0)?;
        return Some(Fp { dhash, sig, rgb: Some(rgb), aspect: Some(aspect) });
    }
    // v2: "<dhash>:<gray>"
    let (dh, gs) = s.split_once(':')?;
    let dhash = u64::from_str_radix(dh, 16).ok()?;
    let sig = hex_bytes(gs).filter(|v| v.len() == 256)?;
    Some(Fp { dhash, sig, rgb: None, aspect: None })
}

/// Mean absolute difference of two equal-length signatures (0 = identical).
fn sig_mad(a: &[u8], b: &[u8]) -> u32 {
    if a.is_empty() || a.len() != b.len() { return u32::MAX; }
    a.iter().zip(b).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs()).sum::<u32>() / a.len() as u32
}

/// One item as the duplicate finder sees it.
struct DupCand {
    motion:   bool,                // video / GIF — only ever compared with each other
    fp:       Option<Fp>,
    clip:     Option<Vec<f32>>,    // CLIP embedding, L2-normalised (clip.rs)
    words:    HashSet<String>,     // text found in the picture (OCR), normalised
    duration: Option<f64>,
    aspect:   f64,                 // of the trimmed picture when known
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum DupLevel { Possible, Identical }

const DUP_ASPECT_TOL: f64 = 1.06;      // a resized copy keeps its shape
const DUP_CLIP_STILL: f32 = 0.95;      // same picture: unrelated designs sit ≤ 0.81 (real library)
const DUP_CLIP_CLIP: f32 = 0.90;       // same-length videos: thumbnails may be different frames
const DUP_GRAY_MAX: u32 = 12;          // light/dark layout must still line up…
const DUP_RGB_MAX: u32 = 20;           // …and so must the colours

fn ocr_words(text: &str) -> HashSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2)
        .map(|w| w.to_lowercase())
        .collect()
}

/// Are these two items the same picture / video? Every signal has to agree:
/// kind → shape → length (videos) → the words in it → what it shows (CLIP) → layout and
/// colour (fingerprint). Calibrated on a real 479-item library, where all 18 pairs the user
/// marked "not duplicates" scored CLIP ≤ 0.81 and shared no words, while the one real copy
/// (a reel saved twice) scored 0.92 with lengths 0.06 s apart.
fn dup_match(a: &DupCand, b: &DupCand) -> Option<DupLevel> {
    use DupLevel::*;
    if a.motion != b.motion { return None; }

    let (hi, lo) = if a.aspect >= b.aspect { (a.aspect, b.aspect) } else { (b.aspect, a.aspect) };
    if lo <= 0.0 || hi / lo > DUP_ASPECT_TOL { return None; }

    let same_length = match (a.duration, b.duration) {
        (Some(x), Some(y)) if x > 0.0 && y > 0.0 => {
            if (x - y).abs() > 0.6f64.max(0.03 * x.max(y)) { return None; }
            true
        }
        _ => false,
    };

    // Same template, different words (a poster series, a UI kit's screens) is not a copy.
    if a.words.len() >= 3 && b.words.len() >= 3 {
        let common = a.words.intersection(&b.words).count();
        let all = a.words.len() + b.words.len() - common;
        if common * 2 < all { return None; }
    }

    let fp = match (&a.fp, &b.fp) {
        (Some(x), Some(y)) => Some((
            sig_mad(&x.sig, &y.sig),
            (x.dhash ^ y.dhash).count_ones(),
            match (&x.rgb, &y.rgb) { (Some(p), Some(q)) => Some(sig_mad(p, q)), _ => None },
        )),
        _ => None,
    };

    match (&a.clip, &b.clip) {
        (Some(x), Some(y)) => {
            let cos: f32 = x.iter().zip(y).map(|(p, q)| p * q).sum();
            if a.motion && same_length {
                if cos < DUP_CLIP_CLIP { return None; }
                return Some(if cos >= 0.97 { Identical } else { Possible });
            }
            if cos < DUP_CLIP_STILL { return None; }
            let (gray, _, rgb) = fp?;
            if gray > DUP_GRAY_MAX || rgb.is_some_and(|c| c > DUP_RGB_MAX) { return None; }
            Some(if cos >= 0.975 && gray <= 4 { Identical } else { Possible })
        }
        // Not embedded yet (model still downloading / indexing): fingerprint only, strictly.
        _ => {
            let (gray, dh, rgb) = fp?;
            if a.motion && !same_length && (a.duration.is_some() || b.duration.is_some()) { return None; }
            if gray > 4 || dh > 10 || rgb.is_some_and(|c| c > 10) { return None; }
            Some(if gray <= 2 && dh <= 4 { Identical } else { Possible })
        }
    }
}

/// Group matching items. Every pair inside a group must match, and no pair the user
/// marked "not duplicates" may share a group — the old seed-only check let B and C come
/// back together whenever both still matched A. `order` is oldest first, so a group's
/// first item is the one to keep.
fn cluster_dupes(
    order: &[usize],
    edges: &HashMap<(usize, usize), DupLevel>,
    used: &mut [bool],
    ignored: &dyn Fn(usize, usize) -> bool,
) -> Vec<(Vec<usize>, DupLevel)> {
    let edge = |a: usize, b: usize| edges.get(&(a.min(b), a.max(b))).copied();
    let rank: HashMap<usize, usize> = order.iter().enumerate().map(|(r, &i)| (i, r)).collect();
    let mut neighbours: HashMap<usize, Vec<usize>> = HashMap::new();
    for &(a, b) in edges.keys() {
        neighbours.entry(a).or_default().push(b);
        neighbours.entry(b).or_default().push(a);
    }
    let mut groups = Vec::new();
    for &seed in order {
        if used[seed] { continue; }
        let Some(nb) = neighbours.get(&seed) else { continue };
        let mut cands: Vec<usize> = nb.iter().copied().filter(|&c| !used[c]).collect();
        cands.sort_by_key(|c| rank.get(c).copied().unwrap_or(usize::MAX));
        let mut members = vec![seed];
        let mut level = DupLevel::Identical;
        for c in cands {
            let links: Option<Vec<DupLevel>> = members.iter()
                .map(|&m| if ignored(m, c) { None } else { edge(m, c) })
                .collect();
            if let Some(links) = links {
                level = links.into_iter().fold(level, |l, e| l.min(e));
                members.push(c);
            }
        }
        if members.len() >= 2 {
            for &m in &members { used[m] = true; }
            groups.push((members, level));
        }
    }
    groups
}

/// Fill in perceptual hashes for any items missing one — new imports, videos whose
/// thumbnail arrived after import, and the pre-existing library. Cheap when nothing
/// is missing (only touches rows where phash IS NULL). File I/O runs off the lock.
pub fn ensure_phashes(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<AppState>();

    let rows: Vec<(String, String, Option<String>, String)> = {
        let db = match state.db.lock() { Ok(d) => d, Err(_) => return };
        let mut stmt = match db.prepare(
            "SELECT id, type, thumbnail_path, stored_path FROM inspirations \
             WHERE phash IS NULL OR phash_source IS NOT ?1"
        ) { Ok(s) => s, Err(_) => return };
        let mapped = match stmt.query_map([FP_VERSION], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?,
        ))) { Ok(m) => m, Err(_) => return };
        mapped.filter_map(|r| r.ok()).collect()
    };
    if rows.is_empty() { return; }

    // Decoding images is the expensive part — fan it out across cores. Each thread
    // hashes its own chunk (no shared state, no lock), then we write all results
    // once under a single lock. Keeps the DB lock held for milliseconds, not the
    // whole decode pass.
    let n_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let chunk_size = ((rows.len() + n_threads - 1) / n_threads).max(1);
    let mut handles = Vec::new();
    for chunk in rows.chunks(chunk_size) {
        let chunk = chunk.to_vec();
        handles.push(std::thread::spawn(move || {
            let mut out: Vec<(String, String, String)> = Vec::new();
            for (id, kind, thumb, stored) in chunk {
                // Videos have no still to hash — use the generated thumbnail once it exists.
                let src = if kind == "video" { thumb } else { Some(stored.clone()) };
                if let Some(src) = src {
                    if let Some(ph) = phash_from_path(&src) { out.push((id, ph, stored)); }
                }
            }
            out
        }));
    }
    let results: Vec<(String, String, String)> =
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect();

    if !results.is_empty() {
        if let Ok(db) = state.db.lock() {
            for (id, ph, stored) in &results {
                // Only while the item still shows the file that was hashed: a crop or a restore
                // meanwhile cleared the hash for its new file
                let _ = db.execute(
                    "UPDATE inspirations SET phash = ?1, phash_source = ?3 WHERE id = ?2 AND stored_path = ?4",
                    params![ph, id, FP_VERSION, stored],
                );
            }
        }
        log::info!(target: "Dupes", "phash_backfill computed={}", results.len());
    }
}

#[derive(Serialize)]
pub struct DupItem {
    pub id:          String,
    pub kind:        String,               // image | video | gif
    pub title:       Option<String>,
    pub thumb:       String,               // path to hash-worthy still (thumbnail or file)
    pub created_at:  i64,
    pub collections: Option<String>,       // json array of collection names
}

#[derive(Serialize)]
pub struct DupGroup {
    pub reason:   String,   // "exact" | "identical" | "same_video" | "potential"
    pub distance: u32,      // unused (kept for the frontend contract)
    pub items:    Vec<DupItem>,
}

/// Group duplicate items. Exact = identical file bytes (same file_hash). Otherwise
/// every pair in a group must pass dup_match — the same picture re-encoded, resized,
/// padded or lightly edited, or the same video saved twice — even when title/tags differ.
///
/// Runs on the blocking thread pool (NOT the main thread) so decoding images +
/// the compare never freeze the UI.
#[tauri::command]
pub async fn find_duplicates(app: AppHandle) -> Result<Vec<DupGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || find_duplicates_impl(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn find_duplicates_impl(app: &AppHandle) -> Result<Vec<DupGroup>, String> {
    use tauri::Manager;
    ensure_phashes(app);   // make sure hashes are current before comparing

    let state = app.state::<AppState>();

    struct Row {
        id: String, kind: String, title: Option<String>, stored: String,
        thumb: Option<String>, created_at: i64, file_hash: Option<String>,
        collections: Option<String>, cand: DupCand,
    }

    let rows: Vec<Row> = {
        let db = state.db.lock().map_err(|_| "db lock".to_string())?;
        crate::clip::ensure_table(&db);   // the join below needs it even before the first index
        let mut stmt = db.prepare(
            "SELECT i.id, i.type, i.title, i.stored_path, i.thumbnail_path, i.created_at, i.file_hash, i.phash, i.aspect_ratio,
                    (SELECT json_group_array(c.name)
                     FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
                     WHERE ci.inspiration_id = i.id) AS collection_names,
                    i.ocr_text, i.duration_secs, e.emb
             FROM inspirations i
             LEFT JOIN clip_embeddings e ON e.id = i.id AND e.model = ?1"
        ).map_err(|e| e.to_string())?;
        let mapped = stmt.query_map([crate::clip::MODEL_TAG], |r| {
            let kind: String = r.get(1)?;
            let fp = r.get::<_, Option<String>>(7)?.as_deref().and_then(parse_fp);
            let aspect = fp.as_ref().and_then(|f| f.aspect)
                .unwrap_or(r.get::<_, Option<f64>>(8)?.unwrap_or(1.0));
            let clip = r.get::<_, Option<Vec<u8>>>(12)?.as_deref().and_then(crate::clip::from_blob).map(|mut v| {
                let len = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if len > 0.0 { for x in &mut v { *x /= len; } }
                v
            });
            Ok(Row {
                id: r.get(0)?, title: r.get(2)?, stored: r.get(3)?,
                thumb: r.get(4)?, created_at: r.get(5)?, file_hash: r.get(6)?,
                collections: r.get(9)?,
                cand: DupCand {
                    motion: kind == "video" || kind == "gif",
                    fp, clip, aspect,
                    words: ocr_words(&r.get::<_, Option<String>>(10)?.unwrap_or_default()),
                    duration: r.get(11)?,
                },
                kind,
            })
        }).map_err(|e| e.to_string())?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    let n = rows.len();
    if n < 2 { return Ok(vec![]); }

    // Pairs the user explicitly marked "not duplicates" — never in one group again.
    let ignored: HashSet<(usize, usize)> = {
        let index: HashMap<&str, usize> = rows.iter().enumerate().map(|(i, r)| (r.id.as_str(), i)).collect();
        let db = state.db.lock().map_err(|_| "db lock".to_string())?;
        let mut set = HashSet::new();
        if let Ok(mut stmt) = db.prepare("SELECT a, b FROM ignored_dupes") {
            if let Ok(it) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                for (a, b) in it.flatten() {
                    if let (Some(&i), Some(&j)) = (index.get(a.as_str()), index.get(b.as_str())) {
                        set.insert((i.min(j), i.max(j)));
                    }
                }
            }
        }
        set
    };
    let is_ignored = |a: usize, b: usize| ignored.contains(&(a.min(b), a.max(b)));

    let mut used = vec![false; n];
    let mut clusters: Vec<(&'static str, Vec<usize>)> = Vec::new();

    // 1. Exact — identical file bytes (same hash). Always safe to group.
    {
        let mut by_hash: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, row) in rows.iter().enumerate() {
            if let Some(h) = row.file_hash.as_deref() {
                by_hash.entry(h).or_default().push(i);
            }
        }
        for members in by_hash.into_values() {
            if members.len() >= 2 {
                for &m in &members { used[m] = true; }
                clusters.push(("exact", members));
            }
        }
    }

    // 2. Same picture / video. Only items of the same kind and nearly the same shape can
    //    match, so compare along a sorted aspect window instead of every pair, then verify
    //    each candidate pair with dup_match. Capped so a very large library can't hang.
    const CAP: usize = 20_000;
    if n <= CAP {
        let mut by_shape: Vec<usize> = (0..n).filter(|&i| !used[i]).collect();
        by_shape.sort_by(|&a, &b| {
            let (ca, cb) = (&rows[a].cand, &rows[b].cand);
            ca.motion.cmp(&cb.motion).then(ca.aspect.total_cmp(&cb.aspect))
        });
        let mut edges: HashMap<(usize, usize), DupLevel> = HashMap::new();
        for (k, &i) in by_shape.iter().enumerate() {
            let a = &rows[i].cand;
            for &j in &by_shape[k + 1..] {
                let b = &rows[j].cand;
                if b.motion != a.motion || b.aspect > a.aspect * DUP_ASPECT_TOL { break; }
                if is_ignored(i, j) { continue; }
                if let Some(level) = dup_match(a, b) { edges.insert((i.min(j), i.max(j)), level); }
            }
        }
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|&i| rows[i].created_at);
        for (members, level) in cluster_dupes(&order, &edges, &mut used, &is_ignored) {
            let reason = match level {
                DupLevel::Identical if rows[members[0]].cand.motion => "same_video",
                DupLevel::Identical => "identical",
                DupLevel::Possible => "potential",
            };
            clusters.push((reason, members));
        }
    }

    // 3. Build output groups (oldest copy first = the one to keep).
    let mut groups: Vec<DupGroup> = Vec::new();
    for (reason, mut members) in clusters {
        members.sort_by_key(|&m| rows[m].created_at);
        let items = members.iter().map(|&m| {
            let r = &rows[m];
            DupItem {
                id: r.id.clone(), kind: r.kind.clone(), title: r.title.clone(),
                thumb: r.thumb.clone().unwrap_or_else(|| r.stored.clone()),
                created_at: r.created_at, collections: r.collections.clone(),
            }
        }).collect();
        groups.push(DupGroup { reason: reason.to_string(), distance: 0, items });
    }

    // Exact copies first, then near-certain, then possible matches; larger groups higher.
    groups.sort_by(|a, b| {
        let rank = |r: &str| match r { "exact" => 0, "identical" | "same_video" => 1, _ => 2 };
        rank(&a.reason).cmp(&rank(&b.reason)).then(b.items.len().cmp(&a.items.len()))
    });

    Ok(groups)
}

/// Record that the given items are NOT duplicates of each other, so `find_duplicates`
/// never groups them again. Stores every pairwise combination (canonical a < b).
#[tauri::command]
pub fn mark_not_duplicates(ids: Vec<String>, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    for i in 0..ids.len() {
        for j in (i + 1)..ids.len() {
            let (a, b) = if ids[i] < ids[j] { (&ids[i], &ids[j]) } else { (&ids[j], &ids[i]) };
            db.execute("INSERT OR IGNORE INTO ignored_dupes (a, b) VALUES (?1, ?2)", params![a, b])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct SimilarResult {
    #[serde(flatten)]
    item: Inspiration,
    tier: u8,   // 0 = clearly looks alike (full opacity); 1 = loosely looks alike (dimmed)
}

/// Find images that look like `id`. Ranked purely on appearance — what the image shows,
/// its style and colours (CLIP embeddings, clip.rs; fingerprint fallback until the library
/// is indexed) — never on tags, titles or detected objects. The canvas dims tier 1.
#[tauri::command]
pub async fn find_similar(app: AppHandle, id: String, limit: i64) -> Result<Vec<SimilarResult>, String> {
    tauri::async_runtime::spawn_blocking(move || find_similar_impl(&app, &id, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// Fingerprint ranking (dHash + 16×16 grayscale) — a near-duplicate detector, blind to
/// content and colour. Only the fallback now, until CLIP embeddings exist (clip.rs).
/// Visual only: just the items within the fingerprint threshold, nearest first.
fn legacy_similar_order(app: &AppHandle, id: &str, limit: i64) -> Result<Vec<(String, u8)>, String> {
    use tauri::Manager;
    ensure_phashes(app);
    let state = app.state::<AppState>();

    struct Cand { id: String, fp: Fp, aspect: f64 }

    let (target, cands): (Option<(Fp, f64)>, Vec<Cand>) = {
        let db = state.db.lock().map_err(|_| "db lock".to_string())?;
        let mut target = None;
        let mut cands = Vec::new();
        if let Ok(mut stmt) = db.prepare(
            "SELECT id, phash, aspect_ratio FROM inspirations \
             WHERE type IN ('image','gif') AND phash IS NOT NULL"
        ) {
            if let Ok(it) = stmt.query_map([], |r| Ok((
                r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<f64>>(2)?,
            ))) {
                for (rid, ph, ar) in it.flatten() {
                    let Some(fp) = ph.as_deref().and_then(parse_fp) else { continue };
                    if rid == id { target = Some((fp, ar.unwrap_or(1.0))); }
                    else { cands.push(Cand { id: rid, fp, aspect: ar.unwrap_or(1.0) }); }
                }
            }
        }
        (target, cands)
    };
    let Some((tfp, taspect)) = target else { return Ok(vec![]); };

    const MAX_ASPECT: f64 = 2.2;
    const VISUAL_MAX: u32 = 100;   // dHash*3 + MAD threshold to count as "visually similar"
    let limit = limit.max(0) as usize;

    let mut visual: Vec<(u32, String)> = cands.iter().filter_map(|c| {
        let (hi, lo) = if taspect >= c.aspect { (taspect, c.aspect) } else { (c.aspect, taspect) };
        if lo > 0.0 && hi / lo > MAX_ASPECT { return None; }
        let dh  = (tfp.dhash ^ c.fp.dhash).count_ones();
        let mad = tfp.sig.iter().zip(c.fp.sig.iter())
            .map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs()).sum::<u32>() / 256;
        let d = dh * 3 + mad;
        (d <= VISUAL_MAX).then(|| (d, c.id.clone()))
    }).collect();
    visual.sort_by_key(|(d, _)| *d);
    visual.truncate(limit.min(18));
    Ok(visual.into_iter().map(|(_, id)| (id, 0u8)).collect())
}

fn find_similar_impl(app: &AppHandle, id: &str, limit: i64) -> Result<Vec<SimilarResult>, String> {
    use tauri::Manager;
    use std::collections::HashMap;
    let state = app.state::<AppState>();

    // CLIP ranking (content + style + colour) once the library is indexed; the
    // fingerprint ranking only until then.
    let ordered: Vec<(String, u8)> = match crate::clip::rank_similar(app, id, limit.max(0) as usize) {
        Some(o) => o,
        None => legacy_similar_order(app, id, limit)?,
    };
    if ordered.is_empty() { return Ok(vec![]); }

    // Fetch full rows, preserving order + tier.
    let ids: Vec<String> = ordered.iter().map(|(id, _)| id.clone()).collect();
    let tier_of: HashMap<&str, u8> = ordered.iter().map(|(id, t)| (id.as_str(), *t)).collect();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, lens_suggestions, auto_tag_model, duration_secs,
                (SELECT json_group_array(c.name) FROM collection_items ci
                 JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names, enhanced_path, auto_tag_sig, (original_path IS NOT NULL) AS has_original
         FROM inspirations WHERE id IN ({placeholders})"
    );
    let db = state.db.lock().map_err(|_| "db lock".to_string())?;
    let mut map: HashMap<String, Inspiration> = HashMap::new();
    if let Ok(mut stmt) = db.prepare(&sql) {
        if let Ok(it) = stmt.query_map(rusqlite::params_from_iter(ids.iter()), row_to_inspiration) {
            for insp in it.flatten() { map.insert(insp.id.clone(), insp); }
        }
    }
    Ok(ids.into_iter().filter_map(|id| {
        let tier = *tier_of.get(id.as_str()).unwrap_or(&1);
        map.remove(&id).map(|item| SimilarResult { item, tier })
    }).collect())
}

pub(crate) fn palette_from_path(path: &str, num_colors: usize) -> Vec<String> {
    match image::open(path) {
        Ok(img) => palette_from_image(&img, num_colors),
        Err(_) => vec![],
    }
}

/// A picture's main colours as "#rrggbb", most frequent first, each visibly different from the
/// others (crop.rs uses it on the cut it already has in memory).
pub(crate) fn palette_from_image(img: &image::DynamicImage, num_colors: usize) -> Vec<String> {
    let img = img.resize(80, 80, image::imageops::FilterType::Triangle);
    let pixels: Vec<[u8; 3]> = img.pixels()
        .filter(|(_, _, p)| p[3] > 127)
        .map(|(_, _, p)| [p[0], p[1], p[2]])
        .collect();
    if pixels.is_empty() { return vec![]; }

    // Over-generate candidate colours (many more buckets than we return) so that
    // genuinely distinct minority colours get their own bucket instead of being
    // drowned out by a dominant region that median-cut splits into many
    // near-identical shades. 2^5 = 32 candidates.
    let mut buckets = palette_median_cut(pixels, 5);
    buckets.retain(|b| !b.is_empty());

    // Average each bucket → (rgb, weight), most-frequent first.
    let mut candidates: Vec<([i32; 3], usize)> = buckets.iter().map(|bucket| {
        let n = bucket.len() as u32;
        let (sr, sg, sb) = bucket.iter().fold((0u32, 0u32, 0u32), |acc, &[r, g, b]| {
            (acc.0 + r as u32, acc.1 + g as u32, acc.2 + b as u32)
        });
        ([(sr/n) as i32, (sg/n) as i32, (sb/n) as i32], bucket.len())
    }).collect();
    candidates.sort_by(|a, b| b.1.cmp(&a.1));

    // Greedily pick dominant-first colours that are each far enough apart to be
    // visibly distinct, dropping near-duplicates. If the image is genuinely
    // near-monochrome we return fewer colours rather than padding with clones.
    const MIN_DIST_SQ: i32 = 40 * 40;   // ~perceptibly different per channel
    let mut chosen: Vec<[i32; 3]> = Vec::with_capacity(num_colors);
    for (c, _) in &candidates {
        if chosen.len() >= num_colors { break; }
        let distinct = chosen.iter().all(|s| {
            let dr = s[0]-c[0]; let dg = s[1]-c[1]; let db = s[2]-c[2];
            dr*dr + dg*dg + db*db >= MIN_DIST_SQ
        });
        if distinct { chosen.push(*c); }
    }

    chosen.into_iter()
        .map(|c| format!("#{:02x}{:02x}{:02x}", c[0] as u8, c[1] as u8, c[2] as u8))
        .collect()
}

fn palette_median_cut(mut pixels: Vec<[u8; 3]>, depth: usize) -> Vec<Vec<[u8; 3]>> {
    if depth == 0 || pixels.is_empty() { return vec![pixels]; }
    let (mut rn, mut rx, mut gn, mut gx, mut bn, mut bx) = (255u8,0,255u8,0,255u8,0);
    for &[r,g,b] in &pixels {
        rn=rn.min(r); rx=rx.max(r); gn=gn.min(g); gx=gx.max(g); bn=bn.min(b); bx=bx.max(b);
    }
    let ch = if rx-rn >= gx-gn && rx-rn >= bx-bn { 0 }
             else if gx-gn >= bx-bn { 1 } else { 2 };
    pixels.sort_by_key(|p| p[ch]);
    let mid = pixels.len() / 2;
    let right = pixels.split_off(mid);
    let mut out = palette_median_cut(pixels, depth - 1);
    out.extend(palette_median_cut(right, depth - 1));
    out
}

#[tauri::command]
pub fn extract_palette(id: String, path: String, state: State<AppState>) -> Result<Vec<String>, String> {
    let colors = palette_from_path(&path, 5);
    if colors.is_empty() { return Ok(vec![]); }
    let json = serde_json::to_string(&colors).map_err(|e| e.to_string())?;
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE inspirations SET palette = ?1, updated_at = ?2 WHERE id = ?3",
        params![json, now_ms(), id],
    ).map_err(|e| e.to_string())?;
    Ok(colors)
}

// ─── Reindex ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ReindexResult {
    pub tags_rebuilt: i64,
    pub media_requeued: i64,
}

#[tauri::command]
pub fn reindex_library(state: State<AppState>) -> Result<ReindexResult, String> {
    let db = state.db.lock().unwrap();

    // Rebuild tag_usage_counts from ground truth
    db.execute_batch(crate::db::RECOUNT_ALL_TAGS).map_err(|e| e.to_string())?;

    let tags_rebuilt: i64 = db
        .query_row("SELECT COUNT(*) FROM tag_usage_counts", [], |r| r.get(0))
        .unwrap_or(0);

    // Reset OCR so every image/gif is re-analysed on next pass
    db.execute_batch(
        "UPDATE inspirations SET ocr_status = NULL, ocr_text = '' WHERE type IN ('image','gif')"
    ).map_err(|e| e.to_string())?;

    // Reset object detection too — the same "Reindex" button re-analyses content so
    // keyword search (e.g. "box") picks up newly-detected objects across the library.
    db.execute_batch(
        "UPDATE inspirations SET object_status = NULL, object_tags = '' WHERE type IN ('image','gif')"
    ).map_err(|e| e.to_string())?;

    let media_requeued: i64 = db
        .query_row("SELECT COUNT(*) FROM inspirations WHERE type IN ('image','gif')", [], |r| r.get(0))
        .unwrap_or(0);

    Ok(ReindexResult { tags_rebuilt, media_requeued })
}

// ─── Vault ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_vault_info(app: AppHandle, state: State<AppState>) -> Result<VaultInfo, String> {
    let vault_path   = vault::get_vault_path(&app).map_err(|e| e.to_string())?;
    let default_path = vault::default_vault_path(&app).map_err(|e| e.to_string())?;
    let is_default   = vault::read_custom_vault_path(&app).map(|c| c.is_none()).unwrap_or(true);
    let db = state.db.lock().unwrap();
    let total: i64 = db.query_row("SELECT COUNT(*) FROM inspirations", [], |r| r.get(0)).unwrap_or(0);
    let size_bytes  = vault::dir_size_bytes(&vault_path);
    let disk_free   = vault::disk_free_bytes(&vault_path).unwrap_or(0);
    Ok(VaultInfo {
        path:         vault_path.to_string_lossy().into_owned(),
        default_path: default_path.to_string_lossy().into_owned(),
        total_items:  total,
        size_bytes,
        disk_free_bytes: disk_free,
        is_default,
    })
}

#[tauri::command]
pub async fn pick_vault_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog()
        .file()
        .blocking_pick_folder();
    Ok(path.map(|p: tauri_plugin_dialog::FilePath| p.to_string()))
}

#[tauri::command]
pub async fn pick_cookies_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog()
        .file()
        .add_filter("Cookies text file", &["txt"])
        .blocking_pick_file();
    let Some(fp) = path else { return Ok(None) };
    let path_str = fp.to_string();
    // Validate Netscape cookie-jar header so users can't accidentally pick the wrong file.
    let first_line = std::fs::read_to_string(&path_str)
        .ok()
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()));
    if first_line.as_deref() != Some("# Netscape HTTP Cookie File") {
        return Err("Not a valid cookies.txt file. Export cookies from your browser using the 'Get cookies.txt LOCALLY' extension.".to_string());
    }
    Ok(Some(path_str))
}

const EXTRA_FREE_BYTES: u64 = 5 * 1024 * 1024 * 1024; // 5 GB

#[tauri::command]
pub async fn relocate_vault(
    new_path: String,
    migrate: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RelocateResult, String> {
    let new_vault = std::path::PathBuf::from(&new_path);
    let old_vault = vault::get_vault_path(&app).map_err(|e| e.to_string())?;

    // ── Pre-flight checks ──────────────────────────────────────────
    if new_vault == old_vault {
        return Err("New path is the same as the current vault location.".into());
    }

    // Reject if new path is inside old vault
    if new_vault.starts_with(&old_vault) {
        return Err("New path cannot be inside the current vault folder.".into());
    }

    // Reject cross-disk "no migration" (Option B from architecture)
    if !migrate {
        let old_root = root_component(&old_vault);
        let new_root = root_component(&new_vault);
        if old_root != new_root {
            return Err("Moving to a different disk requires file migration. Please choose 'Move files'.".into());
        }
    }

    // Check destination has no existing files (subdirs from a prior vault structure are fine)
    if new_vault.exists() && vault::dir_size_bytes(&new_vault) > 0 {
        return Err(format!(
            "Destination folder already contains files: {}. Choose an empty folder.",
            new_path
        ));
    }

    // Path length guard (Windows MAX_PATH)
    if new_path.len() + 60 > 255 {
        return Err("Destination path is too long. Choose a shorter path.".into());
    }

    // Disk space check
    if migrate {
        let vault_size   = vault::dir_size_bytes(&old_vault);
        let required     = vault_size + EXTRA_FREE_BYTES;
        let parent_check = new_vault.parent().unwrap_or(&new_vault);
        let free = vault::disk_free_bytes(&parent_check.to_path_buf()).unwrap_or(u64::MAX);
        if free < required {
            let needed_gb  = required as f64 / 1_073_741_824.0;
            let free_gb    = free    as f64 / 1_073_741_824.0;
            return Err(format!(
                "Not enough disk space. Need {:.1} GB, only {:.1} GB free.",
                needed_gb, free_gb
            ));
        }
    }

    // ── Create new vault structure ─────────────────────────────────
    vault::ensure_structure(&new_vault).map_err(|e| e.to_string())?;

    let mut files_moved: u64 = 0;

    if migrate {
        // Collect all files to copy
        let files = collect_vault_files(&old_vault);
        let total = files.len() as u64;

        let _ = app.emit("vault:relocate-progress", serde_json::json!({ "done": 0, "total": total }));

        for (src, rel) in &files {
            let dst = new_vault.join(rel);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    // cleanup partial new vault
                    let _ = std::fs::remove_dir_all(&new_vault);
                    e.to_string()
                })?;
            }
            std::fs::copy(src, &dst).map_err(|e| {
                let _ = std::fs::remove_dir_all(&new_vault);
                format!("Failed to copy {:?}: {}", src, e)
            })?;
            files_moved += 1;
            let _ = app.emit("vault:relocate-progress", serde_json::json!({ "done": files_moved, "total": total }));
        }

        // ── Verify: file count and total size must match ───────────
        let new_size  = vault::dir_size_bytes(&new_vault);
        let old_size  = vault::dir_size_bytes(&old_vault);
        let new_count = collect_vault_files(&new_vault).len();
        if new_count != files.len() || new_size < old_size {
            // Verification failed — roll back
            let _ = std::fs::remove_dir_all(&new_vault);
            return Err(format!(
                "Verification failed: {}/{} files copied. Rolled back — your library is safe at {}. You can delete the incomplete folder at {}.",
                new_count, files.len(), old_vault.display(), new_vault.display()
            ));
        }
    }

    // ── Commit: write new vault path ───────────────────────────────
    vault::write_custom_vault_path(&app, &new_vault).map_err(|e| e.to_string())?;
    let _ = app.asset_protocol_scope().allow_directory(&new_vault, true);

    // ── Update absolute paths in DB ────────────────────────────────
    // Item files, kept originals, upscaled copies and thumbnails are stored as absolute paths,
    // so they must be rewritten to reflect the new vault root.
    if migrate {
        let old_prefix = old_vault.to_string_lossy().into_owned();
        let new_prefix = new_vault.to_string_lossy().into_owned();
        let db = state.db.lock().unwrap();
        move_library_paths(&db, &old_prefix, &new_prefix).map_err(|e| {
            // DB update failed — revert vault_path.txt so old location is restored
            let _ = vault::clear_custom_vault_path(&app);
            format!("Database path update failed: {e}. Vault location reverted.")
        })?;
    }

    // ── Remove old vault files (only after commit + DB update) ─────
    if migrate {
        for (src, _) in collect_vault_files(&old_vault) {
            let _ = std::fs::remove_file(&src);
        }
    }

    let _ = app.emit("vault:relocate-complete", serde_json::json!({ "path": new_path }));

    Ok(RelocateResult { new_path, files_moved })
}

/// After the library folder moved (relocate_vault): every absolute item path under `old` now
/// starts with `new`. The item's file, the first original a cropped picture keeps and the upscaled
/// copy change in one transaction (the old files are deleted next, so none may still point
/// there); thumbnails after it, best effort (a relative one needs nothing, a missing one is only
/// cosmetic).
fn move_library_paths(db: &rusqlite::Connection, old: &str, new: &str) -> rusqlite::Result<()> {
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
    for col in ["stored_path", "original_path", "enhanced_path"] {
        tx.execute(
            &format!("UPDATE inspirations SET {col} = ?2 || SUBSTR({col}, LENGTH(?1) + 1) \
                      WHERE {col} IS NOT NULL AND SUBSTR({col}, 1, LENGTH(?1)) = ?1"),
            params![old, new],
        )?;
    }
    tx.commit()?;
    // thumbnail_path may be absolute or relative; only rewrite absolute ones
    db.execute(
        "UPDATE inspirations \
         SET thumbnail_path = ?2 || SUBSTR(thumbnail_path, LENGTH(?1) + 1) \
         WHERE thumbnail_path IS NOT NULL \
           AND SUBSTR(thumbnail_path, 1, LENGTH(?1)) = ?1",
        params![old, new],
    ).ok(); // best-effort; missing thumbnails are just cosmetic
    Ok(())
}

fn root_component(p: &std::path::Path) -> Option<std::path::PathBuf> {
    p.components().next().map(|c| std::path::PathBuf::from(c.as_os_str()))
}

fn collect_vault_files(vault: &std::path::Path) -> Vec<(std::path::PathBuf, std::path::PathBuf)> {
    let mut out = Vec::new();
    collect_files_recursive(vault, vault, &mut out);
    out
}

fn collect_files_recursive(
    base: &std::path::Path,
    dir:  &std::path::Path,
    out:  &mut Vec<(std::path::PathBuf, std::path::PathBuf)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(base, &path, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push((path.clone(), rel.to_path_buf()));
        }
    }
}

// ─── License ──────────────────────────────────────────────────────

#[tauri::command]
pub fn get_license_cache(state: State<AppState>) -> Result<Option<LicenseCache>, String> {
    let db = state.db.lock().unwrap();
    db.query_row(
        "SELECT license_key, plan_type, expires_at, last_validated_at, device_fingerprint, revoked_at FROM license_cache WHERE id = 1",
        [],
        |row| Ok(LicenseCache {
            license_key: row.get(0)?, plan_type: row.get(1)?,
            expires_at: row.get(2)?, last_validated_at: row.get(3)?,
            device_fingerprint: row.get(4)?, revoked_at: row.get(5)?,
        }),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_license_cache(state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM license_cache WHERE id = 1", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_license_plan(plan_type: String, state: State<AppState>) -> Result<(), String> {
    let db  = state.db.lock().unwrap();
    let now = now_ms();
    // UPSERT: inserts the row if missing, otherwise only touches plan_type + last_validated_at
    db.execute(
        "INSERT INTO license_cache (id, plan_type, last_validated_at)
         VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET
           plan_type         = excluded.plan_type,
           last_validated_at = excluded.last_validated_at",
        rusqlite::params![plan_type, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Refresh ONLY the license cache's last_validated_at (no plan change). Used on a
/// successful re-validation where the server plan already matched the cache — it
/// keeps the 7-day offline grace window alive without rewriting the plan value.
#[tauri::command]
pub fn touch_license_validated(state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE license_cache SET last_validated_at = ?1 WHERE id = 1",
        rusqlite::params![now_ms()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Milestones ───────────────────────────────────────────────────

#[tauri::command]
pub fn list_milestones(state: State<AppState>) -> Result<Vec<Milestone>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare("SELECT id, type, achieved_at, certificate_shown, shared FROM milestones ORDER BY achieved_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(Milestone {
        id: row.get(0)?, r#type: row.get(1)?, achieved_at: row.get(2)?,
        certificate_shown: row.get::<_, i64>(3)? != 0,
        shared: row.get::<_, i64>(4)? != 0,
    })).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

// ─── Notifications ────────────────────────────────────────────────

#[tauri::command]
pub fn get_notifications(state: State<AppState>) -> Result<Vec<Notification>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT n.id, n.type, n.title, n.body, n.data, n.created_at, r.notification_id IS NOT NULL
         FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id
         ORDER BY n.created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(Notification {
        id: row.get(0)?, r#type: row.get(1)?, title: row.get(2)?,
        body: row.get(3)?, data: row.get(4)?, created_at: row.get(5)?,
        read: row.get::<_, i64>(6)? != 0,
    })).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[tauri::command]
pub fn mark_notification_read(id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("INSERT OR IGNORE INTO notification_reads (notification_id, read_at) VALUES (?1, ?2)", params![id, now_ms()]).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Mobile ───────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct MobileQrData {
    pub uri: String,
    pub svg: String,
}

/// New connection key: the old QR code stops working, so a phone that once scanned it
/// (or a photo of it) can no longer send files in. The browser extension shares the key
/// and re-pairs by itself when it sees the change.
#[tauri::command]
pub fn reset_mobile_connection_key(state: State<AppState>) -> Result<MobileQrData, String> {
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES ('extension_connection_key', ?1)",
            [uuid::Uuid::new_v4().to_string()],
        ).map_err(|e| e.to_string())?;
    }
    log::info!(target: "ExtServer", "connection_key_reset");
    get_mobile_connection_qr(state)
}

#[tauri::command]
pub fn get_mobile_connection_qr(state: State<AppState>) -> Result<MobileQrData, String> {
    let db = state.db.lock().unwrap();
    let key: Option<String> = db
        .query_row("SELECT value FROM preferences WHERE key = 'extension_connection_key'", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let key = match key.filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => {
            // No key yet — generate one now so mobile pairing works even without the extension
            let new_key = uuid::Uuid::new_v4().to_string();
            db.execute(
                "INSERT OR REPLACE INTO preferences (key, value) VALUES ('extension_connection_key', ?1)",
                [&new_key],
            ).map_err(|e| e.to_string())?;
            new_key
        }
    };
    let name: String = db
        .query_row("SELECT value FROM preferences WHERE key = 'display_name'", [], |r| r.get(0))
        .unwrap_or_else(|_| "My Computer".to_string());
    drop(db);

    let ip = local_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    let name_enc = urlencoding::encode(&name);
    let uri = format!("qooti://pair?ip={ip}&port=1420&name={name_enc}&key={key}");
    let svg = qr_svg(&uri);
    Ok(MobileQrData { uri, svg })
}

fn local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

fn qr_svg(data: &str) -> String {
    use qrcode::QrCode;
    let code = match QrCode::new(data.as_bytes()) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let width = code.width();
    let colors = code.into_colors();
    let cell: usize = 8;
    let border: usize = 24;
    let total = width * cell + border * 2;
    let mut svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" width="{total}" height="{total}"><rect width="{total}" height="{total}" fill="#ffffff"/>"##
    );
    for y in 0..width {
        for x in 0..width {
            if colors[y * width + x] == qrcode::Color::Dark {
                let px = border + x * cell;
                let py = border + y * cell;
                svg.push_str(&format!(r##"<rect x="{px}" y="{py}" width="{cell}" height="{cell}" fill="#000000"/>"##));
            }
        }
    }
    svg.push_str("</svg>");
    svg
}

// ─── Downloader ───────────────────────────────────────────────────

/// Enqueue a download and return its ID immediately.
/// The download starts as soon as a slot is free (MAX_CONCURRENT = 1).
#[tauri::command]
pub fn download_url(
    app: AppHandle,
    url: String,
    quality: String,
    ext_id: Option<String>,
) -> Result<String, String> {
    // Links reach here from the page, the browser extension and the phone: only plain
    // web addresses go on to the downloader (never options, local files or other schemes).
    if !is_web_url(&url) {
        log::warn!(target: "Download", "rejected_url url={url:?}");
        return Err("Unsupported link".into());
    }
    // Nothing from the user's own network (router, NAS, other programs here) — a web
    // page picks what the extension sends. run_ytdlp checks again after the DNS lookup.
    if crate::net_guard::is_private_literal(&url) {
        log::warn!(target: "Download", "rejected_private_address");
        if let Some(ref eid) = ext_id {
            set_ext_progress(&app, eid, 0.0, "", "error", crate::net_guard::PRIVATE_ADDRESS);
        }
        return Err(crate::net_guard::PRIVATE_ADDRESS.into());
    }
    let vault_path = vault::get_vault_path(&app).map_err(|e| e.to_string())?;
    let tmp_dir = vault_path.join("downloads_tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    // In-app downloads (no ext_id) are capped at FREE_DOWNLOAD_DAILY_LIMIT per day for
    // free users. Charged here (so a burst of requests can't overshoot the limit) and
    // refunded by the queue if the download doesn't succeed — failures and cancels
    // don't use up the quota. Extension saves are charged by extension_server.rs.
    let charged = match ext_id {
        Some(ref eid) => charged_ext_ids().lock().unwrap().remove(eid),
        None => {
            let state = app.state::<AppState>();
            let db = state.db.lock().unwrap();
            let plan = get_plan_from_db(&db);
            if is_free_plan(&plan) {
                let today = chrono::Local::now().format("%Y-%m-%d").to_string();
                let stored_date: String = db.query_row(
                    "SELECT value FROM preferences WHERE key = 'app_dl_date'", [], |r| r.get(0)
                ).unwrap_or_default();
                let used: u32 = if stored_date == today {
                    db.query_row(
                        "SELECT CAST(value AS INTEGER) FROM preferences WHERE key = 'app_dl_count'",
                        [], |r| r.get(0),
                    ).unwrap_or(0)
                } else { 0 };
                if used >= FREE_DOWNLOAD_DAILY_LIMIT {
                    return Err("UPGRADE_REQUIRED:download_limit".to_string());
                }
                let _ = db.execute(
                    "INSERT OR REPLACE INTO preferences (key, value) VALUES ('app_dl_date', ?1)",
                    [&today],
                );
                let _ = db.execute(
                    "INSERT OR REPLACE INTO preferences (key, value) VALUES ('app_dl_count', ?1)",
                    [(used + 1).to_string()],
                );
                true
            } else {
                false
            }
        }
    };

    let download_id = Uuid::new_v4().to_string();

    // Register the ext_id ↔ download_id mapping immediately so that
    // cancel_download_for_ext_id can find queued (not-yet-running) downloads.
    if let Some(ref eid) = ext_id {
        app.state::<AppState>()
            .ext_id_map.lock().unwrap()
            .insert(download_id.clone(), eid.clone());
    }

    // If a download is already running this one will wait — tell the extension.
    let will_queue = ACTIVE_DOWNLOADS.load(Ordering::SeqCst) >= MAX_CONCURRENT;
    if will_queue {
        if let Some(ref eid) = ext_id {
            set_ext_progress(&app, eid, 0.0, "", "queued", "Waiting in queue…");
        }
        let _ = app.emit("download:queued", serde_json::json!({
            "download_id": &download_id,
        }));
    }

    download_queue().lock().unwrap().push_back(DownloadRequest {
        app: app.clone(),
        download_id: download_id.clone(),
        url,
        quality,
        tmp_dir,
        ext_id,
        charged,
    });

    try_start_next();

    Ok(download_id)
}

/// An http(s) address with a host and no spaces or control characters.
fn is_web_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
    url.len() <= 4096
        && url == url.trim()
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && rest.is_some_and(|r| r.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '['))
}

pub fn ytdlp_binary_path(app: &AppHandle) -> std::path::PathBuf {
    ytdlp_binary(app)
}

/// Writable, self-updated copy of yt-dlp under the app-data dir. Once seeded and
/// refreshed by `update_ytdlp_once`, this is preferred over the frozen bundled
/// binary so YouTube fixes land without shipping a new app build. `None` if the
/// app-data dir can't be resolved.
fn ytdlp_managed_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    #[cfg(windows)]      let name = "yt-dlp.exe";
    #[cfg(not(windows))] let name = "yt-dlp";
    app.path().app_data_dir().ok().map(|d| d.join("bin").join(name))
}

fn ytdlp_binary(app: &AppHandle) -> std::path::PathBuf {
    // Prefer the self-updated copy in app-data when present (see update_ytdlp_once).
    if let Some(mp) = ytdlp_managed_path(app) {
        if mp.exists() {
            log::debug!(target: "Boot", "ytdlp=managed path={:?}", mp);
            return mp;
        }
    }
    ytdlp_bundled_binary(app)
}

/// Resolve the yt-dlp that ships inside the app bundle (resource dir / next to the
/// exe / dev `binaries/`). This is the seed for the managed copy and the offline
/// fallback when no update has run yet.
fn ytdlp_bundled_binary(app: &AppHandle) -> std::path::PathBuf {
    // Plain name used in resource dir (Tauri strips the triple suffix at install time)
    #[cfg(windows)]     let name         = "yt-dlp.exe";
    #[cfg(not(windows))]let name         = "yt-dlp";

    // Name Tauri uses for externalBin: includes the target triple
    #[cfg(target_os = "windows")] let bundled_name = "yt-dlp-x86_64-pc-windows-msvc.exe";
    #[cfg(target_os = "macos")]   let bundled_name = "yt-dlp-aarch64-apple-darwin";
    #[cfg(target_os = "linux")]   let bundled_name = "yt-dlp-x86_64-unknown-linux-gnu";

    // Production: resource dir (Tauri strips the triple suffix here)
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(name);
        if p.exists() {
            log::debug!(target: "Boot", "ytdlp=resource path={:?}", p);
            return p;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        // Installed / cargo run: binary sits next to the exe with triple suffix
        if let Some(dir) = exe.parent() {
            let p = dir.join(bundled_name);
            if p.exists() {
                log::debug!(target: "Boot", "ytdlp=exe_dir_triple path={:?}", p);
                return p;
            }
            let p = dir.join(name);
            if p.exists() {
                log::debug!(target: "Boot", "ytdlp=exe_dir_plain path={:?}", p);
                return p;
            }
        }

        // Dev (cargo run / tauri dev): exe is at src-tauri/target/debug/qooti.exe
        // The externalBin lives in src-tauri/binaries/
        let maybe_src_tauri = exe
            .parent()               // .../target/debug/
            .and_then(|d| d.parent()) // .../target/
            .and_then(|d| d.parent()); // .../src-tauri/
        if let Some(src_tauri) = maybe_src_tauri {
            let p = src_tauri.join("binaries").join(bundled_name);
            if p.exists() {
                log::debug!(target: "Boot", "ytdlp=dev_binaries path={:?}", p);
                return p;
            }
        }
    }

    let fallback = std::path::PathBuf::from(name);
    log::warn!(target: "Boot", "ytdlp=PATH_fallback path={:?}", fallback);
    fallback
}

/// Keep yt-dlp current by self-updating a writable copy in app-data, at most once
/// per 24 h. YouTube breaks a frozen yt-dlp every few weeks (HTTP 403 on the media
/// fetch), so the bundled binary is only a seed. Runs on a background thread at
/// boot — never blocks startup. Offline-safe: seeding + the bundled fallback keep
/// downloads working even when the update check can't reach GitHub.
pub fn update_ytdlp_once(app: &AppHandle) {
    let managed = match ytdlp_managed_path(app) { Some(p) => p, None => return };

    const DAY: i64 = 24 * 60 * 60;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Throttle: check at most once per day (independent of outcome). Skip only when
    // we already have a managed copy — the first run must always seed it.
    {
        let state = app.state::<AppState>();
        let lock  = state.db.lock();
        if let Ok(db) = lock {
            let last: i64 = db.query_row(
                "SELECT value FROM preferences WHERE key = 'ytdlp_update_checked_at'",
                [], |r| r.get::<_, String>(0),
            ).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
            if managed.exists() && now.saturating_sub(last) < DAY {
                return;
            }
        }
    }

    if let Some(dir) = managed.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            log::warn!(target: "Boot", "ytdlp_bin_dir_failed dir={:?} err={}", dir, e);
            return;
        }
    }

    // Seed the managed copy from the bundled binary the first time so `--update`
    // has a real release binary to refresh in place.
    if !managed.exists() {
        let src = ytdlp_bundled_binary(app);
        if let Err(e) = std::fs::copy(&src, &managed) {
            log::warn!(target: "Boot", "ytdlp_seed_failed src={:?} err={}", src, e);
            return;
        }
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o755));
        }
        log::info!(target: "Boot", "ytdlp_seeded path={:?}", managed);
    }

    // Record the attempt up front so a hung/failed check doesn't retry every boot.
    {
        let state = app.state::<AppState>();
        let lock  = state.db.lock();
        if let Ok(db) = lock {
            let _ = db.execute(
                "INSERT OR REPLACE INTO preferences (key, value) VALUES ('ytdlp_update_checked_at', ?1)",
                params![now.to_string()],
            );
        }
    }

    // Self-update to the latest stable release (a fast no-op when already current).
    // yt-dlp verifies the download and atomically replaces its own file.
    match hidden_command(&managed).arg("--update").output() {
        Ok(out) => {
            let msg = format!("{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr));
            log::info!(target: "Boot", "ytdlp_update ok={} msg={}",
                out.status.success(), msg.replace('\n', " ").trim());
        }
        Err(e) => log::warn!(target: "Boot", "ytdlp_update_failed err={}", e),
    }
}

pub(crate) fn ffmpeg_binary(app: &AppHandle) -> Option<std::path::PathBuf> {
    #[cfg(windows)]     let name         = "ffmpeg.exe";
    #[cfg(not(windows))]let name         = "ffmpeg";

    #[cfg(target_os = "windows")] let bundled_name = "ffmpeg-x86_64-pc-windows-msvc.exe";
    #[cfg(target_os = "macos")]   let bundled_name = "ffmpeg-aarch64-apple-darwin";
    #[cfg(target_os = "linux")]   let bundled_name = "ffmpeg-x86_64-unknown-linux-gnu";

    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(name);
        if p.exists() {
            log::debug!(target: "Boot", "ffmpeg=resource path={:?}", p);
            return Some(p);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in &[bundled_name, name] {
                let p = dir.join(candidate);
                if p.exists() {
                    log::debug!(target: "Boot", "ffmpeg=exe_dir path={:?}", p);
                    return Some(p);
                }
            }
        }

        let maybe_src_tauri = exe
            .parent()
            .and_then(|d| d.parent())
            .and_then(|d| d.parent());
        if let Some(src_tauri) = maybe_src_tauri {
            let p = src_tauri.join("binaries").join(bundled_name);
            if p.exists() {
                log::debug!(target: "Boot", "ffmpeg=dev_binaries path={:?}", p);
                return Some(p);
            }
        }
    }

    // Fall back to system ffmpeg in PATH
    if hidden_command("ffmpeg").arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status().is_ok()
    {
        log::debug!(target: "Boot", "ffmpeg=system_PATH");
        return Some(std::path::PathBuf::from("ffmpeg"));
    }

    log::warn!(target: "Boot", "ffmpeg=not_found quality_capped=360p");
    None
}

// Returns (duration_secs, aspect_ratio) by running ffmpeg -i once.
fn video_meta(path: &std::path::Path, app: &AppHandle) -> (Option<f64>, Option<f64>) {
    let ffmpeg = match ffmpeg_binary(app) {
        Some(f) => f,
        None    => return (None, None),
    };
    let mut child = match hidden_command(&ffmpeg)
        .args(["-i", &path.to_string_lossy().into_owned()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c)  => c,
        Err(_) => return (None, None),
    };

    // Read stderr on a background thread so we can enforce a timeout without
    // blocking the import/finalize call indefinitely on a malformed video file.
    let stderr_pipe = match child.stderr.take() {
        Some(p) => p,
        None    => return (None, None),
    };
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let _ = std::io::BufReader::new(stderr_pipe).read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let stderr_bytes = match rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(b)  => b,
        Err(_) => {
            log::warn!(target: "VideoMeta", "ffmpeg timed out path={:?}", path);
            child.kill().ok();
            return (None, None);
        }
    };
    child.wait().ok();
    let stderr = String::from_utf8_lossy(&stderr_bytes);

    let duration = (|| {
        let pos      = stderr.find("Duration:")?;
        let rest     = &stderr[pos + "Duration:".len()..];
        let end      = rest.find(',')?;
        let time_str = rest[..end].trim();
        let parts: Vec<&str> = time_str.split(':').collect();
        if parts.len() != 3 { return None; }
        let h: f64 = parts[0].trim().parse().ok()?;
        let m: f64 = parts[1].trim().parse().ok()?;
        let s: f64 = parts[2].trim().parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + s)
    })();

    // ffmpeg prints e.g. "Video: h264 ..., 1080x1920, ..." — parse WxH
    let aspect = stderr.find(" Video: ")
        .and_then(|p| parse_video_wh(&stderr[p..]));

    (duration, aspect)
}

fn parse_video_wh(s: &str) -> Option<f64> {
    // Scan for "WxH" where W and H are 2–5 ASCII digits (handles 16x9 through 7680x4320).
    for (i, _) in s.match_indices('x') {
        if i == 0 { continue; }
        let left    = &s[..i];
        let w_start = left.rfind(|c: char| !c.is_ascii_digit()).map(|p| p + 1).unwrap_or(0);
        let w_str   = &left[w_start..];
        let right   = &s[i + 1..];
        let h_end   = right.find(|c: char| !c.is_ascii_digit()).unwrap_or(right.len());
        let h_str   = &right[..h_end];
        if !(2..=5).contains(&w_str.len()) || !(2..=5).contains(&h_str.len()) { continue; }
        if let (Ok(w), Ok(h)) = (w_str.parse::<f64>(), h_str.parse::<f64>()) {
            if w > 0.0 && h > 0.0 { return Some(w / h); }
        }
    }
    None
}

/// Why a save from the browser extension failed: (code, raw-error needles, wording).
/// Checked in order. The extension shows its own translation of the code (English or
/// Uzbek); the English wording is for older extensions, which cut it at 80 chars.
const EXT_ERRORS: &[(&str, &[&str], &str)] = &[
    ("private_address",    &["private_address"], "qooti doesn't download from addresses on your own network."),
    ("youtube_setup",      &["couldn't set up youtube"], "Couldn't set up YouTube. Check your internet and try again."),
    ("not_video",          &["couldn't read the video link"], "This link isn't a video. Open the video itself and try again."),
    ("timeout",            &["timed out", "timeout"], "This took too long. Please try again."),
    ("unavailable",        &["private video", "video unavailable", "is unavailable", "has been removed", "members-only", "not available in your country"], "This video is private, removed or unavailable."),
    ("age_bot",            &["sign in to confirm", "confirm your age", "age-restricted"], "YouTube blocked this one (age or bot check). Try again later."),
    ("signin",             &["qooti extension", "browser session", "logged-in", "login required", "cookies"], "Sign in to this site in your browser, then try again."),
    ("unsupported",        &["unsupported url", "private or unsupported"], "qooti can't save from this link."),
    ("refused",            &["http error 403", "forbidden", "http error 429", "http error 503", "challenge"], "The site refused the download. Try again in a few minutes."),
    ("network",            &["unable to download webpage", "getaddrinfo", "failed to resolve", "connection", "network"], "Couldn't connect. Check your internet and try again."),
    ("missing_downloader", &["yt-dlp not found"], "qooti's downloader is missing. Reinstall qooti to fix it."),
    ("nothing_found",      &["no importable files", "no output files", "requested format is not available"], "No video or image found here."),
    ("add_failed",         &["save failed", "couldn't add"], "Downloaded, but couldn't add it to your library."),
    ("image_failed",       &["failed to save image", "failed to download image"], "Couldn't save this image."),
];
const EXT_ERROR_GENERIC: &str = "Couldn't save this. Please try again.";

/// What the browser extension shows when a save fails: short, plain words. The raw
/// error stays in the log.
pub(crate) fn friendly_ext_error(raw: &str) -> String {
    let l = raw.to_lowercase();
    if l.contains("free daily limit") || l.contains("download_limit") { return raw.to_string() }
    EXT_ERRORS.iter()
        .find(|(_, needles, _)| needles.iter().any(|n| l.contains(n)))
        .map_or(EXT_ERROR_GENERIC, |e| e.2)
        .to_string()
}

/// The code for wording made by `friendly_ext_error` ("generic" for anything else).
pub(crate) fn ext_error_code(message: &str) -> &'static str {
    if message.to_lowercase().contains("daily limit") { return "limit" }
    EXT_ERRORS.iter().find(|e| e.2 == message).map_or("generic", |e| e.0)
}

fn set_ext_progress(app: &AppHandle, ext_id: &str, pct: f64, speed: &str, status: &str, message: &str) {
    let state = app.state::<crate::AppState>();
    let message = if status == "error" {
        log::info!(target: "ExtServer", "ext_error ext_id={ext_id} raw={message:?}");
        friendly_ext_error(message)
    } else { message.to_string() };
    let message = message.as_str();
    let mut map = state.ext_progress.lock().unwrap();
    // Preserve existing inspiration_id when updating status
    let existing_insp_id = map.get(ext_id).and_then(|p| p.inspiration_id.clone());
    map.insert(ext_id.to_string(), crate::ExtProgress {
        pct,
        speed:          speed.to_string(),
        status:         status.to_string(),
        message:        message.to_string(),
        inspiration_id: existing_insp_id,
        updated_at:     std::time::Instant::now(),
    });
}

/// Cancel the download associated with the given ext_id.
/// Called by the HTTP server when the extension user hits the × button.
pub fn cancel_download_for_ext_id(ext_id: &str, app: &AppHandle) {
    let state = app.state::<crate::AppState>();

    // ext_id_map is download_id → ext_id; iterate to find matching download_id
    let download_id = {
        let mut map = state.ext_id_map.lock().unwrap();
        let found = map.iter()
            .find(|(_, v)| v.as_str() == ext_id)
            .map(|(k, _)| k.clone());
        if let Some(ref did) = found { map.remove(did); }
        found
    };

    if let Some(did) = download_id {
        log::info!(target: "Download", "cancel ext_id={ext_id} download_id={did}");
        cancel_download_by_id(app, &did);
    }

    set_ext_progress(app, ext_id, 0.0, "", "cancelled", "Cancelled by user");
}


/// Replace the value of a query-string key (naive, first occurrence). Used to bump
/// image-CDN size params (e.g. Twitter `name=small`) to their largest variant.
fn replace_query_value(url: &str, key: &str, val: &str) -> String {
    let needle = format!("{key}=");
    if let Some(pos) = url.find(&needle) {
        let start = pos + needle.len();
        let end = url[start..].find('&').map(|i| start + i).unwrap_or(url.len());
        format!("{}{}{}", &url[..start], val, &url[end..])
    } else {
        url.to_string()
    }
}

/// Rewrite a known image-CDN URL to its highest-resolution variant. Returns `Some`
/// only when a rule matches. Callers MUST try this first and fall back to the
/// original URL — the hi-res variant can 404 for some images.
fn hi_res_image_url(url: &str) -> Option<String> {
    // Pinterest: https://i.pinimg.com/{size}/aa/bb/cc/hash.jpg → /originals/…
    // The size bucket is the first path segment (236x, 474x, 564x, 736x, 60x60…).
    if let Some(idx) = url.find("pinimg.com/") {
        let base_len = idx + "pinimg.com/".len();
        let after = &url[base_len..];
        if let Some(slash) = after.find('/') {
            let seg = &after[..slash];
            let is_size = seg != "originals"
                && !seg.is_empty()
                && seg.chars().all(|c| c.is_ascii_digit() || c == 'x')
                && seg.contains(|c: char| c.is_ascii_digit());
            if is_size {
                return Some(format!("{}originals/{}", &url[..base_len], &after[slash + 1..]));
            }
        }
        return None;
    }
    // Twitter / X: pbs.twimg.com/media/ID?format=jpg&name=small → name=orig
    if url.contains("pbs.twimg.com/media/") {
        return Some(if url.contains("name=") {
            replace_query_value(url, "name", "orig")
        } else {
            let sep = if url.contains('?') { '&' } else { '?' };
            format!("{url}{sep}name=orig")
        });
    }
    None
}

/// Technical download breadcrumb → feedback activity trail (download:diag event) + log.
fn dl_diag(app: &AppHandle, msg: impl AsRef<str>) {
    let m = msg.as_ref();
    log::info!(target: "Download", "{m}");
    let _ = app.emit("download:diag", m.to_string());
}

/// Deletes a temp file (the extension's cookie jar) when the download finishes —
/// on every exit path, including after retries that still need it.
struct TempFileGuard(Option<String>);
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(ref p) = self.0 {
            std::fs::remove_file(p).ok();
            log::debug!(target: "Download", "cookie_file_deleted path={:?}", p);
        }
    }
}

/// Sleep, waking early if the download is cancelled. Returns false if it was.
fn sleep_unless_cancelled(download_id: &str, dur: std::time::Duration) -> bool {
    let end = std::time::Instant::now() + dur;
    while std::time::Instant::now() < end {
        if is_cancelled(download_id) { return false; }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    !is_cancelled(download_id)
}

/// Files that appeared in `dir` since the `pre` snapshot, minus partials/metadata.
fn new_download_files(dir: &std::path::Path, pre: &HashSet<std::path::PathBuf>) -> Vec<String> {
    const SKIP_EXTS: &[&str] = &["part", "ytdl", "json", "description", "annotations"];
    std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter_map(|e| {
            let path = e.path();
            if pre.contains(&path) { return None; }
            let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
            if SKIP_EXTS.contains(&ext.as_str()) { return None; }
            path.to_str().map(|s| s.to_string())
        })
        .collect()
}

/// Delete everything (partials included) that appeared in `dir` since `pre`.
fn remove_new_files(dir: &std::path::Path, pre: &HashSet<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if !pre.contains(&p) { let _ = std::fs::remove_file(&p); }
    }
}

fn snapshot_dir(dir: &std::path::Path) -> HashSet<std::path::PathBuf> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect()
}

/// Run a follow-up yt-dlp attempt (a fallback after the main run failed) the same way
/// as the main run: PID registered so Cancel can kill it, progress streamed, and a hard
/// time limit so a stalled retry can't hold the serial download queue forever.
/// Returns (exited successfully, stderr).
fn run_tracked(
    app: &AppHandle,
    binary: &std::path::Path,
    args: &[String],
    download_id: &str,
    limit: std::time::Duration,
) -> (bool, String) {
    use std::io::Read;
    let mut child = match ytdlp_command(binary)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c)  => c,
        Err(e) => return (false, format!("ERROR: {e}")),
    };
    let pid = child.id();
    active_pids().lock().unwrap().insert(download_id.to_string(), pid);
    // Cancelled between our last check and the PID becoming visible to cancel_download.
    if is_cancelled(download_id) {
        active_pids().lock().unwrap().remove(download_id);
        kill_process_tree(pid);
    }

    let stderr = child.stderr.take();
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut e) = stderr { let _ = e.read_to_end(&mut buf); }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let stdout = child.stdout.take();
    let (app_o, did_o) = (app.clone(), download_id.to_string());
    let out_reader = std::thread::spawn(move || {
        if let Some(o) = stdout {
            for line in BufReader::new(o).lines().flatten() {
                if line.starts_with("[download]") { emit_download_progress(&line, &app_o, &did_o); }
            }
        }
    });

    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if std::time::Instant::now() >= deadline => {
                log::warn!(target: "Download", "retry_timeout download_id={download_id}");
                kill_process_tree(pid);
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(250)),
            Err(_)   => break None,
        }
    };
    active_pids().lock().unwrap().remove(download_id);
    let _ = out_reader.join();
    let err = err_reader.join().unwrap_or_default();
    (status.is_some_and(|s| s.success()), err)
}

/// Copy of `args` with the value after `flag` replaced.
fn with_arg(args: &[String], flag: &str, value: &str) -> Vec<String> {
    let mut out = args.to_vec();
    if let Some(i) = out.iter().position(|a| a == flag) {
        if i + 1 < out.len() { out[i + 1] = value.to_string(); }
    }
    out
}

/// YouTube player clients when a JS runtime is installed: yt-dlp's defaults (tuned
/// upstream; our copy self-updates daily) plus the embedded player. Once YouTube
/// rate-limits a connection (the watch page answers HTTP 429) it turns every default
/// client away with "Sign in to confirm you're not a bot", while the embedded player
/// still gets the streams, without a PO token. One extra request per save (~0.5 s).
const YT_CLIENTS: &str = "default,web_embedded";

/// The one `youtube:` extractor-args value for a normal run (repeated `--extractor-args
/// youtube:…` flags don't merge). HLS manifests cost an extra request (~0.5 s) and we
/// normally end up on DASH / progressive formats, so they're skipped — except for a
/// stream that's live right now (HLS only).
fn youtube_extractor_args(url: &str, clients: &str) -> String {
    let skip_hls = if url.contains("/live/") { "" } else { "skip=hls;" };
    format!("youtube:{skip_hls}player_client={clients}")
}

/// yt-dlp's note that YouTube withheld a client's direct streams (SABR). The embedded
/// player then still offers HLS, which a run with skip=hls throws away.
fn youtube_withheld_streams(stderr: &str) -> bool {
    stderr.to_lowercase().contains("formats have been skipped as they are missing a url")
}

/// Copy of `args` whose YouTube extractor args are replaced by just `player_client=clients`
/// (the retries take whatever formats those clients offer, HLS included).
fn with_youtube_clients(args: &[String], clients: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len() + 2);
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--extractor-args"
            && args.get(i + 1).is_some_and(|v| v.starts_with("youtube:"))
        {
            i += 2;
            continue;
        }
        out.push(args[i].clone());
        i += 1;
    }
    out.push("--extractor-args".into());
    out.push(format!("youtube:player_client={clients}"));
    out
}

/// "Title.f137.mp4" → "Title.mp4": yt-dlp names split video/audio streams with a
/// `.f<format id>` suffix until they're merged; the UI should show the final name.
fn strip_format_suffix(name: &str) -> String {
    if let Some(dot) = name.rfind('.') {
        let stem = &name[..dot];
        if let Some(f) = stem.rfind(".f") {
            if stem[f + 2..].chars().all(|c| c.is_ascii_digit()) && f + 2 < stem.len() {
                return format!("{}{}", &stem[..f], &name[dot..]);
            }
        }
    }
    name.to_string()
}

/// yt-dlp's extraction steps (stdout, when not --quiet) → a UI stage + English label, so
/// the few seconds before the first byte show what's happening instead of a silent
/// "Fetching info…". Ranked so the label only ever moves forward.
fn extraction_stage(line: &str) -> Option<(u8, &'static str, &'static str)> {
    if line.starts_with("[download]") { return None; }
    if line.starts_with("[Merger]") || line.starts_with("[VideoConvertor]") || line.starts_with("[FixupM") {
        return Some((4, "finishing", "finishing…"));
    }
    if line.starts_with("[info]") && line.contains("format(s)") {
        return Some((3, "starting", "starting download…"));
    }
    if line.contains("Solving JS challenges") || line.contains(": Downloading player ") {
        return Some((2, "unlocking", "unlocking video…"));
    }
    if line.starts_with('[') && (line.contains("Extracting URL") || line.contains(": Downloading")) {
        return Some((1, "reading", "reading video info…"));
    }
    None
}

fn run_ytdlp(
    app: AppHandle,
    download_id: String,
    url: String,
    quality: String,
    tmp_dir: std::path::PathBuf,
    ext_id: Option<String>,
) {
    use std::io::Read;

    // A name can lead to the local network too: look it up before fetching anything.
    if let Err(code) = crate::net_guard::check_public_url(&url) {
        log::warn!(target: "Download", "rejected_private_address download_id={download_id}");
        emit_download_error(&app, &download_id, code, ext_id.as_deref());
        return;
    }

    let binary = ytdlp_binary(&app);
    if let Ok(meta) = std::fs::metadata(&binary) {
        log::debug!(target: "Download", "binary path={:?} bytes={}", binary, meta.len());
    } else {
        log::debug!(target: "Download", "binary path={:?}", binary);
    }
    log::info!(target: "Download", "start download_id={download_id} url={url:?} quality={quality}");
    let eid = ext_id.as_deref();

    // Direct image URL: bypass yt-dlp entirely and download via HTTP.
    // yt-dlp cannot handle plain image file URLs (exits with code 1).
    let url_lower = url.to_lowercase();
    let url_path  = url_lower.split('?').next().unwrap_or(&url_lower);
    let is_direct_image = url_lower.contains("img.youtube.com")
        || url_path.ends_with(".jpg")  || url_path.ends_with(".jpeg")
        || url_path.ends_with(".png")  || url_path.ends_with(".webp")
        || url_path.ends_with(".gif");

    if is_direct_image {
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
        if let Some(e) = eid {
            set_ext_progress(&app, e, 0.1, "", "downloading", "");
        }
        // Try the highest-res variant of known CDNs (Pinterest/Twitter) first, then
        // the original URL. The hi-res guess can 404, so the original is always kept
        // as a fallback and we never regress below what the browser showed.
        let mut candidates: Vec<String> = Vec::new();
        if let Some(hi) = hi_res_image_url(&url) { candidates.push(hi); }
        candidates.push(url.clone());

        let mut fetched: Option<(Vec<u8>, String)> = None;
        for cand in &candidates {
            let r = crate::net_guard::agent().get(cand).set("User-Agent", ua).call()
                .map_err(|e| e.to_string())
                .and_then(|r| {
                    // An image link is read into memory: stop at a sane size.
                    const MAX_IMAGE: u64 = 200 * 1024 * 1024;
                    let mut bytes = Vec::new();
                    r.into_reader().take(MAX_IMAGE + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                    if bytes.len() as u64 > MAX_IMAGE { return Err("image too large".to_string()); }
                    Ok(bytes)
                });
            match r {
                Ok(bytes) if !bytes.is_empty() => {
                    if cand != &url { log::info!(target: "Download", "hi_res_image used={cand:?}"); }
                    fetched = Some((bytes, cand.clone()));
                    break;
                }
                Ok(_)  => continue,
                Err(e) => { log::debug!(target: "Download", "image_candidate_failed url={cand:?} err={e}"); continue; }
            }
        }

        match fetched {
            Some((bytes, used_url)) => {
                let used_path = used_url.split('?').next().unwrap_or(&used_url);
                let ext       = used_path.rsplit('.').next().filter(|e| e.len() <= 5).unwrap_or("jpg");
                let out_path  = tmp_dir.join(format!("image_{download_id}.{ext}"));
                if let Err(e) = std::fs::write(&out_path, &bytes) {
                    log::warn!(target: "Download", "direct_image_write_err error={e}");
                    emit_download_error(&app, &download_id, &format!("Failed to save image: {e}"), eid);
                    return;
                }
                log::info!(target: "Download", "direct_image_ok path={:?}", out_path);
                emit_download_complete(&app, &download_id,
                    &[out_path.to_string_lossy().to_string()], &url, eid);
            }
            None => {
                log::warn!(target: "Download", "direct_image_fetch_err all candidates failed");
                emit_download_error(&app, &download_id, "Failed to download image", eid);
            }
        }
        return;
    }

    // Resolve ffmpeg path early — needed for high-quality stream merging.
    let ffmpeg_path_str = ffmpeg_binary(&app)
        .map(|p| p.to_string_lossy().into_owned());

    let out_tpl = tmp_dir
        .join("%(title).120s.%(ext)s")
        .to_string_lossy()
        .into_owned();

    let is_youtube   = url.contains("youtube.com")   || url.contains("youtu.be");
    let is_pinterest = url.contains("pinterest.")    || url.contains("pin.it");
    let is_instagram = url.contains("instagram.com") || url.contains("instagr.am");
    let is_tiktok    = url.contains("tiktok.com");
    let needs_auth   = is_instagram || is_tiktok;

    // Browser cookies sent by the extension for this save (a temp file, deleted by the
    // guard when this download ends — after any retries that reuse it).
    let cookie_file_path: Option<String> = ext_id.as_ref().and_then(|eid| {
        app.state::<crate::AppState>()
            .cookie_files.lock().unwrap()
            .remove(eid)
    });
    let _cookie_guard = TempFileGuard(cookie_file_path.clone());

    // User-provided cookies.txt from Settings → Downloads → Cookies file.
    // Second priority after extension-provided cookies.
    let user_cookies_txt: Option<String> = if cookie_file_path.is_none() {
        let app_state = app.state::<crate::AppState>();
        let db = app_state.db.lock().unwrap();
        db.query_row(
            "SELECT value FROM preferences WHERE key = 'cookies_txt_path'",
            [],
            |r| r.get::<_, String>(0),
        ).ok()
        .filter(|p| !p.is_empty() && std::path::Path::new(p).exists())
    } else {
        None
    };

    // Effective cookie file: extension cookies > user cookies.txt > browser profile
    let effective_cookie_path: Option<&str> = cookie_file_path.as_deref()
        .or(user_cookies_txt.as_deref());

    // For Instagram/TikTok without a cookie file, try the user's Firefox profile.
    // Chrome is excluded on Windows: it holds an exclusive lock on its Cookies SQLite
    // file, and since Chrome 127 cookie values use app-bound encryption tied to the
    // Chrome process, so even a copied file is undecryptable.  Firefox has no such
    // restriction.  On macOS, Chrome cookies are accessible via Keychain and work fine.
    let auto_cookie_browser: Option<&str> = if needs_auth && effective_cookie_path.is_none() {
        let firefox_path = {
            #[cfg(target_os = "windows")]
            { std::path::Path::new(&std::env::var("APPDATA").unwrap_or_default())
                .join("Mozilla\\Firefox\\Profiles").exists() }
            #[cfg(target_os = "macos")]
            { std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
                .join("Library/Application Support/Firefox/Profiles").exists() }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            { false }
        };
        let chrome_path = {
            #[cfg(target_os = "windows")]
            { false } // Chrome on Windows: exclusive lock + app-bound encryption — unusable
            #[cfg(target_os = "macos")]
            { std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
                .join("Library/Application Support/Google/Chrome").exists() }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            { false }
        };
        if firefox_path {
            Some("firefox")
        } else if chrome_path {
            Some("chrome")
        } else {
            None
        }
    } else {
        None
    };

    // Reject bare YouTube domain URLs before burning a yt-dlp process.
    // A valid YouTube target always carries a video ID: ?v=, /shorts/, /live/, /embed/,
    // or a youtu.be short link.  The homepage (https://www.youtube.com/) has none of
    // these, which means the content-script failed to extract the watch URL.
    if is_youtube {
        let is_youtu_be   = url.contains("youtu.be/");
        let has_video_id  = url.contains("?v=") || url.contains("&v=")
            || url.contains("/shorts/")
            || url.contains("/live/")
            || url.contains("/embed/");
        if !is_youtu_be && !has_video_id {
            log::warn!(target: "Download", "youtube_no_video_id url={url:?} download_id={download_id}");
            emit_download_error(&app, &download_id,
                "Couldn't read the video link — open the video page first", eid);
            return;
        }
    }

    // YouTube requires a JavaScript runtime: yt-dlp runs YouTube's player challenges in
    // it, and without one every media URL returns HTTP 403 (js_runtime.rs). It's
    // normally prefetched at boot; if not, install it now (once, ~45 MB) with progress.
    let deno: Option<std::path::PathBuf> = if is_youtube {
        match crate::js_runtime::ready_path(&app) {
            Some(p) => Some(p),
            None => {
                emit_download_stage(&app, &download_id, "preparing_youtube",
                    "preparing YouTube support…", 0.0, eid);
                let last_pct = std::cell::Cell::new(-1i32);
                let report = |f: f64| {
                    let pct = (f * 100.0) as i32;
                    if pct != last_pct.get() {
                        last_pct.set(pct);
                        emit_download_stage(&app, &download_id, "preparing_youtube",
                            "preparing YouTube support…", f, eid);
                    }
                };
                match crate::js_runtime::ensure(&app, &report) {
                    Ok(p)  => Some(p),
                    Err(e) => {
                        log::warn!(target: "Download", "js_runtime_unavailable err={e}");
                        None
                    }
                }
            }
        }
    } else {
        None
    };
    if is_cancelled(&download_id) { return; }

    let mut args: Vec<String> = [
        "--no-playlist",
        "--newline",
        "--progress",
        "--force-overwrites",
        // mp4 for H.264/AAC; webm (not mkv) when only VP9/Opus exists, so the file
        // is a real WebM that WebView2 and macOS WebKit can both play.
        "--merge-output-format", "mp4/webm/mkv",
        "--retries", "5",
        "--fragment-retries", "5",
        "--socket-timeout", "30",
        "--add-header", "Accept-Language:en-US,en;q=0.9",
        "-o", out_tpl.as_str(),
    ].map(String::from).to_vec();

    // YouTube picks client-specific User-Agents itself; a fixed desktop-Chrome UA
    // only makes its requests look inconsistent. Other sites keep the browser UA.
    if !is_youtube {
        args.extend(["--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"].map(String::from));
    }

    // Point yt-dlp at our bundled ffmpeg so it can merge split streams (required for 1080p+).
    if let Some(ref fp) = ffmpeg_path_str {
        args.extend(["--ffmpeg-location".to_string(), fp.clone()]);
    }

    // Legacy no-JS player-client chain, from before YouTube required a JS runtime. Only
    // used when deno couldn't be installed (e.g. offline on first use). With a runtime:
    // YT_CLIENTS.
    let yt_legacy_clients = if effective_cookie_path.is_some() { "tv,android_vr,ios" } else { "tv,android_vr,web_embedded,ios" };
    let yt_clients = if deno.is_some() { YT_CLIENTS } else { yt_legacy_clients };
    // The clients that consume a GVS PO token (mweb gets one even while the watch page is
    // rate-limited) — used for the retry once the PO-token provider is running (see the
    // 403 fallback below).
    const YT_POT_CLIENTS: &str = "mweb,web,web_embedded";

    // The PO-token provider is only for the 403 fallback below. It used to be started up
    // front on every install that had ever hit a 403 — 2–9 s to boot plus ~3 s for the
    // first token, on the first YouTube save of every session — and its yt-dlp plugin
    // (installed in yt-dlp's config dir) cost ~2 s on every run even with the server
    // down. Normal runs therefore pass --no-plugin-dirs; only the retry loads it.
    let pot_installed = is_youtube && crate::pot_provider::is_downloaded(&app);

    if is_youtube {
        args.extend(crate::js_runtime::ytdlp_args(deno.as_deref()));
        // H.264 + AAC first (→ .mp4): plays in both WebView2 and macOS WebKit, where
        // VP9/AV1 in MKV often doesn't (AV1 needs an M3+ Mac). YouTube serves H.264 up
        // to 1080p, so "best" caps there — 4K VP9 was ~10× larger (1.4 GB for a
        // 10-minute video) for no visible gain in an inspiration library. The cap is a sort
        // limit, not a height filter: `res` is the shorter side, so a vertical Short comes
        // in 1080×1920 H.264 (`[height<=1080]` left it at 608×1080 VP9).
        let cap = if quality == "medium" { 720 } else { 1080 };
        args.extend([
            "--format".to_string(), "bv*+ba/b".to_string(),
            "--format-sort".to_string(), format!("res:{cap},vcodec:h264,fps,acodec:aac"),
        ]);
        args.extend(["--extractor-args".to_string(), youtube_extractor_args(&url, yt_clients)]);
    } else if quality == "medium" {
        args.extend([
            "--format",
            "bestvideo[height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best",
            "--format-sort", "vcodec:h264:vp9:av01,res:720,fps",
        ].map(String::from));
    } else {
        args.extend([
            "--format",
            "bestvideo[height<=2160]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
            "--format-sort", "vcodec:h264:vp9:av01,res:2160,fps",
        ].map(String::from));
    }
    // Instagram: when we have session cookies (from extension or user cookies.txt), let yt-dlp
    // choose the best API automatically — forcing graphql conflicts with the bloks auth flow
    // that Instagram requires for cookie-authenticated downloads.  Without cookies, graphql
    // is still the best bet for public content.
    if is_instagram && effective_cookie_path.is_none() && auto_cookie_browser.is_none() {
        args.extend(["--extractor-args", "instagram:api=graphql"].map(String::from));
    }

    if let Some(cp) = effective_cookie_path {
        args.extend(["--cookies".to_string(), cp.to_string()]);
        let cookie_source = if cookie_file_path.is_some() { "extension" } else { "user_cookies_txt" };
        log::debug!(target: "Download", "cookie_source={cookie_source} download_id={download_id}");
    } else if let Some(browser) = auto_cookie_browser {
        args.extend(["--cookies-from-browser".to_string(), browser.to_string()]);
        log::debug!(target: "Download", "cookie_source=browser_{browser} download_id={download_id}");
    } else if needs_auth {
        // No cookie source — limit retries so the user gets a fast failure.
        args.extend(["--retries", "1", "--fragment-retries", "1"].map(String::from));
        log::warn!(target: "Download", "cookie_source=none needs_auth=true download_id={download_id}");
    }

    // "--" ends the options: whatever the URL looks like, yt-dlp can only read it as a URL.
    let with_url = |mut a: Vec<String>| -> Vec<String> { a.push("--".into()); a.push(url.clone()); a };
    // Normal runs never load yt-dlp plugins (see pot_installed above).
    let plugins_off = |a: Vec<String>| -> Vec<String> {
        let mut v = vec!["--no-plugin-dirs".to_string()];
        v.extend(a);
        v
    };

    // Snapshot tmp_dir BEFORE spawning so the diff after exit is accurate.
    let pre_files = snapshot_dir(&tmp_dir);

    dl_diag(&app, format!(
        "start id={download_id} youtube={is_youtube} quality={quality} js_runtime={} pot_installed={pot_installed} bin={}{}",
        if deno.is_some() { "deno" } else { "none" },
        binary.file_name().and_then(|s| s.to_str()).unwrap_or("?"),
        if is_youtube { format!(" clients={yt_clients}") } else { String::new() }
    ));

    let mut child = match ytdlp_command(&binary)
        .args(with_url(plugins_off(args.clone())))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => {
            log::info!(target: "Download", "spawned pid={:?} download_id={download_id}", c.id());
            active_pids().lock().unwrap().insert(download_id.clone(), c.id());
            // Cancelled before the PID was visible to cancel_download: stop it now.
            if is_cancelled(&download_id) {
                active_pids().lock().unwrap().remove(&download_id);
                kill_process_tree(c.id());
            }
            if let Some(e) = eid {
                app.state::<crate::AppState>().ext_id_map.lock().unwrap()
                    .insert(download_id.clone(), e.to_string());
                set_ext_progress(&app, e, 0.0, "", "downloading", "");
            }
            c
        }
        Err(e) => {
            emit_download_error(&app, &download_id, &format!("yt-dlp not found: {e}"), eid);
            return;
        }
    };

    // Watchdog: kill the child if the total download exceeds 15 minutes.
    // Covers yt-dlp hanging during HLS segment loops, ffmpeg post-processing, or stalled
    // auth flows that --socket-timeout doesn't catch (socket is open but data never moves).
    const DOWNLOAD_TIMEOUT_SECS: u64 = 15 * 60;
    let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (wd_done_tx, wd_done_rx) = std::sync::mpsc::channel::<()>();
    {
        let to_flag  = timed_out.clone();
        let wd_did   = download_id.clone();
        std::thread::spawn(move || {
            if wd_done_rx.recv_timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS)).is_err() {
                to_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                log::warn!(target: "Download", "watchdog_timeout download_id={wd_did}");
                if let Some(pid) = active_pids().lock().unwrap().remove(&wd_did) {
                    kill_process_tree(pid);
                }
            }
        });
    }

    // Read stderr in a background thread — splits on \r and \n for real-time progress.
    // Collects all stderr text so we can surface the real error message on failure.
    let app_pg  = app.clone();
    let did_pg  = download_id.clone();
    let stderr  = child.stderr.take().unwrap();
    let stderr_lines_shared: std::sync::Arc<std::sync::Mutex<String>> =
        std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let sl_clone = stderr_lines_shared.clone();

    let stderr_handle = std::thread::spawn(move || {
        let mut reader  = BufReader::new(stderr);
        let mut partial = String::new();
        let mut buf     = [0u8; 4096];
        let mut total   = 0usize;

        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    total += n;
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    log::debug!(target: "Download", "stderr bytes={n}");
                    sl_clone.lock().unwrap().push_str(&chunk);
                    partial.push_str(&chunk);
                    drain_progress_lines(&mut partial, &app_pg, &did_pg);
                }
            }
        }
        if !partial.trim().is_empty() {
            let leftover = partial.trim().to_string();
            log::debug!(target: "Download", "stderr_leftover={:?}", leftover);
            emit_download_progress(&leftover, &app_pg, &did_pg);
        }
        log::debug!(target: "Download", "stderr_done bytes={total}");
    });

    // Drain stdout — yt-dlp writes progress lines here too; log everything.
    let app_out = app.clone();
    let did_out = download_id.clone();
    let stdout  = child.stdout.take().unwrap();

    let mut stage_rank = 0u8;
    let mut named = false;   // name the download after its first stream (video), not the audio that follows
    for line in BufReader::new(stdout).lines().flatten() {
        log::debug!(target: "Download", "stdout={:?}", line);
        if let Some((rank, stage, label)) = extraction_stage(&line) {
            if rank > stage_rank {
                stage_rank = rank;
                emit_download_stage(&app_out, &did_out, stage, label, 0.0, eid);
            }
            if rank == 3 { dl_diag(&app_out, format!("formats id={did_out} {}", line.trim())); }
        }
        if line.starts_with("[download] Destination:") {
            // Emit the real filename as soon as yt-dlp chooses it — before any bytes download.
            let filename = line
                .trim_start_matches("[download] Destination:")
                .trim()
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .to_string();
            if !filename.is_empty() && !named {
                named = true;
                let _ = app_out.emit("download:filename", serde_json::json!({
                    "download_id": did_out,
                    "filename":    strip_format_suffix(&filename),
                }));
            }
        }
        if line.starts_with("[download]") {
            emit_download_progress(&line, &app_out, &did_out);
        }
    }

    let exit_status = child.wait();
    // Signal watchdog that the process exited normally (no-op if it already fired).
    let _ = wd_done_tx.send(());
    log::info!(target: "Download", "exited status={:?} download_id={download_id}", exit_status);
    active_pids().lock().unwrap().remove(&download_id);

    stderr_handle.join().ok();

    // Cancelled: the UI already shows it; just drop whatever was written.
    if is_cancelled(&download_id) {
        remove_new_files(&tmp_dir, &pre_files);
        log::info!(target: "Download", "cancelled_cleanup download_id={download_id}");
        return;
    }

    // Discover files written by yt-dlp: anything new in tmp_dir that isn't
    // a partial download or metadata artifact.
    let final_paths = new_download_files(&tmp_dir, &pre_files);
    log::info!(target: "Download", "files_ready count={} download_id={download_id}", final_paths.len());

    // Extract a human-readable error from stderr for failure cases.
    let stderr_text = std::sync::Arc::try_unwrap(stderr_lines_shared)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();

    dl_diag(&app, format!("yt-dlp exit id={download_id} code={:?}",
        exit_status.as_ref().ok().and_then(|s| s.code())));
    if let Some(err) = stderr_text.lines().rev().find(|l| l.contains("ERROR:")) {
        dl_diag(&app, format!("yt-dlp stderr: {}", err.trim().chars().take(200).collect::<String>()));
    }

    match exit_status {
        Ok(ref s) if s.success() => {
            if final_paths.is_empty() {
                log::warn!(target: "Download", "no_output_files download_id={download_id}");
                emit_download_error(&app, &download_id, "yt-dlp produced no importable files", eid);
            } else {
                emit_download_complete(&app, &download_id, &final_paths, &url, eid);
            }
            return;
        }
        Err(e) => {
            emit_download_error(&app, &download_id, &e.to_string(), eid);
            return;
        }
        Ok(_) => {}
    }

    // ── Failure: fallbacks ────────────────────────────────────────────

    // Pinterest image-pin fallback: the bundled yt-dlp doesn't expose
    // image formats for image-only pins, but it CAN download the pin's
    // thumbnail (which IS the original image on Pinterest).
    if is_pinterest && stderr_text.contains("No video formats found") {
        let fallback = pinterest_image_fallback(&binary, &url, &tmp_dir, &pre_files);
        if !fallback.is_empty() {
            emit_download_complete(&app, &download_id, &fallback, &url, eid);
            return;
        }
    }

    // Unmerged split-stream fragments ("Title.f137.mp4") and partials from the failed
    // attempt must never be imported or resumed by a retry.
    remove_new_files(&tmp_dir, &pre_files);

    // The stderr of the most recent attempt — the source of the final error message.
    let mut last_stderr = stderr_text;

    // YouTube 503 (per-IP rate limit on the split streams): back off, then retry once at
    // ≤720p. Same arguments as the main run (JS runtime, clients) — only the cap changes.
    if is_youtube && last_stderr.contains("HTTP Error 503") {
        log::warn!(target: "Download", "youtube_503 download_id={download_id} retrying=720p_fallback");
        emit_download_stage(&app, &download_id, "retrying", "retrying at 720p…", 0.0, eid);
        if !sleep_unless_cancelled(&download_id, std::time::Duration::from_secs(12)) { return; }

        let pre = snapshot_dir(&tmp_dir);
        let fb_args = with_url(plugins_off(with_arg(&args, "--format-sort", "res:720,vcodec:h264,fps,acodec:aac")));
        let (ok, se) = run_tracked(&app, &binary, &fb_args, &download_id,
            std::time::Duration::from_secs(10 * 60));
        let paths = new_download_files(&tmp_dir, &pre);
        log::info!(target: "Download", "fallback_result ok={ok} paths={}", paths.len());
        if is_cancelled(&download_id) { remove_new_files(&tmp_dir, &pre); return; }
        if ok && !paths.is_empty() {
            emit_download_complete(&app, &download_id, &paths, &url, eid);
            return;
        }
        remove_new_files(&tmp_dir, &pre);
        if !se.trim().is_empty() { last_stderr = se; }
    }

    // YouTube withheld the direct streams (SABR) and skip=hls threw away the HLS ones the
    // embedded player still offers: the same run with HLS allowed. Much quicker than
    // starting the PO-token provider below, which stays the next step if this fails too.
    if is_youtube && deno.is_some() && !url.contains("/live/") && youtube_withheld_streams(&last_stderr) {
        log::warn!(target: "Download", "youtube_sabr download_id={download_id} retrying=hls");
        emit_download_stage(&app, &download_id, "retrying", "retrying…", 0.0, eid);
        let pre = snapshot_dir(&tmp_dir);
        let hls_args = with_url(plugins_off(with_youtube_clients(&args, YT_CLIENTS)));
        let (ok, se) = run_tracked(&app, &binary, &hls_args, &download_id,
            std::time::Duration::from_secs(10 * 60));
        let paths = new_download_files(&tmp_dir, &pre);
        log::info!(target: "Download", "hls_fallback_result ok={ok} paths={}", paths.len());
        if is_cancelled(&download_id) { remove_new_files(&tmp_dir, &pre); return; }
        if ok && !paths.is_empty() {
            emit_download_complete(&app, &download_id, &paths, &url, eid);
            return;
        }
        remove_new_files(&tmp_dir, &pre);
        if !se.trim().is_empty() { last_stderr = se; }
    }

    // YouTube PO-token / SABR 403: some sessions gate the media streams behind a GVS PO
    // token. Download + start the bgutil provider on demand (once), then retry with the
    // web clients that consume the token. Pointless without a JS runtime — the 403 is
    // then the unsolved player challenge, which no token fixes.
    let looks_pot = is_youtube && deno.is_some() && {
        let s = last_stderr.to_lowercase();
        s.contains("http error 403") || s.contains("po token") || s.contains("sabr")
    };
    if looks_pot {
        log::warn!(target: "Download", "youtube_pot_403 download_id={download_id} pot_installed={pot_installed}");
        emit_download_stage(&app, &download_id, "setting_up_youtube", "setting up YouTube…", 0.3, eid);

        // Downloads the provider (once), installs the bgutil plugin into yt-dlp's
        // config dir, and starts the local server. This retry is the one run without
        // --no-plugin-dirs, so yt-dlp picks the plugin up from there.
        if crate::pot_provider::ensure_running(&app) && !is_cancelled(&download_id) {
            emit_download_stage(&app, &download_id, "retrying", "retrying…", 0.0, eid);
            let pre = snapshot_dir(&tmp_dir);
            let pot_args = with_url(with_youtube_clients(&args, YT_POT_CLIENTS));
            let (ok, se) = run_tracked(&app, &binary, &pot_args, &download_id,
                std::time::Duration::from_secs(10 * 60));
            if !se.trim().is_empty() { log::debug!(target: "Download", "pot_retry_stderr={:?}", se); }
            let paths = new_download_files(&tmp_dir, &pre);
            if is_cancelled(&download_id) { remove_new_files(&tmp_dir, &pre); return; }
            if ok && !paths.is_empty() {
                log::info!(target: "Download", "pot_retry_ok paths={}", paths.len());
                emit_download_complete(&app, &download_id, &paths, &url, eid);
                return;
            }
            remove_new_files(&tmp_dir, &pre);
            log::warn!(target: "Download", "pot_retry_failed download_id={download_id}");
            if !se.trim().is_empty() { last_stderr = se; }
        }
    }
    if is_cancelled(&download_id) { return; }

    // Extract the most useful error line from yt-dlp's stderr output.
    let raw_err = last_stderr
        .lines()
        .rev()
        .find(|l| l.contains("ERROR:"))
        .map(|l| l.trim_start_matches("ERROR:").trim().to_string())
        .unwrap_or_default();

    // Surface the best possible error message.
    // For Instagram/TikTok auth failures, explain the cookie situation clearly.
    if !raw_err.is_empty() {
        log::warn!(target: "Download", "ytdlp_error download_id={download_id} err={raw_err:?}");
    }
    let is_chrome_cookie_err = raw_err.contains("Could not copy Chrome cookie database");
    let is_auth_err = is_chrome_cookie_err
        || raw_err.to_lowercase().contains("login")
        || raw_err.to_lowercase().contains("cookie")
        || raw_err.to_lowercase().contains("auth")
        || raw_err.to_lowercase().contains("not accessible")
        || raw_err.contains("HTTP Error 401")
        || raw_err.contains("HTTP Error 403")
        || raw_err.contains("checkpoint")
        || raw_err.contains("empty media response");
    let msg = if timed_out.load(std::sync::atomic::Ordering::SeqCst) {
        "Download timed out after 15 minutes — the source may be slow or unresponsive.".to_string()
    } else if is_youtube && deno.is_none() {
        "Couldn't set up YouTube support — check your internet connection and try again.".to_string()
    } else if is_chrome_cookie_err {
        "Chrome blocks cookie access on Windows. Open the link in Chrome and save it via the qooti extension — it sends your session automatically.".to_string()
    } else if needs_auth && effective_cookie_path.is_none() && auto_cookie_browser.is_none() && (is_auth_err || raw_err.is_empty()) {
        "Open the link in Chrome and save it with the qooti extension.".to_string()
    } else if !raw_err.is_empty() {
        raw_err
    } else {
        "Download failed — the URL may be private or unsupported.".to_string()
    };
    emit_download_error(&app, &download_id, &msg, eid);
}

fn pinterest_image_fallback(
    _binary: &std::path::Path,
    url: &str,
    tmp_dir: &std::path::Path,
    _pre_files: &std::collections::HashSet<std::path::PathBuf>,
) -> Vec<String> {
    use std::io::Read;
    log::info!(target: "Download", "pinterest_fallback url={url:?}");

    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
              (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    // Step 1: fetch the Pinterest pin page HTML
    let html = match crate::net_guard::agent().get(url).set("User-Agent", ua).call() {
        Ok(r)  => match r.into_string() {
            Ok(s)  => s,
            Err(e) => { log::warn!(target: "Download", "pinterest_page_read_err error={e}"); return vec![]; }
        },
        Err(e) => { log::warn!(target: "Download", "pinterest_page_fetch_err error={e}"); return vec![]; }
    };

    // Step 2: extract og:image URL — Pinterest always embeds the original image here
    let image_url = match extract_og_image(&html) {
        Some(u) => u,
        None    => { log::warn!(target: "Download", "pinterest_og_image_missing"); return vec![]; }
    };
    log::debug!(target: "Download", "pinterest_og_image url={:?}", image_url);

    // Step 3: download the image bytes — prefer the highest-res variant (originals/),
    // fall back to the og:image URL as-is if that 404s.
    let mut img_candidates: Vec<String> = Vec::new();
    if let Some(hi) = hi_res_image_url(&image_url) { img_candidates.push(hi); }
    img_candidates.push(image_url.clone());

    let mut bytes: Vec<u8> = Vec::new();
    let mut used_img = image_url.clone();
    for cand in &img_candidates {
        match crate::net_guard::agent().get(cand).set("User-Agent", ua).call() {
            Ok(r) => {
                let mut b = Vec::new();
                if r.into_reader().read_to_end(&mut b).is_ok() && !b.is_empty() {
                    bytes = b; used_img = cand.clone(); break;
                }
            }
            Err(e) => { log::debug!(target: "Download", "pin_img_candidate_failed url={cand:?} err={e}"); }
        }
    }
    if bytes.is_empty() {
        log::warn!(target: "Download", "pinterest_img_download_err all candidates failed");
        return vec![];
    }

    // Step 4: save with correct extension and return path
    let ext = used_img.split('?').next()
        .and_then(|u| u.rsplit('.').next())
        .filter(|e| e.len() <= 5)
        .unwrap_or("jpg");

    // Use og:title as filename so finalize_download picks it up as the item title.
    let stem = extract_og_title(&html)
        .map(|t| sanitize_filename(&t))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Pinterest image".to_string());
    let out_path = tmp_dir.join(format!("{}.{}", stem, ext));

    if let Err(e) = std::fs::write(&out_path, &bytes) {
        log::warn!(target: "Download", "pinterest_img_write_err error={e}");
        return vec![];
    }

    let paths = vec![out_path.to_string_lossy().into_owned()];
    log::info!(target: "Download", "pinterest_fallback_ok paths={}", paths.len());
    paths
}

fn extract_og_title(html: &str) -> Option<String> {
    let og_pos    = html.find("og:title")?;
    let tag_start = html[..og_pos].rfind('<')?;
    let tag_end   = html[og_pos..].find('>')? + og_pos + 1;
    let tag       = &html[tag_start..tag_end];
    let c_pos     = tag.find("content=\"")? + "content=\"".len();
    let rest      = &tag[c_pos..];
    let end       = rest.find('"')?;
    let title     = html_decode(&rest[..end]).trim().to_string();
    if title.is_empty() { None } else { Some(title) }
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c => c,
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(120)
        .collect()
}

fn extract_og_image(html: &str) -> Option<String> {
    // Handles both orderings: property="og:image" content="URL"
    //                     and content="URL" property="og:image"
    let og_pos   = html.find("og:image")?;
    let tag_start = html[..og_pos].rfind('<')?;
    let tag_end   = html[og_pos..].find('>')? + og_pos + 1;
    let tag       = &html[tag_start..tag_end];
    let c_pos     = tag.find("content=\"")? + "content=\"".len();
    let rest      = &tag[c_pos..];
    let end       = rest.find('"')?;
    let url       = html_decode(&rest[..end]);
    if url.starts_with("http") { Some(url) } else { None }
}

fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
}

fn detect_platform(url: &str) -> Option<String> {
    let u = url.to_lowercase();
    if u.contains("instagram.com") { return Some("Instagram".into()); }
    if u.contains("pinterest.") || u.contains("pin.it") { return Some("Pinterest".into()); }
    if u.contains("tiktok.com") || u.contains("tiktok.") { return Some("TikTok".into()); }
    if u.contains("twitter.com") || u.contains("x.com") { return Some("X".into()); }
    if u.contains("youtube.com") || u.contains("youtu.be") { return Some("YouTube".into()); }
    if u.contains("vimeo.com") { return Some("Vimeo".into()); }
    if u.contains("facebook.com") || u.contains("fb.com") { return Some("Facebook".into()); }
    if u.contains("behance.net") { return Some("Behance".into()); }
    if u.contains("dribbble.com") { return Some("Dribbble".into()); }
    if u.contains("reddit.com") { return Some("Reddit".into()); }
    None
}

// ─── finalize_download ────────────────────────────────────────────
// Called after yt-dlp finishes. Renames the temp file into the vault
// and inserts the DB record. Handles both video and image downloads.
#[tauri::command]
pub fn finalize_download(
    path: String,
    url: Option<String>,
    ext_id: Option<String>,
    title: Option<String>,
    app: AppHandle,
    state: State<AppState>,
) -> Result<Inspiration, String> {
    log::info!(target: "Download", "finalize_start path={path:?} ext_id={ext_id:?}");
    let vault_path = vault::get_vault_path(&app).map_err(|e| e.to_string())?;
    vault::ensure_structure(&vault_path).map_err(|e| e.to_string())?;

    let src = std::path::Path::new(&path);

    let validated = match crate::media_guard::validate_path(src) {
        Ok(v)  => v,
        Err(e) => {
            log::warn!(target: "Download", "guard_rejected path={path:?} error={e}");
            std::fs::remove_file(src).ok();
            return Err(e.user_message());
        }
    };
    let (file_type, subdir, mime, default_ratio) =
        (validated.db_type, validated.subdir, validated.mime, validated.default_ratio);

    // Prefer the explicit title passed by the caller (e.g. page title from the extension).
    // Fall back to the filename stem — yt-dlp encodes the video title there via %(title).120s,
    // so this works for YouTube, TikTok, Instagram, etc. without the caller needing to pass anything.
    let stem_title: Option<String> = src.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let title: Option<String> = title.filter(|s| !s.trim().is_empty()).or(stem_title);

    let id        = Uuid::new_v4().to_string();
    let dest_name = format!("{}.{}", id, validated.real_ext);
    let dest_path = vault_path.join(subdir).join(&dest_name);

    let hash = stream_hash(src).map_err(|e| e.to_string())?;

    // Already saved: the same bytes as an item's file, or as the first original a cropped
    // picture keeps
    {
        let db = state.db.lock().unwrap();
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM inspirations WHERE file_hash = ?1 OR original_hash = ?1",
            params![hash], |r| r.get(0),
        ).unwrap_or(0);
        if count > 0 {
            std::fs::remove_file(src).ok();
            return Err("duplicate".to_string());
        }
    }

    rename_or_copy(src, &dest_path).map_err(|e| e.to_string())?;

    let stored_path = dest_path.to_string_lossy().into_owned();
    let save_source = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT value FROM preferences WHERE key = 'save_source_url'",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap_or_else(|_| "true".to_string()) != "false"
    };
    let source_url:      Option<String> = if save_source { url.clone() } else { None };
    let source_platform: Option<String> = if save_source { url.as_deref().and_then(detect_platform) } else { None };
    let import_source = if ext_id.is_some() { "extension" } else { "app_download" };
    let now            = now_ms();

    // Videos have no pixels to OCR or sample for palette.
    let is_video    = file_type == "video";
    let ocr_status  = if is_video { Some("skipped") } else { None };
    let palette_json = if !is_video {
        let p = stored_path.clone();
        let colors = std::panic::catch_unwind(|| palette_from_path(&p, 5)).unwrap_or_default();
        if colors.is_empty() { None } else { serde_json::to_string(&colors).ok() }
    } else { None };
    let (duration, video_ratio) = if is_video { video_meta(&dest_path, &app) } else { (None, None) };
    // Pictures: the real size from the file (this path used to store the default 1.0)
    let aspect_ratio = new_item_ratio(is_video, &stored_path, video_ratio, default_ratio);

    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT INTO inspirations \
             (id, type, title, stored_path, file_hash, mime_type, aspect_ratio, ocr_text, \
              ocr_status, source_url, source_platform, palette, duration_secs, import_source, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,'',?8,?9,?10,?11,?12,?13,?14,?14)",
            params![id, file_type, title, stored_path, hash, mime, aspect_ratio,
                    ocr_status, source_url, source_platform, palette_json, duration, import_source, now],
        ).map_err(|e| e.to_string())?;
    }

    // File is now in the vault and recorded in the DB.
    // Advance ext_progress to "complete" so the extension shows "Saved to qooti"
    // and can display the "View" button using the new inspiration_id.
    if let Some(ref eid) = ext_id {
        let mut prog_map = state.ext_progress.lock().unwrap();
        if let Some(prog) = prog_map.get_mut(eid) {
            prog.status         = "complete".to_string();
            prog.inspiration_id = Some(id.clone());
            prog.updated_at     = std::time::Instant::now();
        }
    }

    log::info!(target: "Download", "finalize_ok id={id} type={file_type} ext_id={ext_id:?}");
    Ok(Inspiration {
        id,
        r#type: file_type.to_string(),
        title,
        source_url,
        source_platform,
        stored_path,
        thumbnail_path: None,
        aspect_ratio,
        palette: palette_json,
        ocr_text: String::new(),
        ocr_status: ocr_status.map(|s| s.to_string()),
        ocr_language: None,
        file_hash: Some(hash),
        phash: None,
        phash_source: None,
        vault_id: None,
        mime_type: Some(mime.to_string()),
        created_at: now,
        updated_at: now,
        auto_tag_status: None,
        lens_suggestions: None,
        auto_tag_model: None,
        duration_secs: duration,
        collection_names: None,
        enhanced_path: None,
        auto_tag_sig: None,
        has_original: false,
    })
}

// ─── Helpers ──────────────────────────────────────────────────────

fn drain_progress_lines(partial: &mut String, app: &AppHandle, download_id: &str) {
    while let Some(pos) = partial.find(|c: char| c == '\r' || c == '\n') {
        let line = partial[..pos].to_string();
        *partial = partial[pos + 1..].to_string();
        if !line.trim().is_empty() {
            emit_download_progress(&line, app, download_id);
        }
    }
}

fn emit_download_progress(line: &str, app: &AppHandle, download_id: &str) {
    log::debug!(target: "Download", "progress_line={:?}", line);
    // "[download]  42.3% of 100MiB at 2.00MiB/s ETA 00:30"
    let Some(rest) = line.strip_prefix("[download]") else { return };
    let t = rest.trim();
    let Some(pct_end) = t.find('%') else { return };
    let Ok(pct) = t[..pct_end].trim().parse::<f32>() else { return };
    let speed = t[pct_end + 1..]
        .split("at").nth(1)
        .and_then(|s| s.split("ETA").next())
        .unwrap_or("").trim().to_string();
    log::debug!(target: "Download", "progress pct={:.1} speed={:?}", pct, speed);
    let _ = app.emit("download:progress", serde_json::json!({
        "download_id": download_id,
        "pct": pct / 100.0,
        "speed": speed,
    }));
    // Mirror progress to ext_progress so the browser extension can poll it
    let eid_opt = app.state::<crate::AppState>().ext_id_map.lock().unwrap()
        .get(download_id).cloned();
    if let Some(eid) = eid_opt {
        set_ext_progress(app, &eid, pct as f64 / 100.0, &speed, "downloading", "");
    }
}

pub(crate) fn stream_hash(path: &std::path::Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = sha2::Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

fn rename_or_copy(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if std::fs::rename(src, dst).is_ok() { return Ok(()); }
    std::fs::copy(src, dst)?;
    std::fs::remove_file(src).ok();
    Ok(())
}

/// Called from JS when finalizeDownload fails for all paths — marks the
/// extension progress entry as "error" so the toast shows a failure message.
#[tauri::command]
pub fn set_ext_progress_error(ext_id: String, state: State<AppState>) -> Result<(), String> {
    let mut map = state.ext_progress.lock().unwrap();
    if let Some(prog) = map.get_mut(&ext_id) {
        prog.status     = "error".to_string();
        prog.message    = friendly_ext_error("save failed");
        prog.updated_at = std::time::Instant::now();
    }
    Ok(())
}

// ─── Import Source Analysis ──────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ImportAnalysis {
    pub source_type: String,  // "notion" | "telegram" | "qooti"
    pub media_count: u32,
    pub display_name: String,
}

#[derive(Serialize)]
pub struct ImportQooTiResult {
    pub collection_id:   String,
    pub collection_name: String,
    pub imported_count:  u32,
    pub skipped_count:   u32,
}

fn is_import_media(name: &str) -> bool {
    if name.contains("_thumb") { return false; }
    matches!(
        name.rsplit('.').next().unwrap_or("").to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "avif" | "heic" | "gif" |
        "mp4" | "webm" | "mov" | "avi" | "mkv"
    )
}

#[tauri::command]
pub fn analyze_import_source(path: String) -> Result<ImportAnalysis, String> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if p.is_dir() {
        analyze_telegram_folder_source(p)
    } else if ext == "qooti" {
        analyze_qooti_pack_source(p)
    } else if ext == "zip" {
        analyze_notion_zip_source(p)
    } else {
        Err("Select a Notion export (.zip), a Telegram export folder, or a .qooti collection".to_string())
    }
}

fn analyze_qooti_pack_source(p: &std::path::Path) -> Result<ImportAnalysis, String> {
    use std::io::Read;
    let raw = std::fs::read(p).map_err(|e| e.to_string())?;
    if raw.len() < QOOTI_PACK_MAGIC.len() || &raw[..QOOTI_PACK_MAGIC.len()] != QOOTI_PACK_MAGIC {
        return Err("Not a valid .qooti collection file".to_string());
    }
    let zip_bytes: Vec<u8> = raw[QOOTI_PACK_MAGIC.len()..]
        .iter().enumerate()
        .map(|(i, &b)| b ^ QOOTI_PACK_KEY[i % QOOTI_PACK_KEY.len()])
        .collect();
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let manifest: serde_json::Value = {
        let mut f = archive.by_name("manifest.json").map_err(|_| "manifest.json missing".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())?
    };
    let col_name = manifest["collection"]["name"].as_str().unwrap_or("Imported Collection").to_string();
    let item_count = manifest["items"].as_array().map(|a| a.len()).unwrap_or(0) as u32;
    Ok(ImportAnalysis { source_type: "qooti".to_string(), media_count: item_count, display_name: col_name })
}

fn analyze_telegram_folder_source(dir: &std::path::Path) -> Result<ImportAnalysis, String> {
    let has_messages = dir.join("messages.html").exists();
    let has_photos   = dir.join("photos").exists();
    if !has_messages && !has_photos {
        return Err("Not a recognised Telegram export (no messages.html or photos/ folder)".to_string());
    }
    let mut count = 0u32;
    for sub in &["photos", "video_files", "files"] {
        let subdir = dir.join(sub);
        if !subdir.is_dir() { continue; }
        if let Ok(entries) = std::fs::read_dir(&subdir) {
            for entry in entries.flatten() {
                let n = entry.file_name();
                if is_import_media(&n.to_string_lossy()) { count += 1; }
            }
        }
    }
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("Telegram Export").to_string();
    Ok(ImportAnalysis { source_type: "telegram".to_string(), media_count: count, display_name: name })
}

fn analyze_notion_zip_source(zip_path: &std::path::Path) -> Result<ImportAnalysis, String> {
    use std::io::Read;
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut inner_zips: Vec<String> = Vec::new();
    let mut direct_count = 0u32;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let file_name = std::path::Path::new(&name).file_name()
            .and_then(|n| n.to_str()).unwrap_or("").to_string();
        if name.ends_with(".zip") { inner_zips.push(name); }
        else if is_import_media(&file_name) { direct_count += 1; }
    }

    let stem = zip_path.file_stem().and_then(|n| n.to_str()).unwrap_or("Notion Export").to_string();

    if inner_zips.is_empty() {
        if direct_count == 0 { return Err("No media files found in zip".to_string()); }
        return Ok(ImportAnalysis { source_type: "notion".to_string(), media_count: direct_count, display_name: stem });
    }

    let mut total = 0u32;
    for zip_name in &inner_zips {
        let mut entry = match archive.by_name(zip_name) { Ok(e) => e, Err(_) => continue };
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_err() { continue; }
        let cursor = std::io::Cursor::new(buf);
        let mut inner = match zip::ZipArchive::new(cursor) { Ok(z) => z, Err(_) => continue };
        for i in 0..inner.len() {
            if let Ok(ie) = inner.by_index(i) {
                let iname = ie.name().to_string();
                let fname = std::path::Path::new(&iname).file_name()
                    .and_then(|n| n.to_str()).unwrap_or("").to_string();
                if is_import_media(&fname) { total += 1; }
            }
        }
    }

    if total == 0 { return Err("No media files found in Notion export".to_string()); }
    Ok(ImportAnalysis { source_type: "notion".to_string(), media_count: total, display_name: stem })
}

#[tauri::command]
pub fn extract_import_archive(path: String, source_type: String) -> Result<Vec<String>, String> {
    let p = std::path::Path::new(&path);
    match source_type.as_str() {
        "telegram" => extract_telegram_media_paths(p),
        "notion"   => extract_notion_media_paths(p),
        _          => Err(format!("Unknown source type: {}", source_type)),
    }
}

fn extract_telegram_media_paths(dir: &std::path::Path) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    for sub in &["photos", "video_files", "files"] {
        let subdir = dir.join(sub);
        if !subdir.is_dir() { continue; }
        if let Ok(entries) = std::fs::read_dir(&subdir) {
            for entry in entries.flatten() {
                let n = entry.file_name();
                if is_import_media(&n.to_string_lossy()) {
                    paths.push(entry.path().to_string_lossy().into_owned());
                }
            }
        }
    }
    Ok(paths)
}

fn extract_notion_media_paths(zip_path: &std::path::Path) -> Result<Vec<String>, String> {
    use std::io::Read;
    let tmp_dir = std::env::temp_dir().join(format!("qooti_notion_{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let inner_zips: Vec<String> = {
        let mut v = Vec::new();
        for i in 0..archive.len() {
            if let Ok(e) = archive.by_index(i) {
                if e.name().ends_with(".zip") { v.push(e.name().to_string()); }
            }
        }
        v
    };

    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    fn write_entry(data: Vec<u8>, file_name: &str, dir: &std::path::Path,
                   out: &mut Vec<String>, seen: &mut std::collections::HashSet<String>) {
        let out_name = if !seen.contains(file_name) {
            seen.insert(file_name.to_string());
            file_name.to_string()
        } else {
            let (stem, ext) = file_name.rsplit_once('.').unwrap_or((file_name, ""));
            let n = format!("{}-{}.{}", stem, seen.len(), ext);
            seen.insert(n.clone()); n
        };
        let out_path = dir.join(&out_name);
        if std::fs::write(&out_path, &data).is_ok() {
            out.push(out_path.to_string_lossy().into_owned());
        }
    }

    if inner_zips.is_empty() {
        for i in 0..archive.len() {
            let mut entry = match archive.by_index(i) { Ok(e) => e, Err(_) => continue };
            let name = entry.name().to_string();
            let fname = std::path::Path::new(&name).file_name()
                .and_then(|n| n.to_str()).unwrap_or("").to_string();
            if !is_import_media(&fname) { continue; }
            let mut data = Vec::new();
            if entry.read_to_end(&mut data).is_err() { continue; }
            write_entry(data, &fname, &tmp_dir, &mut out, &mut seen);
        }
    } else {
        for zip_name in &inner_zips {
            let mut buf = Vec::new();
            {
                let mut entry = match archive.by_name(zip_name) { Ok(e) => e, Err(_) => continue };
                if entry.read_to_end(&mut buf).is_err() { continue; }
            }
            let cursor = std::io::Cursor::new(buf);
            let mut inner = match zip::ZipArchive::new(cursor) { Ok(z) => z, Err(_) => continue };
            for i in 0..inner.len() {
                let mut ie = match inner.by_index(i) { Ok(e) => e, Err(_) => continue };
                let iname = ie.name().to_string();
                let fname = std::path::Path::new(&iname).file_name()
                    .and_then(|n| n.to_str()).unwrap_or("").to_string();
                if !is_import_media(&fname) { continue; }
                let mut data = Vec::new();
                if ie.read_to_end(&mut data).is_err() { continue; }
                write_entry(data, &fname, &tmp_dir, &mut out, &mut seen);
            }
        }
    }

    Ok(out)
}

#[tauri::command]
pub fn fetch_youtube_thumbnail(url: String) -> Result<String, String> {
    use std::io::Read;
    let video_id = extract_yt_video_id(&url)
        .ok_or_else(|| "Could not extract YouTube video ID".to_string())?
        .to_string();
    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
              (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
    let thumb_url = format!("https://img.youtube.com/vi/{}/maxresdefault.jpg", video_id);
    let resp = crate::net_guard::agent().get(&thumb_url).set("User-Agent", ua).call()
        .or_else(|_| {
            let fb = format!("https://img.youtube.com/vi/{}/hqdefault.jpg", video_id);
            crate::net_guard::agent().get(&fb).set("User-Agent", ua).call()
        })
        .map_err(|e| e.to_string())?;
    let mut bytes: Vec<u8> = Vec::new();
    resp.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let out = std::env::temp_dir().join(format!("qooti_yt_thumb_{}.jpg", video_id));
    std::fs::write(&out, &bytes).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}

fn extract_yt_video_id(url: &str) -> Option<&str> {
    if let Some(pos) = url.find("v=") {
        let rest = &url[pos + 2..];
        let end = rest.find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-').unwrap_or(rest.len());
        let id = &rest[..end];
        if id.len() >= 8 { return Some(id); }
    }
    for prefix in &["youtu.be/", "/shorts/", "/embed/"] {
        if let Some(pos) = url.find(prefix) {
            let rest = &url[pos + prefix.len()..];
            let end = rest.find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-').unwrap_or(rest.len());
            let id = &rest[..end];
            if id.len() >= 8 { return Some(id); }
        }
    }
    None
}

// ── Free-plan helpers ─────────────────────────────────────────────

/// The plan the free-plan limits use: the verified licence ticket, never the `plan`
/// preference (that's a display copy the user could edit in the database).
fn get_plan_from_db(_db: &rusqlite::Connection) -> String {
    crate::bloot_hub::verified_plan().to_string()
}

pub(crate) fn is_free_plan(plan: &str) -> bool {
    !plan.starts_with("pro")
}

// Returns true if this collection is read-only for the current (free) plan user.
// A collection is locked when it's not among the FREE_COLLECTION_LIMIT oldest ones.
pub(crate) fn is_collection_locked(db: &rusqlite::Connection, collection_id: &str) -> bool {
    let plan = get_plan_from_db(db);
    if !is_free_plan(&plan) { return false; }
    collection_past_free_allowance(db, collection_id)
}

/// The collection isn't among the FREE_COLLECTION_LIMIT oldest, so the Free plan only reads it
/// (is_collection_locked, whatever the plan is).
pub(crate) fn collection_past_free_allowance(db: &rusqlite::Connection, collection_id: &str) -> bool {
    // Count how many collections were created strictly before this one.
    // If 3 or more are older, this one falls outside the free allowance.
    let older: i64 = db.query_row(
        "SELECT COUNT(*) FROM collections c2
         WHERE c2.created_at < (SELECT created_at FROM collections WHERE id = ?1)",
        [collection_id],
        |r| r.get(0),
    ).unwrap_or(0);
    older >= FREE_COLLECTION_LIMIT as i64
}

pub const FREE_ITEM_LIMIT:         u32 = 200;
pub const FREE_ITEM_TEASER:        u32 = 40;   // max blurred teaser cards (2 rows × up to 20 cols)
pub const FREE_COLLECTION_LIMIT:   u32 = 3;
pub const FREE_EXT_DAILY_LIMIT:    u32 = 10;
pub const FREE_DOWNLOAD_DAILY_LIMIT: u32 = 20;

#[derive(serde::Serialize)]
pub struct FreePlanInfo {
    pub is_free:             bool,
    pub item_limit:          u32,
    pub item_total:          i64,
    pub collection_limit:    u32,
    pub collection_count:    i64,
    pub ext_limit:           u32,
    pub ext_used_today:      u32,
    pub queued_count:        i64,
    pub download_limit:      u32,
    pub download_used_today: u32,
}

#[tauri::command]
pub fn get_free_plan_info(state: State<AppState>) -> Result<FreePlanInfo, String> {
    let db = state.db.lock().unwrap();
    let plan = get_plan_from_db(&db);
    let is_free = is_free_plan(&plan);

    let item_total: i64 = db.query_row(
        "SELECT COUNT(*) FROM inspirations", [], |r| r.get(0)
    ).unwrap_or(0);

    let collection_count: i64 = db.query_row(
        "SELECT COUNT(*) FROM collections", [], |r| r.get(0)
    ).unwrap_or(0);
    // For the bars on the account site's Free card (sent only on Free, only on change).
    crate::bloot_hub::report_usage(item_total, collection_count);

    let queued_count: i64 = db.query_row(
        "SELECT COUNT(*) FROM ext_download_queue", [], |r| r.get(0)
    ).unwrap_or(0);

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    let ext_date: String = db.query_row(
        "SELECT value FROM preferences WHERE key = 'ext_dl_date'", [], |r| r.get(0)
    ).unwrap_or_default();
    let ext_used: u32 = if ext_date == today {
        db.query_row(
            "SELECT CAST(value AS INTEGER) FROM preferences WHERE key = 'ext_dl_count'",
            [], |r| r.get(0),
        ).unwrap_or(0)
    } else { 0 };

    let app_dl_date: String = db.query_row(
        "SELECT value FROM preferences WHERE key = 'app_dl_date'", [], |r| r.get(0)
    ).unwrap_or_default();
    let app_dl_used: u32 = if app_dl_date == today {
        db.query_row(
            "SELECT CAST(value AS INTEGER) FROM preferences WHERE key = 'app_dl_count'",
            [], |r| r.get(0),
        ).unwrap_or(0)
    } else { 0 };

    Ok(FreePlanInfo {
        is_free,
        item_limit:          if is_free { FREE_ITEM_LIMIT } else { u32::MAX },
        item_total,
        collection_limit:    if is_free { FREE_COLLECTION_LIMIT } else { u32::MAX },
        collection_count,
        ext_limit:           if is_free { FREE_EXT_DAILY_LIMIT } else { u32::MAX },
        ext_used_today:      if is_free { ext_used } else { 0 },
        queued_count:        if is_free { queued_count } else { 0 },
        download_limit:      if is_free { FREE_DOWNLOAD_DAILY_LIMIT } else { u32::MAX },
        download_used_today: if is_free { app_dl_used } else { 0 },
    })
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ─── URL duplicate check ─────────────────────────────────────────
// Before downloading a link, qooti looks for an item saved from the same page. The
// same page is often written differently — share links add ?si=/utm_ tags, youtu.be vs
// youtube.com/watch?v=, Shorts, www./m. — so links are compared by a normal form.

/// A link reduced to what identifies the page: the video id for YouTube, Instagram and
/// TikTok; otherwise host + path + the query without tracking tags (sorted), no fragment.
pub fn normalize_link(raw: &str) -> String {
    let s = raw.trim();
    let no_scheme = s.split_once("://").map_or(s, |(_, rest)| rest);
    let no_frag = no_scheme.split('#').next().unwrap_or("");
    let (host_path, query) = no_frag.split_once('?').unwrap_or((no_frag, ""));
    let (host, path) = host_path.split_once('/').unwrap_or((host_path, ""));
    let host = host.to_ascii_lowercase();
    let host = host.trim_start_matches("www.").trim_start_matches("m.").trim_start_matches("mobile.");
    let path = path.trim_end_matches('/');
    let segs: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let param = |k: &str| query.split('&').find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| v.to_string()));

    match host {
        "youtu.be" => if let Some(id) = segs.first() { return format!("youtube:{id}") },
        "youtube.com" | "music.youtube.com" => {
            if let Some(id) = param("v").filter(|v| !v.is_empty()) { return format!("youtube:{id}") }
            if let [kind, id, ..] = segs.as_slice() {
                if matches!(*kind, "shorts" | "embed" | "live" | "v") { return format!("youtube:{id}") }
            }
        }
        "instagram.com" => {
            // /p/ID, /reel/ID, /reels/ID, /tv/ID — also behind a /username/ prefix
            if let Some(i) = segs.iter().position(|p| matches!(*p, "p" | "reel" | "reels" | "tv")) {
                if let Some(id) = segs.get(i + 1) { return format!("instagram:{id}") }
            }
        }
        "tiktok.com" => {
            if let Some(i) = segs.iter().position(|p| *p == "video" || *p == "photo") {
                if let Some(id) = segs.get(i + 1) { return format!("tiktok:{id}") }
            }
        }
        // A post is its path; the query (?s=20&t=…) is only share tracking
        "x.com" | "twitter.com" | "pinterest.com" | "behance.net" | "dribbble.com" => return format!("{host}/{path}"),
        _ => {}
    }

    const TRACKING: &[&str] = &["si", "feature", "igsh", "igshid", "fbclid", "gclid", "ref", "ref_src", "share_id", "_r", "_t"];
    let mut keep: Vec<&str> = query.split('&')
        .filter(|kv| !kv.is_empty())
        .filter(|kv| { let k = kv.split('=').next().unwrap_or(""); !k.starts_with("utm_") && !TRACKING.contains(&k) })
        .collect();
    keep.sort_unstable();
    let mut out = format!("{host}/{path}");
    if !keep.is_empty() { out.push('?'); out.push_str(&keep.join("&")); }
    out
}

/// The item already saved from this link, if any (exact match first, then the normal form).
pub fn find_by_link(db: &rusqlite::Connection, url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() { return None; }
    if let Ok(id) = db.query_row("SELECT id FROM inspirations WHERE source_url = ?1 LIMIT 1", params![url], |r| r.get(0)) {
        return Some(id);
    }
    let want = normalize_link(url);
    let mut stmt = db.prepare("SELECT id, source_url FROM inspirations WHERE source_url IS NOT NULL AND source_url != ''").ok()?;
    let rows: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).ok()?.flatten().collect();
    rows.into_iter().find(|(_, u)| normalize_link(u) == want).map(|(id, _)| id)
}

#[tauri::command]
pub fn check_url_exists(url: String, state: State<AppState>) -> Result<Option<Inspiration>, String> {
    let db = state.db.lock().unwrap();
    let Some(id) = find_by_link(&db, &url) else { return Ok(None) };
    db.query_row(
        "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, lens_suggestions, auto_tag_model, duration_secs,
                (SELECT json_group_array(c.name) FROM collection_items ci
                 JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names, enhanced_path, auto_tag_sig, (original_path IS NOT NULL) AS has_original
         FROM inspirations WHERE id = ?1",
        params![id],
        row_to_inspiration,
    ).optional().map_err(|e| e.to_string())
}

// ─── Engagement tracking ─────────────────────────────────────────

#[tauri::command]
pub fn track_view(id: String, state: State<AppState>) -> Result<(), String> {
    let db  = state.db.lock().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    db.execute(
        "UPDATE inspirations SET view_count = view_count + 1, last_viewed_at = ?1 WHERE id = ?2",
        params![now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Collection hints (Tag lens spec §6.4) ───────────────────────
// In a collection where at least 3 items carry people's own tags and ≥ 70 % of those share one,
// the collection's items with none of people's tags are asked about it: the suggestion key
// `col:<tag_id>` in lens_suggestions, shown on cards next to the lens suggestions.
// Returns the number of items that got a new hint, and sends `autotag:scored {ids}` for them so
// their cards ask about it at once.

#[tauri::command]
pub fn apply_collection_tag_suggestions(app: AppHandle, state: State<AppState>) -> Result<i64, String> {
    let ids = {
        let db = state.db.lock().unwrap();
        apply_collection_hints(&db).map_err(|e| e.to_string())?
    };
    if !ids.is_empty() {
        if let Err(e) = app.emit("autotag:scored", serde_json::json!({ "ids": ids })) {
            log::warn!(target: "Lens", "autotag:scored not sent: {e}");
        }
    }
    Ok(ids.len() as i64)
}

/// Only while tag suggestions are on. Only people's own tags are hinted (lens tags come from the
/// lenses, and so does a people's tag that stands for a concept: one name, one tag, tagging.rs).
/// A video only when its length is known and within the limit (tagging::max_tag_video_secs,
/// §0.11): a video whose length isn't known yet, or can't be found, gets none. Never a tag the
/// item already has, a hint already answered (`tag_answers.concept_id = 'col:<tag_id>'`), or a
/// tag named like one the item has (a lens tag with that label: spec §0b.2). Each hint is added
/// with json_set, so no other key of the item changes. Returns the ids of the items that got a
/// new hint, sorted.
fn apply_collection_hints(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<String>> {
    if !crate::tagging::suggestions_enabled(conn) { return Ok(Vec::new()); }
    let rows: Vec<(String, String, f64)> = {
        let mut stmt = conn.prepare(
            "WITH
             people AS (
                 SELECT it.inspiration_id, it.tag_id FROM inspiration_tags it
                 JOIN tags t ON t.id = it.tag_id
                 WHERE t.concept_id IS NULL AND t.source != 'model'
             ),
             col_tagged AS (
                 SELECT ci.collection_id, COUNT(DISTINCT ci.inspiration_id) AS cnt
                 FROM collection_items ci JOIN people p ON p.inspiration_id = ci.inspiration_id
                 GROUP BY ci.collection_id
                 HAVING cnt >= 3
             ),
             tag_freq AS (
                 SELECT ci.collection_id, p.tag_id, COUNT(DISTINCT ci.inspiration_id) AS freq
                 FROM collection_items ci JOIN people p ON p.inspiration_id = ci.inspiration_id
                 GROUP BY ci.collection_id, p.tag_id
             ),
             dominant AS (
                 SELECT tf.collection_id, tf.tag_id, CAST(tf.freq AS REAL) / ct.cnt AS confidence
                 FROM tag_freq tf JOIN col_tagged ct ON ct.collection_id = tf.collection_id
                 WHERE CAST(tf.freq AS REAL) / ct.cnt >= 0.70
             )
             SELECT i.id, d.tag_id, MAX(d.confidence)
             FROM dominant d
             JOIN collection_items ci ON ci.collection_id = d.collection_id
             JOIN inspirations i ON i.id = ci.inspiration_id
             WHERE (i.type != 'video' OR (i.duration_secs > 0 AND i.duration_secs <= ?1))
               AND NOT EXISTS (SELECT 1 FROM people p WHERE p.inspiration_id = i.id)
               AND NOT EXISTS (SELECT 1 FROM inspiration_tags it WHERE it.inspiration_id = i.id AND it.tag_id = d.tag_id)
               AND NOT EXISTS (SELECT 1 FROM tag_answers a WHERE a.inspiration_id = i.id AND a.concept_id = 'col:' || d.tag_id)
             GROUP BY i.id, d.tag_id",
        )?;
        let rows = stmt.query_map(params![crate::tagging::max_tag_video_secs()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    if rows.is_empty() { return Ok(Vec::new()); }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let mut items: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (id, tag_id, confidence) in &rows {
        if !hint_safe_tag_id(tag_id) { continue; }   // a key nobody could answer (tag ids are UUIDs)
        if crate::tagging::hint_name_taken(&tx, id, tag_id)? { continue; }
        let n = tx.execute(
            "UPDATE inspirations SET lens_suggestions = json_set(
                 CASE WHEN json_valid(lens_suggestions) THEN lens_suggestions ELSE '{}' END, ?2, ?3)
             WHERE id = ?1
               AND CASE WHEN json_valid(lens_suggestions) THEN json_type(lens_suggestions, ?2) IS NULL ELSE 1 END",
            params![id, format!("$.\"col:{tag_id}\""), (confidence * 10_000.0).round() / 10_000.0],
        )?;
        if n > 0 { items.insert(id.clone()); }
    }
    tx.commit()?;
    Ok(items.into_iter().collect())
}

// ─── Recommendation queries ───────────────────────────────────────

const INSP_SELECT: &str =
    "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
            aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
            phash, phash_source, vault_id, mime_type, created_at, updated_at,
            auto_tag_status, lens_suggestions, auto_tag_model, duration_secs,
            (SELECT json_group_array(c.name) FROM collection_items ci
             JOIN collections c ON c.id = ci.collection_id
             WHERE ci.inspiration_id = inspirations.id) AS collection_names, enhanced_path, auto_tag_sig, (original_path IS NOT NULL) AS has_original
     FROM inspirations";

// Items saved 60–180 days ago, least recently viewed first.
#[tauri::command]
pub fn list_rediscover(limit: i64, state: State<AppState>) -> Result<Vec<Inspiration>, String> {
    let db  = state.db.lock().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let day_ms  = 86_400_000i64;
    let ago_60  = now - 60  * day_ms;
    let ago_180 = now - 180 * day_ms;

    let sql = format!(
        "{} WHERE created_at BETWEEN ?1 AND ?2
           AND NOT (type = 'video' AND aspect_ratio < 0.67)
         ORDER BY COALESCE(last_viewed_at, 0) ASC, RANDOM()
         LIMIT ?3",
        INSP_SELECT
    );

    let rows: Vec<Inspiration> = db.prepare(&sql).map_err(|e| e.to_string())?
        .query_map(params![ago_180, ago_60, limit], row_to_inspiration)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// Items sharing tags with the most-recently-opened item.
#[tauri::command]
pub fn list_because_you_viewed(limit: i64, state: State<AppState>) -> Result<Vec<Inspiration>, String> {
    let db = state.db.lock().unwrap();

    let last: Option<(String, String)> = db.query_row(
        "SELECT id, type FROM inspirations WHERE last_viewed_at IS NOT NULL ORDER BY last_viewed_at DESC LIMIT 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).ok();

    let Some((pivot_id, pivot_type)) = last else { return Ok(vec![]) };

    // Check pivot actually has tags; if not, fall back to items of the same media type.
    let tag_count: i64 = db.query_row(
        "SELECT COUNT(*) FROM inspiration_tags WHERE inspiration_id = ?1",
        params![pivot_id],
        |r| r.get(0),
    ).unwrap_or(0);

    if tag_count == 0 {
        let fallback_sql = format!(
            "{} WHERE type = ?1 AND id != ?2
               AND NOT (type = 'video' AND aspect_ratio < 0.67)
             ORDER BY RANDOM()
             LIMIT ?3",
            INSP_SELECT
        );
        let rows: Vec<Inspiration> = db.prepare(&fallback_sql).map_err(|e| e.to_string())?
            .query_map(params![pivot_type, pivot_id, limit], row_to_inspiration)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        return Ok(rows);
    }

    let sql = format!(
        "SELECT inspirations.id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, lens_suggestions, auto_tag_model, duration_secs,
                (SELECT json_group_array(c.name) FROM collection_items ci
                 JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names, enhanced_path, auto_tag_sig, (original_path IS NOT NULL) AS has_original
         FROM inspirations
         WHERE inspirations.id != ?1
           AND inspirations.id IN (
               SELECT it2.inspiration_id FROM inspiration_tags it2
               WHERE it2.tag_id IN (
                   SELECT tag_id FROM inspiration_tags WHERE inspiration_id = ?1
               )
           )
           AND NOT (type = 'video' AND aspect_ratio < 0.67)
         ORDER BY RANDOM()
         LIMIT ?2"
    );

    let rows: Vec<Inspiration> = db.prepare(&sql).map_err(|e| e.to_string())?
        .query_map(params![pivot_id, limit], row_to_inspiration)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// Items saved 30+ days ago with the lowest view counts — things you've forgotten.
#[tauri::command]
pub fn list_havent_seen(limit: i64, state: State<AppState>) -> Result<Vec<Inspiration>, String> {
    let db  = state.db.lock().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let ago_30 = now - 30 * 86_400_000i64;

    let sql = format!(
        "{} WHERE created_at < ?1
           AND NOT (type = 'video' AND aspect_ratio < 0.67)
         ORDER BY COALESCE(view_count, 0) ASC, COALESCE(last_viewed_at, 0) ASC, RANDOM()
         LIMIT ?2",
        INSP_SELECT
    );

    let rows: Vec<Inspiration> = db.prepare(&sql).map_err(|e| e.to_string())?
        .query_map(params![ago_30, limit], row_to_inspiration)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

trait OptionalExt<T> {
    fn optional(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalExt<T> for rusqlite::Result<T> {
    fn optional(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

// ─── Download session persistence ────────────────────────────────────────────
// Stores failed/cancelled downloads that never reached the vault so the activity
// view can show them and offer retry across app restarts.

#[tauri::command]
pub fn log_failed_download(
    id:           String,
    url:          String,
    quality:      String,
    import_source: String,
    status:       String,
    error_msg:    Option<String>,
    filename:     Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let now = now_ms();
    let db  = state.db.lock().unwrap();
    db.execute(
        "INSERT OR REPLACE INTO download_sessions \
         (id, url, quality, import_source, status, error_msg, filename, created_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![id, url, quality, import_source, status, error_msg, filename, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_failed_download(id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM download_sessions WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_all_failed_downloads(state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM download_sessions", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_activity(limit: i64, state: State<AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().unwrap();
    let mut entries: Vec<serde_json::Value> = Vec::new();

    // 1. Non-pack inspirations (file imports, app downloads, extension downloads)
    {
        let mut stmt = db.prepare(
            "SELECT id, type, title, thumbnail_path, source_platform, import_source, created_at, stored_path
             FROM inspirations
             WHERE import_source IS NULL OR import_source != 'pack_import'
             ORDER BY created_at DESC
             LIMIT ?1",
        ).map_err(|e| e.to_string())?;
        let rows: Vec<serde_json::Value> = stmt.query_map(params![limit], |row| {
            let import_source: Option<String> = row.get(5)?;
            Ok(serde_json::json!({
                "kind":            "media",
                "id":              row.get::<_, String>(0)?,
                "type":            row.get::<_, String>(1)?,
                "title":           row.get::<_, Option<String>>(2)?,
                "thumbnail_path":  row.get::<_, Option<String>>(3)?,
                "source_platform": row.get::<_, Option<String>>(4)?,
                "import_source":   import_source.unwrap_or_else(|| "file_import".to_string()),
                "created_at":      row.get::<_, i64>(6)?,
                "stored_path":     row.get::<_, Option<String>>(7)?,
            }))
        }).map_err(|e| e.to_string())?
        .flatten()
        .collect();
        entries.extend(rows);
    }

    // 2. Pack import groups — each group is one collapsed row in the activity view
    let pack_groups: Vec<(String, String, String, i64, i64)> = {
        let mut stmt = db.prepare(
            "SELECT i.batch_id, c.id, c.name, COUNT(*) AS cnt, MIN(i.created_at)
             FROM inspirations i
             JOIN collections c ON c.id = i.batch_id
             WHERE i.import_source = 'pack_import'
             GROUP BY i.batch_id
             ORDER BY MIN(i.created_at) DESC",
        ).map_err(|e| e.to_string())?;
        let result: Vec<_> = stmt.query_map([], |row| Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))).map_err(|e| e.to_string())?
        .flatten()
        .collect();
        result
    };
    for (batch_id, col_id, col_name, item_count, created_at) in pack_groups {
        let previews: Vec<serde_json::Value> = {
            let mut ps = db.prepare(
                "SELECT id, type, thumbnail_path, title
                 FROM inspirations WHERE batch_id = ?1 LIMIT 5",
            ).map_err(|e| e.to_string())?;
            let result: Vec<_> = ps.query_map(params![batch_id], |r| Ok(serde_json::json!({
                "id":             r.get::<_, String>(0)?,
                "type":           r.get::<_, String>(1)?,
                "thumbnail_path": r.get::<_, Option<String>>(2)?,
                "title":          r.get::<_, Option<String>>(3)?,
            }))).map_err(|e| e.to_string())?
            .flatten()
            .collect();
            result
        };
        entries.push(serde_json::json!({
            "kind":            "pack",
            "batch_id":        batch_id,
            "collection_id":   col_id,
            "collection_name": col_name,
            "item_count":      item_count,
            "preview_items":   previews,
            "created_at":      created_at,
        }));
    }

    // 3. Persisted failed/cancelled download attempts
    {
        let mut stmt = db.prepare(
            "SELECT id, url, quality, import_source, status, error_msg, filename, created_at
             FROM download_sessions
             ORDER BY created_at DESC",
        ).map_err(|e| e.to_string())?;
        let rows: Vec<serde_json::Value> = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "kind":          "failed",
                "id":            row.get::<_, String>(0)?,
                "url":           row.get::<_, String>(1)?,
                "quality":       row.get::<_, String>(2)?,
                "import_source": row.get::<_, String>(3)?,
                "status":        row.get::<_, String>(4)?,
                "error_msg":     row.get::<_, Option<String>>(5)?,
                "filename":      row.get::<_, Option<String>>(6)?,
                "created_at":    row.get::<_, i64>(7)?,
            }))
        }).map_err(|e| e.to_string())?
        .flatten()
        .collect();
        entries.extend(rows);
    }

    // Merge and sort all entries newest first
    entries.sort_by(|a, b| {
        let ta = a["created_at"].as_i64().unwrap_or(0);
        let tb = b["created_at"].as_i64().unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok(serde_json::json!({ "entries": entries }))
}

/// Queue a URL for the Chrome extension to download using its browser cookies.
/// The extension polls GET /extension/pending-download and picks this up within a few seconds.
#[tauri::command]
pub fn queue_ext_download(url: String, state: State<AppState>) {
    log::info!(target: "Download", "queue_ext_download url={url:?}");
    *state.pending_ext_download.lock().unwrap() = Some(url);
}

// ─── Full app reset ───────────────────────────────────────────────
#[tauri::command]
pub async fn reset_app(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    // 1. Wipe all user-content tables. Kept: preferences (so also user_role, the tag-suggestion
    //    switch and the lens update bookkeeping), license_cache, tag_vocab, schema_meta, and the
    //    installed Tag lenses with their on/off flags and concepts (app data, like settings).
    //    Per-item tag data goes: tag_answers, the CLIP vectors of the wiped items, and the
    //    placeholder concepts pack imports made for concepts no lens here has (lens_id '').
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.execute_batch(
            "DELETE FROM tag_answers;
             DELETE FROM concepts WHERE lens_id = '';
             DELETE FROM clip_embeddings;
             DELETE FROM clip_frames;
             DELETE FROM inspirations;
             DELETE FROM collections;
             DELETE FROM tags;
             DELETE FROM milestones;
             DELETE FROM notifications;
             DELETE FROM feedback_outbox;
             DELETE FROM user_tag_weights;
             DELETE FROM download_sessions;"
        ).map_err(|e| e.to_string())?;
    }

    // 2. Delete all files inside every vault subdirectory (keep directory structure)
    if let Ok(vault_path) = vault::get_vault_path(&app) {
        for sub in &["images", "videos", "gifs", "links", "thumbnails", "temp", "profile", "downloads_tmp"] {
            let dir = vault_path.join(sub);
            if !dir.exists() { continue; }
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        std::fs::remove_file(&path).ok();
                    } else if path.is_dir() {
                        std::fs::remove_dir_all(&path).ok();
                    }
                }
            }
        }
    }

    log::info!(target: "Reset", "reset_app completed — library wiped");
    Ok(())
}

#[cfg(test)]
mod ext_error_tests {
    use super::{ext_error_code, friendly_ext_error};

    #[test]
    fn extension_errors_are_plain_and_short() {
        let cases = [
            "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser",
            "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
            "ERROR: unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>",
            "yt-dlp exited with code 1: HTTP Error 403: Forbidden",
            "timed out in pending state",
            "something nobody anticipated: panic at 0x0000",
            "Free daily limit reached. qooti will download it at midnight.",
        ];
        for raw in cases {
            let m = friendly_ext_error(raw);
            assert!(m.len() <= 80, "{m}");
            assert!(!m.contains("ERROR") && !m.contains("yt-dlp") && !m.contains("HTTP") && !m.contains("[youtube]"), "{m}");
        }
        assert_eq!(friendly_ext_error(cases[0]), "YouTube blocked this one (age or bot check). Try again later.");
        assert_eq!(friendly_ext_error(cases[1]), "This video is private, removed or unavailable.");
    }

    // The extension words each code in its own language
    #[test]
    fn every_wording_has_its_code() {
        let code = |raw: &str| ext_error_code(&friendly_ext_error(raw));
        assert_eq!(code("ERROR: [youtube] x: Sign in to confirm you're not a bot"), "age_bot");
        assert_eq!(code("Requested content is not available, rate-limit reached or login required. Use --cookies"), "signin");
        assert_eq!(code("private_address"), "private_address");
        assert_eq!(code("timed out in pending state"), "timeout");
        assert_eq!(code("something nobody anticipated"), "generic");
        assert_eq!(code("Free daily limit reached. qooti will download it at midnight."), "limit");
    }
}

#[cfg(test)]
mod youtube_args_tests {
    use super::*;

    #[test]
    fn normal_runs_add_the_embedded_player_and_skip_hls() {
        assert_eq!(
            youtube_extractor_args("https://www.youtube.com/watch?v=x", YT_CLIENTS),
            "youtube:skip=hls;player_client=default,web_embedded"
        );
        // A live stream only exists as HLS.
        assert_eq!(
            youtube_extractor_args("https://www.youtube.com/live/x", YT_CLIENTS),
            "youtube:player_client=default,web_embedded"
        );
        assert_eq!(
            youtube_extractor_args("https://youtu.be/x", "tv,android_vr,web_embedded,ios"),
            "youtube:skip=hls;player_client=tv,android_vr,web_embedded,ios"
        );
    }

    #[test]
    fn retries_swap_the_one_youtube_value() {
        let args: Vec<String> = [
            "--format", "bv*+ba/b", "--format-sort", "res:1080,vcodec:h264,fps,acodec:aac",
            "--extractor-args", "youtube:skip=hls;player_client=default,web_embedded",
        ].map(String::from).to_vec();
        let hls = with_youtube_clients(&args, YT_CLIENTS);
        let youtube: Vec<&String> = hls.iter().filter(|a| a.starts_with("youtube:")).collect();
        assert_eq!(youtube, ["youtube:player_client=default,web_embedded"]);
        assert_eq!(hls.iter().filter(|a| *a == "--extractor-args").count(), 1);

        let capped = with_arg(&args, "--format-sort", "res:720,vcodec:h264,fps,acodec:aac");
        assert_eq!(capped[3], "res:720,vcodec:h264,fps,acodec:aac");
        assert_eq!(capped[1], "bv*+ba/b");
    }

    #[test]
    fn recognises_withheld_streams() {
        assert!(youtube_withheld_streams(
            "WARNING: [youtube] qtl2fg-xc30: Some web_embedded client https formats have been skipped as they are missing a URL. YouTube may have enabled the SABR-only streaming experiment for the current session."
        ));
        assert!(!youtube_withheld_streams(
            "ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."
        ));
    }
}

#[cfg(test)]
mod dup_tests {
    use super::*;

    fn unit(seed: &[f32]) -> Vec<f32> {
        let mut v: Vec<f32> = (0..512).map(|k| seed[k % seed.len()] + (k as f32 * 0.37).sin() * 0.05).collect();
        let len = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        for x in &mut v { *x /= len; }
        v
    }
    /// A copy of `v` rotated towards an orthogonal direction so cos(v, result) == cos.
    fn at_cos(v: &[f32], cos: f32) -> Vec<f32> {
        let mut o: Vec<f32> = (0..512).map(|k| if k % 2 == 0 { 1.0 } else { -1.0 }).collect();
        let d: f32 = o.iter().zip(v).map(|(a, b)| a * b).sum();
        for (x, y) in o.iter_mut().zip(v) { *x -= d * y; }
        let len = o.iter().map(|x| x * x).sum::<f32>().sqrt();
        let s = (1.0 - cos * cos).sqrt();
        v.iter().zip(&o).map(|(a, b)| cos * a + s * b / len).collect()
    }
    fn fp(gray: u8, rgb: u8) -> Option<Fp> {
        Some(Fp { dhash: 0xF0F0, sig: vec![gray; 256], rgb: Some(vec![rgb; 48]), aspect: Some(1.0) })
    }
    fn still(clip: Option<Vec<f32>>, gray: u8, text: &str) -> DupCand {
        DupCand { motion: false, fp: fp(gray, 100), clip, words: ocr_words(text), duration: None, aspect: 1.0 }
    }

    #[test]
    fn same_picture_matches_and_lookalikes_do_not() {
        let e = unit(&[0.3, -0.2, 0.9]);
        assert_eq!(dup_match(&still(Some(e.clone()), 100, ""), &still(Some(at_cos(&e, 0.99)), 101, "")), Some(DupLevel::Identical));
        assert_eq!(dup_match(&still(Some(e.clone()), 100, ""), &still(Some(at_cos(&e, 0.96)), 108, "")), Some(DupLevel::Possible));
        // Same light/dark layout, different picture (the old false positives: CLIP ≤ 0.81).
        assert_eq!(dup_match(&still(Some(e.clone()), 100, ""), &still(Some(at_cos(&e, 0.81)), 100, "")), None);
        // Same template, different words.
        assert_eq!(dup_match(&still(Some(e.clone()), 100, "summer sale up to fifty"), &still(Some(at_cos(&e, 0.99)), 100, "winter launch new collection")), None);
        // Recoloured variant: layout lines up, colours don't.
        let mut b = still(Some(at_cos(&e, 0.97)), 100, "");
        b.fp = fp(100, 160);
        assert_eq!(dup_match(&still(Some(e.clone()), 100, ""), &b), None);
        // A still is never a copy of a video.
        let mut v = still(Some(e.clone()), 100, "");
        v.motion = true;
        assert_eq!(dup_match(&still(Some(e.clone()), 100, ""), &v), None);
    }

    #[test]
    fn same_video_is_found_even_when_thumbnails_differ() {
        let e = unit(&[0.5, 0.1, -0.4]);
        let clip = |cos: f32, dur: f64, gray: u8| DupCand { motion: true, fp: fp(gray, 100), clip: Some(at_cos(&e, cos)), words: HashSet::new(), duration: Some(dur), aspect: 1.78 };
        // The reel saved twice: CLIP 0.92, 0.06 s apart, thumbnails from different frames.
        assert_eq!(dup_match(&clip(1.0, 60.14, 60), &clip(0.92, 60.20, 140)), Some(DupLevel::Possible));
        // Same look, different length → different videos.
        assert_eq!(dup_match(&clip(1.0, 2.46, 60), &clip(0.95, 8.17, 60)), None);
        // Same length, different content.
        assert_eq!(dup_match(&clip(1.0, 13.19, 60), &clip(0.69, 12.98, 60)), None);
    }

    #[test]
    fn without_clip_only_near_identical_fingerprints_match() {
        let a = still(None, 100, "");
        assert_eq!(dup_match(&a, &still(None, 101, "")), Some(DupLevel::Identical));
        assert_eq!(dup_match(&a, &still(None, 106, "")), None);
    }

    #[test]
    fn dismissed_pairs_never_share_a_group() {
        // A matches B and C, B matches C, but the user said B and C are not duplicates.
        let edges: HashMap<(usize, usize), DupLevel> =
            [((0, 1), DupLevel::Identical), ((0, 2), DupLevel::Identical), ((1, 2), DupLevel::Identical)].into();
        let mut used = vec![false; 3];
        let groups = cluster_dupes(&[0, 1, 2], &edges, &mut used, &|a, b| (a.min(b), a.max(b)) == (1, 2));
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0, vec![0, 1]);

        // Every pair must match: C matches A but not B → C stays out of A+B.
        let edges: HashMap<(usize, usize), DupLevel> = [((0, 1), DupLevel::Possible), ((0, 2), DupLevel::Possible)].into();
        let mut used = vec![false; 3];
        let groups = cluster_dupes(&[0, 1, 2], &edges, &mut used, &|_, _| false);
        assert_eq!(groups, vec![(vec![0, 1], DupLevel::Possible)]);
    }

    #[test]
    fn letterbox_bars_are_trimmed_before_fingerprinting() {
        let mut img = image::RgbImage::from_pixel(300, 300, image::Rgb([0, 0, 0]));
        for y in 75..225 { for x in 0..300 { img.put_pixel(x, y, image::Rgb([(x % 255) as u8, 120, (y % 200) as u8])); } }
        let dir = std::env::temp_dir().join("qooti-dup-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("letterbox.png");
        img.save(&path).unwrap();
        let f = parse_fp(&phash_from_path(path.to_str().unwrap()).unwrap()).unwrap();
        assert!((f.aspect.unwrap() - 2.0).abs() < 0.05, "aspect {:?}", f.aspect);
        assert_eq!(f.rgb.as_ref().map(|v| v.len()), Some(48));
        // v2 strings still parse until the backfill replaces them.
        assert!(parse_fp(&format!("{:016x}:{}", 7u64, "ab".repeat(256))).is_some());
    }
}

#[cfg(test)]
mod pack_meta_tests {
    use super::*;
    use base64::Engine;

    /// Everything one computer worked out for an item survives export → manifest → import,
    /// so the other computer has nothing to recompute.
    #[test]
    fn pack_carries_all_analysis_results() {
        let dir = std::env::temp_dir().join(format!("qooti-pack-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("a.png");
        image::RgbImage::from_fn(64, 48, |x, y| image::Rgb([(x * 4) as u8, (y * 5) as u8, 90])).save(&img).unwrap();
        let thumb = dir.join("a_thumb.jpg");
        image::RgbImage::from_pixel(8, 8, image::Rgb([10, 20, 30])).save(&thumb).unwrap();
        let phash = phash_from_path(img.to_str().unwrap()).unwrap();
        let emb: Vec<u8> = (0..crate::clip::DIM).flat_map(|k| (k as f32 / 512.0).to_le_bytes()).collect();

        let db = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&db).unwrap();
        crate::clip::ensure_table(&db);
        db.execute(
            "INSERT INTO inspirations (id, type, stored_path, created_at, updated_at, aspect_ratio, palette,
                ocr_text, ocr_status, ocr_language, phash, phash_source, auto_tag_status, auto_tag_confidence,
                auto_tag_model, object_tags, object_status, duration_secs, thumbnail_path, lens_suggestions)
             VALUES ('a','image',?1,0,0,1.3333,'[\"#112233\",\"#AABBCC\"]','hello world','done','eng',?2,?3,
                'done','{\"sunset\":0.81}','clip-vit-base-patch32','person car','done',NULL,?4,'{\"poster\":0.6}')",
            params![img.to_string_lossy(), phash, FP_VERSION, thumb.to_string_lossy()],
        ).unwrap();
        db.execute("INSERT INTO clip_embeddings (id, model, emb) VALUES ('a', ?1, ?2)", params![crate::clip::MODEL_TAG, emb]).unwrap();
        db.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('t1','sunset','model',0),('t2','moodboard','user',0)", []).unwrap();
        db.execute("INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('a','t1'),('a','t2')", []).unwrap();

        // Export side
        let ex = pack_extras(&db, "a").unwrap();
        let mut entry = serde_json::json!({ "id": "a", "type": "image", "file": "media/a.png", "ocr_text": "hello world" });
        let mut media = vec![("media/a.png".to_string(), img.to_string_lossy().into_owned())];
        pack_attach_extras(&mut entry, "a", &ex, &mut media);
        assert_eq!(media.len(), 2, "thumbnail travels with the item");
        assert_eq!(entry["thumb"], "thumbs/a.jpg");
        assert_eq!(entry["tag_sources"]["sunset"], "model");
        assert_eq!(entry["tag_sources"]["moodboard"], "user");
        // Tag suggestions never travel (the importing computer scores with its own lenses)
        for k in ["auto_tag_status", "auto_tag_confidence", "auto_tag_model", "lens_suggestions"] {
            assert!(entry["meta"].get(k).is_none(), "{k} exported");
        }

        // Through JSON text, as in the real pack
        let entry: serde_json::Value = serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();

        // Import side
        let got = read_pack_meta(&entry, false);
        assert_eq!(got, PackMeta {
            aspect_ratio:        Some(1.3333),
            duration_secs:       None,
            ocr_text:            "hello world".into(),
            ocr_status:          Some("done".into()),
            ocr_language:        Some("eng".into()),
            palette:             Some("[\"#112233\",\"#AABBCC\"]".into()),
            phash:               Some(phash.clone()),
            object_tags:         Some("person car".into()),
            object_status:       Some("done".into()),
            clip_emb:            Some(emb.clone()),
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A tampered or half-finished pack never plants bad data: each odd field is dropped and
    /// that step runs again here.
    #[test]
    fn pack_meta_rejects_bad_values() {
        let short = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        let nan: Vec<u8> = (0..crate::clip::DIM).flat_map(|_| f32::NAN.to_le_bytes()).collect();
        let nan = base64::engine::general_purpose::STANDARD.encode(nan);
        for (meta, what) in [
            (serde_json::json!({ "clip": { "model": crate::clip::MODEL_TAG, "emb": short } }), "short embedding"),
            (serde_json::json!({ "clip": { "model": crate::clip::MODEL_TAG, "emb": nan } }), "NaN embedding"),
            (serde_json::json!({ "clip": { "model": "other", "emb": "" } }), "other model"),
        ] {
            assert_eq!(read_pack_meta(&serde_json::json!({ "meta": meta }), false).clip_emb, None, "{what}");
        }
        let m = read_pack_meta(&serde_json::json!({ "meta": {
            "aspect_ratio": -2.0, "palette": "[\"red\"]", "phash": "v2|abc", "phash_source": "v2",
            "ocr_status": "processing", "ocr_language": "eng", "auto_tag_status": "processing",
            "auto_tag_model": "x", "object_status": "weird", "object_tags": "car",
        }, "ocr_text": "a\r\nb" }), false);
        assert_eq!(m, PackMeta { ocr_text: "a\nb".into(), ..Default::default() });
        // v1 pack: no meta at all, but its OCR text is kept
        let v1 = read_pack_meta(&serde_json::json!({ "ocr_text": "kept" }), false);
        assert_eq!(v1, PackMeta { ocr_text: "kept".into(), ..Default::default() });
        // Videos never queue OCR
        assert_eq!(read_pack_meta(&serde_json::json!({}), true).ocr_status.as_deref(), Some("skipped"));
    }
}

#[cfg(test)]
mod link_tests {
    use super::*;

    #[test]
    fn same_page_written_differently_matches() {
        let same = |a: &str, b: &str| assert_eq!(normalize_link(a), normalize_link(b), "{a} vs {b}");
        same("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "https://youtu.be/dQw4w9WgXcQ?si=abc");
        same("https://youtube.com/shorts/abc123?feature=share", "https://m.youtube.com/watch?v=abc123");
        same("https://www.instagram.com/reel/C9xyz/?igsh=MTc4", "https://instagram.com/p/C9xyz");
        same("https://www.instagram.com/someone/reel/C9xyz/", "https://instagram.com/reel/C9xyz");
        same("https://www.tiktok.com/@me/video/7300000000?is_from_webapp=1", "https://tiktok.com/@me/video/7300000000");
        same("https://x.com/user/status/123?s=20&t=xyz", "https://x.com/user/status/123");
        same("https://site.com/page/?utm_source=a&id=7#top", "http://site.com/page?id=7");
        same("https://site.com/a?b=2&a=1", "https://site.com/a?a=1&b=2");
    }

    #[test]
    fn different_pages_stay_different() {
        let differ = |a: &str, b: &str| assert_ne!(normalize_link(a), normalize_link(b), "{a} vs {b}");
        differ("https://youtu.be/aaa", "https://youtu.be/bbb");
        differ("https://site.com/search?q=cats", "https://site.com/search?q=dogs");
        differ("https://site.com/one", "https://site.com/two");
        differ("https://instagram.com/p/AAA", "https://instagram.com/p/BBB");
    }

    #[test]
    fn finds_the_saved_item() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&db).unwrap();
        db.execute("INSERT INTO inspirations (id, type, stored_path, source_url, created_at, updated_at) VALUES ('a','video','x','https://www.youtube.com/watch?v=XYZ',0,0)", []).unwrap();
        assert_eq!(find_by_link(&db, "https://youtu.be/XYZ?si=1").as_deref(), Some("a"));
        assert_eq!(find_by_link(&db, "https://youtu.be/OTHER"), None);
        assert_eq!(find_by_link(&db, "  "), None);
    }
}

#[cfg(test)]
mod url_guard_tests {
    use super::is_web_url;

    #[test]
    fn accepts_web_addresses_only() {
        assert!(is_web_url("https://www.youtube.com/watch?v=abc"));
        assert!(is_web_url("http://i.pinimg.com/originals/a.jpg"));
        assert!(!is_web_url(r"--config-locations=\\server\share\x"));
        assert!(!is_web_url("-o x https://a.com"));
        assert!(!is_web_url("file:///C:/Windows/win.ini"));
        assert!(!is_web_url("https://"));
        assert!(!is_web_url("https:// a.com"));
        assert!(!is_web_url(" https://a.com"));
        assert!(!is_web_url("javascript:alert(1)"));
    }
}

#[cfg(test)]
mod tag_lens_tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    /// A migrated database with two concepts, as an installed lens leaves them.
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&db).unwrap();
        db.execute_batch("
            INSERT INTO concepts (id, lens_id, labels_json, media, vec, active, updated_at) VALUES
              ('green_screen', 'motion', '{\"en\":\"Green screen\",\"uz\":\"Yashil ekran\"}', 'any', x'00', 1, 0),
              ('music_video', 'motion', '{\"en\":\"Music video\",\"uz\":\"Qo\u{2018}shiq klipi\"}', 'video', x'00', 1, 0);
        ").unwrap();
        db
    }
    fn item(db: &Connection, id: &str, kind: &str, title: &str) {
        db.execute("INSERT INTO inspirations (id, type, stored_path, title, created_at, updated_at) VALUES (?1, ?2, 'x', ?3, 0, 0)",
            params![id, kind, title]).unwrap();
    }
    /// A people's tag with a given id: a lens tag stored under the name moves on. (create_tag itself
    /// first lets a lens tag whose label is the name become the people's tag: one name, one tag.)
    fn user_tag(db: &Connection, id: &str, name: &str) {
        crate::tagging::make_room_for_name(db, name).unwrap();
        db.execute("INSERT INTO tags (id, name, source, created_at) VALUES (?1, ?2, 'user', 0)", params![id, name]).unwrap();
    }
    fn stored_name(db: &Connection, tag: &str) -> String {
        db.query_row("SELECT name FROM tags WHERE id = ?1", [tag], |r| r.get(0)).unwrap()
    }
    fn link(db: &Connection, item: &str, tag: &str) {
        db.execute("INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES (?1, ?2)", params![item, tag]).unwrap();
    }
    fn conf(db: &Connection, id: &str) -> serde_json::Map<String, serde_json::Value> {
        let s: Option<String> = db.query_row("SELECT lens_suggestions FROM inspirations WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        s.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    fn search(db: &Connection, q: &str) -> Vec<String> {
        let (cond, args) = search_condition(q);
        let mut stmt = db.prepare(&format!("SELECT id FROM inspirations WHERE {cond} ORDER BY id")).unwrap();
        stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }
    fn count(db: &Connection, tag: &str) -> i64 {
        db.query_row("SELECT count FROM tag_usage_counts WHERE tag_id = ?1", [tag], |r| r.get(0)).unwrap()
    }

    #[test]
    fn search_matches_accepted_tags_only_and_lens_labels_in_both_languages() {
        let db = db();
        item(&db, "a", "image", "");                       // has the green_screen lens tag
        item(&db, "b", "image", "");                       // green_screen only suggested
        item(&db, "c", "image", "");                       // people's tag "Moodboard"
        item(&db, "d", "image", "green screen tutorial");  // title
        item(&db, "e", "video", "");                       // music_video lens tag (Uzbek label with ‘)
        let gs = crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap();
        link(&db, "a", &gs);
        db.execute(r#"UPDATE inspirations SET lens_suggestions = '{"green_screen":0.9,"music_video":0.8}',
                      auto_tag_confidence = '{"green_screen":0.9,"music_video":0.8}' WHERE id = 'b'"#, []).unwrap();
        user_tag(&db, "u1", "Moodboard");
        link(&db, "c", "u1");
        let mv = crate::tagging::ensure_concept_tag(&db, "music_video").unwrap();
        link(&db, "e", &mv);

        assert_eq!(search(&db, "green"), vec!["a", "d"], "pending suggestions never match");
        assert_eq!(search(&db, "Yashil"), vec!["a"], "Uzbek label");
        assert_eq!(search(&db, "ekran"), vec!["a"]);
        assert_eq!(search(&db, "moodboard"), vec!["c"]);
        assert_eq!(search(&db, "music"), vec!["e"]);
        assert_eq!(search(&db, "qo'shiq"), vec!["e"], "an ASCII apostrophe finds o\u{2018}");
        assert_eq!(search(&db, "Qo\u{2018}shiq"), vec!["e"]);
        assert_eq!(search(&db, "\u{2019}"), vec!["e"], "no FTS term: the tag condition alone");
        assert!(search(&db, "lens:").is_empty(), "lens tags never match by their stored name");
        // A lens tag stored as "… (Tag lens)" (another tag has its label as its name) isn't found by
        // that name either.
        db.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('x1', 'music VIDEO', 'extension', 0)", []).unwrap();
        assert_eq!(crate::tagging::name_lens_tags(&db).unwrap(), 1);
        assert_eq!(stored_name(&db, &mv), "Music video (Tag lens)");
        assert!(search(&db, "tag lens").is_empty(), "lens tags never match by their stored name");
        assert_eq!(search(&db, "music"), vec!["e"]);
        // A people's tag made with a lens tag's label is that tag (one name, one tag): found by its
        // labels, and by its own name too, even after a new lens version renames the concept.
        let t = create_tag_with(&db, "GREEN screen".into(), None).unwrap();
        assert_eq!((t.id.as_str(), t.concept_id.as_deref()), (gs.as_str(), Some("green_screen")));
        assert_eq!(search(&db, "green"), vec!["a", "d"]);
        assert_eq!(search(&db, "yashil"), vec!["a"]);
        db.execute(r#"UPDATE concepts SET labels_json = '{"en":"Chroma key","uz":"Xromakey"}' WHERE id = 'green_screen'"#, []).unwrap();
        assert_eq!(search(&db, "chroma"), vec!["a"]);
        assert_eq!(search(&db, "green screen"), vec!["a", "d"], "the people's own name");
        assert!(search(&db, "yashil").is_empty());
        assert_eq!(search(&db, "video"), vec!["e"], "b only has music_video suggested");
    }

    #[test]
    fn a_new_peoples_tag_with_a_lens_tags_name_is_that_tag() {
        // One name, one tag (owner, 2026-11-20). A lens tag is stored under its English label
        // (qooti 1.2.2 shows tags.name as it is), and tag names are UNIQUE. A people's tag made with
        // that name (create_tag, a pack import) is the lens tag, in place: it gets the name exactly
        // as given and the source, and keeps the lens tag's id, concept, items and count. A lens tag
        // only stored under the name (its label changed since) moves on to "<label> (Tag lens)".
        let db = db();
        item(&db, "x", "image", "");
        item(&db, "y", "image", "");
        let gs = crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap();
        let mv = crate::tagging::ensure_concept_tag(&db, "music_video").unwrap();
        link(&db, "x", &gs);
        recount_tags(&db, &[gs.clone()]);
        assert_eq!((stored_name(&db, &gs), stored_name(&db, &mv)), ("Green screen".to_string(), "Music video".to_string()));
        let t = create_tag_with(&db, "green SCREEN".into(), None).unwrap();
        assert_eq!((t.id.as_str(), t.name.as_str(), t.source.as_str(), t.concept_id.as_deref(), t.usage_count),
                   (gs.as_str(), "green SCREEN", "user", Some("green_screen"), 1), "the lens tag, with its item");
        assert_eq!(t.labels.map(|l| l.en), Some("Green screen".to_string()), "it carries its concept's labels; the page shows its own name");
        // A second people's tag with that name is a tag of its own (two people's tags with one name
        // stay apart from each other and from lens tags)
        let t2 = create_tag_with(&db, "Green Screen".into(), Some("import".into())).unwrap();
        assert!(t2.id != gs && t2.concept_id.is_none());
        assert_eq!(stored_name(&db, &gs), "green SCREEN", "a people's tag never moves on, also one that stands for a concept");
        // A pack's people's tag named like a lens tag's label: the lens tag becomes it, with the
        // item linked; the next pack with that name links the same tag
        let links = import_pack_tags(&db, "y", &json!({ "tags": ["Music video"], "tag_sources": { "Music video": "user" } }), 5);
        assert_eq!(links.tag_ids, vec![mv.clone()]);
        recount_tags(&db, &links.tag_ids);
        assert_eq!(item_tags(&db, "y"), vec![("Music video".to_string(), "user".to_string(), Some("music_video".to_string()), 1)]);
        let again = import_pack_tags(&db, "x", &json!({ "tags": ["music VIDEO"] }), 6);
        assert_eq!(again.tag_ids, vec![mv.clone()], "found by name, any case");
        // A lens tag only stored under the name (its label was "Rotoscope" when it was named, and a
        // new lens version changed it) moves on instead: "rotoscope" isn't its label
        db.execute(r#"INSERT INTO concepts (id, lens_id, labels_json, media, vec, active, updated_at)
                      VALUES ('chroma', 'motion', '{"en":"Chroma key","uz":"Xromakey"}', 'any', x'00', 1, 0)"#, []).unwrap();
        let ck = crate::tagging::ensure_concept_tag(&db, "chroma").unwrap();
        db.execute("UPDATE tags SET name = 'Rotoscope' WHERE id = ?1", [&ck]).unwrap();
        let t3 = create_tag_with(&db, "rotoscope".into(), None).unwrap();
        assert!(t3.id != ck && t3.concept_id.is_none());
        assert_eq!(stored_name(&db, &ck), "Chroma key");
        // A name that reads as an id is refused
        assert!(create_tag_with(&db, "lens:green_screen".into(), None).is_err());
        assert!(create_tag_with(&db, " LENS:x".into(), None).is_err());
        // One tag per concept, and the next start keeps every name
        let lens: Vec<String> = db.prepare("SELECT id || '|' || concept_id FROM tags WHERE concept_id IS NOT NULL ORDER BY concept_id").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(lens, vec![format!("{ck}|chroma"), format!("{gs}|green_screen"), format!("{mv}|music_video")]);
        assert_eq!(crate::tagging::join_same_name_tags(&db).unwrap().joined, 0);
        assert_eq!(crate::tagging::name_lens_tags(&db).unwrap(), 0);
        let names: Vec<String> = db.prepare("SELECT name FROM tags").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert!(names.iter().all(|n| !n.contains('_') && !n.to_lowercase().starts_with("lens:") && !n.contains("(Tag lens")), "{names:?}");
    }

    #[test]
    fn collection_hints_add_their_key_and_leave_the_rest_alone() {
        let db = db();
        db.execute("INSERT INTO collections (id, name, created_at, updated_at) VALUES ('col', 'Client', 0, 0)", []).unwrap();
        for (id, kind) in [("a", "image"), ("b", "image"), ("c", "image"), ("d", "image"), ("e", "image"),
                           ("f", "image"), ("g", "image"), ("v", "video"), ("w", "video"), ("x", "video"), ("z", "video")] {
            item(&db, id, kind, "");
            db.execute("INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES ('col', ?1, 0)", [id]).unwrap();
        }
        db.execute("UPDATE inspirations SET duration_secs = 120 WHERE id = 'v'", []).unwrap();   // over the limit
        db.execute("UPDATE inspirations SET duration_secs = 20 WHERE id = 'w'", []).unwrap();
        // x: length not known (yet, or ever); z: a length of 0 is no length either (C8)
        db.execute("UPDATE inspirations SET duration_secs = 0 WHERE id = 'z'", []).unwrap();
        user_tag(&db, "u1", "clientx");
        user_tag(&db, "u2", "other");
        for id in ["a", "b", "c"] { link(&db, id, "u1"); }   // 3 of the 4 items with people's tags
        link(&db, "e", "u2");                                // has a people's tag: not asked
        let gs = crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap();
        for id in ["a", "b", "c", "d"] { link(&db, id, &gs); }   // lens tags are never hinted
        db.execute(r#"UPDATE inspirations SET lens_suggestions = '{"green_screen":0.7,"col:old":0.5}',
                      auto_tag_confidence = '{"web_design":0.4}' WHERE id = 'f'"#, []).unwrap();
        db.execute("INSERT INTO tag_answers (inspiration_id, concept_id, answer, answered_at) VALUES ('g', 'col:u1', 'dismissed', 0)", []).unwrap();

        assert!(apply_collection_hints(&db).unwrap().is_empty(), "nothing while tag suggestions are off");
        db.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES ('tag_recommendations_enabled', 'true')", []).unwrap();
        // The ids come back for `autotag:scored` (C5)
        assert_eq!(apply_collection_hints(&db).unwrap(), vec!["d", "f", "w"]);
        for id in ["x", "z"] {
            assert!(conf(&db, id).is_empty(), "a video of unknown length got a hint: {id}");
        }
        let f = conf(&db, "f");
        assert_eq!(f.len(), 3, "{f:?}");
        assert_eq!(f.get("green_screen").and_then(|v| v.as_f64()), Some(0.7), "other keys untouched");
        assert_eq!(f.get("col:old").and_then(|v| v.as_f64()), Some(0.5));
        assert_eq!(f.get("col:u1").and_then(|v| v.as_f64()), Some(0.75));
        assert_eq!(conf(&db, "d").keys().collect::<Vec<_>>(), vec!["col:u1"], "a lens tag doesn't count as tagged");
        assert!(conf(&db, "w").contains_key("col:u1"));
        for id in ["a", "b", "c", "e", "g", "v"] {
            assert!(!conf(&db, id).contains_key("col:u1"), "{id}");
        }
        let gs_key = format!("col:{gs}");
        for id in ["a", "b", "c", "d", "e", "f", "g", "v", "w"] {
            assert!(!conf(&db, id).contains_key(&gs_key), "lens tag hinted on {id}");
        }
        assert!(apply_collection_hints(&db).unwrap().is_empty(), "nothing new the second time");
        let old: Vec<Option<String>> = db.prepare("SELECT auto_tag_confidence FROM inspirations ORDER BY id").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(old.iter().flatten().collect::<Vec<_>>(), vec![r#"{"web_design":0.4}"#], "the old column is never written");
        // Once x's length is measured and short, the next run hints it
        db.execute("UPDATE inspirations SET duration_secs = 12.5 WHERE id = 'x'", []).unwrap();
        assert_eq!(apply_collection_hints(&db).unwrap(), vec!["x"]);
    }

    #[test]
    fn linking_a_lens_tag_answers_it_and_a_hint_leaves_with_its_tag() {
        let db = db();
        item(&db, "a", "image", "");
        let gs = crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap();
        user_tag(&db, "u1", "Moodboard");
        db.execute(r#"UPDATE inspirations SET auto_tag_status = 'done',
                      lens_suggestions = '{"green_screen":0.9,"col:u1":0.8,"music_video":0.4}' WHERE id = 'a'"#, []).unwrap();
        tag_item(&db, "a", &gs).unwrap();
        let answer: String = db.query_row(
            "SELECT answer FROM tag_answers WHERE inspiration_id = 'a' AND concept_id = 'green_screen'", [], |r| r.get(0)).unwrap();
        assert_eq!(answer, "added");
        assert!(!conf(&db, "a").contains_key("green_screen"));
        tag_item(&db, "a", "u1").unwrap();
        tag_item(&db, "a", "u1").unwrap();
        assert_eq!(conf(&db, "a").keys().collect::<Vec<_>>(), vec!["music_video"]);
        assert_eq!((count(&db, &gs), count(&db, "u1")), (1, 1), "counted once");
        let status: String = db.query_row("SELECT auto_tag_status FROM inspirations WHERE id = 'a'", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "done");
        assert!(tag_item(&db, "a", "no-such-tag").is_err());
    }

    #[test]
    fn a_tag_linked_later_drops_the_questions_that_ask_its_name() {
        // Spec §0b.2 when a tag is linked, not only when scores are written (final review R2,
        // WT1): a card never asks a name its item already has, and Add never gives it twice.
        let db = db();
        for id in ["a", "b", "c", "d"] { item(&db, id, "image", ""); }
        user_tag(&db, "u_gs", "  green SCREEN ");   // green_screen's English label: other case, spaces
        user_tag(&db, "u_mv", "qo'shiq klipi");     // music_video's Uzbek label, typed with a plain '
        user_tag(&db, "u_mb", "Moodboard");
        let set = |id: &str, json: &str| {
            db.execute("UPDATE inspirations SET lens_suggestions = ?2, auto_tag_status = 'done', auto_tag_model = 'lens-1',
                        auto_tag_sig = 's' WHERE id = ?1", params![id, json]).unwrap();
        };
        let keys = |id: &str| -> Vec<String> { let mut k: Vec<String> = conf(&db, id).keys().cloned().collect(); k.sort(); k };
        let tags = |id: &str| -> Vec<String> { let mut t: Vec<String> = item_tags(&db, id).into_iter().map(|t| t.0).collect(); t.sort(); t };

        // 1. The detail picker links a people's tag: the lens question with its name goes, the rest stays.
        set("a", r#"{"green_screen":0.9,"music_video":0.5,"col:u_mb":0.7}"#);
        tag_item(&db, "a", "u_gs").unwrap();
        assert_eq!(keys("a"), vec!["col:u_mb", "music_video"]);
        tag_item(&db, "a", "u_mv").unwrap();
        assert_eq!(keys("a"), vec!["col:u_mb"]);
        // A card read before that still asks "Green screen": Add links nothing (null), the key goes.
        set("a", r#"{"green_screen":0.9}"#);
        assert_eq!(crate::tagging::answer_with(&db, "a", "green_screen", "added").unwrap(), None);
        assert!(keys("a").is_empty());
        assert_eq!(tags("a"), vec!["  green SCREEN ", "qo'shiq klipi"]);

        // 2. Adding a collection hint for a people's tag does the same.
        set("b", r#"{"green_screen":0.9,"music_video":0.5,"col:u_gs":0.8}"#);
        let t = crate::tagging::answer_with(&db, "b", "col:u_gs", "added").unwrap().unwrap();
        assert_eq!(t.id, "u_gs");
        assert_eq!(keys("b"), vec!["music_video"]);

        // 3. Adding a lens question whose label a people's tag has as its name links that tag (one
        //    name, one tag): it stands for the concept from now on, so its hints leave every item…
        set("c", r#"{"green_screen":0.9,"col:u_gs":0.8,"col:u_mb":0.7}"#);
        let t = crate::tagging::answer_with(&db, "c", "green_screen", "added").unwrap().unwrap();
        assert_eq!((t.id.as_str(), t.concept_id.as_deref()), ("u_gs", Some("green_screen")));
        assert_eq!(keys("c"), vec!["col:u_mb"]);
        // …and a card read before that: Add on the hint links the tag the item already has.
        set("c", r#"{"col:u_gs":0.8}"#);
        assert_eq!(crate::tagging::answer_with(&db, "c", "col:u_gs", "added").unwrap().map(|t| t.id), Some("u_gs".to_string()));
        assert!(keys("c").is_empty());
        assert_eq!(tags("c"), vec!["  green SCREEN "], "one tag, the people's own name");

        // 4. The picker's lens path (tag_item with a lens tag) drops the hint named like it too.
        set("d", r#"{"col:u_mv":0.8,"green_screen":0.4}"#);
        let mv = crate::tagging::ensure_concept_tag(&db, "music_video").unwrap();
        tag_item(&db, "d", &mv).unwrap();
        assert_eq!(keys("d"), vec!["green_screen"]);

        // Only real adds are kept as answers; status, model and signature never change.
        let answers: Vec<(String, String)> = db.prepare(
            "SELECT inspiration_id, concept_id FROM tag_answers WHERE answer = 'added' ORDER BY inspiration_id, concept_id").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(answers, vec![("b".into(), "col:u_gs".into()), ("c".into(), "col:u_gs".into()), ("c".into(), "green_screen".into()),
                                 ("d".into(), "music_video".into())]);
        let untouched: i64 = db.query_row("SELECT COUNT(*) FROM inspirations WHERE auto_tag_status = 'done'
                                            AND auto_tag_model = 'lens-1' AND auto_tag_sig = 's'", [], |r| r.get(0)).unwrap();
        assert_eq!(untouched, 4);
        assert_eq!((count(&db, "u_gs"), count(&db, "u_mv")), (3, 1));
    }

    #[test]
    fn a_scored_lens_question_goes_when_its_people_tag_is_picked() {
        // Review R2's case with real scores: the item was scored with d_one ("L d one"); then
        // the person picks their own tag " l D ONE ". Nothing re-scores the item afterwards.
        use crate::lenses::testkit::{install_texts, standard_texts};
        let db = db();
        install_texts(&db, &standard_texts(1)).unwrap();
        let cat = crate::lenses::Catalogue::load(&db);
        let d_one = cat.lenses.iter().flat_map(|l| l.concepts.iter()).find(|c| c.id == "d_one").unwrap().vec.clone();
        item(&db, "x", "image", "");
        let blob: Vec<u8> = d_one.iter().flat_map(|v| v.to_le_bytes()).collect();
        db.execute("INSERT INTO clip_embeddings (id, model, emb) VALUES ('x', ?1, ?2)", params![crate::clip::MODEL_TAG, blob]).unwrap();
        crate::tagging::score_chunk(&db, &cat, &["x".to_string()]).unwrap();
        assert!(conf(&db, "x").contains_key("d_one"));
        user_tag(&db, "mine", " l D ONE ");
        tag_item(&db, "x", "mine").unwrap();
        assert!(!conf(&db, "x").contains_key("d_one"), "{:?}", conf(&db, "x"));
    }

    #[test]
    fn a_collection_hint_never_asks_a_name_the_item_has_as_a_lens_tag() {
        let db = db();
        db.execute("INSERT INTO collections (id, name, created_at, updated_at) VALUES ('col', 'Client', 0, 0)", []).unwrap();
        for id in ["a", "b", "c", "x", "y"] {
            item(&db, id, "image", "");
            db.execute("INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES ('col', ?1, 0)", [id]).unwrap();
        }
        db.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES ('tag_recommendations_enabled', 'true')", []).unwrap();
        // A people's tag with green_screen's Uzbek label stays a tag of its own (one name, one tag
        // goes by the English label, the name lens tags are stored under)
        user_tag(&db, "u_gs", "Yashil Ekran");
        for id in ["a", "b", "c"] { link(&db, id, "u_gs"); }
        let gs = crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap();
        assert_ne!(gs, "u_gs");
        link(&db, "x", &gs);   // x has the lens tag "Yashil ekran": asking "Yashil Ekran" would be the same name
        assert_eq!(apply_collection_hints(&db).unwrap(), vec!["y"]);
        assert!(conf(&db, "x").is_empty(), "{:?}", conf(&db, "x"));
        // With the English label it is the lens tag itself: one tag, hinted by the lenses, not by
        // the collection
        let db = self::db();
        db.execute("INSERT INTO collections (id, name, created_at, updated_at) VALUES ('col', 'Client', 0, 0)", []).unwrap();
        for id in ["a", "b", "c", "y"] {
            item(&db, id, "image", "");
            db.execute("INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES ('col', ?1, 0)", [id]).unwrap();
        }
        db.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES ('tag_recommendations_enabled', 'true')", []).unwrap();
        user_tag(&db, "u_gs", "Green Screen");
        for id in ["a", "b", "c"] { link(&db, id, "u_gs"); }
        assert_eq!(apply_collection_hints(&db).unwrap(), vec!["y"]);
        assert_eq!(crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap(), "u_gs");
        assert!(conf(&db, "y").is_empty(), "its hint went: {:?}", conf(&db, "y"));
        assert!(apply_collection_hints(&db).unwrap().is_empty());
    }

    #[test]
    fn packs_carry_lens_tags_by_concept_and_drop_old_suggestion_tags() {
        // Export side: a lens tag goes out under its English label, plus tag_concepts.
        let src = db();
        item(&src, "a", "image", "");
        let gs = crate::tagging::ensure_concept_tag(&src, "green_screen").unwrap();
        link(&src, "a", &gs);
        user_tag(&src, "u1", "Moodboard");
        link(&src, "a", "u1");
        src.execute("INSERT INTO tags (id, name, source, created_at) VALUES ('m1', 'sunset', 'model', 0)", []).unwrap();
        link(&src, "a", "m1");
        let tags = pack_tags(&src, None).unwrap();
        let a = &tags["a"];
        assert_eq!(a.names, vec!["Green screen", "Moodboard", "sunset"]);
        assert_eq!(serde_json::Value::Object(a.concepts.clone()), json!({ "Green screen": "green_screen" }));
        assert!(pack_tags(&src, Some("no-such-collection")).unwrap().is_empty());
        item(&src, "b", "image", "");
        let bare = crate::tagging::ensure_concept_tag(&src, "web_design_x").unwrap();   // no concepts row
        link(&src, "b", &bare);
        assert_eq!(pack_tags(&src, None).unwrap()["b"].names, vec!["web design x"], "never lens:<id>");
        let ex = pack_extras(&src, "a").unwrap();
        assert_eq!(serde_json::Value::Object(ex.tag_sources.clone()),
                   json!({ "Green screen": "lens", "Moodboard": "user", "sunset": "model" }));

        // Import side: a computer that has green_screen but not rotoscope.
        let dst = db();
        item(&dst, "x", "image", "");
        user_tag(&dst, "local", "moodboard");
        let meta = json!({
            "tags": ["Green screen", "Moodboard", "sunset", "Rotoscope", "lens:green_screen", "Fresh", "", "  "],
            "tag_concepts": { "Green screen": "green_screen", "Rotoscope": "rotoscope" },
            "tag_sources": { "Green screen": "lens", "Moodboard": "user", "sunset": "model", "Rotoscope": "lens", "Fresh": "user" },
        });
        let links = import_pack_tags(&dst, "x", &meta, 5);
        assert_eq!(links.waiting, 1, "Rotoscope waits for its lens");
        recount_tags(&dst, &links.tag_ids);
        let mut got = item_tags(&dst, "x");
        got.sort();
        assert_eq!(got, vec![
            ("Fresh".to_string(), "user".to_string(), None, 1),
            ("Green screen".to_string(), "lens".to_string(), Some("green_screen".to_string()), 1),
            // A concept this computer doesn't have is kept, not dropped (rust-data D1)
            ("Rotoscope".to_string(), "lens".to_string(), Some("rotoscope".to_string()), 1),
            ("moodboard".to_string(), "user".to_string(), None, 1),   // the existing tag, not a copy
        ]);
        // ...through a placeholder concept: the pack's name in both languages, no lens, inactive
        let placeholder: (String, String, String, i64, Vec<u8>) = dst.query_row(
            "SELECT lens_id, labels_json, media, active, vec FROM concepts WHERE id = 'rotoscope'", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap();
        assert_eq!(placeholder.0, "");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&placeholder.1).unwrap(), json!({ "en": "Rotoscope", "uz": "Rotoscope" }));
        assert_eq!((placeholder.2.as_str(), placeholder.3, placeholder.4.len()), ("any", 0, 0));
        let roto = crate::tagging::ensure_concept_tag(&dst, "rotoscope").unwrap();
        assert_eq!(crate::tagging::load_tag(&dst, &roto).unwrap().unwrap().labels.unwrap().en, "Rotoscope");
        assert_eq!(search(&dst, "rotoscope"), vec!["x"], "searchable by its label");
        let made: i64 = dst.query_row("SELECT COUNT(*) FROM tags WHERE (name IN ('sunset', 'Rotoscope') AND concept_id IS NULL) OR source = 'model'", [], |r| r.get(0)).unwrap();
        assert_eq!(made, 0, "no suggestion tags, and the kept lens tag is a lens tag, not a plain one");
        // A second import of the same item links the same tags without new ones.
        let again = import_pack_tags(&dst, "x", &meta, 6);
        assert_eq!(again.tag_ids.len(), 4);
        let n: i64 = dst.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4);
        let n: i64 = dst.query_row("SELECT COUNT(*) FROM concepts WHERE lens_id = ''", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "one placeholder per concept");

        // The lens with rotoscope arrives later: install fills in the real concept (labels,
        // vector, active), and the item's tag now follows the app's language.
        use crate::lenses::testkit::{install_texts, lens_text, tc, unit};
        install_texts(&dst, &[
            lens_text("design", "base", 1, &[tc("d_one", unit(1)), tc("d_two", unit(2))], &[]),
            lens_text("motion", "specialist", 1, &[tc("rotoscope", unit(3)), tc("m_two", unit(4))], &[]),
        ]).unwrap();
        let real: (String, i64, usize) = dst.query_row(
            "SELECT c.lens_id, c.active, length(e.vec) FROM concepts c JOIN concept_entries e ON e.concept_id = c.id AND e.lens_id = c.lens_id WHERE c.id = 'rotoscope'", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((real.0.as_str(), real.1), ("motion", 1));
        assert!(real.2 > 0, "the real vector");
        let tag = crate::tagging::load_tag(&dst, &roto).unwrap().unwrap();
        assert_eq!(tag.labels.map(|l| (l.en, l.uz)), Some(("L rotoscope".to_string(), "U rotoscope".to_string())));
        assert!(item_tags(&dst, "x").iter().any(|t| t.2.as_deref() == Some("rotoscope")), "still on the item");
        // The next start stores it under its new English label (what older versions show)
        assert_eq!(stored_name(&dst, &roto), "Rotoscope");
        assert_eq!(crate::tagging::name_lens_tags(&dst).unwrap(), 1);
        assert_eq!(stored_name(&dst, &roto), "L rotoscope");
        // And the next pack with rotoscope doesn't wait any more
        assert_eq!(import_pack_tags(&dst, "x", &meta, 7).waiting, 0);
    }

    /// (name, source, concept_id, count) of an item's tags.
    fn item_tags(db: &Connection, id: &str) -> Vec<(String, String, Option<String>, i64)> {
        db.prepare(
            "SELECT t.name, t.source, t.concept_id, u.count FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id
             LEFT JOIN tag_usage_counts u ON u.tag_id = t.id WHERE it.inspiration_id = ?1").unwrap()
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect()
    }

    /// A manifest entry's tags as export writes them, read back through JSON text as in a real pack.
    fn entry_tags(db: &Connection, id: &str) -> serde_json::Value {
        let mut entry = json!({ "id": id });
        pack_put_tags(&mut entry, pack_tags(db, None).unwrap().remove(id).unwrap_or_default());
        if let Some(ex) = pack_extras(db, id) { pack_attach_extras(&mut entry, id, &ex, &mut Vec::new()); }
        serde_json::from_str(&entry.to_string()).unwrap()
    }

    #[test]
    fn a_people_tag_and_a_lens_tag_with_the_same_name_both_travel() {
        // Export side: b has the people's tag "Green screen" and the lens tag whose English
        // label is "Green screen" (two tags until the next start joins them, or for good when they
        // can't be one: tagging.rs, one name, one tag); c has two lens tags with one English label.
        let src = db();
        src.execute("INSERT INTO concepts (id, lens_id, labels_json, media, vec, active, updated_at)
                     VALUES ('green_screen_old', 'motion', '{\"en\":\"Green screen\",\"uz\":\"Eski yashil ekran\"}', 'any', x'00', 0, 0)", []).unwrap();
        item(&src, "b", "image", "");
        item(&src, "c", "image", "");
        let gs = crate::tagging::ensure_concept_tag(&src, "green_screen").unwrap();
        let old = crate::tagging::ensure_concept_tag(&src, "green_screen_old").unwrap();
        user_tag(&src, "u1", "Green screen");
        for (i, t) in [("b", "u1"), ("b", gs.as_str()), ("c", gs.as_str()), ("c", old.as_str())] { link(&src, i, t); }

        let b = entry_tags(&src, "b");
        assert_eq!(b["tags"], json!(["Green screen"]));
        assert!(b.get("tag_concepts").is_none(), "{b}");
        assert_eq!(b["extra_concepts"], json!(["green_screen"]));
        assert_eq!(b["tag_sources"], json!({ "Green screen": "user" }), "the name keeps the people's tag's source");
        let c = entry_tags(&src, "c");
        assert_eq!(c["tags"], json!(["Green screen"]));
        let mut both: Vec<String> = c["tag_concepts"].as_object().unwrap().values()
            .chain(c["extra_concepts"].as_array().unwrap()).map(|v| v.as_str().unwrap().to_string()).collect();
        both.sort();
        assert_eq!(both, vec!["green_screen", "green_screen_old"]);

        // Import side (has green_screen, not green_screen_old): b's two arrive as one tag (one name,
        // one tag): the people's tag "Green screen", which stands for green_screen; both of c.
        let dst = db();
        item(&dst, "y", "image", "");
        item(&dst, "z", "image", "");
        let yl = import_pack_tags(&dst, "y", &b, 5);
        let zl = import_pack_tags(&dst, "z", &c, 5);
        recount_tags(&dst, &[yl.tag_ids, zl.tag_ids].concat());
        let y = item_tags(&dst, "y");
        assert_eq!(y, vec![("Green screen".to_string(), "user".to_string(), Some("green_screen".to_string()), 2)]);
        let mut z: Vec<Option<String>> = item_tags(&dst, "z").into_iter().map(|t| t.2).collect();
        z.sort();
        assert_eq!(z, vec![Some("green_screen".to_string()), Some("green_screen_old".to_string())]);
        assert_eq!(zl.waiting, 1);

        // An older app ignores extra_concepts: it still imports the people's tag.
        let older = db();
        item(&older, "y", "image", "");
        let mut b_old = b.clone();
        b_old.as_object_mut().unwrap().remove("extra_concepts");
        recount_tags(&older, &import_pack_tags(&older, "y", &b_old, 5).tag_ids);
        assert_eq!(item_tags(&older, "y").into_iter().map(|t| (t.0, t.1)).collect::<Vec<_>>(),
                   vec![("Green screen".to_string(), "user".to_string())]);
    }

    #[test]
    fn a_peoples_tag_that_stands_for_a_concept_travels_as_its_own() {
        // DS-ON-2: the owner's own "ui" became ui_design's tag (one name, one tag). A pack carries it
        // as the person's tag, by its own name and source with its concept, never as a lens tag
        // named by the label. It arrives as that people's tag, standing for the concept: in a
        // library with the lens (also one where the lens tag already is), after Settings › Reset,
        // and in a library without the lens (a placeholder concept), where it is never swept with
        // its last item. A relabel never changes the name it travels by.
        let ui_concept = "INSERT INTO concepts (id, lens_id, labels_json, media, vec, active, updated_at)
                          VALUES ('ui_design', 'design', '{\"en\":\"UI\",\"uz\":\"UI\"}', 'any', x'00', 1, 0)";
        let src = db();
        src.execute(ui_concept, []).unwrap();
        for id in ["a", "b"] { item(&src, id, "image", ""); }
        src.execute_batch("
            INSERT INTO tags (id, name, source, created_at) VALUES ('mine', 'ui', 'user', 0);
            INSERT INTO tags (id, name, source, created_at, concept_id) VALUES ('lt', 'UI (Tag lens)', 'lens', 1, 'ui_design');").unwrap();
        link(&src, "a", "mine");
        link(&src, "b", "lt");
        src.execute_batch(crate::db::RECOUNT_ALL_TAGS).unwrap();
        assert_eq!(crate::tagging::join_same_name_tags(&src).unwrap().joined, 1);
        let a = entry_tags(&src, "a");
        assert_eq!(a["tags"], json!(["ui"]));
        assert_eq!(a["tag_sources"], json!({ "ui": "user" }));
        assert_eq!(a["tag_concepts"], json!({ "ui": "ui_design" }));
        assert!(a.get("extra_concepts").is_none(), "{a}");
        let mine = |conn: &Connection, id: &str| -> Vec<(String, String, Option<String>)> {
            item_tags(conn, id).into_iter().map(|t| (t.0, t.1, t.2)).collect()
        };
        let want = vec![("ui".to_string(), "user".to_string(), Some("ui_design".to_string()))];
        // A library with the lens: the people's tag "ui", standing for ui_design
        let dst = db();
        dst.execute(ui_concept, []).unwrap();
        item(&dst, "x", "image", "");
        let l = import_pack_tags(&dst, "x", &a, 5);
        assert_eq!(l.waiting, 0);
        recount_tags(&dst, &l.tag_ids);
        assert_eq!(mine(&dst, "x"), want);
        // ...also where its lens tag already is: that tag becomes the people's tag, in place
        let dst2 = db();
        dst2.execute(ui_concept, []).unwrap();
        for id in ["x", "w"] { item(&dst2, id, "image", ""); }
        let lt2 = crate::tagging::ensure_concept_tag(&dst2, "ui_design").unwrap();
        link(&dst2, "w", &lt2);
        let l2 = import_pack_tags(&dst2, "x", &a, 5);
        recount_tags(&dst2, &l2.tag_ids);
        assert_eq!(mine(&dst2, "x"), want);
        assert_eq!(item_tags(&dst2, "w"), vec![("ui".to_string(), "user".to_string(), Some("ui_design".to_string()), 2)], "one tag");
        // Restored after Settings › Reset (the concepts stay, the tags go)
        src.execute_batch("DELETE FROM tag_answers; DELETE FROM inspirations; DELETE FROM tags;").unwrap();
        item(&src, "a", "image", "");
        recount_tags(&src, &import_pack_tags(&src, "a", &a, 6).tag_ids);
        assert_eq!(mine(&src, "a"), want);
        // A library without the lens: a placeholder concept named like the tag, waiting for its lens
        let bare = db();
        item(&bare, "x", "image", "");
        let l3 = import_pack_tags(&bare, "x", &a, 7);
        assert_eq!(l3.waiting, 1);
        recount_tags(&bare, &l3.tag_ids);
        assert_eq!(mine(&bare, "x"), want);
        // Deleting its last item there never sweeps it: it is a people's tag
        let tag_id: String = bare.query_row("SELECT tag_id FROM inspiration_tags WHERE inspiration_id = 'x'", [], |r| r.get(0)).unwrap();
        delete_item_row(&bare, "x").unwrap();
        tidy_tags_after_delete(&bare, &[tag_id.clone()]);
        assert_eq!(bare.query_row("SELECT COUNT(*) FROM tags WHERE id = ?1", [&tag_id], |r| r.get::<_, i64>(0)).unwrap(), 1);
        // Where its name stands for another concept: the people's tag keeps that one, and the pack's
        // concept comes with its own tag (kept apart)
        let other = db();
        other.execute(ui_concept, []).unwrap();
        item(&other, "x", "image", "");
        other.execute("INSERT INTO tags (id, name, source, created_at, concept_id) VALUES ('p', 'UI', 'user', 0, 'green_screen')", []).unwrap();
        recount_tags(&other, &import_pack_tags(&other, "x", &a, 8).tag_ids);
        let mut got = mine(&other, "x");
        got.sort();
        assert_eq!(got, vec![("UI".to_string(), "user".to_string(), Some("green_screen".to_string())),
                             ("UI (Tag lens)".to_string(), "lens".to_string(), Some("ui_design".to_string()))]);
        // After a relabel on the exporting side, it still travels by its own name
        src.execute(r#"UPDATE concepts SET labels_json = '{"en":"Interface","uz":"Interfeys"}' WHERE id = 'ui_design'"#, []).unwrap();
        assert_eq!(entry_tags(&src, "a")["tags"], json!(["ui"]));
        // An app that knows no tag_concepts (qooti 1.2.2) still makes the people's tag
        let older = db();
        item(&older, "y", "image", "");
        let mut a_old = a.clone();
        a_old.as_object_mut().unwrap().remove("tag_concepts");
        recount_tags(&older, &import_pack_tags(&older, "y", &a_old, 5).tag_ids);
        assert_eq!(mine(&older, "y"), vec![("ui".to_string(), "user".to_string(), None)]);
    }

    #[test]
    fn deleting_an_item_keeps_peoples_tags_and_drops_only_its_unused_lens_tags() {
        let db = db();
        for id in ["a", "b"] { item(&db, id, "image", ""); }
        user_tag(&db, "moodboard", "moodboard");   // on no item (its last link was removed before)
        user_tag(&db, "client", "client");         // only on a
        user_tag(&db, "shared", "shared");         // on a and b
        db.execute("UPDATE tags SET source = 'import' WHERE id = 'client'", []).unwrap();
        let gs = crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap();   // only on a
        let mv = crate::tagging::ensure_concept_tag(&db, "music_video").unwrap();    // on a and b
        let idle = crate::tagging::ensure_concept_tag(&db, "rotoscope").unwrap();    // on no item, not a's
        for (i, t) in [("a", "client"), ("a", "shared"), ("b", "shared"), ("a", gs.as_str()), ("a", mv.as_str()), ("b", mv.as_str())] {
            link(&db, i, t);
        }
        db.execute_batch(crate::db::RECOUNT_ALL_TAGS).unwrap();

        delete_item_row(&db, "a").unwrap();

        let tags: HashSet<String> = db.prepare("SELECT id FROM tags").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        for kept in ["moodboard", "client", "shared", mv.as_str(), idle.as_str()] {
            assert!(tags.contains(kept), "{kept} was removed");
        }
        assert!(!tags.contains(&gs), "a's lens tag that no item has any more goes");
        assert_eq!((count(&db, "client"), count(&db, "shared"), count(&db, &mv)), (0, 1, 1));
        let left: i64 = db.query_row("SELECT COUNT(*) FROM tag_usage_counts WHERE tag_id = ?1", [&gs], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        assert!(load_inspiration(&db, "a").is_err(), "the item is gone");
        // The lens tag comes back whenever it's needed
        item(&db, "c", "image", "");
        crate::tagging::answer_with(&db, "c", "green_screen", "added").unwrap();
        assert_eq!(item_tags(&db, "c")[0].2.as_deref(), Some("green_screen"));
    }

    #[test]
    fn deleting_a_collection_with_its_items_sets_the_counts_of_their_tags() {
        let db = db();
        db.execute("INSERT INTO collections (id, name, created_at, updated_at) VALUES ('col', 'Client', 0, 0)", []).unwrap();
        for id in ["x", "y", "z"] { item(&db, id, "image", ""); }
        for id in ["x", "y"] {
            db.execute("INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES ('col', ?1, 0)", [id]).unwrap();
        }
        user_tag(&db, "p", "poster");   // x and z (z isn't in the collection)
        user_tag(&db, "q", "quiet");    // only y
        let gs = crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap();   // x and y
        for (i, t) in [("x", "p"), ("z", "p"), ("y", "q"), ("x", gs.as_str()), ("y", gs.as_str())] { link(&db, i, t); }
        db.execute_batch(crate::db::RECOUNT_ALL_TAGS).unwrap();

        delete_collection_item_rows(&db, "col").unwrap();

        assert_eq!((count(&db, "p"), count(&db, "q")), (1, 0), "counts follow the links that are left");
        let gone: i64 = db.query_row("SELECT COUNT(*) FROM tags WHERE id = ?1", [&gs], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0, "the lens tag no item has any more goes");
        let items: i64 = db.query_row("SELECT COUNT(*) FROM inspirations", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 1, "only z is left");
    }

    #[test]
    fn removing_a_tag_twice_counts_it_once() {
        let db = db();
        for id in ["a", "b", "c"] { item(&db, id, "image", ""); }
        user_tag(&db, "u1", "moodboard");
        tag_item(&db, "a", "u1").unwrap();
        tag_item(&db, "b", "u1").unwrap();
        assert_eq!(count(&db, "u1"), 2);
        // A double click on × sends the same untag twice
        untag_item(&db, "a", "u1").unwrap();
        untag_item(&db, "a", "u1").unwrap();
        assert_eq!(count(&db, "u1"), 1, "b still has it");
        // The same for a lens tag
        let gs = crate::tagging::ensure_concept_tag(&db, "green_screen").unwrap();
        tag_item(&db, "a", &gs).unwrap();
        tag_item(&db, "b", &gs).unwrap();
        untag_item(&db, "b", &gs).unwrap();
        untag_item(&db, "b", &gs).unwrap();
        assert_eq!(count(&db, &gs), 1);
        // A count that was already wrong is healed by the next change
        db.execute("UPDATE tag_usage_counts SET count = 9 WHERE tag_id = 'u1'", []).unwrap();
        tag_item(&db, "c", "u1").unwrap();
        assert_eq!(count(&db, "u1"), 2);
        db.execute("UPDATE tag_usage_counts SET count = 0 WHERE tag_id = 'u1'", []).unwrap();
        untag_item(&db, "a", "u1").unwrap();   // a doesn't have it any more: nothing to remove
        assert_eq!(count(&db, "u1"), 2);
        // An unknown tag is no error and makes no count
        untag_item(&db, "a", "no-such-tag").unwrap();
        let n: i64 = db.query_row("SELECT COUNT(*) FROM tag_usage_counts WHERE tag_id = 'no-such-tag'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        // The tag stays even when no item has it
        untag_item(&db, "b", "u1").unwrap();
        untag_item(&db, "c", "u1").unwrap();
        assert_eq!(count(&db, "u1"), 0);
    }

    #[test]
    fn items_carry_their_scoring_signature() {
        let db = db();
        item(&db, "a", "image", "");
        item(&db, "b", "image", "");
        db.execute("UPDATE inspirations SET auto_tag_sig = 'abc123' WHERE id = 'a'", []).unwrap();
        assert_eq!(load_inspiration(&db, "a").unwrap().auto_tag_sig.as_deref(), Some("abc123"));
        assert_eq!(load_inspiration(&db, "b").unwrap().auto_tag_sig, None, "not scored yet");
        let rows: Vec<Inspiration> = db.prepare(&format!("{INSP_SELECT} ORDER BY id")).unwrap()
            .query_map([], row_to_inspiration).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(rows.iter().map(|r| r.auto_tag_sig.clone()).collect::<Vec<_>>(), vec![Some("abc123".to_string()), None]);
        // A query that doesn't select it still reads the row
        let lean: Inspiration = db.query_row(
            "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                    aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                    phash, phash_source, vault_id, mime_type, created_at, updated_at,
                    auto_tag_status, lens_suggestions, auto_tag_model, duration_secs
             FROM inspirations WHERE id = 'a'", [], row_to_inspiration).unwrap();
        assert_eq!(lean.auto_tag_sig, None);
        let json = serde_json::to_value(load_inspiration(&db, "a").unwrap()).unwrap();
        assert_eq!(json["auto_tag_sig"], "abc123", "the page gets it");
    }
}

#[cfg(test)]
mod picture_aspect_tests {
    use super::*;

    /// A folder of test pictures of known sizes: (file name, width, height).
    fn pictures(sizes: &[(&str, u32, u32)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("qooti-aspect-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, w, h) in sizes {
            image::RgbImage::from_pixel(*w, *h, image::Rgb([200, 120, 40])).save(dir.join(name)).unwrap();
        }
        dir
    }

    #[test]
    fn new_items_get_their_real_shape() {
        let dir = pictures(&[("wide.png", 160, 90), ("tall.jpg", 60, 120), ("anim.gif", 40, 30)]);
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        // Pictures: their real size, whatever the caller passes (a link download passed nothing
        // and got the format's 1.0; a pack may carry an old 1.0)
        assert!(close(new_item_ratio(false, &p("wide.png"), None, 1.0), 160.0 / 90.0));
        assert!(close(new_item_ratio(false, &p("tall.jpg"), Some(1.0), 1.0), 0.5));
        assert!(close(new_item_ratio(false, &p("anim.gif"), None, 1.0), 40.0 / 30.0));
        // A picture whose header can't be read: the known ratio, else the default
        assert!(close(new_item_ratio(false, &p("missing.png"), Some(1.5), 1.0), 1.5));
        assert!(close(new_item_ratio(false, &p("missing.png"), None, 1.0), 1.0));
        // Videos: the probed (or the pack's) ratio, else the default; never a picture header
        assert!(close(new_item_ratio(true, &p("wide.png"), Some(0.5625), 1.78), 0.5625));
        assert!(close(new_item_ratio(true, &p("wide.png"), None, 1.78), 1.78));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn picture_aspects_are_fixed_once() {
        let dir = pictures(&[("wide.png", 160, 90), ("tall.jpg", 60, 120), ("anim.gif", 40, 30),
                             ("square.png", 50, 50), ("near.png", 201, 200)]);
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        let add = |id: &str, kind: &str, file: &str, ratio: f64| {
            conn.execute(
                "INSERT INTO inspirations (id, type, stored_path, aspect_ratio, auto_tag_sig, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'old', 0, 0)",
                params![id, kind, dir.join(file).to_string_lossy(), ratio],
            ).unwrap();
        };
        add("wide", "image", "wide.png", 1.0);
        add("tall", "image", "tall.jpg", 1.0);
        add("anim", "gif", "anim.gif", 1.0);
        add("square", "image", "square.png", 1.0);
        add("near", "image", "near.png", 1.0);     // 0.5 % off: left alone
        add("gone", "image", "missing.png", 1.0);  // file missing
        add("set", "image", "wide.png", 1.5);      // already has a ratio: not looked at
        add("clip", "video", "wide.png", 1.0);     // videos are never read as pictures
        let db = Mutex::new(conn);

        let r = fix_picture_aspects(&db).unwrap();
        assert_eq!(r, AspectFix { already_done: false, checked: 6, fixed: 3, unreadable: 1, marked_done: true });
        let conn = db.lock().unwrap();
        let row = |id: &str| -> (f64, Option<String>) {
            conn.query_row("SELECT aspect_ratio, auto_tag_sig FROM inspirations WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        assert!((row("wide").0 - 160.0 / 90.0).abs() < 1e-9);
        assert!((row("tall").0 - 0.5).abs() < 1e-9);
        assert!((row("anim").0 - 40.0 / 30.0).abs() < 1e-9);
        for id in ["wide", "tall", "anim"] { assert_eq!(row(id).1, None, "{id} is scored again"); }
        for id in ["square", "near", "gone", "clip"] { assert_eq!(row(id), (1.0, Some("old".to_string())), "{id}"); }
        assert_eq!(row("set"), (1.5, Some("old".to_string())));
        drop(conn);

        // Once only
        assert_eq!(fix_picture_aspects(&db).unwrap(), AspectFix { already_done: true, ..Default::default() });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn picture_aspects_wait_when_no_file_can_be_read() {
        // The library's drive isn't connected: nothing could be read, so the next start tries again
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute("INSERT INTO inspirations (id, type, stored_path, aspect_ratio, created_at, updated_at)
                      VALUES ('a', 'image', 'Z:/offline/a.png', 1.0, 0, 0)", []).unwrap();
        let db = Mutex::new(conn);
        let r = fix_picture_aspects(&db).unwrap();
        assert_eq!((r.checked, r.unreadable, r.marked_done), (1, 1, false));
        assert!(!fix_picture_aspects(&db).unwrap().already_done, "tried again");
        // A file that is there but can't be read as a picture (a format without a readable
        // header): the drive is connected, so the step is done; it isn't retried at every start
        let dir = std::env::temp_dir().join(format!("qooti-aspect-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let odd = dir.join("photo.heic");
        std::fs::write(&odd, b"not a picture this crate reads").unwrap();
        db.lock().unwrap().execute("UPDATE inspirations SET stored_path = ?1", params![odd.to_string_lossy()]).unwrap();
        let r = fix_picture_aspects(&db).unwrap();
        assert_eq!((r.checked, r.fixed, r.unreadable, r.marked_done), (1, 0, 1, true));
        assert!(fix_picture_aspects(&db).unwrap().already_done);
        // A library without pictures at 1.0 is done at once
        db.lock().unwrap().execute_batch("DELETE FROM inspirations; DELETE FROM preferences;").unwrap();
        assert!(fix_picture_aspects(&db).unwrap().marked_done);
        assert!(fix_picture_aspects(&db).unwrap().already_done);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The fix on a COPY of a real library (never the live file), with test pictures in a
    /// scratch folder. Every item's file is first pointed into that folder, so nothing else is
    /// ever read:
    /// QOOTI_DB_COPY=<copy of qooti.db> QOOTI_SCRATCH=<empty folder> cargo test --lib real_library_copy_picture_aspects -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_copy_picture_aspects() {
        let copy = std::env::var("QOOTI_DB_COPY").expect("QOOTI_DB_COPY");
        let scratch = std::path::PathBuf::from(std::env::var("QOOTI_SCRATCH").expect("QOOTI_SCRATCH"));
        std::fs::create_dir_all(&scratch).unwrap();
        let conn = rusqlite::Connection::open(&copy).unwrap();
        crate::db::migrate(&conn).unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        let square_before = count("SELECT COUNT(*) FROM inspirations WHERE type IN ('image','gif') AND aspect_ratio = 1.0");
        // Point every item at the scratch folder: the pictures at 1.0 get test files of
        // different shapes (one in five really square), everything else a file that isn't there.
        conn.execute("UPDATE inspirations SET stored_path = ?1 || '/missing-' || id", params![scratch.to_string_lossy()]).unwrap();
        let ids: Vec<String> = conn.prepare("SELECT id FROM inspirations WHERE type IN ('image','gif') AND aspect_ratio = 1.0 ORDER BY id").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        let shapes = [(1600u32, 900u32), (600, 1200), (500, 500), (1280, 720), (720, 1280)];
        let mut expect_fixed = 0usize;
        for (k, id) in ids.iter().enumerate() {
            let (w, h) = shapes[k % shapes.len()];
            let file = scratch.join(format!("{id}.png"));
            image::RgbImage::from_pixel(w / 10, h / 10, image::Rgb([90, 90, 90])).save(&file).unwrap();
            conn.execute("UPDATE inspirations SET stored_path = ?2, auto_tag_sig = 'old' WHERE id = ?1",
                         params![id, file.to_string_lossy()]).unwrap();
            if w != h { expect_fixed += 1; }
        }
        let outside = count(&format!(
            "SELECT COUNT(*) FROM inspirations WHERE substr(stored_path, 1, {}) != '{}'",
            scratch.to_string_lossy().chars().count(), scratch.to_string_lossy().replace('\'', "''")));
        assert_eq!(outside, 0, "every file is in the scratch folder");
        let db = Mutex::new(conn);
        let r = fix_picture_aspects(&db).unwrap();
        println!("pictures at 1.0 before: {square_before}; {r:?}");
        assert_eq!(r.checked, ids.len());
        assert_eq!(r.fixed, expect_fixed);
        assert!(r.marked_done);
        let conn = db.lock().unwrap();
        let left = conn.query_row("SELECT COUNT(*) FROM inspirations WHERE type IN ('image','gif') AND aspect_ratio = 1.0", [], |r| r.get::<_, i64>(0)).unwrap();
        let rescore = conn.query_row("SELECT COUNT(*) FROM inspirations WHERE auto_tag_sig IS NULL AND type IN ('image','gif')", [], |r| r.get::<_, i64>(0)).unwrap();
        println!("left at 1.0 (really square): {left}; pictures to score again: {rescore}");
        assert_eq!(left as usize, ids.len() - expect_fixed);
        drop(conn);
        assert!(fix_picture_aspects(&db).unwrap().already_done);
    }
}

/// The parts of the crop contract (crop spec C2, C3, C7) that live in this file; crop.rs tests
/// the crop itself.
#[cfg(test)]
mod crop_contract_tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&db).unwrap();
        db
    }

    fn folder() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("qooti-crop-contract-{}", Uuid::new_v4()));
        vault::ensure_structure(&dir).unwrap();
        dir
    }

    fn picture(path: &std::path::Path, w: u32, h: u32) {
        image::RgbImage::from_pixel(w, h, image::Rgb([30, 60, 90])).save(path).unwrap();
    }

    fn ratio_and_sig(db: &Connection, id: &str) -> (f64, Option<String>) {
        db.query_row("SELECT aspect_ratio, auto_tag_sig FROM inspirations WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
    }

    #[test]
    fn set_aspect_checks_and_saves_only_real_changes() {
        let db = db();
        db.execute("INSERT INTO inspirations (id, type, stored_path, aspect_ratio, auto_tag_sig, created_at, updated_at)
                    VALUES ('a', 'image', 'a.png', 1.0, 'sig', 5, 5)", []).unwrap();
        for bad in [0.04, 21.0, f64::NAN, f64::INFINITY, -1.0, 0.0] {
            assert_eq!(set_aspect(&db, "a", bad), Err("bad_ratio".to_string()), "{bad}");
        }
        // Within 1 %: nothing is written, the signature stays
        assert_eq!(set_aspect(&db, "a", 1.005), Ok(false));
        assert_eq!(ratio_and_sig(&db, "a"), (1.0, Some("sig".into())));
        // A real change: stored, scored again, updated_at untouched (a correction, not an edit)
        assert_eq!(set_aspect(&db, "a", 1.6), Ok(true));
        assert_eq!(ratio_and_sig(&db, "a"), (1.6, None));
        let updated: i64 = db.query_row("SELECT updated_at FROM inspirations WHERE id = 'a'", [], |r| r.get(0)).unwrap();
        assert_eq!(updated, 5);
        assert_eq!(set_aspect(&db, "a", 1.6), Ok(false), "the same shape again");
        // The limits themselves are allowed
        assert_eq!(set_aspect(&db, "a", 0.05), Ok(true));
        assert_eq!(set_aspect(&db, "a", 20.0), Ok(true));
        assert_eq!(set_aspect(&db, "nobody", 1.5), Ok(false), "an unknown id is no error");

        // Re-scoring: every item queued while a run is booked goes into that run, once
        assert!(queue_reshaped("x".into()), "the first books the run");
        assert!(!queue_reshaped("y".into()));
        assert!(!queue_reshaped("x".into()));
        assert_eq!(take_reshaped(), vec!["x".to_string(), "y".to_string()]);
        assert!(queue_reshaped("z".into()), "after the run, the next one books a new run");
        assert_eq!(take_reshaped(), vec!["z".to_string()]);
    }

    #[test]
    fn has_original_reaches_the_page() {
        let db = db();
        db.execute_batch(
            "INSERT INTO inspirations (id, type, stored_path, original_path, original_hash, crop_rect, created_at, updated_at)
                 VALUES ('a', 'image', 'a_crop_1.png', 'a.png', 'h', '{\"x\":0,\"y\":0,\"w\":0.5,\"h\":1}', 2, 2);
             INSERT INTO inspirations (id, type, stored_path, created_at, updated_at) VALUES ('b', 'image', 'b.png', 1, 1);",
        ).unwrap();
        assert!(load_inspiration(&db, "a").unwrap().has_original);
        assert!(!load_inspiration(&db, "b").unwrap().has_original);
        let rows: Vec<Inspiration> = db.prepare(&format!("{INSP_SELECT} ORDER BY id")).unwrap()
            .query_map([], row_to_inspiration).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(rows.iter().map(|r| r.has_original).collect::<Vec<_>>(), vec![true, false]);
        let opts: ListInspirationsOpts = serde_json::from_value(serde_json::json!({ "sort": "recent" })).unwrap();
        let listed = list_inspirations_with(&db, opts).unwrap();
        assert_eq!(listed.iter().map(|r| (r.id.as_str(), r.has_original)).collect::<Vec<_>>(), vec![("a", true), ("b", false)]);
        // A lean query (the OCR claim) still reads the row, as false
        let lean: Inspiration = db.query_row(
            "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                    aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                    phash, phash_source, vault_id, mime_type, created_at, updated_at,
                    auto_tag_status, lens_suggestions, auto_tag_model, duration_secs
             FROM inspirations WHERE id = 'a'", [], row_to_inspiration).unwrap();
        assert!(!lean.has_original);
        // The page gets the flag, never the kept file's path
        let json = serde_json::to_value(load_inspiration(&db, "a").unwrap()).unwrap();
        assert_eq!(json["has_original"], true);
        assert!(json.get("original_path").is_none() && json.get("original_hash").is_none() && json.get("crop_rect").is_none());
    }

    #[test]
    fn deleting_a_cropped_item_removes_both_files() {
        let dir = folder();
        let p = |name: &str| dir.join("images").join(name);
        for name in ["a.png", "a_crop_1.png", "a_crop_1_enhanced.png", "b.png", "b_crop_2.png", "c.png"] { picture(&p(name), 20, 20); }
        let s = |name: &str| p(name).to_string_lossy().into_owned();
        let db = Mutex::new(db());
        db.lock().unwrap().execute_batch(&format!(
            "INSERT INTO inspirations (id, type, stored_path, original_path, enhanced_path, created_at, updated_at)
                 VALUES ('a', 'image', '{}', '{}', '{}', 0, 0);
             INSERT INTO inspirations (id, type, stored_path, original_path, created_at, updated_at)
                 VALUES ('b', 'image', '{}', '{}', 0, 0);
             INSERT INTO inspirations (id, type, stored_path, created_at, updated_at) VALUES ('c', 'image', '{}', 0, 0);
             INSERT INTO collections (id, name, created_at, updated_at) VALUES ('col', 'Posters', 0, 0);
             INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES ('col', 'b', 0);",
            s("a_crop_1.png"), s("a.png"), s("a_crop_1_enhanced.png"), s("b_crop_2.png"), s("b.png"), s("c.png"),
        )).unwrap();

        delete_inspiration_with(&db, "a").unwrap();
        for name in ["a.png", "a_crop_1.png", "a_crop_1_enhanced.png"] { assert!(!p(name).exists(), "{name}"); }
        delete_collection_with(&db, Some(&dir), "col", true).unwrap();
        for name in ["b.png", "b_crop_2.png"] { assert!(!p(name).exists(), "{name}"); }
        assert!(p("c.png").exists(), "other items keep their files");
        let left: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM inspirations", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn moving_the_library_moves_kept_originals_and_upscaled_copies() {
        let db = db();
        db.execute_batch(
            "INSERT INTO inspirations (id, type, stored_path, thumbnail_path, original_path, enhanced_path, created_at, updated_at)
                 VALUES ('a', 'image', 'D:/old/images/a_crop_1.png', NULL, 'D:/old/images/a.png', 'D:/old/images/a_crop_1_enhanced.png', 0, 0),
                        ('v', 'video', 'D:/old/videos/v.mp4', 'D:/old/thumbnails/v_thumb.jpg', NULL, NULL, 0, 0),
                        ('x', 'image', 'E:/elsewhere/x.png', NULL, 'E:/elsewhere/x0.png', NULL, 0, 0);",
        ).unwrap();
        move_library_paths(&db, "D:/old", "F:/new").unwrap();
        let row = |id: &str| -> (String, Option<String>, Option<String>, Option<String>) {
            db.query_row("SELECT stored_path, thumbnail_path, original_path, enhanced_path FROM inspirations WHERE id = ?1", [id],
                         |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
        };
        assert_eq!(row("a"), ("F:/new/images/a_crop_1.png".into(), None, Some("F:/new/images/a.png".into()),
                              Some("F:/new/images/a_crop_1_enhanced.png".into())));
        assert_eq!(row("v"), ("F:/new/videos/v.mp4".into(), Some("F:/new/thumbnails/v_thumb.jpg".into()), None, None));
        assert_eq!(row("x"), ("E:/elsewhere/x.png".into(), None, Some("E:/elsewhere/x0.png".into()), None), "not in the old folder");
    }

    #[test]
    fn import_one_is_the_import_loop() {
        let dir = folder();
        let db = Mutex::new(db());
        let src = dir.join("downloads");
        std::fs::create_dir_all(&src).unwrap();
        picture(&src.join("wide.png"), 160, 90);
        std::fs::write(src.join("notes.txt"), b"not a picture").unwrap();
        let none = |_: &std::path::Path| (None, None);
        let path = |n: &str| src.join(n).to_string_lossy().into_owned();
        let ImportOne::Imported(item) = import_one(&db, &dir, &path("wide.png"), "file_import", &none).unwrap() else { panic!("not imported") };
        assert!(item.stored_path.starts_with(&*dir.join("images").to_string_lossy()));
        assert!((item.aspect_ratio - 160.0 / 90.0).abs() < 1e-9);
        assert!(!item.has_original);
        assert!(matches!(import_one(&db, &dir, &path("wide.png"), "file_import", &none).unwrap(), ImportOne::Existing(ref id) if *id == item.id));
        assert!(matches!(import_one(&db, &dir, &path("notes.txt"), "file_import", &none).unwrap(), ImportOne::Skipped));
        assert!(matches!(import_one(&db, &dir, &path("missing.png"), "file_import", &none).unwrap(), ImportOne::Skipped));
        let (source, n): (String, i64) = db.lock().unwrap()
            .query_row("SELECT import_source, (SELECT COUNT(*) FROM inspirations) FROM inspirations", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((source.as_str(), n), ("file_import", 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn text_read_from_an_old_file_never_lands_on_a_crop() {
        let db = db();
        db.execute("INSERT INTO inspirations (id, type, stored_path, created_at, updated_at) VALUES ('a', 'image', 'a.png', 0, 0)", []).unwrap();
        let result = |file: Option<&str>, text: &str, status: &str| OcrResult {
            id: "a".into(), ocr_text: text.into(), ocr_language: Some("en".into()), status: status.into(),
            stored_path: file.map(String::from),
        };
        let row = || -> (String, Option<String>) {
            db.query_row("SELECT ocr_text, ocr_status FROM inspirations WHERE id = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        let found = |word: &str| -> i64 {
            db.query_row("SELECT COUNT(*) FROM inspirations_fts WHERE inspirations_fts MATCH ?1", [word], |r| r.get(0)).unwrap()
        };
        // Read and written while the item shows that file: kept
        assert!(finalize_ocr(&db, &result(Some("a.png"), "big sale", "done")).unwrap());
        assert_eq!(row(), ("big sale".to_string(), Some("done".to_string())));
        assert_eq!(found("big"), 1);

        // The reader took the item, then a crop gave it a new file and reset its text…
        db.execute("UPDATE inspirations SET stored_path = 'a_crop_1.png', ocr_text = '', ocr_status = NULL WHERE id = 'a'", []).unwrap();
        // …so the old file's words are dropped, and so is a failure (the file read may be gone)
        assert!(!finalize_ocr(&db, &result(Some("a.png"), "big sale", "done")).unwrap());
        assert!(!finalize_ocr(&db, &result(Some("a.png"), "", "failed")).unwrap());
        assert_eq!(row(), (String::new(), None), "waiting to be read again");
        assert_eq!(found("big"), 0, "not found by the words that were cut away");
        // The cut, read next, is kept
        assert!(finalize_ocr(&db, &result(Some("a_crop_1.png"), "sale", "done")).unwrap());
        assert_eq!(row(), ("sale".to_string(), Some("done".to_string())));

        // A page that doesn't say which file it read is written as before
        let old: OcrResult = serde_json::from_value(serde_json::json!({ "id": "a", "ocr_text": "", "ocr_language": null, "status": "skipped" })).unwrap();
        assert_eq!(old.stored_path, None);
        assert!(finalize_ocr(&db, &old).unwrap());
        assert_eq!(row(), (String::new(), Some("skipped".to_string())));
        assert!(!finalize_ocr(&db, &OcrResult { id: "nobody".into(), ..result(None, "x", "done") }).unwrap());
    }
}
