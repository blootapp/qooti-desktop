//! Crop in the image player (crop spec, contract C1–C6).
//!
//! `crop_image` cuts a JPEG, PNG or WebP picture to the frame the page drew. Mode `replace` gives
//! the item the cut as its file and keeps the first original, which `restore_original` brings
//! back; mode `copy` saves the cut as a new item through the import path, with the same title,
//! tags and collections. Every crop is cut from the first original, so a JPEG is re-saved at most
//! once, however often it is cropped again. The third command of the feature, `set_item_aspect`,
//! lives with the other picture-shape code in commands.rs.
//!
//! Frames are fractions (0–1) of the picture as the page shows it: the current file, turned by its
//! EXIF orientation when it is a JPEG or PNG (WebView2 shows a WebP as stored, whatever its EXIF
//! says: commands::exif_turns). Rust rounds the frame's edges to whole pixels, once.

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, TryLockError};

use image::codecs::jpeg::{JpegDecoder, JpegEncoder};
use image::codecs::png::{PngDecoder, PngEncoder};
use image::codecs::webp::{WebPDecoder, WebPEncoder};
use image::{ColorType, DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageError, ImageFormat};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::commands::{self, ImportOne, Inspiration};
use crate::AppState;

// ── Schema (C1) ──────────────────────────────────────────────────────────────

/// The crop columns on `inspirations`, checked at every start like the Tag lens ones
/// (lenses::ensure_schema), so a library already at schema 36 gets them too. No SCHEMA_VERSION
/// bump: that would rebuild the search index and wipe object tags for three nullable columns.
/// - `original_path`: the first original's file, while the item shows a crop made with Save
/// - `original_hash`: that file's SHA-256 (importing it again finds the item)
/// - `crop_rect`: JSON `{"x","y","w","h"}`, the crop as fractions of the first original as shown
///
/// Each step is attempted, failures are logged, and the first one is returned.
pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    let mut first: Option<rusqlite::Error> = None;
    let mut step = |what: &str, r: rusqlite::Result<()>| {
        if let Err(e) = r {
            log::error!(target: "Crop", "schema step '{what}' failed: {e}");
            first.get_or_insert(e);
        }
    };
    for column in ["original_path", "original_hash", "crop_rect"] {
        step(column, add_column(conn, column));
    }
    step("idx_ins_original_hash",
         conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_ins_original_hash ON inspirations(original_hash)"));
    match first { Some(e) => Err(e), None => Ok(()) }
}

/// `ALTER TABLE inspirations ADD COLUMN <column> TEXT`, only when PRAGMA table_info doesn't list it.
fn add_column(conn: &Connection, column: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(inspirations)")?;
    let cols: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<Result<_, _>>()?;
    if cols.iter().any(|c| c.eq_ignore_ascii_case(column)) { return Ok(()); }
    conn.execute_batch(&format!("ALTER TABLE inspirations ADD COLUMN {column} TEXT"))
}

// ── Errors ───────────────────────────────────────────────────────────────────

/// Why a crop or a restore didn't happen. The page gets `code()`: a plain code it turns into words
/// (spec B11), never a technical message; the details go to the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CropError {
    /// The frame isn't inside the picture, or isn't made of numbers.
    BadRect,
    /// The mode is neither `replace` nor `copy`.
    BadMode,
    /// No item with that id.
    NotFound,
    /// Not a still JPEG, PNG or WebP picture (GIFs, videos, AVIF, HEIC, animated WebP, APNG …).
    Unsupported,
    /// The file couldn't be read or decoded.
    Unreadable,
    /// More pixels than the decoder may hold (512 MiB).
    TooBig,
    /// A side of the cut would be under MIN_SIDE pixels.
    TooSmall,
    /// The frame takes in the whole picture: nothing to save.
    NoChange,
    /// A file couldn't be written or renamed, or the database refused the change.
    Disk,
    /// The item's file changed while the crop was being made: nothing was saved.
    Changed,
    /// Another crop is running.
    Busy,
    /// Save as copy: the same picture is already in the library, as this item.
    AlreadySaved(String),
    /// Restore: the item has no kept original.
    NoOriginal,
    /// Restore: the kept original's file is gone (or can't be read); nothing was changed.
    OriginalMissing,
}

impl CropError {
    pub fn code(&self) -> String {
        match self {
            CropError::BadRect => "bad_rect".into(),
            CropError::BadMode => "bad_mode".into(),
            CropError::NotFound => "not_found".into(),
            CropError::Unsupported => "unsupported".into(),
            CropError::Unreadable => "unreadable".into(),
            CropError::TooBig => "too_big".into(),
            CropError::TooSmall => "too_small".into(),
            CropError::NoChange => "no_change".into(),
            CropError::Disk => "disk".into(),
            CropError::Changed => "changed".into(),
            CropError::Busy => "busy".into(),
            CropError::AlreadySaved(id) => format!("already_saved:{id}"),
            CropError::NoOriginal => "no_original".into(),
            CropError::OriginalMissing => "original_missing".into(),
        }
    }
}

/// A database error. With one connection behind a mutex, what refuses a write is the disk (full,
/// read-only, gone), so the page hears `disk`; the message goes to the log.
fn db_err(e: rusqlite::Error) -> CropError {
    log::warn!(target: "Crop", "the database refused: {e}");
    CropError::Disk
}

// ── Frames ───────────────────────────────────────────────────────────────────

/// What crop_image does with the cut.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The item gets the cut as its file; its first original is kept.
    Replace,
    /// The cut becomes a new item.
    Copy,
}

impl Mode {
    pub fn parse(s: &str) -> Result<Mode, CropError> {
        match s {
            "replace" => Ok(Mode::Replace),
            "copy" => Ok(Mode::Copy),
            _ => Err(CropError::BadMode),
        }
    }
}

/// A frame as fractions of a picture: left, top, width, height.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// How far past the picture's edge a frame from the page may reach and still be clamped (float
/// rounding in the page) rather than refused.
const EDGE_SLACK: f64 = 1e-6;

/// The smallest side a cut may have, in pixels. The page keeps frames at 32 picture pixels or
/// 40 screen pixels, whichever is more; this is the floor behind it.
const MIN_SIDE: u32 = 16;

impl Rect {
    pub const FULL: Rect = Rect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };

    /// The frame the page sent, checked: all four values finite, 0 ≤ x, y < 1, 0 < w, h ≤ 1, and
    /// x + w, y + h ≤ 1. An overshoot of at most 1e-6 (float rounding) is clamped back inside the
    /// picture; anything else is `bad_rect`.
    pub fn from_page(x: f64, y: f64, w: f64, h: f64) -> Result<Rect, CropError> {
        if ![x, y, w, h].iter().all(|v| v.is_finite()) { return Err(CropError::BadRect); }
        if x < -EDGE_SLACK || y < -EDGE_SLACK || x >= 1.0 || y >= 1.0 || w <= 0.0 || h <= 0.0
            || w > 1.0 + EDGE_SLACK || h > 1.0 + EDGE_SLACK
            || x + w > 1.0 + EDGE_SLACK || y + h > 1.0 + EDGE_SLACK
        {
            return Err(CropError::BadRect);
        }
        let (x, y) = (x.max(0.0), y.max(0.0));
        let (w, h) = (w.min(1.0 - x), h.min(1.0 - y));
        if w <= 0.0 || h <= 0.0 { return Err(CropError::BadRect); }
        Ok(Rect { x, y, w, h })
    }

    /// `inner`, a frame in the picture this frame cut out, as a frame in the whole picture.
    pub fn compose(self, inner: Rect) -> Rect {
        Rect { x: self.x + inner.x * self.w, y: self.y + inner.y * self.h, w: inner.w * self.w, h: inner.h * self.h }
    }

    /// A stored `crop_rect`; None when it isn't a usable frame.
    fn parse(json: &str) -> Option<Rect> {
        serde_json::from_str::<Rect>(json).ok()
            .filter(|r| [r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite()) && r.w > 0.0 && r.h > 0.0)
    }

    fn to_json(self) -> String {
        serde_json::to_string(&self).unwrap_or_default()
    }
}

/// The frame's edges on a `width`×`height` picture as whole pixels, kept inside it: (left, top,
/// right, bottom). The edges are rounded, not the sizes, so two crops that meet share an edge.
fn edges(r: Rect, width: u32, height: u32) -> (u32, u32, u32, u32) {
    let px = |f: f64, size: u32| (f * size as f64).round().clamp(0.0, size as f64) as u32;
    (px(r.x, width), px(r.y, height), px(r.x + r.w, width), px(r.y + r.h, height))
}

/// The frame takes in all of a `width`×`height` picture, to the pixel.
fn covers_all(r: Rect, width: u32, height: u32) -> bool {
    edges(r, width, height) == (0, 0, width, height)
}

/// The cut in pixels (left, top, width, height); a side under MIN_SIDE is `too_small`.
fn pixel_box(r: Rect, width: u32, height: u32) -> Result<(u32, u32, u32, u32), CropError> {
    let (x0, y0, x1, y1) = edges(r, width, height);
    let (w, h) = (x1.saturating_sub(x0), y1.saturating_sub(y0));
    if w < MIN_SIDE || h < MIN_SIDE { return Err(CropError::TooSmall); }
    Ok((x0, y0, w, h))
}

/// The cut of a frame on the picture it was drawn on: `no_change` when it takes in the whole
/// picture, `too_small` when a side is under MIN_SIDE pixels.
fn pixel_rect(r: Rect, width: u32, height: u32) -> Result<(u32, u32, u32, u32), CropError> {
    if covers_all(r, width, height) { return Err(CropError::NoChange); }
    pixel_box(r, width, height)
}

// ── Pictures ─────────────────────────────────────────────────────────────────

/// A decoded picture: its pixels as the page shows them (a JPEG or PNG turned by its EXIF
/// orientation), its file format and its colour profile.
struct Picture {
    img: DynamicImage,
    format: ImageFormat,
    icc: Option<Vec<u8>>,
}

/// Read a still JPEG, PNG or WebP picture the way the page shows it. Any other format (GIF,
/// AVIF, HEIC, …), an animated WebP or an APNG: `unsupported`. A file that can't be decoded:
/// `unreadable`. More pixels than the decoder may hold (512 MiB): `too_big`.
fn decode(bytes: &[u8]) -> Result<Picture, CropError> {
    let format = image::guess_format(bytes).map_err(|_| CropError::Unsupported)?;
    let cursor = || std::io::Cursor::new(bytes);
    let turn = commands::exif_turns(format);
    let (img, icc) = match format {
        ImageFormat::Jpeg => decode_with(JpegDecoder::new(cursor()).map_err(decode_err)?, turn)?,
        ImageFormat::Png => {
            let dec = PngDecoder::with_limits(cursor(), image::Limits::default()).map_err(decode_err)?;
            if dec.is_apng().map_err(decode_err)? { return Err(CropError::Unsupported); }
            decode_with(dec, turn)?
        }
        ImageFormat::WebP => {
            let dec = WebPDecoder::new(cursor()).map_err(decode_err)?;
            if dec.has_animation() { return Err(CropError::Unsupported); }
            decode_with(dec, turn)?
        }
        _ => return Err(CropError::Unsupported),
    };
    Ok(Picture { img, format, icc })
}

/// `turn`: apply the EXIF orientation, as the page does for this format (commands::exif_turns).
fn decode_with(mut dec: impl ImageDecoder, turn: bool) -> Result<(DynamicImage, Option<Vec<u8>>), CropError> {
    use image::metadata::Orientation::NoTransforms;
    image::Limits::default().reserve(dec.total_bytes()).map_err(|_| CropError::TooBig)?;
    // An EXIF block that can't be read means "not turned", as commands::image_aspect_ratio reads it
    let orientation = if turn { dec.orientation().unwrap_or(NoTransforms) } else { NoTransforms };
    let icc = dec.icc_profile().ok().flatten();
    let mut img = DynamicImage::from_decoder(dec).map_err(decode_err)?;
    img.apply_orientation(orientation);
    Ok((img, icc))
}

fn decode_err(e: ImageError) -> CropError {
    match e {
        ImageError::Limits(_) => CropError::TooBig,
        ImageError::Unsupported(_) => CropError::Unsupported,
        e => {
            log::debug!(target: "Crop", "decode failed: {e}");
            CropError::Unreadable
        }
    }
}

/// The cut in the source's format: JPEG at quality 92 (RGB, or grey for a grey JPEG), PNG in its
/// own colour type (alpha and 16 bits kept), WebP lossless (all the image crate writes: it can be
/// larger than a lossy source, but loses nothing more). The colour profile is kept when it fits
/// the pixels written. EXIF is left out: the orientation is in the pixels now, and camera and
/// location data go.
fn encode(img: &DynamicImage, format: ImageFormat, icc: Option<&[u8]>) -> Result<Vec<u8>, CropError> {
    let mut out = Vec::new();
    let (w, h) = (img.width(), img.height());
    let written = match format {
        ImageFormat::Jpeg => {
            let grey = !img.color().has_color();
            let mut enc = JpegEncoder::new_with_quality(&mut out, 92);
            keep_profile(&mut enc, icc, if grey { b"GRAY" } else { b"RGB " });
            if grey {
                let px = img.to_luma8();
                enc.write_image(px.as_raw(), w, h, ExtendedColorType::L8)
            } else {
                let px = img.to_rgb8();
                enc.write_image(px.as_raw(), w, h, ExtendedColorType::Rgb8)
            }
        }
        ImageFormat::Png => {
            let converted;
            let img = match img.color() {
                ColorType::L8 | ColorType::La8 | ColorType::Rgb8 | ColorType::Rgba8
                | ColorType::L16 | ColorType::La16 | ColorType::Rgb16 | ColorType::Rgba16 => img,
                c if c.has_alpha() => { converted = DynamicImage::ImageRgba16(img.to_rgba16()); &converted }
                _ => { converted = DynamicImage::ImageRgb16(img.to_rgb16()); &converted }
            };
            let mut enc = PngEncoder::new(&mut out);
            keep_profile(&mut enc, icc, if img.color().has_color() { b"RGB " } else { b"GRAY" });
            enc.write_image(img.as_bytes(), w, h, img.color().into())
        }
        ImageFormat::WebP => {
            let mut enc = WebPEncoder::new_lossless(&mut out);
            keep_profile(&mut enc, icc, b"RGB ");
            if img.color().has_alpha() {
                let px = img.to_rgba8();
                enc.write_image(px.as_raw(), w, h, ExtendedColorType::Rgba8)
            } else {
                let px = img.to_rgb8();
                enc.write_image(px.as_raw(), w, h, ExtendedColorType::Rgb8)
            }
        }
        _ => return Err(CropError::Unsupported),
    };
    written.map_err(|e| match e {
        ImageError::Limits(_) => CropError::TooBig,
        e => {
            log::warn!(target: "Crop", "encode failed: {e}");
            CropError::Unsupported
        }
    })?;
    Ok(out)
}

/// Give the encoder the source's colour profile when it describes the pixels written: an RGB
/// profile for RGB pixels, a grey one for grey (a CMYK JPEG's profile doesn't fit the RGB pixels
/// it decodes to). The colour space is in the profile's header, bytes 16–19.
fn keep_profile(enc: &mut impl ImageEncoder, icc: Option<&[u8]>, space: &[u8; 4]) {
    if let Some(profile) = icc.filter(|p| p.get(16..20) == Some(&space[..])) {
        let _ = enc.set_icc_profile(profile.to_vec());
    }
}

/// The file extension and MIME type a cut in `format` is saved with.
fn file_kind(format: ImageFormat) -> (&'static str, &'static str) {
    match format {
        ImageFormat::Png => ("png", "image/png"),
        ImageFormat::WebP => ("webp", "image/webp"),
        _ => ("jpg", "image/jpeg"),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

// ── Cutting ──────────────────────────────────────────────────────────────────

/// The item as crop_image found it (read under the database lock, which is released after).
struct Item {
    id: String,
    stored_path: String,
    file_hash: Option<String>,
    original_path: Option<String>,
    /// The crop the current file shows, in the first original (set together with original_path).
    crop: Option<Rect>,
    enhanced_path: Option<String>,
}

fn read_item(conn: &Connection, id: &str) -> Result<Item, CropError> {
    let row = conn.query_row(
        "SELECT type, stored_path, file_hash, original_path, crop_rect, enhanced_path
         FROM inspirations WHERE id = ?1",
        params![id],
        |r| Ok((r.get::<_, String>(0)?, Item {
            id: id.to_string(),
            stored_path: r.get(1)?,
            file_hash: r.get(2)?,
            original_path: r.get::<_, Option<String>>(3)?.filter(|p| !p.is_empty()),
            crop: r.get::<_, Option<String>>(4)?.as_deref().and_then(Rect::parse),
            enhanced_path: r.get(5)?,
        })),
    ).optional().map_err(db_err)?;
    let Some((kind, item)) = row else { return Err(CropError::NotFound) };
    // Still pictures only: GIFs (their own type), videos and links have no crop
    if kind != "image" { return Err(CropError::Unsupported); }
    Ok(item)
}

/// What a crop came to, before anything is written.
struct Cut {
    bytes: Vec<u8>,
    ext: &'static str,
    mime: &'static str,
    width: u32,
    height: u32,
    hash: String,
    palette: Option<String>,
    /// The cut as fractions of the first original (what `crop_rect` stores), snapped to pixels.
    rect_in_original: Rect,
    /// SHA-256 of the current file, when it was the one read: the first original's hash for an
    /// item saved without a file_hash.
    current_hash: Option<String>,
}

fn read_picture(path: &Path) -> Result<(Vec<u8>, Picture), CropError> {
    let bytes = std::fs::read(path).map_err(|e| {
        log::debug!(target: "Crop", "couldn't read {path:?}: {e}");
        CropError::Unreadable
    })?;
    let picture = decode(&bytes)?;
    Ok((bytes, picture))
}

/// Decode, cut and encode, with the database released. The source is the first original when the
/// item has one that can still be read (the page's frame is composed into it, so a JPEG is never
/// re-saved twice), else the current file. `no_change` is judged on the picture the page showed.
fn cut(item: &Item, r: Rect) -> Result<Cut, CropError> {
    if let (Some(original), Some(prev)) = (item.original_path.as_deref(), item.crop) {
        match read_picture(Path::new(original)) {
            Ok((_, pic)) => {
                let (w, h) = (pic.img.width(), pic.img.height());
                // The current file is `prev` of the original: does the frame take in all of it?
                let (x0, y0, x1, y1) = edges(prev, w, h);
                if covers_all(r, x1.saturating_sub(x0), y1.saturating_sub(y0)) { return Err(CropError::NoChange); }
                let cut_box = pixel_box(prev.compose(r), w, h)?;
                return finish(pic, cut_box, Rect::FULL, None);
            }
            Err(e) => log::warn!(target: "Crop",
                "the first original of id={} can't be used ({}): cut from the current file", item.id, e.code()),
        }
    }
    let (bytes, pic) = read_picture(Path::new(&item.stored_path))?;
    let cut_box = pixel_rect(r, pic.img.width(), pic.img.height())?;
    // Where the current file sits in the first original: all of it, or the earlier crop when the
    // original couldn't be read (the frame stays right)
    finish(pic, cut_box, item.crop.unwrap_or(Rect::FULL), Some(sha256_hex(&bytes)))
}

/// Cut `cut_box` (left, top, width, height in pixels) out of `pic` and encode it. `base` is where
/// `pic` sits in the first original.
fn finish(pic: Picture, cut_box: (u32, u32, u32, u32), base: Rect, current_hash: Option<String>) -> Result<Cut, CropError> {
    let (w, h) = (pic.img.width(), pic.img.height());
    let (x0, y0, cw, ch) = cut_box;
    let snapped = Rect { x: x0 as f64 / w as f64, y: y0 as f64 / h as f64, w: cw as f64 / w as f64, h: ch as f64 / h as f64 };
    let out = pic.img.crop_imm(x0, y0, cw, ch);
    let bytes = encode(&out, pic.format, pic.icc.as_deref())?;
    // From the pixels in memory, so the picture isn't decoded twice
    let colours = commands::palette_from_image(&out, 5);
    let (ext, mime) = file_kind(pic.format);
    Ok(Cut {
        hash: sha256_hex(&bytes),
        bytes,
        ext,
        mime,
        width: cw,
        height: ch,
        palette: if colours.is_empty() { None } else { serde_json::to_string(&colours).ok() },
        rect_in_original: base.compose(snapped),
        current_hash,
    })
}

fn lock(db: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|e| e.into_inner())
}

/// crop_image on one database and library folder: check the item, cut it, then replace its file
/// or save the cut as a new item. `free`: the Free plan's rules apply (a copy isn't added to the
/// collections it only reads).
pub(crate) fn crop_with(
    db: &Mutex<Connection>,
    vault: &Path,
    id: &str,
    rect: Rect,
    mode: Mode,
    free: bool,
) -> Result<Inspiration, CropError> {
    let item = read_item(&lock(db), id)?;
    let cut = std::panic::catch_unwind(AssertUnwindSafe(|| cut(&item, rect))).unwrap_or_else(|_| {
        log::error!(target: "Crop", "the picture of id={id} made the decoder fail");
        Err(CropError::Unreadable)
    })?;
    match mode {
        Mode::Replace => replace(db, vault, &item, &cut),
        Mode::Copy => copy(db, vault, &item, &cut, free),
    }
}

// ── Save (replace) ───────────────────────────────────────────────────────────

/// Letters, digits, '-' and '_' only: item ids are UUIDs, and no other id may reach outside the
/// library's folders through a file name.
fn file_safe(id: &str) -> String {
    let s: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if s.is_empty() { "item".into() } else { s }
}

/// Write the cut into the library: `temp/<uuid>.part` first, then renamed to
/// `images/<id>_crop_<unix ms>.<ext>`. A new name is a new address for the page, so no cached
/// picture can show. Any failure: `disk`, with nothing left behind.
fn write_into_library(vault: &Path, id: &str, cut: &Cut) -> Result<PathBuf, CropError> {
    let (temp, images) = (vault.join("temp"), vault.join("images"));
    let part = temp.join(format!("{}.part", Uuid::new_v4()));
    let mut dest = images.join(format!("{}_crop_{}.{}", file_safe(id), commands::now_ms(), cut.ext));
    if dest.exists() {
        dest = images.join(format!("{}_crop_{}_{}.{}", file_safe(id), commands::now_ms(), Uuid::new_v4().simple(), cut.ext));
    }
    let written = std::fs::create_dir_all(&temp)
        .and_then(|_| std::fs::create_dir_all(&images))
        .and_then(|_| std::fs::write(&part, &cut.bytes))
        .and_then(|_| std::fs::rename(&part, &dest));
    match written {
        Ok(()) => Ok(dest),
        Err(e) => {
            log::warn!(target: "Crop", "couldn't write the cut of id={id}: {e}");
            let _ = std::fs::remove_file(&part);
            Err(CropError::Disk)
        }
    }
}

/// Remove a file the item doesn't use any more. Already gone is fine; any other failure is
/// logged (it only leaves a stray file behind).
fn remove_logged(path: &str) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!(target: "Crop", "couldn't remove {path:?}: {e}");
        }
    }
}

/// Mode `replace`: the cut is written into the library and becomes the item's file in one
/// transaction that resets what was worked out from the old pixels (contract C6). The write only
/// happens while the item still shows the file that was cut (`changed` otherwise, and the new file
/// is removed). Afterwards an in-between crop and any upscaled copy are removed; the first original
/// never is.
fn replace(db: &Mutex<Connection>, vault: &Path, item: &Item, cut: &Cut) -> Result<Inspiration, CropError> {
    let new_path = write_into_library(vault, &item.id, cut)?;
    let upscaled_at_write = match commit_replace(&lock(db), item, cut, &new_path.to_string_lossy()) {
        Ok(upscaled) => upscaled,
        Err(e) => {
            let _ = std::fs::remove_file(&new_path);
            return Err(e);
        }
    };
    // The file it showed until now goes when it was itself a crop (the first original is kept)
    if item.original_path.as_deref().is_some_and(|o| o != item.stored_path) {
        remove_logged(&item.stored_path);
    }
    // The upscaled copies showed the old framing
    for upscaled in old_upscales(item.enhanced_path.as_deref(), upscaled_at_write.as_deref()) {
        remove_logged(upscaled);
    }
    commands::load_inspiration(&lock(db), &item.id).map_err(db_err)
}

/// The upscaled copies a crop or a restore leaves without a use: the one the item had when it was
/// read, and the one it had when the change was written (an Upscale can finish in between, while
/// the picture is being cut). Each once.
fn old_upscales<'a>(when_read: Option<&'a str>, at_write: Option<&'a str>) -> Vec<&'a str> {
    let mut paths: Vec<&str> = [when_read, at_write].into_iter().flatten().filter(|p| !p.is_empty()).collect();
    paths.dedup();
    paths
}

/// The item's upscaled copy as the row has it now (inside the transaction that replaces it).
fn upscaled_now(conn: &Connection, id: &str) -> Result<Option<String>, CropError> {
    Ok(conn
        .query_row("SELECT enhanced_path FROM inspirations WHERE id = ?1", params![id], |r| r.get::<_, Option<String>>(0))
        .optional().map_err(db_err)?.flatten())
}

/// → the upscaled copy the row pointed to as the cut replaced it (the caller removes it).
fn commit_replace(conn: &Connection, item: &Item, cut: &Cut, new_path: &str) -> Result<Option<String>, CropError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db_err)?;
    let hints = collection_hints(&tx, &item.id)?;
    let upscaled = upscaled_now(&tx, &item.id)?;
    // The first original's hash, on the first crop only (later ones keep it)
    let original_hash = if item.original_path.is_none() {
        item.file_hash.clone().filter(|h| !h.is_empty()).or_else(|| cut.current_hash.clone())
    } else {
        None
    };
    let n = tx.execute(
        "UPDATE inspirations SET
             stored_path = ?2, file_hash = ?3, aspect_ratio = ?4, palette = ?5, mime_type = ?6,
             original_path = COALESCE(original_path, ?7), original_hash = COALESCE(original_hash, ?8),
             crop_rect = ?9,
             ocr_text = '', ocr_status = NULL, ocr_language = NULL,
             phash = NULL, phash_source = NULL, enhanced_path = NULL,
             auto_tag_sig = NULL, auto_tag_status = NULL, auto_tag_model = NULL, lens_suggestions = ?10,
             object_tags = NULL, object_status = NULL,
             updated_at = ?11
         WHERE id = ?1 AND stored_path = ?7",
        params![
            item.id, new_path, cut.hash, cut.width as f64 / cut.height as f64, cut.palette, cut.mime,
            item.stored_path, original_hash, cut.rect_in_original.to_json(), hints, commands::now_ms(),
        ],
    ).map_err(db_err)?;
    if n == 0 { return Err(gone_or_changed(&tx, &item.id)); }   // the transaction rolls back
    forget_derived(&tx, &item.id);
    tx.commit().map_err(db_err)?;
    Ok(upscaled)
}

/// The item's suggestion map reduced to its collection hints (`col:<tag_id>`): the lens scores came
/// from the old pixels and go, the hints don't depend on them. None when no hint is left.
fn collection_hints(conn: &Connection, id: &str) -> Result<Option<String>, CropError> {
    let current: Option<String> = conn
        .query_row("SELECT lens_suggestions FROM inspirations WHERE id = ?1", params![id], |r| r.get(0))
        .optional().map_err(db_err)?.flatten();
    Ok(only_collection_hints(current.as_deref()))
}

fn only_collection_hints(json: Option<&str>) -> Option<String> {
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(json?).ok()?;
    let kept: serde_json::Map<String, serde_json::Value> = map.into_iter().filter(|(k, _)| k.starts_with("col:")).collect();
    if kept.is_empty() { None } else { Some(serde_json::Value::Object(kept).to_string()) }
}

/// The vectors and duplicate pairs made from the old pixels. The indexer makes a new vector from
/// the new file (clip::wake), and tag suggestions are scored from it. Best effort: a failed delete
/// is logged and leaves the rest of the transaction standing.
fn forget_derived(conn: &Connection, id: &str) {
    for sql in [
        "DELETE FROM clip_embeddings WHERE id = ?1",
        "DELETE FROM clip_frames WHERE id = ?1",
        "DELETE FROM duplicate_pairs WHERE inspiration_id_a = ?1 OR inspiration_id_b = ?1",
    ] {
        if let Err(e) = conn.execute(sql, params![id]) {
            log::warn!(target: "Crop", "old data of id={id} not cleared: {e}");
        }
    }
}

/// A guarded write changed nothing: the item is gone (`not_found`) or shows another file now
/// (`changed`).
fn gone_or_changed(conn: &Connection, id: &str) -> CropError {
    match conn.query_row("SELECT 1 FROM inspirations WHERE id = ?1", params![id], |_| Ok(())).optional() {
        Ok(Some(())) => CropError::Changed,
        Ok(None) => CropError::NotFound,
        Err(e) => db_err(e),
    }
}

// ── Save as copy ─────────────────────────────────────────────────────────────

/// Mode `copy`: the cut goes through the import path (commands::import_one, import source
/// `crop_copy`) as a new item, then gets the source's title, tags and collections. The source item
/// isn't touched. The same picture already in the library: `already_saved:<id>`.
fn copy(db: &Mutex<Connection>, vault: &Path, item: &Item, cut: &Cut, free: bool) -> Result<Inspiration, CropError> {
    let temp = vault.join("temp");
    let file = temp.join(format!("crop-{}.{}", Uuid::new_v4(), cut.ext));
    if let Err(e) = std::fs::create_dir_all(&temp).and_then(|_| std::fs::write(&file, &cut.bytes)) {
        log::warn!(target: "Crop", "couldn't write the copy of id={}: {e}", item.id);
        let _ = std::fs::remove_file(&file);
        return Err(CropError::Disk);
    }
    let imported = commands::import_one(db, vault, &file.to_string_lossy(), "crop_copy", &|_| (None, None));
    let _ = std::fs::remove_file(&file);
    let new_item = match imported {
        Ok(ImportOne::Imported(new_item)) => new_item,
        Ok(ImportOne::Existing(other)) => return Err(CropError::AlreadySaved(other)),
        Ok(ImportOne::Skipped) => return Err(CropError::Unreadable),
        Err(e) => {
            log::warn!(target: "Crop", "the copy of id={} wasn't saved: {e}", item.id);
            return Err(CropError::Disk);
        }
    };
    let conn = lock(db);
    if let Err(e) = copy_extras(&conn, &item.id, &new_item.id, free) {
        // The copy is saved: say so, with what it got
        log::warn!(target: "Crop", "copy {} of id={} saved without all of its title, tags and collections: {e}", new_item.id, item.id);
    }
    commands::load_inspiration(&conn, &new_item.id).map_err(db_err)
}

/// Onto a crop saved as a copy, from the item it was cut from: the title and source; every tag,
/// through commands::tag_item (the same counting and answer rules as a person adding it; a
/// refusal because the copy already has a tag with that name is skipped); every collection except
/// those the Free plan only reads (`free`); and a "not duplicates" pair, so the Duplicates finder
/// never offers to delete a crop made on purpose.
fn copy_extras(conn: &Connection, from: &str, to: &str, free: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE inspirations SET (title, source_url, source_platform) =
             (SELECT title, source_url, source_platform FROM inspirations WHERE id = ?1)
         WHERE id = ?2",
        params![from, to],
    )?;
    let ids = |sql: &str| -> rusqlite::Result<Vec<String>> {
        let mut stmt = conn.prepare(sql)?;
        let ids = stmt.query_map(params![from], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    };
    for tag in ids("SELECT tag_id FROM inspiration_tags WHERE inspiration_id = ?1 ORDER BY rowid")? {
        if let Err(e) = commands::tag_item(conn, to, &tag) {
            log::debug!(target: "Crop", "tag {tag} not given to the copy {to}: {e}");
        }
    }
    let now = commands::now_ms();
    for collection in ids("SELECT collection_id FROM collection_items WHERE inspiration_id = ?1 ORDER BY rowid")? {
        if free && commands::collection_past_free_allowance(conn, &collection) { continue; }
        conn.execute(
            "INSERT OR IGNORE INTO collection_items (collection_id, inspiration_id, created_at) VALUES (?1, ?2, ?3)",
            params![collection, to, now],
        )?;
    }
    let (a, b) = if from < to { (from, to) } else { (to, from) };
    conn.execute("INSERT OR IGNORE INTO ignored_dupes (a, b) VALUES (?1, ?2)", params![a, b])?;
    Ok(())
}

// ── Restore original (C5) ────────────────────────────────────────────────────

/// The kept original as it goes back: its hash, shape as shown, colours and MIME type.
struct Restored {
    hash: String,
    ratio: f64,
    palette: Option<String>,
    mime: Option<&'static str>,
}

/// restore_original on one database: the item shows its first original again, with the same
/// resets as a crop; the cut file and any upscaled copy are removed afterwards. Errors:
/// `not_found`, `no_original`, `original_missing` (nothing changes), `disk`, `changed`.
pub(crate) fn restore_with(db: &Mutex<Connection>, id: &str) -> Result<Inspiration, CropError> {
    type Row = (String, Option<String>, Option<String>, Option<String>, f64, Option<String>);
    let row: Option<Row> = lock(db).query_row(
        "SELECT stored_path, original_path, original_hash, crop_rect, aspect_ratio, enhanced_path
         FROM inspirations WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    ).optional().map_err(db_err)?;
    let Some((current, original, original_hash, crop, aspect, enhanced)) = row else { return Err(CropError::NotFound) };
    let Some(original) = original.filter(|p| !p.is_empty()) else { return Err(CropError::NoOriginal) };
    let path = Path::new(&original);
    if !path.is_file() { return Err(CropError::OriginalMissing); }

    // Its shape as shown; when its header can't be read, worked back from the crop:
    // shape of the cut = (w · W) / (h · H), so W / H = shape · h / w
    let crop = crop.as_deref().and_then(Rect::parse);
    let ratio = commands::image_aspect_ratio(&original)
        .or_else(|| crop.map(|c| aspect * c.h / c.w))
        .filter(|r| r.is_finite() && *r > 0.0)
        .unwrap_or(aspect);
    let colours = std::panic::catch_unwind(|| commands::palette_from_path(&original, 5)).unwrap_or_default();
    let hash = match original_hash.filter(|h| !h.is_empty()) {
        Some(h) => h,
        None => commands::stream_hash(path).map_err(|e| {
            log::warn!(target: "Crop", "the original of id={id} can't be read: {e}");
            CropError::OriginalMissing
        })?,
    };
    let restored = Restored {
        hash,
        ratio,
        palette: if colours.is_empty() { None } else { serde_json::to_string(&colours).ok() },
        mime: sniff_mime(path),
    };
    let upscaled_at_write = commit_restore(&lock(db), id, &current, &original, &restored)?;
    // The cut it showed, and the upscaled copies of the cut
    if current != original { remove_logged(&current); }
    for upscaled in old_upscales(enhanced.as_deref(), upscaled_at_write.as_deref()) { remove_logged(upscaled); }
    commands::load_inspiration(&lock(db), id).map_err(db_err)
}

/// → the upscaled copy the row pointed to as the original came back (the caller removes it).
fn commit_restore(conn: &Connection, id: &str, current: &str, original: &str, r: &Restored) -> Result<Option<String>, CropError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(db_err)?;
    let hints = collection_hints(&tx, id)?;
    let upscaled = upscaled_now(&tx, id)?;
    let n = tx.execute(
        "UPDATE inspirations SET
             stored_path = original_path, file_hash = ?3, aspect_ratio = ?4,
             palette = COALESCE(?5, palette), mime_type = COALESCE(?6, mime_type),
             original_path = NULL, original_hash = NULL, crop_rect = NULL,
             ocr_text = '', ocr_status = NULL, ocr_language = NULL,
             phash = NULL, phash_source = NULL, enhanced_path = NULL,
             auto_tag_sig = NULL, auto_tag_status = NULL, auto_tag_model = NULL, lens_suggestions = ?7,
             object_tags = NULL, object_status = NULL,
             updated_at = ?8
         WHERE id = ?1 AND stored_path = ?2 AND original_path = ?9",
        params![id, current, r.hash, r.ratio, r.palette, r.mime, hints, commands::now_ms(), original],
    ).map_err(db_err)?;
    if n == 0 { return Err(gone_or_changed(&tx, id)); }
    forget_derived(&tx, id);
    tx.commit().map_err(db_err)?;
    Ok(upscaled)
}

/// The MIME type of a JPEG, PNG or WebP file, from its first bytes.
fn sniff_mime(path: &Path) -> Option<&'static str> {
    use std::io::Read;
    let mut head = [0u8; 16];
    let n = std::fs::File::open(path).ok()?.read(&mut head).ok()?;
    match image::guess_format(&head[..n]).ok()? {
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Png => Some("image/png"),
        ImageFormat::WebP => Some("image/webp"),
        _ => None,
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// One crop or restore at a time.
static CROP_LOCK: Mutex<()> = Mutex::new(());

/// Run `f` as the only crop or restore. A crop that finds another one running is turned away
/// (`busy`, `wait` false); a restore waits its turn (`wait` true).
fn exclusive<T>(wait: bool, f: impl FnOnce() -> Result<T, CropError>) -> Result<T, CropError> {
    let _turn = if wait {
        CROP_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    } else {
        match CROP_LOCK.try_lock() {
            Ok(g) => g,
            Err(TryLockError::Poisoned(p)) => p.into_inner(),
            Err(TryLockError::WouldBlock) => return Err(CropError::Busy),
        }
    };
    f()
}

/// Cut a picture to the frame the page drew: `x, y, w, h` are fractions (0–1) of the picture as it
/// is shown (the current file; a JPEG or PNG turned by its EXIF orientation). `mode` `replace`: the item gets the cut
/// and keeps its first original (`has_original` true); `copy`: the cut becomes a new item with the
/// source's title, tags and collections. Returns the item changed or made. Errors are plain codes
/// (CropError::code): bad_rect, bad_mode, not_found, unsupported, unreadable, too_big, too_small,
/// no_change, disk, changed, busy, already_saved:<id>.
#[tauri::command]
pub async fn crop_image(app: AppHandle, id: String, x: f64, y: f64, w: f64, h: f64, mode: String) -> Result<Inspiration, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = crop_command(&app, &id, Rect::from_page(x, y, w, h), &mode);
        match &result {
            Ok(item) => {
                log::info!(target: "Crop", "cropped id={id} mode={mode} item={}", item.id);
                // The new pixels get a new vector, and with it new tag suggestions
                crate::clip::wake();
            }
            Err(e) => log::warn!(target: "Crop", "crop_failed id={id} mode={mode} error={}", e.code()),
        }
        result.map_err(|e| e.code())
    })
    .await
    .map_err(|e| {
        log::error!(target: "Crop", "the crop task failed: {e}");
        CropError::Unreadable.code()
    })?
}

fn crop_command(app: &AppHandle, id: &str, rect: Result<Rect, CropError>, mode: &str) -> Result<Inspiration, CropError> {
    let rect = rect?;
    let mode = Mode::parse(mode)?;
    exclusive(false, || {
        let vault = crate::vault::get_vault_path(app).map_err(|e| {
            log::warn!(target: "Crop", "the library folder isn't available: {e}");
            CropError::Disk
        })?;
        let free = commands::is_free_plan(crate::bloot_hub::verified_plan());
        crop_with(&app.state::<AppState>().db, &vault, id, rect, mode, free)
    })
}

/// Bring back the first original of a picture cropped with Save. Returns the item
/// (`has_original` false). Errors: not_found, no_original, original_missing (nothing changes),
/// disk, changed.
#[tauri::command]
pub async fn restore_original(app: AppHandle, id: String) -> Result<Inspiration, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = exclusive(true, || restore_with(&app.state::<AppState>().db, &id));
        match &result {
            Ok(_) => {
                log::info!(target: "Crop", "restored the original of id={id}");
                crate::clip::wake();
            }
            Err(e) => log::warn!(target: "Crop", "restore_failed id={id} error={}", e.code()),
        }
        result.map_err(|e| e.code())
    })
    .await
    .map_err(|e| {
        log::error!(target: "Crop", "the restore task failed: {e}");
        CropError::Disk.code()
    })?
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    /// A library in a temp folder (the vault's folders) with a migrated in-memory database.
    struct Lib {
        dir: PathBuf,
        db: Mutex<Connection>,
    }

    impl Lib {
        fn new() -> Lib {
            let dir = std::env::temp_dir().join(format!("qooti-crop-test-{}", Uuid::new_v4()));
            crate::vault::ensure_structure(&dir).unwrap();
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
            crate::db::migrate(&conn).unwrap();
            Lib { dir, db: Mutex::new(conn) }
        }

        fn conn(&self) -> MutexGuard<'_, Connection> { lock(&self.db) }

        /// Save `img` as images/<id>.<ext> and add it as an item, the way an import leaves one.
        fn add(&self, id: &str, img: &DynamicImage, ext: &str) -> String {
            let path = self.dir.join("images").join(format!("{id}.{ext}"));
            img.save(&path).unwrap();
            self.add_file(id, &path)
        }

        fn add_file(&self, id: &str, path: &Path) -> String {
            let bytes = std::fs::read(path).unwrap();
            let (kind, mime) = match image::guess_format(&bytes) {
                Ok(ImageFormat::Gif) => ("gif", "image/gif"),
                Ok(f) => ("image", file_kind(f).1),
                Err(_) => ("image", "image/heic"),
            };
            let ratio = commands::image_aspect_ratio(&path.to_string_lossy()).unwrap_or(1.0);
            self.conn().execute(
                "INSERT INTO inspirations (id, type, title, source_url, source_platform, stored_path, file_hash,
                                           mime_type, aspect_ratio, palette, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'https://example.com/pin/1', 'pinterest', ?4, ?5, ?6, ?7, '[\"#ffffff\"]', 1000, 1000)",
                params![id, kind, format!("Title {id}"), path.to_string_lossy(), sha256_hex(&bytes), mime, ratio],
            ).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn crop(&self, id: &str, (x, y, w, h): (f64, f64, f64, f64), mode: Mode) -> Result<Inspiration, CropError> {
            crop_with(&self.db, &self.dir, id, Rect::from_page(x, y, w, h)?, mode, true)
        }

        fn text(&self, id: &str, column: &str) -> Option<String> {
            self.conn().query_row(&format!("SELECT {column} FROM inspirations WHERE id = ?1"), [id], |r| r.get(0)).unwrap()
        }

        fn count(&self, sql: &str) -> i64 {
            self.conn().query_row(sql, [], |r| r.get(0)).unwrap()
        }

        /// The file names in one of the library's folders, sorted.
        fn files(&self, folder: &str) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(self.dir.join(folder)).unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        }
    }

    impl Drop for Lib {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
    }

    const RED: Rgb<u8> = Rgb([255, 0, 0]);
    const BLUE: Rgb<u8> = Rgb([0, 0, 255]);

    /// 200×100: the left half red, the right half blue.
    fn halves() -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(200, 100, |x, _| if x < 100 { RED } else { BLUE }))
    }

    fn open(path: &str) -> DynamicImage { image::open(path).unwrap() }

    fn near(a: Rgb<u8>, b: Rgb<u8>) -> bool { a.0.iter().zip(b.0.iter()).all(|(x, y)| x.abs_diff(*y) < 40) }

    /// The palette JSON holds a colour close to `c` (the palette averages its buckets, so a few
    /// blended edge pixels can tint a colour slightly).
    fn has_colour(palette: Option<&str>, c: Rgb<u8>) -> bool {
        let colours: Vec<String> = palette.and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
        colours.iter().any(|hex| {
            let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(u32::MAX);
            let got = Rgb([(v >> 16) as u8, (v >> 8) as u8, v as u8]);
            got.0.iter().zip(c.0.iter()).all(|(x, y)| x.abs_diff(*y) <= 24)
        })
    }

    fn approx(a: Rect, b: (f64, f64, f64, f64)) -> bool {
        [(a.x, b.0), (a.y, b.1), (a.w, b.2), (a.h, b.3)].iter().all(|(p, q)| (p - q).abs() < 1e-9)
    }

    /// A JPEG of `img` with an EXIF block that holds `orientation`.
    fn jpeg_with_orientation(img: &RgbImage, orientation: u16) -> Vec<u8> {
        // TIFF header (little endian, first IFD at 8), one entry: 0x0112 Orientation, SHORT, 1 value
        let mut exif = vec![0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
                            0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00];
        exif.extend_from_slice(&orientation.to_le_bytes());
        exif.extend_from_slice(&[0, 0, 0, 0, 0, 0]);   // value padding, no next IFD
        let mut out = Vec::new();
        let mut enc = JpegEncoder::new_with_quality(&mut out, 95);
        enc.set_exif_metadata(exif).unwrap();
        enc.write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgb8).unwrap();
        out
    }

    #[test]
    fn crop_columns_exist_at_every_start() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        let all_there = || {
            ["original_path", "original_hash", "crop_rect"].iter().all(|c| {
                count(&format!("SELECT COUNT(*) FROM pragma_table_info('inspirations') WHERE name = '{c}'")) == 1
            }) && count("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_ins_original_hash'") == 1
        };
        assert!(all_there(), "a new library");

        // A library already at schema 36 without them (every 36 library before this change)
        conn.execute_batch(
            "DROP INDEX idx_ins_original_hash;
             ALTER TABLE inspirations DROP COLUMN original_path;
             ALTER TABLE inspirations DROP COLUMN original_hash;
             ALTER TABLE inspirations DROP COLUMN crop_rect;
             INSERT INTO inspirations (id, type, stored_path, created_at, updated_at) VALUES ('a', 'image', 'x.png', 0, 0);",
        ).unwrap();
        assert!(!all_there());
        crate::db::migrate(&conn).unwrap();
        assert!(all_there(), "back at the next start");
        assert_eq!(count("SELECT COUNT(*) FROM inspirations WHERE id = 'a' AND original_path IS NULL"), 1, "items survive");
        let version: String = conn.query_row("SELECT value FROM schema_meta WHERE key = 'version'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, "36", "no version bump");
        // And every start after that is a no-op
        crate::db::migrate(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        assert!(all_there());
    }

    #[test]
    fn pixel_rect_rounds_edges_and_clamps() {
        let r = Rect::from_page(0.1, 0.2, 0.5, 0.5).unwrap();
        assert_eq!(pixel_rect(r, 1000, 500), Ok((100, 100, 500, 250)));
        // A tiny overshoot past the edge (float rounding in the page) is clamped, not refused
        let r = Rect::from_page(0.3, 0.0, 0.7000001, 1.0).unwrap();
        assert!(r.x + r.w <= 1.0);
        assert_eq!(pixel_rect(r, 1000, 500), Ok((300, 0, 700, 500)));
        let r = Rect::from_page(-1e-9, 0.0, 0.5, 1.0).unwrap();
        assert_eq!(r.x, 0.0);
        // Edges are rounded, not sizes: two frames that meet share their edge
        let left = pixel_rect(Rect::from_page(0.0, 0.0, 0.3333, 1.0).unwrap(), 1000, 500).unwrap();
        let right = pixel_rect(Rect::from_page(0.3333, 0.0, 0.6667, 1.0).unwrap(), 1000, 500).unwrap();
        assert_eq!(left.0 + left.2, right.0);
        // Refused: negative, zero, not a number, outside the picture
        for (x, y, w, h) in [(-0.1, 0.0, 0.5, 0.5), (0.0, -0.2, 0.5, 0.5), (0.0, 0.0, 0.0, 0.5), (0.0, 0.0, 0.5, -0.2),
                             (f64::NAN, 0.0, 0.5, 0.5), (0.0, 0.0, f64::INFINITY, 0.5), (0.6, 0.0, 0.5, 0.5),
                             (0.0, 0.6, 0.5, 0.5), (1.0, 0.0, 0.1, 0.1), (0.0, 0.0, 1.1, 1.0)] {
            assert_eq!(Rect::from_page(x, y, w, h), Err(CropError::BadRect), "{x} {y} {w} {h}");
        }
        // 10 px wide on a 1000 px picture: too small (the floor is 16 px)
        assert_eq!(pixel_rect(Rect::from_page(0.0, 0.0, 0.01, 0.5).unwrap(), 1000, 500), Err(CropError::TooSmall));
        assert_eq!(pixel_rect(Rect::from_page(0.0, 0.0, 0.016, 0.5).unwrap(), 1000, 500), Ok((0, 0, 16, 250)));
        // The whole picture, also to under half a pixel: nothing to save
        assert_eq!(pixel_rect(Rect::FULL, 1000, 500), Err(CropError::NoChange));
        assert_eq!(pixel_rect(Rect::from_page(0.0002, 0.0, 0.9998, 1.0).unwrap(), 1000, 500), Err(CropError::NoChange));
        // Modes
        assert_eq!(Mode::parse("replace"), Ok(Mode::Replace));
        assert_eq!(Mode::parse("copy"), Ok(Mode::Copy));
        assert_eq!(Mode::parse("Replace"), Err(CropError::BadMode));
    }

    #[test]
    fn compose_maps_a_recrop_into_the_original() {
        let prev = Rect { x: 0.5, y: 0.0, w: 0.5, h: 1.0 };
        let r = Rect { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
        assert_eq!(prev.compose(r), Rect { x: 0.625, y: 0.25, w: 0.25, h: 0.5 });
        assert_eq!(Rect::FULL.compose(r), r);
        assert_eq!(r.compose(Rect::FULL), r);
        // Stored and read back as JSON {x, y, w, h}
        assert_eq!(Rect::parse(&r.to_json()), Some(r));
        assert_eq!(r.to_json(), r#"{"x":0.25,"y":0.25,"w":0.5,"h":0.5}"#);
        assert_eq!(Rect::parse(r#"{"x":0,"y":0,"w":0,"h":1}"#), None);
        assert_eq!(Rect::parse("nonsense"), None);
    }

    #[test]
    fn replace_keeps_the_first_original_and_resets_derived_data() {
        let lib = Lib::new();
        let first = lib.add("a", &halves(), "png");
        lib.add("b", &halves().crop_imm(0, 0, 150, 100), "png");
        let enhanced = lib.dir.join("images").join("a_enhanced.png");
        halves().save(&enhanced).unwrap();
        lib.conn().execute_batch(&format!(
            "UPDATE inspirations SET ocr_text = 'big sale', ocr_status = 'done', ocr_language = 'en',
                 phash = 'v3|x', phash_source = 'v3', auto_tag_sig = 'sig', auto_tag_status = 'done',
                 auto_tag_model = 'lens-1', lens_suggestions = '{{\"col:t1\":0.8,\"green_screen\":0.7}}',
                 auto_tag_confidence = '{{\"web_design\":0.4}}',
                 object_tags = 'box', object_status = 'done', enhanced_path = '{}'
             WHERE id = 'a';
             INSERT INTO clip_embeddings (id, model, emb) VALUES ('a', 'clip-b32-q8', x'00');
             INSERT INTO clip_frames (id, model, n, emb) VALUES ('a', 'clip-b32-q8', 0, x'');
             INSERT INTO duplicate_pairs (id, inspiration_id_a, inspiration_id_b, match_type, similarity_score, detected_at)
                 VALUES ('p', 'a', 'b', 'phash', 0.9, 0);
             INSERT INTO tags (id, name, source, created_at) VALUES ('t1', 'poster', 'user', 0);
             INSERT INTO inspiration_tags (inspiration_id, tag_id) VALUES ('a', 't1');
             INSERT INTO collections (id, name, created_at, updated_at) VALUES ('c1', 'Client', 0, 0);
             INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES ('c1', 'a', 0);",
            enhanced.to_string_lossy().replace('\'', "''"),
        )).unwrap();
        let first_hash = lib.text("a", "file_hash");

        let item = lib.crop("a", (0.0, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        assert_eq!(item.id, "a");
        assert!(item.has_original);
        let cut_path = item.stored_path.clone();
        let cut_file = Path::new(&cut_path);
        assert_eq!(cut_file.parent(), Some(lib.dir.join("images").as_path()), "in the library's images");
        assert!(cut_file.file_name().unwrap().to_string_lossy().starts_with("a_crop_"));
        let pixels = open(&cut_path);
        assert_eq!((pixels.width(), pixels.height()), (100, 100));
        assert!(near(pixels.to_rgb8().get_pixel(99, 50).to_owned(), RED));
        assert_eq!(item.aspect_ratio, 1.0);
        assert_eq!(item.file_hash.as_deref(), Some(sha256_hex(&std::fs::read(&cut_path).unwrap()).as_str()));
        assert_eq!(item.mime_type.as_deref(), Some("image/png"));
        assert!(has_colour(item.palette.as_deref(), RED), "colours of the cut: {:?}", item.palette);
        assert!(!has_colour(item.palette.as_deref(), BLUE) && !has_colour(item.palette.as_deref(), Rgb([255, 255, 255])));
        // The first original is kept, untouched
        assert_eq!(lib.text("a", "original_path").as_deref(), Some(first.as_str()));
        assert!(Path::new(&first).is_file());
        assert_eq!(lib.text("a", "original_hash"), first_hash);
        assert!(approx(Rect::parse(&lib.text("a", "crop_rect").unwrap()).unwrap(), (0.0, 0.0, 0.5, 1.0)));
        // What came from the old pixels is reset; the person's tags, answers and collections stay
        assert_eq!((item.ocr_text.as_str(), item.ocr_status.as_deref(), item.ocr_language.as_deref()), ("", None, None));
        assert_eq!((item.phash.as_deref(), item.phash_source.as_deref()), (None, None));
        assert_eq!((item.auto_tag_sig.as_deref(), item.auto_tag_status.as_deref(), item.auto_tag_model.as_deref()), (None, None, None));
        assert_eq!(item.lens_suggestions.as_deref(), Some(r#"{"col:t1":0.8}"#), "only the collection hint");
        assert_eq!(lib.text("a", "auto_tag_confidence").as_deref(), Some(r#"{"web_design":0.4}"#), "the old column is never written");
        assert_eq!((lib.text("a", "object_tags"), lib.text("a", "object_status")), (None, None));
        assert_eq!(item.enhanced_path, None);
        assert!(!enhanced.exists(), "the upscaled copy showed the old framing");
        assert_eq!(lib.count("SELECT COUNT(*) FROM clip_embeddings WHERE id = 'a'"), 0);
        assert_eq!(lib.count("SELECT COUNT(*) FROM clip_frames WHERE id = 'a'"), 0);
        assert_eq!(lib.count("SELECT COUNT(*) FROM duplicate_pairs"), 0);
        assert_eq!(lib.count("SELECT COUNT(*) FROM inspiration_tags WHERE inspiration_id = 'a'"), 1);
        assert_eq!(lib.count("SELECT COUNT(*) FROM collection_items WHERE inspiration_id = 'a'"), 1);
        assert!(item.updated_at > 1000);
        assert_eq!(item.created_at, 1000, "the Free window and taste order stay");
        // Re-indexed for search: the old OCR words don't match any more
        assert_eq!(lib.count("SELECT COUNT(*) FROM inspirations_fts WHERE inspirations_fts MATCH 'sale'"), 0);

        // Crop again: still cut from the first original. The in-between file is painted green to
        // prove it isn't the source; it is removed after the save
        DynamicImage::ImageRgb8(RgbImage::from_pixel(100, 100, Rgb([0, 255, 0]))).save(&cut_path).unwrap();
        let again = lib.crop("a", (0.5, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        assert_eq!(lib.text("a", "original_path").as_deref(), Some(first.as_str()), "the first original stays the original");
        assert_eq!(lib.text("a", "original_hash"), first_hash);
        assert!(!cut_file.exists(), "the in-between crop is removed");
        assert!(Path::new(&first).is_file());
        let pixels = open(&again.stored_path);
        assert_eq!((pixels.width(), pixels.height()), (50, 100));
        assert!(near(pixels.to_rgb8().get_pixel(0, 0).to_owned(), RED), "from the original, not the painted file");
        assert!(approx(Rect::parse(&lib.text("a", "crop_rect").unwrap()).unwrap(), (0.25, 0.0, 0.25, 1.0)));
        assert_eq!(again.aspect_ratio, 0.5);
        // The whole of what it shows now: nothing to save (judged on the cut, not the original)
        assert_eq!(lib.crop("a", (0.0, 0.0, 1.0, 1.0), Mode::Replace).err(), Some(CropError::NoChange));
        assert_eq!(lib.files("temp"), Vec::<String>::new(), "no part files left");
    }

    #[test]
    fn crop_applies_exif_orientation() {
        let lib = Lib::new();
        // Stored 40×20 with orientation 6 (turned 90° clockwise to show): shown 20×40. Its left
        // half (red) is the top half as shown
        let stored = RgbImage::from_fn(40, 20, |x, _| if x < 20 { RED } else { BLUE });
        let path = lib.dir.join("images").join("phone.jpg");
        std::fs::write(&path, jpeg_with_orientation(&stored, 6)).unwrap();
        let p = path.to_string_lossy().into_owned();
        assert_eq!(commands::image_aspect_ratio(&p), Some(0.5));
        lib.add_file("phone", &path);
        let ratio: f64 = lib.conn().query_row("SELECT aspect_ratio FROM inspirations WHERE id = 'phone'", [], |r| r.get(0)).unwrap();
        assert_eq!(ratio, 0.5, "stored with its shape as shown");

        let top = lib.crop("phone", (0.0, 0.0, 1.0, 0.5), Mode::Replace).unwrap();
        assert_eq!(top.aspect_ratio, 1.0);
        let pixels = open(&top.stored_path);
        assert_eq!((pixels.width(), pixels.height()), (20, 20));
        assert!(near(pixels.to_rgb8().get_pixel(10, 10).to_owned(), RED));
        assert_eq!(commands::image_aspect_ratio(&top.stored_path), Some(1.0), "the turn is in the pixels, no EXIF left");

        // A re-crop goes back to the turned original: its bottom half as shown is blue
        let restored = restore_with(&lib.db, "phone").unwrap();
        assert_eq!(restored.aspect_ratio, 0.5);
        let bottom = lib.crop("phone", (0.0, 0.5, 1.0, 0.5), Mode::Replace).unwrap();
        assert!(near(open(&bottom.stored_path).to_rgb8().get_pixel(10, 10).to_owned(), BLUE));
    }

    /// A lossless WebP of `img` in the extended format, with an EXIF chunk that holds `orientation`
    /// (as some phone and gallery converters write it).
    fn webp_with_orientation(img: &RgbImage, orientation: u16) -> Vec<u8> {
        let mut simple = Vec::new();
        WebPEncoder::new_lossless(&mut simple).write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgb8).unwrap();
        assert_eq!(&simple[12..16], b"VP8L");
        let mut tiff = vec![0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
                            0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00];
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        let mut body = b"WEBP".to_vec();
        body.extend_from_slice(b"VP8X");
        body.extend_from_slice(&10u32.to_le_bytes());
        body.extend_from_slice(&[0x08, 0, 0, 0]);                        // flags: an EXIF chunk follows
        body.extend_from_slice(&(img.width() - 1).to_le_bytes()[..3]);   // the canvas, minus one
        body.extend_from_slice(&(img.height() - 1).to_le_bytes()[..3]);
        body.extend_from_slice(&simple[12..]);                           // the VP8L chunk, padded
        body.extend_from_slice(b"EXIF");
        body.extend_from_slice(&(tiff.len() as u32).to_le_bytes());
        body.extend_from_slice(&tiff);
        let mut file = b"RIFF".to_vec();
        file.extend_from_slice(&(body.len() as u32).to_le_bytes());
        file.extend(body);
        file
    }

    #[test]
    fn a_webp_is_cut_as_the_window_shows_it() {
        let lib = Lib::new();
        // Stored 80×40 (left half red) with EXIF orientation 6. The window shows a WebP as stored,
        // whatever its EXIF says (a JPEG it turns: crop_applies_exif_orientation)
        let stored = RgbImage::from_fn(80, 40, |x, _| if x < 40 { RED } else { BLUE });
        let bytes = webp_with_orientation(&stored, 6);
        let mut dec = WebPDecoder::new(std::io::Cursor::new(&bytes)).unwrap();
        assert_eq!(dec.orientation().unwrap(), image::metadata::Orientation::Rotate90, "the file does carry the turn");
        let path = lib.dir.join("images").join("turned.webp");
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(commands::image_aspect_ratio(&path.to_string_lossy()), Some(2.0), "its shape as shown");
        lib.add_file("w", &path);

        // The top half as shown: an 80×20 strip, red on the left, blue on the right
        let top = lib.crop("w", (0.0, 0.0, 1.0, 0.5), Mode::Replace).unwrap();
        assert_eq!(top.aspect_ratio, 4.0);
        let pixels = open(&top.stored_path).to_rgb8();
        assert_eq!(pixels.dimensions(), (80, 20));
        assert!(near(*pixels.get_pixel(10, 10), RED) && near(*pixels.get_pixel(70, 10), BLUE));

        // Restore gives back its shape as shown, and a re-crop is cut the same way
        assert_eq!(restore_with(&lib.db, "w").unwrap().aspect_ratio, 2.0);
        let right = lib.crop("w", (0.5, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        let pixels = open(&right.stored_path).to_rgb8();
        assert_eq!(pixels.dimensions(), (40, 40));
        assert!(near(*pixels.get_pixel(20, 20), BLUE));
    }

    #[test]
    fn an_upscale_saved_while_cutting_is_removed_too() {
        let lib = Lib::new();
        lib.add("a", &halves(), "png");
        let item = read_item(&lib.conn(), "a").unwrap();
        assert_eq!(item.enhanced_path, None);
        let made = cut(&item, Rect::from_page(0.0, 0.0, 0.5, 1.0).unwrap()).unwrap();
        // Upscale finishes while the picture is being cut: its copy shows the old framing
        let upscaled = lib.dir.join("images").join("a_enhanced.png");
        halves().save(&upscaled).unwrap();
        lib.conn().execute("UPDATE inspirations SET enhanced_path = ?1 WHERE id = 'a'", [upscaled.to_string_lossy()]).unwrap();
        let cropped = replace(&lib.db, &lib.dir, &item, &made).unwrap();
        assert_eq!(cropped.enhanced_path, None);
        assert!(!upscaled.exists(), "no copy is left on disk with nothing pointing to it");

        // Restore: the copy the row has as the original comes back is the one removed
        let cut_upscaled = lib.dir.join("images").join("a_crop_enhanced.png");
        halves().save(&cut_upscaled).unwrap();
        lib.conn().execute("UPDATE inspirations SET enhanced_path = ?1 WHERE id = 'a'", [cut_upscaled.to_string_lossy()]).unwrap();
        let original = lib.text("a", "original_path").unwrap();
        let back = Restored { hash: "h".into(), ratio: 2.0, palette: None, mime: Some("image/png") };
        let at_write = commit_restore(&lib.conn(), "a", &cropped.stored_path, &original, &back).unwrap();
        assert_eq!(at_write.as_deref(), Some(&*cut_upscaled.to_string_lossy()));
        assert_eq!(lib.text("a", "enhanced_path"), None);
        // …and restore_with removes it (here it was already there when the item was read)
        let again = lib.crop("a", (0.0, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        lib.conn().execute("UPDATE inspirations SET enhanced_path = ?1 WHERE id = 'a'", [cut_upscaled.to_string_lossy()]).unwrap();
        restore_with(&lib.db, "a").unwrap();
        assert!(!cut_upscaled.exists());
        assert!(!Path::new(&again.stored_path).exists());

        // Each copy once, empty paths never
        assert_eq!(old_upscales(None, Some("b")), vec!["b"]);
        assert_eq!(old_upscales(Some("a"), Some("a")), vec!["a"]);
        assert_eq!(old_upscales(Some("a"), Some("b")), vec!["a", "b"]);
        assert_eq!(old_upscales(Some(""), None), Vec::<&str>::new());
        assert_eq!(old_upscales(None, None), Vec::<&str>::new());
    }

    #[test]
    fn formats_stay_the_same() {
        let lib = Lib::new();
        // JPEG → JPEG
        lib.add("jpg", &halves(), "jpg");
        let j = lib.crop("jpg", (0.0, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        assert!(j.stored_path.ends_with(".jpg"));
        assert_eq!(image::guess_format(&std::fs::read(&j.stored_path).unwrap()).unwrap(), ImageFormat::Jpeg);
        assert_eq!(j.mime_type.as_deref(), Some("image/jpeg"));

        // PNG with alpha keeps its alpha
        let alpha = DynamicImage::ImageRgba8(RgbaImage::from_fn(64, 64, |x, _| {
            if x < 32 { Rgba([0, 0, 0, 0]) } else { Rgba([0, 200, 0, 255]) }
        }));
        lib.add("alpha", &alpha, "png");
        let a = lib.crop("alpha", (0.0, 0.0, 0.75, 1.0), Mode::Replace).unwrap();
        let px = open(&a.stored_path);
        assert!(px.color().has_alpha());
        assert_eq!(px.to_rgba8().get_pixel(0, 0)[3], 0, "transparent stays transparent");
        assert_eq!(px.to_rgba8().get_pixel(47, 0)[3], 255);

        // A 16-bit PNG stays 16-bit
        let deep = DynamicImage::ImageRgb16(image::ImageBuffer::from_pixel(64, 64, Rgb([40000u16, 1000, 65535])));
        lib.add("deep", &deep, "png");
        let d = lib.crop("deep", (0.25, 0.25, 0.5, 0.5), Mode::Replace).unwrap();
        assert_eq!(open(&d.stored_path).color(), ColorType::Rgb16);

        // WebP → lossless WebP
        let web = DynamicImage::ImageRgb8(RgbImage::from_fn(64, 64, |x, y| Rgb([(x * 4) as u8, (y * 4) as u8, 90])));
        lib.add("web", &web, "webp");
        let w = lib.crop("web", (0.0, 0.0, 0.5, 0.5), Mode::Replace).unwrap();
        let bytes = std::fs::read(&w.stored_path).unwrap();
        assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::WebP);
        assert_eq!(&bytes[12..16], b"VP8L", "lossless");
        assert_eq!(w.mime_type.as_deref(), Some("image/webp"));
        let pixels = open(&w.stored_path).to_rgb8();
        assert_eq!(pixels.get_pixel(10, 20), web.to_rgb8().get_pixel(10, 20), "nothing lost");

        // Refused, with plain codes: GIFs, a GIF saved as a picture, a file this crate can't read
        // as a picture, a missing file, videos, unknown ids
        lib.add("gif", &DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 64, RED)), "gif");
        assert_eq!(lib.crop("gif", (0.0, 0.0, 0.5, 0.5), Mode::Replace).err(), Some(CropError::Unsupported));
        lib.conn().execute("UPDATE inspirations SET type = 'image' WHERE id = 'gif'", []).unwrap();
        assert_eq!(lib.crop("gif", (0.0, 0.0, 0.5, 0.5), Mode::Replace).err(), Some(CropError::Unsupported));
        let heic = lib.dir.join("images").join("photo.heic");
        std::fs::write(&heic, b"\0\0\0\x18ftypheic\0\0\0\0mif1heic").unwrap();
        lib.add_file("heic", &heic);
        assert_eq!(lib.crop("heic", (0.0, 0.0, 0.5, 0.5), Mode::Replace).err(), Some(CropError::Unsupported));
        let broken = lib.dir.join("images").join("broken.jpg");
        std::fs::write(&broken, [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1, 2, 3]).unwrap();
        lib.add_file("broken", &broken);
        assert_eq!(lib.crop("broken", (0.0, 0.0, 0.5, 0.5), Mode::Replace).err(), Some(CropError::Unreadable));
        lib.add("gone", &halves(), "png");
        std::fs::remove_file(lib.text("gone", "stored_path").unwrap()).unwrap();
        assert_eq!(lib.crop("gone", (0.0, 0.0, 0.5, 0.5), Mode::Replace).err(), Some(CropError::Unreadable));
        lib.conn().execute("INSERT INTO inspirations (id, type, stored_path, created_at, updated_at) VALUES ('clip', 'video', 'x.mp4', 0, 0)", []).unwrap();
        assert_eq!(lib.crop("clip", (0.0, 0.0, 0.5, 0.5), Mode::Replace).err(), Some(CropError::Unsupported));
        assert_eq!(lib.crop("nobody", (0.0, 0.0, 0.5, 0.5), Mode::Copy).err(), Some(CropError::NotFound));
        // Nothing was written for any of them
        assert_eq!(lib.files("temp"), Vec::<String>::new());
        assert_eq!(lib.files("images").iter().filter(|n| n.contains("_crop_")).count(), 4, "only the four crops above");
    }

    #[test]
    fn copy_goes_through_import() {
        let lib = Lib::new();
        lib.add("src", &halves(), "png");
        let lens_tag = {
            let conn = lib.conn();
            conn.execute_batch(
                "INSERT INTO concepts (id, lens_id, labels_json, media, vec, active, updated_at)
                     VALUES ('green_screen', 'motion', '{\"en\":\"Green screen\",\"uz\":\"Yashil ekran\"}', 'any', x'00', 1, 0);
                 INSERT INTO tags (id, name, source, created_at) VALUES ('u1', 'poster', 'user', 0);
                 INSERT INTO collections (id, name, created_at, updated_at) VALUES
                     ('c1', 'One', 1, 1), ('c2', 'Two', 2, 2), ('c3', 'Three', 3, 3), ('c4', 'Four', 4, 4);
                 INSERT INTO collection_items (collection_id, inspiration_id, created_at) VALUES
                     ('c1', 'src', 0), ('c4', 'src', 0);",
            ).unwrap();
            commands::tag_item(&conn, "src", "u1").unwrap();
            let gs = crate::tagging::ensure_concept_tag(&conn, "green_screen").unwrap();
            commands::tag_item(&conn, "src", &gs).unwrap();
            gs
        };
        let source_before: (String, Option<String>, i64) = lib.conn().query_row(
            "SELECT stored_path, file_hash, updated_at FROM inspirations WHERE id = 'src'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();

        let copy = lib.crop("src", (0.0, 0.0, 0.5, 1.0), Mode::Copy).unwrap();
        assert_ne!(copy.id, "src");
        assert!(!copy.has_original);
        assert_eq!(copy.title.as_deref(), Some("Title src"));
        assert_eq!(copy.source_url.as_deref(), Some("https://example.com/pin/1"));
        assert_eq!(copy.source_platform.as_deref(), Some("pinterest"));
        assert!(copy.created_at > 1000, "the newest item");
        assert_eq!(copy.aspect_ratio, 1.0);
        assert_eq!((open(&copy.stored_path).width(), open(&copy.stored_path).height()), (100, 100));
        assert_eq!(lib.text(&copy.id, "import_source").as_deref(), Some("crop_copy"));
        let tags_of = |id: &str| -> Vec<String> {
            lib.conn().prepare("SELECT tag_id FROM inspiration_tags WHERE inspiration_id = ?1 ORDER BY tag_id").unwrap()
                .query_map([id], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(tags_of(&copy.id), tags_of("src"), "same tags");
        assert!(tags_of(&copy.id).contains(&lens_tag) && tags_of(&copy.id).contains(&"u1".to_string()));
        assert_eq!(lib.count(&format!("SELECT COUNT(*) FROM tag_answers WHERE inspiration_id = '{}' AND answer = 'added'", copy.id)), 1,
                   "a lens tag goes through the answer path");
        assert_eq!(lib.count("SELECT count FROM tag_usage_counts WHERE tag_id = 'u1'"), 2);
        let cols = |id: &str| -> Vec<String> {
            lib.conn().prepare("SELECT collection_id FROM collection_items WHERE inspiration_id = ?1 ORDER BY collection_id").unwrap()
                .query_map([id], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        assert_eq!(cols(&copy.id), vec!["c1"], "the Free plan only reads c4, so the copy isn't added to it");
        assert_eq!(copy.collection_names.as_deref(), Some(r#"["One"]"#));
        let (a, b) = if copy.id.as_str() < "src" { (copy.id.clone(), "src".to_string()) } else { ("src".to_string(), copy.id.clone()) };
        assert_eq!(lib.count(&format!("SELECT COUNT(*) FROM ignored_dupes WHERE a = '{a}' AND b = '{b}'")), 1, "never offered as a duplicate");
        // The source is untouched
        let source_after: (String, Option<String>, i64) = lib.conn().query_row(
            "SELECT stored_path, file_hash, updated_at FROM inspirations WHERE id = 'src'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(source_after, source_before);
        assert!(!commands::load_inspiration(&lib.conn(), "src").unwrap().has_original);

        // The same frame again makes the same picture: already in the library, as the first copy
        assert_eq!(lib.crop("src", (0.0, 0.0, 0.5, 1.0), Mode::Copy).err(), Some(CropError::AlreadySaved(copy.id.clone())));
        assert_eq!(lib.files("temp"), Vec::<String>::new(), "no temp files left");

        // On Pro every collection takes the copy
        let pro = crop_with(&lib.db, &lib.dir, "src", Rect::from_page(0.5, 0.0, 0.5, 1.0).unwrap(), Mode::Copy, false).unwrap();
        assert_eq!(cols(&pro.id), vec!["c1", "c4"]);
        assert_eq!(lib.count("SELECT COUNT(*) FROM inspirations"), 3);
    }

    #[test]
    fn restore_brings_back_the_original() {
        let lib = Lib::new();
        let first = lib.add("a", &halves(), "png");
        let first_hash = lib.text("a", "file_hash");
        assert_eq!(restore_with(&lib.db, "a").err(), Some(CropError::NoOriginal), "never cropped");
        assert_eq!(restore_with(&lib.db, "nobody").err(), Some(CropError::NotFound));

        let cropped = lib.crop("a", (0.0, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        lib.conn().execute(r#"UPDATE inspirations SET ocr_text = 'words', ocr_status = 'done', auto_tag_sig = 'sig',
                              lens_suggestions = '{"col:t9":0.5,"poster":0.6}' WHERE id = 'a'"#, []).unwrap();
        let restored = restore_with(&lib.db, "a").unwrap();
        assert_eq!(restored.lens_suggestions.as_deref(), Some(r#"{"col:t9":0.5}"#), "the hint stays, the scores go");
        assert_eq!(restored.stored_path, first);
        assert!(!restored.has_original);
        assert_eq!((lib.text("a", "original_path"), lib.text("a", "original_hash"), lib.text("a", "crop_rect")), (None, None, None));
        assert!(!Path::new(&cropped.stored_path).exists(), "the cut file is removed");
        assert!(Path::new(&first).is_file());
        assert_eq!(restored.aspect_ratio, 2.0);
        assert_eq!(restored.file_hash, first_hash);
        assert!(has_colour(restored.palette.as_deref(), RED) && has_colour(restored.palette.as_deref(), BLUE),
                "colours of the whole picture: {:?}", restored.palette);
        assert_eq!(restored.mime_type.as_deref(), Some("image/png"));
        assert_eq!((restored.ocr_text.as_str(), restored.ocr_status.as_deref(), restored.auto_tag_sig.as_deref()), ("", None, None));
        assert_eq!(restore_with(&lib.db, "a").err(), Some(CropError::NoOriginal), "nothing more to restore");

        // The original's file gone: nothing changes
        let cropped = lib.crop("a", (0.25, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        std::fs::remove_file(&first).unwrap();
        assert_eq!(restore_with(&lib.db, "a").err(), Some(CropError::OriginalMissing));
        let still = commands::load_inspiration(&lib.conn(), "a").unwrap();
        assert_eq!(still.stored_path, cropped.stored_path);
        assert!(still.has_original);
        assert!(Path::new(&cropped.stored_path).is_file());
        // …and a re-crop is cut from the file it shows (the frame stays right)
        let recut = lib.crop("a", (0.0, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        assert_eq!((open(&recut.stored_path).width(), open(&recut.stored_path).height()), (50, 100));
        assert!(approx(Rect::parse(&lib.text("a", "crop_rect").unwrap()).unwrap(), (0.25, 0.0, 0.25, 1.0)));
        assert_eq!(lib.text("a", "original_path").as_deref(), Some(first.as_str()));
    }

    #[test]
    fn importing_the_original_again_finds_the_item() {
        let lib = Lib::new();
        let first = lib.add("a", &halves(), "png");
        lib.crop("a", (0.0, 0.0, 0.5, 1.0), Mode::Replace).unwrap();
        let outside = lib.dir.join("downloads");
        std::fs::create_dir_all(&outside).unwrap();
        let again = outside.join("same-picture.png");
        std::fs::copy(&first, &again).unwrap();
        let r = commands::import_one(&lib.db, &lib.dir, &again.to_string_lossy(), "file_import", &|_| (None, None)).unwrap();
        assert!(matches!(r, ImportOne::Existing(ref id) if id == "a"));
        assert_eq!(lib.count("SELECT COUNT(*) FROM inspirations"), 1);
    }

    #[test]
    fn a_changed_row_is_not_overwritten() {
        let lib = Lib::new();
        lib.add("a", &halves(), "png");
        let item = read_item(&lib.conn(), "a").unwrap();
        let made = cut(&item, Rect::from_page(0.0, 0.0, 0.5, 1.0).unwrap()).unwrap();
        // The item shows another file by the time the cut is saved
        lib.conn().execute("UPDATE inspirations SET stored_path = 'elsewhere.png' WHERE id = 'a'", []).unwrap();
        assert_eq!(replace(&lib.db, &lib.dir, &item, &made).err(), Some(CropError::Changed));
        assert_eq!(lib.text("a", "stored_path").as_deref(), Some("elsewhere.png"));
        assert_eq!(lib.text("a", "original_path"), None);
        // …or is gone
        lib.conn().execute("DELETE FROM inspirations WHERE id = 'a'", []).unwrap();
        assert_eq!(replace(&lib.db, &lib.dir, &item, &made).err(), Some(CropError::NotFound));
        assert_eq!(lib.files("images"), vec!["a.png"], "the new files were removed");
        assert_eq!(lib.files("temp"), Vec::<String>::new());
    }

    #[test]
    fn a_second_crop_waits_its_turn() {
        let held = CROP_LOCK.lock().unwrap();
        assert_eq!(exclusive(false, || Ok(())).err(), Some(CropError::Busy));
        drop(held);
        assert_eq!(exclusive(false, || Ok(7)), Ok(7));
        assert_eq!(exclusive(true, || Ok(8)), Ok(8));
    }

    #[test]
    fn error_codes_are_plain() {
        let codes: Vec<String> = [
            CropError::BadRect, CropError::BadMode, CropError::NotFound, CropError::Unsupported, CropError::Unreadable,
            CropError::TooBig, CropError::TooSmall, CropError::NoChange, CropError::Disk, CropError::Changed,
            CropError::Busy, CropError::AlreadySaved("x1".into()), CropError::NoOriginal, CropError::OriginalMissing,
        ].iter().map(|e| e.code()).collect();
        assert_eq!(codes, ["bad_rect", "bad_mode", "not_found", "unsupported", "unreadable", "too_big", "too_small",
                           "no_change", "disk", "changed", "busy", "already_saved:x1", "no_original", "original_missing"]);
        assert_eq!(only_collection_hints(Some(r#"{"col:a":0.7,"poster":0.9}"#)).as_deref(), Some(r#"{"col:a":0.7}"#));
        assert_eq!(only_collection_hints(Some(r#"{"poster":0.9}"#)), None);
        assert_eq!(only_collection_hints(Some("not json")), None);
        assert_eq!(only_collection_hints(None), None);
        assert_eq!(file_safe("3f2a-b_c"), "3f2a-b_c");
        assert_eq!(file_safe("../../x"), "x");
        assert_eq!(file_safe("/\\"), "item");
    }

    /// Crop on a COPY of a real library (never the live file). Every item's file is first pointed
    /// into a scratch folder, so nothing outside it is read, written or removed:
    /// QOOTI_DB_COPY=<copy of qooti.db> QOOTI_SCRATCH=<empty folder> cargo test --lib real_library_copy_crop -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library_copy_crop() {
        let copy = std::env::var("QOOTI_DB_COPY").expect("QOOTI_DB_COPY");
        let scratch = PathBuf::from(std::env::var("QOOTI_SCRATCH").expect("QOOTI_SCRATCH"));
        crate::vault::ensure_structure(&scratch).unwrap();
        let conn = Connection::open(&copy).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::db::migrate(&conn).unwrap();
        let s = scratch.to_string_lossy().into_owned();
        // Every file into the scratch folder (missing there), nothing kept or upscaled
        conn.execute(
            "UPDATE inspirations SET stored_path = ?1 || '/missing-' || id, thumbnail_path = NULL, enhanced_path = NULL,
                 original_path = NULL, original_hash = NULL, crop_rect = NULL",
            params![s],
        ).unwrap();
        // The JPEG with the most tags and collections, with a test picture of its shape
        let (id, ratio): (String, f64) = conn.query_row(
            "SELECT id, aspect_ratio FROM inspirations WHERE type = 'image' AND mime_type = 'image/jpeg'
             ORDER BY (SELECT COUNT(*) FROM inspiration_tags it WHERE it.inspiration_id = inspirations.id)
                    + (SELECT COUNT(*) FROM collection_items ci WHERE ci.inspiration_id = inspirations.id) DESC, id
             LIMIT 1",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        let (w, h) = if ratio >= 1.0 { (600, ((600.0 / ratio).round() as u32).max(64)) } else { (((600.0 * ratio).round() as u32).max(64), 600) };
        let file = scratch.join("images").join(format!("{id}.jpg"));
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128]))).save(&file).unwrap();
        conn.execute("UPDATE inspirations SET stored_path = ?2, file_hash = NULL WHERE id = ?1", params![id, file.to_string_lossy()]).unwrap();
        let outside = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM inspirations WHERE substr(stored_path, 1, ?2) != ?1
                    OR (original_path IS NOT NULL AND substr(original_path, 1, ?2) != ?1)
                    OR (enhanced_path IS NOT NULL AND substr(enhanced_path, 1, ?2) != ?1)",
                params![s, s.chars().count() as i64], |r| r.get(0)).unwrap()
        };
        assert_eq!(outside(&conn), 0, "every file is in the scratch folder");
        let tags_of = |conn: &Connection, id: &str| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM inspiration_tags WHERE inspiration_id = ?1", [id], |r| r.get(0)).unwrap()
        };
        let cols_of = |conn: &Connection, id: &str| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM collection_items WHERE inspiration_id = ?1", [id], |r| r.get(0)).unwrap()
        };
        let (tags, cols) = (tags_of(&conn, &id), cols_of(&conn, &id));
        let db = Mutex::new(conn);

        let cropped = crop_with(&db, &scratch, &id, Rect::from_page(0.1, 0.1, 0.5, 0.5).unwrap(), Mode::Replace, true).unwrap();
        assert!(cropped.has_original);
        assert!(cropped.stored_path.starts_with(&s));
        let copied = crop_with(&db, &scratch, &id, Rect::from_page(0.25, 0.25, 0.5, 0.5).unwrap(), Mode::Copy, true).unwrap();
        assert!(copied.stored_path.starts_with(&s));
        let (copy_tags, copy_cols) = {
            let conn = lock(&db);   // one guard: the mutex isn't re-entrant
            (tags_of(&conn, &copied.id), cols_of(&conn, &copied.id))
        };
        let restored = restore_with(&db, &id).unwrap();
        assert_eq!(restored.stored_path, file.to_string_lossy());
        assert!(!restored.has_original);
        assert!(!Path::new(&cropped.stored_path).exists());
        assert_eq!(outside(&lock(&db)), 0, "nothing points outside the scratch folder");
        println!("item {id} ({w}×{h}): tags {tags} → copy {copy_tags}; collections {cols} → copy {copy_cols} (Free: locked ones skipped)");
        assert_eq!(copy_tags, tags);
        assert!(copy_cols <= cols);
    }
}
