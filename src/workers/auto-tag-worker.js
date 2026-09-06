// CLIP inference worker — runs off the main thread so the UI never freezes.
// Receives { type:'infer', reqId, dataUrl, prompts, clearCache } messages.
// Responds with { type:'result', reqId, results } or { type:'error', reqId, message }.

import { pipeline, env } from '@huggingface/transformers'

env.allowLocalModels  = false
env.allowRemoteModels = true
env.useBrowserCache   = true

const MODEL_ID = 'Xenova/clip-vit-base-patch32'
let clf = null

async function ensureModel(clearCache) {
  if (clf) return

  if (clearCache && typeof caches !== 'undefined') {
    await caches.delete('transformers-cache').catch(() => {})
    self.postMessage({ type: 'log', msg: 'cleared stale model cache' })
  }

  self.postMessage({ type: 'log', msg: 'loading model…' })
  clf = await pipeline('zero-shot-image-classification', MODEL_ID, {
    progress_callback: info => {
      if (info.status === 'downloading' && info.total) {
        const pct = Math.round((info.loaded / info.total) * 100)
        self.postMessage({ type: 'log', msg: `model download ${pct}%` })
      }
    },
  })
  self.postMessage({ type: 'log', msg: 'model ready' })
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'infer') return
  const { reqId, dataUrl, prompts, clearCache } = data
  try {
    await ensureModel(clearCache)
    const results = await clf(dataUrl, prompts, { multi_label: true })
    self.postMessage({ type: 'result', reqId, results })
  } catch (err) {
    self.postMessage({ type: 'error', reqId, message: err.message })
  }
}
