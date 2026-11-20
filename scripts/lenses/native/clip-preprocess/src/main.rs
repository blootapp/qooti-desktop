// clip-preprocess — the app's CLIP image decode + preprocessing, for the Node lens tools.
//
// The q8 vision model turns ±1-level pixel differences into cosines of ~0.985, and Node's JPEG
// decoder (libjpeg-turbo) differs from the app's (zune-jpeg via `image`) by about that much. With
// this helper Node feeds onnxruntime the exact tensor the app computes: measured on 60 library
// pictures, median cosine 1.0000 against the stored Rust vectors (vs 0.985 with sharp decoding).
//
// KEEP IN SYNC with `preprocess` and the decode in src-tauri/src/clip.rs.
//
//   clip-preprocess <out.bin> <image>...
// For each image, in order: one status byte (1 = ok, 0 = couldn't decode) followed by
// 3·224·224 little-endian f32 (CHW, CLIP-normalised; zeros when status is 0).
use std::io::Write;

const SIZE: u32 = 224;
const MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const STD: [f32; 3] = [0.268_629_54, 0.261_302_6, 0.275_777_1];

/// Verbatim from src-tauri/src/clip.rs.
fn preprocess(img: &image::DynamicImage) -> Vec<f32> {
    use image::imageops::FilterType;
    let (w, h) = (img.width().max(1), img.height().max(1));
    let scale = SIZE as f32 / w.min(h) as f32;
    let nw = ((w as f32 * scale).round() as u32).max(SIZE);
    let nh = ((h as f32 * scale).round() as u32).max(SIZE);
    // Big photos: a fast pre-shrink first so the bicubic pass stays cheap.
    let resized = if w.min(h) > SIZE * 4 {
        img.thumbnail(nw * 2, nh * 2).resize_exact(nw, nh, FilterType::CatmullRom)
    } else {
        img.resize_exact(nw, nh, FilterType::CatmullRom)
    }
    .to_rgb8();
    let (x0, y0) = ((nw - SIZE) / 2, (nh - SIZE) / 2);
    let plane = (SIZE * SIZE) as usize;
    let mut data = vec![0f32; 3 * plane];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let p = resized.get_pixel(x0 + x, y0 + y);
            let i = (y * SIZE + x) as usize;
            for c in 0..3 {
                data[c * plane + i] = (p[c] as f32 / 255.0 - MEAN[c]) / STD[c];
            }
        }
    }
    data
}

fn decode(path: &str) -> Result<image::DynamicImage, String> {
    image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: clip-preprocess <out.bin> <image>...");
        std::process::exit(2);
    }
    let file = std::fs::File::create(&args[1]).unwrap_or_else(|e| {
        eprintln!("can't create {}: {e}", args[1]);
        std::process::exit(1);
    });
    let mut out = std::io::BufWriter::new(file);
    let zeros = vec![0u8; 3 * (SIZE * SIZE) as usize * 4];
    for path in &args[2..] {
        match decode(path) {
            Ok(img) => {
                out.write_all(&[1]).unwrap();
                let mut bytes = Vec::with_capacity(zeros.len());
                for v in preprocess(&img) {
                    bytes.extend_from_slice(&v.to_le_bytes());
                }
                out.write_all(&bytes).unwrap();
            }
            Err(e) => {
                eprintln!("{path}: {e}");
                out.write_all(&[0]).unwrap();
                out.write_all(&zeros).unwrap();
            }
        }
    }
    out.flush().unwrap();
}
