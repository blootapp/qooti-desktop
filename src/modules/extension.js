import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { makeLogger, createOp } from './logger.js'

const log = makeLogger('ExtBridge')

export function init() {
  store.on(events.EXTENSION_ITEM_RECEIVED,     handleItem)
  store.on(events.EXTENSION_ADD_TO_COLLECTION, handleAddToCollection)
  store.on(events.EXT_SAVE_QUEUED, ({ queued_count, used, limit }) => {
    store.emit(events.SYSTEM_TOAST, {
      type: 'info',
      message: `Daily limit reached (${used}/${limit}). Link saved — downloads resume at midnight.`,
      duration: 6000,
    })
  })
}

async function handleItem(payload) {
  const { url, type, file_path, _ext_id, title, importSource } = payload
  const op = createOp()
  log.info('item_received', { type, has_url: !!url, has_file: !!file_path, ext_id: _ext_id }, op)
  try {
    if (type === 'link') {
      const downloadId = await api.downloadUrl(url, 'link', _ext_id ?? null)
      log.info('download_queued', { downloadId }, op)
      store.emit(events.DOWNLOAD_STARTED, {
        downloadId,
        url,
        quality: 'link',
        importSource: importSource ?? 'extension',
      })
      await trackDownload(downloadId, url, _ext_id ?? null, title ?? null)
      return
    }

    if (file_path) {
      await api.importFiles([file_path], importSource ?? null)
      store.emit(events.GRID_RELOAD, {})
      return
    }

    if (!url) return
    const quality = await getDefaultQuality()
    const downloadId = await api.downloadUrl(url, quality, _ext_id ?? null)
    log.info('download_queued', { downloadId, quality }, op)
    store.emit(events.DOWNLOAD_STARTED, {
      downloadId,
      url,
      quality,
      importSource: importSource ?? 'extension',
    })
    await trackDownload(downloadId, url, _ext_id ?? null)
  } catch (err) {
    const msg = err?.message ?? ''
    // Auth failure with no extension cookies already tried — delegate to the extension
    // so it can retry using the browser's live session cookies (e.g. Instagram, TikTok).
    // Skip if _ext_id is set: cookies were already provided and still failed, retrying
    // would loop forever.
    const isAuthErr = msg.includes('extension') || msg.includes('login') ||
      msg.includes('Instagram') || msg.includes('TikTok') ||
      msg.includes('logged-in') || msg.includes('browser session')
    if (isAuthErr && url && !_ext_id) {
      api.queueExtDownload(url).catch(e => log.warn('queue_ext_download_failed', { error: e }, op))
      log.info('delegated_to_extension', { url }, op)
    } else {
      log.error('item_failed', { error: err }, op)
    }
  }
}

function trackDownload(downloadId, url, extId = null, itemTitle = null) {
  return new Promise((resolve, reject) => {
    let onDone, onErr

    onDone = store.on(events.DOWNLOAD_COMPLETE, async payload => {
      if (payload.download_id !== downloadId) return
      store.off(events.DOWNLOAD_COMPLETE, onDone)
      store.off(events.DOWNLOAD_ERROR,    onErr)

      const allPaths = Array.isArray(payload.paths)
        ? payload.paths
        : (payload.paths ? [payload.paths] : [])

      let imported = 0
      try {
        for (const p of allPaths) {
          try {
            await api.finalizeDownload(p, url ?? null, extId, itemTitle)
            imported++
          } catch (err) {
            if (!String(err).includes('duplicate')) {
              log.error('finalize_error', { error: err, path: p })
            }
          }
        }
      } finally {
        // Error is the default outcome — only suppress it if at least one file
        // was imported.  This covers: empty paths, all-failing finalizeDownload
        // calls, and unexpected throws.  The Rust watchdog is a belt-and-suspenders
        // backstop if this call itself somehow never fires.
        if (imported > 0) {
          store.emit(events.GRID_RELOAD, {})
        } else if (extId) {
          try { await api.setExtProgressError(extId) } catch {}
        }
      }
      resolve()
    })

    onErr = store.on(events.DOWNLOAD_ERROR, payload => {
      if (payload.download_id !== downloadId) return
      store.off(events.DOWNLOAD_COMPLETE, onDone)
      store.off(events.DOWNLOAD_ERROR,    onErr)
      reject(new Error(payload.message ?? 'Download failed'))
    })
  })
}

async function handleAddToCollection({ inspiration_id, collection_id }) {
  if (!inspiration_id || !collection_id) return
  try {
    await api.addToCollection(collection_id, inspiration_id)
  } catch (err) {
    log.error('add_to_collection_failed', { inspiration_id, collection_id, error: err })
  }
}

async function getDefaultQuality() {
  try {
    const settings = await api.getSettings()
    return settings.video_quality ?? 'best'
  } catch {
    return 'best'
  }
}
