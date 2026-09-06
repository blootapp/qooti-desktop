// Local HTTP server on port 1420 — bound on all interfaces so the mobile app can reach it.
// Receives payloads from the Chrome extension and mobile app.
//
// Endpoints
//   GET  /extension/ping            — returns version/platform, no auth required
//   POST /extension/pair            — auto-generates connection key on first call, returns it
//   GET  /extension/collections     — returns [{id, name}] list    (requires X-Qooti-Key)
//   POST /extension/save            — queues media for download     (requires X-Qooti-Key)
//   POST /extension/add-to-collection — adds item to collection    (requires X-Qooti-Key)
//   GET  /mobile/ping               — returns version/platform, no auth required
//   POST /mobile/queue              — receive queued links from mobile (requires X-Qooti-Key)
//   POST /mobile/upload             — receive a media file from mobile (requires X-Qooti-Key)

use crate::AppState;
use base64::Engine as _;
use rusqlite::OptionalExtension as _;
#[allow(unused_imports)]
use std::io::Read;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

// Bind on all interfaces so the mobile app (on the same LAN) can reach the desktop.
const PORT: &str = "0.0.0.0:1420";

pub fn start(app: AppHandle) {
    log::info!(target: "ExtServer", "start port={PORT}");
    let server = match Server::http(PORT) {
        Ok(s) => s,
        Err(e) => {
            log::error!(target: "ExtServer", "bind_failed port={PORT} error={e}");
            let notify = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let _ = notify.emit("extension-server-failed", serde_json::json!({
                    "error": format!("Port 1420 is in use. The browser extension won't work until qooti is restarted.")
                }));
            });
            return;
        }
    };

    for mut request in server.incoming_requests() {
        let url    = request.url().to_string();
        let method = request.method().clone();

        // CORS preflight — respond immediately, no auth needed
        if method == Method::Options {
            respond_cors(request);
            continue;
        }

        match (method.as_str(), url.as_str()) {

            // ── Ping (no auth) ────────────────────────────────────
            ("GET", "/extension/ping") => {
                respond_json(request, &serde_json::json!({
                    "version": "2.0.0",
                    "platform": "desktop"
                }));
            }

            // ── Pair (no auth — generates key on first call) ──────
            ("POST", "/extension/pair") => {
                match do_pair(&app) {
                    Ok(key) => {
                        log::info!(target: "ExtServer", "paired");
                        let _ = app.emit("extension-paired", serde_json::json!({}));
                        respond_json(request, &serde_json::json!({ "key": key }));
                    }
                    Err(e) => {
                        log::error!(target: "ExtServer", "pair_failed error={e}");
                        respond_error(request, 500, &e);
                    }
                }
            }

            // ── Collections (auth required) ───────────────────────
            ("GET", "/extension/collections") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                match get_collections(&app) {
                    Ok(cols) => respond_json(request, &cols),
                    Err(e)  => respond_error(request, 500, &e),
                }
            }

            // ── Save (auth required) ──────────────────────────────
            ("POST", "/extension/save") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).ok();
                match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(mut payload) => {
                        // Duplicate check: if this URL is already in the library,
                        // return immediately with the existing inspiration_id — no download needed.
                        let check_url = payload.get("url")
                            .and_then(|v| v.as_str())
                            .or_else(|| payload.get("page_url").and_then(|v| v.as_str()))
                            .unwrap_or("")
                            .to_string();
                        if !check_url.is_empty() {
                            let state = app.state::<crate::AppState>();
                            let existing: Option<String> = {
                                let db = state.db.lock().unwrap();
                                db.query_row(
                                    "SELECT id FROM inspirations WHERE source_url = ?1 LIMIT 1",
                                    [&check_url],
                                    |row| row.get::<_, String>(0),
                                ).optional().unwrap_or(None)
                            };
                            if let Some(existing_id) = existing {
                                log::info!(target: "ExtServer", "save_duplicate url={check_url:?} id={existing_id}");
                                respond_json(request, &serde_json::json!({
                                    "ok": true,
                                    "already_exists": true,
                                    "inspiration_id": existing_id,
                                    "ext_id":  serde_json::Value::Null,
                                    "is_frame": false,
                                }));
                                continue;
                            }
                        }

                        // ── Free plan daily download limit ────────────────────
                        {
                            let state = app.state::<crate::AppState>();
                            let db = state.db.lock().unwrap();
                            let plan = get_plan(&db);
                            if is_free_plan(&plan) {
                                let used = ext_dl_used_today(&db);
                                if used >= FREE_EXT_DAILY_LIMIT {
                                    // Queue the URL for midnight processing
                                    let queue_id = uuid::Uuid::new_v4().to_string();
                                    let q_url    = payload.get("url").and_then(|v| v.as_str()).unwrap_or(&check_url).to_string();
                                    let q_page   = payload.get("page_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    let q_title  = payload.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    let q_plat   = payload.get("source_platform").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    let q_now    = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
                                    let _ = db.execute(
                                        "INSERT OR IGNORE INTO ext_download_queue (id, url, page_url, title, source_platform, queued_at) VALUES (?1,?2,?3,?4,?5,?6)",
                                        rusqlite::params![queue_id, q_url, q_page, q_title, q_plat, q_now],
                                    );
                                    let queued_count: u32 = db.query_row(
                                        "SELECT COUNT(*) FROM ext_download_queue", [], |r| r.get(0)
                                    ).unwrap_or(0);
                                    drop(db);

                                    // Notify the app UI so it can show a toast
                                    let _ = app.emit("ext-save-queued", serde_json::json!({
                                        "queued_count": queued_count,
                                        "used": used,
                                        "limit": FREE_EXT_DAILY_LIMIT,
                                    }));

                                    // Return a fake ext_id whose progress is immediately "error"
                                    // so the extension progress toast shows the limit message.
                                    let fake_id = uuid::Uuid::new_v4().to_string();
                                    {
                                        let state2 = app.state::<crate::AppState>();
                                        let mut prog = state2.ext_progress.lock().unwrap();
                                        prog.insert(fake_id.clone(), crate::ExtProgress {
                                            pct:            1.0,
                                            speed:          String::new(),
                                            status:         "error".to_string(),
                                            message:        format!(
                                                "Daily limit reached ({}/{}). Link saved — downloads resume at midnight.",
                                                FREE_EXT_DAILY_LIMIT, FREE_EXT_DAILY_LIMIT
                                            ),
                                            inspiration_id: None,
                                            updated_at:     std::time::Instant::now(),
                                        });
                                    }
                                    log::info!(target: "ExtServer", "save_queued_limit url={check_url:?} queued_count={queued_count}");
                                    respond_json(request, &serde_json::json!({
                                        "ok": true,
                                        "ext_id": fake_id,
                                        "is_frame": false,
                                        "queued": true,
                                    }));
                                    continue;
                                }
                                // Under the limit — count this save
                                increment_ext_dl_count(&db);
                            }
                        }

                        // Generate a tracking ID the extension can poll for progress
                        let ext_id = uuid::Uuid::new_v4().to_string();
                        if let Some(obj) = payload.as_object_mut() {
                            obj.insert("_ext_id".into(), serde_json::Value::String(ext_id.clone()));
                        }

                        // Extract browser cookies sent by the extension, write to a temp
                        // Netscape file, and store the path keyed by ext_id for yt-dlp.
                        let cookies_str = payload.get("_cookies")
                            .and_then(|v| v.as_str()).map(|s| s.to_string());
                        if let Some(obj) = payload.as_object_mut() { obj.remove("_cookies"); }
                        if let Some(ref cookies) = cookies_str {
                            let tmp = std::env::temp_dir()
                                .join(format!("qooti_cookies_{}.txt", &ext_id));
                            if std::fs::write(&tmp, cookies).is_ok() {
                                let state = app.state::<crate::AppState>();
                                state.cookie_files.lock().unwrap()
                                    .insert(ext_id.clone(), tmp.to_string_lossy().into_owned());
                                log::debug!(target: "ExtServer", "cookie_file_written path={:?}", tmp);
                            }
                        }

                        // Frame capture: data_url field → decode, write temp JPEG, replace with file_path
                        let data_url_opt = payload.get("data_url")
                            .and_then(|v| v.as_str()).map(|s| s.to_string());
                        let is_frame = data_url_opt.is_some();
                        if let Some(data_url) = data_url_opt {
                            match save_frame(&app, &data_url) {
                                Ok(path) => {
                                    let obj = payload.as_object_mut().unwrap();
                                    obj.remove("data_url");
                                    obj.insert("file_path".into(), serde_json::Value::String(path));
                                }
                                Err(e) => log::warn!(target: "ExtServer", "frame_save_failed error={e}"),
                            }
                        }
                        log::info!(target: "ExtServer", "save_queued ext_id={ext_id} is_frame={is_frame}");
                        app.emit("extension-item-received", &payload).ok();
                        respond_json(request, &serde_json::json!({
                            "ok": true,
                            "ext_id": ext_id,
                            "is_frame": is_frame,
                        }));
                    }
                    Err(_) => respond_error(request, 400, "Invalid JSON"),
                }
            }

            // ── Download progress polling (auth required) ─────────
            ("GET", url) if url.starts_with("/extension/download-progress/") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let ext_id = &url["/extension/download-progress/".len()..];
                let state = app.state::<crate::AppState>();
                let mut map = state.ext_progress.lock().unwrap();
                if let Some(prog) = map.get_mut(ext_id) {
                    // Watchdog: auto-expire non-terminal states that have been
                    // stuck longer than their budget.  Prevents immortal toasts
                    // when JS-side finalization silently fails.
                    let budget = match prog.status.as_str() {
                        "finalizing"  => std::time::Duration::from_secs(60),
                        "pending"     => std::time::Duration::from_secs(120),
                        "downloading" => std::time::Duration::from_secs(900),
                        _             => std::time::Duration::MAX,
                    };
                    if prog.updated_at.elapsed() > budget {
                        let old = prog.status.clone();
                        prog.status     = "error".to_string();
                        prog.message    = format!("timed out in {old} state");
                        prog.updated_at = std::time::Instant::now();
                        log::warn!(target: "ExtServer", "watchdog_expired ext_id={ext_id} was={old}");
                    }
                    respond_json(request, &serde_json::json!({
                        "status":         prog.status,
                        "pct":            prog.pct,
                        "speed":          prog.speed,
                        "message":        prog.message,
                        "inspiration_id": prog.inspiration_id,
                    }));
                } else {
                    respond_json(request, &serde_json::json!({
                        "status":         "pending",
                        "pct":            0.0,
                        "speed":          "",
                        "message":        "",
                        "inspiration_id": serde_json::Value::Null,
                    }));
                }
            }

            // ── Open item in app (auth required) ──────────────────
            ("POST", "/extension/open-item") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).ok();
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) {
                    let insp_id = payload.get("inspiration_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if !insp_id.is_empty() {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit("extension:open-item",
                            serde_json::json!({ "inspiration_id": insp_id }));
                    }
                }
                respond_json(request, &serde_json::json!({ "ok": true }));
            }

            // ── Cancel download (auth required) ───────────────────
            ("POST", url) if url.starts_with("/extension/cancel/") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let ext_id = &url["/extension/cancel/".len()..];
                crate::commands::cancel_download_for_ext_id(ext_id, &app);
                respond_json(request, &serde_json::json!({ "ok": true }));
            }

            // ── Pending download (auth required) ──────────────────
            // App queues a URL here when yt-dlp fails due to missing auth cookies.
            // Extension polls every few seconds; claiming pops the slot (one-shot).
            ("GET", "/extension/pending-download") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let state = app.state::<crate::AppState>();
                let pending = state.pending_ext_download.lock().unwrap().take();
                match pending {
                    Some(url) => {
                        log::info!(target: "ExtServer", "pending_download_claimed url={url:?}");
                        respond_json(request, &serde_json::json!({ "url": url }));
                    }
                    None => respond_json(request, &serde_json::json!({ "url": null })),
                }
            }

            // ── Add to collection (auth required) ─────────────────
            ("POST", "/extension/add-to-collection") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).ok();
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) {
                    app.emit("extension-add-to-collection", payload).ok();
                }
                respond_json(request, &serde_json::json!({ "ok": true }));
            }

            // ── Set app preference from extension popup ───────────
            ("POST", "/extension/set-pref") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).ok();
                let payload: serde_json::Value = match serde_json::from_str(&body) {
                    Ok(v)  => v,
                    Err(_) => { respond_error(request, 400, "Bad JSON"); continue; }
                };
                let key   = payload["key"].as_str().unwrap_or("").to_string();
                let value = payload["value"].as_str().unwrap_or("").to_string();
                const ALLOWED: &[&str] = &["show_download_toast"];
                if !ALLOWED.contains(&key.as_str()) {
                    respond_error(request, 400, "Unknown preference key");
                    continue;
                }
                let state = app.state::<crate::AppState>();
                let db = state.db.lock().unwrap();
                db.execute(
                    "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)",
                    rusqlite::params![key, value],
                ).ok();
                drop(db);
                app.emit("ext-pref-changed", serde_json::json!({ "key": key, "value": value })).ok();
                log::info!(target: "ExtServer", "set_pref key={key:?} value={value:?}");
                respond_json(request, &serde_json::json!({ "ok": true }));
            }

            // ── Mobile endpoints ──────────────────────────────────
            ("GET", "/mobile/ping") => {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                app.emit("mobile-connected", serde_json::json!({ "ts": ts })).ok();
                respond_json(request, &serde_json::json!({
                    "version": "2.0.0", "platform": "desktop"
                }));
            }

            ("POST", "/mobile/queue") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).ok();
                let payload: serde_json::Value = match serde_json::from_str(&body) {
                    Ok(v)  => v,
                    Err(_) => { respond_error(request, 400, "Bad JSON"); continue; }
                };
                let items = payload["items"].as_array().cloned().unwrap_or_default();
                let synced_ids: Vec<serde_json::Value> = items.iter()
                    .filter_map(|i| i["id"].as_str().map(|s| serde_json::Value::String(s.to_string())))
                    .collect();
                app.emit("mobile-queue-received", &payload).ok();
                log::info!(target: "ExtServer", "mobile_queue count={}", items.len());
                respond_json(request, &serde_json::json!({ "ok": true, "synced_ids": synced_ids }));
            }

            ("POST", "/mobile/upload") => {
                if !check_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let item_id = header_value(&request, "x-item-id").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let mime    = header_value(&request, "content-type").unwrap_or_else(|| "application/octet-stream".to_string());
                let ext = if mime.contains("video") { "mp4" } else { "jpg" };
                let mut bytes = Vec::new();
                request.as_reader().read_to_end(&mut bytes).ok();
                if bytes.is_empty() {
                    respond_error(request, 400, "Empty body");
                    continue;
                }
                match save_mobile_file(&app, &bytes, &item_id, ext) {
                    Ok(path) => {
                        log::info!(target: "ExtServer", "mobile_upload saved item_id={item_id} path={path}");
                        app.emit("mobile-file-received", serde_json::json!({ "item_id": item_id, "path": path, "mime": mime })).ok();
                        respond_json(request, &serde_json::json!({ "ok": true }));
                    }
                    Err(e) => {
                        log::error!(target: "ExtServer", "mobile_upload error={e}");
                        respond_error(request, 500, "Failed to save file");
                    }
                }
            }

            _ => respond_error(request, 404, "Not Found"),
        }
    }
}

// ── Free plan helpers ────────────────────────────────────────────

const FREE_EXT_DAILY_LIMIT: u32 = 10;

fn get_plan(db: &rusqlite::Connection) -> String {
    db.query_row(
        "SELECT value FROM preferences WHERE key = 'plan'",
        [],
        |r| r.get::<_, String>(0),
    ).unwrap_or_else(|_| "free".to_string())
}

fn is_free_plan(plan: &str) -> bool {
    !plan.starts_with("pro")
}

fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Returns how many extension saves have been counted today (local date).
/// Resets counter automatically when the date has changed.
fn ext_dl_used_today(db: &rusqlite::Connection) -> u32 {
    let stored_date: String = db.query_row(
        "SELECT value FROM preferences WHERE key = 'ext_dl_date'",
        [],
        |r| r.get(0),
    ).unwrap_or_default();

    let today = today_local();
    if stored_date != today {
        let _ = db.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES ('ext_dl_date', ?1)",
            [&today],
        );
        let _ = db.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES ('ext_dl_count', '0')",
            [],
        );
        return 0;
    }

    db.query_row(
        "SELECT CAST(value AS INTEGER) FROM preferences WHERE key = 'ext_dl_count'",
        [],
        |r| r.get::<_, u32>(0),
    ).unwrap_or(0)
}

fn increment_ext_dl_count(db: &rusqlite::Connection) {
    let current = ext_dl_used_today(db);
    let _ = db.execute(
        "INSERT OR REPLACE INTO preferences (key, value) VALUES ('ext_dl_count', ?1)",
        [(current + 1).to_string()],
    );
}

// ── Frame save ───────────────────────────────────────────────────

fn save_frame(app: &AppHandle, data_url: &str) -> Result<String, String> {
    // data_url = "data:image/jpeg;base64,<bytes>"
    let b64 = data_url
        .split_once(',')
        .map(|(_, b)| b)
        .ok_or("invalid data URL")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64)
        .map_err(|e| e.to_string())?;
    let vault = crate::vault::get_vault_path(app).map_err(|e| e.to_string())?;
    let dir   = vault.join("downloads_tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let filename = format!("frame_{}.jpg", uuid::Uuid::new_v4());
    let dest = dir.join(&filename);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

// ── Mobile file save ─────────────────────────────────────────────

fn save_mobile_file(app: &AppHandle, bytes: &[u8], item_id: &str, ext: &str) -> Result<String, String> {
    let vault = crate::vault::get_vault_path(app).map_err(|e| e.to_string())?;
    let dir   = vault.join("mobile_uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let filename = format!("{}_{}.{}", chrono::Local::now().format("%Y%m%d_%H%M%S"), &item_id[..8.min(item_id.len())], ext);
    let dest = dir.join(&filename);
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

fn header_value(request: &tiny_http::Request, name: &str) -> Option<String> {
    for h in request.headers() {
        if h.field.as_str().as_str().eq_ignore_ascii_case(name) {
            return Some(h.value.as_str().to_string());
        }
    }
    None
}

// ── Auth ─────────────────────────────────────────────────────────

fn stored_key(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    db.query_row(
        "SELECT value FROM preferences WHERE key = 'extension_connection_key'",
        [],
        |r| r.get::<_, String>(0),
    ).ok()
}

fn check_auth(request: &tiny_http::Request, app: &AppHandle) -> bool {
    let expected = match stored_key(app) {
        Some(k) => k,
        None    => return false,
    };
    for header in request.headers() {
        if header.field.as_str().as_str().eq_ignore_ascii_case("x-qooti-key") {
            return header.value.as_str() == expected;
        }
    }
    false
}

// ── Pairing ──────────────────────────────────────────────────────

fn do_pair(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    // INSERT OR IGNORE preserves any existing key — prevents invalidating mobile pairing
    // when the browser extension reconnects and calls this endpoint again.
    let candidate = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT OR IGNORE INTO preferences (key, value) VALUES ('extension_connection_key', ?1)",
        [&candidate],
    ).map_err(|e| e.to_string())?;
    // Return the actual stored key (existing or newly inserted)
    let key: String = db.query_row(
        "SELECT value FROM preferences WHERE key = 'extension_connection_key'",
        [],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    Ok(key)
}

// ── Collections ──────────────────────────────────────────────────

fn get_collections(app: &AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name FROM collections ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let cols: Vec<serde_json::Value> = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "id":   row.get::<_, String>(0)?,
            "name": row.get::<_, String>(1)?,
        }))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(serde_json::Value::Array(cols))
}

// ── Response helpers ─────────────────────────────────────────────

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(b"Content-Type",                     b"application/json").unwrap(),
        Header::from_bytes(b"Access-Control-Allow-Origin",      b"*").unwrap(),
        Header::from_bytes(b"Access-Control-Allow-Methods",     b"GET, POST, OPTIONS").unwrap(),
        Header::from_bytes(b"Access-Control-Allow-Headers",     b"Content-Type, X-Qooti-Key").unwrap(),
    ]
}

fn respond_json(request: tiny_http::Request, value: &serde_json::Value) {
    let body = value.to_string();
    let mut r = Response::from_string(body);
    for h in cors_headers() { r = r.with_header(h); }
    request.respond(r).ok();
}

fn respond_cors(request: tiny_http::Request) {
    let mut r = Response::empty(204);
    for h in cors_headers() { r = r.with_header(h); }
    request.respond(r).ok();
}

fn respond_error(request: tiny_http::Request, code: u16, msg: &str) {
    let body = serde_json::json!({ "error": msg }).to_string();
    let mut r = Response::from_string(body).with_status_code(code);
    for h in cors_headers() { r = r.with_header(h); }
    request.respond(r).ok();
}
