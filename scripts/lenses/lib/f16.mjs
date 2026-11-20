// IEEE-754 binary16 helpers: lens concept vectors and video frame vectors are stored as
// little-endian f16 (spec §2.2, §4: 512 values = 1024 bytes per vector).

const HAS_F16 = typeof DataView.prototype.setFloat16 === 'function';

/** Half-precision bits → number (exact). */
export function halfToNumber(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// Fallback encoder (round half to even, via f32 bits) for runtimes without setFloat16.
const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
function numberToHalfFallback(v) {
  f32buf[0] = v;
  const x = u32buf[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (half & 1))) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;
  return sign | half;
}

/** Numbers → f16 little-endian bytes. */
export function encodeF16(values) {
  const out = new Uint8Array(values.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    if (HAS_F16) dv.setFloat16(i * 2, values[i], true);
    else dv.setUint16(i * 2, numberToHalfFallback(values[i]), true);
  }
  return out;
}

/** f16 little-endian bytes → Float64Array (exact values). */
export function decodeF16(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length % 2) throw new Error('f16 data has an odd byte length');
  const n = b.length / 2;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = halfToNumber(b[2 * i] | (b[2 * i + 1] << 8));
  return out;
}

export const toBase64 = (bytes) => Buffer.from(bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes).toString('base64');
export const fromBase64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));

/** Strict base64 check (standard alphabet, padded) so a corrupted `vec` can't decode "successfully". */
export function isStrictBase64(s) {
  return typeof s === 'string' && s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

/** f32 little-endian blob (clip_embeddings.emb) → Float64Array. */
export function decodeF32(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length % 4) throw new Error('f32 data has a bad byte length');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float64Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** Returns a new L2-normalised Float64Array (zero vectors stay zero). */
export function normalize(v) {
  const n = l2norm(v);
  const out = new Float64Array(v.length);
  if (n > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
