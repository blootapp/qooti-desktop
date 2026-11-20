// Notifications: the bell in the top bar, its panel and the pop-ups
// (MD/qooti-notifications-spec.md §4). bloot writes them on the admin page; announcements.rs
// fetches them from api.bloot.app, keeps them for offline, downloads their pictures and sends
// the "seen" / "click" reports. This file shows them:
//  • the bell with the unread count, and a panel anchored to it (the downloads panel's family)
//  • one card per notification: type icon, title, message (5 lines + More), picture, button, time
//  • seen = a card ≥ 60 % visible in the open panel for ≥ 600 ms, or a pop-up on screen ≥ 1 s;
//    seen also marks it read. "Mark all as read" only marks read.
//  • pop-ups: one at a time under the top bar, never during the first-run steps
// Checks: 10 s after start, then every next_check_s (the server's choice), on focus once the
// last check is 5 minutes old, and whenever the panel opens once it is a minute old — so a
// notification ended or deleted on the admin page leaves the bell as soon as people look.
// Pop-ups wait for the first check of the run, so a deleted one never pops up from the cache.
// Offline: the cache, no error.
// A language switch re-renders from what is here, without asking the server again.

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { t, currentLang } from './i18n.js'
import { showTab } from './settings.js'
import { startupBusy } from './role-step.js'
import { isDialogOpen } from './dialog.js'
import { reducedMotion } from './motion.js'

const PLAN_URL       = 'https://account.bloot.app/plan/'   // the plan page the app already opens (browser-queue.js)
const FIRST_CHECK_MS = 10_000
const STALE_MS       = 5 * 60_000   // on focus
const OPEN_STALE_MS  = 60_000       // when the panel opens
const SEEN_RATIO     = 0.6
const SEEN_MS        = 600
const POPUP_SEEN_MS  = 1000
const POPUP_HIDE_MS  = 12_000
const POPUP_START_MS = 2500     // by then boot holds the first-run steps (main.js holdFirstRunSteps)
const POPUP_GAP_MS   = 500
const POPUP_OUT_MS   = 180

const KIND_ICON = { news: 'article', tip: 'lightning', update: 'sparkle', offer: 'star', important: 'warning' }
// Screen keys the admin page offers (§4.4) → views; settings:<tab> and the rest below
const VIEWS = { home: 'grid', collections: 'collections', history: 'activity', duplicates: 'duplicates' }
const SETTINGS_TABS = ['general', 'appearance', 'library', 'downloads', 'system', 'mobile']

let _btn = null, _badge = null, _panel = null, _list = null, _markAll = null
let _open = false
let _items = []                 // as announcements.rs lists them
let _loaded = false             // something to show: a cached list, or a check has answered
let _lastSync = 0, _lastTry = 0, _nextCheckS = 1800
let _syncing = null, _syncTimer = null
let _observer = null
const _seenTimers = new Map()   // id → timer while a card is visible enough
const _expanded = new Set()     // cards whose "More" was opened
// Marks made here this run, kept over lists that were read before they were saved
const _local = { read: new Set(), seen: new Set(), popped: new Set() }
let _popupsReady = false, _pumping = false
let _firstCheckDone = false     // pop-ups only after the run's first check (ok or offline)
let _popup = null               // { item, el, hide, refresh } while a pop-up is up

// ─── Helpers ──────────────────────────────────────────────────────

function icon(name, size = 16) {
  const el = document.createElement('span')
  el.className = `icon icon-${size}`
  el.style.maskImage = `url('/icons/${name}.svg')`
  el.style.webkitMaskImage = `url('/icons/${name}.svg')`
  el.setAttribute('aria-hidden', 'true')
  return el
}

function make(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text != null) el.textContent = text
  return el
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const byId = id => _items.find(i => i.id === id)
const pick = text => (currentLang() === 'uz' && text?.uz ? text.uz : text?.en ?? '')
const unreadCount = () => _items.filter(i => !i.read).length
const windowVisible = () => document.visibilityState === 'visible'

function relTime(ts) {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60_000))
  if (m < 1) return t('ann.time.now')
  if (m < 60) return t('ann.time.min', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('ann.time.hour', { n: h })
  const d = Math.floor(h / 24)
  if (d < 30) return t('ann.time.day', { n: d })
  const mo = Math.floor(d / 30)
  if (mo < 12) return t('ann.time.month', { n: mo })
  return t('ann.time.year', { n: Math.floor(mo / 12) })
}

// ─── Init ─────────────────────────────────────────────────────────

export function init() {
  _btn = document.getElementById('top-bar-bell')
  if (!_btn) return
  _badge = _btn.querySelector('.ann-badge')
  _btn.querySelector('.ann-bell-icon')?.appendChild(icon('bell', 20))
  _btn.setAttribute('aria-haspopup', 'dialog')
  _btn.setAttribute('aria-expanded', 'false')
  _btn.addEventListener('click', () => (_open ? closePanel() : openPanel()))

  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', () => {
    if (_open) positionPanel()
    if (_popup) positionPopup(_popup.el)
  })
  window.addEventListener('focus', checkIfStale)
  document.addEventListener('visibilitychange', () => {
    if (!windowVisible()) return
    checkIfStale()
    pumpPopups()
  })
  document.addEventListener('i18n:changed', onLanguage)

  renderBadge()
  api.announcementsList().then(list => apply(list)).catch(() => {})
  _syncTimer = setTimeout(sync, FIRST_CHECK_MS)
  setTimeout(() => { _popupsReady = true; pumpPopups() }, POPUP_START_MS)
}

// ─── Data ─────────────────────────────────────────────────────────

function apply(list, fromServer = false) {
  if (!list || !Array.isArray(list.items)) return
  _items = list.items
  // Ended or deleted on the admin page: a pop-up of it that is up goes away
  if (_popup && !byId(_popup.item.id)) _popup.hide()
  for (const i of _items) {
    if (_local.read.has(i.id)) i.read = true
    if (_local.seen.has(i.id)) i.seen = true
    if (_local.popped.has(i.id)) i.popped = true
  }
  if (list.last_sync) _lastSync = list.last_sync
  if (list.next_check_s) _nextCheckS = list.next_check_s
  if (fromServer || list.last_sync || _items.length) _loaded = true
  renderBadge()
  if (_open) renderPanel()
  pumpPopups()
}

function sync() {
  if (_syncing) return _syncing
  clearTimeout(_syncTimer)
  _lastTry = Date.now()
  _syncing = api.announcementsSync(currentLang())
    .then(list => apply(list, !!list?.synced))
    .catch(() => {})   // offline: the cache stays, nothing is shown
    .finally(() => {
      _syncing = null
      // The first check failed with nothing cached: the empty state, not skeletons forever
      if (!_loaded) { _loaded = true; if (_open) renderPanel() }
      if (!_firstCheckDone) { _firstCheckDone = true; pumpPopups() }
      _syncTimer = setTimeout(sync, Math.max(900, _nextCheckS) * 1000)
    })
  return _syncing
}

function isStale() {
  return Date.now() - Math.max(_lastSync, _lastTry) > STALE_MS
}

function checkIfStale() {
  if (_lastTry && isStale()) sync()   // not before the first check (10 s after start)
}

// ─── Bell ─────────────────────────────────────────────────────────

function renderBadge() {
  const n = unreadCount()
  _badge.textContent = n > 9 ? '9+' : String(n)
  _badge.hidden = n === 0
  _btn.title = t('ann.title')
  _btn.setAttribute('aria-label', n ? t('ann.bell_unread', { n }) : t('ann.title'))
}

// ─── Panel ────────────────────────────────────────────────────────

function buildPanel() {
  const el = make('div', 'ann-panel')
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-labelledby', 'ann-panel-title')
  el.tabIndex = -1
  const head = make('div', 'ann-head')
  const title = make('h2', 'ann-head-title')
  title.id = 'ann-panel-title'
  _markAll = make('button', 'ann-mark-all')
  _markAll.type = 'button'
  _markAll.addEventListener('click', markAllRead)
  head.append(title, _markAll)
  _list = make('div', 'ann-list')
  _list.setAttribute('role', 'list')
  el.append(head, _list)
  document.getElementById('overlays').appendChild(el)
  return el
}

function positionPanel() {
  const r = _btn.getBoundingClientRect()
  const top = r.bottom + 6
  _panel.style.top = `${top}px`
  _panel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`
  _panel.style.maxHeight = `${Math.max(240, Math.min(480, window.innerHeight - top - 12))}px`
  // It grows out of the bell and goes back into it
  _panel.style.transformOrigin = `calc(100% - ${Math.round(r.width / 2)}px) -6px`
}

function syncMarkAll() {
  if (!_markAll) return
  const any = unreadCount() > 0
  if (!any && document.activeElement === _markAll) _panel.focus({ preventScroll: true })
  // Hidden, not removed: the title never moves
  _markAll.classList.toggle('is-hidden', !any)
  _markAll.disabled = !any
  _markAll.setAttribute('aria-hidden', String(!any))
}

function renderPanel({ animate = false } = {}) {
  if (!_panel) return
  _panel.querySelector('.ann-head-title').textContent = t('ann.title')
  _markAll.textContent = t('ann.mark_all')
  syncMarkAll()
  stopSeenTracking()
  const scroll = _list.scrollTop
  _list.replaceChildren()

  if (!_loaded) {
    _list.setAttribute('aria-busy', 'true')
    for (let i = 0; i < 3; i++) _list.appendChild(skeletonCard())
    return
  }
  _list.removeAttribute('aria-busy')
  if (!_items.length) {
    _list.appendChild(emptyState())
    return
  }
  const stagger = animate && !reducedMotion()
  _items.forEach((item, i) => {
    const card = buildCard(item)
    if (stagger) {
      card.classList.add('is-entering')
      card.style.setProperty('--i', String(Math.min(i, 8)))
      card.addEventListener('animationend', () => card.classList.remove('is-entering'), { once: true })
    }
    _list.appendChild(card)
  })
  _list.scrollTop = animate ? 0 : scroll
  fitBodies(_list)
  startSeenTracking()
}

function openPanel() {
  if (_open) return
  _open = true
  hidePopup()
  if (!_panel) _panel = buildPanel()
  renderPanel({ animate: true })
  positionPanel()
  void _panel.offsetWidth   // start the entrance from the closed state
  _panel.classList.add('is-open')
  _btn.classList.add('active')
  _btn.setAttribute('aria-expanded', 'true')
  setTimeout(() => { if (_open) document.addEventListener('click', onOutsideClick, true) }, 0)
  _panel.focus({ preventScroll: true })
  // Nothing cached yet: skeletons until the check answers. A list over a minute old: check
  // again (the cards show meanwhile; ended or deleted ones leave when the answer comes).
  if (!_loaded || (_lastTry && Date.now() - Math.max(_lastSync, _lastTry) > OPEN_STALE_MS)) sync()
}

function closePanel({ returnFocus = false } = {}) {
  if (!_open) return
  _open = false
  stopSeenTracking()
  _panel.classList.remove('is-open')
  _btn.classList.remove('active')
  _btn.setAttribute('aria-expanded', 'false')
  document.removeEventListener('click', onOutsideClick, true)
  if (returnFocus || _panel.contains(document.activeElement)) _btn.focus({ preventScroll: true })
  setTimeout(pumpPopups, 300)
}

function onOutsideClick(e) {
  if (_btn.contains(e.target) || _panel?.contains(e.target)) return
  closePanel()
}

function onKeydown(e) {
  if (e.key !== 'Escape') return
  if (_open) {
    e.preventDefault()
    e.stopPropagation()
    closePanel({ returnFocus: true })
  } else if (_popup?.el.contains(document.activeElement)) {
    e.preventDefault()
    e.stopPropagation()
    _popup.hide()
  }
}

function onLanguage() {
  renderBadge()
  if (_open) renderPanel()
  _popup?.refresh()
}

// ─── Cards ────────────────────────────────────────────────────────

function buildCard(item, { inPopup = false } = {}) {
  const kind = KIND_ICON[item.kind] ? item.kind : 'news'
  const card = make('article', `ann-card ann-card--${kind}`)
  card.dataset.id = item.id
  if (!item.read) card.classList.add('is-unread')
  if (!inPopup) card.setAttribute('role', 'listitem')
  const titleId = `ann-title-${item.id}${inPopup ? '-popup' : ''}`
  card.setAttribute('aria-labelledby', titleId)

  const badge = make('span', 'ann-kind')
  badge.title = t(`ann.kind.${kind}`)
  badge.appendChild(icon(KIND_ICON[kind], 16))

  const main = make('div', 'ann-main')
  const top = make('div', 'ann-top')
  const title = make('h3', 'ann-card-title', pick(item.title))
  title.id = titleId
  const dot = make('span', 'ann-dot')
  dot.setAttribute('aria-hidden', 'true')
  top.append(title, dot)

  // Plain text, line breaks kept (CSS pre-line); five lines, then "More"
  const body = make('p', 'ann-body', pick(item.body))
  if (_expanded.has(item.id)) body.classList.add('is-open')
  const more = make('button', 'ann-more', t('ann.more'))
  more.type = 'button'
  more.hidden = true
  more.addEventListener('click', () => {
    _expanded.add(item.id)
    body.classList.add('is-open')
    // The rest of the text is right there; keep the keyboard on the card, not on a hidden button
    if (document.activeElement === more) (card.querySelector('.ann-btn') ?? card.closest('[tabindex]'))?.focus({ preventScroll: true })
    more.hidden = true
  })
  main.append(top, body, more)

  // announcements.rs hands over data: URLs only (the window loads no remote pictures)
  if (typeof item.image?.src === 'string' && item.image.src.startsWith('data:image/')) {
    const frame = make('div', 'ann-img')
    const img = document.createElement('img')
    img.alt = ''
    img.decoding = 'async'
    img.draggable = false
    img.addEventListener('error', () => frame.remove(), { once: true })
    img.src = item.image.src
    frame.appendChild(img)
    main.appendChild(frame)
  }

  const foot = make('div', 'ann-foot')
  if (item.button) {
    const btn = make('button', 'ann-btn')
    btn.type = 'button'
    btn.appendChild(make('span', 'ann-btn-label', pick(item.button.label)))
    if (item.button.action === 'link') btn.appendChild(icon('arrow-square-out', 12))
    btn.addEventListener('click', () => press(item.id, item))
    foot.appendChild(btn)
  }
  foot.appendChild(make('span', 'ann-meta', metaText(item)))
  main.appendChild(foot)

  card.append(badge, main)
  return card
}

function metaText(item) {
  return [item.pinned && t('ann.pinned'), item.test && t('ann.test'), relTime(item.published_at)]
    .filter(Boolean).join(' · ')
}

// "More" only where the message runs over five lines (measured once the cards are in place)
function fitBodies(root) {
  for (const card of root.querySelectorAll('.ann-card[data-id]')) {
    const body = card.querySelector('.ann-body')
    const more = card.querySelector('.ann-more')
    if (!body || !more) continue
    more.hidden = body.classList.contains('is-open') || body.scrollHeight <= body.clientHeight + 1
  }
}

function skeletonCard() {
  const card = make('div', 'ann-card ann-card--skel')
  card.setAttribute('aria-hidden', 'true')
  const main = make('div', 'ann-main')
  for (const w of ['55%', '100%', '78%']) {
    const line = make('span', 'ann-skel-line')
    line.style.width = w
    main.appendChild(line)
  }
  card.append(make('span', 'ann-kind'), main)
  return card
}

function emptyState() {
  const el = make('div', 'ann-empty')
  const ic = make('span', 'ann-empty-icon')
  ic.appendChild(icon('bell', 20))
  el.append(ic, make('span', 'ann-empty-title', t('ann.empty_title')), make('span', 'ann-empty-body', t('ann.empty_body')))
  return el
}

// ─── Seen / read / click ──────────────────────────────────────────

function startSeenTracking() {
  if (!_open || typeof IntersectionObserver === 'undefined') return
  const thresholds = Array.from({ length: 11 }, (_, i) => i / 10)
  _observer = new IntersectionObserver(onIntersect, { root: _list, threshold: thresholds })
  for (const card of _list.querySelectorAll('.ann-card[data-id]')) {
    const item = byId(card.dataset.id)
    if (item && !(item.seen && item.read)) _observer.observe(card)
  }
}

function onIntersect(entries) {
  for (const e of entries) {
    const id = e.target.dataset.id
    // A card taller than the list counts once it fills 60 % of the list
    const rootH = e.rootBounds?.height || _list.clientHeight
    const enough = e.isIntersecting &&
      (e.intersectionRatio >= SEEN_RATIO || e.intersectionRect.height >= rootH * SEEN_RATIO)
    if (enough && !_seenTimers.has(id)) {
      const card = e.target
      _seenTimers.set(id, setTimeout(() => {
        _seenTimers.delete(id)
        if (!_open || !windowVisible()) return
        _observer?.unobserve(card)
        markSeen(id)
      }, SEEN_MS))
    } else if (!enough && _seenTimers.has(id)) {
      clearTimeout(_seenTimers.get(id))
      _seenTimers.delete(id)
    }
  }
}

function stopSeenTracking() {
  _observer?.disconnect()
  _observer = null
  for (const timer of _seenTimers.values()) clearTimeout(timer)
  _seenTimers.clear()
}

function markSeen(id) {
  const item = byId(id)
  if (!item) return
  const wasUnread = !item.read
  item.seen = true
  item.read = true
  _local.seen.add(id)
  _local.read.add(id)
  api.announcementsEvent(id, 'seen').catch(() => {})
  if (wasUnread) refreshReadMarks()
}

function markAllRead() {
  const ids = _items.filter(i => !i.read).map(i => i.id)
  if (!ids.length) return
  for (const i of _items) { i.read = true; _local.read.add(i.id) }
  api.announcementsMarkRead(ids).catch(() => {})
  refreshReadMarks()
}

// Dots and the badge follow the read marks in place — no re-render, nothing moves
function refreshReadMarks() {
  renderBadge()
  for (const card of document.querySelectorAll('.ann-panel .ann-card[data-id], .ann-popup .ann-card[data-id]')) {
    card.classList.toggle('is-unread', !byId(card.dataset.id)?.read)
  }
  syncMarkAll()
}

function press(id, fallback) {
  const item = byId(id) ?? fallback
  const button = item?.button
  if (!button) return
  api.announcementsEvent(item.id, 'click').catch(() => {})   // fire and forget
  if (!item.read) {
    item.read = true
    _local.read.add(item.id)
    api.announcementsMarkRead([item.id]).catch(() => {})
    refreshReadMarks()
  }
  closePanel()
  hidePopup()
  if (button.action === 'link') {
    if (/^https:\/\/\S+$/.test(button.target)) api.openUrl(button.target).catch(() => {})
  } else if (button.action === 'screen') {
    openScreen(button.target)
  }
}

function openScreen(key) {
  if (VIEWS[key]) {
    store.emit(events.NAVIGATE, { view: VIEWS[key] })
  } else if (key === 'settings' || key.startsWith('settings:')) {
    const tab = key === 'settings' ? 'general' : key.slice('settings:'.length)
    if (!SETTINGS_TABS.includes(tab)) return
    showTab(tab)
    store.emit(events.NAVIGATE, { view: 'settings' })
  } else if (key === 'upgrade') {
    api.openUrl(PLAN_URL).catch(() => {})
  } else if (key === 'import') {
    store.emit(events.IMPORT_REQUESTED)
  }
  // A key this version doesn't know (a newer admin page): the panel just closed
}

// ─── Pop-ups ──────────────────────────────────────────────────────

const popupQueue = () => _items.filter(i => i.popup && !i.popped && !i.read)

async function pumpPopups() {
  if (!_popupsReady || !_firstCheckDone || _pumping || _popup) return
  _pumping = true
  try {
    while (popupQueue().length) {
      // Never over the sign-in screen, the role step, the tour or a dialog; not while the
      // panel is open (it shows them anyway) or the window is hidden
      if (_open || startupBusy() || isDialogOpen() || !windowVisible()) { await sleep(800); continue }
      await showPopup(popupQueue()[0])
      await sleep(POPUP_GAP_MS)
    }
  } finally {
    _pumping = false
  }
}

function positionPopup(el) {
  const r = _btn.getBoundingClientRect()
  const bar = document.getElementById('top-bar')?.getBoundingClientRect()
  const top = Math.round((bar?.bottom ?? r.bottom) + 8)
  el.style.top = `${top}px`
  el.style.right = `${Math.max(8, window.innerWidth - r.right)}px`
  // Enters from the bell, leaves into it
  el.style.transformOrigin = `calc(100% - ${Math.round(r.width / 2)}px) ${Math.round(r.top + r.height / 2 - top)}px`
}

function showPopup(item) {
  return new Promise(resolve => {
    item.popped = true
    _local.popped.add(item.id)
    api.announcementsMarkPopped(item.id).catch(() => {})

    const el = make('div', 'ann-popup')
    el.setAttribute('role', 'region')
    el.setAttribute('aria-live', 'polite')
    el.tabIndex = -1
    const close = make('button', 'ann-popup-close')
    close.type = 'button'
    close.appendChild(icon('x', 14))
    const label = () => {
      el.setAttribute('aria-label', t('ann.title'))
      close.title = t('ann.close')
      close.setAttribute('aria-label', t('ann.close'))
    }
    label()
    el.append(buildCard(item, { inPopup: true }), close)
    document.getElementById('overlays').appendChild(el)
    positionPopup(el)
    fitBodies(el)
    void el.offsetWidth
    el.classList.add('is-open')

    // Hides by itself after 12 s — not while hovered or focused, nor while the window is hidden
    let timer = null, left = POPUP_HIDE_MS, since = 0, hovered = false, focused = false, done = false
    const run = () => {
      clearTimeout(timer)
      timer = null
      if (hovered || focused || !windowVisible()) return
      since = Date.now()
      timer = setTimeout(hide, left)
    }
    const pause = () => {
      if (timer) left = Math.max(4000, left - (Date.now() - since))
      clearTimeout(timer)
      timer = null
    }
    const onVisibility = () => (windowVisible() ? run() : pause())
    el.addEventListener('mouseenter', () => { hovered = true; pause() })
    el.addEventListener('mouseleave', () => { hovered = false; run() })
    el.addEventListener('focusin', () => { focused = true; pause() })
    el.addEventListener('focusout', e => { if (el.contains(e.relatedTarget)) return; focused = false; run() })
    document.addEventListener('visibilitychange', onVisibility)
    close.addEventListener('click', () => hide())
    const seenTimer = setTimeout(() => { if (!done && windowVisible()) markSeen(item.id) }, POPUP_SEEN_MS)

    function hide() {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(seenTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      if (el.contains(document.activeElement)) _btn.focus({ preventScroll: true })
      el.classList.remove('is-open')
      const finish = () => {
        el.remove()
        if (_popup?.el === el) _popup = null
        resolve()
      }
      if (reducedMotion()) finish()
      else setTimeout(finish, POPUP_OUT_MS)
    }

    _popup = {
      item, el, hide,
      refresh() {
        label()
        el.querySelector('.ann-card')?.replaceWith(buildCard(byId(item.id) ?? item, { inPopup: true }))
        fitBodies(el)
      },
    }
    run()
  })
}

function hidePopup() {
  _popup?.hide()
}
