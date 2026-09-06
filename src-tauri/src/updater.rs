use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Spawns a background thread that waits 30 s after launch (so startup isn't
/// impacted), then checks the GitHub Releases endpoint for a new version.
/// If one is found, emits "update-available" so the frontend can show a pill.
pub fn spawn_update_check(app: AppHandle) {
    std::thread::spawn(move || {
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

/// Tauri command: re-checks for update, downloads, installs, then restarts.
/// Called from JS when the user confirms the update prompt.
#[tauri::command]
pub async fn apply_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update  = updater.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Err("No update available".into());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
    #[allow(unreachable_code)]
    Ok(())
}
