// "Downloads & imports" history view — full-page view rendered in #view-activity.
// Shows all saved items grouped by recency, with source tags and pack grouping.

import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { retryDownload, dismissEntry } from './download-tracker.js'
// `tr`, not `t`: this module uses `t` as a local name.
import { t as tr, currentLang } from './i18n.js'
import { friendlyDownloadError } from './download-errors.js'

const locale = () => (currentLang() === 'uz' ? 'uz-Latn' : undefined)

let _root       = null
let _loaded     = false
let _packOpen   = new Set()  // batch_ids whose pack row is expanded

// ─── Source labels ────────────────────────────────────────────────

const SOURCE_LABELS = {
  app_download: { key: 'activity.src.app_download', cls: 'tag--app'       },
  extension:    { key: 'activity.src.extension',    cls: 'tag--extension' },
  file_import:  { key: 'activity.src.file_import',  cls: 'tag--file'      },
  pack_import:  { key: 'activity.src.pack_import',  cls: 'tag--pack'      },
  mobile:       { key: 'activity.src.mobile',       cls: 'tag--mobile'    },
}

function sourceTag(importSource) {
  const s = SOURCE_LABELS[importSource]
  const el = document.createElement('span')
  el.className = `activity-tag ${s?.cls ?? 'tag--file'}`
  el.textContent = s ? tr(s.key) : (importSource ?? tr('activity.src.unknown'))
  return el
}

// ─── Relative time ────────────────────────────────────────────────

function relTime(ts) {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m <  1)  return tr('activity.just_now')
  if (m <  60) return tr('activity.minutes_ago', { n: m })
  const h = Math.floor(m / 60)
  if (h <  24) return tr('activity.hours_ago', { n: h })
  const d = Math.floor(h / 24)
  if (d <  7)  return tr('date.days_ago', { n: d })
  return new Date(ts).toLocaleDateString(locale(), { month: 'short', day: 'numeric' })
}

// ─── Title resolution ─────────────────────────────────────────────

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RE_HASH = /^[0-9a-zA-Z_-]{30,}$/

function resolveTitle(entry) {
  const t = entry.title
  const isJunk = t && (RE_UUID.test(t) || (RE_HASH.test(t) && !/\s/.test(t)))
  if (t && !isJunk) return t
  // Fall back to the basename of stored_path (strip extension)
  if (entry.stored_path) {
    const base = entry.stored_path.replace(/\\/g, '/').split('/').pop() ?? ''
    const name = base.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim()
    // Stored files are usually named by id — that's no better than no title
    if (name && name.length < 80 && !RE_UUID.test(name) && !(RE_HASH.test(name) && !/\s/.test(name))) return name
  }
  if (entry.source_platform) return entry.source_platform
  return tr('activity.untitled')
}

// ─── Thumbnail icon ───────────────────────────────────────────────

function thumbIcon(type) {
  if (type === 'video') return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M192,72V184a16,16,0,0,1-16,16H32a16,16,0,0,1-16-16V72A16,16,0,0,1,32,56H176A16,16,0,0,1,192,72Zm58,.25a8.23,8.23,0,0,0-6.63,1.22L209.78,95.86A4,4,0,0,0,208,99.19v57.62a4,4,0,0,0,1.78,3.33l33.78,22.52a8,8,0,0,0,8.58.19,8.33,8.33,0,0,0,3.86-7.17V80A8,8,0,0,0,250,72.25Z"/></svg>`
  if (type === 'gif')   return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM112,144a32,32,0,0,1-64,0V112a32,32,0,0,1,55.85-21.33,8,8,0,1,1-11.92,10.66A16,16,0,0,0,64,112v32a16,16,0,0,0,32,0v-8H88a8,8,0,0,1,0-16h16a8,8,0,0,1,8,8Zm32,24a8,8,0,0,1-16,0V88a8,8,0,0,1,16,0Zm60-72H176v24h20a8,8,0,0,1,0,16H176v32a8,8,0,0,1-16,0V88a8,8,0,0,1,8-8h36a8,8,0,0,1,0,16Z"/></svg>`
  // image / link / default
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM156,88a12,12,0,1,1-12,12A12,12,0,0,1,156,88Zm60,112H40V160.69l46.34-46.35a8,8,0,0,1,11.32,0h0L165,181.66a8,8,0,0,0,11.32-11.32l-17.66-17.65L173,138.34a8,8,0,0,1,11.31,0L216,170.07V200Z"/></svg>`
}

function setThumb(thumb, entry) {
  if (entry.thumbnail_path) {
    const img = document.createElement('img')
    img.src = convertFileSrc(entry.thumbnail_path)
    img.onerror = () => { img.remove(); setThumb(thumb, { ...entry, thumbnail_path: null }) }
    thumb.appendChild(img)
  } else if (entry.type === 'video' && entry.stored_path) {
    const vid = document.createElement('video')
    vid.src = convertFileSrc(entry.stored_path)
    vid.muted = true
    vid.preload = 'metadata'
    vid.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;'
    vid.addEventListener('loadedmetadata', () => {
      vid.currentTime = Math.min(vid.duration * 0.1, 5)
    })
    vid.addEventListener('error', () => { vid.remove(); thumb.classList.add('activity-thumb--placeholder'); thumb.innerHTML = thumbIcon(entry.type) })
    thumb.appendChild(vid)
  } else if (entry.stored_path && (entry.type === 'image' || entry.type === 'gif')) {
    const img = document.createElement('img')
    img.src = convertFileSrc(entry.stored_path)
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;'
    img.onerror = () => { img.remove(); thumb.classList.add('activity-thumb--placeholder'); thumb.innerHTML = thumbIcon(entry.type) }
    thumb.appendChild(img)
  } else {
    thumb.classList.add('activity-thumb--placeholder')
    thumb.innerHTML = thumbIcon(entry.type)
  }
}

// ─── Row builders ─────────────────────────────────────────────────

function buildMediaRow(entry) {
  const row = document.createElement('div')
  row.className = 'activity-row'
  row.addEventListener('click', () => {
    store.emit(events.CARD_OPEN, { item: entry })
  })

  const thumb = document.createElement('div')
  thumb.className = 'activity-thumb'
  setThumb(thumb, entry)
  row.appendChild(thumb)

  const body = document.createElement('div')
  body.className = 'activity-row-body'

  const title = document.createElement('span')
  title.className = 'activity-row-title'
  title.textContent = resolveTitle(entry)
  body.appendChild(title)

  const meta = document.createElement('div')
  meta.className = 'activity-row-meta'
  meta.appendChild(sourceTag(entry.import_source))
  if (entry.source_platform) {
    const plat = document.createElement('span')
    plat.className = 'activity-platform'
    plat.textContent = entry.source_platform
    meta.appendChild(plat)
  }
  const time = document.createElement('span')
  time.className = 'activity-time'
  time.textContent = relTime(entry.created_at)
  meta.appendChild(time)
  body.appendChild(meta)

  row.appendChild(body)
  return row
}

function buildPackRow(entry) {
  const wrap = document.createElement('div')
  wrap.className = 'activity-pack'

  const header = document.createElement('div')
  header.className = 'activity-pack-header'
  header.addEventListener('click', () => {
    store.emit(events.NAVIGATE, { view: 'collections' })
    // Open the collection — use COLLECTION_SELECTED if available
    store.emit(events.COLLECTION_SELECTED, { id: entry.collection_id })
  })

  // Preview strip (up to 5 thumbnails)
  const strip = document.createElement('div')
  strip.className = 'activity-pack-strip'
  for (const item of entry.preview_items) {
    const t = document.createElement('div')
    t.className = 'activity-pack-thumb'
    if (item.thumbnail_path) {
      const img = document.createElement('img')
      img.src = convertFileSrc(item.thumbnail_path)
      img.onerror = () => img.remove()
      t.appendChild(img)
    } else {
      t.classList.add('activity-pack-thumb--placeholder')
      t.textContent = item.type === 'video' ? '▶' : '◻'
    }
    strip.appendChild(t)
  }
  if (entry.item_count > 5) {
    const more = document.createElement('div')
    more.className = 'activity-pack-thumb activity-pack-more'
    more.textContent = `+${entry.item_count - 5}`
    strip.appendChild(more)
  }
  header.appendChild(strip)

  const info = document.createElement('div')
  info.className = 'activity-pack-info'
  const name = document.createElement('span')
  name.className = 'activity-pack-name'
  name.textContent = entry.collection_name
  info.appendChild(name)

  const meta = document.createElement('div')
  meta.className = 'activity-row-meta'
  meta.appendChild(sourceTag('pack_import'))
  const cnt = document.createElement('span')
  cnt.className = 'activity-platform'
  cnt.textContent = tr(entry.item_count === 1 ? 'import.files_one' : 'import.files_many', { n: entry.item_count })
  meta.appendChild(cnt)
  const time = document.createElement('span')
  time.className = 'activity-time'
  time.textContent = relTime(entry.created_at)
  meta.appendChild(time)
  info.appendChild(meta)
  header.appendChild(info)

  wrap.appendChild(header)
  return wrap
}

function buildFailedRow(entry) {
  const row = document.createElement('div')
  row.className = 'activity-row activity-row--failed'

  const icon = document.createElement('div')
  icon.className = 'activity-thumb activity-thumb--error'
  icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z"/></svg>'
  row.appendChild(icon)

  const body = document.createElement('div')
  body.className = 'activity-row-body'

  const title = document.createElement('span')
  title.className = 'activity-row-title'
  try {
    const u = new URL(entry.url)
    title.textContent = entry.filename ?? (u.hostname.replace(/^www\./, '') + u.pathname.slice(0, 40))
  } catch {
    title.textContent = entry.filename ?? entry.url.slice(0, 60)
  }
  body.appendChild(title)

  if (entry.error_msg) {
    const err = document.createElement('span')
    err.className = 'activity-error-msg'
    // Readable message; the raw one stays a hover away for support.
    err.textContent = friendlyDownloadError(entry.error_msg)
    err.title = entry.error_msg
    body.appendChild(err)
  }

  const meta = document.createElement('div')
  meta.className = 'activity-row-meta'
  meta.appendChild(sourceTag(entry.import_source))
  const time = document.createElement('span')
  time.className = 'activity-time'
  time.textContent = relTime(entry.created_at)
  meta.appendChild(time)
  body.appendChild(meta)

  row.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'activity-row-actions'

  const retry = document.createElement('button')
  retry.className = 'activity-btn activity-btn--retry'
  retry.textContent = tr('dl.panel.retry')
  retry.addEventListener('click', async e => {
    e.stopPropagation()
    retry.disabled = true
    retry.textContent = tr('dl.stage.retrying')
    await retryDownload(entry.id, entry).catch(err => console.error('[activity] retry failed:', err))
    row.remove()
  })
  actions.appendChild(retry)

  const clear = document.createElement('button')
  clear.className = 'activity-btn activity-btn--clear'
  clear.textContent = tr('dl.panel.clear')
  clear.addEventListener('click', e => {
    e.stopPropagation()
    dismissEntry(entry.id)
    row.remove()
  })
  actions.appendChild(clear)

  row.appendChild(actions)
  return row
}

// ─── Date grouping ────────────────────────────────────────────────

function dayLabel(ts) {
  const d = new Date(ts)
  const today     = new Date(); today.setHours(0,0,0,0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const dMid = new Date(d); dMid.setHours(0,0,0,0)
  if (dMid >= today)     return tr('date.today')
  if (dMid >= yesterday) return tr('date.yesterday')
  return d.toLocaleDateString(locale(), { weekday: 'long', month: 'short', day: 'numeric' })
}

// ─── Render ───────────────────────────────────────────────────────

// Guide E4: page head, then one card of rows per day.
async function render() {
  if (!_root) return
  _root.innerHTML = `
    <div class="view-page">
      <div class="view-head"><h1>${tr('nav.activity')}</h1><p>${tr('activity.subtitle')}</p></div>
      <div id="activity-list"><div class="activity-loading">${tr('activity.loading')}</div></div>
    </div>`
  const list = _root.querySelector('#activity-list')
  let data
  try {
    data = await api.listActivity(300)
  } catch (err) {
    console.error('[activity] listActivity failed:', err)
    list.innerHTML = `<div class="activity-empty">${tr('activity.load_failed')}</div>`
    return
  }

  const entries = data?.entries ?? []
  if (!entries.length) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="empty-state-icon"><span class="icon icon-20" style="mask-image:url('/icons/clock-counter-clockwise.svg');-webkit-mask-image:url('/icons/clock-counter-clockwise.svg')" aria-hidden="true"></span></span>
        <span class="empty-state-title">${tr('activity.empty_title')}</span>
        <p class="empty-state-body">${tr('activity.empty')}</p>
        <button class="empty-state-btn" id="activity-import">${tr('action.import')}</button>
      </div>`
    list.querySelector('#activity-import').addEventListener('click', () => store.emit(events.IMPORT_REQUESTED))
    return
  }

  list.innerHTML = ''

  let lastDay = null, group = null
  for (const entry of entries) {
    const day = dayLabel(entry.created_at)
    if (day !== lastDay) {
      lastDay = day
      const sep = document.createElement('div')
      sep.className = 'activity-day-sep'
      sep.textContent = day
      group = document.createElement('div')
      group.className = 'activity-group'
      list.append(sep, group)
    }

    if (entry.kind === 'media')  group.appendChild(buildMediaRow(entry))
    if (entry.kind === 'pack')   group.appendChild(buildPackRow(entry))
    if (entry.kind === 'failed') group.appendChild(buildFailedRow(entry))
  }
}

// ─── Init ─────────────────────────────────────────────────────────

export function init(root) {
  _root = root

  store.on(events.NAV_CHANGE, ({ view }) => {
    if (view === 'activity') render()
  })
  document.addEventListener('i18n:changed', () => { if (_root?.childElementCount) render() })

  // Refresh when a download completes or a file is imported
  store.on(events.DOWNLOAD_COMPLETE, () => {
    if (document.getElementById('view-activity')?.hidden === false) render()
  })
  store.on(events.FILES_IMPORTED, () => {
    if (document.getElementById('view-activity')?.hidden === false) render()
  })
}
