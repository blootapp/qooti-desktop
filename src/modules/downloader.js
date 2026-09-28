// Handles URL-paste-to-download flow:
//  1. Caller feeds every search-bar input value to checkUrl()
//  2. When a URL is detected the color-picker button morphs to a download button
//  3. Clicking the morphed button (or Enter) triggers the download
//  4. Progress shown in the ring and as input placeholder text
//  5. Button morphs to a cancel (X) button; clicking it stops the download
//  6. On completion the file is imported and the grid reloads

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { startTask } from './progress-ring.js'
import { getSetting } from './settings.js'
import { makeLogger, createOp } from './logger.js'
import { dismissEntry } from './download-tracker.js'
import { t } from './i18n.js'
import { friendlyDownloadError, isCancelled } from './download-errors.js'

const log = makeLogger('Download')

const URL_RE = /^https?:\/\/.+/i
const placeholder = () => t('search.placeholder')

let _searchInput   = null
let _swatchBtn     = null
let _isUrlMode     = false
let _activeTask    = null
let _activeId      = null   // download_id of the running download
let _activeUrl     = null   // URL for the current download (for extension delegation)
let _inputFocused  = false
let _progressLabel = ''     // last known "Downloading · speed · pct%" string

// Two-phase (video then audio) scaling state
let _phase   = 0
let _prevPct = 0

export function isUrl(value) {
  return URL_RE.test(String(value ?? '').trim())
}

export function initDownloader(searchInput, swatchBtn) {
  _searchInput = searchInput
  _swatchBtn   = swatchBtn
  _searchInput.placeholder = placeholder()

  document.addEventListener('i18n:changed', () => {
    if (!_activeId && _searchInput) _searchInput.placeholder = placeholder()
  })

  // Track input focus so we suppress placeholder updates while the user is typing
  _searchInput.addEventListener('focus', () => {
    _inputFocused = true
    if (_activeId) _searchInput.placeholder = placeholder()
  })
  _searchInput.addEventListener('blur', () => {
    _inputFocused = false
    if (_activeId) _searchInput.placeholder = _progressLabel
  })

  store.on(events.DOWNLOAD_QUEUED, ({ download_id }) => {
    if (_activeId !== download_id) return
    _progressLabel = t('dl.search.queued')
    if (!_inputFocused) _searchInput.placeholder = _progressLabel
  })

  store.on(events.DOWNLOAD_PROGRESS, ({ download_id, pct, speed, stage }) => {
    if (_activeId !== download_id) return

    if (stage) {
      // Setup / retry stages (e.g. installing YouTube support on first use) aren't
      // byte progress: say what's happening, and keep them out of the two-phase arc.
      const label = t(`dl.stage.${stage}`)
      _progressLabel = pct > 0 ? `${label} · ${Math.round(pct * 100)}%` : label
      if (stage === 'retrying') { _phase = 0; _prevPct = 0 }
      if (!_inputFocused) _searchInput.placeholder = _progressLabel
      return
    }

    // Detect phase reset: yt-dlp downloads video then audio, each 0→100%
    if (_phase === 0 && pct < _prevPct - 0.15 && _prevPct > 0.8) _phase = 1
    _prevPct = pct

    // Map two phases into a single 0–100% arc
    const scaled = _phase === 0 ? pct * 0.5 : 0.5 + pct * 0.5
    const pctStr = Math.round(scaled * 100) + '%'
    _progressLabel = speed
      ? t('dl.search.progress_speed', { speed, pct: pctStr })
      : t('dl.search.progress', { pct: pctStr })

    _activeTask?.update(scaled)
    // Ring is visual-only during download; all text lives in the placeholder
    if (!_inputFocused) _searchInput.placeholder = _progressLabel
  })

  store.on(events.DOWNLOAD_COMPLETE, async ({ download_id, paths, url }) => {
    if (_activeId !== download_id) return
    _finishDownload()

    _activeTask?.update(1)

    // paths is an array — one entry per file (carousels / multi-image posts)
    const allPaths = Array.isArray(paths) ? paths : (paths ? [paths] : [])

    log.info('complete', { paths: allPaths.length })
    let imported = 0
    let duplicates = 0
    let failed = 0
    if (allPaths.length) {
      _searchInput.placeholder = allPaths.length > 1
        ? t('dl.search.importing_n', { n: allPaths.length })
        : t('dl.search.importing')
      for (const p of allPaths) {
        try {
          const result = await api.finalizeDownload(p, url ?? null)
          log.debug('finalized', { id: result?.id })
          imported++
        } catch (err) {
          if (String(err).includes('duplicate')) {
            duplicates++
          } else {
            failed++
            log.error('finalize_error', { error: err, path: p })
          }
        }
      }
      log.info('import_done', { imported, total: allPaths.length })
      if (imported > 0) store.emit(events.GRID_RELOAD, {})
    } else {
      log.warn('complete_no_paths', {})
    }

    _activeTask?.finish()
    _activeTask = null

    if (imported === 0 && duplicates > 0) {
      _searchInput.placeholder = t('dl.search.already')
      setTimeout(() => { if (_searchInput && !_activeId) _searchInput.placeholder = placeholder() }, 3000)
    } else {
      if (imported === 0 && failed > 0) {
        store.emit(events.SYSTEM_TOAST, { type: 'error', message: t('dl.err.save_failed'), duration: 6000 })
      }
      _resetSearchBar()
    }
  })

  store.on(events.DOWNLOAD_ERROR, ({ download_id, message }) => {
    if (_activeId !== download_id) return

    const url = _activeUrl
    const isAuthMsg = typeof message === 'string' && (
      message.includes("browser session") ||
      message.includes("extension") ||
      message.includes("logged-in") ||
      message.includes("Instagram") ||
      message.includes("TikTok")
    )

    if (isAuthMsg && url) {
      // yt-dlp failed due to missing auth cookies — ask the extension to handle
      // it using its own browser session instead of surfacing an error.
      const failedId = download_id
      const askingLabel = t('dl.search.asking_extension')
      _activeTask?.finish()  // removes the task from the ring's Map so the spinner clears
      _activeTask = null
      _finishDownload()
      _searchInput.placeholder = askingLabel
      _swatchBtn?.classList.remove('cancel-mode', 'download-mode')

      // dismiss the failed tracker entry so it doesn't appear in the dropdown
      // (give the tracker one tick to process the error first)
      setTimeout(() => dismissEntry(failedId), 0)

      api.queueExtDownload(url).catch(err => {
        log.warn('queue_ext_download_failed', { error: err })
      })

      // When the extension picks it up, it emits DOWNLOAD_STARTED with importSource 'extension'.
      // Use that as the success signal — clear the placeholder and cancel the fallback timeout.
      let onExtStart
      const fallbackTimer = setTimeout(() => {
        store.off(events.DOWNLOAD_STARTED, onExtStart)
        if (_searchInput.placeholder === askingLabel) {
          _searchInput.placeholder = t('dl.search.no_extension')
          setTimeout(() => {
            if (_searchInput.placeholder !== placeholder()) _resetSearchBar()
          }, 4000)
        }
      }, 12000)

      onExtStart = store.on(events.DOWNLOAD_STARTED, ({ downloadId, importSource }) => {
        if (importSource !== 'extension') return
        clearTimeout(fallbackTimer)
        store.off(events.DOWNLOAD_STARTED, onExtStart)
        // The extension restarted the download with its browser cookies.
        // extension.js owns the finalize + grid reload; we mirror progress and
        // confirm the outcome so the app doesn't go silent after handing off.
        _watchDelegated(downloadId)
      })

      return
    }

    const friendly = friendlyDownloadError(message)
    _activeTask?.fail(friendly)
    _activeTask = null
    _finishDownload()
    _resetSearchBar()
    if (!isCancelled(message)) {
      // The ring only flashes an error for ~1.6 s — failures used to look like
      // "nothing happened". Say it where it can actually be read.
      log.warn('failed', { error: message })
      store.emit(events.SYSTEM_TOAST, { type: 'error', message: friendly, duration: 7000 })
    }
  })
}

// Mirror a download that was delegated to the browser extension for auth
// cookies. Display-only: extension.js performs the actual finalize + grid
// reload, so we must NOT finalize here (that would double-import). We restart
// the ring, follow progress, and give a clear success/failure confirmation —
// otherwise the app goes silent while the extension quietly saves the file.
function _watchDelegated(id) {
  // Own ring task, kept local — the delegated download isn't cancellable via the
  // swatch, so it must not touch _activeTask (that's the app-initiated download).
  const task = startTask(id, { label: '', indeterminate: true })
  const savedLabel = t('dl.search.saved')
  if (!_activeId && !_inputFocused) _searchInput.placeholder = t('dl.status.downloading')

  let onProg, onDone, onErr
  const cleanup = () => {
    store.off(events.DOWNLOAD_PROGRESS, onProg)
    store.off(events.DOWNLOAD_COMPLETE, onDone)
    store.off(events.DOWNLOAD_ERROR,    onErr)
  }

  onProg = store.on(events.DOWNLOAD_PROGRESS, ({ download_id, pct, speed }) => {
    if (download_id !== id) return
    task?.update(pct)
    if (!_activeId && !_inputFocused) {
      const pctStr = Math.round(pct * 100) + '%'
      _searchInput.placeholder = speed
        ? t('dl.search.progress_speed', { speed, pct: pctStr })
        : t('dl.search.progress', { pct: pctStr })
    }
  })

  onDone = store.on(events.DOWNLOAD_COMPLETE, ({ download_id }) => {
    if (download_id !== id) return
    cleanup()
    task?.finish()
    store.emit(events.SYSTEM_TOAST, { type: 'success', message: savedLabel, duration: 3000 })
    if (!_activeId) {
      _searchInput.placeholder = savedLabel
      setTimeout(() => {
        if (_searchInput && !_activeId && _searchInput.placeholder === savedLabel) _resetSearchBar()
      }, 2500)
    }
  })

  onErr = store.on(events.DOWNLOAD_ERROR, ({ download_id, message }) => {
    if (download_id !== id) return
    cleanup()
    task?.fail(friendlyDownloadError(message))
    store.emit(events.SYSTEM_TOAST, {
      type: 'error',
      message: t('dl.err.delegated'),
      duration: 5000,
    })
    if (!_activeId) _resetSearchBar()
  })
}

// Called by main.js on every search input event
export function checkUrl(value) {
  if (_activeId) return  // don't interfere with an active download
  const url = isUrl(value)
  if (url === _isUrlMode) return
  _isUrlMode = url
  _swatchBtn?.classList.toggle('download-mode', url)
}

// Called by main.js when the swatch/download button is clicked.
// Returns true if it handled the click (caller should skip color picker).
// This is the ONLY place a click cancels — Enter in the search box goes through
// startDownloadFromInput, so searching while a download runs can't kill it.
export async function handleSwatchClick() {
  // Cancel an active download — clean dismissal, not an error flash.
  if (_activeId) {
    const idToCancel = _activeId
    _activeTask?.cancel()
    _activeTask = null
    _finishDownload()  // clears _activeUrl too
    _resetSearchBar()
    try { await api.cancelDownload(idToCancel) } catch (_) {}
    return true
  }

  if (!_isUrlMode) return false
  return startDownloadFromInput()
}

// Enter in the search box with a URL in it. Returns true if handled.
export async function startDownloadFromInput() {
  const url = _searchInput?.value.trim()
  if (!url || !isUrl(url)) return false

  if (_activeId) {
    // One search-bar download at a time; tell the user instead of silently ignoring.
    store.emit(events.SYSTEM_TOAST, { type: 'info', message: t('dl.search.busy'), duration: 3500 })
    return true
  }

  const existing = await api.checkUrlExists(url)
  if (existing) {
    const { showDuplicateDialog } = await import('./dialog.js')
    const action = await showDuplicateDialog({
      title: t('dl.dup.title'),
      message: t('dl.dup.message', { title: existing.title ?? t('dl.dup.this_item') }),
    })
    if (action === 'view') {
      store.emit(events.CARD_OPEN, { item: existing })
      return true
    }
    if (action !== 'download') return true
  }

  const quality = getSetting('download_quality', 'best')

  const op = createOp()
  try {
    log.info('start', { url }, op)
    const downloadId = await api.downloadUrl(url, quality)
    _activeId  = downloadId
    _activeUrl = url
    _phase     = 0
    _prevPct   = 0

    log.info('queued', { downloadId }, op)
    store.emit(events.DOWNLOAD_STARTED, {
      downloadId,
      url,
      quality,
      importSource: 'app_download',
    })

    // Clear the URL from the input immediately
    _searchInput.value = ''
    _progressLabel = t('dl.search.fetching')
    _searchInput.placeholder = _progressLabel

    // Morph button to cancel
    _swatchBtn?.classList.remove('download-mode')
    _swatchBtn?.classList.add('cancel-mode')

    const task = startTask(downloadId, { label: '', indeterminate: true })
    _activeTask = task
  } catch (err) {
    if (String(err).includes('UPGRADE_REQUIRED:download_limit')) {
      store.emit(events.SYSTEM_TOAST, {
        type: 'warning',
        message: friendlyDownloadError(err),
        duration: 6000,
      })
      return true
    }
    log.error('start_failed', { error: err }, op)
    store.emit(events.SYSTEM_TOAST, { type: 'error', message: friendlyDownloadError(err), duration: 6000 })
  }

  return true
}

function _finishDownload() {
  _activeId      = null
  _activeUrl     = null
  _progressLabel = ''
  _isUrlMode     = false
  _swatchBtn?.classList.remove('cancel-mode', 'download-mode')
}

function _resetSearchBar() {
  if (!_searchInput) return
  _searchInput.placeholder = placeholder()
  // The URL was cleared when the download started, so anything in the box now was
  // typed during the download (a search, or the next link) — keep it and its
  // results, and re-sync the swatch in case it's a URL.
  if (_searchInput.value.trim()) { checkUrl(_searchInput.value); return }
  store.emit(events.SEARCH_QUERY_CHANGED, { query: null })
}
