// Tag suggestions: the glue between the Rust tagger and the views (spec §7).
//
// Everything that reads and scores lives in Rust now: the indexer stores CLIP vectors
// (one per picture, one per second of a video: 8 to 32), lens files carry their concept vectors, and
// tagging.rs writes each item's suggestions to the lens_suggestions column (the page reads them
// as item.auto_tag_confidence; the old column of that name is emptied at start). This module only:
//  • bridges the backend's events into the store:
//      autotag:scored → AUTO_TAG_BATCH_DONE { ids, processed }
//      lens:changed   → LENS_CHANGED {}        (lenses.js reloads, then emits LENS_LOADED)
//      lens:status    → LENS_STATUS { … }      (Settings › Library › Tag lens shows the progress;
//                                               sent only while it watches: lens_status_watch)
//  • wakes the indexer when items are added or imported, so new items get suggestions
//    without waiting out its idle pause;
//  • runs the Tag lens catalogue check at most once every 7 days while suggestions are on.
// Labels, the display rule and the check itself are in lenses.js.

import store from './store.js'
import * as events from './events.js'
import { api, listenEvent } from './tauri-api.js'
import { makeLogger } from './logger.js'
import { keyLabel, suggestionsOn, checkForLensUpdates } from './lenses.js'

const log = makeLogger('AutoTag')

const WAKE_DEBOUNCE_MS = 1500            // a burst of imports wakes the indexer once
const FIRST_CHECK_MS   = 20_000          // the lens check waits until start-up has settled…
const CHECK_TICK_MS    = 60 * 60 * 1000  // …then looks once an hour whether 7 days have passed

/**
 * The label of a stored suggestion key (a concept id or `col:<tag id>`) in the app's
 * language; '' when it is unknown (a key is an id and never shows as it is). Kept for
 * existing callers; new code uses lenses.js (keyLabel, tagLabel).
 */
export function getTagLabel(id, lang) {
  return keyLabel(id, lang)
}

let _inited    = false
let _wakeTimer = null

function wakeSoon() {
  if (!suggestionsOn()) return   // the indexer only reads videos and scores while they're on
  clearTimeout(_wakeTimer)
  _wakeTimer = setTimeout(() => {
    api.taggingWake().catch(err => log.debug('wake_failed', { error: err }))
  }, WAKE_DEBOUNCE_MS)
}

// Without force: runs only while suggestions are on and 7 days have passed (lenses.js)
function dailyCheck() {
  checkForLensUpdates()
    .then(result => { if (result === 'updated') log.info('lenses_updated', {}) })
    .catch(err => log.warn('lens_check_failed', { error: err }))
}

function bridge(name, handler) {
  listenEvent(name, handler).catch(err => log.warn('listen_failed', { event: name, error: err }))
}

// ─── Entry point (main.js, after initSettings) ───────────────────
export function initAutoTag() {
  if (_inited) return
  _inited = true

  // Backend → store. In the browser preview listenEvent does nothing: mock.js emits these.
  bridge('autotag:scored', e => {
    const ids = Array.isArray(e?.payload?.ids) ? e.payload.ids : []
    if (ids.length) store.emit(events.AUTO_TAG_BATCH_DONE, { ids, processed: ids.length })
  })
  bridge('lens:changed', () => store.emit(events.LENS_CHANGED, {}))
  bridge('lens:status',  e => store.emit(events.LENS_STATUS, e?.payload ?? {}))

  // New items: imports, downloads and extension saves all end in a grid reload
  store.on(events.GRID_ITEM_ADDED, wakeSoon)
  store.on(events.FILES_IMPORTED,  wakeSoon)
  store.on(events.GRID_RELOAD,     wakeSoon)

  // Suggestions just turned on (Settings, or the role step): the check may be due
  store.on(events.SETTINGS_CHANGED, p => {
    if (p?.key === 'tag_recommendations_enabled' && suggestionsOn()) dailyCheck()
  })
  setTimeout(dailyCheck, FIRST_CHECK_MS)
  setInterval(dailyCheck, CHECK_TICK_MS)
}
