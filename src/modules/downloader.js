// Handles URL-paste-to-download flow:
//  1. Caller feeds every search-bar input value to checkUrl()
//  2. When a URL is detected the color-picker button morphs to a download button
//  3. Clicking the morphed button triggers the download
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

const log = makeLogger('Download')

const URL_RE = /^https?:\/\/.+/i
const DEFAULT_PLACEHOLDER = 'Search...'

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

export function initDownloader(searchInput, swatchBtn) {
  _searchInput = searchInput
  _swatchBtn   = swatchBtn

  // Track input focus so we suppress placeholder updates while the user is typing
  _searchInput.addEventListener('focus', () => {
    _inputFocused = true
    if (_activeId) _searchInput.placeholder = DEFAULT_PLACEHOLDER
  })
  _searchInput.addEventListener('blur', () => {
    _inputFocused = false
    if (_activeId) _searchInput.placeholder = _progressLabel
  })

  store.on(events.DOWNLOAD_QUEUED, ({ download_id }) => {
    if (_activeId !== download_id) return
    _progressLabel = 'Queued · waiting…'
    if (!_inputFocused) _searchInput.placeholder = _progressLabel
  })

  store.on(events.DOWNLOAD_PROGRESS, ({ download_id, pct, speed }) => {
    if (_activeId !== download_id) return

    // Detect phase reset: yt-dlp downloads video then audio, each 0→100%
    if (_phase === 0 && pct < _prevPct - 0.15 && _prevPct > 0.8) _phase = 1
    _prevPct = pct

    // Map two phases into a single 0–100% arc
    const scaled = _phase === 0 ? pct * 0.5 : 0.5 + pct * 0.5
    const pctStr = Math.round(scaled * 100) + '%'
    const speedStr = speed || ''
    _progressLabel = speedStr ? `Downloading · ${speedStr} · ${pctStr}` : `Downloading · ${pctStr}`

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
    if (allPaths.length) {
      _searchInput.placeholder = allPaths.length > 1 ? `Importing ${allPaths.length} files…` : 'Importing…'
      for (const p of allPaths) {
        try {
          const result = await api.finalizeDownload(p, url ?? null)
          log.debug('finalized', { id: result?.id })
          imported++
        } catch (err) {
          if (String(err).includes('duplicate')) {
            duplicates++
          } else {
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
      _searchInput.placeholder = 'Already in your library'
      setTimeout(() => { if (_searchInput) _searchInput.placeholder = DEFAULT_PLACEHOLDER }, 3000)
    } else {
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
      _activeTask?.finish()  // removes the task from the ring's Map so the spinner clears
      _activeTask = null
      _finishDownload()
      _searchInput.placeholder = 'Asking extension for cookies…'
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
        if (_searchInput.placeholder === 'Asking extension for cookies…') {
          _searchInput.placeholder = 'Extension not found — install qooti in Chrome'
          setTimeout(() => {
            if (_searchInput.placeholder !== DEFAULT_PLACEHOLDER) _resetSearchBar()
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

    _activeTask?.fail(message ?? 'Download failed')
    _activeTask = null
    _finishDownload()
    _resetSearchBar()
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
  if (!_activeId && !_inputFocused) _searchInput.placeholder = 'Downloading…'

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
      _searchInput.placeholder = speed ? `Downloading · ${speed} · ${pctStr}` : `Downloading · ${pctStr}`
    }
  })

  onDone = store.on(events.DOWNLOAD_COMPLETE, ({ download_id }) => {
    if (download_id !== id) return
    cleanup()
    task?.finish()
    store.emit(events.SYSTEM_TOAST, { type: 'success', message: 'Saved to qooti', duration: 3000 })
    if (!_activeId) {
      _searchInput.placeholder = 'Saved to qooti'
      setTimeout(() => {
        if (_searchInput && !_activeId && _searchInput.placeholder === 'Saved to qooti') _resetSearchBar()
      }, 2500)
    }
  })

  onErr = store.on(events.DOWNLOAD_ERROR, ({ download_id, message }) => {
    if (download_id !== id) return
    cleanup()
    task?.fail(message ?? 'Download failed')
    store.emit(events.SYSTEM_TOAST, {
      type: 'error',
      message: 'Could not save this link — make sure you are signed in to the site in your browser.',
      duration: 5000,
    })
    if (!_activeId) _resetSearchBar()
  })
}

// Called by main.js on every search input event
export function checkUrl(value) {
  if (_activeId) return  // don't interfere with an active download
  const isUrl = URL_RE.test(value.trim())
  if (isUrl === _isUrlMode) return
  _isUrlMode = isUrl
  _swatchBtn?.classList.toggle('download-mode', isUrl)
}

// Called by main.js when the swatch/download button is clicked
// Returns true if it handled the click (caller should skip color picker)
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

  const url = _searchInput?.value.trim()
  if (!url) return false

  const existing = await api.checkUrlExists(url)
  if (existing) {
    const { showDuplicateDialog } = await import('./dialog.js')
    const action = await showDuplicateDialog({
      title: 'Already in your library',
      message: `"${existing.title ?? 'This item'}" was already downloaded. Download again anyway?`,
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
    _progressLabel = 'Fetching info…'
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
        message: `Daily download limit reached (${20}/day on free plan). Upgrade to Pro for unlimited downloads.`,
        duration: 6000,
      })
      return true
    }
    log.error('start_failed', { error: err }, op)
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
  if (_searchInput) {
    _searchInput.value       = ''
    _searchInput.placeholder = DEFAULT_PLACEHOLDER
  }
  store.emit(events.SEARCH_QUERY_CHANGED, { query: null })
}
