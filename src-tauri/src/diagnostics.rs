// Diagnostics for feedback reports (see src/modules/diagnostics.js, which formats them).
//
// `diagnostics_snapshot` gathers what a bug report needs and a user can't tell us:
// OS / hardware / install location, storage, library health, helper tools, license
// state, recent downloads, plus this session's backend log and the previous run's
// (logger.rs keeps both). Secrets never leave: the license key, extension key and
// cookie file are reported only as set / not set, and the frontend shortens paths
// under the home folder to "~" before anything is sent.
//
// `log_frontend` lets the webview write into the same log, so the file on disk is one
// timeline (what the user did + what the backend did) that survives a crash.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use crate::{AppState, logger, vault};

/// Tool versions discovered elsewhere (e.g. the yt-dlp probe at boot), so a report
/// doesn't have to spawn slow binaries.
fn tool_versions() -> &'static Mutex<BTreeMap<String, String>> {
    static V: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(BTreeMap::new()))
}
pub fn set_tool_version(tool: &str, version: &str) {
    if let Ok(mut v) = tool_versions().lock() { v.insert(tool.to_string(), version.trim().to_string()); }
}

/// Settings that are safe and useful to include verbatim. Anything else in the
/// preferences table is left out (tokens, keys, profile image, display name…).
const SAFE_SETTINGS: &[&str] = &[
    "language", "theme", "plan", "download_quality", "grid_density", "save_source_url",
    "show_collection_label", "show_platform_label", "tag_recommendations_enabled",
    "show_download_toast", "onboarding_state", "walkthrough_done", "logged_in_at",
    "last_account_sync_at", "autostart_initialized", "image_ratios_backfilled",
    "ytdlp_update_checked_at", "app_dl_count", "app_dl_date", "ext_dl_count", "ext_dl_date",
];
/// Present/absent only.
const SECRET_SETTINGS: &[&str] = &["extension_connection_key", "cookies_txt_path", "device_id", "bloot_id"];

#[tauri::command]
pub async fn diagnostics_snapshot(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(snapshot(&app)))
        .await.map_err(|e| e.to_string())?
}

/// Webview → backend log. `lines` = [[level, target, message], …] (batched by the
/// frontend; targets are prefixed "UI" so they're easy to tell apart).
#[tauri::command]
pub fn log_frontend(lines: Vec<(String, String, String)>) {
    for (level, target, msg) in lines.into_iter().take(200) {
        let target = if target.is_empty() { "UI".to_string() } else { format!("UI:{}", target.chars().take(24).collect::<String>()) };
        let msg: String = msg.chars().take(4000).collect();
        logger::frontend(&level, &target, &msg);
    }
}

fn snapshot(app: &AppHandle) -> Value {
    let data_dir = app.path().app_data_dir().ok();
    let vault_path = vault::get_vault_path(app).ok();
    let (library, settings, license, downloads) = match app.state::<AppState>().db.lock() {
        Ok(db) => (library(&db, vault_path.as_deref()), settings(&db), license(&db), downloads(&db)),
        Err(_) => (json!({ "error": "database busy" }), json!({}), json!({}), json!([])),
    };
    let prev = logger::previous_session();
    json!({
        "app": {
            "version":         app.package_info().version.to_string(),
            "build":           if cfg!(debug_assertions) { "debug" } else { "release" },
            "session_started": logger::session_started(),
            "install":         install_location(),
            "log_dir":         logger::log_dir().map(|p| p.to_string_lossy().to_string()),
        },
        "os":       os_info(),
        "webview":  tauri::webview_version().unwrap_or_else(|e| format!("unknown ({e})")),
        "home":     home_dir(),
        "storage":  storage(app, data_dir.as_deref(), vault_path.as_deref()),
        "library":  library,
        "tools":    tools(app, data_dir.as_deref()),
        "settings": settings,
        "license":  license,
        "downloads": downloads,
        "log":      logger::session_lines(),
        "previous_session": prev,
    })
}

// ─── System ──────────────────────────────────────────────────────

fn home_dir() -> Option<String> {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok().filter(|s| !s.is_empty())
}

/// Where the app runs from — several support problems are really install problems
/// (running from the DMG, macOS App Translocation, a copy in Downloads…).
fn install_location() -> String {
    let Ok(exe) = std::env::current_exe() else { return "unknown".into() };
    let p = exe.to_string_lossy().to_string();
    let lower = p.to_lowercase().replace('\\', "/");
    let kind = if lower.contains("/target/debug/") || lower.contains("/target/release/") { "dev build" }
        else if lower.contains("/apptranslocation/") { "macOS App Translocation (quarantined copy — move qooti to Applications)" }
        else if lower.starts_with("/volumes/") { "running from a mounted disk image (not installed)" }
        else if lower.starts_with("/applications/") { "/Applications" }
        else if lower.contains("/program files") { "Program Files (all users)" }
        else if lower.contains("/appdata/local/") { "AppData\\Local (current user)" }
        else if lower.contains("/downloads/") { "Downloads folder (not installed)" }
        else { "custom location" };
    format!("{kind} — {p}")
}

fn os_info() -> Value {
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let (ram_total, ram_free) = memory();
    json!({
        "name":    os_name(),
        "arch":    std::env::consts::ARCH,
        "cpus":    cpus,
        "ram_total_mb": ram_total.map(|b| b / 1_048_576),
        "ram_free_mb":  ram_free.map(|b| b / 1_048_576),
        "rosetta": rosetta(),
    })
}

#[cfg(windows)]
fn os_name() -> String {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion") else {
        return "Windows".into();
    };
    let get = |n: &str| k.get_value::<String, _>(n).unwrap_or_default();
    let build = get("CurrentBuild");
    let ubr: u32 = k.get_value("UBR").unwrap_or(0);
    // ProductName still says "Windows 10" on Windows 11; the build number tells them apart.
    let mut product = get("ProductName");
    if build.parse::<u32>().unwrap_or(0) >= 22000 { product = product.replacen("Windows 10", "Windows 11", 1); }
    format!("{product} {} (build {build}.{ubr})", get("DisplayVersion")).replace("  ", " ")
}

#[cfg(target_os = "macos")]
fn os_name() -> String {
    let run = |a: &str| std::process::Command::new("sw_vers").arg(a).output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    format!("macOS {} ({})", run("-productVersion"), run("-buildVersion"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn os_name() -> String { std::env::consts::OS.to_string() }

#[cfg(target_os = "macos")]
fn rosetta() -> Option<bool> {
    let o = std::process::Command::new("sysctl").args(["-n", "sysctl.proc_translated"]).output().ok()?;
    Some(String::from_utf8_lossy(&o.stdout).trim() == "1")
}
#[cfg(not(target_os = "macos"))]
fn rosetta() -> Option<bool> { None }

#[cfg(windows)]
fn memory() -> (Option<u64>, Option<u64>) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 { (Some(m.ullTotalPhys), Some(m.ullAvailPhys)) } else { (None, None) }
}
#[cfg(target_os = "macos")]
fn memory() -> (Option<u64>, Option<u64>) {
    let total = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok());
    (total, None)
}
#[cfg(not(any(windows, target_os = "macos")))]
fn memory() -> (Option<u64>, Option<u64>) { (None, None) }

// ─── Storage ─────────────────────────────────────────────────────

fn storage(app: &AppHandle, data_dir: Option<&Path>, vault_path: Option<&Path>) -> Value {
    let custom = vault::read_custom_vault_path(app).ok().flatten().is_some();
    let file_mb = |p: PathBuf| std::fs::metadata(p).ok().map(|m| (m.len() as f64 / 1_048_576.0 * 10.0).round() / 10.0);
    json!({
        "data_dir":       data_dir.map(|p| p.to_string_lossy().to_string()),
        "vault":          vault_path.map(|p| p.to_string_lossy().to_string()),
        "vault_custom":   custom,
        "vault_exists":   vault_path.is_some_and(|p| p.is_dir()),
        "vault_writable": vault_path.map(writable),
        "vault_free_mb":  vault_path.and_then(|p| vault::disk_free_bytes(&p.to_path_buf())).map(|b| b / 1_048_576),
        "data_free_mb":   data_dir.and_then(|p| vault::disk_free_bytes(&p.to_path_buf())).map(|b| b / 1_048_576),
        "db_mb":          data_dir.and_then(|d| file_mb(d.join("qooti.db"))),
        "db_wal_mb":      data_dir.and_then(|d| file_mb(d.join("qooti.db-wal"))),
    })
}

/// Can we actually create a file in the vault? (Permissions, read-only or offline drives.)
fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".qooti-write-test-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

// ─── Library ─────────────────────────────────────────────────────

fn count(db: &Connection, sql: &str) -> Option<i64> { db.query_row(sql, [], |r| r.get(0)).ok() }

fn histogram(db: &Connection, sql: &str) -> Value {
    let mut out = serde_json::Map::new();
    if let Ok(mut st) = db.prepare(sql) {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?))) {
            for (k, n) in rows.flatten() { out.insert(k.unwrap_or_else(|| "none".into()), json!(n)); }
        }
    }
    Value::Object(out)
}

fn library(db: &Connection, vault_path: Option<&Path>) -> Value {
    // Spot-check that the newest items' files still exist (moved/deleted vault, offline drive…).
    let mut checked = 0; let mut missing = 0; let mut examples: Vec<String> = Vec::new();
    if let Ok(mut st) = db.prepare("SELECT stored_path FROM inspirations ORDER BY created_at DESC LIMIT 2000") {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
            for p in rows.flatten() {
                checked += 1;
                if !Path::new(&p).exists() {
                    missing += 1;
                    if examples.len() < 3 { examples.push(p); }
                }
            }
        }
    }
    // Paths that aren't inside the current vault point at an old/moved vault.
    let outside_vault = vault_path.and_then(|v| {
        let v = v.to_string_lossy().to_string();
        db.query_row("SELECT COUNT(*) FROM inspirations WHERE substr(stored_path, 1, length(?1)) != ?1", [v], |r| r.get::<_, i64>(0)).ok()
    });
    let (oldest, newest): (Option<i64>, Option<i64>) = db.query_row(
        "SELECT MIN(created_at), MAX(created_at) FROM inspirations", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap_or((None, None));
    let schema = db.query_row("SELECT value FROM schema_meta WHERE key = 'version'", [], |r| r.get::<_, String>(0)).ok();

    json!({
        "by_type":        histogram(db, "SELECT type, COUNT(*) FROM inspirations GROUP BY type"),
        "total":          count(db, "SELECT COUNT(*) FROM inspirations"),
        "collections":    count(db, "SELECT COUNT(*) FROM collections"),
        "tags":           count(db, "SELECT COUNT(*) FROM tags"),
        "schema_version": schema,
        "oldest":         oldest.map(to_iso),
        "newest":         newest.map(to_iso),
        "files_checked":  checked,
        "files_missing":  missing,
        "missing_examples": examples,
        "outside_vault":  outside_vault,
        "videos_without_thumbnail": count(db, "SELECT COUNT(*) FROM inspirations WHERE type = 'video' AND thumbnail_path IS NULL"),
        "without_palette": count(db, "SELECT COUNT(*) FROM inspirations WHERE palette IS NULL AND type IN ('image','gif')"),
        "ocr_status":     histogram(db, "SELECT ocr_status, COUNT(*) FROM inspirations GROUP BY ocr_status"),
        "auto_tag_status": histogram(db, "SELECT auto_tag_status, COUNT(*) FROM inspirations GROUP BY auto_tag_status"),
        "similar_index":  histogram(db, "SELECT model, COUNT(*) FROM clip_embeddings GROUP BY model"),
        "ext_queue":      count(db, "SELECT COUNT(*) FROM ext_download_queue"),
    })
}

/// created_at is milliseconds for items (seconds in a few older columns) → ISO date.
fn to_iso(t: i64) -> String {
    let ms = if t > 100_000_000_000 { t } else { t * 1000 };
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

fn settings(db: &Connection) -> Value {
    let mut out = serde_json::Map::new();
    if let Ok(mut st) = db.prepare("SELECT key, value FROM preferences") {
        if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))) {
            for (k, v) in rows.flatten() {
                if SAFE_SETTINGS.contains(&k.as_str()) {
                    out.insert(k, json!(v.unwrap_or_default().chars().take(80).collect::<String>()));
                } else if SECRET_SETTINGS.contains(&k.as_str()) {
                    out.insert(k, json!(if v.is_some_and(|v| !v.is_empty()) { "(set)" } else { "(empty)" }));
                }
            }
        }
    }
    Value::Object(out)
}

fn license(db: &Connection) -> Value {
    db.query_row(
        "SELECT license_key IS NOT NULL AND license_key != '', plan_type, expires_at, last_validated_at, revoked_at FROM license_cache WHERE id = 1",
        [],
        |r| Ok(json!({
            "key_present":       r.get::<_, bool>(0)?,
            "plan":              r.get::<_, Option<String>>(1)?,
            "expires_at":        r.get::<_, Option<i64>>(2)?.map(to_iso),
            "last_validated_at": r.get::<_, Option<i64>>(3)?,
            "revoked":           r.get::<_, Option<i64>>(4)?.is_some(),
        })),
    ).optional().ok().flatten().unwrap_or(json!(null))
}

/// The last few download attempts with their outcome (the Activity view's table).
fn downloads(db: &Connection) -> Value {
    let mut out = Vec::new();
    if let Ok(mut st) = db.prepare(
        "SELECT url, quality, import_source, status, error_msg, created_at FROM download_sessions ORDER BY created_at DESC LIMIT 10"
    ) {
        if let Ok(rows) = st.query_map([], |r| Ok(json!({
            "url":     r.get::<_, String>(0)?,
            "quality": r.get::<_, String>(1)?,
            "source":  r.get::<_, String>(2)?,
            "status":  r.get::<_, String>(3)?,
            "error":   r.get::<_, Option<String>>(4)?.map(|e| e.chars().take(300).collect::<String>()),
            "at":      r.get::<_, i64>(5)?,
        }))) {
            out.extend(rows.flatten());
        }
    }
    Value::Array(out)
}

// ─── Helper tools ────────────────────────────────────────────────

fn tools(app: &AppHandle, data_dir: Option<&Path>) -> Value {
    let known = tool_versions().lock().map(|v| v.clone()).unwrap_or_default();
    let ytdlp = crate::commands::ytdlp_binary_path(app);
    let ytdlp_kind = if data_dir.is_some_and(|d| ytdlp.starts_with(d)) { "self-updated copy" } else { "bundled" };
    let ffmpeg = crate::commands::ffmpeg_binary(app);
    let ffmpeg_version = ffmpeg.as_ref().and_then(|p| {
        crate::commands::hidden_command(p).arg("-version").output().ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(|l| l.chars().take(80).collect::<String>()))
    });
    let model = |name: &str| data_dir.map(|d| d.join("models").join(name)).and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len());
    json!({
        "ytdlp": {
            "present": ytdlp.exists(),
            "kind":    ytdlp_kind,
            "version": known.get("yt-dlp"),
        },
        "ffmpeg": { "present": ffmpeg.is_some(), "version": ffmpeg_version },
        "deno":   { "ready": crate::js_runtime::ready_path(app).is_some(), "pinned": crate::js_runtime::DENO_VERSION },
        "po_token_helper": crate::pot_provider::is_downloaded(app),
        "similar_model_bytes": model("clip-vit-base-patch32-vision-q8.onnx"),
        "similar_model_ready": crate::clip::model_ready(app),
        "other": known.iter().filter(|(k, _)| k.as_str() != "yt-dlp").map(|(k, v)| (k.clone(), json!(v))).collect::<serde_json::Map<_, _>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_never_leak_secrets() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO preferences VALUES ('language','uz'), ('extension_connection_key','abc123secret'),
                                           ('profile_image','data:image/png;base64,AAAA'), ('display_name','Someone'),
                                           ('cookies_txt_path',''), ('some_future_key','x');").unwrap();
        let s = settings(&db);
        assert_eq!(s["language"], "uz");
        assert_eq!(s["extension_connection_key"], "(set)");
        assert_eq!(s["cookies_txt_path"], "(empty)");
        assert!(s.get("profile_image").is_none() && s.get("display_name").is_none() && s.get("some_future_key").is_none());
        assert!(!s.to_string().contains("abc123secret"));
    }

    #[test]
    fn timestamps_in_seconds_or_ms() {
        assert_eq!(to_iso(1_700_000_000), "2023-11-14");
        assert_eq!(to_iso(1_700_000_000_000), "2023-11-14");
    }
}
