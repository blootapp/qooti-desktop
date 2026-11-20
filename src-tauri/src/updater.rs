use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Spawns a background thread that waits 30 s after launch (so startup isn't
/// impacted), then checks the GitHub Releases endpoint for a new version.
/// If one is found, emits "update-available" so the frontend can show a pill.
pub fn spawn_update_check(app: AppHandle) {
    std::thread::spawn(move || {
        remove_moved_aside();
        std::thread::sleep(std::time::Duration::from_secs(30));
        tauri::async_runtime::spawn(async move {
            if let Err(e) = check_and_notify(&app).await {
                eprintln!("[updater] check failed: {e}");
            }
        });
    });
}

async fn check_and_notify(app: &AppHandle) -> anyhow::Result<()> {
    let updater = app.updater()?;
    if let Some(update) = updater.check().await? {
        app.emit("update-available", serde_json::json!({
            "version": update.version,
            "notes":   update.body.unwrap_or_default(),
        }))?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes:   String,
}

/// Tauri command: check-only. Returns Some(UpdateInfo) when a newer version is
/// available, None when already up to date. Backs the Settings "Check for
/// updates" button (apply_update handles the actual download/install).
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(Some(UpdateInfo {
            version: update.version,
            notes:   update.body.unwrap_or_default(),
        })),
        None => Ok(None),
    }
}

/// Tauri command: re-checks for update, downloads, installs, then restarts.
/// Called from JS when the user confirms the update prompt. The updating screen
/// (update-screen.js) follows it through "update-progress": `{ phase: "downloading",
/// downloaded, total }` while the update downloads (total is null when the server doesn't
/// say), then `{ phase: "installing" }` until qooti closes for the installer (Windows)
/// or restarts (macOS).
#[tauri::command]
pub async fn apply_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update  = updater.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Err("No update available".into());
    };
    log::info!(target: "Update", "installing {} (from {})", update.version, update.current_version);
    let mut progress = Progress { app: app.clone(), downloaded: 0, sent: None };
    let installing = app.clone();
    update
        .download_and_install(
            move |chunk, total| progress.add(chunk, total),
            move || { let _ = installing.emit("update-progress", serde_json::json!({ "phase": "installing" })); },
        )
        .await
        .map_err(|e| {
            log::error!(target: "Update", "install failed: {e}");
            e.to_string()
        })?;
    // restart() doesn't go through RunEvent::Exit — close the session log cleanly here.
    crate::logger::mark_clean_exit("restarting to finish the update");
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}

/// How much of the update has arrived, for the updating screen: at most ten times a
/// second, and always the last piece, so the line ends full.
struct Progress {
    app: AppHandle,
    downloaded: u64,
    sent: Option<Instant>,
}

impl Progress {
    fn add(&mut self, chunk: usize, total: Option<u64>) {
        self.downloaded += chunk as u64;
        let last = total.is_some_and(|t| self.downloaded >= t);
        if !last && self.sent.is_some_and(|at| at.elapsed() < Duration::from_millis(100)) { return; }
        self.sent = Some(Instant::now());
        let _ = self.app.emit("update-progress", serde_json::json!({
            "phase": "downloading", "downloaded": self.downloaded, "total": total,
        }));
    }
}

/// The installer moves a qooti.exe that Windows still holds locked out of the way
/// (windows/nsis-hooks.nsh: `qooti.exe.<n>.old`). Delete those once nothing holds them;
/// one still locked stays for the next start.
fn remove_moved_aside() {
    #[cfg(windows)]
    {
        let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(std::path::Path::to_path_buf)) else { return };
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with("qooti.exe.") && name.ends_with(".old") {
                match std::fs::remove_file(entry.path()) {
                    Ok(()) => log::info!(target: "Update", "removed {name}, moved aside by the installer"),
                    Err(e) => log::info!(target: "Update", "{name} is still held, keeping it for now: {e}"),
                }
            }
        }
    }
}
