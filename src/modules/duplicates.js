// Duplicates view — surfaces exact and near-duplicate items so the same file
// isn't kept many times. Detection lives in Rust (find_duplicates): exact = same
// file bytes; near = perceptual-hash (dHash) Hamming distance, so re-encoded /
// resized / lightly-edited copies are caught even when title + tags differ.

import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { t } from './i18n.js'
import { showConfirm } from './dialog.js'

let _root   = null
let _loaded = false

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

function esc(s) {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const RE_UUID = /^(image|img|video|vid|photo|screenshot|download|file)[_-][0-9a-f]{4,}/i
// Returns a meaningful title, or '' for auto-generated junk (so the card can omit it).
function niceTitle(it) {
  const raw = (it.title ?? '').trim()
  if (!raw || RE_UUID.test(raw)) return ''
  return raw
}

function reasonLabel(reason) {
  if (reason === 'exact') return t('duplicates.reason.exact')
  return t('duplicates.reason.potential')
}

// ─── Render ────────────────────────────────────────────────────────

async function render() {
  if (!_root) return
  _root.innerHTML = `
    <div class="dup-view">
      <div class="dup-head">
        <h1 class="dup-title">${esc(t('duplicates.title'))}</h1>
        <p class="dup-sub" id="dup-sub">${esc(t('duplicates.scanning'))}</p>
      </div>
      <div class="dup-body" id="dup-body">
        <div class="dup-loading"><span class="spinner-ring"></span>${esc(t('duplicates.scanning'))}</div>
      </div>
    </div>
  `
  const body = _root.querySelector('#dup-body')
  const sub  = _root.querySelector('#dup-sub')

  let groups
  try {
    groups = await api.findDuplicates()
  } catch (err) {
    console.error('[duplicates] scan failed:', err)
    sub.textContent = ''
    body.innerHTML = `<div class="dup-empty">${I('warning', 28)}<p>${esc(t('duplicates.error'))}</p></div>`
    return
  }

  if (!groups || groups.length === 0) {
    sub.textContent = ''
    body.innerHTML = `<div class="dup-empty">${I('check-circle', 32)}<p>${esc(t('duplicates.empty'))}</p></div>`
    return
  }

  const totalDupes = groups.reduce((n, g) => n + (g.items.length - 1), 0)
  sub.textContent = t('duplicates.summary', { groups: groups.length, files: totalDupes })

  body.innerHTML = ''
  for (const group of groups) body.appendChild(renderGroup(group))
}

function renderGroup(group) {
  const el = document.createElement('div')
  el.className = 'dup-group'

  const head = document.createElement('div')
  head.className = 'dup-group-head'
  head.innerHTML = `
    <span class="dup-badge dup-badge--${group.reason}">${esc(reasonLabel(group.reason))}</span>
    <span class="dup-group-count">${t('duplicates.copies', { n: group.items.length })}</span>
    <button class="dup-keep-btn">${I('trash', 14)}${esc(t('duplicates.keep_oldest', { n: group.items.length - 1 }))}</button>
  `
  el.appendChild(head)

  const grid = document.createElement('div')
  grid.className = 'dup-items'
  group.items.forEach((item, idx) => grid.appendChild(renderItem(item, idx === 0, el)))
  el.appendChild(grid)

  // Keep oldest, delete the rest.
  head.querySelector('.dup-keep-btn').addEventListener('click', async () => {
    const rest = group.items.slice(1)
    const ok = await showConfirm({
      title: t('duplicates.confirm_title'),
      message: t('duplicates.confirm_msg', { n: rest.length }),
      danger: true,
      confirmLabel: t('duplicates.confirm_ok'),
      icon: 'trash',
    })
    if (!ok) return
    for (const it of rest) await deleteItem(it.id, el)
    reconcileGroup(el)
  })

  return el
}

function renderItem(item, isOriginal, groupEl) {
  const el = document.createElement('div')
  el.className = 'dup-item'
  el.dataset.id = item.id

  let cols = []
  try { cols = item.collections ? JSON.parse(item.collections) : [] } catch { /* ignore */ }
  const colLabel = cols.length
    ? `<span class="dup-item-col">${I('folder', 12)}${esc(cols.length > 1 ? `${cols[0]} +${cols.length - 1}` : cols[0])}</span>`
    : ''

  el.innerHTML = `
    <div class="dup-thumb">
      <img loading="lazy" decoding="async" src="${esc(convertFileSrc(item.thumb))}" alt="" />
      ${item.kind === 'video' ? `<span class="dup-play">${I('play', 14)}</span>` : ''}
      ${isOriginal ? `<span class="dup-original">${esc(t('duplicates.original'))}</span>` : ''}
      <button class="dup-del" title="${esc(t('duplicates.delete'))}" aria-label="${esc(t('duplicates.delete'))}">${I('trash', 14)}</button>
    </div>
    <div class="dup-item-meta">
      ${niceTitle(item) ? `<span class="dup-item-title">${esc(niceTitle(item))}</span>` : ''}
      <span class="dup-item-date">${esc(shortDate(item.created_at))}${colLabel}</span>
    </div>
  `

  // Open detail on thumbnail click (fetch the full record first).
  el.querySelector('.dup-thumb img').addEventListener('click', async () => {
    try {
      const full = await api.getInspiration(item.id)
      if (full) store.emit(events.CARD_OPEN, { item: full })
    } catch (err) { console.warn('[duplicates] open failed:', err) }
  })

  // Delete this specific copy.
  el.querySelector('.dup-del').addEventListener('click', async e => {
    e.stopPropagation()
    await deleteItem(item.id, groupEl)
    reconcileGroup(groupEl)
  })

  return el
}

async function deleteItem(id, groupEl) {
  try {
    await api.deleteInspiration(id)
    groupEl.querySelector(`.dup-item[data-id="${id}"]`)?.remove()
    store.emit(events.GRID_ITEM_DELETED, { id })
  } catch (err) {
    console.error('[duplicates] delete failed:', err)
  }
}

// After deletions, drop groups that no longer have ≥2 items and refresh the summary.
function reconcileGroup(groupEl) {
  const left = groupEl.querySelectorAll('.dup-item').length
  if (left < 2) groupEl.remove()
  else {
    // Re-mark the first remaining item as the original + refresh the count.
    groupEl.querySelectorAll('.dup-original').forEach(n => n.remove())
    const first = groupEl.querySelector('.dup-item .dup-thumb')
    if (first && !first.querySelector('.dup-original')) {
      const tag = document.createElement('span')
      tag.className = 'dup-original'
      tag.textContent = t('duplicates.original')
      first.appendChild(tag)
    }
    const count = groupEl.querySelector('.dup-group-count')
    if (count) count.textContent = t('duplicates.copies', { n: left })
  }

  const body = _root?.querySelector('#dup-body')
  const sub  = _root?.querySelector('#dup-sub')
  if (body && !body.querySelector('.dup-group')) {
    if (sub) sub.textContent = ''
    body.innerHTML = `<div class="dup-empty">${I('check-circle', 32)}<p>${esc(t('duplicates.empty'))}</p></div>`
  } else if (sub) {
    const groups = body.querySelectorAll('.dup-group').length
    const files  = [...body.querySelectorAll('.dup-group')]
      .reduce((n, g) => n + Math.max(0, g.querySelectorAll('.dup-item').length - 1), 0)
    sub.textContent = t('duplicates.summary', { groups, files })
  }
}

// ─── Init ──────────────────────────────────────────────────────────

export function init(root) {
  _root = root
  store.on(events.NAV_CHANGE, ({ view }) => {
    if (view === 'duplicates') { _loaded = true; render() }
  })
  // Re-render on language change while the view is open.
  document.addEventListener('i18n:changed', () => { if (_loaded && !_root?.hidden) render() })
}
