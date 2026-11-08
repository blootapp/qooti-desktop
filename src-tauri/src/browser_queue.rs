// Links the browser extension kept while qooti was closed ("Links from your browser").
//
// The extension can't save while qooti isn't running, so it keeps each link and hands
// it over once qooti runs again (POST /extension/queue). qooti keeps them here until the
// user picks what to download from each one in the dialog — or clears them. Starting a
// link sends it down the same road as a save from the extension: the duplicate check,
// the Free daily limit (over it, the link waits for midnight), then the normal download.

use crate::AppState;
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

/// A runaway extension can't fill the disk.
const MAX_ITEMS: i64 = 1000;
/// Bigger pictures get no preview (the row shows a plain tile).
const MAX_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
const PREVIEW_EDGE: u32 = 160;
const MAX_FRAME_BYTES: usize = 24 * 1024 * 1024;

/// Created on every start rather than through a schema bump: it is a new table only,
/// and a bump re-runs the additive migrations (a full search-index rebuild) for nothing.
pub fn ensure_table(conn: &Connection) {
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS browser_queue (
            id              TEXT PRIMARY KEY,
            url             TEXT NOT NULL,
            page_url        TEXT NOT NULL DEFAULT '',
            title           TEXT NOT NULL DEFAULT '',
            kind            TEXT NOT NULL,
            source_platform TEXT NOT NULL DEFAULT '',
            thumbnail_url   TEXT,
            file_path       TEXT,
            choice          TEXT NOT NULL,
            saved_at        INTEGER NOT NULL,
            received_at     INTEGER NOT NULL,
            preview         BLOB,
            preview_tried   INTEGER NOT NULL DEFAULT 0
        );"
    );
}

/// One link, as the dialog shows it.
#[derive(Serialize, Clone, Debug)]
pub struct QueueItem {
    pub id: String,
    pub url: String,
    pub page_url: String,
    pub title: String,
    /// video | image | frame
    pub kind: String,
    /// The site it came from, without "www." — the dialog groups long lists by it.
    pub site: String,
    pub source_platform: String,
    /// What the browser picked; the dialog's menu starts there.
    pub choice: String,
    /// What this link can give, in menu order.
    pub formats: Vec<String>,
    pub saved_at: i64,
    /// A small JPEG as a data URL (the window may not load pictures from the web).
    pub preview: Option<String>,
}

/// What a link can be saved as. A video: the video, its thumbnail (when the page had
/// one) or just the link. A picture: the picture or the link. A frame taken in the
/// browser is already a picture.
pub fn formats_for(kind: &str, has_thumbnail: bool) -> Vec<&'static str> {
    match kind {
        "video" => {
            let mut f = vec!["video"];
            if has_thumbnail { f.push("thumbnail"); }
            f.push("link");
            f
        }
        "frame" => vec!["frame"],
        _ => vec!["image", "link"],
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An http(s) address that isn't on this computer or the local network.
fn web_url(v: Option<&serde_json::Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    if s.len() > 8192 || !(s.starts_with("https://") || s.starts_with("http://")) { return None }
    if crate::net_guard::is_private_literal(s) { return None }
    Some(s.to_string())
}

fn site_of(page_url: &str, url: &str) -> String {
    let pick = if page_url.is_empty() { url } else { page_url };
    let rest = pick.split_once("://").map(|(_, r)| r).unwrap_or(pick);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

/// Takes one link from the extension. Sending the same link twice is harmless (same id).
pub fn accept(app: &AppHandle, db: &Connection, v: &serde_json::Value) -> Result<String, &'static str> {
    let id = v.get("id").and_then(|x| x.as_str()).filter(|s| is_id(s)).ok_or("bad_id")?.to_string();
    let url = web_url(v.get("url")).ok_or("bad_url")?;
    let page_url = web_url(v.get("page_url")).unwrap_or_default();
    let title: String = v.get("title").and_then(|x| x.as_str()).unwrap_or("").chars().take(500).collect();
    let thumbnail_url = web_url(v.get("thumbnail_url"));
    let source_platform = v.get("source_platform").and_then(|x| x.as_str())
        .filter(|s| (1..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase()))
        .unwrap_or("").to_string();
    let data_url = v.get("data_url").and_then(|x| x.as_str());
    let kind = match (data_url, v.get("type").and_then(|x| x.as_str())) {
        (Some(_), _) => "frame",
        (None, Some("video")) => "video",
        _ => "image",
    };
    let formats = formats_for(kind, thumbnail_url.is_some());
    let choice = v.get("choice").and_then(|x| x.as_str())
        .and_then(|c| formats.iter().find(|f| **f == c).copied())
        .unwrap_or(formats[0]).to_string();
    let saved_at = v.get("saved_at").and_then(|x| x.as_i64()).filter(|t| *t > 0).unwrap_or_else(now_ms);

    let already: Option<i64> = db.query_row("SELECT 1 FROM browser_queue WHERE id = ?1", [&id], |r| r.get(0)).optional().unwrap_or(None);
    if already.is_some() { return Ok(id) }
    let count: i64 = db.query_row("SELECT COUNT(*) FROM browser_queue", [], |r| r.get(0)).unwrap_or(0);
    if count >= MAX_ITEMS { return Err("queue_full") }

    // A frame arrives as the picture itself: keep it until the user decides.
    let file_path = match data_url {
        Some(d) => Some(save_frame(app, &id, d)?),
        None => None,
    };

    db.execute(
        "INSERT OR IGNORE INTO browser_queue
           (id, url, page_url, title, kind, source_platform, thumbnail_url, file_path, choice, saved_at, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![id, url, page_url, title, kind, source_platform, thumbnail_url, file_path, choice, saved_at, now_ms()],
    ).map_err(|_| "store_failed")?;
    Ok(id)
}

fn queue_dir(app: &AppHandle) -> Result<std::path::PathBuf, &'static str> {
    let dir = app.path().app_data_dir().map_err(|_| "no_folder")?.join("browser-queue");
    std::fs::create_dir_all(&dir).map_err(|_| "no_folder")?;
    Ok(dir)
}

fn save_frame(app: &AppHandle, id: &str, data_url: &str) -> Result<String, &'static str> {
    let (head, b64) = data_url.split_once(',').ok_or("bad_frame")?;
    let ext = match head {
        "data:image/jpeg;base64" => "jpg",
        "data:image/png;base64" => "png",
        "data:image/webp;base64" => "webp",
        _ => return Err("bad_frame"),
    };
    if b64.len() > MAX_FRAME_BYTES { return Err("bad_frame") }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "bad_frame")?;
    let dest = queue_dir(app)?.join(format!("{id}.{ext}"));
    std::fs::write(&dest, &bytes).map_err(|_| "store_failed")?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Tells the window the list changed (it opens or refreshes the dialog).
pub fn changed(app: &AppHandle) {
    let count: i64 = {
        let state = app.state::<AppState>();
        let db = state.db.lock().unwrap();
        db.query_row("SELECT COUNT(*) FROM browser_queue", [], |r| r.get(0)).unwrap_or(0)
    };
    let _ = app.emit("browser-queue-changed", serde_json::json!({ "count": count }));
    spawn_preview_worker(app.clone());
}

pub fn list(db: &Connection) -> Vec<QueueItem> {
    let Ok(mut stmt) = db.prepare(
        "SELECT id, url, page_url, title, kind, source_platform, thumbnail_url, choice, saved_at, preview
         FROM browser_queue ORDER BY saved_at DESC, received_at DESC"
    ) else { return vec![] };
    stmt.query_map([], |r| {
        let kind: String = r.get(4)?;
        let thumb: Option<String> = r.get(6)?;
        let url: String = r.get(1)?;
        let page_url: String = r.get(2)?;
        let preview: Option<Vec<u8>> = r.get(9)?;
        Ok(QueueItem {
            id: r.get(0)?,
            site: site_of(&page_url, &url),
            formats: formats_for(&kind, thumb.is_some()).into_iter().map(String::from).collect(),
            url,
            page_url,
            title: r.get(3)?,
            kind,
            source_platform: r.get(5)?,
            choice: r.get(7)?,
            saved_at: r.get(8)?,
            preview: preview.filter(|p| !p.is_empty())
                .map(|p| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(p))),
        })
    }).map(|rows| rows.filter_map(|r| r.ok()).collect()).unwrap_or_default()
}

fn remove_rows(db: &Connection, ids: &[String]) {
    for id in ids {
        let file: Option<String> = db.query_row("SELECT file_path FROM browser_queue WHERE id = ?1", [id], |r| r.get(0))
            .optional().unwrap_or(None).flatten();
        let _ = db.execute("DELETE FROM browser_queue WHERE id = ?1", [id]);
        if let Some(f) = file { let _ = std::fs::remove_file(f); }
    }
}

/// What a link becomes when started with `choice` — the same shape as a save from the
/// extension, so the window's usual handling downloads or imports it.
pub fn payload_for(row: &Row, choice: &str) -> serde_json::Value {
    let base = |url: &str, kind: &str| serde_json::json!({
        "url": url, "page_url": row.page_url, "title": row.title,
        "type": kind, "source_platform": row.source_platform,
    });
    match choice {
        "video" => {
            let mut p = base(&row.url, "video");
            if let Some(t) = &row.thumbnail_url { p["thumbnail_url"] = t.clone().into() }
            p
        }
        "thumbnail" => base(row.thumbnail_url.as_deref().unwrap_or(&row.url), "image"),
        "link" => base(if row.page_url.is_empty() { &row.url } else { &row.page_url }, "link"),
        "frame" => serde_json::json!({
            "file_path": row.file_path, "page_url": row.page_url, "title": row.title,
            "type": "image", "source_platform": row.source_platform,
        }),
        _ => base(&row.url, "image"),
    }
}

#[derive(Debug, Clone)]
pub struct Row {
    pub id: String,
    pub url: String,
    pub page_url: String,
    pub title: String,
    pub kind: String,
    pub source_platform: String,
    pub thumbnail_url: Option<String>,
    pub file_path: Option<String>,
}

fn row(db: &Connection, id: &str) -> Option<Row> {
    db.query_row(
        "SELECT id, url, page_url, title, kind, source_platform, thumbnail_url, file_path FROM browser_queue WHERE id = ?1",
        [id],
        |r| Ok(Row {
            id: r.get(0)?, url: r.get(1)?, page_url: r.get(2)?, title: r.get(3)?, kind: r.get(4)?,
            source_platform: r.get(5)?, thumbnail_url: r.get(6)?, file_path: r.get(7)?,
        }),
    ).optional().unwrap_or(None)
}

// ── Previews ─────────────────────────────────────────────────────
// Fetched once per link in the background (through the public-internet-only client)
// and kept as a small JPEG, so the dialog can show them without loading the web.

static PREVIEWS_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn spawn_preview_worker(app: AppHandle) {
    if PREVIEWS_RUNNING.swap(true, Ordering::SeqCst) { return }
    std::thread::spawn(move || loop {
        let next: Option<(String, String, Option<String>, Option<String>, String)> = {
            let state = app.state::<AppState>();
            let db = state.db.lock().unwrap();
            db.query_row(
                "SELECT id, kind, thumbnail_url, file_path, url FROM browser_queue WHERE preview_tried = 0 ORDER BY saved_at DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            ).optional().unwrap_or(None)
        };
        let Some((id, kind, thumb, file, url)) = next else {
            PREVIEWS_RUNNING.store(false, Ordering::SeqCst);
            // A link that arrived just now could have missed this run
            let pending: bool = {
                let state = app.state::<AppState>();
                let db = state.db.lock().unwrap();
                db.query_row("SELECT 1 FROM browser_queue WHERE preview_tried = 0 LIMIT 1", [], |_| Ok(true)).optional().unwrap_or(None).is_some()
            };
            if pending && !PREVIEWS_RUNNING.swap(true, Ordering::SeqCst) { continue }
            return;
        };
        let bytes = match (kind.as_str(), file) {
            ("frame", Some(f)) => std::fs::read(f).ok(),
            ("video", _) => thumb.and_then(|t| fetch(&t)),
            _ => fetch(&url),
        };
        let preview = bytes.and_then(|b| shrink(&b));
        {
            let state = app.state::<AppState>();
            let db = state.db.lock().unwrap();
            let _ = db.execute("UPDATE browser_queue SET preview = ?1, preview_tried = 1 WHERE id = ?2", params![preview, id]);
        }
        if preview.is_some() { let _ = app.emit("browser-queue-changed", serde_json::json!({ "preview": id })); }
    });
}

fn fetch(url: &str) -> Option<Vec<u8>> {
    let res = crate::net_guard::agent().get(url).timeout(std::time::Duration::from_secs(8)).call().ok()?;
    let mut buf = Vec::new();
    res.into_reader().take(MAX_PREVIEW_BYTES + 1).read_to_end(&mut buf).ok()?;
    if buf.len() as u64 > MAX_PREVIEW_BYTES { return None }
    Some(buf)
}

/// A picture made small enough to keep in the list (≤ 160 px, JPEG).
pub fn shrink(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let small = img.thumbnail(PREVIEW_EDGE, PREVIEW_EDGE).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 78).encode_image(&small).ok()?;
    Some(out)
}

// ── Commands for the window ──────────────────────────────────────

#[tauri::command]
pub fn browser_queue_list(state: State<'_, AppState>) -> Result<Vec<QueueItem>, String> {
    let db = state.db.lock().unwrap();
    Ok(list(&db))
}

/// × on a row, or Clear all once its Undo has run out.
#[tauri::command]
pub fn browser_queue_remove(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    {
        let db = state.db.lock().unwrap();
        remove_rows(&db, &ids);
    }
    let _ = app.emit("browser-queue-changed", serde_json::json!({ "removed": ids.len() }));
    Ok(())
}

#[derive(Deserialize)]
pub struct Pick {
    pub id: String,
    pub choice: String,
}

#[derive(Serialize, Default, Debug)]
pub struct StartSummary {
    /// Sent to downloads now.
    pub started: u32,
    /// Already in the library — nothing to do.
    pub already: u32,
    /// Over today's Free limit: they download at midnight.
    pub later: u32,
}

/// Start downloading: every picked link goes down the extension's own save road.
#[tauri::command]
pub fn browser_queue_start(app: AppHandle, state: State<'_, AppState>, picks: Vec<Pick>) -> Result<StartSummary, String> {
    let mut summary = StartSummary::default();
    let mut payloads = Vec::new();
    {
        let db = state.db.lock().unwrap();
        let free = crate::extension_server::is_free_plan(&crate::extension_server::get_plan(&db));
        let mut done = Vec::new();
        for pick in &picks {
            let Some(row) = row(&db, &pick.id) else { continue };
            let formats = formats_for(&row.kind, row.thumbnail_url.is_some());
            let choice = formats.iter().find(|f| **f == pick.choice).copied().unwrap_or(formats[0]);
            let mut payload = payload_for(&row, choice);
            done.push(row.id.clone());

            // A frame is a new picture: never "already saved".
            if choice != "frame" {
                let check = payload.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if !check.is_empty() && crate::commands::find_by_link(&db, &check).is_some() {
                    summary.already += 1;
                    if let Some(f) = &row.file_path { let _ = std::fs::remove_file(f); }
                    continue;
                }
            }
            // The Free limit is about downloads: links and frames aren't downloads.
            let counts = matches!(choice, "video" | "image" | "thumbnail");
            if free && counts {
                if crate::extension_server::ext_dl_used_today(&db) >= crate::extension_server::FREE_EXT_DAILY_LIMIT {
                    let url = payload.get("url").and_then(|v| v.as_str()).unwrap_or(&row.url).to_string();
                    let _ = db.execute(
                        "INSERT OR IGNORE INTO ext_download_queue (id, url, page_url, title, source_platform, queued_at) VALUES (?1,?2,?3,?4,?5,?6)",
                        params![uuid::Uuid::new_v4().to_string(), url, row.page_url, row.title, row.source_platform, now_ms()],
                    );
                    summary.later += 1;
                    continue;
                }
                crate::extension_server::increment_ext_dl_count(&db);
            }
            let ext_id = uuid::Uuid::new_v4().to_string();
            if free && counts { crate::commands::mark_ext_quota_charged(&ext_id) }
            payload["_ext_id"] = ext_id.into();
            if choice == "frame" {
                // Into the library's own temporary folder, as frames from the page arrive
                if let Some(path) = row.file_path.as_deref().and_then(|f| move_to_vault(&app, f)) {
                    payload["file_path"] = path.into();
                }
            }
            payloads.push(payload);
            summary.started += 1;
        }
        // Rows go; frames that were started now live in the library's folder
        for id in &done { let _ = db.execute("DELETE FROM browser_queue WHERE id = ?1", [id]); }
    }
    // (The dialog says what happened — started, already saved, at midnight — in one toast.)
    let _ = app.emit("browser-queue-changed", serde_json::json!({ "started": summary.started }));
    log::info!(target: "BrowserQueue", "start started={} already={} later={}", summary.started, summary.already, summary.later);
    // One after another, like the midnight queue: the downloader takes them in turn
    let emitter = app.clone();
    std::thread::spawn(move || {
        for p in payloads {
            let _ = emitter.emit("extension-item-received", p);
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    });
    Ok(summary)
}

fn move_to_vault(app: &AppHandle, file: &str) -> Option<String> {
    let src = std::path::Path::new(file);
    let dir = crate::vault::get_vault_path(app).ok()?.join("downloads_tmp");
    std::fs::create_dir_all(&dir).ok()?;
    let dest = dir.join(format!("frame_{}.{}", uuid::Uuid::new_v4(), src.extension()?.to_str()?));
    if std::fs::rename(src, &dest).is_err() {
        std::fs::copy(src, &dest).ok()?;
        let _ = std::fs::remove_file(src);
    }
    Some(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        ensure_table(&c);
        c
    }

    fn sample_row(kind: &str, thumb: Option<&str>) -> Row {
        Row {
            id: "a1".into(), url: "https://www.youtube.com/watch?v=abc".into(),
            page_url: "https://www.youtube.com/watch?v=abc&t=10".into(), title: "A talk".into(),
            kind: kind.into(), source_platform: "youtube".into(),
            thumbnail_url: thumb.map(String::from), file_path: None,
        }
    }

    #[test]
    fn formats_follow_what_the_link_is() {
        assert_eq!(formats_for("video", true), ["video", "thumbnail", "link"]);
        assert_eq!(formats_for("video", false), ["video", "link"]);
        assert_eq!(formats_for("image", false), ["image", "link"]);
        assert_eq!(formats_for("frame", false), ["frame"]);
    }

    #[test]
    fn each_choice_becomes_an_extension_save() {
        let r = sample_row("video", Some("https://img.youtube.com/vi/abc/maxresdefault.jpg"));
        let v = payload_for(&r, "video");
        assert_eq!(v["type"], "video");
        assert_eq!(v["url"], "https://www.youtube.com/watch?v=abc");
        assert_eq!(v["thumbnail_url"], "https://img.youtube.com/vi/abc/maxresdefault.jpg");
        let t = payload_for(&r, "thumbnail");
        assert_eq!((t["type"].as_str(), t["url"].as_str()), (Some("image"), Some("https://img.youtube.com/vi/abc/maxresdefault.jpg")));
        let l = payload_for(&r, "link");
        assert_eq!((l["type"].as_str(), l["url"].as_str()), (Some("link"), Some("https://www.youtube.com/watch?v=abc&t=10")));
        let mut f = sample_row("frame", None);
        f.file_path = Some("C:/q/frame.jpg".into());
        let fp = payload_for(&f, "frame");
        assert_eq!(fp["file_path"], "C:/q/frame.jpg");
        assert!(fp.get("url").is_none());
    }

    #[test]
    fn site_is_the_page_host_without_www() {
        assert_eq!(site_of("https://www.youtube.com/watch?v=1", ""), "youtube.com");
        assert_eq!(site_of("", "https://i.pinimg.com/a.jpg"), "i.pinimg.com");
        assert_eq!(site_of("https://user@Web.Telegram.org:443/k/", ""), "web.telegram.org");
    }

    #[test]
    fn list_is_newest_first_with_formats() {
        let db = mem();
        for (id, at, kind, thumb) in [("old", 1_i64, "image", None), ("new", 2, "video", Some("https://img.youtube.com/vi/x/0.jpg"))] {
            db.execute(
                "INSERT INTO browser_queue (id, url, page_url, title, kind, source_platform, thumbnail_url, choice, saved_at, received_at)
                 VALUES (?1, 'https://example.com/a', 'https://www.example.com/p', 't', ?2, '', ?3, 'image', ?4, 0)",
                params![id, kind, thumb, at],
            ).unwrap();
        }
        let items = list(&db);
        assert_eq!(items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["new", "old"]);
        assert_eq!(items[0].formats, ["video", "thumbnail", "link"]);
        assert_eq!(items[1].site, "example.com");
    }

    #[test]
    fn previews_are_small_jpegs() {
        let big = image::RgbImage::from_pixel(1280, 720, image::Rgb([200, 40, 40]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(big).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let small = shrink(&png).expect("shrinks");
        let back = image::load_from_memory(&small).unwrap();
        assert!(back.width() <= PREVIEW_EDGE && back.height() <= PREVIEW_EDGE);
        assert_eq!(&small[..2], &[0xFF, 0xD8]);
        assert!(shrink(b"not a picture").is_none());
    }

    #[test]
    fn ids_and_addresses_are_checked() {
        assert!(is_id("q_1699-abc") && !is_id("") && !is_id("a b") && !is_id(&"x".repeat(65)));
        let j = |s: &str| serde_json::Value::String(s.into());
        assert!(web_url(Some(&j("https://pin.it/x"))).is_some());
        assert!(web_url(Some(&j("http://192.168.1.1/a.jpg"))).is_none());
        assert!(web_url(Some(&j("file:///C:/x"))).is_none());
        assert!(web_url(Some(&j("javascript:alert(1)"))).is_none());
    }
}
