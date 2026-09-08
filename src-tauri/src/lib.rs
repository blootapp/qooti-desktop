use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

pub mod commands;
pub mod db;
pub mod logger;
pub mod media_guard;
pub mod vault;
pub mod extension_server;
pub mod local_stats_server;
pub mod updater;
pub mod pack;
pub mod palette;

pub struct ExtProgress {
    pub pct:            f64,
    pub speed:          String,
    pub status:         String,  // "pending" | "downloading" | "finalizing" | "complete" | "error" | "cancelled"
    pub message:        String,
    pub inspiration_id: Option<String>,
    pub updated_at:     std::time::Instant,
}

pub struct AppState {
    pub db:          std::sync::Mutex<rusqlite::Connection>,
    /// download_id → ext_id, registered when an extension-triggered download starts
    pub ext_id_map:  std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// ext_id → progress, polled by the browser extension
    pub ext_progress: std::sync::Mutex<std::collections::HashMap<String, ExtProgress>>,
    /// ext_id → path of temp Netscape cookie file, written from browser cookies on save
    pub cookie_files: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// URL queued by the app for the extension to pick up and download using browser cookies.
    /// Only one pending at a time; extension polls GET /extension/pending-download to claim it.
    pub pending_ext_download: std::sync::Mutex<Option<String>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logger::init();
    log::info!(target: "Boot", "qooti starting version=1.0.0");

    tauri::Builder::default()
        // Must be the FIRST plugin. When the app is already running and the user
        // launches it again (Start menu, taskbar, etc.), focus the existing window
        // instead of opening a second one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            // A qooti:// deep link delivered via the second launch (Windows) —
            // handle plan-sync so a Pro upgrade re-validates while the app runs.
            if argv.iter().any(|a| a.starts_with("qooti://plan-sync")) {
                use tauri::Emitter;
                let _ = app.emit("license-status-push", ());
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let conn = db::init(app.handle())?;

            // Enable autostart by default on first install.
            // The flag prevents re-enabling it if the user later turns it off.
            #[cfg(target_os = "windows")]
            {
                let already_init: bool = conn.query_row(
                    "SELECT COUNT(*) FROM preferences WHERE key = 'autostart_initialized'",
                    [],
                    |row| row.get::<_, i64>(0),
                ).unwrap_or(0) > 0;
                if !already_init {
                    commands::set_autostart(true);
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO preferences (key, value) VALUES ('autostart_initialized', 'true')",
                        [],
                    );
                }
            }

            app.manage(AppState {
                db:                    std::sync::Mutex::new(conn),
                ext_id_map:            std::sync::Mutex::new(std::collections::HashMap::new()),
                ext_progress:          std::sync::Mutex::new(std::collections::HashMap::new()),
                cookie_files:          std::sync::Mutex::new(std::collections::HashMap::new()),
                pending_ext_download:  std::sync::Mutex::new(None),
            });

            // Clean up any partial/stale files left in downloads_tmp from a previous crash or
            // cancelled download. Safe to wipe on boot — no download can be active yet.
            if let Ok(vault_path) = vault::get_vault_path(app.handle()) {
                let tmp_dir = vault_path.join("downloads_tmp");
                if tmp_dir.exists() {
                    if let Ok(entries) = std::fs::read_dir(&tmp_dir) {
                        for entry in entries.flatten() {
                            std::fs::remove_file(entry.path()).ok();
                        }
                    }
                }
            }

            // Log yt-dlp version so we can confirm which binary is active.
            {
                let binary = commands::ytdlp_binary_path(app.handle());
                if let Ok(out) = commands::hidden_command(&binary).arg("--version").output() {
                    log::info!(target: "Boot", "ytdlp_version={}", String::from_utf8_lossy(&out.stdout).trim());
                } else {
                    log::warn!(target: "Boot", "ytdlp_missing path={:?}", binary);
                }
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || extension_server::start(handle));

            // Midnight queue processor: at local midnight, flush ext_download_queue back
            // into the normal download flow so queued items download automatically.
            let queue_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    let secs = secs_until_local_midnight();
                    std::thread::sleep(std::time::Duration::from_secs(secs));
                    process_ext_queue(&queue_handle);
                }
            });

            let stats_handle = app.handle().clone();
            std::thread::spawn(move || local_stats_server::start(stats_handle));

            updater::spawn_update_check(app.handle().clone());

            // Boot disk-space check: warn if vault disk has < 5 GB free.
            {
                use tauri::Emitter;
                const LOW_DISK_THRESHOLD: u64 = 5 * 1024 * 1024 * 1024;
                let boot_handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Ok(vault_path) = vault::get_vault_path(&boot_handle) {
                        let free = vault::disk_free_bytes(&vault_path).unwrap_or(u64::MAX);
                        if free < LOW_DISK_THRESHOLD {
                            let free_gb = free as f64 / 1_073_741_824.0;
                            let _ = boot_handle.emit("vault:low-disk", serde_json::json!({
                                "free_bytes": free,
                                "free_gb": free_gb,
                                "vault_path": vault_path.to_string_lossy()
                            }));
                        }
                    }
                });
            }

            let window = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "windows")]
            window.set_decorations(false)?;

            // Close button hides to tray instead of quitting.
            let w = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = w.hide();
                }
            });

            // Deep link: qooti://plan-sync — triggered by account.bloot.app after a
            // successful plan upgrade. Shows the window and tells the JS license module
            // to re-validate against the server immediately.
            {
                use tauri::Emitter;
                use tauri_plugin_deep_link::DeepLinkExt;
                let dl_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if url.as_str().starts_with("qooti://plan-sync") {
                            if let Some(win) = dl_handle.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                                let _ = win.emit("license-status-push", ());
                            }
                            break;
                        }
                    }
                });

                // Register the scheme in the OS during development so the link works
                // without a full installer run. The release installer handles production.
                #[cfg(debug_assertions)]
                app.deep_link().register_all()?;
            }

            window.show()?;

            // Build system tray menu.
            let show_item = MenuItem::with_id(app, "show", "Show qooti", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit qooti", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("qooti")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_files,
            commands::get_app_info,
            commands::get_settings,
            commands::set_setting,
            commands::window_minimize,
            commands::window_maximize,
            commands::window_close,
            commands::list_inspirations,
            commands::get_inspiration,
            commands::update_inspiration,
            commands::delete_inspiration,
            commands::read_image_as_base64,
            commands::claim_ocr_index_candidates,
            commands::finalize_ocr_index_result,
            commands::reset_ocr_status_for_inspiration,
            commands::queue_full_ocr_reindex,
            commands::get_ocr_index_stats,
            commands::list_collections,
            commands::create_collection,
            commands::update_collection,
            commands::delete_collection,
            commands::export_collection,
            commands::export_all_items,
            commands::get_collection_ids_for_inspiration,
            commands::add_to_collection,
            commands::remove_from_collection,
            commands::list_tags,
            commands::get_tags_for_inspiration,
            commands::create_tag,
            commands::delete_tag,
            commands::tag_inspiration,
            commands::untag_inspiration,
            commands::get_vault_info,
            commands::get_license_cache,
            commands::clear_license_cache,
            commands::update_license_plan,
            commands::list_milestones,
            commands::get_notifications,
            commands::mark_notification_read,
            commands::get_mobile_connection_qr,
            commands::claim_auto_tag_candidates,
            commands::finalize_auto_tag_result,
            commands::reindex_library,
            commands::extract_palette,
            commands::download_url,
            commands::finalize_download,
            commands::cancel_download,
            commands::list_tag_vocab,
            commands::upsert_tag_vocab,
            commands::delete_tag_vocab,
            commands::reset_all_auto_tags,
            commands::copy_file_to_folder,
            commands::copy_file_to_clipboard,
            commands::reveal_in_folder,
            commands::analyze_import_source,
            commands::extract_import_archive,
            commands::import_qooti_pack,
            commands::fetch_youtube_thumbnail,
            commands::get_autostart,
            commands::set_autostart,
            commands::track_view,
            commands::apply_collection_tag_suggestions,
            commands::list_rediscover,
            commands::list_because_you_viewed,
            commands::list_havent_seen,
            commands::check_url_exists,
            commands::pick_vault_folder,
            commands::pick_cookies_file,
            commands::relocate_vault,
            commands::save_thumbnail,
            commands::set_ext_progress_error,
            commands::log_failed_download,
            commands::clear_failed_download,
            commands::clear_all_failed_downloads,
            commands::list_activity,
            commands::queue_ext_download,
            commands::reset_app,
            commands::get_free_plan_info,
            updater::apply_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn secs_until_local_midnight() -> u64 {
    let now      = chrono::Local::now();
    let tomorrow = now.date_naive() + chrono::Duration::days(1);
    let midnight = tomorrow.and_hms_opt(0, 0, 0).unwrap();
    let midnight_local = match midnight.and_local_timezone(chrono::Local) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => t,
        chrono::LocalResult::None => return 86_400, // fallback: 24h
    };
    midnight_local.signed_duration_since(now).num_seconds().max(60) as u64
}

fn process_ext_queue(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let state = app.state::<AppState>();
    let db = state.db.lock().unwrap();

    let items: Vec<(String, String, String, String, String)> = {
        let mut stmt = match db.prepare(
            "SELECT id, url, page_url, title, source_platform FROM ext_download_queue ORDER BY queued_at ASC"
        ) {
            Ok(s)  => s,
            Err(_) => return,
        };
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2).unwrap_or_default(),
                row.get::<_, String>(3).unwrap_or_default(),
                row.get::<_, String>(4).unwrap_or_default(),
            ))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }; // stmt drops here, releasing borrow on db

    if items.is_empty() { return; }

    let _ = db.execute("DELETE FROM ext_download_queue", []);
    let _ = db.execute(
        "INSERT OR REPLACE INTO preferences (key, value) VALUES ('ext_dl_count', '0')",
        [],
    );
    drop(db);

    log::info!(target: "QueueProcessor", "processing {} queued ext items", items.len());

    for (_, url, page_url, title, platform) in items {
        let ext_id = uuid::Uuid::new_v4().to_string();
        let _ = app.emit("extension-item-received", serde_json::json!({
            "url":             url,
            "page_url":        page_url,
            "title":           title,
            "type":            "video",
            "source_platform": platform,
            "_ext_id":         ext_id,
        }));
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
}
