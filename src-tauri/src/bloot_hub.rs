//! qooti's account comes from bloot apps (MD/bloot-apps-licensing.md §5.3, §9).
//!
//! bloot apps signs in (Telegram or bloot ID) and keeps a signed licence ticket in
//! the shared "Bloot Apps" folder. qooti never signs in itself: it verifies that
//! ticket — Ed25519 signature, this computer's device id, expiry — and takes the
//! name, bloot ID and plan from it. Everything here is offline and takes < 1 ms.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::{commands, AppState};

/// Public halves of the licence signing keys, by `kid` (same list as bloot apps).
const KEYS: &[(&str, &str)] = &[("lic-2026-10", "BRSpQbJiunsoEHUC3J2ypRz8Oc6/4wMn7jsPcuB58Uo=")];

/// A clock set back more than this before the newest ticket qooti has seen counts as tampering.
const ROLLBACK_SLACK_MS: i64 = 48 * 60 * 60 * 1000;

#[derive(Deserialize)]
struct Ticket {
    kid: String,
    bloot_id: String,
    #[serde(default)]
    name: Option<String>,
    tier: String,
    #[serde(default)]
    pro_until: Option<i64>,
    device_id: String,
    iat: i64,
    exp: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Account {
    /// signed_in | signed_out | expired
    pub state: String,
    pub name: Option<String>,
    pub bloot_id: Option<String>,
    /// free | pro (only meaningful when signed_in)
    pub tier: String,
    pub pro_until: Option<i64>,
    /// bloot apps is on this computer (so "Continue with bloot apps" can open it).
    pub hub_installed: bool,
}

// ── shared folder ────────────────────────────────────────────────────────────

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

/// %LOCALAPPDATA%\Bloot\Apps (Windows), ~/Library/Application Support/Bloot/Apps (macOS).
fn bloot_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData").join("Local"));
    #[cfg(target_os = "macos")]
    let base = home().join("Library").join("Application Support");
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = home().join(".local").join("share");
    base.join("Bloot").join("Apps")
}

fn shared(name: &str) -> PathBuf { bloot_dir().join(name) }

fn read_json(name: &str) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(shared(name)).ok()?).ok()
}

fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }

// ── ticket ───────────────────────────────────────────────────────────────────

/// Signature + key id + device check (§5.3 steps 2–4). Expiry is checked by the caller.
fn verify(raw: &str, device_id: &str) -> Option<Ticket> {
    let mut parts = raw.trim().split('.');
    let (Some("v1"), Some(p), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return None };
    let t: Ticket = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).ok()?).ok()?;
    let key_b64 = KEYS.iter().find(|(k, _)| *k == t.kid)?.1;
    let key = VerifyingKey::from_bytes(&STANDARD.decode(key_b64).ok()?.try_into().ok()?).ok()?;
    let sig: [u8; 64] = URL_SAFE_NO_PAD.decode(s).ok()?.try_into().ok()?;
    key.verify_strict(format!("v1.{p}").as_bytes(), &Signature::from_bytes(&sig)).ok()?;
    (t.device_id == device_id).then_some(t)
}

/// The newest `iat` qooti has accepted, for the clock-rollback guard (§5.3 step 5).
fn max_iat_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("bloot-max-iat"))
}

fn hub_installed() -> bool {
    shared("hub.json").exists() || hub_exe().is_some()
}

pub fn account(app: &AppHandle) -> Account {
    let signed_out = |state: &str| Account {
        state: state.into(), name: None, bloot_id: None, tier: "free".into(), pro_until: None, hub_installed: hub_installed(),
    };
    let Some(device_id) = read_json("device.json").and_then(|d| d["device_id"].as_str().map(str::to_string)) else {
        return signed_out("signed_out");
    };
    let Some(raw) = std::fs::read_to_string(shared("licence.ticket")).ok() else { return signed_out("signed_out") };
    let Some(t) = verify(&raw, &device_id) else { return signed_out("signed_out") };

    let now = now_ms();
    let file = max_iat_file(app);
    let seen: i64 = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    if t.iat > seen {
        if let Some(f) = &file {
            let _ = std::fs::create_dir_all(f.parent().unwrap());
            let _ = std::fs::write(f, t.iat.to_string());
        }
    }
    if now >= t.exp || now < seen.max(t.iat) - ROLLBACK_SLACK_MS { return signed_out("expired"); }

    Account {
        state: "signed_in".into(),
        name: t.name.filter(|n| !n.trim().is_empty()),
        bloot_id: Some(t.bloot_id),
        tier: if t.tier == "pro" { "pro".into() } else { "free".into() },
        pro_until: t.pro_until,
        hub_installed: true,
    }
}

// ── bloot apps: find, start, talk to ─────────────────────────────────────────

/// The installed bloot apps executable (per-user NSIS install / Applications).
fn hub_exe() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
        return ["bloot apps.exe", "bloot-apps.exe"].iter().map(|exe| local.join("bloot apps").join(exe)).find(|p| p.is_file());
    }
    #[cfg(target_os = "macos")]
    {
        return [PathBuf::from("/Applications/bloot apps.app"), home().join("Applications").join("bloot apps.app")]
            .into_iter().find(|p| p.exists());
    }
    #[allow(unreachable_code)]
    None
}

fn hub_port() -> Option<u64> { read_json("hub.json")?["port"].as_u64() }

fn hub_running() -> bool {
    let Some(port) = hub_port() else { return false };
    ureq::get(&format!("http://127.0.0.1:{port}/v1/hello")).timeout(Duration::from_millis(300)).call().is_ok()
}

/// Start bloot apps without a window (it refreshes the ticket in the background).
fn start_hub_in_background() {
    let Some(exe) = hub_exe() else { return };
    #[cfg(windows)]
    let _ = std::process::Command::new(exe).arg("--background").spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-g").arg("-a").arg(exe).args(["--args", "--background"]).spawn();
}

/// Hand a bloot:// link to bloot apps (registered by its installer; starts it if needed).
fn open_link(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // With the exe known, pass the link straight to it (works even if the link
        // registration is missing); otherwise let Windows route the bloot: scheme.
        let status = match hub_exe() {
            Some(exe) => std::process::Command::new(exe).arg(url).spawn().map(|_| ()),
            None => std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url])
                .creation_flags(0x0800_0000).spawn().map(|_| ()),
        };
        return status.map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("open").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Err("unsupported".into())
}

// ── commands ─────────────────────────────────────────────────────────────────

// ── bloot apps inside qooti (macOS) ──────────────────────────────────────────
// A DMG install can't run an installer, so qooti carries "bloot apps.app" in its
// resources (scripts/fetch-bloot-apps.mjs) and puts it into Applications on launch
// when it's missing or older (§13.2). Windows: qooti's installer does it (nsis-hooks.nsh).

#[cfg(target_os = "macos")]
fn bundle_version(app: &std::path::Path) -> String {
    std::process::Command::new("plutil")
        .args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"])
        .arg(app.join("Contents/Info.plist"))
        .output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| s.split(['.', '-']).map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(a) > parse(b)
}

#[cfg(target_os = "macos")]
fn install_bundled_hub(app: &AppHandle) {
    let Ok(res) = app.path().resource_dir() else { return };
    let bundled = res.join("bloot-apps").join("bloot apps.app");
    if !bundled.exists() { return; }
    let installed = hub_exe();
    if let Some(i) = &installed {
        if !newer(&bundle_version(&bundled), &bundle_version(i)) { return; }
    }
    // Where it already is (an update), else /Applications, else ~/Applications.
    let mut dirs = vec![PathBuf::from("/Applications"), home().join("Applications")];
    if let Some(dir) = installed.as_ref().and_then(|i| i.parent()) {
        dirs.retain(|d| d != dir);
        dirs.insert(0, dir.to_path_buf());
    }
    for dir in dirs {
        let _ = std::fs::create_dir_all(&dir);
        let dest = dir.join("bloot apps.app");
        let fresh = dir.join(".bloot apps.app.qooti-new");
        let old = dir.join(".bloot apps.app.qooti-old");
        let _ = std::fs::remove_dir_all(&fresh);
        // --noqtn: qooti.app carries the "downloaded" mark from its DMG; bloot apps,
        // started by qooti, must not inherit it.
        let copied = std::process::Command::new("ditto").arg("--noqtn").arg(&bundled).arg(&fresh)
            .status().map(|s| s.success()).unwrap_or(false);
        if !copied { let _ = std::fs::remove_dir_all(&fresh); continue; }
        let _ = std::fs::remove_dir_all(&old);
        if dest.exists() && std::fs::rename(&dest, &old).is_err() { let _ = std::fs::remove_dir_all(&fresh); return; }
        if std::fs::rename(&fresh, &dest).is_err() { let _ = std::fs::rename(&old, &dest); let _ = std::fs::remove_dir_all(&fresh); return; }
        let _ = std::fs::remove_dir_all(&old);
        log::info!(target: "bloot-apps", "installed bloot apps {} into {}", bundle_version(&dest), dir.display());
        return;
    }
}

/// Once per launch: share qooti's device id with bloot apps if it has none yet, so this
/// computer keeps counting as one device (§16); on macOS put the bundled bloot apps into
/// Applications if needed; then start bloot apps if it isn't running.
#[tauri::command]
pub fn hub_prepare(app: AppHandle, state: State<AppState>) {
    let device = shared("device.json");
    if !device.exists() {
        if let Ok(id) = commands::get_device_id(state) {
            let _ = std::fs::create_dir_all(bloot_dir().join("private"));
            let body = json!({ "device_id": id, "created_at": now_ms(), "created_by": "qooti" });
            let tmp = device.with_extension("json.tmp");
            if std::fs::write(&tmp, serde_json::to_string_pretty(&body).unwrap_or_default()).is_ok() {
                let _ = std::fs::rename(&tmp, &device);
            }
        }
    }
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        install_bundled_hub(&app);
        #[cfg(not(target_os = "macos"))]
        let _ = &app;
        if !hub_running() { start_hub_in_background(); }
    });
}

#[tauri::command]
pub fn hub_account(app: AppHandle) -> Account { account(&app) }

/// Open bloot apps on a screen: "signin" (comes back to qooti when done) or "account".
#[tauri::command]
pub fn hub_open(screen: String) -> Result<(), String> {
    if !hub_installed() { return Err("not_installed".into()); }
    let url = match screen.as_str() {
        "signin" => "bloot://signin?product=qooti",
        "account" => "bloot://account",
        _ => "bloot://open",
    };
    open_link(url)
}

/// Ask bloot apps to refresh the licence now (after a payment, or the refresh button),
/// then return the account as it is afterwards.
#[tauri::command]
pub async fn hub_refresh(app: AppHandle) -> Account {
    let _ = tauri::async_runtime::spawn_blocking(|| {
        if let Some(port) = hub_port() {
            let _ = ureq::post(&format!("http://127.0.0.1:{port}/v1/refresh"))
                .set("X-Bloot-Product", "qooti").timeout(Duration::from_secs(15)).call();
        }
    }).await;
    account(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_garbage_and_tampering() {
        assert!(verify("nope", "d").is_none());
        assert!(verify("v1.e30.AAAA", "d").is_none());
        let s = URL_SAFE_NO_PAD.encode([0u8; 64]);
        let unknown = URL_SAFE_NO_PAD.encode(br#"{"kid":"x","bloot_id":"B","tier":"pro","device_id":"d","iat":0,"exp":0}"#);
        assert!(verify(&format!("v1.{unknown}.{s}"), "d").is_none());
        let known = URL_SAFE_NO_PAD.encode(br#"{"kid":"lic-2026-10","bloot_id":"B","tier":"pro","device_id":"d","iat":0,"exp":0}"#);
        assert!(verify(&format!("v1.{known}.{s}"), "d").is_none());
    }

    /// The real ticket bloot apps keeps on this computer, if signed in:
    /// cargo test real_hub_ticket -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_hub_ticket() {
        let device = read_json("device.json").unwrap()["device_id"].as_str().unwrap().to_string();
        let raw = std::fs::read_to_string(shared("licence.ticket")).unwrap();
        let t = verify(&raw, &device).expect("bloot apps' ticket verifies");
        println!("{} {:?} tier={} exp in {} h", t.bloot_id, t.name, t.tier, (t.exp - now_ms()) / 3_600_000);
        assert!(verify(&raw, "another-computer").is_none(), "a copied ticket must not verify");
        println!("hub installed: {}, running: {}, exe: {:?}", hub_installed(), hub_running(), hub_exe());
    }
}
