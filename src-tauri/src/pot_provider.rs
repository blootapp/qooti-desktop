// On-demand YouTube PO-token provider (bgutil).
//
// YouTube's SABR / GVS-PO-token gating returns HTTP 403 on the media stream for
// some sessions/IPs (see arch §51.4). A GVS PO token clears it. The provider is a
// self-contained (deno-compiled) local HTTP server that mints *anonymous* BotGuard
// tokens — no login, no cookies, no account risk. It's large (~250 MB), so it is
// NOT bundled: it's downloaded (gzip) into app-data the first time YouTube needs it,
// then spawned on 127.0.0.1:4416, where yt-dlp's bgutil plugin (installed into
// yt-dlp's config dir — the frozen binary ignores --plugin-dirs) queries it.
//
// Best-effort: if anything fails, callers run yt-dlp without a PO token (unchanged
// behaviour). Every step emits a `pot:diag` event so it shows up in feedback reports
// (diagnostics.js) — the only way to debug the macOS path remotely.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use crate::AppState;

const PORT: u16 = 4416;

#[cfg(target_os = "windows")] const TARGET: &str = "x86_64-pc-windows-msvc";
#[cfg(target_os = "macos")]   const TARGET: &str = "aarch64-apple-darwin";
#[cfg(target_os = "linux")]   const TARGET: &str = "x86_64-unknown-linux-gnu";

#[cfg(windows)]      const BIN_NAME: &str = "qooti-pot.exe";
#[cfg(not(windows))] const BIN_NAME: &str = "qooti-pot";

/// Emit a diagnostic breadcrumb (→ feedback activity trail) + log it.
fn diag(app: &AppHandle, msg: impl AsRef<str>) {
    let m = msg.as_ref();
    log::info!(target: "Pot", "{m}");
    let _ = app.emit("pot:diag", m.to_string());
}

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
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent().and_then(|d| d.parent()).and_then(|d| d.parent())
            .map(|d| d.join("pot-plugin"))
        {
            if p.join("yt_dlp_plugins").exists() { return Some(p); }
        }
    }
    None
}

/// yt-dlp's default config plugin directories for this OS. The frozen (PyInstaller)
/// yt-dlp only auto-loads plugins from these — `--plugin-dirs` and next-to-binary
/// are ignored (verified on Windows). We install into every candidate to cover the
/// macOS uncertainty (`~/.config` vs `~/Library/Application Support`).
fn ytdlp_plugin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    { if let Some(a) = std::env::var_os("APPDATA") { dirs.push(PathBuf::from(a).join("yt-dlp").join("plugins")); } }
    #[cfg(not(windows))]
    {
        if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
            dirs.push(PathBuf::from(x).join("yt-dlp").join("plugins"));
        }
        if let Some(h) = std::env::var_os("HOME") {
            let home = PathBuf::from(h);
            dirs.push(home.join(".config").join("yt-dlp").join("plugins"));
            #[cfg(target_os = "macos")]
            dirs.push(home.join("Library").join("Application Support").join("yt-dlp").join("plugins"));
        }
    }
    dirs
}

/// Copy the bundled bgutil plugin into yt-dlp's config plugin dir(s). Idempotent.
pub fn install_plugin(app: &AppHandle) -> bool {
    let Some(src) = plugin_source(app) else { diag(app, "plugin source missing"); return false };
    let src_ext = src.join("yt_dlp_plugins").join("extractor");
    let mut installed = 0;
    for dir in ytdlp_plugin_dirs() {
        let dst_ext = dir.join("qooti-bgutil").join("yt_dlp_plugins").join("extractor");
        if std::fs::create_dir_all(&dst_ext).is_err() { continue; }
        let mut copied = false;
        if let Ok(entries) = std::fs::read_dir(&src_ext) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("py") {
                    if let Some(name) = p.file_name() {
                        if std::fs::copy(&p, dst_ext.join(name)).is_ok() { copied = true; }
                    }
                }
            }
        }
        if copied { installed += 1; }
    }
    diag(app, format!("plugin installed into {installed} dir(s)"));
    installed > 0
}

/// True once the provider binary has been downloaded.
pub fn is_downloaded(app: &AppHandle) -> bool {
    binary_path(app).is_some_and(|p| p.exists())
}

/// Download + gunzip the provider binary from R2 into app-data. Blocking. No-op if
/// already present.
pub fn ensure_downloaded(app: &AppHandle) -> Result<PathBuf, String> {
    let path = binary_path(app).ok_or("no app_data_dir")?;
    if path.exists() { return Ok(path); }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let url = format!("https://api.bloot.app/download/qooti-pot-{TARGET}.gz");
    diag(app, format!("downloading provider ({TARGET})…"));
    let resp = ureq::get(&url).call().map_err(|e| format!("download failed: {e}"))?;
    let mut gz = Vec::new();
    resp.into_reader().read_to_end(&mut gz).map_err(|e| e.to_string())?;
    diag(app, format!("downloaded {} MB (gz), decompressing…", gz.len() / 1_048_576));

    let mut dec = flate2::read::GzDecoder::new(&gz[..]);
    let mut bin = Vec::new();
    dec.read_to_end(&mut bin).map_err(|e| format!("decompress failed: {e}"))?;

    let tmp = path.with_extension("part");
    std::fs::write(&tmp, &bin).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    // macOS: our own download shouldn't quarantine, but strip it defensively so
    // Gatekeeper can't block the helper.
    #[cfg(target_os = "macos")]
    { let _ = std::process::Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(&tmp).status(); }

    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    diag(app, format!("provider ready ({} MB)", bin.len() / 1_048_576));
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

/// Delete the managed binary so a (re-hosted) fixed build is re-downloaded next time.
fn discard_binary(app: &AppHandle) {
    if let Some(p) = binary_path(app) { let _ = std::fs::remove_file(p); }
}

/// Ensure the provider server is running (downloading the binary first if needed).
/// Returns true once it answers on 127.0.0.1:4416. Best-effort.
pub fn ensure_running(app: &AppHandle) -> bool {
    install_plugin(app);
    if is_up() { diag(app, "server already up"); return true; }

    let path = match ensure_downloaded(app) {
        Ok(p) => p,
        Err(e) => { diag(app, format!("download failed: {e}")); return false; }
    };

    let state = app.state::<AppState>();
    {
        let mut guard = state.pot_child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) { drop(guard); return wait_up(); }
        }

        diag(app, "starting provider server…");
        let spawned = crate::commands::hidden_command(&path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c)  => c,
            Err(e) => { diag(app, format!("spawn failed: {e}")); discard_binary(app); return false; }
        };

        // Did it die immediately? (e.g. Apple-Silicon killing an unsigned binary →
        // signal 9, or a runtime error). Capture stderr to say WHY, then self-heal.
        std::thread::sleep(Duration::from_millis(900));
        if let Ok(Some(status)) = child.try_wait() {
            let mut err = String::new();
            if let Some(mut se) = child.stderr.take() { let _ = se.read_to_string(&mut err); }
            #[cfg(unix)]
            let how = {
                use std::os::unix::process::ExitStatusExt;
                status.signal().map(|s| format!("signal {s}"))
                    .or_else(|| status.code().map(|c| format!("code {c}")))
                    .unwrap_or_else(|| "?".into())
            };
            #[cfg(not(unix))]
            let how = status.code().map(|c| format!("code {c}")).unwrap_or_else(|| "?".into());
            diag(app, format!("provider exited immediately ({how}) {}", err.trim().chars().take(160).collect::<String>()));
            discard_binary(app);
            return false;
        }

        // Alive — drain stderr in the background so the pipe never blocks the server.
        if let Some(mut se) = child.stderr.take() {
            std::thread::spawn(move || { let mut buf = [0u8; 4096]; while matches!(se.read(&mut buf), Ok(n) if n > 0) {} });
        }
        *guard = Some(child);
    }

    let ok = wait_up();
    diag(app, if ok { "server up ✓" } else { "server did not respond on :4416" });
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
