// Central registry of all downloads — both in-app URL-bar and extension-triggered.
// Other modules (indicator, activity view) read from here instead of each maintaining
// their own incomplete state.
//
// Entry shape:
//   { id, url, quality, importSource, status, pct, filename, domain, error, addedAt }
//
// importSource: 'app_download' | 'extension'
// status:       'queued' | 'active' | 'complete' | 'failed' | 'cancelled'

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'

const _entries = new Map()  // id → entry

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function set(id, patch) {
  const e = _entries.get(id)
  if (!e) { console.warn('[tracker] set() called for unknown id:', id); return }
  Object.assign(e, patch)
  store.emit(events.DOWNLOADS_CHANGED)
}

function add(entry) {
  console.info('[tracker] added', entry.id, entry.domain)
  _entries.set(entry.id, entry)
  store.emit(events.DOWNLOADS_CHANGED)
}

export function init() {
  store.on(events.DOWNLOAD_STARTED, ({ downloadId, url, quality, importSource }) => {
    add({
      id:           downloadId,
      url,
      quality:      quality ?? 'best',
      importSource: importSource ?? 'app_download',
      status:       'active',
      pct:          0,
      filename:     null,
      domain:       domain(url),
      error:        null,
      addedAt:      Date.now(),
    })
  })

  store.on(events.DOWNLOAD_QUEUED, ({ download_id }) => {
    const e = _entries.get(download_id)
    if (e) { e.status = 'queued'; store.emit(events.DOWNLOADS_CHANGED) }
  })

  store.on(events.DOWNLOAD_FILENAME, ({ download_id, filename }) => {
    set(download_id, { filename })
  })

  store.on(events.DOWNLOAD_PROGRESS, ({ download_id, pct }) => {
    const e = _entries.get(download_id)
    if (!e) return
    e.status = 'active'
    e.pct    = pct ?? 0
    store.emit(events.DOWNLOADS_CHANGED)
  })

  store.on(events.DOWNLOAD_COMPLETE, ({ download_id }) => {
    set(download_id, { status: 'complete', pct: 1 })
  })

  store.on(events.DOWNLOAD_ERROR, async ({ download_id, message }) => {
    const e = _entries.get(download_id)
    if (!e) { console.warn('[tracker] DOWNLOAD_ERROR for unknown id:', download_id); return }
    const isCancelled = (message ?? '').toLowerCase() === 'cancelled'
    // User cancel: drop the entry cleanly — no lingering "cancelled" row, no
    // error styling. The progress ring already dismisses itself smoothly.
    if (isCancelled) {
      console.info('[tracker] cancelled', download_id)
      _entries.delete(download_id)
      store.emit(events.DOWNLOADS_CHANGED)
      return
    }
    console.info('[tracker] failed', download_id, message ?? '')
    e.status = 'failed'
    e.error  = message ?? null
    store.emit(events.DOWNLOADS_CHANGED)
    // Persist real failures so the activity view shows them after restart
    try {
      await api.logFailedDownload(
        e.id, e.url, e.quality, e.importSource, 'failed',
        message ?? null, e.filename ?? null,
      )
    } catch (err) {
      console.warn('[tracker] logFailedDownload failed — entry will not persist across restarts:', err)
    }
  })
}

// ─── Read ─────────────────────────────────────────────────────────

export function getEntries() {
  return [..._entries.values()]
}

export function getEntry(id) {
  return _entries.get(id) ?? null
}

// ─── Actions ──────────────────────────────────────────────────────

export function dismissEntry(id) {
  _entries.delete(id)
  store.emit(events.DOWNLOADS_CHANGED)
  api.clearFailedDownload(id).catch(() => {})
}

export function dismissCompleted() {
  for (const [id, e] of _entries) {
    if (e.status === 'complete') _entries.delete(id)
  }
  store.emit(events.DOWNLOADS_CHANGED)
}

export async function retryDownload(id, fallback = null) {
  const e = _entries.get(id) ?? fallback
  if (!e) { console.warn('[tracker] retryDownload: no entry for id', id); return }
  console.info('[tracker] retry', id, e.url)
  _entries.delete(id)
  await api.clearFailedDownload(id).catch(err => console.warn('[tracker] clearFailedDownload failed:', err))

  const src = e.importSource ?? e.import_source ?? 'app_download'

  // Mobile-sync retries must go through handleItem so that auth failures
  // trigger extension delegation (queueExtDownload) — calling downloadUrl
  // directly bypasses that logic and the error is silently dropped.
  if (src === 'mobile') {
    store.emit(events.EXTENSION_ITEM_RECEIVED, {
      url:          e.url,
      type:         'link',
      _ext_id:      null,
      importSource: 'mobile',
    })
    return
  }

  const newId = await api.downloadUrl(e.url, e.quality ?? 'best')
  console.info('[tracker] retry started as', newId)
  store.emit(events.DOWNLOAD_STARTED, {
    downloadId:   newId,
    url:          e.url,
    quality:      e.quality ?? 'best',
    importSource: src,
  })
  return newId
}
