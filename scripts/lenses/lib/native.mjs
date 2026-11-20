// The native clip-preprocess helper (scripts/lenses/native/clip-preprocess): the app's exact image
// decode + CLIP preprocessing, so Node embeds the very tensor the Rust indexer would.
// Built once with cargo (offline, from the crates src-tauri already uses) into the eval folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EVAL_DIR } from './paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CRATE_DIR = path.resolve(here, '..', 'native', 'clip-preprocess');
export const TARGET_DIR = path.join(EVAL_DIR, 'native-target');
const EXE = process.platform === 'win32' ? 'clip-preprocess.exe' : 'clip-preprocess';
const TENSOR = 3 * 224 * 224;

export function helperPath() {
  if (process.env.CLIP_PREPROCESS && fs.existsSync(process.env.CLIP_PREPROCESS)) return process.env.CLIP_PREPROCESS;
  const p = path.join(TARGET_DIR, 'release', EXE);
  return fs.existsSync(p) ? p : null;
}

/** Builds the helper (cargo build --release --offline). Returns its path or throws. */
export function buildHelper({ log = console.log } = {}) {
  log(`building clip-preprocess (cargo, offline) into ${TARGET_DIR.replace(/\\/g, '/')} …`);
  const r = spawnSync('cargo', ['build', '--release', '--offline', '--manifest-path', path.join(CRATE_DIR, 'Cargo.toml')], {
    env: { ...process.env, CARGO_TARGET_DIR: TARGET_DIR }, encoding: 'utf8', windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`cargo build failed:\n${(r.stderr || r.error?.message || '').slice(-1500)}`);
  const p = helperPath();
  if (!p) throw new Error('cargo finished but the helper is missing');
  return p;
}

/** The helper's path, building it when missing. null when it can't be built (caller falls back). */
export function ensureHelper({ log = console.log, build = true } = {}) {
  const p = helperPath();
  if (p || !build) return p;
  try { return buildHelper({ log }); } catch (e) { log(`  clip-preprocess unavailable: ${e.message.split('\n')[0]}`); return null; }
}

function readTensors(out, n) {
  const buf = fs.readFileSync(out);
  const per = 1 + TENSOR * 4;
  if (buf.length !== per * n) throw new Error('clip-preprocess wrote an unexpected size');
  const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  return Array.from({ length: n }, (_, i) => {
    const off = i * per;
    if (buf[off] !== 1) return null;
    const start = buf.byteOffset + off + 1;
    if (le) return new Float32Array(buf.buffer.slice(start, start + TENSOR * 4));   // aligned copy
    const t = new Float32Array(TENSOR);
    const dv = new DataView(buf.buffer, start, TENSOR * 4);
    for (let k = 0; k < TENSOR; k++) t[k] = dv.getFloat32(k * 4, true);
    return t;
  });
}

/**
 * Decode + preprocess image files with the app's code. Returns one Float32Array(3·224·224) per
 * file, or null for a file that couldn't be decoded.
 */
export function rustTensors(helper, files) {
  if (!files.length) return [];
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clip-pre-')), 'tensors.bin');
  try {
    const r = spawnSync(helper, [out, ...files], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
    if (r.status !== 0) throw new Error(`clip-preprocess failed: ${(r.stderr || r.error?.message || '').slice(-500)}`);
    return readTensors(out, files.length);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

/** Same as rustTensors without blocking the event loop (parallel ffmpeg workers keep draining). */
export async function rustTensorsAsync(helper, files) {
  if (!files.length) return [];
  const { spawn } = await import('node:child_process');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clip-pre-')), 'tensors.bin');
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(helper, [out, ...files], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      child.on('error', () => resolve(-1));
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error(`clip-preprocess failed (exit ${code})`);
    return readTensors(out, files.length);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}
