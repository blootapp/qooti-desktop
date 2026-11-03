// Local HTTP server on port 1420 — bound on all interfaces so the mobile app can reach it.
// Receives payloads from the Chrome extension and mobile app.
//
// Web pages get nothing here: a request a browser marks as coming from a web page
// (Sec-Fetch-Site), or sent to a name instead of an address (DNS rebinding), is
// answered like an address that doesn't exist — so a site can't even tell qooti is
// installed. The extension's own requests are marked "none"; the phone sends no mark.
//
// Endpoints
//   GET  /extension/ping            — returns version/platform/language, no auth required
//   POST /extension/pair            — a browser extension asks to connect: 202 while the user
//                                     is being asked in the app, then 200 with that browser's
//                                     own key (403 when the user said no)
//   GET  /extension/collections     — returns [{id, name}] list    (requires X-Qooti-Key)
//   POST /extension/save            — queues media for download     (requires X-Qooti-Key)
//   POST /extension/add-to-collection — adds item to collection    (requires X-Qooti-Key)
//   GET  /mobile/ping               — returns version/platform, no auth required
//   POST /mobile/queue              — receive queued links from mobile (requires X-Qooti-Key)
//   POST /mobile/upload             — receive a media file from mobile (requires X-Qooti-Key)

use crate::AppState;
use base64::Engine as _;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
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

        let phone_path = url.starts_with("/mobile/");
        if from_web_page(header_value(&request, "sec-fetch-site").as_deref())
            || !host_ok(header_value(&request, "host").as_deref(), phone_path) {
            respond_error(request, 404, "Not Found");
            continue;
        }

        // CORS preflight — respond immediately, no auth needed
        if method == Method::Options {
            respond_cors(request);
            continue;
        }

        // We listen on the network only for the phone app. Everything else — the browser
        // extension's endpoints — answers this computer only.
        let local = request.remote_addr().is_some_and(|a| a.ip().is_loopback());
        if !local && !phone_path {
            respond_error(request, 403, "Forbidden");
            continue;
        }

        match (method.as_str(), url.as_str()) {

            // ── Ping (no auth) ────────────────────────────────────
            ("GET", "/extension/ping") => {
                // The language qooti is set to: the extension speaks it too (unless the
                // user picked another one there).
                let lang: Option<String> = {
                    let state = app.state::<AppState>();
                    let db = state.db.lock().unwrap();
                    db.query_row("SELECT value FROM preferences WHERE key = 'language'", [], |r| r.get(0)).ok()
                };
                respond_json(request, &serde_json::json!({
                    "app":      "qooti",
                    "version":  app.package_info().version.to_string(),
                    "platform": std::env::consts::OS,
                    "lang":     lang,
                }));
            }

            // ── Pair: a browser extension asks to connect ─────────
            // Only a browser extension on this computer may ask (never a web page, a
            // program without an extension's origin, or another device), and it gets a
            // key only once the user has said Allow in the app.
            ("POST", "/extension/pair") => {
                let Some(origin) = extension_origin(&request) else {
                    log::warn!(target: "ExtServer", "pair_refused origin={:?} remote={:?}",
                               header_value(&request, "origin"), request.remote_addr());
                    respond_error(request, 403, "Forbidden");
                    continue;
                };
                let known = {
                    let state = app.state::<AppState>();
                    let db = state.db.lock().unwrap();
                    load_clients(&db).into_iter().find(|c| c.origin == origin).map(|c| c.key)
                };
                if let Some(key) = known {
                    respond_json(request, &serde_json::json!({ "key": key }));
                    continue;
                }
                // "Connect again" in the extension's menu asks once more after a no.
                let body = read_body(&mut request, MAX_SMALL_BODY);
                let ask_again = serde_json::from_str::<serde_json::Value>(&body).ok()
                    .and_then(|v| v.get("ask_again").and_then(|a| a.as_bool())).unwrap_or(false);
                let browser = browser_name(&request);
                match pairing_step(&origin, &browser, ask_again) {
                    PairStep::Refused => respond_error(request, 403, "denied"),
                    PairStep::Waiting => respond_json_status(request, 202, &serde_json::json!({ "status": "pending" })),
                    PairStep::AskNow => {
                        log::info!(target: "ExtServer", "pair_requested browser={browser}");
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit("extension-pair-request", serde_json::json!({ "origin": origin, "browser": browser }));
                        respond_json_status(request, 202, &serde_json::json!({ "status": "pending" }));
                    }
                }
            }

            // ── Collections (auth required) ───────────────────────
            ("GET", "/extension/collections") => {
                if !check_extension_auth(&request, &app) {
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
                if !check_extension_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let body = read_body(&mut request, MAX_SAVE_BODY);
                match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(mut payload) => {
                        // A caller never names a file on this computer: the app would import
                        // whatever path it was given. Frames arrive as data and are saved
                        // by us (file_path is set again below for those).
                        if let Some(obj) = payload.as_object_mut() { obj.remove("file_path"); }

                        // The page chose this address: never fetch from the user's own network
                        // (router, NAS, other programs here). The download checks again after
                        // looking the name up — this is the instant, no-DNS part.
                        let target = payload.get("url").and_then(|v| v.as_str()).unwrap_or("");
                        if crate::net_guard::is_private_literal(target) {
                            log::warn!(target: "ExtServer", "save_refused_private_address");
                            respond_error(request, 400, "private_address");
                            continue;
                        }

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
                                crate::commands::find_by_link(&db, &check_url)
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
                        let mut quota_charged = false;
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
                                            // Old extensions show this under "Download failed",
                                            // cut at 80 chars — keep it short and calm.
                                            message:        "Free daily limit reached. qooti will download it at midnight.".to_string(),
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
                                // Under the limit — count this save (refunded by the
                                // download queue if the download then fails).
                                increment_ext_dl_count(&db);
                                quota_charged = true;
                            }
                        }

                        // Generate a tracking ID the extension can poll for progress
                        let ext_id = uuid::Uuid::new_v4().to_string();
                        if let Some(obj) = payload.as_object_mut() {
                            obj.insert("_ext_id".into(), serde_json::Value::String(ext_id.clone()));
                        }
                        if quota_charged { crate::commands::mark_ext_quota_charged(&ext_id); }

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
                if !check_extension_auth(&request, &app) {
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
                        prog.message    = crate::commands::friendly_ext_error("timed out");
                        prog.updated_at = std::time::Instant::now();
                        log::warn!(target: "ExtServer", "watchdog_expired ext_id={ext_id} was={old}");
                    }
                    let code = if prog.status == "error" { crate::commands::ext_error_code(&prog.message) } else { "" };
                    respond_json(request, &serde_json::json!({
                        "status":         prog.status,
                        "pct":            prog.pct,
                        "speed":          prog.speed,          // stage label while pct is 0
                        "message":        prog.message,        // English wording, for older extensions
                        "code":           code,                // what the extension words in its language
                        "friendly":       true,
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
                if !check_extension_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let body = read_body(&mut request, MAX_SMALL_BODY);
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
                if !check_extension_auth(&request, &app) {
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
                if !check_extension_auth(&request, &app) {
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
                if !check_extension_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let body = read_body(&mut request, MAX_SMALL_BODY);
                let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) else {
                    respond_error(request, 400, "Bad request");
                    continue;
                };
                // A locked collection (free plan) takes no new items — say so instead of
                // pretending it worked.
                let collection_id = payload.get("collection_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let locked = {
                    let state = app.state::<AppState>();
                    let db = state.db.lock().unwrap();
                    crate::commands::is_collection_locked(&db, &collection_id)
                };
                if locked {
                    log::info!(target: "ExtServer", "add_to_collection_locked");
                    respond_error(request, 403, "collection_locked");
                    continue;
                }
                app.emit("extension-add-to-collection", payload).ok();
                respond_json(request, &serde_json::json!({ "ok": true }));
            }

            // ── Set app preference from extension popup ───────────
            ("POST", "/extension/set-pref") => {
                if !check_extension_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let body = read_body(&mut request, MAX_SMALL_BODY);
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
                // Only the paired phone (it sends the key) shows as connected.
                if check_phone_auth(&request, &app) {
                    app.emit("mobile-connected", serde_json::json!({ "ts": ts })).ok();
                }
                respond_json(request, &serde_json::json!({
                    "version": "2.0.0", "platform": "desktop"
                }));
            }

            ("POST", "/mobile/queue") => {
                if !check_phone_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                let body = read_body(&mut request, MAX_SMALL_BODY);
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
                if !check_phone_auth(&request, &app) {
                    respond_error(request, 401, "Unauthorized");
                    continue;
                }
                // The id ends up in a file name: keep letters, digits and dashes only.
                let item_id: String = header_value(&request, "x-item-id")
                    .unwrap_or_default()
                    .chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
                let item_id = if item_id.is_empty() { uuid::Uuid::new_v4().to_string() } else { item_id };
                let mime    = header_value(&request, "content-type").unwrap_or_else(|| "application/octet-stream".to_string());
                let ext = if mime.contains("video") { "mp4" } else { "jpg" };
                let mut bytes = Vec::new();
                let limit = MAX_UPLOAD_BODY;
                request.as_reader().take(limit + 1).read_to_end(&mut bytes).ok();
                if bytes.len() as u64 > limit {
                    respond_error(request, 413, "File too large");
                    continue;
                }
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

/// From the verified licence ticket — see bloot_hub::verified_plan.
fn get_plan(_db: &rusqlite::Connection) -> String {
    crate::bloot_hub::verified_plan().to_string()
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

/// A request a browser sent on behalf of a web page. Browsers mark every request with
/// where it comes from; the extension's own requests are "none" (no page asked), and
/// programs like the phone app send no mark at all.
fn from_web_page(sec_fetch_site: Option<&str>) -> bool {
    sec_fetch_site.is_some_and(|s| !s.trim().eq_ignore_ascii_case("none"))
}

/// The Host a request was sent to must be an address, not a name: a site that points
/// its own name at this computer (DNS rebinding) could otherwise read our answers. This
/// computer only for the extension; any IP for the phone on the network.
fn host_ok(host: Option<&str>, phone: bool) -> bool {
    let Some(host) = host.map(str::trim) else { return true };   // not a browser
    let name = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    if name.eq_ignore_ascii_case("localhost") { return true }
    match name.parse::<std::net::IpAddr>() {
        Ok(ip) => phone || ip.is_loopback(),
        Err(_) => false,
    }
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

/// The phone's key (shown as the QR code). Browsers have their own keys since 1.2.
fn check_phone_auth(request: &tiny_http::Request, app: &AppHandle) -> bool {
    let expected = match stored_key(app) {
        Some(k) => k,
        None    => return false,
    };
    for header in request.headers() {
        if header.field.as_str().as_str().eq_ignore_ascii_case("x-qooti-key") {
            return same_secret(header.value.as_str().as_bytes(), expected.as_bytes());
        }
    }
    false
}

/// Compare without stopping at the first different byte (no timing hint).
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// Request bodies are read up to these sizes and no further.
const MAX_SAVE_BODY:  u64 = 32 * 1024 * 1024;   // a captured video frame arrives as a data URL
const MAX_SMALL_BODY: u64 = 1024 * 1024;
const MAX_UPLOAD_BODY: u64 = 2 * 1024 * 1024 * 1024;  // a phone video, read into memory

fn read_body(request: &mut tiny_http::Request, limit: u64) -> String {
    let mut body = String::new();
    request.as_reader().take(limit).read_to_string(&mut body).ok();
    body
}

// ── Pairing ──────────────────────────────────────────────────────
// Each browser extension gets its own key, and only once the user has said Allow in
// the app. Up to 1.0.6 any program or extension on the computer could ask for the key
// and got it at once — and it was the key the phone uses too. The phone keeps that
// original key (`extension_connection_key`, the QR code); browsers are listed in
// `extension_clients` and can be removed one by one in Settings → Downloads.

const CLIENTS_PREF: &str = "extension_clients";
/// After a "Don't allow", the same extension isn't asked again for this long…
const DENIED_FOR: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// …unless the user presses "Connect again" in it, which asks right away (a mis-click
/// is undone at once) — but no more than this many questions in that time, so nothing
/// can keep asking until the user gives in.
const MAX_ASKS: u32 = 3;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ExtClient {
    origin: String,
    key: String,
    browser: String,
    approved_at: i64,
}

enum PairState {
    /// The user is being asked right now (`asks`: questions shown this round).
    Pending { browser: String, asks: u32 },
    /// The user said no (or closed the question) at this moment.
    Denied { at: std::time::Instant, asks: u32 },
}

enum PairStep { AskNow, Waiting, Refused }

fn pairing() -> &'static Mutex<HashMap<String, PairState>> {
    static PAIRING: OnceLock<Mutex<HashMap<String, PairState>>> = OnceLock::new();
    PAIRING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What to do with a pairing request from an extension that has no key yet.
fn pairing_step(origin: &str, browser: &str, ask_again: bool) -> PairStep {
    let mut map = pairing().lock().unwrap();
    let asks = match map.get(origin) {
        Some(PairState::Pending { .. }) => return PairStep::Waiting,
        Some(PairState::Denied { at, .. }) if at.elapsed() >= DENIED_FOR => 1,   // an old no is forgotten
        Some(PairState::Denied { asks, .. }) if ask_again && *asks < MAX_ASKS => asks + 1,
        Some(PairState::Denied { .. }) => return PairStep::Refused,
        None => 1,
    };
    map.insert(origin.to_string(), PairState::Pending { browser: browser.to_string(), asks });
    PairStep::AskNow
}

/// The user answered the question: it's over; a no is remembered for a while. Returns
/// the browser's name, or None when this extension wasn't being asked.
fn settle_question(origin: &str, allow: bool) -> Option<String> {
    let mut map = pairing().lock().unwrap();
    match map.remove(origin) {
        Some(PairState::Pending { browser, asks }) => {
            if !allow { map.insert(origin.to_string(), PairState::Denied { at: std::time::Instant::now(), asks }); }
            Some(browser)
        }
        other => {
            if let Some(state) = other { map.insert(origin.to_string(), state); }
            None
        }
    }
}

/// `chrome-extension://<32 letters a–p>` (Chrome, Edge, Brave, Opera…) or
/// `moz-extension://<uuid>` (Firefox), from this computer — the only callers that
/// may pair. Browsers set Origin themselves; a web page can't pretend to be one.
fn extension_origin(request: &tiny_http::Request) -> Option<String> {
    if !request.remote_addr().is_some_and(|a| a.ip().is_loopback()) { return None }
    let origin = header_value(request, "origin")?.trim().to_ascii_lowercase();
    let chrome = origin.strip_prefix("chrome-extension://")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)));
    let firefox = origin.strip_prefix("moz-extension://")
        .is_some_and(|id| id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'));
    (chrome || firefox).then_some(origin)
}

/// The browser's everyday name, for the question and the Settings list.
fn browser_name(request: &tiny_http::Request) -> String {
    let ua = header_value(request, "user-agent").unwrap_or_default();
    let name = if ua.contains("Edg/") { "Edge" }
        else if ua.contains("OPR/") { "Opera" }
        else if ua.contains("YaBrowser/") { "Yandex Browser" }
        else if ua.contains("Firefox/") { "Firefox" }
        else { "Chrome" };
    name.to_string()
}

fn load_clients(db: &rusqlite::Connection) -> Vec<ExtClient> {
    db.query_row("SELECT value FROM preferences WHERE key = ?1", [CLIENTS_PREF], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

fn save_clients(db: &rusqlite::Connection, clients: &[ExtClient]) -> Result<(), String> {
    let value = serde_json::to_string(clients).map_err(|e| e.to_string())?;
    db.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)", rusqlite::params![CLIENTS_PREF, value])
        .map(|_| ()).map_err(|e| e.to_string())
}

/// A request from a connected browser: its own key, and when the browser says who it
/// is (Origin), the key must be that browser's.
fn check_extension_auth(request: &tiny_http::Request, app: &AppHandle) -> bool {
    let Some(given) = header_value(request, "x-qooti-key") else { return false };
    let origin = extension_origin(request);
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    load_clients(&db).iter().any(|c|
        same_secret(given.as_bytes(), c.key.as_bytes()) && origin.as_deref().map_or(true, |o| o == c.origin))
}

/// The user's answer to "Connect your browser?" in the app.
#[tauri::command]
pub fn answer_extension_pair(origin: String, allow: bool, app: AppHandle) -> Result<(), String> {
    let origin = origin.to_ascii_lowercase();
    let Some(browser) = settle_question(&origin, allow) else {
        return Err("No connection request from this browser".into());
    };
    if !allow {
        log::info!(target: "ExtServer", "pair_denied browser={browser}");
        return Ok(());
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let mut clients = load_clients(&db);
    clients.retain(|c| c.origin != origin);
    clients.push(ExtClient {
        origin,
        key: uuid::Uuid::new_v4().to_string(),
        browser: browser.clone(),
        approved_at: chrono::Utc::now().timestamp_millis(),
    });
    save_clients(&db, &clients)?;
    drop(db);
    log::info!(target: "ExtServer", "pair_allowed browser={browser} browsers={}", clients.len());
    let _ = app.emit("extension-paired", serde_json::json!({ "browser": browser }));
    Ok(())
}

/// Connected browsers for Settings (never their keys).
#[tauri::command]
pub fn list_extension_clients(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    Ok(load_clients(&db).into_iter().map(|c| serde_json::json!({
        "origin": c.origin, "browser": c.browser, "approved_at": c.approved_at,
    })).collect())
}

/// Disconnect one browser: its key stops working at once; it asks again next time.
#[tauri::command]
pub fn remove_extension_client(origin: String, app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let mut clients = load_clients(&db);
    let before = clients.len();
    clients.retain(|c| c.origin != origin.to_ascii_lowercase());
    save_clients(&db, &clients)?;
    log::info!(target: "ExtServer", "browser_removed removed={} left={}", before - clients.len(), clients.len());
    Ok(())
}

// ── Collections ──────────────────────────────────────────────────

fn get_collections(app: &AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name, created_at FROM collections ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, i64)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    // Free plan: only the FREE_COLLECTION_LIMIT oldest collections take new items —
    // the same rule as the app (commands::is_collection_locked). The extension shows
    // the others as locked.
    let cutoff = if is_free_plan(&get_plan(&db)) {
        let mut ages: Vec<i64> = rows.iter().map(|r| r.2).collect();
        ages.sort_unstable();
        ages.get(crate::commands::FREE_COLLECTION_LIMIT as usize).copied()
    } else {
        None
    };
    let cols: Vec<serde_json::Value> = rows.into_iter().map(|(id, name, created_at)| {
        serde_json::json!({
            "id":     id,
            "name":   name,
            "locked": cutoff.is_some_and(|cut| created_at >= cut),
        })
    }).collect();
    Ok(serde_json::Value::Array(cols))
}

// ── Response helpers ─────────────────────────────────────────────

// No Access-Control-Allow-Origin: the browser extension (host permission) and the phone
// app don't need it, and without it a web page can't read anything this server says.
fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(b"Content-Type", b"application/json").unwrap(),
    ]
}

fn respond_json_status(request: tiny_http::Request, code: u16, value: &serde_json::Value) {
    let mut r = Response::from_string(value.to_string()).with_status_code(code);
    for h in cors_headers() { r = r.with_header(h); }
    request.respond(r).ok();
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

#[cfg(test)]
mod pairing_tests {
    use super::*;

    #[test]
    fn web_pages_and_rebound_names_get_nothing() {
        // What browsers send: the extension's own requests, and web pages'
        assert!(!from_web_page(Some("none")));
        assert!(!from_web_page(None));                       // the phone app, other programs
        assert!(from_web_page(Some("cross-site")));
        assert!(from_web_page(Some("same-site")));
        assert!(from_web_page(Some("same-origin")));
        // Host: an address, never a name
        assert!(host_ok(Some("127.0.0.1:1420"), false));
        assert!(host_ok(Some("localhost:1420"), false));
        assert!(host_ok(Some("[::1]:1420"), false));
        assert!(host_ok(None, false));
        assert!(!host_ok(Some("evil.example:1420"), false));
        assert!(!host_ok(Some("127.0.0.1.nip.io:1420"), false));
        assert!(!host_ok(Some("192.168.1.20:1420"), false));  // the network: the phone only
        assert!(host_ok(Some("192.168.1.20:1420"), true));
        assert!(host_ok(Some("[fe80::1]:1420"), true));
        assert!(!host_ok(Some("my-pc.local:1420"), true));
    }

    #[test]
    fn a_new_browser_is_asked_once_then_waits() {
        let o = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
        assert!(matches!(pairing_step(o, "Edge", false), PairStep::AskNow));
        assert!(matches!(pairing_step(o, "Edge", false), PairStep::Waiting));
        assert!(matches!(pairing_step(o, "Edge", true), PairStep::Waiting));
    }

    #[test]
    fn after_a_no_only_connect_again_asks_and_not_endlessly() {
        let o = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac";
        assert!(matches!(pairing_step(o, "Chrome", false), PairStep::AskNow));
        assert_eq!(settle_question(o, false).as_deref(), Some("Chrome"));
        assert!(matches!(pairing_step(o, "Chrome", false), PairStep::Refused));  // not by itself
        assert!(matches!(pairing_step(o, "Chrome", true), PairStep::AskNow));    // "Connect again", at once
        settle_question(o, false);
        assert!(matches!(pairing_step(o, "Chrome", true), PairStep::AskNow));    // a third question
        settle_question(o, false);
        assert!(matches!(pairing_step(o, "Chrome", true), PairStep::Refused));   // then it rests
        assert!(settle_question(o, true).is_none());                             // nothing to answer
    }

    #[test]
    fn a_no_expires_on_its_own() {
        let o = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad";
        let long_ago = std::time::Instant::now() - DENIED_FOR - std::time::Duration::from_secs(1);
        pairing().lock().unwrap().insert(o.into(), PairState::Denied { at: long_ago, asks: MAX_ASKS });
        assert!(matches!(pairing_step(o, "Chrome", false), PairStep::AskNow));
    }
}
