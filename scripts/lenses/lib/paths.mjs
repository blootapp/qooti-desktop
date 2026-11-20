// Default locations shared by the lens tools. Every one can be overridden on the command line.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The worktree root (…/qooti-redesign). */
export const ROOT = path.resolve(here, '..', '..', '..');
/** Lens sources the owner edits. */
export const SRC_DIR = path.join(ROOT, 'lenses', 'src');
/** Publish copies + the catalogue index. */
export const DIST_DIR = path.join(ROOT, 'lenses', 'dist');
/** Bundled copies that Rust embeds with include_str!. */
export const BUNDLED_DIR = path.join(ROOT, 'src-tauri', 'lenses');
/** The ffmpeg the app bundles (Windows build). */
export const FFMPEG = path.join(ROOT, 'src-tauri', 'binaries',
  process.platform === 'win32' ? 'ffmpeg-x86_64-pc-windows-msvc.exe'
    : process.platform === 'darwin' ? 'ffmpeg-aarch64-apple-darwin' : 'ffmpeg-x86_64-unknown-linux-gnu');

/** Private evaluation kit, outside git (DB copy, frames, judge sheets, judgments). */
export const EVAL_DIR = process.env.QOOTI_TAG_EVAL || 'E:/DP 2/qooti-tag-eval';
export const HF_CACHE = path.join(EVAL_DIR, 'hf-cache');
export const DB_COPY = path.join(EVAL_DIR, 'db', 'qooti-copy.db');
export const FRAMES_DIR = path.join(EVAL_DIR, 'frames');
export const FRAME_VECTORS = path.join(FRAMES_DIR, 'frame-vectors.json');
export const PREVIEWS_DIR = path.join(EVAL_DIR, 'previews');
export const JUDGMENTS_DIR = path.join(EVAL_DIR, 'judgments');
export const RUNS_DIR = path.join(EVAL_DIR, 'runs');

/** Forward slashes everywhere in printed paths (Windows tools accept them). */
export const slash = (p) => String(p).replace(/\\/g, '/');
