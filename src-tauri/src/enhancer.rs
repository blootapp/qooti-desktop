// AI image enhancer / upscaler (4×).
//
// Uses Real-ESRGAN general x4v3 — a perceptual (GAN) super-resolution model that visibly
// sharpens, denoises and reconstructs detail. (A swin2SR PSNR model was tried first but
// its output was near-indistinguishable from plain upscaling — not noticeable.) The
// ~4.7 MB ONNX model is compiled into the binary; onnxruntime itself is statically linked
// (see Cargo.toml `ort`), so nothing ships as a loose file. A GPU execution provider
// (CoreML on macOS, DirectML on Windows) is used when available and falls back to CPU.
//
// All inference runs OFF the UI thread: the `enhance_image` command dispatches the work
// to `spawn_blocking`, and a process-wide Mutex serialises runs (one image at a time).

use std::path::PathBuf;
use std::sync::Mutex;
use once_cell::sync::OnceCell;
use image::RgbImage;
use tauri::{AppHandle, Manager};
use crate::AppState;

static MODEL: &[u8] = include_bytes!("../models/realesr_x4.onnx");

const SCALE: u32    = 4;     // Real-ESRGAN general x4v3 output scale
const TILE_IN: u32  = 128;   // the model's FIXED input size (H = W = 128)
const HALO: u32     = 16;    // context margin around each core tile so seams vanish
const CORE: u32     = TILE_IN - 2 * HALO;  // 96 — real content advanced per tile
const MAX_EDGE: u32 = 1500;  // refuse large sources — enhancement is for low-res items;
                             // ×4 of anything bigger is huge/slow and pointless

static SESSION: OnceCell<Mutex<ort::session::Session>> = OnceCell::new();

/// Build (once) and cache the onnxruntime session with GPU→CPU execution providers.
fn get_session() -> Result<&'static Mutex<ort::session::Session>, String> {
    SESSION.get_or_try_init(|| {
        use ort::session::{Session, builder::GraphOptimizationLevel};
        use ort::execution_providers::CPUExecutionProvider;
        #[cfg(target_os = "macos")]   use ort::execution_providers::CoreMLExecutionProvider;
        #[cfg(target_os = "windows")] use ort::execution_providers::DirectMLExecutionProvider;

        let mut eps = Vec::new();
        #[cfg(target_os = "macos")]   eps.push(CoreMLExecutionProvider::default().build());
        #[cfg(target_os = "windows")] eps.push(DirectMLExecutionProvider::default().build());
        eps.push(CPUExecutionProvider::default().build());

        let session = Session::builder().map_err(|e| e.to_string())?
            .with_execution_providers(eps).map_err(|e| e.to_string())?
            .with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| e.to_string())?
            .commit_from_memory(MODEL).map_err(|e| e.to_string())?;
        log::info!(target: "Enhance", "onnxruntime session ready");
        Ok::<_, String>(Mutex::new(session))
    })
}

/// Run the model on one fixed 128×128 window whose top-left is (wx, wy) in image space
/// (edge-replicated outside the image). Returns the model's 512×512 (= 128·SCALE) output.
fn run_tile(session: &mut ort::session::Session, img: &RgbImage, wx: i64, wy: i64) -> Result<RgbImage, String> {
    use ort::value::Tensor;
    let (iw, ih) = (img.width() as i64, img.height() as i64);
    let n = TILE_IN as usize;
    let plane = n * n;
    let mut data = vec![0f32; 3 * plane];
    for by in 0..TILE_IN {
        let sy = (wy + by as i64).clamp(0, ih - 1) as u32;
        for bx in 0..TILE_IN {
            let sx = (wx + bx as i64).clamp(0, iw - 1) as u32;
            let p = img.get_pixel(sx, sy);
            let idx = (by * TILE_IN + bx) as usize;
            data[idx]             = p[0] as f32 / 255.0;
            data[plane + idx]     = p[1] as f32 / 255.0;
            data[2 * plane + idx] = p[2] as f32 / 255.0;
        }
    }

    let input = Tensor::from_array((vec![1_i64, 3, TILE_IN as i64, TILE_IN as i64], data))
        .map_err(|e| e.to_string())?;
    let outputs = session
        .run(ort::inputs!["image" => input])
        .map_err(|e| e.to_string())?;
    let (_oshape, odata) = outputs["upscaled_image"]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    let on = (TILE_IN * SCALE) as usize;
    let oplane = on * on;
    let mut out = RgbImage::new(TILE_IN * SCALE, TILE_IN * SCALE);
    for y in 0..(TILE_IN * SCALE) {
        for x in 0..(TILE_IN * SCALE) {
            let i = (y as usize) * on + (x as usize);
            out.put_pixel(x, y, image::Rgb([
                (odata[i].clamp(0.0, 1.0) * 255.0).round() as u8,
                (odata[oplane + i].clamp(0.0, 1.0) * 255.0).round() as u8,
                (odata[2 * oplane + i].clamp(0.0, 1.0) * 255.0).round() as u8,
            ]));
        }
    }
    Ok(out)
}

/// Upscale a full image by feeding fixed 128×128 windows (a 96-px core plus a 16-px halo
/// of context) to the model and stitching the 4× core regions, so tile seams are hidden.
fn enhance_rgb(img: &RgbImage) -> Result<RgbImage, String> {
    let session_m = get_session()?;
    let mut session = session_m.lock().map_err(|_| "enhancer busy".to_string())?;

    let (w, h) = (img.width(), img.height());
    let mut out = RgbImage::new(w * SCALE, h * SCALE);

    let mut cy = 0;
    while cy < h {
        let core_h = CORE.min(h - cy);
        let mut cx = 0;
        while cx < w {
            let core_w = CORE.min(w - cx);
            // 128 window placed so this tile's core sits at (HALO, HALO) inside it.
            let tile = run_tile(&mut session, img, cx as i64 - HALO as i64, cy as i64 - HALO as i64)?;
            let (ox, oy) = (HALO * SCALE, HALO * SCALE);
            for yy in 0..(core_h * SCALE) {
                for xx in 0..(core_w * SCALE) {
                    let p = tile.get_pixel(ox + xx, oy + yy);
                    out.put_pixel(cx * SCALE + xx, cy * SCALE + yy, *p);
                }
            }
            cx += CORE;
        }
        cy += CORE;
    }
    Ok(out)
}

/// Blocking worker (runs on a spawn_blocking thread).
fn enhance_impl(app: &AppHandle, id: &str) -> Result<String, String> {
    // Look up the source (images only).
    let (stored_path, typ, existing): (String, String, Option<String>) = {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.query_row(
            "SELECT stored_path, type, enhanced_path FROM inspirations WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|e| e.to_string())?
    };
    if typ != "image" {
        return Err("Only images can be enhanced".into());
    }
    // Already enhanced and the file is still present → return it as-is.
    if let Some(ep) = existing {
        if !ep.is_empty() && std::path::Path::new(&ep).exists() {
            return Ok(ep);
        }
    }

    let rgb = image::open(&stored_path).map_err(|e| format!("open failed: {e}"))?.to_rgb8();
    if rgb.width().max(rgb.height()) > MAX_EDGE {
        return Err("Image is already high-resolution".into());
    }
    log::info!(target: "Enhance", "enhancing id={id} {}x{}", rgb.width(), rgb.height());

    let out = enhance_rgb(&rgb)?;

    let src  = PathBuf::from(&stored_path);
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let enhanced = src.with_file_name(format!("{stem}_enhanced.png"));
    out.save(&enhanced).map_err(|e| format!("save failed: {e}"))?;
    let enhanced_str = enhanced.to_string_lossy().to_string();

    {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "UPDATE inspirations SET enhanced_path = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![enhanced_str, now, id],
        ).map_err(|e| e.to_string())?;
    }
    log::info!(target: "Enhance", "enhanced id={id} → {enhanced_str}");
    Ok(enhanced_str)
}

/// Enhance an image item. Heavy inference runs on a blocking thread so the UI never
/// stalls; returns the enhanced file's path.
#[tauri::command]
pub async fn enhance_image(app: AppHandle, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || enhance_impl(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercises the full native pipeline: session build (GPU→CPU EP), NCHW tensor I/O,
    // ×8 padding, tiling, and 2× output. Non-multiple-of-8 dims verify pad + crop.
    // Exercises the full native pipeline: session build (GPU→CPU EP), fixed 128 tiling,
    // stitching, and 4× output. Non-multiple dims verify the edge tiling + crop.
    #[test]
    fn upscales_4x() {
        let mut img = RgbImage::new(37, 22);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([(x.wrapping_mul(6)) as u8, (y.wrapping_mul(10)) as u8, 128]);
        }
        let out = enhance_rgb(&img).expect("enhance failed");
        assert_eq!(out.dimensions(), (148, 88), "output must be exactly 4× the input");
    }
}
