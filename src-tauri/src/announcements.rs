//! qooti notifications — "announcements" in the code (MD/qooti-notifications-spec.md §4.6).
//!
//! bloot writes short messages (news, tips, updates, offers) on the admin page; qooti shows
//! them under the bell in the top bar. This module talks to api.bloot.app from Rust (§2.1),
//! keeps the last list in the local `notifications` / `notification_reads` tables (no schema
//! change: `data` holds the whole announcement in both languages, `type` the kind, `title` /
//! `body` the English text, `created_at` the publish time), downloads each image once into
//! `<app data>/announcements/` and hands the page a `data:` URL (the CSP allows no remote
//! images), and reports "seen" and "click". Reports that can't be sent wait in a small queue
//! (popped / seen / clicked flags and the queue live in the `announcements_state` preference)
//! and go out with the next sync.
//!
//! The server is not trusted: everything it sends is checked here (ids, kinds, lengths,
//! https-only links, the image address, size and bytes) and whatever is off is dropped. The
//! sign-in ticket is read from bloot apps' shared folder by bloot_hub.rs and only ever leaves
//! in a request body to the API; no command hands it to the page.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// The bloot API. Debug builds only: `QOOTI_API_BASE` points qooti at another one (a local
/// `wrangler dev` for end-to-end tests). Release builds never read the variable.
const API_BASE: &str = "https://api.bloot.app";
/// Images come only from `<API>/download/ann-<id>-<sha12>.<ext>` (§2.4).
const IMAGE_PATH: &str = "/download/ann-";
const STATE_KEY: &str = "announcements_state";
const IMAGE_DIR: &str = "announcements";

const MAX_ITEMS: usize = 20;
const MAX_TITLE: usize = 80;
const MAX_BODY: usize = 600;
const MAX_LABEL: usize = 24;
const MAX_LINK: usize = 500;
const MAX_IMAGE_BYTES: u64 = 1024 * 1024;
const MAX_IMAGE_SIDE: u64 = 10_000;
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
const MAX_PENDING: usize = 200;
/// How many popped / seen / clicked ids are remembered (oldest forgotten first).
const MAX_REMEMBERED: usize = 500;
/// The server counts late reports up to 7 days after an announcement ended; older ones go.
const PENDING_MAX_AGE_MS: i64 = 8 * 24 * 60 * 60 * 1000;
const CHECK_DEFAULT_S: u32 = 1800;
const CHECK_MIN_S: u32 = 900;
const CHECK_MAX_S: u32 = 21_600;
const KINDS: [&str; 5] = ["news", "tip", "update", "offer", "important"];

// ── types ────────────────────────────────────────────────────────────────────

/// A text in English and (optionally) Uzbek. The page shows Uzbek when there is one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Text {
    pub en: String,
    pub uz: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Button {
    pub label: Text,
    /// "link" (an https address) | "screen" (a screen key, §4.4)
    pub action: String,
    pub target: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Image {
    pub url: String,
    pub w: u32,
    pub h: u32,
}

/// One announcement as checked here. Also the shape kept in `notifications.data`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Announcement {
    pub id: String,
    pub kind: String,
    pub title: Text,
    pub body: Text,
    pub button: Option<Button>,
    pub image: Option<Image>,
    pub popup: bool,
    pub pinned: bool,
    pub published_at: i64,
    pub ends_at: Option<i64>,
    pub test: bool,
}

/// The image as the page gets it: a `data:` URL of the downloaded file.
#[derive(Serialize, Clone, Debug)]
pub struct ShownImage {
    pub src: String,
    pub w: u32,
    pub h: u32,
}

/// One row of the bell's list.
#[derive(Serialize, Clone, Debug)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub title: Text,
    pub body: Text,
    pub button: Option<Button>,
    /// None until the picture has been downloaded (or when it couldn't be)
    pub image: Option<ShownImage>,
    pub popup: bool,
    pub pinned: bool,
    pub published_at: i64,
    pub ends_at: Option<i64>,
    pub test: bool,
    pub read: bool,
    /// "seen" was reported (or queued)
    pub seen: bool,
    /// already shown as a pop-up
    pub popped: bool,
}

/// What `announcements_list` / `announcements_sync` return.
#[derive(Serialize, Clone, Debug)]
pub struct AnnouncementList {
    pub items: Vec<Item>,
    pub unread: usize,
    /// When the server last answered (ms); None = never, nothing cached yet
    pub last_sync: Option<i64>,
    /// Seconds until the next regular check (the server's choice, clamped 900–21600)
    pub next_check_s: u32,
    /// This call reached the server (false: offline, or just the cache)
    pub synced: bool,
}

/// A report waiting to be sent.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Pending {
    id: String,
    kind: String,
    lang: String,
    at: i64,
}

/// The `announcements_state` preference.
#[derive(Serialize, Deserialize, Default, Debug)]
struct LocalState {
    #[serde(default)]
    popped: Vec<String>,
    #[serde(default)]
    seen: Vec<String>,
    #[serde(default)]
    clicked: Vec<String>,
    #[serde(default)]
    pending: Vec<Pending>,
    #[serde(default)]
    last_sync: Option<i64>,
    #[serde(default)]
    next_check_s: Option<u32>,
}

/// Who is asking: the raw sign-in ticket and the shared device id, sent to the API only.
/// No Serialize on purpose, and Debug never prints the ticket.
pub(crate) struct Identity {
    ticket: Option<String>,
    device_id: Option<String>,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("ticket", &self.ticket.as_ref().map(|_| "(set)"))
            .field("device_id", &self.device_id)
            .finish()
    }
}

impl Identity {
    fn read() -> Self {
        Identity {
            ticket: crate::bloot_hub::raw_ticket(),
            device_id: crate::bloot_hub::shared_device_id().filter(|d| looks_like_uuid(d)),
        }
    }
}

/// Where images may come from.
struct Rules {
    image_prefixes: Vec<String>,
}

impl Rules {
    fn for_base(base: &str) -> Self {
        let mut image_prefixes = vec![format!("{API_BASE}{IMAGE_PATH}")];
        // Only a debug build can have another base (base_from): its local server's images too.
        if base != API_BASE {
            image_prefixes.push(format!("{base}{IMAGE_PATH}"));
        }
        Rules { image_prefixes }
    }
}

// ── API address ──────────────────────────────────────────────────────────────

fn api_base() -> String {
    base_from(cfg!(debug_assertions), std::env::var("QOOTI_API_BASE").ok())
}

/// The override is taken only in a debug build, and only for an https address or a local
/// http one (127.0.0.1 / localhost).
fn base_from(debug: bool, var: Option<String>) -> String {
    if debug {
        if let Some(v) = var {
            let v = v.trim().trim_end_matches('/');
            let local_http = v.strip_prefix("http://").is_some_and(|rest| {
                let host = rest.split(|c| c == '/' || c == ':').next().unwrap_or("");
                host == "127.0.0.1" || host == "localhost"
            });
            let ok = v.len() <= 200
                && (v.starts_with("https://") && v.len() > 8 || local_http)
                && v.bytes().all(|b| b.is_ascii_graphic());
            if ok {
                return v.to_string();
            }
        }
    }
    API_BASE.to_string()
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") { "mac" } else { "windows" }
}

fn now_ms() -> i64 {
    crate::commands::now_ms()
}

// ── checking what the server sends ───────────────────────────────────────────

/// 'ann_' + 16 lowercase letters / digits.
fn valid_id(s: &str) -> bool {
    s.len() == 20 && s.starts_with("ann_") && s[4..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// Plain text: line ends made LF, control and text-direction characters dropped, trimmed.
/// `multiline` keeps line breaks (messages); otherwise they become spaces (titles, labels).
/// Empty or longer than `max` characters → None.
fn clean(s: &str, max: usize, multiline: bool) -> Option<String> {
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\n' if multiline => out.push('\n'),
            '\n' | '\t' => out.push(' '),
            '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    let t = out.trim();
    (!t.is_empty() && t.chars().count() <= max).then(|| t.to_string())
}

/// `{ en: "…", uz: "…" | null }`: English required, Uzbek optional (empty = none).
fn text_pair(v: &Value, max: usize, multiline: bool) -> Option<Text> {
    let en = clean(v.get("en")?.as_str()?, max, multiline)?;
    let uz = match v.get("uz") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => Some(clean(s, max, multiline)?),
        Some(_) => return None,
    };
    Some(Text { en, uz })
}

/// An https address, ASCII only, a real host name, no user name in it, ≤ 500 characters.
fn valid_link(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("https://") else { return false };
    if s.len() > MAX_LINK {
        return false;
    }
    let end = rest.find(|c| matches!(c, '/' | '?' | '#')).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    let edge = |c: char| c == '.' || c == '-';
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !host.starts_with(edge)
        && !host.ends_with(edge);
    let port_ok = port.map_or(true, |p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()));
    let tail_ok = tail.bytes().all(|b| b.is_ascii_graphic() && !b"\"<>\\^`{|}".contains(&b));
    host_ok && port_ok && tail_ok
}

/// A screen key like `settings:library`. Keys this version doesn't know pass (the page just
/// closes the panel for them, §4.4); anything not key-shaped doesn't.
fn valid_screen(s: &str) -> bool {
    (1..=40).contains(&s.len())
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b':' | b'_' | b'-'))
}

/// A broken button is dropped; the message itself still shows.
fn parse_button(v: &Value) -> Option<Button> {
    if v.is_null() {
        return None;
    }
    let label = text_pair(v.get("label")?, MAX_LABEL, false)?;
    let target = v.get("target")?.as_str()?.trim();
    let action = v.get("action")?.as_str()?;
    let ok = match action {
        "link" => valid_link(target),
        "screen" => valid_screen(target),
        _ => false,
    };
    ok.then(|| Button { label, action: action.to_string(), target: target.to_string() })
}

/// The file name of an allowed image address (`ann-….png|jpg|jpeg|webp`), or None.
fn image_name(url: &str, rules: &Rules) -> Option<String> {
    if url.len() > MAX_LINK {
        return None;
    }
    let rest = rules.image_prefixes.iter().find_map(|p| url.strip_prefix(p.as_str()))?;
    let name = format!("ann-{rest}");
    let (stem, ext) = name.rsplit_once('.')?;
    let ok = name.len() <= 120
        && stem.len() > 4
        && stem.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && matches!(ext, "png" | "jpg" | "jpeg" | "webp");
    ok.then_some(name)
}

/// A broken image is dropped; the message itself still shows.
fn parse_image(v: &Value, rules: &Rules) -> Option<Image> {
    if v.is_null() {
        return None;
    }
    let url = v.get("url")?.as_str()?;
    image_name(url, rules)?;
    let side = |k: &str| v.get(k)?.as_u64().filter(|n| (1..=MAX_IMAGE_SIDE).contains(n)).map(|n| n as u32);
    Some(Image { url: url.to_string(), w: side("w")?, h: side("h")? })
}

fn int(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15).map(|f| f as i64))
}

/// One announcement from the server (or from the cache, which keeps the same shape).
/// None when something it can't do without is missing or off.
fn parse_announcement(v: &Value, rules: &Rules) -> Option<Announcement> {
    let id = v.get("id")?.as_str().filter(|s| valid_id(s))?.to_string();
    // A kind this version doesn't know (a newer server) shows as news.
    let kind = match v.get("kind")?.as_str()? {
        k if KINDS.contains(&k) => k.to_string(),
        k if (1..=24).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') => "news".to_string(),
        _ => return None,
    };
    let title = text_pair(v.get("title")?, MAX_TITLE, false)?;
    let body = text_pair(v.get("body")?, MAX_BODY, true)?;
    let published_at = int(v.get("published_at")?).filter(|t| *t >= 0)?;
    let ends_at = match v.get("ends_at") {
        None | Some(Value::Null) => None,
        Some(e) => Some(int(e)?),
    };
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    Some(Announcement {
        id,
        kind,
        title,
        body,
        button: v.get("button").and_then(parse_button),
        image: v.get("image").and_then(|i| parse_image(i, rules)),
        popup: flag("popup"),
        pinned: flag("pinned"),
        published_at,
        ends_at,
        test: flag("test"),
    })
}

fn sort_items(items: &mut [Announcement]) {
    items.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.published_at.cmp(&a.published_at)));
}

struct Fetched {
    items: Vec<Announcement>,
    next_check_s: u32,
}

/// The answer of `POST /v1/announcements`. None when it isn't the expected shape at all;
/// otherwise the valid announcements (at most 20, first of each id), pinned first, newest first.
fn parse_response(bytes: &[u8], rules: &Rules) -> Option<Fetched> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let list = v.get("announcements")?.as_array()?;
    let mut ids = HashSet::new();
    let mut items = Vec::new();
    for a in list.iter().take(MAX_ITEMS * 5) {
        if items.len() == MAX_ITEMS {
            break;
        }
        if let Some(a) = parse_announcement(a, rules) {
            if ids.insert(a.id.clone()) {
                items.push(a);
            }
        }
    }
    sort_items(&mut items);
    let next_check_s = v
        .get("next_check_s")
        .and_then(int)
        .map(|n| n.clamp(CHECK_MIN_S as i64, CHECK_MAX_S as i64) as u32)
        .unwrap_or(CHECK_DEFAULT_S);
    Some(Fetched { items, next_check_s })
}

/// PNG, JPEG or WebP by its first bytes.
fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

// ── local state ──────────────────────────────────────────────────────────────

fn lock(db: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|e| e.into_inner())
}

fn trim_front<T>(v: &mut Vec<T>, max: usize) {
    if v.len() > max {
        v.drain(..v.len() - max);
    }
}

fn load_state(conn: &Connection) -> LocalState {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM preferences WHERE key = ?1", [STATE_KEY], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let mut s: LocalState = raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
    for list in [&mut s.popped, &mut s.seen, &mut s.clicked] {
        list.retain(|id| valid_id(id));
        trim_front(list, MAX_REMEMBERED);
    }
    s.pending.retain(|p| valid_id(&p.id) && matches!(p.kind.as_str(), "seen" | "click") && matches!(p.lang.as_str(), "en" | "uz"));
    trim_front(&mut s.pending, MAX_PENDING);
    s.next_check_s = s.next_check_s.map(|n| n.clamp(CHECK_MIN_S, CHECK_MAX_S));
    s
}

fn save_state(conn: &Connection, s: &LocalState) -> rusqlite::Result<()> {
    let text = serde_json::to_string(s).unwrap_or_else(|_| "{}".into());
    conn.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)", params![STATE_KEY, text])?;
    Ok(())
}

fn app_lang(conn: &Connection) -> &'static str {
    let v: Option<String> = conn.query_row("SELECT value FROM preferences WHERE key = 'language'", [], |r| r.get(0)).ok();
    if v.as_deref() == Some("uz") { "uz" } else { "en" }
}

/// The list the server sent becomes the cache: rows it no longer sends go (with their read
/// mark), the others are updated in place so a read mark stays.
fn replace_cache(conn: &Connection, items: &[Announcement]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let keep: HashSet<&str> = items.iter().map(|a| a.id.as_str()).collect();
    let old: Vec<String> = {
        let mut st = tx.prepare("SELECT id FROM notifications")?;
        let rows: Vec<String> = st.query_map([], |r| r.get(0))?.filter_map(Result::ok).collect();
        rows
    };
    for id in old.iter().filter(|id| !keep.contains(id.as_str())) {
        tx.execute("DELETE FROM notification_reads WHERE notification_id = ?1", [id])?;
        tx.execute("DELETE FROM notifications WHERE id = ?1", [id])?;
    }
    for a in items {
        let data = serde_json::to_string(a).unwrap_or_default();
        tx.execute(
            "INSERT INTO notifications (id, type, title, body, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title, body = excluded.body,
                                           data = excluded.data, created_at = excluded.created_at",
            params![a.id, a.kind, a.title.en, a.body.en, data, a.published_at],
        )?;
    }
    tx.commit()
}

/// The cached announcements with their read mark, pinned first, newest first. Rows that don't
/// hold a valid announcement (the old local notifications) are left out.
fn cached(conn: &Connection, rules: &Rules) -> Vec<(Announcement, bool)> {
    let Ok(mut st) = conn.prepare(
        "SELECT n.data, r.notification_id IS NOT NULL
         FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id",
    ) else {
        return Vec::new();
    };
    let rows: Vec<(Option<String>, bool)> = st
        .query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, bool>(1)?)))
        .map(|it| it.filter_map(Result::ok).collect())
        .unwrap_or_default();
    let mut out: Vec<(Announcement, bool)> = rows
        .into_iter()
        .filter_map(|(data, read)| {
            let v: Value = serde_json::from_str(data.as_deref()?).ok()?;
            Some((parse_announcement(&v, rules)?, read))
        })
        .collect();
    out.sort_by(|(a, _), (b, _)| b.pinned.cmp(&a.pinned).then(b.published_at.cmp(&a.published_at)));
    out
}

fn cached_one(conn: &Connection, id: &str, rules: &Rules) -> Option<Announcement> {
    let data: Option<String> = conn
        .query_row("SELECT data FROM notifications WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    parse_announcement(&serde_json::from_str(&data?).ok()?, rules)
}

fn mark_read(conn: &Connection, ids: &[String], now: i64) -> usize {
    ids.iter()
        .filter(|id| valid_id(id))
        .take(100)
        .map(|id| {
            conn.execute(
                "INSERT OR IGNORE INTO notification_reads (notification_id, read_at) SELECT id, ?2 FROM notifications WHERE id = ?1",
                params![id, now],
            )
            .unwrap_or(0)
        })
        .sum()
}

// ── images ───────────────────────────────────────────────────────────────────

/// `data:` URLs of the downloaded images, by file, so the files are read once per run.
static DATA_URLS: Lazy<Mutex<HashMap<PathBuf, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn data_url(dir: &Path, name: &str) -> Option<String> {
    let path = dir.join(name);
    if let Some(u) = DATA_URLS.lock().unwrap_or_else(|e| e.into_inner()).get(&path) {
        return Some(u.clone());
    }
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let url = format!("data:{};base64,{}", sniff(&bytes)?, STANDARD.encode(&bytes));
    DATA_URLS.lock().unwrap_or_else(|e| e.into_inner()).insert(path, url.clone());
    Some(url)
}

/// An image download: status 200, an image content type that the bytes agree with, ≤ 1 MB.
fn download_image(net: &dyn Net, url: &str) -> Result<Vec<u8>, String> {
    let (status, ctype, bytes) = net.get(url, MAX_IMAGE_BYTES)?;
    if status != 200 {
        return Err(format!("status {status}"));
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("too big".into());
    }
    let ctype = ctype.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let declared = match ctype.as_str() {
        "image/png" => "image/png",
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/webp" => "image/webp",
        _ => return Err(format!("not an image type ({ctype})")),
    };
    match sniff(&bytes) {
        Some(m) if m == declared => Ok(bytes),
        _ => Err("the bytes are not the declared image type".into()),
    }
}

/// Images not on disk yet are downloaded (once: the names change with the content).
fn fetch_images(net: &dyn Net, dir: &Path, items: &[Announcement], rules: &Rules) {
    for img in items.iter().filter_map(|a| a.image.as_ref()) {
        let Some(name) = image_name(&img.url, rules) else { continue };
        let path = dir.join(&name);
        if path.is_file() {
            continue;
        }
        match download_image(net, &img.url) {
            Ok(bytes) => {
                let _ = std::fs::create_dir_all(dir);
                let part = dir.join(format!("{name}.part"));
                if std::fs::write(&part, &bytes).is_ok() && std::fs::rename(&part, &path).is_ok() {
                    continue;
                }
                let _ = std::fs::remove_file(&part);
                log::warn!(target: "Announcements", "image not saved: {name}");
            }
            Err(e) => log::info!(target: "Announcements", "image not downloaded: {e}"),
        }
    }
}

/// After a sync: files of announcements that are gone are removed.
fn prune_images(dir: &Path, items: &[Announcement], rules: &Rules) {
    let keep: HashSet<String> = items.iter().filter_map(|a| image_name(&a.image.as_ref()?.url, rules)).collect();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !keep.contains(&name) && e.path().is_file() {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    DATA_URLS.lock().unwrap_or_else(|e| e.into_inner()).retain(|p, _| {
        !p.starts_with(dir) || p.file_name().is_some_and(|n| keep.contains(n.to_string_lossy().as_ref()))
    });
}

// ── the list for the page ────────────────────────────────────────────────────

fn build_list(conn: &Connection, dir: Option<&Path>, rules: &Rules, now: i64, synced: bool) -> AnnouncementList {
    let st = load_state(conn);
    let popped: HashSet<&str> = st.popped.iter().map(String::as_str).collect();
    let seen: HashSet<&str> = st.seen.iter().map(String::as_str).collect();
    let items: Vec<Item> = cached(conn, rules)
        .into_iter()
        .filter(|(a, _)| a.ends_at.map_or(true, |e| e > now))
        .take(MAX_ITEMS)
        .map(|(a, read)| {
            let image = a.image.as_ref().and_then(|img| {
                let src = data_url(dir?, &image_name(&img.url, rules)?)?;
                Some(ShownImage { src, w: img.w, h: img.h })
            });
            Item {
                seen: seen.contains(a.id.as_str()),
                popped: popped.contains(a.id.as_str()),
                id: a.id,
                kind: a.kind,
                title: a.title,
                body: a.body,
                button: a.button,
                image,
                popup: a.popup,
                pinned: a.pinned,
                published_at: a.published_at,
                ends_at: a.ends_at,
                test: a.test,
                read,
            }
        })
        .collect();
    AnnouncementList {
        unread: items.iter().filter(|i| !i.read).count(),
        items,
        last_sync: st.last_sync,
        next_check_s: st.next_check_s.unwrap_or(CHECK_DEFAULT_S),
        synced,
    }
}

// ── network ──────────────────────────────────────────────────────────────────

/// What sync and reports need from the network (tests use a stand-in).
trait Net {
    /// POST a JSON body → (status, body of at most 512 KB)
    fn post_json(&self, url: &str, body: &str) -> Result<(u16, Vec<u8>), String>;
    /// GET → (status, content type, body of at most `max` + 1 bytes)
    fn get(&self, url: &str, max: u64) -> Result<(u16, String, Vec<u8>), String>;
}

struct Http {
    agent: ureq::Agent,
}

impl Http {
    fn new(base: &str) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(20))
            .redirects(3)
            // Never off https, except a debug build pointed at a local server.
            .https_only(base.starts_with("https://"))
            .user_agent(&format!("qooti/{}", env!("CARGO_PKG_VERSION")))
            .build();
        Http { agent }
    }

    fn read(resp: ureq::Response, max: u64) -> Result<Vec<u8>, String> {
        if resp.header("Content-Length").and_then(|l| l.trim().parse::<u64>().ok()).is_some_and(|l| l > max) {
            return Err("too big".into());
        }
        let mut buf = Vec::new();
        resp.into_reader().take(max + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

impl Net for Http {
    fn post_json(&self, url: &str, body: &str) -> Result<(u16, Vec<u8>), String> {
        let resp = match self.agent.post(url).set("Content-Type", "application/json").send_string(body) {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(e.to_string()),
        };
        let status = resp.status();
        let bytes = Self::read(resp, MAX_RESPONSE_BYTES)?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err("answer too big".into());
        }
        Ok((status, bytes))
    }

    fn get(&self, url: &str, max: u64) -> Result<(u16, String, Vec<u8>), String> {
        let resp = match self.agent.get(url).call() {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(e.to_string()),
        };
        let status = resp.status();
        let ctype = resp.header("Content-Type").unwrap_or("").to_string();
        Ok((status, ctype, Self::read(resp, max)?))
    }
}

/// The fields every request carries (§2.1).
fn base_body(ident: &Identity, lang: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("product".into(), json!("qooti"));
    if let Some(t) = &ident.ticket {
        m.insert("ticket".into(), json!(t));
    }
    if let Some(d) = &ident.device_id {
        m.insert("device_id".into(), json!(d));
    }
    m.insert("lang".into(), json!(lang));
    m.insert("app_version".into(), json!(env!("CARGO_PKG_VERSION")));
    m.insert("platform".into(), json!(platform()));
    m
}

/// Reports one at a time, oldest first. Sent or refused for good (4xx): off the queue.
/// Offline, rate-limited or a server problem: stop, the rest waits for the next sync.
fn flush_pending(db: &Mutex<Connection>, net: &dyn Net, ident: &Identity, base: &str, now: i64, busy: &AtomicBool) -> usize {
    if busy.swap(true, Ordering::SeqCst) {
        return 0; // another flush is running
    }
    let _done = Release(busy);
    let batch: Vec<Pending> = {
        let conn = lock(db);
        let mut st = load_state(&conn);
        let before = st.pending.len();
        st.pending.retain(|p| now - p.at < PENDING_MAX_AGE_MS);
        if st.pending.len() != before {
            let _ = save_state(&conn, &st);
        }
        st.pending.clone()
    };
    if batch.is_empty() {
        return 0;
    }
    let url = format!("{base}/v1/announcements/event");
    let mut sent = Vec::new();
    for p in &batch {
        let mut body = base_body(ident, &p.lang);
        body.insert("id".into(), json!(p.id));
        body.insert("kind".into(), json!(p.kind));
        match net.post_json(&url, &Value::Object(body).to_string()) {
            Ok((s, _)) if (200..300).contains(&s) => sent.push(p.clone()),
            Ok((400 | 403 | 404 | 409 | 410 | 422, _)) => sent.push(p.clone()),
            Ok((s, _)) => {
                log::info!(target: "Announcements", "report kept for later: status {s}");
                break;
            }
            Err(e) => {
                log::info!(target: "Announcements", "report kept for later: {e}");
                break;
            }
        }
    }
    if !sent.is_empty() {
        let conn = lock(db);
        let mut st = load_state(&conn);
        st.pending.retain(|p| !sent.contains(p));
        let _ = save_state(&conn, &st);
    }
    sent.len()
}

struct Release<'a>(&'a AtomicBool);
impl Drop for Release<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Ask the server, keep what it says (cache, images, next check), send waiting reports,
/// return the list. Offline or a bad answer: the cache stays as it was.
fn sync_core(
    db: &Mutex<Connection>,
    dir: Option<&Path>,
    net: &dyn Net,
    ident: &Identity,
    base: &str,
    lang: &str,
    now: i64,
    flushing: &AtomicBool,
) -> AnnouncementList {
    let rules = Rules::for_base(base);
    let body = Value::Object(base_body(ident, lang)).to_string();
    let fetched = match net.post_json(&format!("{base}/v1/announcements"), &body) {
        Ok((200, bytes)) => {
            let f = parse_response(&bytes, &rules);
            if f.is_none() {
                log::warn!(target: "Announcements", "sync: unexpected answer");
            }
            f
        }
        Ok((status, _)) => {
            log::info!(target: "Announcements", "sync: status {status}");
            None
        }
        Err(e) => {
            log::info!(target: "Announcements", "sync: offline ({e})");
            None
        }
    };
    let mut synced = false;
    if let Some(f) = &fetched {
        if let Some(dir) = dir {
            fetch_images(net, dir, &f.items, &rules);
        }
        let conn = lock(db);
        match replace_cache(&conn, &f.items) {
            Ok(()) => {
                synced = true;
                let mut st = load_state(&conn);
                st.last_sync = Some(now);
                st.next_check_s = Some(f.next_check_s);
                let _ = save_state(&conn, &st);
                if let Some(dir) = dir {
                    prune_images(dir, &f.items, &rules);
                }
            }
            Err(e) => log::warn!(target: "Announcements", "cache not replaced: {e}"),
        }
    }
    flush_pending(db, net, ident, base, now, flushing);
    let conn = lock(db);
    build_list(&conn, dir, &rules, now, synced)
}

/// A seen / click report: checked, remembered, queued. Ok(true) = queued (send it now),
/// Ok(false) = this one was reported before. "seen" also marks it read.
fn record_event(conn: &Connection, rules: &Rules, id: &str, kind: &str, lang: &str, now: i64) -> Result<bool, String> {
    if !valid_id(id) {
        return Err("bad_id".into());
    }
    if !matches!(kind, "seen" | "click") {
        return Err("bad_kind".into());
    }
    let ann = cached_one(conn, id, rules).ok_or("unknown")?;
    if kind == "click" && ann.button.is_none() {
        return Err("no_button".into());
    }
    if kind == "seen" {
        mark_read(conn, &[id.to_string()], now);
    }
    let mut st = load_state(conn);
    let list = if kind == "seen" { &mut st.seen } else { &mut st.clicked };
    if list.iter().any(|x| x == id) {
        return Ok(false);
    }
    list.push(id.to_string());
    trim_front(list, MAX_REMEMBERED);
    st.pending.push(Pending { id: id.to_string(), kind: kind.to_string(), lang: lang.to_string(), at: now });
    trim_front(&mut st.pending, MAX_PENDING);
    save_state(conn, &st).map_err(|e| e.to_string())?;
    Ok(true)
}

fn image_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(IMAGE_DIR))
}

static SYNCING: AtomicBool = AtomicBool::new(false);
static FLUSHING: AtomicBool = AtomicBool::new(false);

// ── commands ─────────────────────────────────────────────────────────────────

/// The cached list with the local read / seen / popped marks. Instant, works offline.
#[tauri::command]
pub fn announcements_list(app: AppHandle, state: State<AppState>) -> AnnouncementList {
    let dir = image_dir(&app);
    build_list(&lock(&state.db), dir.as_deref(), &Rules::for_base(&api_base()), now_ms(), false)
}

/// Ask api.bloot.app for the current list (lang: "en" | "uz"), replace the cache, send waiting
/// reports, return the list. Never an error for being offline: the cached list comes back.
#[tauri::command]
pub async fn announcements_sync(app: AppHandle, lang: String) -> Result<AnnouncementList, String> {
    let lang = if lang == "uz" { "uz" } else { "en" };
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir = image_dir(&app);
        let base = api_base();
        if SYNCING.swap(true, Ordering::SeqCst) {
            // one at a time: a second caller gets the cache
            return build_list(&lock(&state.db), dir.as_deref(), &Rules::for_base(&base), now_ms(), false);
        }
        let _done = Release(&SYNCING);
        sync_core(&state.db, dir.as_deref(), &Http::new(&base), &Identity::read(), &base, lang, now_ms(), &FLUSHING)
    })
    .await
    .map_err(|e| e.to_string())
}

/// A card was seen (kind "seen", also marks it read) or its button pressed ("click").
/// Reported once per announcement; sent in the background, queued when offline.
#[tauri::command]
pub fn announcements_event(app: AppHandle, state: State<AppState>, id: String, kind: String) -> Result<(), String> {
    let queued = {
        let conn = lock(&state.db);
        let lang = app_lang(&conn);
        record_event(&conn, &Rules::for_base(&api_base()), &id, &kind, lang, now_ms())?
    };
    if queued {
        std::thread::spawn(move || {
            let state = app.state::<AppState>();
            let base = api_base();
            flush_pending(&state.db, &Http::new(&base), &Identity::read(), &base, now_ms(), &FLUSHING);
        });
    }
    Ok(())
}

/// "Mark all as read" (no report). → how many were marked.
#[tauri::command]
pub fn announcements_mark_read(state: State<AppState>, ids: Vec<String>) -> usize {
    mark_read(&lock(&state.db), &ids, now_ms())
}

/// The pop-up for this announcement was shown; it doesn't pop up again.
#[tauri::command]
pub fn announcements_mark_popped(state: State<AppState>, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("bad_id".into());
    }
    let conn = lock(&state.db);
    let mut st = load_state(&conn);
    if !st.popped.contains(&id) {
        st.popped.push(id);
        trim_front(&mut st.popped, MAX_REMEMBERED);
        save_state(&conn, &st).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    const ID_A: &str = "ann_0123456789abcdef";
    const ID_B: &str = "ann_bbbbbbbbbbbbbbbb";
    const ID_C: &str = "ann_cccccccccccccccc";
    const TICKET: &str = "v1.eyJTRUNSRVQtVElDS0VULVBBWUxPQUQiOjF9.c2lnbmF0dXJlLWJ5dGVz";
    const DEVICE: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    fn rules() -> Rules {
        Rules::for_base(API_BASE)
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        conn
    }

    fn sample(id: &str) -> Value {
        json!({
            "id": id, "kind": "news",
            "title": { "en": "New in qooti", "uz": "qooti’da yangi" },
            "body": { "en": "Line one\r\nLine two", "uz": null },
            "button": { "label": { "en": "Open", "uz": "Ochish" }, "action": "link", "target": "https://bloot.app/qooti?x=1#top" },
            "image": { "url": format!("{API_BASE}/download/ann-{id}-0a1b2c3d4e5f.webp"), "w": 1200, "h": 600 },
            "popup": true, "pinned": false, "published_at": 1_795_000_000_000i64, "ends_at": null, "test": false
        })
    }

    fn png() -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&[0u8; 64]);
        b
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qooti-ann-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// A stand-in server: answers the list call with `list`, the report calls with `events`
    /// (in order; empty = 204), images from `images`; remembers every request.
    #[derive(Default)]
    struct FakeNet {
        list: RefCell<Option<Result<(u16, Vec<u8>), String>>>,
        events: RefCell<VecDeque<Result<u16, String>>>,
        images: HashMap<String, (u16, String, Vec<u8>)>,
        posts: RefCell<Vec<(String, String)>>,
        gets: RefCell<Vec<String>>,
    }

    impl Net for FakeNet {
        fn post_json(&self, url: &str, body: &str) -> Result<(u16, Vec<u8>), String> {
            self.posts.borrow_mut().push((url.to_string(), body.to_string()));
            if url.ends_with("/v1/announcements") {
                return self.list.borrow().clone().unwrap_or(Err("offline".into()));
            }
            self.events.borrow_mut().pop_front().unwrap_or(Ok(204)).map(|s| (s, Vec::new()))
        }
        fn get(&self, url: &str, _max: u64) -> Result<(u16, String, Vec<u8>), String> {
            self.gets.borrow_mut().push(url.to_string());
            self.images.get(url).cloned().ok_or_else(|| "offline".into())
        }
    }

    fn answer(items: Vec<Value>) -> Option<Result<(u16, Vec<u8>), String>> {
        Some(Ok((200, json!({ "announcements": items, "next_check_s": 1800 }).to_string().into_bytes())))
    }

    fn ident() -> Identity {
        Identity { ticket: Some(TICKET.into()), device_id: Some(DEVICE.into()) }
    }

    #[test]
    fn parses_a_full_announcement() {
        let a = parse_announcement(&sample(ID_A), &rules()).expect("valid");
        assert_eq!(a.id, ID_A);
        assert_eq!(a.kind, "news");
        assert_eq!(a.title, Text { en: "New in qooti".into(), uz: Some("qooti’da yangi".into()) });
        assert_eq!(a.body.en, "Line one\nLine two", "line breaks kept, as LF");
        assert_eq!(a.body.uz, None);
        let b = a.button.clone().expect("button");
        assert_eq!((b.action.as_str(), b.target.as_str()), ("link", "https://bloot.app/qooti?x=1#top"));
        assert_eq!(b.label.uz.as_deref(), Some("Ochish"));
        assert_eq!(a.image.as_ref().map(|i| (i.w, i.h)), Some((1200, 600)));
        assert!(a.popup && !a.pinned && !a.test);
        // The cache keeps the same shape: it reads back the same.
        let again = parse_announcement(&serde_json::to_value(&a).unwrap(), &rules()).unwrap();
        assert_eq!(again, parse_announcement(&sample(ID_A), &rules()).unwrap());
    }

    #[test]
    fn refuses_what_is_off() {
        let r = rules();
        let with = |f: &dyn Fn(&mut Value)| {
            let mut v = sample(ID_A);
            f(&mut v);
            parse_announcement(&v, &r)
        };
        // the whole item goes
        for bad_id in ["ann_0123", "ANN_0123456789abcdef", "ann_0123456789ABCDEF", "ann_0123456789abcde/", "x", ""] {
            assert!(with(&|v| v["id"] = json!(bad_id)).is_none(), "{bad_id}");
        }
        assert!(with(&|v| v["id"] = json!(5)).is_none());
        assert!(with(&|v| v["kind"] = json!(3)).is_none());
        assert!(with(&|v| v["kind"] = json!("<script>")).is_none());
        assert!(with(&|v| v["title"]["en"] = json!("x".repeat(81))).is_none(), "title > 80");
        assert!(with(&|v| v["title"]["en"] = json!("   ")).is_none(), "empty title");
        assert!(with(&|v| v["title"] = json!("plain")).is_none());
        assert!(with(&|v| v["title"]["uz"] = json!("y".repeat(81))).is_none(), "uz title > 80");
        assert!(with(&|v| v["body"]["en"] = json!("x".repeat(601))).is_none(), "body > 600");
        assert!(with(&|v| v["published_at"] = json!(null)).is_none());
        assert!(with(&|v| v["published_at"] = json!(-5)).is_none());
        assert!(with(&|v| v["ends_at"] = json!("soon")).is_none());
        // within the limits
        assert!(with(&|v| v["title"]["en"] = json!("é".repeat(80))).is_some(), "80 characters, not bytes");
        assert!(with(&|v| v["body"]["en"] = json!("x".repeat(600))).is_some());
        // a newer kind shows as news
        assert_eq!(with(&|v| v["kind"] = json!("survey")).unwrap().kind, "news");
        for k in KINDS {
            assert_eq!(with(&|v| v["kind"] = json!(k)).unwrap().kind, k);
        }
        // text is cleaned: no controls, no direction tricks, titles on one line
        let a = with(&|v| {
            v["title"]["en"] = json!("Hi\u{0007} there\nyou\u{202E}");
            v["body"]["en"] = json!("\n\n a\u{0000}\r\n\r\nb \n");
            v["title"]["uz"] = json!("");
        })
        .unwrap();
        assert_eq!(a.title.en, "Hi there you");
        assert_eq!(a.body.en, "a\n\nb");
        assert_eq!(a.title.uz, None, "empty Uzbek = English");

        // only the button goes
        let button = |b: Value| with(&|v| v["button"] = b.clone()).unwrap().button;
        let link = |t: &str| json!({ "label": { "en": "Go" }, "action": "link", "target": t });
        for bad in [
            "http://bloot.app", "javascript:alert(1)", "https://", "https://bloot", "https://.bloot.app", "https://bloot.app./",
            "https://user@bloot.app/", "https://bloot.app/a b", "https://bloot.app/\"x", "https://bloot.app/<x>", "https://bloot.app:x/",
            "https://bloöt.app/", "HTTPS://bloot.app",
        ] {
            assert!(button(link(bad)).is_none(), "{bad}");
        }
        assert!(button(link(&format!("https://bloot.app/{}", "a".repeat(490)))).is_none(), "> 500");
        assert!(button(link("https://bloot.app:8443/x?a=1&b=%20#c")).is_some());
        assert!(button(json!({ "label": { "en": "x".repeat(25) }, "action": "link", "target": "https://bloot.app" })).is_none(), "label > 24");
        assert!(button(json!({ "label": { "uz": "Ochish" }, "action": "link", "target": "https://bloot.app" })).is_none(), "label needs English");
        assert!(button(json!({ "label": { "en": "Go" }, "action": "run", "target": "https://bloot.app" })).is_none());
        let screen = |t: &str| json!({ "label": { "en": "Go" }, "action": "screen", "target": t });
        assert!(button(screen("settings:library")).is_some());
        assert!(button(screen("some-future_screen:2")).is_some(), "unknown keys pass; the page closes the panel for them");
        for bad in ["", "Settings", "settings library", "1home", "home/../x", &"a".repeat(41)] {
            assert!(button(screen(bad)).is_none(), "{bad}");
        }
        assert!(button(json!(null)).is_none());
        assert!(button(json!("https://bloot.app")).is_none());

        // only the image goes
        let image = |url: &str, w: Value| with(&|v| v["image"] = json!({ "url": url, "w": w.clone(), "h": 600 })).unwrap().image;
        let ok = format!("{API_BASE}/download/ann-x-0a1b2c3d4e5f.png");
        assert!(image(&ok, json!(1200)).is_some());
        assert!(image(&format!("{API_BASE}/download/ann-x-0a1b.jpeg"), json!(1200)).is_some());
        for bad in [
            "http://api.bloot.app/download/ann-x.png", "https://evil.app/download/ann-x.png", "https://api.bloot.app/download/x.png",
            "https://api.bloot.app/other/ann-x.png", "https://api.bloot.app/download/ann-../../x.png", "https://api.bloot.app/download/ann-x.svg",
            "https://api.bloot.app/download/ann-x.png?y=1", "https://api.bloot.app/download/ann-.png", "https://api.bloot.app.evil.com/download/ann-x.png",
            "https://api.bloot.app/download/ann-x/y.png",
        ] {
            assert!(image(bad, json!(1200)).is_none(), "{bad}");
        }
        assert!(image(&ok, json!(0)).is_none());
        assert!(image(&ok, json!(10_001)).is_none());
        assert!(image(&ok, json!("1200")).is_none());
    }

    #[test]
    fn response_is_capped_deduped_sorted_and_clamped() {
        let r = rules();
        let mut items: Vec<Value> = (0..30)
            .map(|i| {
                let mut v = sample(&format!("ann_{i:016}"));
                v["published_at"] = json!(1000 + i);
                v
            })
            .collect();
        items.insert(0, json!({ "id": "junk" }));
        items[5]["pinned"] = json!(true);
        let dup = items[3].clone();
        items.insert(4, dup);
        let f = parse_response(json!({ "announcements": items, "next_check_s": 60 }).to_string().as_bytes(), &r).unwrap();
        assert_eq!(f.items.len(), 20, "at most 20");
        let ids: HashSet<_> = f.items.iter().map(|a| a.id.clone()).collect();
        assert_eq!(ids.len(), 20, "no id twice");
        assert!(f.items[0].pinned, "pinned first");
        assert!(f.items[1..].windows(2).all(|w| w[0].published_at >= w[1].published_at), "then newest first");
        assert_eq!(f.next_check_s, 900, "clamped up");
        let n = |v: Value| parse_response(json!({ "announcements": [], "next_check_s": v }).to_string().as_bytes(), &r).unwrap().next_check_s;
        assert_eq!(n(json!(99_999)), 21_600, "clamped down");
        assert_eq!(n(json!(null)), 1800);
        assert_eq!(n(json!(3600)), 3600);
        assert!(parse_response(b"<html>", &r).is_none());
        assert!(parse_response(b"{\"error\":\"x\"}", &r).is_none());
        assert!(parse_response(b"{\"announcements\":{}}", &r).is_none());
    }

    #[test]
    fn cache_replace_keeps_read_marks_and_drops_the_rest() {
        let conn = db();
        let r = rules();
        // an old local notification from earlier versions: not shown, removed by a sync
        conn.execute("INSERT INTO notifications (id, type, title, body, data, created_at) VALUES ('old-1', 'info', 'Old', 'x', NULL, 1)", []).unwrap();
        let a = parse_announcement(&sample(ID_A), &r).unwrap();
        let b = parse_announcement(&sample(ID_B), &r).unwrap();
        replace_cache(&conn, &[a.clone(), b.clone()]).unwrap();
        assert_eq!(build_list(&conn, None, &r, 0, false).items.len(), 2, "the old row isn't listed");
        assert_eq!(mark_read(&conn, &[ID_A.into(), ID_B.into(), "ann_zzzzzzzzzzzzzzzz".into(), "junk".into()], 5), 2);
        let mut a2 = a.clone();
        a2.title.en = "Changed".into();
        let c = parse_announcement(&sample(ID_C), &r).unwrap();
        replace_cache(&conn, &[a2, c]).unwrap();
        let list = build_list(&conn, None, &r, 0, false);
        let got: Vec<(&str, bool, &str)> = list.items.iter().map(|i| (i.id.as_str(), i.read, i.title.en.as_str())).collect();
        assert!(got.contains(&(ID_A, true, "Changed")), "updated in place, still read: {got:?}");
        assert!(got.contains(&(ID_C, false, "New in qooti")));
        assert!(!got.iter().any(|g| g.0 == ID_B), "gone from the server = gone here");
        assert_eq!(list.unread, 1);
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM notifications", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 2, "the old local row was removed too");
        let reads: i64 = conn.query_row("SELECT COUNT(*) FROM notification_reads", [], |r| r.get(0)).unwrap();
        assert_eq!(reads, 1, "B's read mark went with it");
        let typ: String = conn.query_row("SELECT type FROM notifications WHERE id = ?1", [ID_A], |r| r.get(0)).unwrap();
        assert_eq!(typ, "news");
    }

    #[test]
    fn ended_ones_are_hidden_between_syncs() {
        let conn = db();
        let r = rules();
        let mut v = sample(ID_A);
        v["ends_at"] = json!(1000);
        replace_cache(&conn, &[parse_announcement(&v, &r).unwrap(), parse_announcement(&sample(ID_B), &r).unwrap()]).unwrap();
        assert_eq!(build_list(&conn, None, &r, 999, false).items.len(), 2);
        let later = build_list(&conn, None, &r, 1000, false);
        assert_eq!(later.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec![ID_B]);
    }

    #[test]
    fn reports_are_queued_once_capped_and_sent() {
        let conn = db();
        let r = rules();
        let mut no_button = sample(ID_B);
        no_button["button"] = json!(null);
        replace_cache(&conn, &[parse_announcement(&sample(ID_A), &r).unwrap(), parse_announcement(&no_button, &r).unwrap()]).unwrap();

        assert_eq!(record_event(&conn, &r, ID_A, "seen", "uz", 10), Ok(true));
        assert_eq!(record_event(&conn, &r, ID_A, "seen", "uz", 11), Ok(false), "seen is reported once");
        assert_eq!(record_event(&conn, &r, ID_A, "click", "en", 12), Ok(true));
        assert_eq!(record_event(&conn, &r, ID_A, "click", "en", 13), Ok(false));
        assert_eq!(record_event(&conn, &r, ID_B, "click", "en", 14), Err("no_button".into()));
        assert_eq!(record_event(&conn, &r, ID_C, "seen", "en", 15), Err("unknown".into()), "not in the list");
        assert!(record_event(&conn, &r, "junk", "seen", "en", 15).is_err());
        assert!(record_event(&conn, &r, ID_A, "like", "en", 15).is_err());
        let list = build_list(&conn, None, &r, 20, false);
        let a = list.items.iter().find(|i| i.id == ID_A).unwrap();
        assert!(a.read && a.seen, "seen marks it read");
        assert!(!list.items.iter().find(|i| i.id == ID_B).unwrap().read);
        let st = load_state(&conn);
        assert_eq!(st.pending.iter().map(|p| (p.kind.as_str(), p.lang.as_str())).collect::<Vec<_>>(), vec![("seen", "uz"), ("click", "en")]);

        // the queue keeps the newest 200
        let mut st = load_state(&conn);
        st.pending = (0..250).map(|i| Pending { id: ID_A.into(), kind: "seen".into(), lang: "en".into(), at: i }).collect();
        save_state(&conn, &st).unwrap();
        let st = load_state(&conn);
        assert_eq!(st.pending.len(), 200);
        assert_eq!(st.pending[0].at, 50, "oldest dropped");
        // a full queue still takes a new report, dropping the oldest
        let mut st = st;
        st.seen.clear();
        save_state(&conn, &st).unwrap();
        assert_eq!(record_event(&conn, &r, ID_A, "seen", "en", 300), Ok(true));
        let st = load_state(&conn);
        assert_eq!(st.pending.len(), 200);
        assert_eq!(st.pending.last().unwrap().at, 300);
    }

    #[test]
    fn failed_reports_wait_for_the_next_sync() {
        let db = Mutex::new(db());
        let r = rules();
        {
            let conn = lock(&db);
            replace_cache(&conn, &[parse_announcement(&sample(ID_A), &r).unwrap(), parse_announcement(&sample(ID_B), &r).unwrap()]).unwrap();
            record_event(&conn, &r, ID_A, "seen", "en", 1_000).unwrap();
            record_event(&conn, &r, ID_B, "seen", "en", 1_001).unwrap();
            record_event(&conn, &r, ID_A, "click", "en", 1_002).unwrap();
        }
        let busy = AtomicBool::new(false);
        let pending = |db: &Mutex<Connection>| load_state(&lock(db)).pending.iter().map(|p| (p.id.clone(), p.kind.clone())).collect::<Vec<_>>();

        // offline: nothing sent, all kept
        let net = FakeNet::default();
        net.events.borrow_mut().push_back(Err("offline".into()));
        assert_eq!(flush_pending(&db, &net, &ident(), API_BASE, 2_000, &busy), 0);
        assert_eq!(pending(&db).len(), 3);
        // first sent, then the server has trouble: the rest stays
        let net = FakeNet::default();
        net.events.borrow_mut().extend([Ok(204), Ok(503)]);
        assert_eq!(flush_pending(&db, &net, &ident(), API_BASE, 2_000, &busy), 1);
        assert_eq!(pending(&db), vec![(ID_B.to_string(), "seen".to_string()), (ID_A.to_string(), "click".to_string())]);
        // a refusal (404: the announcement is gone) is dropped, not retried
        let net = FakeNet::default();
        net.events.borrow_mut().extend([Ok(404), Ok(204)]);
        assert_eq!(flush_pending(&db, &net, &ident(), API_BASE, 2_000, &busy), 2);
        assert!(pending(&db).is_empty());
        let posts = net.posts.borrow();
        let sent: Value = serde_json::from_str(&posts[1].1).unwrap();
        assert_eq!(posts[1].0, format!("{API_BASE}/v1/announcements/event"));
        assert_eq!((sent["id"].as_str(), sent["kind"].as_str(), sent["product"].as_str()), (Some(ID_A), Some("click"), Some("qooti")));
        assert_eq!(sent["ticket"].as_str(), Some(TICKET));
        assert_eq!(sent["device_id"].as_str(), Some(DEVICE));
        assert_eq!(sent["app_version"].as_str(), Some(env!("CARGO_PKG_VERSION")));
        assert!(matches!(sent["platform"].as_str(), Some("windows" | "mac")));
        drop(posts);
        // too old to count: dropped without sending
        {
            let conn = lock(&db);
            let mut st = load_state(&conn);
            st.pending.push(Pending { id: ID_A.into(), kind: "seen".into(), lang: "en".into(), at: 0 });
            save_state(&conn, &st).unwrap();
        }
        let net = FakeNet::default();
        assert_eq!(flush_pending(&db, &net, &ident(), API_BASE, PENDING_MAX_AGE_MS + 1, &busy), 0);
        assert!(net.posts.borrow().is_empty());
        assert!(pending(&db).is_empty());
        // a sync sends what's waiting (here: while offline for the list itself)
        {
            let conn = lock(&db);
            let mut st = load_state(&conn);
            st.pending.push(Pending { id: ID_B.into(), kind: "click".into(), lang: "uz".into(), at: 5_000 });
            save_state(&conn, &st).unwrap();
        }
        let net = FakeNet::default();
        let list = sync_core(&db, None, &net, &ident(), API_BASE, "en", 6_000, &busy);
        assert!(!list.synced);
        assert_eq!(list.items.len(), 2, "offline: the cache stays");
        assert!(pending(&db).is_empty(), "the waiting report went out with the sync");
        // another flush running: this one does nothing
        let held = AtomicBool::new(true);
        {
            let conn = lock(&db);
            let mut st = load_state(&conn);
            st.pending.push(Pending { id: ID_B.into(), kind: "click".into(), lang: "uz".into(), at: 5_000 });
            save_state(&conn, &st).unwrap();
        }
        assert_eq!(flush_pending(&db, &FakeNet::default(), &ident(), API_BASE, 6_000, &held), 0);
        assert_eq!(pending(&db).len(), 1);
    }

    #[test]
    fn sync_replaces_cache_downloads_images_and_never_returns_the_ticket() {
        let dir = temp_dir("sync");
        let db = Mutex::new(db());
        let busy = AtomicBool::new(false);
        let mut net = FakeNet::default();
        let img_a = format!("{API_BASE}/download/ann-{ID_A}-0a1b2c3d4e5f.webp");
        let img_b = format!("{API_BASE}/download/ann-{ID_B}-0a1b2c3d4e5f.webp");
        let img_c = format!("{API_BASE}/download/ann-{ID_C}-0a1b2c3d4e5f.webp");
        let mut webp = b"RIFF\x10\x00\x00\x00WEBPVP8 ".to_vec();
        webp.extend_from_slice(&[1u8; 32]);
        net.images.insert(img_a.clone(), (200, "image/webp".into(), webp.clone()));
        net.images.insert(img_b.clone(), (200, "text/html".into(), webp.clone())); // wrong type
        net.images.insert(img_c.clone(), (200, "image/webp".into(), png())); // bytes don't match
        *net.list.borrow_mut() = answer(vec![sample(ID_A), sample(ID_B), sample(ID_C)]);
        let list = sync_core(&db, Some(dir.as_path()), &net, &ident(), API_BASE, "uz", 50, &busy);
        assert!(list.synced);
        assert_eq!(list.items.len(), 3);
        assert_eq!(list.last_sync, Some(50));
        let shown: HashMap<&str, bool> = list.items.iter().map(|i| (i.id.as_str(), i.image.is_some())).collect();
        assert_eq!(shown[ID_A], true);
        assert_eq!(shown[ID_B], false, "wrong content type: no image");
        assert_eq!(shown[ID_C], false, "bytes not the declared type: no image");
        let a = list.items.iter().find(|i| i.id == ID_A).unwrap();
        let src = &a.image.as_ref().unwrap().src;
        assert!(src.starts_with("data:image/webp;base64,"), "{}", &src[..30]);
        assert!(dir.join(format!("ann-{ID_A}-0a1b2c3d4e5f.webp")).is_file());

        // the request: ticket + device id + language, to the list endpoint only
        let posts = net.posts.borrow().clone();
        let req: Value = serde_json::from_str(&posts[0].1).unwrap();
        assert_eq!(posts[0].0, format!("{API_BASE}/v1/announcements"));
        assert_eq!(req["ticket"].as_str(), Some(TICKET), "the ticket goes to the server");
        assert_eq!(req["lang"].as_str(), Some("uz"));
        assert!(net.gets.borrow().iter().all(|u| !u.contains("SECRET") && !u.contains(TICKET)), "image requests carry nothing");

        // …and never to the page: not in what sync / list return, not in the cache, not in the state
        let secret = &TICKET[3..20];
        for out in [
            serde_json::to_string(&list).unwrap(),
            serde_json::to_string(&build_list(&lock(&db), Some(dir.as_path()), &rules(), 60, false)).unwrap(),
        ] {
            assert!(!out.contains(secret) && !out.contains(TICKET), "the ticket must not reach the page");
        }
        let cache: Vec<String> = {
            let conn = lock(&db);
            let mut st = conn.prepare("SELECT COALESCE(data, '') FROM notifications").unwrap();
            let rows: Vec<String> = st.query_map([], |r| r.get(0)).unwrap().filter_map(Result::ok).collect();
            rows
        };
        assert!(cache.iter().all(|d| !d.contains(TICKET)));
        let state: String = lock(&db).query_row("SELECT value FROM preferences WHERE key = ?1", [STATE_KEY], |r| r.get(0)).unwrap();
        assert!(!state.contains(TICKET));
        assert!(!format!("{:?}", ident()).contains(secret), "Debug hides it too");

        // the next sync: A stays (no second download), B and C are gone, their files too
        std::fs::write(dir.join("stray.part"), b"x").unwrap();
        net.gets.borrow_mut().clear();
        *net.list.borrow_mut() = answer(vec![sample(ID_A)]);
        let list = sync_core(&db, Some(dir.as_path()), &net, &ident(), API_BASE, "en", 70, &busy);
        assert_eq!(list.items.len(), 1);
        assert!(list.items[0].image.is_some());
        assert!(net.gets.borrow().is_empty(), "already on disk");
        assert!(!dir.join("stray.part").exists(), "unreferenced files are removed");

        // a bad answer keeps the cache
        *net.list.borrow_mut() = Some(Ok((500, b"oops".to_vec())));
        let list = sync_core(&db, Some(dir.as_path()), &net, &ident(), API_BASE, "en", 80, &busy);
        assert!(!list.synced);
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.last_sync, Some(70));
        *net.list.borrow_mut() = Some(Ok((200, b"not json".to_vec())));
        assert_eq!(sync_core(&db, Some(dir.as_path()), &net, &ident(), API_BASE, "en", 90, &busy).items.len(), 1);
        // an empty list from the server empties the bell
        *net.list.borrow_mut() = answer(vec![]);
        let list = sync_core(&db, Some(dir.as_path()), &net, &ident(), API_BASE, "en", 100, &busy);
        assert!(list.synced && list.items.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn image_downloads_are_checked() {
        let mut net = FakeNet::default();
        let u = "https://api.bloot.app/download/ann-x-1.png";
        let check = |net: &FakeNet| download_image(net, u);
        net.images.insert(u.into(), (200, "image/png; charset=binary".into(), png()));
        assert!(check(&net).is_ok());
        net.images.insert(u.into(), (200, "image/png".into(), b"<svg onload=alert(1)>".to_vec()));
        assert!(check(&net).is_err(), "not an image");
        net.images.insert(u.into(), (200, "image/svg+xml".into(), png()));
        assert!(check(&net).is_err(), "svg type");
        let mut big = png();
        big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        net.images.insert(u.into(), (200, "image/png".into(), big));
        assert!(check(&net).is_err(), "over 1 MB");
        net.images.insert(u.into(), (404, "image/png".into(), png()));
        assert!(check(&net).is_err());
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpeg.extend_from_slice(&[0u8; 16]);
        net.images.insert(u.into(), (200, "image/jpeg".into(), jpeg));
        assert!(check(&net).is_ok());
    }

    #[test]
    fn popped_and_state_survive_bad_preference_text() {
        let conn = db();
        conn.execute("INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, 'not json')", [STATE_KEY]).unwrap();
        let st = load_state(&conn);
        assert!(st.popped.is_empty() && st.pending.is_empty() && st.last_sync.is_none());
        conn.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)",
            params![STATE_KEY, json!({ "popped": [ID_A, "../x", 5], "pending": [{ "id": ID_A, "kind": "drop", "lang": "en", "at": 1 }], "next_check_s": 1 }).to_string()],
        )
        .unwrap();
        // one bad entry spoils serde's Vec<String>: the state starts fresh rather than half-read
        let st = load_state(&conn);
        assert!(st.popped.is_empty());
        conn.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)",
            params![STATE_KEY, json!({ "popped": [ID_A, "../x"], "pending": [{ "id": ID_A, "kind": "drop", "lang": "en", "at": 1 }], "next_check_s": 1 }).to_string()],
        )
        .unwrap();
        let st = load_state(&conn);
        assert_eq!(st.popped, vec![ID_A.to_string()]);
        assert!(st.pending.is_empty());
        assert_eq!(st.next_check_s, Some(CHECK_MIN_S));
    }

    #[test]
    fn api_address_override_is_debug_only() {
        let local = Some("http://127.0.0.1:8787/".to_string());
        assert_eq!(base_from(false, local.clone()), API_BASE, "a release build ignores QOOTI_API_BASE");
        assert_eq!(base_from(false, Some("https://staging.bloot.app".into())), API_BASE);
        assert_eq!(base_from(true, local), "http://127.0.0.1:8787");
        assert_eq!(base_from(true, Some("http://localhost:8787".into())), "http://localhost:8787");
        assert_eq!(base_from(true, Some("https://staging.bloot.app/".into())), "https://staging.bloot.app");
        for bad in ["http://evil.com", "http://localhost.evil.com", "file:///c:/x", "javascript:x", "https://", "", "https://a b"] {
            assert_eq!(base_from(true, Some(bad.into())), API_BASE, "{bad}");
        }
        assert_eq!(base_from(true, None), API_BASE);
        if !cfg!(debug_assertions) {
            assert_eq!(api_base(), API_BASE);
        }
        // only the real API's images, unless a debug build points elsewhere
        assert_eq!(Rules::for_base(API_BASE).image_prefixes, vec![format!("{API_BASE}/download/ann-")]);
        let local = Rules::for_base("http://127.0.0.1:8787");
        assert!(image_name("http://127.0.0.1:8787/download/ann-x-1.png", &local).is_some());
        assert!(image_name("http://127.0.0.1:8787/download/ann-x-1.png", &rules()).is_none());
    }

    #[test]
    fn device_ids_must_look_like_uuids() {
        assert!(looks_like_uuid(DEVICE));
        assert!(!looks_like_uuid("0f8fad5b-d9cb-469f-a165-70867728950"));
        assert!(!looks_like_uuid("0f8fad5bxd9cb-469f-a165-70867728950e"));
        assert!(!looks_like_uuid("../../../../../../../../../etc/passwd"));
    }
}
