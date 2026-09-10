// All valid store event names — import from here, never hardcode strings.
// Convention: module:action (all lowercase, colon separator).
// See architecture §18.2.

// ─── Navigation ──────────────────────────────────────────────────
export const NAV_CHANGE  = 'nav:change'   // { view: string }
export const NAVIGATE    = 'nav:navigate' // { view: string } — imperative navigate request

// ─── Grid / inspirations ─────────────────────────────────────────
export const GRID_RELOAD      = 'grid:reload'      // { collectionId?, tagIds?, query? }
export const GRID_ITEM_ADDED  = 'grid:item-added'  // { inspiration: Inspiration }
export const GRID_ITEM_DELETED = 'grid:item-deleted' // { id: string }
export const GRID_ITEM_UPDATED = 'grid:item-updated' // { inspiration: Inspiration }

// ─── Collections ─────────────────────────────────────────────────
export const COLLECTION_CREATED = 'collection:created' // { collection }
export const COLLECTION_UPDATED = 'collection:updated' // { collection }
export const COLLECTION_DELETED = 'collection:deleted' // { id }
export const COLLECTION_SELECTED = 'collection:selected' // { id }

// ─── Tags ────────────────────────────────────────────────────────
export const TAG_CREATED        = 'tag:created'        // { tag }
export const TAG_DELETED        = 'tag:deleted'        // { id }
export const TAG_FILTER_CHANGED = 'tag:filter-changed' // { tagIds: string[] }

// ─── Search ──────────────────────────────────────────────────────
export const SEARCH_QUERY_CHANGED = 'search:query-changed' // { query: string }
export const SEARCH_COLOR_CHANGED = 'search:color-changed' // { hex: string | null, tolerance?: 'strict'|'normal'|'broad' }

// ─── OCR ─────────────────────────────────────────────────────────
export const OCR_BATCH_DONE   = 'ocr:batch-done'   // { processed: number }
export const OCR_PAUSED       = 'ocr:paused'
export const OCR_RESUMED      = 'ocr:resumed'
export const OCR_STATS_UPDATED = 'ocr:stats-updated' // { total, done, pending, failed }

// ─── File import ─────────────────────────────────────────────────
export const FILES_DROPPED    = 'files:dropped'    // { paths: string[] } — OS drag-drop onto window
export const FILES_IMPORTING  = 'files:importing'  // { total: number }
export const FILES_IMPORTED   = 'files:imported'   // { imported: number, skipped: number }
export const IMPORT_REQUESTED = 'import:requested' // — top-bar import button clicked
export const QOOTI_FILE_OPEN  = 'qooti:file-open'  // { path } — a .qooti opened via double-click / OS "Open with"

// ─── Extension ───────────────────────────────────────────────────
export const EXTENSION_ITEM_RECEIVED     = 'extension:item-received'      // payload from extension
export const EXTENSION_ADD_TO_COLLECTION = 'extension:add-to-collection'  // { inspiration_id, collection_id }

// ─── Mobile ───────────────────────────────────────────────────────
export const MOBILE_ITEMS_PENDING = 'mobile:items-pending'  // { count } — items waiting in mobile inbox
export const MOBILE_CONNECTED     = 'mobile:connected'      // { ts: number } — mobile pinged desktop

// ─── License ─────────────────────────────────────────────────────
export const LICENSE_STATUS_CHANGED  = 'license:status-changed' // { plan, expiresAt, ... }
export const LICENSE_EXPIRED         = 'license:expired'
export const LICENSE_PUSH_RECEIVED   = 'license:push-received'
export const LICENSE_MANUAL_REFRESH  = 'license:manual-refresh'

// ─── Notifications ───────────────────────────────────────────────
export const NOTIFICATION_NEW  = 'notification:new'  // { notification }
export const NOTIFICATION_READ = 'notification:read' // { id }

// ─── Milestones ──────────────────────────────────────────────────
export const MILESTONE_ACHIEVED = 'milestone:achieved' // { milestone }

// ─── Settings ────────────────────────────────────────────────────
export const SETTINGS_CHANGED = 'settings:changed' // { key, value }

// ─── Auto-tagging ────────────────────────────────────────────────
export const AUTO_TAG_BATCH_DONE  = 'autotag:batch-done'   // { processed: number, ids: string[] }
export const TAG_VOCAB_CHANGED    = 'autotag:vocab-changed' // vocab dictionary updated

// ─── Downloader ──────────────────────────────────────────────────
export const DOWNLOAD_STARTED  = 'download:started'   // { downloadId, url, quality, importSource }
export const DOWNLOAD_QUEUED   = 'download:queued'    // { downloadId } — waiting behind another download
export const DOWNLOAD_FILENAME = 'download:filename'  // { downloadId, filename } — real name from yt-dlp
export const DOWNLOAD_PROGRESS = 'download:progress'  // { downloadId, pct, speed }
export const DOWNLOAD_COMPLETE = 'download:complete'  // { downloadId, path }
export const DOWNLOAD_ERROR    = 'download:error'     // { downloadId, message }
export const DOWNLOADS_CHANGED = 'downloads:changed'  // — tracker list mutated, re-render

// ─── Card detail ─────────────────────────────────────────────────
export const CARD_OPEN = 'card:open' // { item: Inspiration } — open detail modal for a specific item

// ─── Free plan ───────────────────────────────────────────────────
export const EXT_SAVE_QUEUED = 'ext:save-queued' // { queued_count, used, limit }

// ─── System ──────────────────────────────────────────────────────
export const SYSTEM_TOAST    = 'system:toast'    // { type: 'info'|'warning'|'error', message: string, duration?: number }
export const UPDATE_AVAILABLE = 'update:available' // { version: string, notes: string }
export const SESSION_EXPIRED = 'session:expired'  // user deleted on server — must re-login
