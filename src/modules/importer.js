import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { startTask } from './progress-ring.js'

const IS_TAURI = '__TAURI_INTERNALS__' in window
const YT_RE   = /(?:youtube\.com|youtu\.be)/i

// ─── Dialog lazy-load ────────────────────────────────────────────
let _openDialog = null
async function getOpenDialog() {
  if (!IS_TAURI) return null
  if (!_openDialog) ({ open: _openDialog } = await import('@tauri-apps/plugin-dialog'))
  return _openDialog
}

// ─── Module state ────────────────────────────────────────────────
let _modal = null
let _isOpen = false

// Source analysis result + path (set during analysis pane)
let _analysis = null  // { source_type, media_count, display_name }
let _sourcePath = null

// Active video download state (reset each time startVideoDownload runs)
let _activeDownloadId  = null
let _activeRingTask    = null
let _downloadMinimized = false
let _downloadCancelled = false
let _lastPct           = 0

export function isOpen() { return _isOpen }

// ─── Init ────────────────────────────────────────────────────────
export function init() {
  _modal = buildModal()
  document.getElementById('overlays').appendChild(_modal)
  wireModal()

  store.on(events.IMPORT_REQUESTED, () => openModal())

  // Files dropped onto the window while modal is open → handle here
  store.on(events.FILES_DROPPED, ({ paths }) => {
    if (_isOpen) handleDroppedPaths(paths)
  })

  // A .qooti file opened from the OS (double-click / "Open with") → open the
  // importer and analyse it, surfacing the existing import options.
  store.on(events.QOOTI_FILE_OPEN, ({ path }) => {
    if (!path) return
    openModal()
    handleDroppedPaths([path])
  })
}

// ─── Open / close ────────────────────────────────────────────────
export function openModal() {
  if (_isOpen) return
  _isOpen = true
  resetState()
  _modal.hidden = false
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _modal.classList.add('is-open')
  }))
}

function closeModal() {
  if (!_isOpen) return
  _isOpen = false
  _modal.classList.remove('is-open')
  setTimeout(() => { _modal.hidden = true }, 220)
}

// ─── State reset ─────────────────────────────────────────────────
function resetState() {
  _analysis   = null
  _sourcePath = null

  // Reset panes instantly (modal is not yet visible)
  const sheet = _modal.querySelector('.import-modal-sheet')
  sheet.style.height = ''
  for (const id of ['import-pane-idle', 'import-pane-analysis', 'import-pane-progress']) {
    const el = _modal.querySelector(`#${id}`)
    if (!el) continue
    const isIdle = id === 'import-pane-idle'
    el.hidden = !isIdle
    el.classList.remove('import-pane--active', 'import-pane--exit', 'import-pane--enter')
    if (isIdle) el.classList.add('import-pane--active')
  }

  _modal.querySelector('#import-url-input').value   = ''
  _modal.querySelector('#import-url-go').disabled   = true
  _modal.querySelector('#import-url-go').hidden     = false
  _modal.querySelector('#import-url-video').hidden  = true
  _modal.querySelector('#import-url-thumb').hidden  = true
  _modal.querySelector('#import-cancel-btn').hidden = true
  clearDropZoneThumbnail()
  _modal.querySelector('#import-drop-zone').classList.remove('drag-over')
  _modal.querySelector('#import-save-as-collection').checked = true
  _modal.querySelector('#import-collection-field').hidden    = false
}

// ─── Build modal HTML ────────────────────────────────────────────
function buildModal() {
  const el = document.createElement('div')
  el.className = 'import-modal'
  el.id = 'import-modal'
  el.hidden = true
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-label', 'Import')

  el.innerHTML = `
    <div class="import-modal-backdrop"></div>
    <div class="import-modal-sheet">

      <div class="import-modal-header">
        <span class="import-modal-title">Import</span>
        <button class="import-close-btn" id="import-close-btn" aria-label="Close">
          <span class="icon icon-16" style="mask-image:url('/icons/x.svg');-webkit-mask-image:url('/icons/x.svg')" aria-hidden="true"></span>
        </button>
      </div>

      <!-- Pane: idle -->
      <div id="import-pane-idle" class="import-pane import-pane--active">
        <div class="import-drop-zone" id="import-drop-zone">
          <span class="icon icon-28 import-drop-icon"
            style="mask-image:url('/icons/upload-simple.svg');-webkit-mask-image:url('/icons/upload-simple.svg')"
            aria-hidden="true"></span>
          <p class="import-drop-label">Drop files or a folder here</p>
          <p class="import-drop-sub">Images, videos, Notion .zip, Telegram export folder, or .qooti collection</p>
          <button class="import-browse-btn" id="import-browse-btn">Browse files…</button>
        </div>

        <div class="import-or-row"><span class="import-or-text">or paste a link</span></div>

        <div class="import-url-row">
          <input class="import-url-input" id="import-url-input"
            type="url" placeholder="https://youtube.com/watch?v=…"
            autocomplete="off" spellcheck="false" />
          <button class="import-url-go" id="import-url-go" disabled>Download</button>
          <button class="import-url-icon-btn" id="import-url-video" hidden aria-label="Download video" data-tooltip="Download video">
            <span class="icon icon-18" style="mask-image:url('/icons/video-camera.svg');-webkit-mask-image:url('/icons/video-camera.svg')" aria-hidden="true"></span>
          </button>
          <button class="import-url-icon-btn" id="import-url-thumb" hidden aria-label="Download thumbnail" data-tooltip="Download thumbnail">
            <span class="icon icon-18" style="mask-image:url('/icons/image.svg');-webkit-mask-image:url('/icons/image.svg')" aria-hidden="true"></span>
          </button>
        </div>
      </div>

      <!-- Pane: analysis -->
      <div id="import-pane-analysis" class="import-pane" hidden>
        <div class="import-source-card" id="import-source-card">
          <div class="import-source-icon" id="import-source-icon"></div>
          <div class="import-source-detail">
            <span class="import-source-type" id="import-source-type"></span>
            <span class="import-source-count" id="import-source-count"></span>
          </div>
        </div>
        <div class="import-save-collection-row">
          <span class="import-toggle-label">Save as collection</span>
          <label class="import-toggle">
            <input type="checkbox" id="import-save-as-collection" checked />
            <span class="import-toggle-track"><span class="import-toggle-thumb"></span></span>
          </label>
        </div>
        <div id="import-collection-field" class="import-collection-field">
          <input class="import-field-input" id="import-collection-input" placeholder="Collection name…" />
        </div>
        <div class="import-analysis-actions">
          <button class="import-back-btn" id="import-back-btn">
            <span class="icon icon-14" style="mask-image:url('/icons/arrow-left.svg');-webkit-mask-image:url('/icons/arrow-left.svg')" aria-hidden="true"></span>
            Back
          </button>
          <button class="btn btn-primary import-go-btn" id="import-go-btn">Import</button>
        </div>
      </div>

      <!-- Pane: progress -->
      <div id="import-pane-progress" class="import-pane" hidden>
        <div class="import-progress-label" id="import-progress-label">Importing…</div>
        <div class="import-progress-track">
          <div class="import-progress-fill" id="import-progress-fill" style="width:0%"></div>
        </div>
        <p class="import-progress-sub" id="import-progress-sub"></p>
        <div class="import-progress-btns">
          <button class="import-cancel-btn" id="import-cancel-btn" hidden>Cancel</button>
          <button class="import-bg-btn" id="import-bg-btn">Minimize</button>
        </div>
      </div>

    </div>
  `
  return el
}

// ─── Smart close: minimize if a download is running, otherwise close ─────────
function handleClose() {
  if (_activeDownloadId) {
    _downloadMinimized = true
    if (!_activeRingTask) {
      _activeRingTask = startTask(_activeDownloadId, { label: 'Downloading', indeterminate: false })
      _activeRingTask.update(_lastPct)
    }
  }
  closeModal()
}

// ─── Wire events ─────────────────────────────────────────────────
function wireModal() {
  _modal.querySelector('#import-close-btn').addEventListener('click', handleClose)
  _modal.querySelector('.import-modal-backdrop').addEventListener('click', handleClose)

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _isOpen) handleClose()
  })

  // Browse button
  _modal.querySelector('#import-browse-btn').addEventListener('click', browseFiles)

  // URL input
  const urlInput  = _modal.querySelector('#import-url-input')
  const urlGo     = _modal.querySelector('#import-url-go')
  const urlVideo  = _modal.querySelector('#import-url-video')
  const urlThumb  = _modal.querySelector('#import-url-thumb')

  urlInput.addEventListener('input', () => {
    const v = urlInput.value.trim()
    const isYT = YT_RE.test(v)
    urlGo.disabled  = !v
    urlGo.hidden    = isYT
    urlVideo.hidden = !isYT
    urlThumb.hidden = !isYT
    if (isYT) {
      const id = extractYtId(v)
      if (id) showDropZoneThumbnail(id)
    } else {
      clearDropZoneThumbnail()
    }
  })
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && urlInput.value.trim()) startVideoDownload()
  })
  urlGo.addEventListener('click', startVideoDownload)
  urlVideo.addEventListener('click', startVideoDownload)
  urlThumb.addEventListener('click', startThumbDownload)

  // Drop zone visual feedback (actual paths come from FILES_DROPPED event)
  const dz = _modal.querySelector('#import-drop-zone')
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over') })
  dz.addEventListener('dragleave', e => {
    if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag-over')
  })
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over') })

  // Analysis pane
  _modal.querySelector('#import-back-btn').addEventListener('click', () => showPane('idle'))
  _modal.querySelector('#import-go-btn').addEventListener('click', startArchiveImport)

  const saveAsCollectionCheck = _modal.querySelector('#import-save-as-collection')
  const collectionField       = _modal.querySelector('#import-collection-field')
  saveAsCollectionCheck.addEventListener('change', () => {
    collectionField.hidden = !saveAsCollectionCheck.checked
    if (saveAsCollectionCheck.checked) {
      setTimeout(() => _modal.querySelector('#import-collection-input').focus(), 30)
    }
  })

  // Progress pane
  _modal.querySelector('#import-bg-btn').addEventListener('click', handleClose)
  _modal.querySelector('#import-cancel-btn').addEventListener('click', () => {
    if (_activeDownloadId) {
      _downloadCancelled = true
      api.cancelDownload(_activeDownloadId).catch(() => {})
    }
    closeModal()
  })
}

// ─── Pane switcher ───────────────────────────────────────────────
function showPane(name) {
  const sheet   = _modal.querySelector('.import-modal-sheet')
  const next    = _modal.querySelector(`#import-pane-${name}`)
  const current = _modal.querySelector('.import-pane--active')

  if (!next || current === next) return

  const fromH = sheet.offsetHeight

  // Exit current pane
  current.classList.remove('import-pane--active')
  current.classList.add('import-pane--exit')

  setTimeout(() => {
    current.hidden = true
    current.classList.remove('import-pane--exit')

    // Measure target height without flashing — show/measure/hide in same sync block
    next.hidden = false
    const toH = sheet.offsetHeight
    next.hidden = true

    // Lock height and show new pane
    sheet.style.height = `${fromH}px`
    next.hidden = false
    next.classList.add('import-pane--enter', 'import-pane--active')

    requestAnimationFrame(() => {
      sheet.style.height = `${toH}px`
      requestAnimationFrame(() => next.classList.remove('import-pane--enter'))
    })

    setTimeout(() => { sheet.style.height = '' }, 350)
  }, 170)
}

// ─── File browsing ───────────────────────────────────────────────
async function browseFiles() {
  const open = await getOpenDialog()
  if (!open) {
    // Browser dev mode — simulate with empty
    return
  }
  const selected = await open({
    multiple: true,
    filters: [{ name: 'Media, archives & collections', extensions: ['jpg','jpeg','png','webp','avif','gif','mp4','webm','mov','avi','mkv','zip','qooti'] }],
  }).catch(() => null)
  if (!selected) return
  const paths = Array.isArray(selected) ? selected : [selected]
  await handleDroppedPaths(paths)
}

// ─── Dropped paths handler ───────────────────────────────────────
async function handleDroppedPaths(paths) {
  if (!paths.length) return

  // Single zip or folder → try to analyze as archive import
  if (paths.length === 1) {
    const p = paths[0]
    // In Tauri, path is a string; check extension
    const isZip = /\.zip$/i.test(p)
    // Tauri provides real paths, so we can check via analyze command
    if (isZip || !hasMediaExtension(p)) {
      try {
        const analysis = await api.analyzeImportSource(p)
        _analysis   = analysis
        _sourcePath = p
        showAnalysis(analysis, p)
        return
      } catch {
        // Not a recognised archive — fall through to plain file import
      }
    }
  }

  // Otherwise import directly as media files
  await runFileImport(paths, null)
}

function hasMediaExtension(p) {
  return /\.(jpg|jpeg|png|webp|avif|heic|gif|mp4|webm|mov|avi|mkv)$/i.test(p)
}

// ─── Analysis pane ───────────────────────────────────────────────
function showAnalysis(analysis, sourcePath) {
  const typeLabels = { notion: 'Notion export', telegram: 'Telegram export', qooti: 'qooti collection' }
  const typeIcons  = { notion: 'file-zip', telegram: 'folder', qooti: 'stack' }
  const iconName   = typeIcons[analysis.source_type] ?? 'folder'
  const label      = typeLabels[analysis.source_type] ?? analysis.source_type

  _modal.querySelector('#import-source-icon').innerHTML =
    `<span class="icon icon-20" style="mask-image:url('/icons/${iconName}.svg');-webkit-mask-image:url('/icons/${iconName}.svg')" aria-hidden="true"></span>`
  _modal.querySelector('#import-source-type').textContent  = label
  _modal.querySelector('#import-source-count').textContent =
    `${analysis.media_count} ${analysis.media_count === 1 ? 'file' : 'files'}`

  const nameInput = _modal.querySelector('#import-collection-input')
  nameInput.value = analysis.display_name || ''

  showPane('analysis')
  setTimeout(() => nameInput.focus(), 50)
}

// ─── Archive import ──────────────────────────────────────────────
async function startArchiveImport() {
  if (!_analysis || !_sourcePath) return

  showPane('progress')

  // .qooti packs carry their own collection + tags — import directly
  if (_analysis.source_type === 'qooti') {
    setProgress(0, `Importing "${_analysis.display_name}"…`)
    try {
      const result = await api.importQooTiPack(_sourcePath)
      setProgress(1, `Imported ${result.imported_count} item${result.imported_count !== 1 ? 's' : ''} into "${result.collection_name}"`)
      sfx.success()
      store.emit(events.COLLECTION_CREATED)
      store.emit(events.GRID_RELOAD)
    } catch (err) {
      setProgress(0, `Import failed: ${err}`)
    }
    return
  }

  const saveAsCollection = _modal.querySelector('#import-save-as-collection').checked
  const collectionName   = saveAsCollection
    ? (_modal.querySelector('#import-collection-input').value.trim() || _analysis.display_name)
    : null

  setProgress(0, 'Extracting files…')

  let paths
  try {
    paths = await api.extractImportArchive(_sourcePath, _analysis.source_type)
  } catch (err) {
    setProgress(0, `Extract failed: ${err}`)
    return
  }

  if (!paths.length) {
    setProgress(0, 'No media files found')
    return
  }

  await runFileImport(paths, collectionName)
}

// ─── Direct file import ──────────────────────────────────────────
async function runFileImport(paths, collectionName) {
  showPane('progress')
  setProgress(0, `Importing 0 / ${paths.length}…`)

  const imported = []
  for (let i = 0; i < paths.length; i++) {
    setProgress(i / paths.length, `Importing ${i + 1} / ${paths.length}…`)
    try {
      const result = await api.importFiles([paths[i]])
      if (result.imported?.length) imported.push(...result.imported)
    } catch { /* skip bad file */ }
  }

  setProgress(1, `Imported ${imported.length} file${imported.length !== 1 ? 's' : ''}`)

  // Create collection and add items if a name was provided
  if (collectionName && imported.length) {
    try {
      const col = await api.createCollection(collectionName)
      for (const item of imported) {
        await api.addToCollection(col.id, item.id)
      }
      store.emit(events.COLLECTION_CREATED, { collection: col })
    } catch (err) {
      console.error('[importer] collection creation failed:', err)
    }
  }

  if (imported.length) {
    sfx.success()
    store.emit(events.GRID_RELOAD)
  }

  // Stay on modal, close after a beat
  setTimeout(() => { if (_isOpen) closeModal() }, 1800)
}

// ─── Drop zone thumbnail ─────────────────────────────────────────
function extractYtId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}

function showDropZoneThumbnail(videoId) {
  const dz = _modal.querySelector('#import-drop-zone')
  let thumb = dz.querySelector('.import-drop-thumb')
  if (!thumb) {
    thumb = document.createElement('img')
    thumb.className = 'import-drop-thumb'
    thumb.alt = ''
    thumb.onerror = () => { thumb.src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` }
    dz.appendChild(thumb)
  }
  thumb.src = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
  dz.classList.add('has-thumb')
}

function clearDropZoneThumbnail() {
  const dz = _modal?.querySelector('#import-drop-zone')
  if (!dz) return
  const thumb = dz.querySelector('.import-drop-thumb')
  if (thumb) thumb.remove()
  dz.classList.remove('has-thumb')
}

// ─── URL download ────────────────────────────────────────────────
async function startThumbDownload() {
  const url = _modal.querySelector('#import-url-input').value.trim()
  if (!url) return
  showPane('progress')
  setProgress(0, 'Fetching thumbnail…', true)
  try {
    const thumbPath = await api.fetchYoutubeThumbnail(url)
    setProgress(0.5, 'Importing…', true)
    const result = await api.importFiles([thumbPath])
    setProgress(1, 'Cover saved')
    if (result.imported?.length) {
      sfx.success()
      store.emit(events.GRID_RELOAD)
    }
    setTimeout(() => { if (_isOpen) closeModal() }, 1400)
  } catch (err) {
    setProgress(0, `Error: ${err}`)
  }
}

async function startVideoDownload() {
  const url = _modal.querySelector('#import-url-input').value.trim()
  if (!url) return

  showPane('progress')
  setProgress(0, 'Starting download…', true)

  // Reset per-download state
  _activeDownloadId  = null
  _activeRingTask    = null
  _downloadMinimized = false
  _downloadCancelled = false
  _lastPct           = 0

  // Show Cancel for video downloads
  _modal.querySelector('#import-cancel-btn').hidden = false

  let downloadId = null

  const hProgress = store.on(events.DOWNLOAD_PROGRESS, payload => {
    const p = payload.downloadId ?? payload.download_id
    if (downloadId && p !== downloadId) return
    const pct = payload.pct ?? 0
    _lastPct = pct
    if (_downloadMinimized) {
      _activeRingTask?.update(pct)
    } else {
      setProgress(pct, `Downloading… ${Math.round(pct * 100)}%`)
    }
  })

  const hComplete = store.on(events.DOWNLOAD_COMPLETE, async payload => {
    const p = payload.downloadId ?? payload.download_id
    if (downloadId && p !== downloadId) return
    cleanup()

    const paths = Array.isArray(payload.paths) ? payload.paths : (payload.paths ? [payload.paths] : [])

    const finalize = async () => {
      let imported = 0
      for (const filePath of paths) {
        try {
          await api.finalizeDownload(filePath, url)
          imported++
        } catch (err) {
          const msg = String(err)
          if (msg.includes('duplicate')) {
            imported++
          } else {
            console.error('[importer] finalizeDownload failed, falling back to importFiles:', msg)
            try {
              const r = await api.importFiles([filePath])
              if (r?.imported?.length) imported++
            } catch (err2) {
              console.error('[importer] importFiles fallback failed:', String(err2))
              if (!_downloadMinimized) setProgress(0, `Error: ${msg.slice(0, 80)}`)
            }
          }
        }
      }
      return imported
    }

    if (_downloadMinimized) {
      if (paths.length) {
        const imported = await finalize()
        if (imported > 0) store.emit(events.GRID_RELOAD)
      }
      _activeRingTask?.finish()
      _activeRingTask = null
      sfx.success()
      return
    }

    if (paths.length) {
      setProgress(0.98, 'Saving to library…')
      const imported = await finalize()
      if (imported > 0) {
        store.emit(events.GRID_RELOAD)
        setProgress(1, 'Done')
        sfx.success()
      }
    } else {
      setProgress(1, 'Download complete')
      sfx.success()
    }

    setTimeout(() => { if (_isOpen) closeModal() }, 1400)
  })

  const hError = store.on(events.DOWNLOAD_ERROR, payload => {
    const p = payload.downloadId ?? payload.download_id
    if (downloadId && p !== downloadId) return
    cleanup()

    if (_downloadMinimized) {
      if (_downloadCancelled) _activeRingTask?.fail('Cancelled')
      else _activeRingTask?.fail(payload.message ?? 'Download failed')
      _activeRingTask = null
      return
    }

    if (!_downloadCancelled) setProgress(0, `Error: ${payload.message ?? 'download failed'}`)
  })

  function cleanup() {
    store.off(events.DOWNLOAD_PROGRESS, hProgress)
    store.off(events.DOWNLOAD_COMPLETE, hComplete)
    store.off(events.DOWNLOAD_ERROR,    hError)
    _activeDownloadId = null
  }

  try {
    downloadId = await api.downloadUrl(url, '')
    _activeDownloadId = downloadId
  } catch (err) {
    cleanup()
    setProgress(0, `Error: ${err}`)
  }
}

// ─── Progress helpers ────────────────────────────────────────────
function setProgress(pct, label, indeterminate = false) {
  const fillEl  = _modal.querySelector('#import-progress-fill')
  const labelEl = _modal.querySelector('#import-progress-label')
  if (fillEl) {
    fillEl.style.width = `${Math.round(pct * 100)}%`
    fillEl.classList.toggle('import-progress-fill--indeterminate', indeterminate)
  }
  if (labelEl) labelEl.textContent = label
}
