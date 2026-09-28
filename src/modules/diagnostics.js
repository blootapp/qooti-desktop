// Diagnostics for the feedback feature.
//
// A feedback report is one plain-text file (attached to the Telegram message by the
// worker) that should let us fix a bug without a back-and-forth:
//   Summary      — problems detected automatically (crash last time, errors, failed
//                  downloads, low disk, missing files, bad install location, …)
//   System, storage, library health, helper tools, account/settings, failed downloads
//                — from the backend's diagnostics_snapshot (diagnostics.rs)
//   Timeline     — this session's backend log with the app's own lines woven in
//                  (user actions, console warnings/errors, slow calls, UI freezes)
//   Previous run — the last lines of the previous session's log, in full if it
//                  ended unexpectedly (logger.rs keeps it on disk)
//
// Frontend lines are forwarded (batched, rate-limited) into the backend log, so the
// log file on disk is a single timeline that also survives a crash of the webview.
// Before sending, paths under the home folder become "~", and anything that looks
// like a key/token/email or a signed URL query is removed.
import { listen } from '@tauri-apps/api/event'
import { api } from './tauri-api.js'
import { getSetting } from './settings.js'
import store from './store.js'
import * as events from './events.js'

const IS_TAURI = '__TAURI_INTERNALS__' in window

const MAX_ACTIONS = 140
const MAX_ERRORS  = 60
const REPORT_BUDGET = 58_000       // the worker keeps the first 60k chars of `activity`
const _actions = []
const _errors  = []
let _currentView = 'grid'

const clock = () => new Date().toISOString().slice(11, 19)

// ─── Forwarding to the backend log ────────────────────────────────
const FLUSH_MS = 1500
const MAX_LINES_PER_MIN = 150
const _outbox = []
let _flushTimer = null
let _minuteStart = Date.now(), _minuteCount = 0, _suppressed = 0
let _last = null, _lastRepeats = 0

function forward(level, target, msg) {
  if (!IS_TAURI || !msg) return
  if (msg.includes('log_frontend')) return          // never log our own transport
  // Collapse identical consecutive lines (render loops, retry storms).
  const key = `${level}|${target}|${msg}`
  if (key === _last) { _lastRepeats++; return }
  if (_lastRepeats) _outbox.push(['info', 'Diag', `(previous line repeated ${_lastRepeats}×)`])
  _last = key; _lastRepeats = 0

  const now = Date.now()
  if (now - _minuteStart > 60_000) {
    if (_suppressed) _outbox.push(['warn', 'Diag', `${_suppressed} app log line(s) dropped (rate limit)`])
    _minuteStart = now; _minuteCount = 0; _suppressed = 0
  }
  if (++_minuteCount > MAX_LINES_PER_MIN && level !== 'error') { _suppressed++; return }
  _outbox.push([level, target, msg])
  if (!_flushTimer) _flushTimer = setTimeout(flushLog, FLUSH_MS)
}

/** Send buffered app lines to the backend log now (before a report is built). */
export async function flushLog() {
  clearTimeout(_flushTimer); _flushTimer = null
  if (_lastRepeats) { _outbox.push(['info', 'Diag', `(previous line repeated ${_lastRepeats}×)`]); _lastRepeats = 0; _last = null }
  if (!_outbox.length) return
  const batch = _outbox.splice(0, _outbox.length)
  try { await api.logFrontend(batch) } catch { /* backend unavailable — lines stay in the in-memory buffers */ }
}

// ─── Breadcrumbs + console capture ────────────────────────────────
function action(text, { fwd = true } = {}) {
  if (!text) return
  _actions.push(`${clock()}  ${text}`)
  if (_actions.length > MAX_ACTIONS) _actions.splice(0, _actions.length - MAX_ACTIONS)
  if (fwd) forward('info', 'Activity', text)
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

// Lines from logger.js look like "[ISO] [LEVEL] [Module] message"; keep the module as
// the log target and drop the duplicate timestamp.
const STRUCTURED = /^\[[^\]]+\] \[(DEBUG|INFO|WARN|ERROR)\] \[([^\]]+)\] ([\s\S]*)$/
function capture(level, args) {
  const text = fmt(args)
  const m = STRUCTURED.exec(text)
  if (m) forward(level, m[2], m[3])
  else   forward(level, 'Console', text)
  if (level !== 'info') errline(level.toUpperCase(), text)
}

// UI responsiveness + media that failed to load — the usual "it's slow" / "images
// don't show" reports.
const _perf = { longTasks: 0, longTotalMs: 0, worstMs: 0, worstAt: '', mediaErrors: 0, mediaExamples: [] }

function watchPerformance() {
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (e.duration < 200) continue
        _perf.longTasks++
        _perf.longTotalMs += e.duration
        if (e.duration > _perf.worstMs) { _perf.worstMs = e.duration; _perf.worstAt = clock() }
        if (e.duration >= 1000) forward('warn', 'Perf', `UI blocked for ${(e.duration / 1000).toFixed(1)} s (view: ${_currentView})`)
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch { /* not supported (WKWebView) */ }
}

function watchMediaErrors() {
  // Resource errors don't bubble — listen in the capture phase.
  window.addEventListener('error', e => {
    const el = e.target
    if (!(el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLSourceElement)) return
    const src = el.currentSrc || el.src || ''
    if (!src || src.startsWith('data:')) return
    _perf.mediaErrors++
    if (_perf.mediaExamples.length < 5 && !_perf.mediaExamples.includes(src)) {
      _perf.mediaExamples.push(src)
      forward('warn', 'Media', `failed to load ${el.tagName.toLowerCase()}: ${src}`)
    }
  }, true)
}

let _installed = false

/** Install the activity trail + error capture. Call once, early in boot. */
export function initDiagnostics() {
  if (_installed) return
  _installed = true
  action('app launched')

  const orig = level => (console[level] ? console[level].bind(console) : () => {})
  const origErr = orig('error'), origWarn = orig('warn'), origInfo = orig('info')
  console.error = (...a) => { capture('error', a); origErr(...a) }
  console.warn  = (...a) => { capture('warn',  a); origWarn(...a) }
  console.info  = (...a) => { capture('info',  a); origInfo(...a) }
  window.addEventListener('error', e => {
    if (e.target !== window && e.target instanceof Element) return   // media errors: watchMediaErrors
    const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : ''
    const text = `Uncaught ${e.message}${where}${e.error?.stack ? '\n' + e.error.stack : ''}`
    errline('ERROR', text); forward('error', 'Uncaught', text)
  })
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason
    const text = `Unhandled rejection: ${r?.message ?? safeStringify(r)}${r?.stack ? '\n' + r.stack : ''}`
    errline('ERROR', text); forward('error', 'Uncaught', text)
  })
  window.addEventListener('beforeunload', () => { flushLog() })
  watchPerformance()
  watchMediaErrors()

  // PO-token provider / download breadcrumbs from Rust. The backend already logs them,
  // so they only go to the in-memory trail (fallback when the backend log is missing).
  listen('pot:diag', e => action(`POT: ${e.payload}`, { fwd: false })).catch(() => {})
  listen('download:diag', e => action(`[download] ${e.payload}`, { fwd: false })).catch(() => {})

  bindActivityTrail()
}

// Turn the events the app already emits into plain-English breadcrumbs.
function bindActivityTrail() {
  const on = (evt, fn) => store.on(evt, fn)

  on(events.NAV_CHANGE,           ({ view } = {})        => { _currentView = view ?? _currentView; action(`opened ${view}`) })
  on(events.SEARCH_QUERY_CHANGED, ({ query } = {})       => { if (query?.trim()) action(`searched "${short(query.trim(), 40)}"`) })
  on(events.SEARCH_COLOR_CHANGED, ({ hex } = {})         => action(hex ? `color search ${hex}` : 'cleared color search'))
  on(events.TAG_FILTER_CHANGED,   ({ tagIds } = {})      => action(`filtered by ${tagIds?.length || 0} tag(s)`))
  on(events.CARD_OPEN,            ({ item } = {})         => action(`opened item detail${item?.type ? ` (${item.type}${item.source_platform ? ', ' + item.source_platform : ''})` : ''}`))
  on(events.COLLECTION_SELECTED,  ()                     => action('opened a collection'))
  on(events.COLLECTION_CREATED,   ({ collection } = {})  => action(`created collection "${short(collection?.name, 30)}"`))
  on(events.COLLECTION_DELETED,   ()                     => action('deleted a collection'))
  on(events.IMPORT_REQUESTED,     ()                     => action('clicked import'))
  on(events.FILES_DROPPED,        ({ paths } = {})       => action(`dropped ${paths?.length || 0} file(s)${paths?.length ? ' (' + [...new Set(paths.map(extOf))].join(', ') + ')' : ''}`))
  on(events.FILES_IMPORTING,      ({ total } = {})       => action(`importing ${total ?? '?'} file(s)`))
  on(events.FILES_IMPORTED,       ({ imported, skipped } = {}) => action(`imported ${imported ?? 0}, skipped ${skipped ?? 0}`))
  on(events.GRID_ITEM_DELETED,    ()                     => action('deleted an item'))
  on(events.TAG_CREATED,          ({ tag } = {})         => action(`added tag "${short(tag?.name, 30)}"`))
  on(events.DOWNLOAD_STARTED,     ({ url, quality } = {})=> action(`download started: ${short(url)} (${quality ?? '—'})`))
  on(events.DOWNLOAD_COMPLETE,    ()                     => action('download complete'))
  on(events.DOWNLOAD_ERROR,       ({ message } = {})     => action(`download error: ${short(message, 160)}`))
  on(events.SETTINGS_CHANGED,     ({ key, value } = {})  => action(`setting ${key} = ${/key|token|path|image|name/i.test(key ?? '') ? '(changed)' : short(value, 30)}`))
  on(events.UPDATE_AVAILABLE,     ({ version } = {})     => action(`update available: ${version}`))
  on(events.LICENSE_STATUS_CHANGED, ({ plan_type, plan } = {}) => action(`license → ${plan_type ?? plan ?? '—'}`))
  on(events.EXTENSION_ITEM_RECEIVED, ()                  => action('extension saved an item'))
  on(events.MILESTONE_ACHIEVED,   ({ milestone } = {})   => action(`milestone: ${short(milestone?.title, 40) || 'achieved'}`))
  on(events.SESSION_EXPIRED,      ()                     => action('session expired'))
  on(events.SYSTEM_TOAST,         ({ type, message } = {}) => { if (type === 'error' || type === 'warning') action(`⚠ ${type} toast: ${short(message, 160)}`) })
}

function extOf(p) { const m = /\.([a-z0-9]{1,5})$/i.exec(String(p)); return m ? m[1].toLowerCase() : '?' }

// ─── Report ────────────────────────────────────────────────────────

/** The app-side view of the moment: window, locale, theme, memory, responsiveness. */
function frontendInfo() {
  const mem = performance.memory
  return {
    view:      _currentView,
    window:    `${innerWidth}×${innerHeight}`,
    screen:    `${screen.width}×${screen.height} @${devicePixelRatio}x`,
    locale:    navigator.language,
    appLang:   getSetting('language') || '—',
    timezone:  (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return '—' } })(),
    utcOffset: -new Date().getTimezoneOffset() / 60,
    theme:     document.documentElement.classList.contains('theme-light') ? 'light' : 'dark',
    osTheme:   matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    online:    navigator.onLine,
    uptimeMin: Math.round(performance.now() / 60000),
    heapMb:    mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    heapLimitMb: mem ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
    domNodes:  document.getElementsByTagName('*').length,
    perf:      { ..._perf },
    userAgent: navigator.userAgent,
  }
}

// "[2026-09-29T12:34:56.789Z] [WARN] [Download] msg" (+ indented continuation lines)
const LOG_LINE = /^\[(\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d(?:\.\d+)?)Z?)\] \[(\w+)\] \[([^\]]*)\] ?(.*)$/

/** Group raw log lines into entries: { time, level, target, text } (text keeps continuation lines). */
function parseLog(lines) {
  const out = []
  // Ring entries can hold several lines (stack traces); the file has one per line.
  for (const raw of (lines ?? []).flatMap(l => l.split('\n'))) {
    const m = LOG_LINE.exec(raw)
    if (m) out.push({ date: m[1].slice(0, 10), time: m[2], level: m[3], target: m[4], text: m[5] })
    else if (out.length) out[out.length - 1].text += '\n' + raw
    else out.push({ date: '', time: '', level: 'INFO', target: '', text: raw })
  }
  return out
}

function fmtEntry(e) {
  const lvl = e.level === 'INFO' ? '    ' : e.level.padEnd(5).slice(0, 5)
  return `${e.time.padEnd(12)} ${lvl} ${e.target.padEnd(10)} ${e.text}`
}

/** Most recent entries that fit in `budget` chars, oldest first. */
function tailWithin(entries, budget) {
  const out = []
  let used = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const s = fmtEntry(entries[i])
    if (used + s.length + 1 > budget) break
    out.unshift(s); used += s.length + 1
  }
  return out
}

const isProblem = e => e.level === 'ERROR' || e.level === 'WARN'

// Same error with different ids/numbers counts as one.
const normalise = t => t.split('\n')[0].replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>').replace(/\d+/g, 'N').slice(0, 140)

function topProblems(entries, n = 3) {
  const counts = new Map()
  for (const e of entries) {
    if (e.level !== 'ERROR') continue
    const k = `${e.target}: ${normalise(e.text)}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

const gb = mb => mb == null ? '—' : `${(mb / 1024).toFixed(1)} GB`
const yesNo = v => v == null ? '—' : v ? 'yes' : 'no'
const ago = ms => {
  if (!ms) return 'never'
  const h = (Date.now() - ms) / 3_600_000
  return h < 1 ? `${Math.round(h * 60)} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`
}
const kv = obj => Object.entries(obj ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || '—'

/** Problems worth reading first, derived from everything else in the report. */
function detectProblems(snap, fe, cur, prev) {
  const p = []
  const prevInfo = snap.previous_session ?? {}
  if (prevInfo.unclean_exit) {
    const panic = prev.find(e => e.target === 'Panic')
    p.push(`Previous session ended unexpectedly (crash, force-quit or shutdown)${panic ? ` — panic: ${short(panic.text.split('\n')[0], 200)}` : ''}. Its last lines are at the end of this report.`)
  }
  const panicNow = cur.find(e => e.target === 'Panic')
  if (panicNow) p.push(`Backend panic this session: ${short(panicNow.text.split('\n')[0], 200)}`)
  const errs = cur.filter(e => e.level === 'ERROR').length, warns = cur.filter(e => e.level === 'WARN').length
  if (errs) {
    p.push(`${errs} error(s), ${warns} warning(s) this session. Most frequent:`)
    for (const [k, n] of topProblems(cur)) p.push(`    ${n}× ${k}`)
  }
  const failed = snap.downloads ?? []
  if (failed.length) p.push(`${failed.length} failed download(s) on record — latest: ${short(failed[0].error ?? failed[0].status, 180)}`)

  const st = snap.storage ?? {}, lib = snap.library ?? {}, tools = snap.tools ?? {}, os = snap.os ?? {}
  if (st.vault_exists === false) p.push('Vault folder does not exist (moved, deleted or drive disconnected).')
  else if (st.vault_writable === false) p.push('Vault folder is not writable (permissions, read-only or offline drive).')
  if (st.vault_free_mb != null && st.vault_free_mb < 2048) p.push(`Low disk space: ${gb(st.vault_free_mb)} free on the vault drive.`)
  if (lib.files_missing) p.push(`${lib.files_missing} of the ${lib.files_checked} newest items have missing files (e.g. ${lib.missing_examples?.[0] ?? '?'}).`)
  if (lib.outside_vault) p.push(`${lib.outside_vault} item(s) point outside the current vault folder (vault moved?).`)
  if (st.db_wal_mb > 200) p.push(`Database write-ahead log is ${st.db_wal_mb} MB (not being checkpointed).`)
  if (tools.ytdlp && !tools.ytdlp.present) p.push('yt-dlp is missing — downloads cannot work.')
  if (tools.ffmpeg && !tools.ffmpeg.present) p.push('ffmpeg is missing — video merging/thumbnails will fail.')
  if (tools.deno && !tools.deno.ready) p.push('YouTube JS runtime (deno) not installed yet — YouTube downloads will fetch it first (needs internet).')
  const failedEmb = lib.similar_index?.failed ?? 0
  if (failedEmb > 10) p.push(`${failedEmb} items could not be indexed for Find similar.`)
  const install = snap.app?.install ?? ''
  if (/Translocation|disk image|Downloads folder/.test(install)) p.push(`Install location problem: ${install.split(' — ')[0]}.`)
  if (os.rosetta) p.push('Running under Rosetta (Intel build on an Apple Silicon Mac).')
  if (os.ram_free_mb != null && os.ram_free_mb < 700) p.push(`Low free memory: ${os.ram_free_mb} MB.`)
  if (!fe.online) p.push('The device reported being offline.')
  const lic = snap.license
  if (lic?.revoked) p.push('License is revoked.')
  else if (lic?.last_validated_at && Date.now() - lic.last_validated_at > 7 * 86_400_000) p.push(`License not validated for ${ago(lic.last_validated_at)} (offline or blocked?).`)
  if (fe.perf.worstMs >= 1000) p.push(`UI froze ${fe.perf.longTasks} time(s) (worst ${(fe.perf.worstMs / 1000).toFixed(1)} s at ${fe.perf.worstAt}).`)
  if (fe.perf.mediaErrors) p.push(`${fe.perf.mediaErrors} image/video file(s) failed to load in the app.`)
  const upd = [..._actions].reverse().find(a => a.includes('update available'))
  if (upd) p.push(`An update was available: ${upd.split('update available: ')[1]}.`)
  return p
}

function section(title, lines) {
  return [`══ ${title} ${'═'.repeat(Math.max(3, 40 - title.length))}`, ...lines, '']
}

function buildReport(snap, fe) {
  const cur  = parseLog(snap.log)
  const prev = parseLog(snap.previous_session?.lines)
  const { app = {}, os = {}, storage: st = {}, library: lib = {}, tools = {}, license: lic, settings = {} } = snap

  const problems = detectProblems(snap, fe, cur, prev)
  const head = []
  head.push(...section('Summary', problems.length ? problems.map(s => s.startsWith('    ') ? s : `• ${s}`) : ['No obvious problems detected — see the timeline.']))

  head.push(...section('App & system', [
    `qooti ${app.version} (${app.build}) · session started ${app.session_started?.slice(11, 19)} UTC (${fe.uptimeMin} min) · view: ${fe.view}`,
    `Install: ${app.install}`,
    `${os.name} · ${os.arch}${os.rosetta ? ' (Rosetta)' : ''} · ${os.cpus} CPU threads · RAM ${gb(os.ram_total_mb)}${os.ram_free_mb != null ? ` (${gb(os.ram_free_mb)} free)` : ''}`,
    `WebView ${snap.webview} · window ${fe.window} · screen ${fe.screen} · theme ${fe.theme} (OS ${fe.osTheme})`,
    `Locale ${fe.locale} · app language ${fe.appLang} · ${fe.timezone} (UTC${fe.utcOffset >= 0 ? '+' : ''}${fe.utcOffset}) · ${fe.online ? 'online' : 'OFFLINE'}`,
    `JS heap ${fe.heapMb ?? '—'} / ${fe.heapLimitMb ?? '—'} MB · ${fe.domNodes} DOM nodes · UI stalls >200ms: ${fe.perf.longTasks}${fe.perf.longTasks ? ` (worst ${Math.round(fe.perf.worstMs)} ms)` : ''} · media load errors: ${fe.perf.mediaErrors}`,
  ]))

  head.push(...section('Storage & library', [
    `Vault: ${st.vault ?? '—'} (${st.vault_custom ? 'custom location' : 'default'}) · exists ${yesNo(st.vault_exists)} · writable ${yesNo(st.vault_writable)} · ${gb(st.vault_free_mb)} free`,
    `App data: ${st.data_dir ?? '—'} · ${gb(st.data_free_mb)} free · DB ${st.db_mb ?? '—'} MB (+ WAL ${st.db_wal_mb ?? 0} MB) · schema ${lib.schema_version ?? '—'}`,
    `${lib.total ?? '—'} items (${kv(lib.by_type)}) · ${lib.collections ?? '—'} collections · ${lib.tags ?? '—'} tags · saved ${lib.oldest ?? '—'} → ${lib.newest ?? '—'}`,
    `Files: ${lib.files_missing ?? '—'} missing of ${lib.files_checked ?? '—'} newest checked · ${lib.outside_vault ?? 0} outside the vault · ${lib.videos_without_thumbnail ?? 0} videos without thumbnail · ${lib.without_palette ?? 0} images without palette`,
    ...(lib.missing_examples?.length ? [`  missing e.g.: ${lib.missing_examples.join(' | ')}`] : []),
    `Find-similar index: ${kv(lib.similar_index)} · OCR: ${kv(lib.ocr_status)} · auto-tag: ${kv(lib.auto_tag_status)} · extension queue: ${lib.ext_queue ?? 0}`,
  ]))

  head.push(...section('Helper tools', [
    `yt-dlp: ${tools.ytdlp?.present ? `${tools.ytdlp.version ?? 'version unknown'} (${tools.ytdlp.kind})` : 'MISSING'}`,
    `ffmpeg: ${tools.ffmpeg?.present ? (tools.ffmpeg.version ?? 'present') : 'MISSING'}`,
    `deno (YouTube JS runtime): ${tools.deno?.ready ? `ready (${tools.deno.pinned})` : 'not installed'} · PO-token helper: ${tools.po_token_helper ? 'downloaded' : 'not downloaded'}`,
    `Find-similar model: ${tools.similar_model_ready ? 'ready' : 'not downloaded'}${tools.similar_model_bytes ? ` (${tools.similar_model_bytes} bytes)` : ''}`,
  ]))

  head.push(...section('Account & settings', [
    lic ? `License: plan ${lic.plan ?? '—'} · key ${lic.key_present ? 'present' : 'none'} · expires ${lic.expires_at ?? '—'} · validated ${ago(lic.last_validated_at)}${lic.revoked ? ' · REVOKED' : ''}`
        : 'License: no cache (never activated)',
    `Settings: ${Object.entries(settings).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
  ]))

  const failed = snap.downloads ?? []
  if (failed.length) head.push(...section('Failed downloads (newest first)', failed.map(d =>
    `${new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')}  ${d.source}  ${d.quality}  ${d.url}\n    → ${d.error ?? d.status}`)))

  // What's left goes to the logs: previous run first (it's small), then this session.
  const headText = head.join('\n')
  let budget = REPORT_BUDGET - headText.length - 400
  const prevInfo = snap.previous_session ?? {}
  const prevLines = []
  if (prev.length) {
    const prevBudget = Math.min(prevInfo.unclean_exit ? 12_000 : 5_000, budget * 0.3)
    const lastN = tailWithin(prev.slice(-(prevInfo.unclean_exit ? 80 : 15)), prevBudget * 0.6)
    const cutoff = prev.length - lastN.length
    const earlier = tailWithin(prev.slice(0, cutoff).filter(isProblem), prevBudget - lastN.join('\n').length)
    prevLines.push(`${prevInfo.unclean_exit ? 'ENDED UNEXPECTEDLY' : 'ended normally'}${prevInfo.lock_info ? ` · ${prevInfo.lock_info}` : ''} · ${prev.length} log entries (${prev[0]?.date ?? '?'})`)
    if (earlier.length) prevLines.push('— warnings/errors before the end —', ...earlier)
    prevLines.push(`— last ${lastN.length} lines —`, ...lastN)
    budget -= prevLines.join('\n').length + 100
  }

  const tl = []
  if (cur.length) {
    const tail = tailWithin(cur, budget * 0.8)
    const omitted = cur.length - tail.length
    const earlierProblems = tailWithin(cur.slice(0, omitted).filter(isProblem), budget - tail.join('\n').length - 200)
    if (omitted) {
      tl.push(`(${omitted} earlier line(s) not included${earlierProblems.length ? ` — their ${earlierProblems.length} warning(s)/error(s) are listed first` : ''}; full log: ${app.log_dir ?? 'app log folder'}/qooti.log)`)
      if (earlierProblems.length) tl.push(...earlierProblems, '— most recent —')
    }
    tl.push(...tail)
  } else {
    tl.push('(backend log unavailable — app-side trail below)', '', ..._actions, '', '— errors & warnings —', ..._errors)
  }

  const out = [headText, ...section('Timeline — this session (UTC, oldest first)', tl)]
  if (prevLines.length) out.push(...section('Previous session', prevLines))
  return out.join('\n')
}

/** Report without the backend snapshot (browser/mock, or the command failed). */
function fallbackReport(fe) {
  return [
    ...section('App (backend diagnostics unavailable)', [
      `view ${fe.view} · window ${fe.window} · ${fe.locale} · ${fe.timezone} · ${fe.online ? 'online' : 'OFFLINE'} · ${fe.userAgent}`,
    ]),
    ...section('Recent activity (oldest first)', _actions.length ? _actions : ['(no activity recorded)']),
    ...section('Errors & warnings', _errors.length ? _errors : ['(none)']),
  ].join('\n')
}

// ─── Privacy ──────────────────────────────────────────────────────
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Shorten home paths, drop secrets, emails and signed URL queries. */
export function redact(text, home) {
  let t = text
  if (home) {
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])
    for (const v of variants) t = t.replace(new RegExp(escapeRe(v), 'gi'), '~')
  }
  t = t.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/g, '$1 <redacted>')
  t = t.replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '<jwt>')
  t = t.replace(/([\w-]*(?:token|secret|password|passwd|api[_-]?key|license[_-]?key|connection[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;)]+/gi, '$1<redacted>')
  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
  // URL queries often carry signatures, IPs and session ids (googlevideo, CDNs): keep
  // just the video id for YouTube, drop the rest.
  t = t.replace(/(https?:\/\/[^\s?#"'<>]+)\?([^\s#"'<>]*)/g, (_, base, q) => {
    if (/youtu\.?be/.test(base)) {
      const keep = q.split('&').filter(p => /^(v|list|t)=/.test(p))
      return keep.length ? `${base}?${keep.join('&')}` : base
    }
    return `${base}?…`
  })
  return t
}

// ─── Public API ───────────────────────────────────────────────────

/** The full plain-text report (also shown in the feedback dialog's "what's included"). */
export async function buildActivityTrail() {
  await flushLog()
  const fe = frontendInfo()
  let snap = null
  try { snap = await api.diagnosticsSnapshot() } catch { /* old backend / browser */ }
  const text = snap ? buildReport(snap, fe) : fallbackReport(fe)
  return redact(text, snap?.home).slice(0, REPORT_BUDGET + 1500)
}

/** One-shot diagnostics snapshot to attach to a feedback message. */
export async function gatherDiagnostics() {
  const [appInfo, vaultInfo, activity] = await Promise.all([
    api.getAppInfo().catch(() => null),
    api.getVaultInfo().catch(() => null),
    buildActivityTrail(),
  ])
  // First summary line, for the Telegram caption (newer workers show it).
  const summary = (activity.split('\n').find(l => l.startsWith('• ')) ?? '').slice(2, 200)
  return {
    public_id:   getSetting('bloot_id') || '',
    app_version: appInfo?.version ?? '—',
    platform:    appInfo?.platform ?? '—',
    items_total: vaultInfo?.total_items ?? null,
    summary,
    activity,
  }
}
