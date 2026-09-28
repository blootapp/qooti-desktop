// JavaScript runtime (deno) for yt-dlp's YouTube support.
//
// yt-dlp has to execute YouTube's player JavaScript (the "n" / signature challenges)
// in an external JS runtime. Without one it can't unlock the media URLs and every
// YouTube download ends in HTTP 403 — the "YouTube downloads don't work" reports on
// stock Windows + macOS (it only ever worked on machines that happened to have deno
// on PATH). yt-dlp's standalone builds bundle the challenge-solver scripts but not a
// runtime, so we provision the official, code-signed deno binary into app-data
// (`bin/deno[.exe]`) and hand it to yt-dlp explicitly with `--js-runtimes deno:<path>`
// (a macOS GUI app doesn't inherit the shell PATH, so relying on PATH never works there).
//
// Installed once: prefetched in the background shortly after boot, and ensured
// (blocking, with progress) before a YouTube download if the prefetch hasn't landed.
// The zip is SHA-256-verified against the pinned release before anything is extracted,
// so a mirror can never hand us a different binary. See arch §52.1.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use sha2::Digest;
use tauri::{AppHandle, Emitter, Manager};

/// Pinned deno release. yt-dlp needs deno ≥ 2.3.0. Bumping this means updating the
/// SHA-256 constants below (dl.deno.land/release/v{VER}/deno-{TARGET}.zip.sha256sum).
const DENO_VERSION: &str = "2.9.7";

#[cfg(target_os = "windows")] const TARGET: &str = "x86_64-pc-windows-msvc";
#[cfg(target_os = "macos")]   const TARGET: &str = "aarch64-apple-darwin";
#[cfg(target_os = "linux")]   const TARGET: &str = "x86_64-unknown-linux-gnu";

#[cfg(target_os = "windows")]
const ZIP_SHA256: &str = "a0c3101b4158d1dfb7d6a78a7bf0f3de80c96bb423c152beec8beb22786f2238";
#[cfg(target_os = "macos")]
const ZIP_SHA256: &str = "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c";
#[cfg(target_os = "linux")]
const ZIP_SHA256: &str = ""; // Linux isn't shipped — provisioning is skipped there.

#[cfg(windows)]      const BIN_NAME: &str = "deno.exe";
#[cfg(not(windows))] const BIN_NAME: &str = "deno";

/// Serializes installs so the boot prefetch and a download never fetch twice.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

/// Breadcrumb → feedback activity trail (download:diag, see diagnostics.js) + log.
fn diag(app: &AppHandle, msg: impl AsRef<str>) {
    let m = msg.as_ref();
    log::info!(target: "JsRuntime", "{m}");
    let _ = app.emit("download:diag", format!("[js-runtime] {m}"));
}

fn managed_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("bin").join(BIN_NAME))
}

/// The installed deno, if present. Never blocks or downloads.
pub fn ready_path(app: &AppHandle) -> Option<PathBuf> {
    managed_path(app).filter(|p| p.exists())
}

/// Return the managed deno, downloading + installing it first if needed. Blocking.
/// `progress` receives 0.0..=1.0 while the zip downloads (only when the server
/// reports a size).
pub fn ensure(app: &AppHandle, progress: &dyn Fn(f64)) -> Result<PathBuf, String> {
    if ZIP_SHA256.is_empty() { return Err("unsupported platform".into()); }
    let path = managed_path(app).ok_or("no app_data_dir")?;
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if path.exists() { return Ok(path); }
    install(app, &path, progress).map_err(|e| {
        diag(app, format!("install failed: {e}"));
        e
    })?;
    Ok(path)
}

/// Install deno in the background a little after boot, so it's already there by
/// the time the user saves their first YouTube link. Offline-safe: a failure just
/// leaves the on-demand `ensure` in `run_ytdlp` to try again.
pub fn prefetch_in_background(app: &AppHandle) {
    if ZIP_SHA256.is_empty() || ready_path(app).is_some() { return; }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15)); // let startup work settle first
        let _ = ensure(&app, &|_| {});
    });
}

/// yt-dlp arguments that enable a JS runtime: the managed deno when installed, plus
/// a system Node (≥ 22) as a fallback for the rare install where deno couldn't be
/// fetched. yt-dlp ignores runtimes it can't find or that are too old.
pub fn ytdlp_args(deno: Option<&Path>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(p) = deno {
        args.push("--js-runtimes".to_string());
        args.push(format!("deno:{}", p.to_string_lossy()));
    }
    args.push("--js-runtimes".to_string());
    args.push("node".to_string());
    args
}

/// Download sources, tried in order. The api.bloot.app mirror (R2, fast for our
/// users) is optional — if the object isn't there it 404s and we fall back to the
/// official Deno CDN. Both are checked against the same pinned SHA-256.
fn sources() -> [String; 2] {
    [
        format!("https://api.bloot.app/download/deno-{DENO_VERSION}-{TARGET}.zip"),
        format!("https://dl.deno.land/release/v{DENO_VERSION}/deno-{TARGET}.zip"),
    ]
}

fn install(app: &AppHandle, dest: &Path, progress: &dyn Fn(f64)) -> Result<(), String> {
    let dir = dest.parent().ok_or("bad path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let zip_path = dir.join(format!("deno-{DENO_VERSION}.zip.part"));
    let bin_part = dest.with_extension("part");

    let mut last_err = String::from("no source");
    let mut fetched = false;
    for url in sources() {
        diag(app, format!("downloading deno {DENO_VERSION} from {url}"));
        match fetch_verified(&url, &zip_path, progress) {
            Ok(bytes) => {
                diag(app, format!("downloaded {} MB, checksum ok", bytes / 1_048_576));
                fetched = true;
                break;
            }
            Err(e) => {
                diag(app, format!("source failed: {e}"));
                last_err = e;
            }
        }
    }
    if !fetched {
        let _ = std::fs::remove_file(&zip_path);
        return Err(last_err);
    }

    let extracted = extract_binary(&zip_path, &bin_part);
    let _ = std::fs::remove_file(&zip_path);
    extracted?;

    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&bin_part, std::fs::Permissions::from_mode(0o755));
    }
    // We write the file ourselves so it shouldn't carry a quarantine flag, but strip
    // it defensively — Gatekeeper must never block the helper (deno itself is signed
    // and notarized by Deno Land, so it runs from app-data without prompts).
    #[cfg(target_os = "macos")]
    { let _ = std::process::Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(&bin_part).status(); }

    // Smoke test before exposing it: a truncated/blocked binary must never become
    // the runtime every YouTube download depends on.
    let version = crate::commands::hidden_command(&bin_part).arg("--version").output()
        .map_err(|e| { let _ = std::fs::remove_file(&bin_part); format!("deno won't start: {e}") })?;
    if !version.status.success() {
        let _ = std::fs::remove_file(&bin_part);
        return Err(format!("deno --version failed ({:?})", version.status.code()));
    }

    std::fs::rename(&bin_part, dest).map_err(|e| e.to_string())?;
    let first_line = String::from_utf8_lossy(&version.stdout).lines().next().unwrap_or("").to_string();
    diag(app, format!("installed: {first_line}"));
    Ok(())
}

/// Stream `url` to `out`, hashing as we go. Errors unless the SHA-256 matches the
/// pinned release. Returns the byte count.
fn fetch_verified(url: &str, out: &Path, progress: &dyn Fn(f64)) -> Result<u64, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))   // per-read stall limit, not a total cap
        .build();
    let resp = agent.get(url).call().map_err(|e| e.to_string())?;
    let total: Option<u64> = resp.header("Content-Length").and_then(|v| v.parse().ok());

    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if let Some(t) = total.filter(|t| *t > 0) { progress((done as f64 / t as f64).min(1.0)); }
    }
    file.flush().map_err(|e| e.to_string())?;

    let got = hex::encode(hasher.finalize());
    if got != ZIP_SHA256 {
        return Err(format!("checksum mismatch (got {got}, {done} bytes)"));
    }
    Ok(done)
}

fn extract_binary(zip_path: &Path, out: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("bad zip: {e}"))?;
    let mut entry = archive.by_name(BIN_NAME).map_err(|e| format!("{BIN_NAME} not in zip: {e}"))?;
    let mut o = std::fs::File::create(out).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut o).map_err(|e| e.to_string())?;
    o.flush().map_err(|e| e.to_string())?;
    Ok(())
}
