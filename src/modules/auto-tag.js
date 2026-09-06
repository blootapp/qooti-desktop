// Auto-tag pipeline: claims batches of untagged images, runs CLIP inference via
// a Web Worker (transformers.js), writes confidence scores back to the DB.
//
// The worker runs off the main thread so WASM/ONNX computation never freezes the UI.
//
// Multilingual design: canonical English tag IDs (e.g. "minimal") are stored in
// the DB and in auto_tag_confidence. Display names are resolved at render time
// through getTagLabel() so the same tag shows as "minimal" in English and
// "minimalistik" in Uzbek — same DB record, same filter, different label.

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { currentLang } from './i18n.js'
import { makeLogger } from './logger.js'
import { getSetting } from './settings.js'

const log = makeLogger('AutoTag')

const MODEL_NAME = 'clip-vit-base-patch32'
const THRESHOLD  = 0.22   // minimum cosine similarity to surface a tag
const TOP_K      = 5      // max suggestions shown per image
const BATCH_SIZE = 4      // images claimed at once
const IDLE_MS    = 12_000 // poll interval when queue is empty

// Version tag — bump to invalidate the browser model cache after a library upgrade.
const CACHE_VERSION  = 'hf-v3.2'
const CACHE_VER_KEY  = '__auto_tag_cache_ver'

// Vocab loaded from DB — rebuilt each batch so edits take effect without restart
let VOCAB = []
const ALL_PROMPTS  = []
const PROMPT_TO_ID = {}

async function reloadVocab() {
  try {
    const entries = await api.listTagVocab()
    VOCAB = entries.map(e => ({
      id:      e.id,
      prompts: JSON.parse(e.prompts_json || '[]'),
      labels:  JSON.parse(e.labels_json  || '{}'),
    }))
  } catch {
    VOCAB = []
  }
  ALL_PROMPTS.length = 0
  for (const k of Object.keys(PROMPT_TO_ID)) delete PROMPT_TO_ID[k]
  for (const entry of VOCAB) {
    for (const p of (entry.prompts || [])) {
      ALL_PROMPTS.push(p)
      PROMPT_TO_ID[p] = entry.id
    }
  }
}

// ─── Web Worker bridge ────────────────────────────────────────────────────────

let _worker         = null
let _reqCounter     = 0
let _clearCacheSent = false
const _pending      = new Map()   // reqId → { resolve, reject }

function needsCacheClear() {
  try {
    if (localStorage.getItem(CACHE_VER_KEY) !== CACHE_VERSION) {
      localStorage.setItem(CACHE_VER_KEY, CACHE_VERSION)
      return true
    }
  } catch { /* storage unavailable */ }
  return false
}

// Check once at module load time so the flag survives across calls
let _pendingCacheClear = needsCacheClear()

function getWorker() {
  if (_worker) return _worker
  _worker = new Worker(new URL('../workers/auto-tag-worker.js', import.meta.url), { type: 'module' })

  _worker.onmessage = ({ data }) => {
    if (data.type === 'log') {
      log.debug('worker', { msg: data.msg })
    } else if (data.type === 'result') {
      const req = _pending.get(data.reqId)
      if (req) { _pending.delete(data.reqId); req.resolve(data.results) }
    } else if (data.type === 'error') {
      const req = _pending.get(data.reqId)
      if (req) { _pending.delete(data.reqId); req.reject(new Error(data.message)) }
    }
  }

  _worker.onerror = err => {
    log.error('worker_crashed', { error: err.message ?? String(err) })
    for (const [, req] of _pending) req.reject(new Error('Worker crashed'))
    _pending.clear()
    _worker = null  // will be recreated on next inference
  }

  return _worker
}

function inferInWorker(dataUrl, prompts) {
  return new Promise((resolve, reject) => {
    const reqId      = ++_reqCounter
    const clearCache = _pendingCacheClear && !_clearCacheSent
    if (clearCache) _clearCacheSent = true

    _pending.set(reqId, { resolve, reject })
    getWorker().postMessage({ type: 'infer', reqId, dataUrl, prompts, clearCache })
  })
}

// ─── Public: resolve a canonical tag ID to the display label for a language ──
// Falls back to the English label, then to the raw ID if not in the vocab at all
// (user-created tags, for example, are returned unchanged).
export function getTagLabel(canonicalId, lang) {
  const l     = lang ?? currentLang()
  const entry = VOCAB.find(v => v.id === canonicalId)
  return entry?.labels[l] ?? entry?.labels.en ?? canonicalId
}

// ─── Core inference for one item ─────────────────────────────────────────────
async function processOne(item) {
  let confidence = null
  let status     = 'done'

  try {
    const b64     = await api.readImageAsBase64(item.stored_path)
    const mime    = item.mime_type ?? 'image/jpeg'
    const dataUrl = `data:${mime};base64,${b64}`

    const results = await inferInWorker(dataUrl, ALL_PROMPTS)

    // Aggregate: multiple prompts per tag → keep the highest score per ID
    const byId = {}
    for (const r of results) {
      const id = PROMPT_TO_ID[r.label]
      if (!id) continue
      if (r.score > (byId[id] ?? 0)) byId[id] = r.score
    }

    // ─── OCR text boosting ────────────────────────────────────────────────────
    // Option 2: boost tags whose prompts share words with the image's OCR text.
    // Option 3: use word-count density as a signal (sparse → visual tags win;
    //           dense → text-heavy tags win).
    const ocrText = (item.ocr_text || '').toLowerCase()
    if (ocrText.length > 0) {
      const ocrTokens    = new Set(ocrText.split(/\W+/).filter(w => w.length > 2))
      const ocrWordCount = ocrText.split(/\s+/).filter(Boolean).length

      // Option 2 — prompt-text word overlap
      for (const entry of VOCAB) {
        const promptWords = entry.prompts.join(' ').toLowerCase().split(/\W+/).filter(w => w.length > 2)
        const matchCount  = promptWords.filter(w => ocrTokens.has(w)).length
        if (matchCount > 0) {
          const boost = Math.min((matchCount / promptWords.length) * 0.3, 0.15)
          byId[entry.id] = (byId[entry.id] ?? 0) + boost
        }
      }

      // Option 3 — density signal
      const SPARSE_IDS = ['minimal', 'abstract', '3d_render', 'dark_cinematic', 'neon_glow']
      const DENSE_IDS  = ['typographic', 'infographic', 'poster', 'social_media', 'brand_identity']
      if (ocrWordCount < 5) {
        for (const id of SPARSE_IDS) byId[id] = (byId[id] ?? 0) + 0.04
        for (const id of DENSE_IDS)  byId[id]  = Math.max((byId[id] ?? 0) - 0.03, 0)
      } else if (ocrWordCount > 30) {
        for (const id of DENSE_IDS)  byId[id]  = (byId[id] ?? 0) + 0.04
        for (const id of SPARSE_IDS) byId[id]  = Math.max((byId[id] ?? 0) - 0.03, 0)
      }
    }

    // Filter by threshold, sort descending, keep top-k
    const kept = Object.entries(byId)
      .filter(([, s]) => s >= THRESHOLD)
      .sort(([, a], [, b]) => b - a)
      .slice(0, TOP_K)

    confidence = {}
    for (const [id, score] of kept) {
      confidence[id] = Math.round(score * 100) / 100
    }

    const ocrWords = (item.ocr_text || '').split(/\s+/).filter(Boolean).length
    log.info('scored', { id: item.id, tags: Object.keys(confidence ?? {}).length, ocr_words: ocrWords })
  } catch (err) {
    log.error('inference_error', { id: item.id, error: err })
    status = 'failed'
  }

  await api.finalizeAutoTagResult(
    item.id,
    confidence !== null ? JSON.stringify(confidence) : null,
    status === 'done' ? MODEL_NAME : null,
    status,
  ).catch(e => log.error('finalize_error', { id: item.id, error: e }))
}

// ─── Batch loop ───────────────────────────────────────────────────────────────

let _running = false
let _enabled = false
let _wakeUp  = null  // resolves the idle sleep so work starts immediately

async function runBatch() {
  await reloadVocab()
  if (!ALL_PROMPTS.length) return false  // no vocab — nothing to score against

  const batch = await api.claimAutoTagCandidates(BATCH_SIZE)
  if (!batch.length) return false

  for (const item of batch) {
    await processOne(item)
  }

  store.emit(events.AUTO_TAG_BATCH_DONE, { processed: batch.length, ids: batch.map(i => i.id) })
  return true
}

async function loop() {
  if (_running) { _wakeUp?.(); return }  // already running — just wake it if idling
  _running = true
  try {
    while (_enabled) {
      const hadWork = await runBatch()
      if (!hadWork) {
        await new Promise(r => {
          _wakeUp = r
          setTimeout(r, IDLE_MS)
        })
        _wakeUp = null
      }
    }
  } catch (err) {
    log.error('loop_crashed', { error: err })
  } finally {
    _running = false
  }
}

// ─── Entry point (called from main.js) ───────────────────────────────────────
export function initAutoTag() {
  if (!('__TAURI_INTERNALS__' in window)) return  // no-op in browser mock

  _enabled = getSetting('tag_recommendations_enabled', 'false') !== 'false'
  if (_enabled) loop()

  // Wake the loop immediately when new work arrives (import, re-tag all, etc.)
  store.on(events.GRID_RELOAD,       () => { if (_enabled) loop() })
  store.on(events.TAG_VOCAB_CHANGED, () => { if (_enabled) reloadVocab() })

  // React to the toggle in settings — start or stop the loop dynamically
  store.on(events.SETTINGS_CHANGED, ({ key, value }) => {
    if (key !== 'tag_recommendations_enabled') return
    _enabled = value !== 'false' && value !== false
    if (_enabled) loop()
    else _wakeUp?.()  // wake the sleeping loop so it exits on next iteration check
  })
}
