// Diagnostics for the feedback feature. Instead of dumping raw console output
// (which doesn't tell you what the user was doing), we build a human-readable
// ACTIVITY TRAIL from the app's own event bus — searches, downloads, imports,
// navigation, setting changes, etc. — plus a small errors/warnings buffer. The
// trail is attached to feedback as a .txt file so the Telegram message stays clean.
import { listen } from '@tauri-apps/api/event'
import { api } from './tauri-api.js'
import { getSetting } from './settings.js'
import store from './store.js'
import * as events from './events.js'

const MAX_ACTIONS = 140
const MAX_ERRORS  = 60
const _actions = []
const _errors  = []

const clock = () => new Date().toISOString().slice(11, 19)

function action(text) {
  if (!text) return
  _actions.push(`${clock()}  ${text}`)
  if (_actions.length > MAX_ACTIONS) _actions.splice(0, _actions.length - MAX_ACTIONS)
}

function errline(level, text) {
  _errors.push(`${clock()}  ${level}  ${text}`)
  if (_errors.length > MAX_ERRORS) _errors.splice(0, _errors.length - MAX_ERRORS)
}

/** Record a manual breadcrumb from anywhere that the event bus doesn't cover. */
export function logAction(text) { action(text) }

function fmt(args) {
  return args.map(a =>
    a instanceof Error      ? (a.stack || a.message)
    : typeof a === 'object' ? safeStringify(a)
    :                         String(a)
  ).join(' ')
}
function safeStringify(o) { try { return JSON.stringify(o) } catch { return String(o) } }
function short(s, n = 70) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s }

let _installed = false

/** Install the activity trail + error capture. Call once, early in boot. */
export function initDiagnostics() {
  if (_installed) return
  _installed = true
  action('app launched')

  // Capture errors/warnings only — enough to debug a crash without the noise.
  const origErr  = console.error ? console.error.bind(console) : () => {}
  const origWarn = console.warn  ? console.warn.bind(console)  : () => {}
  console.error = (...a) => { errline('ERROR', fmt(a)); origErr(...a) }
  console.warn  = (...a) => { errline('WARN',  fmt(a)); origWarn(...a) }
  window.addEventListener('error', e =>
    errline('ERROR', `Uncaught ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`))
  window.addEventListener('unhandledrejection', e =>
    errline('ERROR', `Unhandled rejection: ${e.reason?.message ?? e.reason}`))

  // PO-token provider steps (emitted from Rust) — so feedback reports reveal exactly
  // where the YouTube provider setup fails on a user's machine.
  listen('pot:diag', e => action(`POT: ${e.payload}`)).catch(() => {})

  bindActivityTrail()
}

// Turn the events the app already emits into plain-English breadcrumbs.
function bindActivityTrail() {
  const on = (evt, fn) => store.on(evt, fn)

  on(events.NAV_CHANGE,           ({ view } = {})        => action(`opened ${view}`))
  on(events.SEARCH_QUERY_CHANGED, ({ query } = {})       => { if (query?.trim()) action(`searched "${short(query.trim(), 40)}"`) })
  on(events.SEARCH_COLOR_CHANGED, ({ hex } = {})         => action(hex ? `color search ${hex}` : 'cleared color search'))
  on(events.TAG_FILTER_CHANGED,   ({ tagIds } = {})      => action(`filtered by ${tagIds?.length || 0} tag(s)`))
  on(events.CARD_OPEN,            ({ item } = {})         => action(`opened item detail${item?.type ? ` (${item.type})` : ''}`))
  on(events.COLLECTION_SELECTED,  ()                     => action('opened a collection'))
  on(events.COLLECTION_CREATED,   ({ collection } = {})  => action(`created collection "${short(collection?.name, 30)}"`))
  on(events.COLLECTION_DELETED,   ()                     => action('deleted a collection'))
  on(events.IMPORT_REQUESTED,     ()                     => action('clicked import'))
  on(events.FILES_DROPPED,        ({ paths } = {})       => action(`dropped ${paths?.length || 0} file(s)`))
  on(events.FILES_IMPORTING,      ({ total } = {})       => action(`importing ${total ?? '?'} file(s)`))
  on(events.FILES_IMPORTED,       ({ imported, skipped } = {}) => action(`imported ${imported ?? 0}, skipped ${skipped ?? 0}`))
  on(events.GRID_ITEM_DELETED,    ()                     => action('deleted an item'))
  on(events.TAG_CREATED,          ({ tag } = {})         => action(`added tag "${short(tag?.name, 30)}"`))
  on(events.DOWNLOAD_STARTED,     ({ url, quality } = {})=> action(`download started: ${short(url)} (${quality ?? '—'})`))
  on(events.DOWNLOAD_COMPLETE,    ()                     => action('download complete'))
  on(events.DOWNLOAD_ERROR,       ({ message } = {})     => action(`download error: ${short(message, 80)}`))
  on(events.SETTINGS_CHANGED,     ({ key, value } = {})  => action(`setting ${key} = ${short(value, 30)}`))
  on(events.UPDATE_AVAILABLE,     ({ version } = {})     => action(`update available: ${version}`))
  on(events.LICENSE_STATUS_CHANGED, ({ plan } = {})      => action(`license → ${plan ?? '—'}`))
  on(events.EXTENSION_ITEM_RECEIVED, ()                  => action('extension saved an item'))
  on(events.MILESTONE_ACHIEVED,   ({ milestone } = {})   => action(`milestone: ${short(milestone?.title, 40) || 'achieved'}`))
  on(events.SESSION_EXPIRED,      ()                     => action('session expired'))
  on(events.SYSTEM_TOAST,         ({ type, message } = {}) => { if (type === 'error' || type === 'warning') action(`⚠ ${type}: ${short(message, 80)}`) })
}

/** The plain-text activity + errors trail attached to a feedback report. */
export function buildActivityTrail() {
  const out = []
  out.push('── Recent activity (oldest first) ──')
  out.push(_actions.length ? _actions.join('\n') : '(no activity recorded)')
  out.push('')
  out.push('── Errors & warnings ──')
  out.push(_errors.length ? _errors.join('\n') : '(none)')
  return out.join('\n')
}

/** One-shot diagnostics snapshot to attach to a feedback message. */
export async function gatherDiagnostics() {
  const [appInfo, vaultInfo] = await Promise.all([
    api.getAppInfo().catch(() => null),
    api.getVaultInfo().catch(() => null),
  ])
  return {
    public_id:   getSetting('bloot_id') || '',
    app_version: appInfo?.version ?? '—',
    platform:    appInfo?.platform ?? '—',
    items_total: vaultInfo?.total_items ?? null,
    activity:    buildActivityTrail(),
  }
}
