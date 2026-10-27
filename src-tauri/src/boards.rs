// Boards — Miro/Milanote-style storyboarding.
//
// A board is stored as ONE JSON document (`{ viewport, elements: [...] }`) in the
// `boards` table; the frontend fully owns the element schema, so Rust treats `doc`
// as opaque text. Images placed on a board (from the library, files, or paste) are
// copied into a per-board assets dir and referenced by RELATIVE filename in the doc,
// which keeps the doc portable for native `.qbord` export/import between installs.

use rusqlite::params;
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::AppState;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Serialize)]
pub struct BoardMeta {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Absolute path to a cover image (resolved from the stored relative thumb), or None.
    pub thumb: Option<String>,
    pub element_count: i64,
}

#[derive(Serialize)]
pub struct Board {
    pub id: String,
    pub name: String,
    pub doc: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Absolute path to this board's assets dir — the frontend joins `${assets_dir}/${asset}`
    /// and runs it through convertFileSrc to render image elements.
    pub assets_dir: String,
}

#[derive(Serialize)]
pub struct AssetRef {
    /// Relative filename stored in the doc (e.g. "a1b2.png").
    pub asset: String,
    /// Absolute path for immediate rendering via convertFileSrc.
    pub abs: String,
}

// ─── Asset dirs ──────────────────────────────────────────────────
fn assets_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("board-assets"))
}

fn board_assets_dir(app: &AppHandle, board_id: &str) -> Result<PathBuf, String> {
    let d = assets_root(app)?.join(board_id);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn norm(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

// ─── CRUD ────────────────────────────────────────────────────────
#[tauri::command]
pub fn list_boards(app: AppHandle, state: State<AppState>) -> Result<Vec<BoardMeta>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db.prepare(
        "SELECT id, name, created_at, updated_at, thumb, element_count
         FROM boards ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, i64, i64, Option<String>, i64)> = stmt
        .query_map([], |r| Ok((
            r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?,
        ))).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    drop(db);

    Ok(rows.into_iter().map(|(id, name, created_at, updated_at, thumb, element_count)| {
        let thumb_abs = thumb.and_then(|t| {
            board_assets_dir(&app, &id).ok().map(|d| norm(&d.join(&t)))
        });
        BoardMeta { id, name, created_at, updated_at, thumb: thumb_abs, element_count }
    }).collect())
}

#[tauri::command]
pub fn create_board(name: String, app: AppHandle, state: State<AppState>) -> Result<BoardMeta, String> {
    let db = state.db.lock().unwrap();
    let id  = Uuid::new_v4().to_string();
    let now = now_ms();
    let name = if name.trim().is_empty() { "Untitled board".to_string() } else { name };
    db.execute(
        "INSERT INTO boards (id, name, doc, thumb, element_count, created_at, updated_at)
         VALUES (?1, ?2, '{}', NULL, 0, ?3, ?3)",
        params![id, name, now],
    ).map_err(|e| e.to_string())?;
    Ok(BoardMeta { id, name, created_at: now, updated_at: now, thumb: None, element_count: 0 })
}

#[tauri::command]
pub fn rename_board(id: String, name: String, state: State<AppState>) -> Result<(), String> {
    if name.trim().is_empty() { return Err("empty name".into()); }
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE boards SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now_ms(), id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_board(id: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    {
        let db = state.db.lock().unwrap();
        db.execute("DELETE FROM boards WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    }
    // Best-effort: remove the board's assets dir.
    if let Ok(dir) = assets_root(&app).map(|r| r.join(&id)) {
        let _ = std::fs::remove_dir_all(dir);
    }
    Ok(())
}

#[tauri::command]
pub fn get_board(id: String, app: AppHandle, state: State<AppState>) -> Result<Board, String> {
    let db = state.db.lock().unwrap();
    let (name, doc, created_at, updated_at): (String, String, i64, i64) = db.query_row(
        "SELECT name, doc, created_at, updated_at FROM boards WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).map_err(|e| e.to_string())?;
    drop(db);
    let assets_dir = norm(&board_assets_dir(&app, &id)?);
    Ok(Board { id, name, doc, created_at, updated_at, assets_dir })
}

/// Autosave the board document. `thumb` is a relative asset filename to use as the
/// list-card cover (or None); `element_count` is denormalised for the list view.
#[tauri::command]
pub fn save_board(
    id: String,
    doc: String,
    thumb: Option<String>,
    element_count: i64,
    state: State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute(
        "UPDATE boards SET doc = ?1, thumb = ?2, element_count = ?3, updated_at = ?4 WHERE id = ?5",
        params![doc, thumb, element_count, now_ms(), id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Assets ──────────────────────────────────────────────────────
fn write_asset(app: &AppHandle, board_id: &str, ext: &str, bytes: &[u8]) -> Result<AssetRef, String> {
    let dir = board_assets_dir(app, board_id)?;
    let ext = {
        let e = ext.trim_start_matches('.').to_lowercase();
        if e.is_empty() || e.len() > 5 || !e.chars().all(|c| c.is_ascii_alphanumeric()) {
            "png".to_string()
        } else { e }
    };
    let name = format!("{}.{}", Uuid::new_v4().simple(), ext);
    let path = dir.join(&name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(AssetRef { asset: name, abs: norm(&path) })
}

/// Copy an existing file (a library item's original, or a dropped/picked file) into
/// the board's assets dir.
#[tauri::command]
pub fn add_board_asset_from_path(
    board_id: String,
    src_path: String,
    app: AppHandle,
) -> Result<AssetRef, String> {
    let bytes = std::fs::read(&src_path).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&src_path)
        .extension().and_then(|e| e.to_str()).unwrap_or("png");
    write_asset(&app, &board_id, ext, &bytes)
}

/// Store raw bytes (a pasted image / data URL) as a board asset.
#[tauri::command]
pub fn add_board_asset_from_data(
    board_id: String,
    bytes: Vec<u8>,
    ext: String,
    app: AppHandle,
) -> Result<AssetRef, String> {
    write_asset(&app, &board_id, &ext, &bytes)
}

// ─── Native export / import (.qbord) ─────────────────────────────
// Same obfuscated-zip envelope as the .qooti collection pack, with a distinct magic
// so the two formats can't be confused. Payload: board.json + assets/<file>.
const BOARD_PACK_MAGIC: &[u8] = b"QOOTIBORD\x01\x00\x00";
const BOARD_PACK_KEY: &[u8]   = b"Qo0t!B04rd_S3cr3t_K3y_2026#XOR$";

fn xor(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().enumerate()
        .map(|(i, &b)| b ^ BOARD_PACK_KEY[i % BOARD_PACK_KEY.len()])
        .collect()
}

#[tauri::command]
pub fn export_board(id: String, save_path: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    use zip::write::FileOptions;
    use zip::CompressionMethod;

    let (name, doc): (String, String) = {
        let db = state.db.lock().unwrap();
        db.query_row("SELECT name, doc FROM boards WHERE id = ?1", params![id],
            |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?
    };

    let manifest = serde_json::json!({
        "version": 1,
        "type": "qooti-board-pack",
        "board": { "name": name, "doc": serde_json::from_str::<serde_json::Value>(&doc).unwrap_or(serde_json::json!({})) },
        "exported_at": now_ms(),
    });

    let cursor = std::io::Cursor::new(Vec::<u8>::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("board.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string(&manifest).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;

    // Bundle every asset file for this board.
    if let Ok(dir) = board_assets_dir(&app, &id) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() { continue; }
                if let (Some(fname), Ok(bytes)) = (p.file_name().and_then(|n| n.to_str()), std::fs::read(&p)) {
                    if zip.start_file(format!("assets/{fname}"), opts).is_ok() {
                        zip.write_all(&bytes).ok();
                    }
                }
            }
        }
    }

    let zip_bytes = zip.finish().map_err(|e| e.to_string())?.into_inner();
    let mut out = std::fs::File::create(&save_path).map_err(|e| e.to_string())?;
    out.write_all(BOARD_PACK_MAGIC).map_err(|e| e.to_string())?;
    out.write_all(&xor(&zip_bytes)).map_err(|e| e.to_string())?;
    log::info!(target: "Boards", "exported board={name:?} path={save_path:?}");
    Ok(())
}

#[tauri::command]
pub fn import_board(src_path: String, app: AppHandle, state: State<AppState>) -> Result<BoardMeta, String> {
    let raw = std::fs::read(&src_path).map_err(|e| e.to_string())?;
    if raw.len() < BOARD_PACK_MAGIC.len() || &raw[..BOARD_PACK_MAGIC.len()] != BOARD_PACK_MAGIC {
        return Err("Not a qooti board file".into());
    }
    let zip_bytes = xor(&raw[BOARD_PACK_MAGIC.len()..]);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| e.to_string())?;

    // Read board.json
    let manifest: serde_json::Value = {
        let mut f = archive.by_name("board.json").map_err(|_| "missing board.json".to_string())?;
        let mut s = String::new();
        std::io::Read::read_to_string(&mut f, &mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())?
    };
    let name = manifest.get("board").and_then(|b| b.get("name")).and_then(|n| n.as_str())
        .unwrap_or("Imported board").to_string();
    let doc_val = manifest.get("board").and_then(|b| b.get("doc")).cloned()
        .unwrap_or(serde_json::json!({}));
    let doc = serde_json::to_string(&doc_val).map_err(|e| e.to_string())?;
    let element_count = doc_val.get("elements").and_then(|e| e.as_array()).map(|a| a.len() as i64).unwrap_or(0);
    let thumb = doc_val.get("elements").and_then(|e| e.as_array())
        .and_then(|arr| arr.iter().find_map(|el| {
            if el.get("kind").and_then(|k| k.as_str()) == Some("image") {
                el.get("asset").and_then(|a| a.as_str()).map(|s| s.to_string())
            } else { None }
        }));

    let id  = Uuid::new_v4().to_string();
    let dir = board_assets_dir(&app, &id)?;

    // Extract assets/<file> into the new board's dir.
    for i in 0..archive.len() {
        let mut file = match archive.by_index(i) { Ok(f) => f, Err(_) => continue };
        let fname = file.name().to_string();
        if let Some(rel) = fname.strip_prefix("assets/") {
            if rel.is_empty() || rel.contains("..") || rel.contains('/') { continue; }
            let mut bytes = Vec::new();
            if std::io::Read::read_to_end(&mut file, &mut bytes).is_ok() {
                let _ = std::fs::write(dir.join(rel), &bytes);
            }
        }
    }

    let now = now_ms();
    {
        let db = state.db.lock().unwrap();
        db.execute(
            "INSERT INTO boards (id, name, doc, thumb, element_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, name, doc, thumb, element_count, now],
        ).map_err(|e| e.to_string())?;
    }

    let thumb_abs = thumb.map(|t| norm(&dir.join(t)));
    log::info!(target: "Boards", "imported board={name:?} id={id}");
    Ok(BoardMeta { id, name, created_at: now, updated_at: now, thumb: thumb_abs, element_count })
}
