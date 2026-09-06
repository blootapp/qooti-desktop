// Top-bar download indicator + dropdown list.
//
// Visibility rule: show when (queued + active >= 1) OR (failed >= 1).
// Completed entries stay in the dropdown until the panel is closed.

import store from './store.js'
import * as events from './events.js'
import { getEntries, dismissEntry, retryDownload } from './download-tracker.js'
import { api } from './tauri-api.js'
import { open as openInBrowser } from '@tauri-apps/plugin-shell'
import { getSetting } from './settings.js'

let _btn       = null   // the button element in top-bar-right
let _importBtn = null   // the + import button (hidden while indicator is visible)
let _dropdown  = null   // the floating panel
let _open      = false
let _completedThisSession = new Set()  // ids dismissed from panel on close

// ─── Visibility logic ────────────────────────────────────────────

function shouldShow(entries) {
  const active  = entries.filter(e => e.status === 'queued' || e.status === 'active').length
  const failed  = entries.filter(e => e.status === 'failed').length
  return active >= 1 || failed >= 1
}

// ─── Dropdown ────────────────────────────────────────────────────

function buildDropdown() {
  const el = document.createElement('div')
  el.className = 'dl-dropdown'
  el.setAttribute('data-dl-panel', '1')
  document.getElementById('overlays').appendChild(el)
  return el
}

function positionDropdown() {
  if (!_btn || !_dropdown) return
  const r = _btn.getBoundingClientRect()
  _dropdown.style.top   = `${r.bottom + 6}px`
  _dropdown.style.right = `${window.innerWidth - r.right}px`
}

function renderDropdown(entries) {
  if (!_dropdown) return
  _dropdown.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'dl-dropdown-header'
  header.innerHTML = '<span class="dl-dropdown-title">Downloads</span>'
  const clearBtn = document.createElement('button')
  clearBtn.className = 'dl-dropdown-clear'
  clearBtn.textContent = 'Clear all'
  clearBtn.addEventListener('click', () => {
    for (const e of entries) {
      if (e.status === 'failed' || e.status === 'cancelled' || e.status === 'complete') {
        dismissEntry(e.id)
      }
    }
    closeDropdown()
  })
  header.appendChild(clearBtn)
  _dropdown.appendChild(header)

  if (!entries.length) {
    const empty = document.createElement('div')
    empty.className = 'dl-dropdown-empty'
    empty.textContent = 'No downloads'
    _dropdown.appendChild(empty)
    return
  }

  const list = document.createElement('div')
  list.className = 'dl-dropdown-list'

  for (const entry of [...entries].reverse().slice(0, 20)) {
    list.appendChild(buildRow(entry))
  }
  _dropdown.appendChild(list)
}

function buildRow(entry) {
  const row = document.createElement('div')
  row.className = `dl-row dl-row--${entry.status}`

  const icon = document.createElement('span')
  icon.className = 'dl-row-icon'
  icon.innerHTML = rowIcon(entry.status)
  row.appendChild(icon)

  const body = document.createElement('div')
  body.className = 'dl-row-body'

  const name = document.createElement('span')
  name.className = 'dl-row-name'
  name.textContent = entry.filename ?? entry.domain
  name.title = entry.url
  body.appendChild(name)

  const sub = document.createElement('span')
  sub.className = 'dl-row-sub'
  sub.textContent = rowSubtext(entry)
  body.appendChild(sub)

  if (entry.status === 'active' && entry.pct > 0) {
    const bar = document.createElement('div')
    bar.className = 'dl-row-bar'
    const fill = document.createElement('div')
    fill.className = 'dl-row-bar-fill'
    fill.style.width = `${Math.round(entry.pct * 100)}%`
    bar.appendChild(fill)
    body.appendChild(bar)
  }

  row.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'dl-row-actions'

  if (entry.status === 'active' || entry.status === 'queued') {
    const cancel = document.createElement('button')
    cancel.className = 'dl-row-btn dl-row-btn--cancel'
    cancel.title = 'Cancel'
    cancel.innerHTML = '&times;'
    cancel.addEventListener('click', async () => {
      await api.cancelDownload(entry.id)
    })
    actions.appendChild(cancel)
  }

  if (entry.status === 'failed') {
    if (entry.url) {
      const open = document.createElement('button')
      open.className = 'dl-row-btn dl-row-btn--open'
      open.textContent = 'Open'
      open.title = 'Open in browser'
      open.addEventListener('click', () => openInBrowser(entry.url).catch(() => {}))
      actions.appendChild(open)
    }

    const retry = document.createElement('button')
    retry.className = 'dl-row-btn dl-row-btn--retry'
    retry.textContent = 'Retry'
    retry.addEventListener('click', async () => {
      await retryDownload(entry.id)
    })
    actions.appendChild(retry)

    const clear = document.createElement('button')
    clear.className = 'dl-row-btn dl-row-btn--clear'
    clear.textContent = 'Clear'
    clear.addEventListener('click', () => dismissEntry(entry.id))
    actions.appendChild(clear)
  }

  if (entry.status === 'complete' || entry.status === 'cancelled') {
    const clear = document.createElement('button')
    clear.className = 'dl-row-btn dl-row-btn--clear'
    clear.title = 'Dismiss'
    clear.innerHTML = '&times;'
    clear.addEventListener('click', () => dismissEntry(entry.id))
    actions.appendChild(clear)
  }

  row.appendChild(actions)
  return row
}

function rowIcon(status) {
  if (status === 'complete')  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,8 6.5,12 13,4"/></svg>'
  if (status === 'failed')    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>'
  if (status === 'cancelled') return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>'
  if (status === 'queued')    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><polyline points="8,5 8,8 10,10"/></svg>'
  // active / downloading
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8,3 8,10"/><polyline points="5,8 8,11 11,8"/><line x1="3" y1="13" x2="13" y2="13"/></svg>'
}

function rowSubtext(entry) {
  if (entry.status === 'queued')    return 'Waiting in queue…'
  if (entry.status === 'complete')  return 'Saved to library'
  if (entry.status === 'cancelled') return 'Cancelled'
  if (entry.status === 'failed')    return entry.error ?? 'Failed'
  if (entry.pct > 0) return `${Math.round(entry.pct * 100)}%`
  return 'Downloading…'
}

// ─── Open / close ─────────────────────────────────────────────────

function openDropdown() {
  if (_open) return
  _open = true
  if (!_dropdown) _dropdown = buildDropdown()
  renderDropdown(getEntries())
  positionDropdown()
  _dropdown.classList.add('dl-dropdown--open')
  _btn?.classList.add('active')
  requestAnimationFrame(() => {
    document.addEventListener('click', onOutsideClick, { once: false, capture: true })
  })
}

function closeDropdown() {
  if (!_open) return
  _open = false
  _dropdown?.classList.remove('dl-dropdown--open')
  _btn?.classList.remove('active')
  document.removeEventListener('click', onOutsideClick, true)
  // Clear completed entries from the tracker on panel close (Chrome behaviour)
  for (const e of getEntries()) {
    if (e.status === 'complete') dismissEntry(e.id)
  }
}

function onOutsideClick(e) {
  if (_btn?.contains(e.target) || _dropdown?.contains(e.target)) return
  closeDropdown()
}

// ─── Sync ─────────────────────────────────────────────────────────

function sync() {
  const entries  = getEntries()
  const busy     = shouldShow(entries)
  const toastEnabled = getSetting('show_download_toast', 'true') !== 'false'

  if (!busy || !toastEnabled) {
    closeDropdown()
    _btn.classList.remove('dl-indicator--active')
    _btn.querySelector('.dl-indicator-badge').hidden = true
    if (_open) renderDropdown(entries)
    return
  }

  _btn.classList.add('dl-indicator--active')

  // Badge count: active + queued
  const inFlight = entries.filter(e => e.status === 'active' || e.status === 'queued').length
  const badge = _btn.querySelector('.dl-indicator-badge')
  if (inFlight > 1) {
    badge.textContent = inFlight
    badge.hidden = false
  } else {
    badge.hidden = true
  }

  if (_open) renderDropdown(entries)
}

// ─── Init ─────────────────────────────────────────────────────────

export function init() {
  _btn = document.getElementById('dl-indicator-btn')
  if (!_btn) return
  _importBtn = document.getElementById('top-bar-import-btn')

  _btn.hidden = false

  _btn.addEventListener('click', e => {
    e.stopPropagation()
    _open ? closeDropdown() : openDropdown()
  })

  store.on(events.DOWNLOADS_CHANGED, sync)
  store.on(events.SETTINGS_CHANGED, ({ key }) => {
    if (key === 'show_download_toast') sync()
  })
  sync()
}
