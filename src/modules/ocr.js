// OCR pipeline coordinator — claim → process (Web Worker) → finalize.
// Worker runs PP-OCRv4 via onnxruntime-web (see workers/ocr-worker.js).

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { makeLogger } from './logger.js'

const log = makeLogger('OCR')

const BATCH_SIZE   = 10
const BATCH_PAUSE_MS = 500

let running  = false
let paused   = false
let worker   = null
let _reqId   = 0
const _pending = new Map()   // reqId → { resolve, timer }

// Per-image cap. Covers the first call's one-time model load; a genuinely hung
// image must never stall the whole pipeline (the old code had no timeout, so one
// bad image left every later item stuck "pending" forever).
const OCR_TIMEOUT_MS = 60000

export async function init() {
  createWorker()
  // Imports, downloads and reindex all emit GRID_RELOAD. The indexer runs until
  // it drains then stops, so wake it on new content (mirrors the auto-tag loop).
  // startIndexing() no-ops when already running, so this is cheap.
  store.on(events.GRID_RELOAD, () => startIndexing())
}

function createWorker() {
  worker = new Worker(new URL('../workers/ocr-worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }) => {
    if (data.type === 'status') { log.info('model', { status: data.text }); return }   // model-load progress
    if (data.type !== 'result' && data.type !== 'error') return
    const p = _pending.get(data.reqId)
    if (p) { _pending.delete(data.reqId); clearTimeout(p.timer); p.resolve(data) }
  }
  // A worker crash sends no message — surface it, fail everything in-flight so
  // the loop advances, then respawn so future items still get processed.
  worker.onerror = e => {
    log.error('worker_crashed', { error: e?.message || e?.filename || String(e) })
    recycleWorker('ocr worker crashed')
  }
}

// Fail all in-flight requests and spin up a fresh worker. Used on crash/timeout
// so a wedged worker can't block the pipeline. (Cost: the next image reloads the
// model — acceptable because this only fires on the rare bad image.)
function recycleWorker(reason) {
  for (const [, p] of _pending) { clearTimeout(p.timer); p.resolve({ type: 'error', message: reason }) }
  _pending.clear()
  try { worker.terminate() } catch {}
  createWorker()
}

function runOcr(base64) {
  return new Promise(resolve => {
    const reqId = ++_reqId
    const timer = setTimeout(() => {
      if (_pending.delete(reqId)) { resolve({ type: 'error', message: 'ocr timeout' }); recycleWorker('recycle after timeout') }
    }, OCR_TIMEOUT_MS)
    _pending.set(reqId, { resolve, timer })
    worker.postMessage({ reqId, base64 })
  })
}

export async function startIndexing() {
  if (running) return
  running = true
  paused  = false
  runLoop()
}

export function pause() {
  paused = true
  store.emit(events.OCR_PAUSED)
}

export function resume() {
  paused = false
  store.emit(events.OCR_RESUMED)
  runLoop()
}

async function runLoop() {
  log.info('pipeline_start')
  while (running && !paused) {
    const batch = await api.claimOcrCandidates(BATCH_SIZE)
    if (!batch.length) { running = false; log.info('idle'); break }
    log.info('batch_claimed', { size: batch.length })

    for (const item of batch) {
      if (paused) break
      try {
        const base64 = await api.readImageAsBase64(item.stored_path)
        const result = await runOcr(base64)
        if (result.type === 'error') throw new Error(result.message)
        await api.finalizeOcrResult({
          id:           item.id,
          ocr_text:     result.text,
          ocr_language: result.language ?? null,
          status:       result.text.trim() ? 'done' : 'skipped',
        })
        log.info('indexed', { id: item.id, chars: result.text.length, lang: result.language ?? '—', status: result.text.trim() ? 'done' : 'skipped' })
      } catch (e) {
        log.error('failed', { id: item.id, error: e?.message ?? String(e) })
        await api.finalizeOcrResult({ id: item.id, ocr_text: '', ocr_language: null, status: 'failed' })
      }
    }

    const stats = await api.getOcrStats()
    store.emit(events.OCR_STATS_UPDATED, stats)
    store.emit(events.OCR_BATCH_DONE, { processed: batch.length })

    if (!paused) await sleep(BATCH_PAUSE_MS)
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
