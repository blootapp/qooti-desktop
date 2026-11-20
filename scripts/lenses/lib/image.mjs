// Image → CLIP pixel tensor, mirroring src-tauri/src/clip.rs `preprocess` as closely as Node
// allows: decode (sharp/libvips; no colour transform, no EXIF rotation, alpha dropped without
// compositing, like the Rust `image` crate) → short side to 224 with the image-crate 0.25
// resampler ported below (box pre-shrink for big pictures, then Catmull-Rom) → centre crop
// 224×224 → (x/255 − mean)/std, channel-first.
//
// Video frames from ffmpeg already have a 224 px short side, so for them this is a pure crop
// (the image crate copies instead of resampling when the size doesn't change).

export const SIZE = 224;
export const MEAN = [0.48145466, 0.4578275, 0.40821073];
export const STD = [0.26862954, 0.26130258, 0.27577711];

let sharpMod = null;
async function getSharp() {
  if (!sharpMod) sharpMod = (await import('sharp')).default;
  return sharpMod;
}

/**
 * Decodes the first frame of an image file (or an encoded buffer) into packed RGB bytes.
 * @returns {Promise<{data: Uint8Array, width: number, height: number, hadAlpha: boolean, icc: boolean}>}
 */
export async function decodeRGB(input) {
  const sharp = await getSharp();
  const img = sharp(input, { pages: 1, failOn: 'none', limitInputPixels: false });
  const meta = await img.metadata();
  const { data, info } = await img.keepIccProfile().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const n = width * height;
  let rgb;
  if (channels === 3) {
    rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      if (channels === 1 || channels === 2) {
        const g = data[i * channels];
        rgb[i * 3] = g; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = g;
      } else {
        rgb[i * 3] = data[i * channels];
        rgb[i * 3 + 1] = data[i * channels + 1];
        rgb[i * 3 + 2] = data[i * channels + 2];
      }
    }
  }
  return { data: rgb, width, height, hadAlpha: channels === 2 || channels === 4, icc: !!meta.icc };
}

// ── image 0.25 resampling, ported (src/imageops/sample.rs) ─────────────────────────────────

function catmullRom(x) {
  // bc_cubic_spline(x, b = 0, c = 0.5)
  const a = Math.abs(x);
  let k;
  if (a < 1) k = 9 * a ** 3 - 15 * a ** 2 + 6;
  else if (a < 2) k = -3 * a ** 3 + 15 * a ** 2 - 24 * a + 12;
  else k = 0;
  return k / 6;
}

const f = Math.fround;

function weightsFor(srcLen, dstLen) {
  const ratio = f(srcLen / dstLen);
  const sratio = ratio < 1 ? 1 : ratio;
  const support = f(2 * sratio);
  const rows = [];
  for (let o = 0; o < dstLen; o++) {
    let input = f(f(o + 0.5) * ratio);
    let left = Math.floor(input - support);
    left = Math.min(Math.max(left, 0), srcLen - 1);
    let right = Math.ceil(input + support);
    right = Math.min(Math.max(right, left + 1), srcLen);
    input = f(input - 0.5);
    const ws = [];
    let sum = 0;
    for (let i = left; i < right; i++) {
      const w = f(catmullRom(f(f(i - input) / sratio)));
      ws.push(w);
      sum = f(sum + w);
    }
    for (let j = 0; j < ws.length; j++) ws[j] = f(ws[j] / sum);
    rows.push({ left, ws });
  }
  return rows;
}

/** imageops::resize(.., CatmullRom): vertical pass to f32, then horizontal pass rounded to u8. */
export function resizeCatmullRom(img, nw, nh) {
  const { data, width: w, height: h } = img;
  if (nw === w && nh === h) return { data: Uint8Array.from(data), width: w, height: h };
  // Vertical: (w × h) u8 → (w × nh) f32, no rounding.
  const vrows = weightsFor(h, nh);
  const tmp = new Float32Array(w * nh * 3);
  for (let oy = 0; oy < nh; oy++) {
    const { left, ws } = vrows[oy];
    for (let x = 0; x < w; x++) {
      let t0 = 0, t1 = 0, t2 = 0;
      for (let k = 0; k < ws.length; k++) {
        const p = ((left + k) * w + x) * 3;
        t0 = f(t0 + f(data[p] * ws[k]));
        t1 = f(t1 + f(data[p + 1] * ws[k]));
        t2 = f(t2 + f(data[p + 2] * ws[k]));
      }
      const q = (oy * w + x) * 3;
      tmp[q] = t0; tmp[q + 1] = t1; tmp[q + 2] = t2;
    }
  }
  // Horizontal: (w × nh) f32 → (nw × nh) u8, clamp then round half away from zero.
  const hrows = weightsFor(w, nw);
  const out = new Uint8Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let ox = 0; ox < nw; ox++) {
      const { left, ws } = hrows[ox];
      let t0 = 0, t1 = 0, t2 = 0;
      for (let k = 0; k < ws.length; k++) {
        const p = (y * w + left + k) * 3;
        t0 = f(t0 + f(tmp[p] * ws[k]));
        t1 = f(t1 + f(tmp[p + 1] * ws[k]));
        t2 = f(t2 + f(tmp[p + 2] * ws[k]));
      }
      const q = (y * nw + ox) * 3;
      out[q] = Math.round(Math.min(Math.max(t0, 0), 255));
      out[q + 1] = Math.round(Math.min(Math.max(t1, 0), 255));
      out[q + 2] = Math.round(Math.min(Math.max(t2, 0), 255));
    }
  }
  return { data: out, width: nw, height: nh };
}

/** DynamicImage::thumbnail(nw, nh): fit inside (aspect kept), integer block average. */
export function thumbnail(img, boxW, boxH) {
  const { data, width: w, height: h } = img;
  const ratio = Math.min(boxW / w, boxH / h);
  const tw = Math.max(Math.round(w * ratio), 1);
  const th = Math.max(Math.round(h * ratio), 1);
  const xr = f(w / tw), yr = f(h / th);
  const out = new Uint8Array(tw * th * 3);
  for (let oy = 0; oy < th; oy++) {
    const bottomf = f(oy * yr), topf = f(bottomf + yr);
    const bottom = Math.min(Math.max(Math.ceil(bottomf), 0), h - 1);
    const top = Math.min(Math.max(Math.ceil(topf), bottom), h);
    for (let ox = 0; ox < tw; ox++) {
      const leftf = f(ox * xr), rightf = f(leftf + xr);
      const left = Math.min(Math.max(Math.ceil(leftf), 0), w - 1);
      const right = Math.min(Math.max(Math.ceil(rightf), left), w);
      const q = (oy * tw + ox) * 3;
      if (bottom === top || left === right) {
        // Only reachable when enlarging; preprocess never asks for that. Nearest pixel.
        const p = (Math.min(bottom, h - 1) * w + Math.min(left, w - 1)) * 3;
        out[q] = data[p]; out[q + 1] = data[p + 1]; out[q + 2] = data[p + 2];
        continue;
      }
      let s0 = 0, s1 = 0, s2 = 0;
      for (let y = bottom; y < top; y++) {
        for (let x = left; x < right; x++) {
          const p = (y * w + x) * 3;
          s0 += data[p]; s1 += data[p + 1]; s2 += data[p + 2];
        }
      }
      const n = (right - left) * (top - bottom);
      const r = Math.floor(n / 2);
      out[q] = Math.min(255, Math.floor((s0 + r) / n));
      out[q + 1] = Math.min(255, Math.floor((s1 + r) / n));
      out[q + 2] = Math.min(255, Math.floor((s2 + r) / n));
    }
  }
  return { data: out, width: tw, height: th };
}

/** The (nw, nh) clip.rs resizes to: short side 224, f32 maths like Rust. */
export function targetSize(w, h) {
  const W = Math.max(w, 1), H = Math.max(h, 1);
  const scale = f(SIZE / Math.min(W, H));
  const nw = Math.max(Math.round(f(W * scale)), SIZE);
  const nh = Math.max(Math.round(f(H * scale)), SIZE);
  return [nw, nh];
}

/** Centre-crops 224×224 from packed RGB and normalises to a CHW Float32Array. */
export function cropNormalize(img) {
  const { data, width: w, height: h } = img;
  if (w < SIZE || h < SIZE) throw new Error(`image smaller than ${SIZE}px after resize (${w}×${h})`);
  const x0 = Math.floor((w - SIZE) / 2), y0 = Math.floor((h - SIZE) / 2);
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = ((y0 + y) * w + (x0 + x)) * 3;
      const i = y * SIZE + x;
      for (let c = 0; c < 3; c++) out[c * plane + i] = (data[p + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return out;
}

/** clip.rs `preprocess`, ported: pre-shrink big pictures, Catmull-Rom to short side 224, crop. */
export function preprocessRust(img) {
  const [nw, nh] = targetSize(img.width, img.height);
  let src = img;
  if (Math.min(img.width, img.height) > SIZE * 4) src = thumbnail(img, nw * 2, nh * 2);
  return cropNormalize(resizeCatmullRom(src, nw, nh));
}

/** Alternative path: let libvips resize (kernel 'cubic' = Catmull-Rom, or 'lanczos3'), then crop. */
export async function preprocessSharp(input, kernel = 'cubic') {
  const sharp = await getSharp();
  const img = await decodeRGB(input);
  const [nw, nh] = targetSize(img.width, img.height);
  const { data, info } = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize(nw, nh, { kernel, fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  return cropNormalize({ data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height });
}
