// Dominant color palette extraction via median-cut quantization.
// Called on image import. Result stored as e.g. '["#1A2B3C","#D4E5F6"]'.

use anyhow::Result;
use std::path::Path;

pub fn extract_palette(image_path: &Path, max_colors: usize) -> Result<Vec<String>> {
    if max_colors == 0 { return Ok(vec![]); }

    let img  = image::open(image_path)?
        .resize(100, 100, image::imageops::FilterType::Triangle);
    let rgba = img.to_rgba8();

    let pixels: Vec<[u8; 3]> = rgba
        .pixels()
        .filter(|p| p[3] > 64)            // skip mostly-transparent
        .map(|p| [p[0], p[1], p[2]])
        .collect();

    if pixels.is_empty() { return Ok(vec![]); }

    // Median-cut: start with one bucket, repeatedly split the
    // bucket with the largest per-channel range at its median.
    let mut buckets: Vec<Vec<[u8; 3]>> = vec![pixels];

    while buckets.len() < max_colors {
        let Some(idx) = widest_bucket(&buckets) else { break };
        let bucket = buckets.remove(idx);
        let (a, b) = split(bucket);
        if a.is_empty() || b.is_empty() { break }
        buckets.push(a);
        buckets.push(b);
    }

    let hexes = buckets
        .into_iter()
        .filter(|b| !b.is_empty())
        .take(max_colors)
        .map(|b| {
            let [r, g, c] = avg(&b);
            format!("#{:02X}{:02X}{:02X}", r, g, c)
        })
        .collect();

    Ok(hexes)
}

// Index of the bucket with the largest color range across any channel.
fn widest_bucket(buckets: &[Vec<[u8; 3]>]) -> Option<usize> {
    buckets
        .iter()
        .enumerate()
        .map(|(i, b)| (i, channel_range(b)))
        .max_by_key(|&(_, r)| r)
        .map(|(i, _)| i)
}

fn channel_range(pixels: &[[u8; 3]]) -> u32 {
    let mut lo = [255u8; 3];
    let mut hi = [0u8; 3];
    for p in pixels {
        for c in 0..3 {
            lo[c] = lo[c].min(p[c]);
            hi[c] = hi[c].max(p[c]);
        }
    }
    (0..3).map(|c| (hi[c] - lo[c]) as u32).max().unwrap_or(0)
}

// Sort pixels by widest channel, split at median.
fn split(mut pixels: Vec<[u8; 3]>) -> (Vec<[u8; 3]>, Vec<[u8; 3]>) {
    let mut lo = [255u8; 3];
    let mut hi = [0u8; 3];
    for p in &pixels {
        for c in 0..3 {
            lo[c] = lo[c].min(p[c]);
            hi[c] = hi[c].max(p[c]);
        }
    }
    let channel = (0..3).max_by_key(|&c| (hi[c] - lo[c]) as u32).unwrap_or(0);
    pixels.sort_unstable_by_key(|p| p[channel]);
    let mid   = pixels.len() / 2;
    let right = pixels.split_off(mid);
    (pixels, right)
}

fn avg(pixels: &[[u8; 3]]) -> [u8; 3] {
    let n = pixels.len() as u64;
    let mut s = [0u64; 3];
    for p in pixels { for c in 0..3 { s[c] += p[c] as u64; } }
    [(s[0] / n) as u8, (s[1] / n) as u8, (s[2] / n) as u8]
}
