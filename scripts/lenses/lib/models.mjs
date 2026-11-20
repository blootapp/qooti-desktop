// CLIP ViT-B/32 (Xenova ONNX export) for the lens tools: pinned files, a local cache, the
// tokenizer, the q8 text encoder (lens build) and the q8 vision encoder (frame embedding).
//
// Files are fetched once from a pinned Hugging Face revision into <cache>/Xenova/clip-vit-base-patch32/
// and verified by SHA-256, then loaded with remote access switched off, so a later upstream
// change can never silently change concept vectors. The vision file is the one the app
// downloads (clip.rs MODEL_SHA256).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HF_CACHE } from './paths.mjs';

export const REPO = 'Xenova/clip-vit-base-patch32';
export const REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523';
export const TEXT_FILE = 'onnx/text_model_quantized.onnx';
export const VISION_FILE = 'onnx/vision_model_quantized.onnx';
export const TEMPLATE = 'This is a photo of {p}';
export const MAX_TOKENS = 77;

/** SHA-256 pins. The vision pin equals MODEL_SHA256 in src-tauri/src/clip.rs. */
export const PINS = {
  'config.json': '493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495',
  'tokenizer.json': 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd',
  'tokenizer_config.json': '60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967',
  [TEXT_FILE]: '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a',
  [VISION_FILE]: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
};

const TOKENIZER_FILES = ['tokenizer.json', 'tokenizer_config.json'];
const TEXT_FILES = ['config.json', ...TOKENIZER_FILES, TEXT_FILE];
const VISION_FILES = ['config.json', VISION_FILE];

export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export const modelDir = (cacheDir = HF_CACHE) => path.join(cacheDir, ...REPO.split('/'));
export const modelFile = (rel, cacheDir = HF_CACHE) => path.join(modelDir(cacheDir), ...rel.split('/'));

async function download(rel, dest) {
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${rel}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${rel}`);
  const out = fs.createWriteStream(part);
  const h = crypto.createHash('sha256');
  for await (const chunk of res.body) {
    h.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  return { part, sha: h.digest('hex') };
}

/**
 * Makes sure the given files are in the cache and match their pins. Downloads what's missing.
 * A file with a mismatching pin is an error (never used). Returns {rel: {path, sha256, size}}.
 */
export async function ensureFiles(files, cacheDir = HF_CACHE, { log = () => {}, offline = false } = {}) {
  const info = {};
  for (const rel of files) {
    const dest = modelFile(rel, cacheDir);
    const pin = PINS[rel];
    if (!fs.existsSync(dest)) {
      if (offline) throw new Error(`${rel} is not in the model cache ${cacheDir} (offline)`);
      log(`downloading ${REPO}/${rel} (revision ${REVISION.slice(0, 8)}) …`);
      const { part, sha } = await download(rel, dest);
      if (pin && sha !== pin) {
        fs.rmSync(part, { force: true });
        throw new Error(`${rel}: downloaded file sha256 ${sha} doesn't match the pin ${pin}`);
      }
      fs.renameSync(part, dest);
    }
    const sha = sha256File(dest);
    if (pin && sha !== pin) {
      throw new Error(`${rel}: cached file ${dest} has sha256 ${sha}, expected ${pin}. Delete it to re-download.`);
    }
    info[rel] = { path: dest, sha256: sha, size: fs.statSync(dest).size };
  }
  return info;
}

let T = null;
async function transformers(cacheDir) {
  if (!T) T = await import('@huggingface/transformers');
  T.env.allowRemoteModels = false;
  T.env.allowLocalModels = true;
  T.env.useFSCache = false;
  T.env.useBrowserCache = false;
  T.env.localModelPath = path.resolve(cacheDir).replace(/\\/g, '/') + '/';
  return T;
}

const tokenizers = new Map();
/** The real CLIP tokenizer. `count(text)` includes the start and end tokens (CLIP's 77 limit). */
export async function loadTokenizer(cacheDir = HF_CACHE, opts = {}) {
  if (tokenizers.has(cacheDir)) return tokenizers.get(cacheDir);
  await ensureFiles(TOKENIZER_FILES, cacheDir, opts);
  const t = await transformers(cacheDir);
  const tok = await t.AutoTokenizer.from_pretrained(REPO);
  const api = {
    encode: (text) => tok.encode(text),
    count: (text) => tok.encode(text).length,
    raw: tok,
  };
  tokenizers.set(cacheDir, api);
  return api;
}

/**
 * The q8 text encoder. `embed(text)` → Float64Array(512), L2-normalised. One prompt per run, no
 * padding: dynamic activation quantisation sees only that prompt's tokens, so a vector never
 * depends on what else is in a batch. One thread keeps runs bit-identical.
 */
export async function loadTextEncoder(cacheDir = HF_CACHE, opts = {}) {
  const files = await ensureFiles(TEXT_FILES, cacheDir, opts);
  const t = await transformers(cacheDir);
  const tok = await t.AutoTokenizer.from_pretrained(REPO);
  const model = await t.CLIPTextModelWithProjection.from_pretrained(REPO, {
    dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'all' },
  });
  return {
    files,
    textModel: `${REPO}@${REVISION} ${TEXT_FILE} sha256:${files[TEXT_FILE].sha256}`,
    tokens: (text) => tok.encode(text).length,
    async embed(text) {
      const inputs = tok([text], { padding: false, truncation: true, max_length: MAX_TOKENS });
      const out = await model(inputs);
      const d = out.text_embeds.data;
      if (d.length !== 512) throw new Error(`unexpected text embedding size ${d.length}`);
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      const n = Math.sqrt(s) || 1;
      const v = new Float64Array(512);
      for (let i = 0; i < 512; i++) v[i] = d[i] / n;
      return v;
    },
    dispose: () => model.dispose?.(),
  };
}

/**
 * The q8 vision encoder (same file as the app). `embed(pixels)` takes the CHW Float32Array from
 * image.mjs and returns an L2-normalised Float64Array(512).
 */
export async function loadVisionEncoder(cacheDir = HF_CACHE, opts = {}) {
  const files = await ensureFiles(VISION_FILES, cacheDir, opts);
  const t = await transformers(cacheDir);
  const model = await t.CLIPVisionModelWithProjection.from_pretrained(REPO, {
    dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: opts.threads || 2, interOpNumThreads: 1, graphOptimizationLevel: 'all' },
  });
  return {
    files,
    async embed(pixels) {
      const pixel_values = new t.Tensor('float32', pixels, [1, 3, 224, 224]);
      const out = await model({ pixel_values });
      const d = out.image_embeds.data;
      if (d.length !== 512) throw new Error(`unexpected image embedding size ${d.length}`);
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      const n = Math.sqrt(s) || 1;
      const v = new Float64Array(512);
      for (let i = 0; i < 512; i++) v[i] = d[i] / n;
      return v;
    },
    dispose: () => model.dispose?.(),
  };
}
