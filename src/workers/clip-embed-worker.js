// Efficient CLIP worker for object detection over a LARGE vocabulary.
//
// Unlike the zero-shot-image-classification pipeline (which re-encodes every candidate
// label's text on every image), this encodes the vocabulary's text embeddings ONCE
// (setVocab) and then, per image, only encodes the image + does fast cosine dot-products.
// That makes a 1000+ label vocabulary cheap (image encode + N·D multiplies).
//
// Messages in:  { type:'setVocab', reqId, prompts:[...] }  → { type:'ready', reqId }
//               { type:'infer',    reqId, dataUrl }         → { type:'result', reqId, scores:[...] }
// The `scores` array is cosine similarity per vocab entry (same order as prompts).

import {
  AutoTokenizer, CLIPTextModelWithProjection,
  AutoProcessor, CLIPVisionModelWithProjection,
  RawImage, env,
} from '@huggingface/transformers'

env.allowLocalModels  = false
env.allowRemoteModels = true
env.useBrowserCache   = true

const MODEL_ID = 'Xenova/clip-vit-base-patch32'

let tokenizer, textModel, processor, visionModel
let textEmb = null   // Float32Array, row-major [N × D], L2-normalized
let N = 0, D = 0

async function ensureModels() {
  if (visionModel) return
  self.postMessage({ type: 'log', msg: 'loading CLIP…' })
  tokenizer   = await AutoTokenizer.from_pretrained(MODEL_ID)
  textModel   = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID)
  processor   = await AutoProcessor.from_pretrained(MODEL_ID)
  visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID)
  self.postMessage({ type: 'log', msg: 'CLIP ready' })
}

function normalizeRows(arr, n, d) {
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = 0; j < d; j++) { const v = arr[i * d + j]; s += v * v }
    s = Math.sqrt(s) || 1
    for (let j = 0; j < d; j++) arr[i * d + j] /= s
  }
}

async function buildTextEmb(prompts) {
  const inputs = tokenizer(prompts, { padding: true, truncation: true })
  const out = await textModel(inputs)
  const t = out.text_embeds
  D = t.dims[t.dims.length - 1]
  N = prompts.length
  textEmb = Float32Array.from(t.data)   // [N × D]
  normalizeRows(textEmb, N, D)
}

async function embedImage(dataUrl) {
  const image  = await RawImage.read(dataUrl)
  const inputs = await processor(image)
  const out    = await visionModel(inputs)
  const v = Float32Array.from(out.image_embeds.data)  // [D]
  let s = 0
  for (let j = 0; j < D; j++) s += v[j] * v[j]
  s = Math.sqrt(s) || 1
  for (let j = 0; j < D; j++) v[j] /= s
  return v
}

self.onmessage = async ({ data }) => {
  const { type, reqId } = data
  try {
    if (type === 'setVocab') {
      await ensureModels()
      await buildTextEmb(data.prompts)
      self.postMessage({ type: 'ready', reqId })
    } else if (type === 'infer') {
      await ensureModels()
      if (!textEmb) throw new Error('vocab not set')
      const v = await embedImage(data.dataUrl)
      const scores = new Float32Array(N)
      for (let i = 0; i < N; i++) {
        let dot = 0
        const base = i * D
        for (let j = 0; j < D; j++) dot += textEmb[base + j] * v[j]
        scores[i] = dot
      }
      self.postMessage({ type: 'result', reqId, scores: Array.from(scores) })
    }
  } catch (err) {
    self.postMessage({ type: 'error', reqId, message: err?.message ?? String(err) })
  }
}
