use std::collections::{HashMap, VecDeque};
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
}

static DOWNLOAD_QUEUE: OnceLock<Mutex<VecDeque<DownloadRequest>>> = OnceLock::new();
fn download_queue() -> &'static Mutex<VecDeque<DownloadRequest>> {
    DOWNLOAD_QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
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
            std::thread::spawn(move || {
                run_ytdlp(r.app, r.download_id, r.url, r.quality, r.tmp_dir, r.ext_id);
                // All run_ytdlp exit paths (success, error, early-return) land here.
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

#[tauri::command]
pub fn cancel_download(download_id: String, app: AppHandle) -> Result<(), String> {
    // Check the queue first — the download may not have started yet.
    {
        let mut queue = download_queue().lock().unwrap();
        if let Some(pos) = queue.iter().position(|r| r.download_id == download_id) {
            let req = queue.remove(pos).unwrap();
            drop(queue); // release lock before any further state mutation
            log::info!(target: "Download", "cancel_queued download_id={download_id}");
            app.state::<AppState>()
                .ext_id_map.lock().unwrap()
                .remove(&download_id);
            if let Some(ref eid) = req.ext_id {
                set_ext_progress(&app, eid, 0.0, "", "cancelled", "Cancelled");
            }
            let _ = app.emit("download:error", serde_json::json!({
                "download_id": download_id,
                "message": "Cancelled",
            }));
            return Ok(());
        }
    }
    // Download is running — kill the yt-dlp process.
    let pid = active_pids().lock().unwrap().remove(&download_id);
    if let Some(pid) = pid {
        log::info!(target: "Download", "cancel_running pid={pid} download_id={download_id}");
        #[cfg(windows)]
        hidden_command("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .spawn()
            .ok();
        #[cfg(not(windows))]
        hidden_command("kill")
            .args(["-9", &pid.to_string()])
            .spawn()
            .ok();
        let _ = app.emit("download:error", serde_json::json!({
            "download_id": download_id,
            "message": "Cancelled",
        }));
    }
    Ok(())
}

// ─── Shared types ────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct AppInfo {
    pub platform: String,
    pub version: String,
}

#[derive(Serialize, Deserialize)]
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
    pub auto_tag_confidence: Option<String>,
    pub auto_tag_model: Option<String>,
    #[serde(default)]
    pub duration_secs: Option<f64>,
    #[serde(default)]
    pub collection_names: Option<String>,
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

#[derive(Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub source: String,
    pub created_at: i64,
    pub usage_count: i64,
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
    pub skipped:  Vec<String>,
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

    for path_str in paths {
        let src = std::path::Path::new(&path_str);

        let validated = match crate::media_guard::validate_path(src) {
            Ok(v)  => v,
            Err(e) => {
                log::warn!(target: "Import", "guard_rejected path={path_str:?} error={e}");
                skipped.push(path_str);
                continue;
            }
        };
        let (file_type, subdir, mime) = (validated.db_type, validated.subdir, validated.mime);

        let content = match std::fs::read(src) {
            Ok(b) => b,
            Err(_) => { skipped.push(path_str); continue; }
        };

        let hash = {
            let mut h = sha2::Sha256::new();
            h.update(&content);
            hex::encode(h.finalize())
        };

        // Skip exact duplicates
        {
            let db = state.db.lock().unwrap();
            let count: i64 = db.query_row(
                "SELECT COUNT(*) FROM inspirations WHERE file_hash = ?1",
                params![hash],
                |r| r.get(0),
            ).unwrap_or(0);
            if count > 0 { skipped.push(path_str); continue; }
        }

        let id = Uuid::new_v4().to_string();
        let dest_name = format!("{}.{}", id, validated.real_ext);
        let dest_path = vault_path.join(subdir).join(&dest_name);

        if std::fs::copy(src, &dest_path).is_err() {
            skipped.push(path_str);
            continue;
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
        let (duration, video_ratio) = if is_video { video_meta(&dest_path, &app) } else { (None, None) };
        let aspect_ratio = video_ratio.unwrap_or(validated.default_ratio);

        {
            let db = state.db.lock().unwrap();
            db.execute(
                "INSERT INTO inspirations \
                 (id, type, stored_path, file_hash, mime_type, aspect_ratio, ocr_text, \
                  ocr_status, palette, duration_secs, import_source, created_at, updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,'',?7,?8,?9,?10,?11,?11)",
                params![id, file_type, stored_path, hash, mime, aspect_ratio, ocr_status, palette_json, duration, src_label, now],
            ).map_err(|e| e.to_string())?;
        }

        imported.push(Inspiration {
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
            auto_tag_confidence: None,
            auto_tag_model: None,
            duration_secs: duration,
            collection_names: None,
        });
    }

    log::info!(target: "Import", "done imported={} skipped={}", imported.len(), skipped.len());
    Ok(ImportResult { imported, skipped })
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

const SETTINGS_BLACKLIST: &[&str] = &["extension_connection_key", "device_id"];

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
pub fn set_setting(key: String, value: String, state: State<AppState>) -> Result<(), String> {
    if SETTINGS_BLACKLIST.contains(&key.as_str()) {
        return Err(format!("key '{key}' is not settable via this command"));
    }
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
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
    let plan     = get_plan_from_db(&db);
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

    // Text search: title + OCR (via FTS5) + accepted tags + auto-tag confidence.
    // title/ocr_text go through the inspirations_fts index instead of two
    // leading-wildcard LIKE '%q%' full scans; tag names and vocab labels stay on
    // LIKE (small tables). The `?` push order below must match the SQL left→right.
    if let Some(q) = &opts.query {
        let like = format!("%{}%", q.to_lowercase());
        let fts  = to_fts_query(q);

        let mut ors: Vec<&str> = Vec::with_capacity(3);
        if !fts.is_empty() {
            ors.push("rowid IN (SELECT rowid FROM inspirations_fts WHERE inspirations_fts MATCH ?)");
        }
        ors.push("id IN (SELECT it.inspiration_id FROM inspiration_tags it \
                         JOIN tags t ON t.id = it.tag_id \
                         WHERE LOWER(t.name) LIKE ?)");
        ors.push("EXISTS (SELECT 1 FROM tag_vocab tv \
                          WHERE LOWER(tv.labels_json) LIKE ? \
                            AND instr(LOWER(COALESCE(auto_tag_confidence,'')), LOWER(tv.id)) > 0)");

        wheres.push(format!("({})", ors.join(" OR ")));

        if !fts.is_empty() { args.push(fts); } // title + ocr_text (FTS MATCH)
        args.push(like.clone());               // accepted tag names
        args.push(like);                       // tag_vocab display labels
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
                auto_tag_status, auto_tag_confidence, auto_tag_model,
                duration_secs,
                (SELECT json_group_array(c.name)
                 FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names
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
    db.query_row(
        "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, auto_tag_confidence, auto_tag_model,
                duration_secs,
                (SELECT json_group_array(c.name)
                 FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names
         FROM inspirations WHERE id = ?1",
        params![id],
        row_to_inspiration,
    )
    .map_err(|e| e.to_string())
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
    // Fetch file paths before touching the DB so we know what to clean up.
    let (stored_path, thumbnail_path): (String, Option<String>) = {
        let db = state.db.lock().unwrap();
        db.query_row(
            "SELECT stored_path, thumbnail_path FROM inspirations WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|e| e.to_string())?
    };

    {
        let db = state.db.lock().unwrap();
        // Decrement counts BEFORE the ON DELETE CASCADE wipes inspiration_tags
        db.execute(
            "UPDATE tag_usage_counts SET count = MAX(0, count - 1)
             WHERE tag_id IN (SELECT tag_id FROM inspiration_tags WHERE inspiration_id = ?1)",
            params![id],
        ).map_err(|e| e.to_string())?;
        db.execute("DELETE FROM inspirations WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        // Delete tags that are now unused (cascade from inspiration_tags already ran)
        db.execute(
            "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM inspiration_tags)",
            [],
        ).map_err(|e| e.to_string())?;
        db.execute(
            "DELETE FROM tag_usage_counts WHERE tag_id NOT IN (SELECT id FROM tags)",
            [],
        ).map_err(|e| e.to_string())?;
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

    Ok(())
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
        auto_tag_confidence:  row.get(20)?,
        auto_tag_model:       row.get(21)?,
        duration_secs:        row.get(22).ok(),
        collection_names:     row.get(23).ok(),
    })
}

#[tauri::command]
pub fn read_image_as_base64(path: String) -> Result<String, String> {
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
                auto_tag_status, auto_tag_confidence, auto_tag_model,
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
}

#[tauri::command]
pub fn finalize_ocr_index_result(result: OcrResult, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE inspirations SET ocr_text = ?1, ocr_language = ?2, ocr_status = ?3 WHERE id = ?4",
        params![result.ocr_text, result.ocr_language, result.status, result.id],
    )
    .map_err(|e| e.to_string())?;
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

// ─── Auto-tagging ────────────────────────────────────────────────

#[tauri::command]
pub fn claim_auto_tag_candidates(
    batch_size: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<Inspiration>, String> {
    let db   = state.db.lock().unwrap();
    let size = batch_size.unwrap_or(4);

    db.execute_batch("BEGIN;").map_err(|e| e.to_string())?;

    let ids: Vec<String> = {
        let mut stmt = db
            .prepare(
                "SELECT id FROM inspirations
                 WHERE (auto_tag_status IS NULL OR auto_tag_status = 'processing')
                 AND type IN ('image','gif')
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
            "UPDATE inspirations SET auto_tag_status = 'processing' WHERE id = ?1",
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
                auto_tag_status, auto_tag_confidence, auto_tag_model,
                duration_secs
         FROM inspirations WHERE id IN ({})",
        placeholders
    );

    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<Inspiration> = stmt
        .query_map(
            rusqlite::params_from_iter(ids.iter().map(|s| s.as_str())),
            row_to_inspiration,
        )
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

#[tauri::command]
pub fn finalize_auto_tag_result(
    id: String,
    confidence: Option<String>,
    model: Option<String>,
    status: String,
    state: State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE inspirations
         SET auto_tag_status = ?1, auto_tag_confidence = ?2, auto_tag_model = ?3
         WHERE id = ?4",
        params![status, confidence, model, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Tag vocab (developer dictionary) ───────────────────────────

#[derive(Serialize)]
pub struct TagVocabEntry {
    pub id:           String,
    pub labels_json:  String,
    pub prompts_json: String,
    pub built_in:     bool,
    pub sort_order:   i64,
}

#[tauri::command]
pub fn list_tag_vocab(state: State<AppState>) -> Result<Vec<TagVocabEntry>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare("SELECT id, labels_json, prompts_json, built_in, sort_order FROM tag_vocab ORDER BY sort_order, id")
        .map_err(|e| e.to_string())?;
    let result: Vec<TagVocabEntry> = stmt
        .query_map([], |row| Ok(TagVocabEntry {
            id:           row.get(0)?,
            labels_json:  row.get(1)?,
            prompts_json: row.get(2)?,
            built_in:     row.get::<_, i64>(3)? != 0,
            sort_order:   row.get(4)?,
        }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(result)
}

#[tauri::command]
pub fn upsert_tag_vocab(
    id:           String,
    labels_json:  String,
    prompts_json: String,
    built_in:     bool,
    sort_order:   i64,
    state: State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO tag_vocab (id, labels_json, prompts_json, built_in, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           labels_json  = excluded.labels_json,
           prompts_json = excluded.prompts_json,
           built_in     = excluded.built_in,
           sort_order   = excluded.sort_order,
           updated_at   = strftime('%s','now')",
        params![id, labels_json, prompts_json, built_in as i64, sort_order],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reset_all_auto_tags(state: State<AppState>) -> Result<u64, String> {
    let db = state.db.lock().unwrap();
    let count = db.execute(
        "UPDATE inspirations SET auto_tag_status = NULL, auto_tag_confidence = NULL \
         WHERE auto_tag_status IS NOT NULL",
        [],
    ).map_err(|e| e.to_string())? as u64;
    Ok(count)
}

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

#[tauri::command]
pub fn delete_tag_vocab(id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM tag_vocab WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    // Re-queue images that were scored against this tag so they get re-tagged
    // without it. The LIKE pattern matches the quoted key in the confidence JSON.
    let pattern = format!("%\"{}\":%", id);
    db.execute(
        "UPDATE inspirations SET auto_tag_status = NULL, auto_tag_confidence = NULL \
         WHERE auto_tag_confidence LIKE ?1",
        params![pattern],
    ).map_err(|e| e.to_string())?;
    Ok(())
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
    if delete_items {
        // Collect stored_path + thumbnail_path for every item in this collection
        let files: Vec<(String, Option<String>)> = {
            let db = state.db.lock().unwrap();
            let mut stmt = db.prepare(
                "SELECT i.stored_path, i.thumbnail_path \
                 FROM inspirations i \
                 JOIN collection_items ci ON ci.inspiration_id = i.id \
                 WHERE ci.collection_id = ?1"
            ).map_err(|e| e.to_string())?;
            let rows: Vec<_> = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };

        // Delete inspiration records (collection_items cascade-delete automatically)
        {
            let db = state.db.lock().unwrap();
            db.execute(
                "DELETE FROM inspirations WHERE id IN \
                 (SELECT inspiration_id FROM collection_items WHERE collection_id = ?1)",
                params![id],
            ).map_err(|e| e.to_string())?;
        }

        // Remove physical files from disk (best-effort — ignore individual errors)
        let vault_path = vault::get_vault_path(&app).ok();
        for (stored, thumb) in &files {
            std::fs::remove_file(stored).ok();
            if let Some(t) = thumb {
                // thumbnail_path may be relative to vault
                let abs = if std::path::Path::new(t).is_absolute() {
                    std::path::PathBuf::from(t)
                } else {
                    vault_path.as_ref().map(|v| v.join(t)).unwrap_or_default()
                };
                std::fs::remove_file(&abs).ok();
            }
        }
    }

    let db = state.db.lock().unwrap();
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
    let (col_name, items, tags_map) = {
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

        let tags_map: HashMap<String, Vec<String>> = {
            let mut stmt = db.prepare(
                "SELECT it.inspiration_id, t.name
                 FROM inspiration_tags it
                 JOIN tags t ON t.id = it.tag_id
                 JOIN collection_items ci ON ci.inspiration_id = it.inspiration_id
                 WHERE ci.collection_id = ?1"
            ).map_err(|e| e.to_string())?;
            let mut map: HashMap<String, Vec<String>> = HashMap::new();
            for row in stmt.query_map(params![collection_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()) {
                map.entry(row.0).or_default().push(row.1);
            }
            map
        };

        (col_name, items, tags_map)
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
            "created_at": created_at, "tags": tags, "file": file_in_zip,
        });
        if let Some(v) = title          { entry["title"]           = serde_json::json!(v); }
        if let Some(v) = mime_type      { entry["mime_type"]        = serde_json::json!(v); }
        if let Some(v) = source_url     { entry["source_url"]       = serde_json::json!(v); }
        if let Some(v) = source_platform{ entry["source_platform"]  = serde_json::json!(v); }
        if let Some(v) = ocr_text       { entry["ocr_text"]         = serde_json::json!(v); }

        manifest_items.push(entry);
        media_entries.push((file_in_zip, stored_path.clone()));
    }

    let manifest = serde_json::json!({
        "version": 1,
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

#[tauri::command]
pub async fn export_all_items(
    save_path: String,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    // Phase 1: DB queries — fast, done while holding the lock briefly
    type Row = (String, Option<String>, String, Option<String>, String,
                Option<String>, Option<String>, i64, Option<String>);
    let (items, tags_map): (Vec<Row>, HashMap<String, Vec<String>>) = {
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

        let tags_map: HashMap<String, Vec<String>> = {
            let mut stmt = db.prepare(
                "SELECT it.inspiration_id, t.name FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id"
            ).map_err(|e| e.to_string())?;
            let mut map: HashMap<String, Vec<String>> = HashMap::new();
            for row in stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()) {
                map.entry(row.0).or_default().push(row.1);
            }
            map
        };

        (items, tags_map)
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
                "created_at": created_at, "tags": tags, "file": file_in_zip,
            });
            if let Some(v) = title           { entry["title"]          = serde_json::json!(v); }
            if let Some(v) = mime_type       { entry["mime_type"]       = serde_json::json!(v); }
            if let Some(v) = source_url      { entry["source_url"]      = serde_json::json!(v); }
            if let Some(v) = source_platform { entry["source_platform"] = serde_json::json!(v); }
            if let Some(v) = ocr_text        { entry["ocr_text"]        = serde_json::json!(v); }

            manifest_items.push(entry);
            media_entries.push((file_in_zip, stored_path.clone()));
        }

        let manifest = serde_json::json!({
            "version": 1,
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

        // Hash-based dedup
        let hash = {
            let mut h = sha2::Sha256::new();
            h.update(&media_bytes);
            hex::encode(h.finalize())
        };
        {
            let db = state.db.lock().unwrap();
            let count: i64 = db.query_row(
                "SELECT COUNT(*) FROM inspirations WHERE file_hash = ?1",
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

        // Derive video metadata (duration + aspect ratio)
        let is_video = file_type == "video";
        let (duration, video_ratio) = if is_video { video_meta(&dest_path, &app) } else { (None, None) };
        let aspect_ratio = video_ratio.unwrap_or(validated.default_ratio);
        let ocr_status   = if is_video { Some("skipped") } else { None };
        let palette_json = if !is_video {
            let p = stored_path.clone();
            let colors = std::panic::catch_unwind(|| palette_from_path(&p, 5)).unwrap_or_default();
            if colors.is_empty() { None } else { serde_json::to_string(&colors).ok() }
        } else { None };

        let title          = item_meta["title"].as_str().map(|s| s.to_string());
        let source_url     = item_meta["source_url"].as_str().map(|s| s.to_string());
        let source_platform = item_meta["source_platform"].as_str().map(|s| s.to_string());
        let created_at     = item_meta["created_at"].as_i64().unwrap_or(now);
        let mime_val       = item_meta["mime_type"].as_str().unwrap_or(mime);

        // Insert inspiration — batch_id = col_id groups all pack items under their collection
        {
            let db = state.db.lock().unwrap();
            if db.execute(
                "INSERT INTO inspirations \
                 (id, type, title, stored_path, file_hash, mime_type, aspect_ratio, ocr_text, \
                  ocr_status, source_url, source_platform, palette, duration_secs, \
                  import_source, batch_id, created_at, updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'',?8,?9,?10,?11,?12,'pack_import',?13,?14,?14)",
                params![item_id, file_type, title, stored_path, hash, mime_val, aspect_ratio,
                        ocr_status, source_url, source_platform, palette_json, duration, col_id, created_at],
            ).is_err() { skipped_count += 1; continue; }
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
        if let Some(tags) = item_meta["tags"].as_array() {
            for tag_val in tags {
                if let Some(tag_name) = tag_val.as_str() {
                    let db = state.db.lock().unwrap();
                    // Find or create tag
                    let tag_id: Option<String> = db.query_row(
                        "SELECT id FROM tags WHERE LOWER(name) = LOWER(?1)",
                        params![tag_name], |r| r.get(0),
                    ).ok();
                    let tag_id = tag_id.unwrap_or_else(|| {
                        let new_id = Uuid::new_v4().to_string();
                        db.execute(
                            "INSERT INTO tags (id, name, source, created_at) VALUES (?1,?2,'import',?3)",
                            params![new_id, tag_name, now],
                        ).ok();
                        new_id
                    });
                    db.execute(
                        "INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES (?1,?2)",
                        params![item_id, tag_id],
                    ).ok();
                }
            }
        }

        imported_count += 1;
    }

    log::info!(target: "Import", "qooti_pack_done collection={col_name:?} imported={imported_count} skipped={skipped_count}");
    Ok(ImportQooTiResult { collection_id: col_id, collection_name: col_name, imported_count, skipped_count })
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

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<Tag>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT t.id, t.name, t.source, t.created_at, COALESCE(u.count, 0) AS usage_count
         FROM tags t
         LEFT JOIN tag_usage_counts u ON u.tag_id = t.id
         ORDER BY usage_count DESC, t.name"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(Tag {
        id: row.get(0)?, name: row.get(1)?, source: row.get(2)?,
        created_at: row.get(3)?, usage_count: row.get(4)?,
    })).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[tauri::command]
pub fn get_tags_for_inspiration(inspiration_id: String, state: State<AppState>) -> Result<Vec<Tag>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT t.id, t.name, t.source, t.created_at, COALESCE(u.count, 0)
         FROM tags t
         JOIN inspiration_tags it ON it.tag_id = t.id
         LEFT JOIN tag_usage_counts u ON u.tag_id = t.id
         WHERE it.inspiration_id = ?1
         ORDER BY t.name"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![inspiration_id], |row| Ok(Tag {
        id: row.get(0)?, name: row.get(1)?, source: row.get(2)?,
        created_at: row.get(3)?, usage_count: row.get(4)?,
    })).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[tauri::command]
pub fn create_tag(name: String, source: Option<String>, state: State<AppState>) -> Result<Tag, String> {
    let db = state.db.lock().unwrap();
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let src = source.unwrap_or_else(|| "user".to_string());
    db.execute("INSERT INTO tags (id, name, source, created_at) VALUES (?1,?2,?3,?4)", params![id, name, src, now]).map_err(|e| e.to_string())?;
    db.execute("INSERT INTO tag_usage_counts (tag_id, count) VALUES (?1, 0)", params![id]).map_err(|e| e.to_string())?;
    Ok(Tag { id, name, source: src, created_at: now, usage_count: 0 })
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
    // Only increment the count if the pair is actually new
    let inserted = db.execute(
        "INSERT OR IGNORE INTO inspiration_tags (inspiration_id, tag_id) VALUES (?1,?2)",
        params![inspiration_id, tag_id],
    ).map_err(|e| e.to_string())?;
    if inserted > 0 {
        db.execute(
            "INSERT INTO tag_usage_counts (tag_id, count) VALUES (?1,1)
             ON CONFLICT(tag_id) DO UPDATE SET count = count + 1",
            params![tag_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn untag_inspiration(inspiration_id: String, tag_id: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM inspiration_tags WHERE inspiration_id = ?1 AND tag_id = ?2", params![inspiration_id, tag_id]).map_err(|e| e.to_string())?;
    db.execute("UPDATE tag_usage_counts SET count = MAX(0, count - 1) WHERE tag_id = ?1", params![tag_id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── OCR ──────────────────────────────────────────────────────────
// OCR moved to WASM (PP-OCRv4 via onnxruntime-web) in the frontend worker —
// see src/workers/ocr-worker.js and src/modules/ocr.js. The former native
// `rapidocr` sidecar (run_ocr / OcrSidecar / rapidocr_binary) and its ~200 MB
// bundled binary were removed. The DB-side OCR index commands
// (claim_ocr_index_candidates, finalize_ocr_index_result, get_ocr_index_stats,
// queue_full_ocr_reindex, reset_ocr_status_for_inspiration) remain in use.

// ─── Palette extraction (Rust-side, no canvas/CORS issues) ───────

fn palette_from_path(path: &str, num_colors: usize) -> Vec<String> {
    let img = match image::open(path) {
        Ok(i) => i,
        Err(_) => return vec![],
    };
    let img = img.resize(80, 80, image::imageops::FilterType::Triangle);
    let pixels: Vec<[u8; 3]> = img.pixels()
        .filter(|(_, _, p)| p[3] > 127)
        .map(|(_, _, p)| [p[0], p[1], p[2]])
        .collect();
    if pixels.is_empty() { return vec![]; }

    let depth = (num_colors as f64).log2().ceil() as usize;
    let mut clusters = palette_median_cut(pixels, depth);
    clusters.sort_by(|a, b| b.len().cmp(&a.len()));

    clusters.into_iter().take(num_colors).map(|bucket| {
        let n = bucket.len() as u32;
        let (sr, sg, sb) = bucket.iter().fold((0u32, 0u32, 0u32), |acc, &[r, g, b]| {
            (acc.0 + r as u32, acc.1 + g as u32, acc.2 + b as u32)
        });
        format!("#{:02x}{:02x}{:02x}", (sr/n) as u8, (sg/n) as u8, (sb/n) as u8)
    }).collect()
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
    db.execute_batch(
        "INSERT OR REPLACE INTO tag_usage_counts (tag_id, count)
         SELECT tag_id, COUNT(*) FROM inspiration_tags GROUP BY tag_id;
         INSERT OR IGNORE INTO tag_usage_counts (tag_id, count)
         SELECT id, 0 FROM tags;"
    ).map_err(|e| e.to_string())?;

    let tags_rebuilt: i64 = db
        .query_row("SELECT COUNT(*) FROM tag_usage_counts", [], |r| r.get(0))
        .unwrap_or(0);

    // Reset OCR so every image/gif is re-analysed on next pass
    db.execute_batch(
        "UPDATE inspirations SET ocr_status = NULL, ocr_text = '' WHERE type IN ('image','gif')"
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

    // ── Update absolute paths in DB ────────────────────────────────
    // stored_path and thumbnail_path are stored as absolute paths, so they
    // must be rewritten to reflect the new vault root.
    if migrate {
        let old_prefix = old_vault.to_string_lossy().into_owned();
        let new_prefix = new_vault.to_string_lossy().into_owned();
        let db = state.db.lock().unwrap();
        // stored_path is always absolute; update any row whose path starts with old root
        db.execute(
            "UPDATE inspirations \
             SET stored_path = ?2 || SUBSTR(stored_path, LENGTH(?1) + 1) \
             WHERE SUBSTR(stored_path, 1, LENGTH(?1)) = ?1",
            params![old_prefix, new_prefix],
        ).map_err(|e| {
            // DB update failed — revert vault_path.txt so old location is restored
            let _ = vault::clear_custom_vault_path(&app);
            format!("Database path update failed: {e}. Vault location reverted.")
        })?;
        // thumbnail_path may be absolute or relative; only rewrite absolute ones
        db.execute(
            "UPDATE inspirations \
             SET thumbnail_path = ?2 || SUBSTR(thumbnail_path, LENGTH(?1) + 1) \
             WHERE thumbnail_path IS NOT NULL \
               AND SUBSTR(thumbnail_path, 1, LENGTH(?1)) = ?1",
            params![old_prefix, new_prefix],
        ).ok(); // best-effort; missing thumbnails are just cosmetic
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
    // In-app downloads (no ext_id) are capped at FREE_DOWNLOAD_DAILY_LIMIT per day for free users.
    if ext_id.is_none() {
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
            // Record this download against today's quota
            let _ = db.execute(
                "INSERT OR REPLACE INTO preferences (key, value) VALUES ('app_dl_date', ?1)",
                [&today],
            );
            let _ = db.execute(
                "INSERT OR REPLACE INTO preferences (key, value) VALUES ('app_dl_count', ?1)",
                [(used + 1).to_string()],
            );
        }
    }

    let vault_path = vault::get_vault_path(&app).map_err(|e| e.to_string())?;
    let tmp_dir = vault_path.join("downloads_tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

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
    });

    try_start_next();

    Ok(download_id)
}

pub fn ytdlp_binary_path(app: &AppHandle) -> std::path::PathBuf {
    ytdlp_binary(app)
}

fn ytdlp_binary(app: &AppHandle) -> std::path::PathBuf {
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

fn ffmpeg_binary(app: &AppHandle) -> Option<std::path::PathBuf> {
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

fn set_ext_progress(app: &AppHandle, ext_id: &str, pct: f64, speed: &str, status: &str, message: &str) {
    let state = app.state::<crate::AppState>();
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

/// Cancel the yt-dlp process associated with the given ext_id.
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
        let pid = active_pids().lock().unwrap().remove(&did);
        if let Some(pid) = pid {
            log::info!(target: "Download", "cancel pid={pid} ext_id={ext_id}");
            #[cfg(windows)]
            hidden_command("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .spawn()
                .ok();
            #[cfg(not(windows))]
            hidden_command("kill")
                .args(["-9", &pid.to_string()])
                .spawn()
                .ok();
        }
    }

    set_ext_progress(app, ext_id, 0.0, "", "cancelled", "Cancelled by user");
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

    let binary = ytdlp_binary(&app);
    if let Ok(meta) = std::fs::metadata(&binary) {
        log::debug!(target: "Download", "binary path={:?} bytes={}", binary, meta.len());
    } else {
        log::debug!(target: "Download", "binary path={:?}", binary);
    }
    log::info!(target: "Download", "start download_id={download_id} url={url:?} quality={quality}");

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
        if let Some(ref eid) = ext_id {
            set_ext_progress(&app, eid, 0.1, "", "downloading", "");
        }
        let bytes_result = ureq::get(&url)
            .set("User-Agent", ua)
            .call()
            .map_err(|e| e.to_string())
            .and_then(|r| {
                let mut bytes = Vec::new();
                r.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                Ok(bytes)
            });
        match bytes_result {
            Ok(bytes) => {
                let ext      = url_path.rsplit('.').next().unwrap_or("jpg");
                let out_path = tmp_dir.join(format!("image_{download_id}.{ext}"));
                if let Err(e) = std::fs::write(&out_path, &bytes) {
                    log::warn!(target: "Download", "direct_image_write_err error={e}");
                    let _ = app.emit("download:error", serde_json::json!({
                        "download_id": download_id,
                        "message": format!("Failed to save image: {e}"),
                    }));
                    if let Some(ref eid) = ext_id { set_ext_progress(&app, eid, 0.0, "", "error", "Save failed"); }
                    return;
                }
                log::info!(target: "Download", "direct_image_ok path={:?}", out_path);
                let _ = app.emit("download:complete", serde_json::json!({
                    "download_id": download_id,
                    "paths": [out_path.to_string_lossy().to_string()],
                    "url":   url,
                }));
                if let Some(ref eid) = ext_id { set_ext_progress(&app, eid, 1.0, "", "finalizing", "Saving to library…"); }
            }
            Err(e) => {
                log::warn!(target: "Download", "direct_image_fetch_err error={e}");
                let _ = app.emit("download:error", serde_json::json!({
                    "download_id": download_id,
                    "message": format!("Failed to download image: {e}"),
                }));
                if let Some(ref eid) = ext_id { set_ext_progress(&app, eid, 0.0, "", "error", &e); }
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

    let mut base_args: Vec<&str> = vec![
        "--no-playlist",
        "--newline",
        "--progress",
        "--force-overwrites",
        "--merge-output-format", "mp4/mkv",
        "--retries", "5",
        "--fragment-retries", "5",
        "--socket-timeout", "30",
        "--add-header", "Accept-Language:en-US,en;q=0.9",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "-o", &out_tpl,
    ];

    // Point yt-dlp at our bundled ffmpeg so it can merge split streams (required for 1080p+).
    if let Some(ref fp) = ffmpeg_path_str {
        base_args.extend_from_slice(&["--ffmpeg-location", fp]);
    }

    let is_youtube   = url.contains("youtube.com")   || url.contains("youtu.be");
    let is_pinterest = url.contains("pinterest.")    || url.contains("pin.it");
    let is_instagram = url.contains("instagram.com") || url.contains("instagr.am");
    let is_tiktok    = url.contains("tiktok.com");
    let needs_auth   = is_instagram || is_tiktok;

    // Resolve browser cookie file before format selection — needed to pick the right
    // YouTube player client (web client unlocks 1080p split streams when cookies supply PO tokens).
    let cookie_file_path: Option<String> = ext_id.as_ref().and_then(|eid| {
        app.state::<crate::AppState>()
            .cookie_files.lock().unwrap()
            .remove(eid)
    });

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
            let _ = app.emit("download:error", serde_json::json!({
                "download_id": download_id,
                "message": "Couldn't read the video link — open the video page first",
            }));
            if let Some(ref eid) = ext_id {
                set_ext_progress(&app, eid, 0.0, "", "error",
                    "Couldn't read the video link — open the video page first");
            }
            return;
        }
    }

    // Build the YouTube player-client extractor arg here so the String lives long
    // enough for base_args (&str borrows from it until Command::spawn() below).
    // android_vr: split streams without PO tokens, accepts account cookies.
    // web_embedded: fallback for publicly embeddable videos (no token needed).
    // tv: exposes full format list once authenticated via cookies.
    let yt_clients_arg = if is_youtube {
        format!("youtube:player_client={}",
            if effective_cookie_path.is_some() { "tv,android_vr" } else { "android_vr,web_embedded" })
    } else {
        String::new()
    };

    if is_youtube {
        if quality == "medium" {
            // Same client chain as best — height cap is the only difference.
            // Avoids the mweb-only trap where format 22 absent → silent 360p fallback.
            base_args.extend_from_slice(&[
                "--format",
                "bv*[height<=720]+ba/b[height<=720]/b",
                "--format-sort", "res:720,fps,vcodec:h264:vp9:av01,acodec:aac:opus",
            ]);
        } else {
            // Best: up to 4K.  Resolution is the primary sort key so VP9/AV1 4K is
            // not suppressed in favour of lower-resolution h264.
            base_args.extend_from_slice(&[
                "--format",
                "bv*[height<=2160]+ba/b[height<=2160]/b",
                "--format-sort", "res:2160,fps,vcodec:vp9.2:av01:vp9:h264,acodec:opus:aac",
            ]);
        }
        base_args.extend_from_slice(&["--print", "before_dl:%(format_id)s %(height)s %(vcodec)s"]);
        base_args.extend_from_slice(&["--extractor-args", yt_clients_arg.as_str()]);
    } else if quality == "medium" {
        base_args.extend_from_slice(&[
            "--format",
            "bestvideo[height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best",
            "--format-sort", "vcodec:h264:vp9:av01,res:720,fps",
        ]);
    } else {
        base_args.extend_from_slice(&[
            "--format",
            "bestvideo[height<=2160]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
            "--format-sort", "vcodec:h264:vp9:av01,res:2160,fps",
        ]);
    }
    // Instagram: when we have session cookies (from extension or user cookies.txt), let yt-dlp
    // choose the best API automatically — forcing graphql conflicts with the bloks auth flow
    // that Instagram requires for cookie-authenticated downloads.  Without cookies, graphql
    // is still the best bet for public content.
    if is_instagram && effective_cookie_path.is_none() && auto_cookie_browser.is_none() {
        base_args.extend_from_slice(&["--extractor-args", "instagram:api=graphql"]);
    }

    if let Some(cp) = effective_cookie_path {
        base_args.extend_from_slice(&["--cookies", cp]);
        let cookie_source = if cookie_file_path.is_some() { "extension" } else { "user_cookies_txt" };
        log::debug!(target: "Download", "cookie_source={cookie_source} download_id={download_id}");
    } else if let Some(browser) = auto_cookie_browser {
        base_args.extend_from_slice(&["--cookies-from-browser", browser]);
        log::debug!(target: "Download", "cookie_source=browser_{browser} download_id={download_id}");
    } else if needs_auth {
        // No cookie source — limit retries so the user gets a fast failure.
        base_args.extend_from_slice(&["--retries", "1", "--fragment-retries", "1"]);
        log::warn!(target: "Download", "cookie_source=none needs_auth=true download_id={download_id}");
    }

    base_args.push(&url);

    // Snapshot tmp_dir BEFORE spawning so the diff after exit is accurate.
    let pre_files: std::collections::HashSet<std::path::PathBuf> =
        std::fs::read_dir(&tmp_dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .collect();

    let mut child = match hidden_command(&binary)
        .args(&base_args)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => {
            log::info!(target: "Download", "spawned pid={:?} download_id={download_id}", c.id());
            active_pids().lock().unwrap().insert(download_id.clone(), c.id());
            if let Some(ref eid) = ext_id {
                app.state::<crate::AppState>().ext_id_map.lock().unwrap()
                    .insert(download_id.clone(), eid.clone());
                set_ext_progress(&app, eid, 0.0, "", "downloading", "");
            }
            c
        }
        Err(e) => {
            let _ = app.emit("download:error", serde_json::json!({
                "download_id": download_id,
                "message": format!("yt-dlp not found: {}", e),
            }));
            if let Some(ref eid) = ext_id {
                set_ext_progress(&app, eid, 0.0, "", "error", "yt-dlp not found");
            }
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
                    #[cfg(windows)]
                    hidden_command("taskkill")
                        .args(["/F", "/PID", &pid.to_string()])
                        .spawn().ok();
                    #[cfg(not(windows))]
                    hidden_command("kill")
                        .args(["-9", &pid.to_string()])
                        .spawn().ok();
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

    for line in BufReader::new(stdout).lines().flatten() {
        log::debug!(target: "Download", "stdout={:?}", line);
        if line.starts_with("[download] Destination:") {
            // Emit the real filename as soon as yt-dlp chooses it — before any bytes download.
            let filename = line
                .trim_start_matches("[download] Destination:")
                .trim()
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .to_string();
            if !filename.is_empty() {
                let _ = app_out.emit("download:filename", serde_json::json!({
                    "download_id": did_out,
                    "filename":    filename,
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

    // Delete the temp cookie file now that yt-dlp has finished.
    if let Some(ref cp) = cookie_file_path {
        std::fs::remove_file(cp).ok();
        log::debug!(target: "Download", "cookie_file_deleted path={:?}", cp);
    }

    // Discover files written by yt-dlp: anything new in tmp_dir that isn't
    // a partial download or metadata artifact.
    const SKIP_EXTS: &[&str] = &["part", "ytdl", "json", "description", "annotations"];
    let final_paths: Vec<String> = std::fs::read_dir(&tmp_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if pre_files.contains(&path) { return None; }
            let ext = path.extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_lowercase();
            if SKIP_EXTS.contains(&ext.as_str()) { return None; }
            path.to_str().map(|s| s.to_string())
        })
        .collect();
    log::info!(target: "Download", "files_ready count={} download_id={download_id}", final_paths.len());

    // Extract a human-readable error from stderr for failure cases.
    let stderr_text = std::sync::Arc::try_unwrap(stderr_lines_shared)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();

    match exit_status {
        Ok(s) if s.success() => {
            if final_paths.is_empty() {
                log::warn!(target: "Download", "no_output_files download_id={download_id}");
                let _ = app.emit("download:error", serde_json::json!({
                    "download_id": download_id,
                    "message": "yt-dlp produced no importable files",
                }));
                if let Some(ref eid) = ext_id {
                    set_ext_progress(&app, eid, 0.0, "", "error", "No output files — try again");
                }
                return;
            }
            let _ = app.emit("download:complete", serde_json::json!({
                "download_id": download_id,
                "paths": final_paths,
                "url":   url,
            }));
            if let Some(ref eid) = ext_id { set_ext_progress(&app, eid, 1.0, "", "finalizing", "Saving to library…"); }
        }
        Ok(_) => {
            // Pinterest image-pin fallback: the bundled yt-dlp doesn't expose
            // image formats for image-only pins, but it CAN download the pin's
            // thumbnail (which IS the original image on Pinterest).
            let no_video_formats = stderr_text.contains("No video formats found");
            if is_pinterest && no_video_formats {
                let fallback = pinterest_image_fallback(&binary, &url, &tmp_dir, &pre_files);
                if !fallback.is_empty() {
                    let _ = app.emit("download:complete", serde_json::json!({
                        "download_id": download_id,
                        "paths": fallback,
                        "url":   url,
                    }));
                    if let Some(ref eid) = ext_id { set_ext_progress(&app, eid, 1.0, "", "finalizing", "Saving to library…"); }
                    return;
                }
            }

            // Clean up orphaned fragment files left by a failed split-stream download.
            // yt-dlp names them like "Title.f137.mp4" / "Title.f140.m4a" — the ".fNNN."
            // pattern identifies unmerged stream fragments that should not be imported.
            for path in &final_paths {
                let name = std::path::Path::new(path)
                    .file_name().and_then(|n| n.to_str()).unwrap_or("");
                let is_fragment = {
                    let mut found = false;
                    let bytes = name.as_bytes();
                    for i in 0..bytes.len().saturating_sub(2) {
                        if bytes[i] == b'.' && bytes[i+1] == b'f' {
                            let rest = &name[i+2..];
                            let digits: usize = rest.chars().take_while(|c| c.is_ascii_digit()).count();
                            if digits > 0 && rest.len() > digits && rest.as_bytes()[digits] == b'.' {
                                found = true;
                                break;
                            }
                        }
                    }
                    found
                };
                if is_fragment {
                    let _ = std::fs::remove_file(path);
                    log::debug!(target: "Download", "fragment_removed path={:?}", path);
                }
            }

            // YouTube split-stream (1080p) 503 fallback: retry with 720p combined stream.
            // Split streams require PO tokens that yt-dlp 2026.03.17 doesn't auto-generate.
            // Combined streams (format 22, 720p h264) work without PO tokens.
            // Update the bundled yt-dlp binary to a newer version to restore 1080p support.
            let is_503 = stderr_text.contains("HTTP Error 503");
            if is_youtube && is_503 {
                log::warn!(target: "Download", "youtube_503 download_id={download_id} retrying=720p_fallback");

                // Unfreeze the progress bar — the UI has had no update since the
                // last stderr line while we wait for the rate limit to reset.
                let _ = app.emit("download:progress", serde_json::json!({
                    "download_id": download_id,
                    "pct": 0.5_f64,
                    "speed": "retrying at 720p…",
                }));

                // Wait for YouTube's per-IP rate limit to reset after the failed
                // split-stream attempt burned through 5 retries on the video CDN.
                std::thread::sleep(std::time::Duration::from_secs(12));

                // Only try format 22 (720p progressive h264, no PO token needed).
                // Avoid falling through to HLS formats 95/94 — they are also
                // CDN-rate-limited after the first attempt's 5 retries.
                let fallback_format = if quality == "medium" { "22" } else { "22" };

                // Delete all files that appeared during the failed first attempt so
                // yt-dlp doesn't try to resume/merge stale partial streams.
                if let Ok(entries) = std::fs::read_dir(&tmp_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if !pre_files.contains(&path) {
                            let _ = std::fs::remove_file(&path);
                            log::debug!(target: "Download", "fallback_cleanup removed={:?}", path);
                        }
                    }
                }

                let pre_fallback: std::collections::HashSet<std::path::PathBuf> =
                    std::fs::read_dir(&tmp_dir).into_iter().flatten().flatten()
                        .map(|e| e.path()).collect();

                let mut fallback_args: Vec<&str> = vec![
                    "--no-playlist",
                    "--merge-output-format", "mp4",
                    "--retries", "5", "--fragment-retries", "5",
                    "--socket-timeout", "30",
                    "--force-overwrites",
                    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                    "-o", &out_tpl,
                ];
                if let Some(ref fp) = ffmpeg_path_str {
                    fallback_args.extend_from_slice(&["--ffmpeg-location", fp]);
                }
                fallback_args.extend_from_slice(&["--format", fallback_format, &url]);

                let fallback_output = hidden_command(&binary)
                    .args(&fallback_args)
                    .env("PYTHONUNBUFFERED", "1")
                    .env("PYTHONIOENCODING", "utf-8")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .output();

                let fallback_ok = fallback_output.as_ref()
                    .map(|o| {
                        let stderr = String::from_utf8_lossy(&o.stderr);
                        if !stderr.trim().is_empty() {
                            log::debug!(target: "Download", "fallback_stderr={:?}", &*stderr);
                        }
                        o.status.success()
                    })
                    .unwrap_or(false);

                let fallback_paths: Vec<String> = std::fs::read_dir(&tmp_dir)
                    .into_iter().flatten().flatten()
                    .filter_map(|e| {
                        let path = e.path();
                        if pre_fallback.contains(&path) { return None; }
                        let ext = path.extension().and_then(|x| x.to_str())
                            .unwrap_or("").to_lowercase();
                        if SKIP_EXTS.contains(&ext.as_str()) { return None; }
                        path.to_str().map(|s| s.to_string())
                    })
                    .collect();

                log::info!(target: "Download", "fallback_result ok={fallback_ok} paths={}", fallback_paths.len());

                if !fallback_paths.is_empty() {
                    let _ = app.emit("download:complete", serde_json::json!({
                        "download_id": download_id,
                        "paths": fallback_paths,
                        "url":   url,
                    }));
                    if let Some(ref eid) = ext_id { set_ext_progress(&app, eid, 1.0, "", "finalizing", "Saving to library…"); }
                    return;
                }
            }

            // Extract the most useful error line from yt-dlp's stderr output.
            let raw_err = stderr_text
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
            } else if is_chrome_cookie_err {
                "Chrome blocks cookie access on Windows. Open the link in Chrome and save it via the qooti extension — it sends your session automatically.".to_string()
            } else if needs_auth && effective_cookie_path.is_none() && auto_cookie_browser.is_none() && (is_auth_err || raw_err.is_empty()) {
                "Open the link in Chrome and save it with the qooti extension.".to_string()
            } else if !raw_err.is_empty() {
                raw_err
            } else {
                "Download failed — the URL may be private or unsupported.".to_string()
            };
            let _ = app.emit("download:error", serde_json::json!({
                "download_id": download_id,
                "message": msg.clone(),
            }));
            if let Some(ref eid) = ext_id { set_ext_progress(&app, eid, 0.0, "", "error", &msg); }
        }
        Err(e) => {
            let e_str = e.to_string();
            let _ = app.emit("download:error", serde_json::json!({
                "download_id": download_id,
                "message": e_str.clone(),
            }));
            if let Some(ref eid) = ext_id { set_ext_progress(&app, eid, 0.0, "", "error", &e_str); }
        }
    }
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
    let html = match ureq::get(url).set("User-Agent", ua).call() {
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

    // Step 3: download the image bytes directly
    let response = match ureq::get(&image_url).set("User-Agent", ua).call() {
        Ok(r)  => r,
        Err(e) => { log::warn!(target: "Download", "pinterest_img_download_err error={e}"); return vec![]; }
    };
    let mut bytes: Vec<u8> = Vec::new();
    if let Err(e) = response.into_reader().read_to_end(&mut bytes) {
        log::warn!(target: "Download", "pinterest_img_read_err error={e}");
        return vec![];
    }

    // Step 4: save with correct extension and return path
    let ext = image_url.split('?').next()
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

    {
        let db = state.db.lock().unwrap();
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM inspirations WHERE file_hash = ?1",
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
    let aspect_ratio = video_ratio.unwrap_or(default_ratio);

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
        auto_tag_confidence: None,
        auto_tag_model: None,
        duration_secs: duration,
        collection_names: None,
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

fn stream_hash(path: &std::path::Path) -> std::io::Result<String> {
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
        prog.message    = "Save failed".to_string();
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
    let resp = ureq::get(&thumb_url).set("User-Agent", ua).call()
        .or_else(|_| {
            let fb = format!("https://img.youtube.com/vi/{}/hqdefault.jpg", video_id);
            ureq::get(&fb).set("User-Agent", ua).call()
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

fn get_plan_from_db(db: &rusqlite::Connection) -> String {
    db.query_row(
        "SELECT value FROM preferences WHERE key = 'plan'",
        [],
        |r| r.get::<_, String>(0),
    ).unwrap_or_else(|_| "free".to_string())
}

fn is_free_plan(plan: &str) -> bool {
    !plan.starts_with("pro")
}

// Returns true if this collection is read-only for the current (free) plan user.
// A collection is locked when it's not among the FREE_COLLECTION_LIMIT oldest ones.
fn is_collection_locked(db: &rusqlite::Connection, collection_id: &str) -> bool {
    let plan = get_plan_from_db(db);
    if !is_free_plan(&plan) { return false; }
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ─── URL duplicate check ─────────────────────────────────────────

#[tauri::command]
pub fn check_url_exists(url: String, state: State<AppState>) -> Result<Option<Inspiration>, String> {
    let db = state.db.lock().unwrap();
    db.query_row(
        "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
                aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
                phash, phash_source, vault_id, mime_type, created_at, updated_at,
                auto_tag_status, auto_tag_confidence, auto_tag_model, duration_secs,
                (SELECT json_group_array(c.name) FROM collection_items ci
                 JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names
         FROM inspirations WHERE source_url = ?1 LIMIT 1",
        params![url],
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

// ─── Collection-context tag propagation ──────────────────────────
// For each collection where ≥70% of tagged items share a tag,
// inject that tag as a suggestion into untagged items in the same collection.
// Returns the number of items updated.

#[tauri::command]
pub fn apply_collection_tag_suggestions(state: State<AppState>) -> Result<i64, String> {
    let db = state.db.lock().unwrap();

    let sql = "
        WITH
        col_tagged AS (
            SELECT ci.collection_id, COUNT(DISTINCT ci.inspiration_id) AS cnt
            FROM collection_items ci
            JOIN inspiration_tags it ON it.inspiration_id = ci.inspiration_id
            GROUP BY ci.collection_id
            HAVING cnt >= 3
        ),
        tag_freq AS (
            SELECT ci.collection_id, t.name AS tag_name,
                   COUNT(DISTINCT ci.inspiration_id) AS freq
            FROM collection_items ci
            JOIN inspiration_tags it ON it.inspiration_id = ci.inspiration_id
            JOIN tags t ON t.id = it.tag_id
            GROUP BY ci.collection_id, t.name
        ),
        dominant AS (
            SELECT tf.collection_id, tf.tag_name,
                   CAST(tf.freq AS REAL) / ct.cnt AS confidence
            FROM tag_freq tf
            JOIN col_tagged ct ON ct.collection_id = tf.collection_id
            WHERE CAST(tf.freq AS REAL) / ct.cnt >= 0.70
        )
        SELECT DISTINCT i.id, d.tag_name, d.confidence, i.auto_tag_confidence
        FROM dominant d
        JOIN collection_items ci ON ci.collection_id = d.collection_id
        JOIN inspirations i ON i.id = ci.inspiration_id
        WHERE NOT EXISTS (
            SELECT 1 FROM inspiration_tags it WHERE it.inspiration_id = i.id
        )
        AND (i.auto_tag_confidence IS NULL
             OR i.auto_tag_confidence NOT LIKE '%\"' || d.tag_name || '\"%')
        ORDER BY d.confidence DESC
    ";

    let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, f64, Option<String>)> = stmt
        .query_map([], |row| Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, f64>(2)?,
            row.get::<_, Option<String>>(3)?,
        )))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() { return Ok(0); }

    // Group by inspiration_id so each item gets one UPDATE with all its new suggestions
    let mut by_item: HashMap<String, serde_json::Map<String, serde_json::Value>> = HashMap::new();
    for (id, tag_name, confidence, current_conf) in &rows {
        let map = by_item.entry(id.clone()).or_insert_with(|| {
            current_conf.as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default()
        });
        map.entry(tag_name.clone()).or_insert(serde_json::json!(confidence));
    }

    let mut updated = 0i64;
    for (id, conf_map) in &by_item {
        let conf_str = serde_json::to_string(conf_map).map_err(|e| e.to_string())?;
        db.execute(
            "UPDATE inspirations SET auto_tag_confidence = ?1 WHERE id = ?2",
            params![conf_str, id],
        ).map_err(|e| e.to_string())?;
        updated += 1;
    }

    Ok(updated)
}

// ─── Recommendation queries ───────────────────────────────────────

const INSP_SELECT: &str =
    "SELECT id, type, title, source_url, source_platform, stored_path, thumbnail_path,
            aspect_ratio, palette, ocr_text, ocr_status, ocr_language, file_hash,
            phash, phash_source, vault_id, mime_type, created_at, updated_at,
            auto_tag_status, auto_tag_confidence, auto_tag_model, duration_secs,
            (SELECT json_group_array(c.name) FROM collection_items ci
             JOIN collections c ON c.id = ci.collection_id
             WHERE ci.inspiration_id = inspirations.id) AS collection_names
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
                auto_tag_status, auto_tag_confidence, auto_tag_model, duration_secs,
                (SELECT json_group_array(c.name) FROM collection_items ci
                 JOIN collections c ON c.id = ci.collection_id
                 WHERE ci.inspiration_id = inspirations.id) AS collection_names
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
    // 1. Wipe all user-content tables (preferences, license_cache, tag_vocab, schema_meta preserved)
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.execute_batch(
            "DELETE FROM inspirations;
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

