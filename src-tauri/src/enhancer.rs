// AI image enhancer / upscaler (2×).
//
// Uses swin2SR-lightweight — a PSNR-oriented (non-GAN) super-resolution model, so it
// reconstructs detail *faithfully*: no hallucinated features, text and edges stay
// intact. The ~7.7 MB ONNX model is compiled into the binary; onnxruntime itself is
// statically linked (see Cargo.toml `ort`), so nothing ships as a loose file. A GPU
// execution provider (CoreML on macOS, DirectML on Windows) is used when available and
// falls back to CPU automatically.
//
// All inference runs OFF the UI thread: the `enhance_image` command dispatches the work
// to `spawn_blocking`, and a process-wide Mutex serialises runs (one image at a time).

use std::path::PathBuf;
use std::sync::Mutex;
use once_cell::sync::OnceCell;
use image::RgbImage;
use tauri::{AppHandle, Manager};
use crate::AppState;

static MODEL: &[u8] = include_bytes!("../models/swin2sr_x2.onnx");

const SCALE: u32    = 2;     // model output scale
const TILE: u32     = 256;   // core tile edge (source px) — bounds peak memory
const OVERLAP: u32  = 16;    // halo added around each tile so seams are invisible
const PAD: u32      = 8;     // swin2SR requires H and W to be multiples of this
const MAX_EDGE: u32 = 4000;  // refuse absurdly large sources (output would be 2×)

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

/// Run the model on one tile. Returns the 2× RGB output for the tile's real region.
fn run_tile(session: &mut ort::session::Session, tile: &RgbImage) -> Result<RgbImage, String> {
    use ort::value::Tensor;
    let (w, h) = (tile.width(), tile.height());
    let pw = ((w + PAD - 1) / PAD) * PAD;
    let ph = ((h + PAD - 1) / PAD) * PAD;

    // NCHW, RGB, 0-1; edge-replicate the right/bottom padding.
    let plane = (pw * ph) as usize;
    let mut data = vec![0f32; 3 * plane];
    for y in 0..ph {
        let sy = y.min(h - 1);
        for x in 0..pw {
            let sx = x.min(w - 1);
            let p = tile.get_pixel(sx, sy);
            let idx = (y * pw + x) as usize;
            data[idx]             = p[0] as f32 / 255.0;
            data[plane + idx]     = p[1] as f32 / 255.0;
            data[2 * plane + idx] = p[2] as f32 / 255.0;
        }
    }

    let input = Tensor::from_array((vec![1_i64, 3, ph as i64, pw as i64], data))
        .map_err(|e| e.to_string())?;
    let outputs = session
        .run(ort::inputs!["pixel_values" => input])
        .map_err(|e| e.to_string())?;
    let (_oshape, odata) = outputs["reconstruction"]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    // Output is [1, 3, ph*SCALE, pw*SCALE] — copy the real (unpadded) region.
    let ow = (pw * SCALE) as usize;
    let oplane = ow * (ph * SCALE) as usize;
    let (rw, rh) = (w * SCALE, h * SCALE);
    let mut out = RgbImage::new(rw, rh);
    for y in 0..rh {
        for x in 0..rw {
            let i = (y as usize) * ow + (x as usize);
            out.put_pixel(x, y, image::Rgb([
                (odata[i].clamp(0.0, 1.0) * 255.0).round() as u8,
                (odata[oplane + i].clamp(0.0, 1.0) * 255.0).round() as u8,
                (odata[2 * oplane + i].clamp(0.0, 1.0) * 255.0).round() as u8,
            ]));
        }
    }
    Ok(out)
}

/// Upscale a full image by tiling with a halo so tile seams are invisible.
fn enhance_rgb(img: &RgbImage) -> Result<RgbImage, String> {
    let session_m = get_session()?;
    let mut session = session_m.lock().map_err(|_| "enhancer busy".to_string())?;

    let (w, h) = (img.width(), img.height());
    let mut out = RgbImage::new(w * SCALE, h * SCALE);

    let mut y0 = 0;
    while y0 < h {
        let y1 = (y0 + TILE).min(h);
        let mut x0 = 0;
        while x0 < w {
            let x1 = (x0 + TILE).min(w);
            // Input region = core tile + halo (clamped to the image).
            let ix0 = x0.saturating_sub(OVERLAP);
            let iy0 = y0.saturating_sub(OVERLAP);
            let ix1 = (x1 + OVERLAP).min(w);
            let iy1 = (y1 + OVERLAP).min(h);

            let sub = image::imageops::crop_imm(img, ix0, iy0, ix1 - ix0, iy1 - iy0).to_image();
            let sr  = run_tile(&mut session, &sub)?;

            // Copy only the core [x0,x1)×[y0,y1) from this tile's SR output.
            let off_x = (x0 - ix0) * SCALE;
            let off_y = (y0 - iy0) * SCALE;
            for yy in 0..((y1 - y0) * SCALE) {
                for xx in 0..((x1 - x0) * SCALE) {
                    let p = sr.get_pixel(off_x + xx, off_y + yy);
                    out.put_pixel(x0 * SCALE + xx, y0 * SCALE + yy, *p);
                }
            }
            x0 = x1;
        }
        y0 = y1;
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
    #[test]
    fn upscales_2x() {
        let mut img = RgbImage::new(37, 22);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([(x.wrapping_mul(6)) as u8, (y.wrapping_mul(10)) as u8, 128]);
        }
        let out = enhance_rgb(&img).expect("enhance failed");
        assert_eq!(out.dimensions(), (74, 44), "output must be exactly 2× the input");
    }
}
