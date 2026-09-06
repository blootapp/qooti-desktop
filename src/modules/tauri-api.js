// All Tauri IPC lives here. Modules never call invoke() or listen() directly.
// When running in a plain browser (no Tauri), mockApi from mock.js is used instead.
// See architecture §18.3.

import { mockApi } from './mock.js'
import { makeLogger } from './logger.js'

const log = makeLogger('IPC')

// ─── Environment detection ───────────────────────────────────────
const IS_TAURI = '__TAURI_INTERNALS__' in window

let _invoke  = null
let _listen  = null

// Lazy-load Tauri modules so the bundle doesn't error in browser
async function loadTauri() {
  const core  = await import('@tauri-apps/api/core')
  const event = await import('@tauri-apps/api/event')
  const raw   = core.invoke
  _invoke = (cmd, args) => {
    const t0 = performance.now()
    log.debug('call', { cmd })
    return raw(cmd, args).then(
      r  => { log.debug('ok', { cmd, ms: Math.round(performance.now() - t0) }); return r },
      e  => { log.warn('fail', { cmd, error: String(e) }); throw e }
    )
  }
  _listen = event.listen
}

import store from './store.js'
import * as events from './events.js'

// ─── Init (call once in main.js boot) ───────────────────────────
export async function initTauriApi() {
  if (!IS_TAURI) {
    // Browser / Vite dev mode — use mock
    return mockApi.getAppInfo()
  }

  await loadTauri()

  await _listen('extension-item-received', e => {
    store.emit(events.EXTENSION_ITEM_RECEIVED, e.payload)
  })

  await _listen('extension-add-to-collection', e => {
    store.emit(events.EXTENSION_ADD_TO_COLLECTION, e.payload)
  })

  await _listen('extension-server-failed', () => {
    store.emit(events.SYSTEM_TOAST, {
      type: 'error',
      message: 'Port 1420 is in use — the browser extension won\'t work. Restart qooti to fix.',
      duration: 10000,
    })
  })

  await _listen('ext-pref-changed', e => {
    store.emit(events.SETTINGS_CHANGED, e.payload)
  })

  await _listen('license-status-push', e => {
    store.emit(events.LICENSE_PUSH_RECEIVED, e.payload)
  })

  await _listen('ext-save-queued', e => {
    store.emit(events.EXT_SAVE_QUEUED, e.payload)
  })

  await _listen('tauri://drag-drop', e => {
    const paths = e.payload?.paths ?? []
    if (paths.length) store.emit(events.FILES_DROPPED, { paths })
  })

  // Mobile: phone pinged desktop — track last-seen timestamp
  await _listen('mobile-connected', e => {
    _lastMobileSeen = e.payload?.ts ?? Date.now()
    store.emit(events.MOBILE_CONNECTED, { ts: _lastMobileSeen })
  })

  // Mobile: queued links — buffered until user approves sync on desktop
  await _listen('mobile-queue-received', e => {
    const items = (e.payload?.items ?? []).filter(i => i.url)
    if (!items.length) return
    _mobileInbox.push(...items)
    store.emit(events.MOBILE_ITEMS_PENDING, { count: _mobileInbox.length })
  })

  // Mobile: uploaded file (photo/video sent directly from phone gallery)
  await _listen('mobile-file-received', e => {
    const { path } = e.payload ?? {}
    if (path) store.emit(events.EXTENSION_ITEM_RECEIVED, { file_path: path, type: 'file', _ext_id: null, importSource: 'mobile' })
  })

  return _invoke('get_app_info')
}

// ─── Build the real invoke-based api ────────────────────────────
const tauriApi = {
  getAppInfo:    () => _invoke('get_app_info'),
  getSettings:   () => _invoke('get_settings'),
  setSetting:    (key, value) => _invoke('set_setting', { key, value }),

  windowMinimize: () => _invoke('window_minimize'),
  windowMaximize: () => _invoke('window_maximize'),
  windowClose:    () => _invoke('window_close'),

  getAutostart:   ()        => _invoke('get_autostart'),
  setAutostart:   (enabled) => _invoke('set_autostart', { enabled }),

  listInspirations:   (opts = {}) => _invoke('list_inspirations', { opts }),
  getInspiration:     id          => _invoke('get_inspiration', { id }),
  updateInspiration:  (id, fields) => _invoke('update_inspiration', { id, ...fields }),
  deleteInspiration:  id          => _invoke('delete_inspiration', { id }),
  readImageAsBase64: path        => _invoke('read_image_as_base64', { path }),
  importFiles:       (paths, importSource = null) => _invoke('import_files', { paths, importSource }),

  claimOcrCandidates:         (batchSize = 10) => _invoke('claim_ocr_index_candidates', { batchSize }),
  finalizeOcrResult:          result           => _invoke('finalize_ocr_index_result', { result }),
  resetOcrStatus:             id               => _invoke('reset_ocr_status_for_inspiration', { id }),
  queueFullOcrReindex:        ()               => _invoke('queue_full_ocr_reindex'),
  getOcrStats:                ()               => _invoke('get_ocr_index_stats'),

  listCollections:                 ()                            => _invoke('list_collections'),
  createCollection:                name                         => _invoke('create_collection', { name }),
  updateCollection:                (id, fields)                 => _invoke('update_collection', { id, ...fields }),
  deleteCollection:                (id, deleteItems = false)     => _invoke('delete_collection', { id, deleteItems }),
  exportCollection:                (collectionId, savePath)     => _invoke('export_collection', { collectionId, savePath }),
  exportAllItems:                  (savePath)                   => _invoke('export_all_items', { savePath }),
  resetApp:                        ()                           => _invoke('reset_app'),
  getCollectionIdsForInspiration:  inspirationId                => _invoke('get_collection_ids_for_inspiration', { inspirationId }),
  addToCollection:                 (collectionId, inspirationId) => _invoke('add_to_collection', { collectionId, inspirationId }),
  removeFromCollection:            (collectionId, inspirationId) => _invoke('remove_from_collection', { collectionId, inspirationId }),

  listTags:               ()                      => _invoke('list_tags'),
  getTagsForInspiration:  id                      => _invoke('get_tags_for_inspiration', { inspirationId: id }),
  createTag:              (name, source)           => _invoke('create_tag', { name, source: source ?? null }),
  deleteTag:              id                      => _invoke('delete_tag', { id }),
  tagInspiration:         (inspirationId, tagId)  => _invoke('tag_inspiration', { inspirationId, tagId }),
  untagInspiration:       (inspirationId, tagId)  => _invoke('untag_inspiration', { inspirationId, tagId }),

  reindexLibrary:  () => _invoke('reindex_library'),
  extractPalette:  (id, path) => _invoke('extract_palette', { id, path }),

  getVaultInfo:    () => _invoke('get_vault_info'),
  getLicenseCache:    () => _invoke('get_license_cache'),
  clearLicenseCache:  () => _invoke('clear_license_cache'),
  updateLicensePlan:  planType => _invoke('update_license_plan', { planType }),
  listMilestones:  () => _invoke('list_milestones'),

  getNotifications:      ()  => _invoke('get_notifications'),
  markNotificationRead:  id  => _invoke('mark_notification_read', { id }),


  getMobileConnectionQr: () => _invoke('get_mobile_connection_qr'),

  claimAutoTagCandidates: (batchSize = 4)                    => _invoke('claim_auto_tag_candidates', { batchSize }),
  finalizeAutoTagResult:  (id, confidence, model, status)    => _invoke('finalize_auto_tag_result', { id, confidence, model, status }),

  listTagVocab:     ()                                          => _invoke('list_tag_vocab'),
  upsertTagVocab:   (id, labelsJson, promptsJson, builtIn, sortOrder) =>
    _invoke('upsert_tag_vocab', { id, labelsJson, promptsJson, builtIn, sortOrder }),
  deleteTagVocab:   (id)                                        => _invoke('delete_tag_vocab', { id }),
  resetAllAutoTags: ()                                          => _invoke('reset_all_auto_tags'),
  copyFileToFolder:     (path, destDir)                         => _invoke('copy_file_to_folder', { path, destDir }),
  copyFileToClipboard:  path                                    => _invoke('copy_file_to_clipboard', { path }),
  revealInFolder:       path                                    => _invoke('reveal_in_folder', { path }),

  downloadUrl:           (url, quality, extId = null) => _invoke('download_url', { url, quality, extId }),
  finalizeDownload:      (path, url, extId = null, title = null) => _invoke('finalize_download', { path, url: url ?? null, extId, title }),
  cancelDownload:        downloadId => _invoke('cancel_download', { downloadId }),
  setExtProgressError:   extId      => _invoke('set_ext_progress_error', { extId }),

  logFailedDownload:       (id, url, quality, importSource, status, errorMsg, filename) =>
    _invoke('log_failed_download', { id, url, quality, importSource, status, errorMsg: errorMsg ?? null, filename: filename ?? null }),
  clearFailedDownload:     id => _invoke('clear_failed_download', { id }),
  clearAllFailedDownloads: () => _invoke('clear_all_failed_downloads'),
  listActivity:            (limit = 200) => _invoke('list_activity', { limit }),
  queueExtDownload:        url           => _invoke('queue_ext_download', { url }),

  analyzeImportSource:   path                => _invoke('analyze_import_source', { path }),
  extractImportArchive:  (path, sourceType)  => _invoke('extract_import_archive', { path, sourceType }),
  importQooTiPack:       path                => _invoke('import_qooti_pack', { path }),
  fetchYoutubeThumbnail: url                 => _invoke('fetch_youtube_thumbnail', { url }),

  trackView:                    id    => _invoke('track_view', { id }),
  applyCollectionTagSuggestions: ()   => _invoke('apply_collection_tag_suggestions'),
  listRediscover:               (limit = 20) => _invoke('list_rediscover', { limit }),
  listBecauseYouViewed:         (limit = 20) => _invoke('list_because_you_viewed', { limit }),
  listHaventSeen:               (limit = 20) => _invoke('list_havent_seen', { limit }),

  checkUrlExists: url => _invoke('check_url_exists', { url }),
  saveThumbnail:  (id, bytes) => _invoke('save_thumbnail', { id, bytes }),
  applyUpdate:    ()         => _invoke('apply_update'),
  getFreePlanInfo: ()        => _invoke('get_free_plan_info'),

  openUrl: async url => {
    const { open } = await import('@tauri-apps/plugin-shell')
    return open(url)
  },

  getVaultInfo:    ()                          => _invoke('get_vault_info'),
  pickVaultFolder: ()                          => _invoke('pick_vault_folder'),
  pickCookiesFile: ()                          => _invoke('pick_cookies_file'),
  relocateVault:   (newPath, migrate)          => _invoke('relocate_vault', { newPath, migrate }),

}

// ─── Download event bridge ───────────────────────────────────────
// Re-emits Tauri backend events into the app's store event bus.
export async function initDownloadListeners() {
  if (!IS_TAURI) return
  if (!_listen) await loadTauri()
  await _listen('download:queued', e => {
    store.emit(events.DOWNLOAD_QUEUED, e.payload)
  })
  await _listen('download:filename', e => {
    store.emit(events.DOWNLOAD_FILENAME, e.payload)
  })
  await _listen('download:progress', e => {
    store.emit(events.DOWNLOAD_PROGRESS, e.payload)
  })
  await _listen('download:complete', e => {
    store.emit(events.DOWNLOAD_COMPLETE, e.payload)
  })
  await _listen('download:error', e => {
    store.emit(events.DOWNLOAD_ERROR, e.payload)
  })
  await _listen('update-available', e => {
    store.emit(events.UPDATE_AVAILABLE, e.payload)
  })
  await _listen('extension:open-item', async e => {
    const { inspiration_id } = e.payload
    if (!inspiration_id) return
    try {
      const item = await _invoke('get_inspiration', { id: inspiration_id })
      if (item) store.emit(events.CARD_OPEN, { item })
    } catch {}
  })
}

// ─── Exported api object ─────────────────────────────────────────
// Points to real Tauri API when inside the shell, mock otherwise.
export const api = IS_TAURI ? tauriApi : mockApi

// ─── Mobile inbox ─────────────────────────────────────────────────
// Items received from the phone are held here until the user approves sync.
const _mobileInbox = []
export function popMobileInbox() {
  const items = [..._mobileInbox]
  _mobileInbox.length = 0
  return items
}
export function mobileInboxCount() { return _mobileInbox.length }

// ─── Mobile connection tracking ──────────────────────────────────
// Timestamp (ms) of the last /mobile/ping from the phone. 0 = never seen.
let _lastMobileSeen = 0
export function mobileConnectedAt() { return _lastMobileSeen }

// ─── Generic event listener ──────────────────────────────────────
// Returns an unlisten function, or a no-op in browser/mock mode.
export async function listenEvent(event, handler) {
  if (!IS_TAURI) return () => {}
  if (!_listen) await loadTauri()
  return _listen(event, handler)
}
