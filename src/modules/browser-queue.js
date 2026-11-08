// "Links from your browser" (guide F11–F11f): links the browser extension kept while
// qooti was closed (browser_queue.rs). Opens when qooti starts with links waiting, or
// when the extension hands them over.
//
// Up to 8 links: one row each — preview, title, site and when, a menu for what to
// download, ×. More: one row per site (closed), with one menu for all its links; the
// chevron opens a site to choose link by link, and the list scrolls inside the dialog.
// Start downloading sends them down the extension's own save road (duplicates, the Free
// daily limit, the downloads queue); Clear all empties the list, with Undo; closing
// keeps everything for next time.

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { t } from './i18n.js'
import { enhanceSelect } from './select-menu.js'
import { isDialogOpen } from './dialog.js'
import { makeLogger } from './logger.js'

const log = makeLogger('BrowserQueue')

const GROUP_FROM = 9            // this many links and more: grouped by site
const UNDO_MS    = 6000
const PLAN_URL   = 'https://account.bloot.app/plan/'
const COUNTED    = ['video', 'image', 'thumbnail']   // what the Free daily limit counts

const SITE_NAMES = {
  'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'pinterest.com': 'Pinterest', 'instagram.com': 'Instagram',
  'behance.net': 'Behance', 'dribbble.com': 'Dribbble', 'tiktok.com': 'TikTok', 'x.com': 'X', 'twitter.com': 'X',
  'vimeo.com': 'Vimeo', 'reddit.com': 'Reddit', 'cosmos.so': 'Cosmos',
}

let overlay = null
let items = []                  // as the backend lists them (newest first)
const choices = new Map()       // id → the format picked here
const openSites = new Set()     // grouped view: sites shown link by link
let plan = null                 // { is_free, ext_limit, ext_used_today }
let pendingClear = null         // { ids, timer } while Clear all can still be undone
let waiting = false             // an open is waiting for another dialog to finish

export function init() {
  store.on(events.BROWSER_QUEUE_CHANGED, onChanged)
  // Links still waiting from an earlier session, once the library is up
  setTimeout(() => refresh({ open: true }), 1500)
}

function onChanged(payload = {}) {
  if (payload.count !== undefined) refresh({ open: true })     // the extension handed links over
  else if (payload.preview && overlay) refresh({ open: false }) // a preview came in
}

async function refresh({ open }) {
  let list
  try { list = await api.browserQueueList() } catch (err) { log.warn('list_failed', { error: err }); return }
  // Links on their way out (Clear all, waiting for Undo) stay out
  if (pendingClear) list = list.filter(i => !pendingClear.ids.includes(i.id))
  items = list ?? []
  for (const id of [...choices.keys()]) if (!items.some(i => i.id === id)) choices.delete(id)
  if (!items.length) { close(); return }
  if (overlay) render()
  else if (open) openWhenFree()
}

// After whatever else is on screen: another dialog, onboarding, the walkthrough.
async function openWhenFree() {
  if (waiting || overlay) return
  waiting = true
  while (isDialogOpen() || busyElsewhere()) await new Promise(r => setTimeout(r, 800))
  waiting = false
  if (!items.length || overlay) return
  try { plan = await api.getFreePlanInfo() } catch { plan = null }
  show()
  log.info('opened', { links: items.length })
}

function busyElsewhere() {
  const onboarding = document.getElementById('onboarding-root')
  return !!document.querySelector('.wt-root') || (!!onboarding && !onboarding.hidden)
}

// ─── The dialog ──────────────────────────────────────────────────

function show() {
  overlay = document.createElement('div')
  overlay.className = 'dlg-overlay bq-overlay'
  overlay.innerHTML = `<div class="dlg-box bq-box" role="dialog" aria-modal="true" aria-labelledby="bq-title"></div>`
  document.body.appendChild(overlay)
  overlay.addEventListener('click', onClick)
  overlay.addEventListener('change', onChange)
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close() })
  document.addEventListener('keydown', onKey)
  render()
  overlay.classList.add('dlg-visible')
  requestAnimationFrame(() => overlay?.querySelector('#bq-start')?.focus())
}

/** Closing keeps the links: they come back next time qooti starts. */
function close() {
  if (!overlay) return
  document.removeEventListener('keydown', onKey)
  const el = overlay
  overlay = null
  el.remove()
}

function onKey(e) {
  // Esc in an open menu closes just the menu
  if (e.key === 'Escape' && !document.querySelector('.sm-menu')) { e.preventDefault(); close() }
}

function render() {
  const box = overlay.querySelector('.bq-box')
  const scroll = box.querySelector('.bq-list')?.scrollTop ?? 0
  const grouped = items.length >= GROUP_FROM
  const n = items.length
  box.innerHTML = `
    <div class="dlg-header">
      <div class="dlg-title" id="bq-title">${esc(n === 1 ? t('bq.title_one') : t('bq.title', { n }))}</div>
      <button class="dlg-close" data-act="close" aria-label="${esc(t('bq.later'))}" title="${esc(t('bq.later'))}">${I('x', 16)}</button>
    </div>
    <div class="dlg-message">${esc(grouped ? t('bq.intro_sites') : t('bq.intro'))}</div>
    <div class="bq-list" role="list">
      ${grouped ? groups().map(groupHtml).join('') : items.map(i => rowHtml(i)).join('')}
    </div>
    ${freeLine()}
    <div class="bq-keep">${esc(t('bq.keep'))}</div>
    <div class="dlg-actions bq-actions">
      <button class="dlg-btn dlg-btn--danger" data-act="clear">${esc(t('bq.clear'))}</button>
      <button class="dlg-btn dlg-btn--primary" id="bq-start" data-act="start">${esc(grouped ? t('bq.start_n', { n }) : t('bq.start'))}</button>
    </div>`
  box.querySelectorAll('select.bq-format').forEach(enhanceSelect)
  const list = box.querySelector('.bq-list')
  if (list) list.scrollTop = scroll
}

const choiceOf = i => choices.get(i.id) ?? i.choice

function rowHtml(i, nested = false) {
  const name = i.title || i.url
  const choice = choiceOf(i)
  const menu = i.formats.length > 1
    ? `<select class="settings-select bq-format" data-id="${esc(i.id)}" aria-label="${esc(t('bq.format_for', { name }))}">
         ${i.formats.map(f => `<option value="${f}"${f === choice ? ' selected' : ''}>${esc(t('bq.fmt.' + f))}</option>`).join('')}
       </select>`
    : `<span class="bq-fixed">${esc(t('bq.fmt.' + i.formats[0]))}</span>`
  return `
    <div class="bq-row${nested ? ' bq-row--link' : ''}" role="listitem" data-id="${esc(i.id)}">
      <div class="bq-thumb">${i.preview ? `<img src="${esc(i.preview)}" alt="" draggable="false">` : I(i.kind === 'video' ? 'ui/video' : 'image', 16)}</div>
      <div class="bq-text">
        <div class="bq-name" title="${esc(name)}">${esc(name)}</div>
        <div class="bq-meta">${esc(nested ? ago(i.saved_at) : `${i.site} · ${ago(i.saved_at)}`)}</div>
      </div>
      ${menu}
      <button class="bq-icon-btn" data-act="remove" data-id="${esc(i.id)}" aria-label="${esc(t('bq.remove'))}" title="${esc(t('bq.remove'))}">${I('x', 14)}</button>
    </div>`
}

function siteName(i) {
  const host = i.site || ''
  for (const [h, name] of Object.entries(SITE_NAMES)) if (host === h || host.endsWith('.' + h)) return name
  return host || t('bq.other_site')
}

function groups() {
  const by = new Map()
  for (const i of items) {
    const k = siteName(i)
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(i)
  }
  return [...by].map(([name, list]) => ({ name, list })).sort((a, b) => b.list.length - a.list.length)
}

function groupHtml(g) {
  const open = openSites.has(g.name)
  const formats = [...new Set(g.list.flatMap(i => i.formats))]
  const picked = new Set(g.list.map(choiceOf))
  const mixed = picked.size > 1
  const value = mixed ? '' : [...picked][0]
  const count = g.list.length === 1 ? t('bq.links_one') : t('bq.links', { n: g.list.length })
  return `
    <div class="bq-site" data-site="${esc(g.name)}">
      <div class="bq-row bq-row--site" role="listitem">
        <div class="bq-stack">${g.list.slice(0, 3).reverse().map(i => `<span>${i.preview ? `<img src="${esc(i.preview)}" alt="" draggable="false">` : ''}</span>`).join('')}</div>
        <div class="bq-text">
          <div class="bq-name">${esc(g.name)}</div>
          <div class="bq-meta">${esc(count)}</div>
        </div>
        <select class="settings-select bq-format" data-site="${esc(g.name)}" aria-label="${esc(t('bq.format_for', { name: g.name }))}">
          ${mixed ? `<option value="" selected hidden>${esc(t('bq.mixed'))}</option>` : ''}
          ${formats.map(f => `<option value="${f}"${f === value ? ' selected' : ''}>${esc(t('bq.fmt.' + f))}</option>`).join('')}
        </select>
        <button class="bq-icon-btn" data-act="toggle" data-site="${esc(g.name)}" aria-expanded="${open}"
          aria-label="${esc(t(open ? 'bq.close_site' : 'bq.open_site', { site: g.name }))}" title="${esc(t(open ? 'bq.close_site' : 'bq.open_site', { site: g.name }))}">${I(open ? 'ui/chevron-up' : 'ui/chevron-down', 16)}</button>
        <button class="bq-icon-btn" data-act="remove-site" data-site="${esc(g.name)}"
          aria-label="${esc(t('bq.remove_site', { site: g.name }))}" title="${esc(t('bq.remove_site', { site: g.name }))}">${I('x', 14)}</button>
      </div>
      ${open ? `<div class="bq-links" role="list">${g.list.map(i => rowHtml(i, true)).join('')}</div>` : ''}
    </div>`
}

// Free plan: how many download now (what is left of today's limit) and that the rest
// wait for midnight — only when the list goes over it.
function freeLine() {
  if (!plan?.is_free) return ''
  const counted = items.filter(i => COUNTED.includes(choiceOf(i))).length
  const left = Math.max(0, (plan.ext_limit ?? 10) - (plan.ext_used_today ?? 0))
  if (counted <= left) return ''
  const msg = left === 0 ? t('bq.free_none') : t('bq.free', { now: left, later: counted - left })
  return `
    <div class="bq-free">
      <span>${esc(msg)}</span>
      <button class="bq-upgrade" data-act="upgrade">${esc(t('bq.upgrade'))}</button>
    </div>`
}

// ─── What the user does ──────────────────────────────────────────

function onChange(e) {
  const sel = e.target.closest?.('select.bq-format')
  if (!sel || !sel.value) return
  if (sel.dataset.id) choices.set(sel.dataset.id, sel.value)
  else {
    // A site's menu sets every link of it that can be saved that way
    const g = groups().find(g => g.name === sel.dataset.site)
    for (const i of g?.list ?? []) if (i.formats.includes(sel.value)) choices.set(i.id, sel.value)
  }
  render()
}

function onClick(e) {
  const b = e.target.closest('[data-act]')
  if (!b || !overlay?.contains(b)) return
  switch (b.dataset.act) {
    case 'close':  close(); break
    case 'toggle': {
      const s = b.dataset.site
      openSites.has(s) ? openSites.delete(s) : openSites.add(s)
      render()
      overlay?.querySelector(`[data-act="toggle"][data-site="${cssEsc(s)}"]`)?.focus()
      break
    }
    case 'remove':      removeIds([b.dataset.id]); break
    case 'remove-site': removeIds((groups().find(g => g.name === b.dataset.site)?.list ?? []).map(i => i.id)); break
    case 'upgrade':     api.openUrl(PLAN_URL).catch(() => {}); break
    case 'clear':       clearAll(); break
    case 'start':       start(b); break
  }
}

// × on a row (or a site): gone from the list at once.
function removeIds(ids) {
  items = items.filter(i => !ids.includes(i.id))
  ids.forEach(id => choices.delete(id))
  if (!items.length) close()
  else render()
  api.browserQueueRemove(ids).catch(err => log.warn('remove_failed', { error: err }))
}

function clearAll() {
  const ids = items.map(i => i.id)
  const n = ids.length
  if (pendingClear) { clearTimeout(pendingClear.timer); api.browserQueueRemove(pendingClear.ids).catch(() => {}) }
  const timer = setTimeout(() => {
    if (pendingClear?.timer !== timer) return
    pendingClear = null
    api.browserQueueRemove(ids).catch(err => log.warn('clear_failed', { error: err }))
  }, UNDO_MS)
  pendingClear = { ids, timer }
  close()
  log.info('cleared', { links: n })
  store.emit(events.SYSTEM_TOAST, {
    type: 'success',
    message: n === 1 ? t('bq.cleared_one') : t('bq.cleared', { n }),
    duration: UNDO_MS,
    action: {
      label: t('bq.undo'),
      onClick: () => {
        if (pendingClear?.timer !== timer) return
        clearTimeout(timer)
        pendingClear = null
        refresh({ open: true })
      },
    },
  })
}

async function start(btn) {
  btn.disabled = true
  const picks = items.map(i => ({ id: i.id, choice: choiceOf(i) }))
  try {
    const res = await api.browserQueueStart(picks)
    items = []
    choices.clear()
    openSites.clear()
    close()
    log.info('started', res ?? {})
    const parts = []
    if (res?.started) parts.push(res.started === 1 ? t('bq.started_one') : t('bq.started', { n: res.started }))
    if (res?.later)   parts.push(t('bq.started_later', { n: res.later }))
    if (res?.already) parts.push(res.already === 1 ? t('bq.already_one') : t('bq.already', { n: res.already }))
    if (parts.length) store.emit(events.SYSTEM_TOAST, { type: 'success', message: parts.join(' · '), duration: 6000 })
  } catch (err) {
    btn.disabled = false
    log.error('start_failed', { error: err })
    store.emit(events.SYSTEM_TOAST, { type: 'error', message: t('bq.start_failed') })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (m < 1) return t('bq.just_now')
  if (m < 60) return t('bq.min_ago', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return h === 1 ? t('bq.hour_ago') : t('bq.hours_ago', { n: h })
  const d = Math.round(h / 24)
  return d <= 1 ? t('bq.yesterday') : t('bq.days_ago', { n: d })
}

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

const cssEsc = s => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'))
