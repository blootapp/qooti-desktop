// On-demand YouTube PO-token provider (bgutil).
//
// YouTube's SABR / GVS-PO-token gating returns HTTP 403 on the media stream for
// some sessions/IPs (see arch §51.4). A GVS PO token clears it. The provider is a
// self-contained (deno-compiled) local HTTP server that mints *anonymous* BotGuard
// tokens — no login, no cookies, no account risk. It's large (~250 MB), so it is
// NOT bundled: it's downloaded (gzip, ~100 MB) into app-data the first time YouTube
// needs it, then spawned on 127.0.0.1:4416, where yt-dlp's bundled bgutil plugin
// (see pot-plugin/, passed via --plugin-dirs) queries it automatically.
//
// Everything here is best-effort: if the download or spawn fails, callers just run
// yt-dlp without a PO token (unchanged behaviour), so YouTube never *breaks* —
// it only gains reliability when the provider is available.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use crate::AppState;

const PORT: u16 = 4416;

#[cfg(target_os = "windows")] const TARGET: &str = "x86_64-pc-windows-msvc";
#[cfg(target_os = "macos")]   const TARGET: &str = "aarch64-apple-darwin";
#[cfg(target_os = "linux")]   const TARGET: &str = "x86_64-unknown-linux-gnu";

#[cfg(windows)]      const BIN_NAME: &str = "qooti-pot.exe";
#[cfg(not(windows))] const BIN_NAME: &str = "qooti-pot";

/// The managed provider binary in app-data.
fn binary_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("bin").join(BIN_NAME))
}

/// Bundled plugin source dir (contains `yt_dlp_plugins/…`).
fn plugin_source(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("pot-plugin");
        if p.join("yt_dlp_plugins").exists() { return Some(p); }
    }
    // Dev (cargo run / tauri dev): exe at src-tauri/target/<profile>/ → src-tauri/pot-plugin
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent().and_then(|d| d.parent()).and_then(|d| d.parent())
            .map(|d| d.join("pot-plugin"))
        {
            if p.join("yt_dlp_plugins").exists() { return Some(p); }
        }
    }
    None
}

/// yt-dlp's default config plugin directory for this OS. IMPORTANT: the frozen
/// (PyInstaller) yt-dlp only auto-loads plugins from here — `--plugin-dirs` and a
/// `yt-dlp-plugins/` folder next to the binary are both ignored by the standalone
/// build (verified). So we copy the plugin here instead.
fn ytdlp_plugin_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    { std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("yt-dlp").join("plugins")) }
    #[cfg(not(windows))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(base.join("yt-dlp").join("plugins"))
    }
}

/// Copy the bundled bgutil plugin into yt-dlp's config plugin dir so the standalone
/// yt-dlp auto-loads it (queries the local server on :4416). Idempotent.
pub fn install_plugin(app: &AppHandle) -> bool {
    let (Some(src), Some(dir)) = (plugin_source(app), ytdlp_plugin_dir()) else { return false };
    let src_ext = src.join("yt_dlp_plugins").join("extractor");
    let dst_ext = dir.join("qooti-bgutil").join("yt_dlp_plugins").join("extractor");
    if std::fs::create_dir_all(&dst_ext).is_err() { return false; }
    let mut ok = false;
    if let Ok(entries) = std::fs::read_dir(&src_ext) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("py") {
                if let Some(name) = p.file_name() {
                    if std::fs::copy(&p, dst_ext.join(name)).is_ok() { ok = true; }
                }
            }
        }
    }
    ok
}

/// True once the provider binary has been downloaded.
pub fn is_downloaded(app: &AppHandle) -> bool {
    binary_path(app).is_some_and(|p| p.exists())
}

/// Download + gunzip the provider binary from R2 into app-data. Blocking; call off
/// the main thread. No-op if already present.
pub fn ensure_downloaded(app: &AppHandle) -> Result<PathBuf, String> {
    let path = binary_path(app).ok_or("no app_data_dir")?;
    if path.exists() { return Ok(path); }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let url = format!("https://api.bloot.app/download/qooti-pot-{TARGET}.gz");
    log::info!(target: "Pot", "downloading provider {url}");
    let resp = ureq::get(&url).call().map_err(|e| format!("download failed: {e}"))?;
    let mut gz = Vec::new();
    resp.into_reader().read_to_end(&mut gz).map_err(|e| e.to_string())?;

    let mut dec = flate2::read::GzDecoder::new(&gz[..]);
    let mut bin = Vec::new();
    dec.read_to_end(&mut bin).map_err(|e| format!("decompress failed: {e}"))?;

    // Write to a temp file then rename, so a half-download never looks "ready".
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, &bin).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    log::info!(target: "Pot", "provider ready ({} MB)", bin.len() / 1_048_576);
    Ok(path)
}

fn is_up() -> bool {
    ureq::get(&format!("http://127.0.0.1:{PORT}/ping"))
        .timeout(Duration::from_millis(800))
        .call()
        .is_ok()
}

fn wait_up() -> bool {
    for _ in 0..30 {                          // up to ~9 s for BotGuard init
        if is_up() { return true; }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// Ensure the provider server is running (downloading the binary first if needed).
/// Returns true once it's answering on 127.0.0.1:4416. Best-effort — a `false`
/// simply means the caller runs yt-dlp without a PO token.
pub fn ensure_running(app: &AppHandle) -> bool {
    install_plugin(app);   // yt-dlp auto-loads the plugin from its config dir
    if is_up() { return true; }

    let path = match ensure_downloaded(app) {
        Ok(p) => p,
        Err(e) => { log::warn!(target: "Pot", "download failed: {e}"); return false; }
    };

    let state = app.state::<AppState>();
    {
        let mut guard = state.pot_child.lock().unwrap();
        // Reuse a still-alive child.
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                drop(guard);
                return wait_up();
            }
        }
        match crate::commands::hidden_command(&path).spawn() {
            Ok(c)  => { *guard = Some(c); }
            Err(e) => { log::warn!(target: "Pot", "spawn failed: {e}"); return false; }
        }
    }
    let ok = wait_up();
    if !ok { log::warn!(target: "Pot", "provider did not come up on :{PORT}"); }
    ok
}

/// Kill the provider server (on app exit) so it doesn't orphan on port 4416.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(mut child) = state.pot_child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}
