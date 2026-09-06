// "Downloads & imports" history view — full-page view rendered in #view-activity.
// Shows all saved items grouped by recency, with source tags and pack grouping.

import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { retryDownload, dismissEntry } from './download-tracker.js'

let _root       = null
let _loaded     = false
let _packOpen   = new Set()  // batch_ids whose pack row is expanded

// ─── Source labels ────────────────────────────────────────────────

const SOURCE_LABELS = {
  app_download: { label: 'App download',       cls: 'tag--app'       },
  extension:    { label: 'Extension',          cls: 'tag--extension' },
  file_import:  { label: 'File import',        cls: 'tag--file'      },
  pack_import:  { label: 'Pack import',        cls: 'tag--pack'      },
  mobile:       { label: 'Mobile app',         cls: 'tag--mobile'    },
}

function sourceTag(importSource) {
  const s = SOURCE_LABELS[importSource] ?? { label: importSource ?? 'Unknown', cls: 'tag--file' }
  const el = document.createElement('span')
  el.className = `activity-tag ${s.cls}`
  el.textContent = s.label
  return el
}

// ─── Relative time ────────────────────────────────────────────────

function relTime(ts) {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m <  1)  return 'Just now'
  if (m <  60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h <  24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d <  7)  return `${d}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
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
    if (name && name.length < 80) return name
  }
  if (entry.source_platform) return entry.source_platform
  return 'Untitled'
}

// ─── Thumbnail icon ───────────────────────────────────────────────

function thumbIcon(type) {
  if (type === 'video') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><polygon points="10,9 16,12 10,15" fill="currentColor" stroke="none"/></svg>`
  if (type === 'gif')   return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M8 12h4M12 12v-3"/><text x="14" y="14" font-size="6" fill="currentColor" stroke="none">GIF</text></svg>`
  // image / link / default
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/></svg>`
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
  cnt.textContent = `${entry.item_count} files`
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
  icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>'
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
    err.textContent = entry.error_msg
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
  retry.textContent = 'Retry'
  retry.addEventListener('click', async e => {
    e.stopPropagation()
    retry.disabled = true
    retry.textContent = 'Retrying…'
    await retryDownload(entry.id, entry).catch(err => console.error('[activity] retry failed:', err))
    row.remove()
  })
  actions.appendChild(retry)

  const clear = document.createElement('button')
  clear.className = 'activity-btn activity-btn--clear'
  clear.textContent = 'Clear'
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
  if (dMid >= today)     return 'Today'
  if (dMid >= yesterday) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

// ─── Render ───────────────────────────────────────────────────────

async function render() {
  if (!_root) return
  _root.innerHTML = '<div class="activity-loading">Loading…</div>'
  let data
  try {
    data = await api.listActivity(300)
  } catch (err) {
    console.error('[activity] listActivity failed:', err)
    _root.innerHTML = '<div class="activity-empty">Could not load activity.</div>'
    return
  }

  const entries = data?.entries ?? []
  if (!entries.length) {
    _root.innerHTML = '<div class="activity-empty">No downloads or imports yet.</div>'
    return
  }

  _root.innerHTML = ''

  let lastDay = null
  for (const entry of entries) {
    const day = dayLabel(entry.created_at)
    if (day !== lastDay) {
      lastDay = day
      const sep = document.createElement('div')
      sep.className = 'activity-day-sep'
      sep.textContent = day
      _root.appendChild(sep)
    }

    if (entry.kind === 'media')  _root.appendChild(buildMediaRow(entry))
    if (entry.kind === 'pack')   _root.appendChild(buildPackRow(entry))
    if (entry.kind === 'failed') _root.appendChild(buildFailedRow(entry))
  }
}

// ─── Init ─────────────────────────────────────────────────────────

export function init(root) {
  _root = root

  store.on(events.NAV_CHANGE, ({ view }) => {
    if (view === 'activity') render()
  })

  // Refresh when a download completes or a file is imported
  store.on(events.DOWNLOAD_COMPLETE, () => {
    if (document.getElementById('view-activity')?.hidden === false) render()
  })
  store.on(events.FILES_IMPORTED, () => {
    if (document.getElementById('view-activity')?.hidden === false) render()
  })
}
