// Object / content detection for keyword search (bilingual: English + Uzbek).
//
// Runs CLIP over each image ONCE — on import, and on a manual "Reindex" — via an efficient
// worker that embeds the whole vocabulary's text ONCE and then only does fast vector math
// per image (so a large vocab stays cheap). CLIP detects using the English label; the
// Uzbek word is stored alongside so a search in either language matches. Detected labels
// flow into the FTS index (see db.rs) → searching "box" OR "quti" finds images with a box,
// with zero analysis at search time.
//
// Mirrors the OCR pipeline: claim a batch → infer → finalize.

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { makeLogger } from './logger.js'
import { OBJECT_VOCAB } from './object-vocab.js'

const log = makeLogger('ObjectTags')

const BATCH_SIZE = 3
const THRESHOLD  = 0.22   // min cosine similarity to keep a label
const TOP_K      = 12      // max object labels stored per image

// CLIP prompts (English, grounded with a template); the worker embeds these once.
const PROMPTS = OBJECT_VOCAB.map(([en]) => `a photo of ${en}`)

// ─── Efficient CLIP worker (text embedded once, image dot-products per call) ───
let _worker = null, _reqCounter = 0, _vocabReady = null
const _pending = new Map()

function getWorker() {
  if (_worker) return _worker
  _worker = new Worker(new URL('../workers/clip-embed-worker.js', import.meta.url), { type: 'module' })
  _worker.onmessage = ({ data }) => {
    if (data.type === 'log') { log.debug('worker', { msg: data.msg }); return }
    const r = _pending.get(data.reqId)
    if (!r) return
    _pending.delete(data.reqId)
    if (data.type === 'error') r.reject(new Error(data.message))
    else r.resolve(data.scores)   // 'ready' → scores is undefined (fine)
  }
  _worker.onerror = () => {
    for (const [, r] of _pending) r.reject(new Error('Worker crashed'))
    _pending.clear(); _worker = null; _vocabReady = null
  }
  return _worker
}
function post(msg) {
  return new Promise((resolve, reject) => {
    const reqId = ++_reqCounter
    _pending.set(reqId, { resolve, reject })
    getWorker().postMessage({ ...msg, reqId })
  })
}
function ensureVocab() {
  if (!_vocabReady) _vocabReady = post({ type: 'setVocab', prompts: PROMPTS }).catch(e => { _vocabReady = null; throw e })
  return _vocabReady
}
async function detect(dataUrl) {
  await ensureVocab()
  return post({ type: 'infer', dataUrl })   // → scores[]
}

// ─── Per-item detection ───────────────────────────────────────────────────────
async function processOne(item) {
  let tags = '', status = 'done'
  try {
    const b64 = await api.readImageAsBase64(item.stored_path)
    const dataUrl = `data:${item.mime_type ?? 'image/jpeg'};base64,${b64}`
    const scores = await detect(dataUrl)

    const idx = []
    for (let i = 0; i < scores.length; i++) if (scores[i] >= THRESHOLD) idx.push(i)
    idx.sort((a, b) => scores[b] - scores[a])
    const kept = idx.slice(0, TOP_K)

    // Store both the English and Uzbek words so either language matches in search.
    tags = kept.map(i => OBJECT_VOCAB[i].join(' ')).join(' ')
    log.info('detected', { id: item.id, objects: kept.length })
  } catch (err) {
    log.error('inference_error', { id: item.id, error: String(err) })
    status = 'failed'
  }
  await api.finalizeObjectResult(item.id, tags, status)
    .catch(e => log.error('finalize_error', { id: item.id, error: String(e) }))
}

// ─── Drain loop ───────────────────────────────────────────────────────────────
// Processes all currently-pending items (new imports / reindexed), then stops. No idle
// polling — it only runs when triggered, matching the "on import only" choice.
let _running = false
async function drain() {
  if (_running) return
  _running = true
  try {
    while (true) {
      const batch = await api.claimObjectCandidates(BATCH_SIZE)
      if (!batch.length) break
      for (const item of batch) await processOne(item)
    }
  } catch (err) {
    log.error('drain_crashed', { error: String(err) })
  } finally {
    _running = false
  }
}

export function initObjectTags() {
  if (!('__TAURI_INTERNALS__' in window)) return
  // GRID_RELOAD fires on import and on the Settings "Reindex" — both are our triggers.
  // Existing items are marked 'skipped' by the migration, so this only picks up new
  // imports (and everything after a reindex). Cheap no-op when nothing is pending.
  store.on(events.GRID_RELOAD, () => drain())
  drain()   // finish anything left pending from a previous session
}
