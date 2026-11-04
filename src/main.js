import './styles/global.css'
import { makeLogger } from './modules/logger.js'
import store from './modules/store.js'

const log = makeLogger('Boot')
import * as events from './modules/events.js'
import { initTauriApi, initDownloadListeners, api } from './modules/tauri-api.js'
import { initI18n, t } from './modules/i18n.js'
import { init as initGrid } from './modules/grid.js'
import { init as initCollections } from './modules/collections.js'
import { init as initBoards } from './modules/boards.js'
import { init as initTags } from './modules/tags.js'
import { init as initSearch } from './modules/search.js'
import { init as initSettings, showTab, applyVisualSettings } from './modules/settings.js'
import { init as initOnboarding } from './modules/onboarding.js'
import { init as initLicensing, isSignedIn, getPlan, openHub } from './modules/licensing.js'
import { init as initNotifications } from './modules/notifications.js'
import { init as initMilestones } from './modules/milestones.js'
import { init as initExtension } from './modules/extension.js'
import { openColorPicker, isColorPickerOpen, closeColorPicker } from './modules/color-picker.js'
import { startTask } from './modules/progress-ring.js'
import { initDownloader, checkUrl, handleSwatchClick, startDownloadFromInput, isUrl } from './modules/downloader.js'
import { init as initCardDetail } from './modules/card-detail.js'
import { init as initOcr, startIndexing as startOcr } from './modules/ocr.js'
import { initAutoTag } from './modules/auto-tag.js'
// Object detection temporarily disabled (was polluting search) — re-enable later:
// import { initObjectTags } from './modules/object-tags.js'
import { initDeveloper, runDevCommand } from './modules/developer.js'
import { syncTagVocab } from './modules/tag-sync.js'
import { init as initImporter } from './modules/importer.js'
import { init as initDownloadTracker } from './modules/download-tracker.js'
import { init as initDownloadIndicator } from './modules/download-indicator.js'
import { init as initActivityView } from './modules/activity-view.js'
import { init as initDuplicates } from './modules/duplicates.js'
import { startWalkthrough } from './modules/walkthrough.js'
import { initDiagnostics } from './modules/diagnostics.js'
import { openFeedbackModal } from './modules/feedback.js'
import { reducedMotion } from './modules/motion.js'
import { initPageBar, setPageBar } from './modules/page-bar.js'
import { isStarterPreview, applyStarterPreview, showStarterPill } from './modules/starter.js'

// Expose progress API globally so download handlers can reach it
window.__progressRing = { startTask }

// ─── Nav config ─────────────────────────────────────────────────
const PRIMARY_NAV = [
  { view: 'grid',        icon: 'house',            labelKey: 'nav.home' },
  { view: 'collections', icon: 'folder',           labelKey: 'nav.collections' },
  // Boards is intentionally hidden from the drawer — reachable only via the
  // secret search-bar command `blt_boards` (see developer.js → runDevCommand).
  { view: 'activity',    icon: 'clock-counter-clockwise', labelKey: 'nav.activity'   },
  { view: 'duplicates',  icon: 'copy',             labelKey: 'nav.duplicates' },
  { view: 'milestones',  icon: 'trophy',           labelKey: 'nav.milestones' },
]

// Settings sits at the very bottom, under the storage meter.
const SECONDARY_NAV = [
  { view: 'settings',    icon: 'sliders',          labelKey: 'nav.settings'   },
]

// ─── State ──────────────────────────────────────────────────────
let currentView = 'grid'
let activeColorFilter = null
let activeColorTolerance = 'normal'

// ─── Icon helper ────────────────────────────────────────────────
function makeIcon(name, size = 18) {
  const el = document.createElement('span')
  el.className = `icon icon-${size}`
  el.style.maskImage = `url('/icons/${name}.svg')`
  el.style.webkitMaskImage = `url('/icons/${name}.svg')`
  el.setAttribute('aria-hidden', 'true')
  return el
}

// ─── Top bar setup ───────────────────────────────────────────────
function setupTopBar(settings) {
  const navDrawer = document.getElementById('nav-drawer')

  // Hamburger
  const drawerToggle = document.getElementById('nav-drawer-toggle')
  drawerToggle.appendChild(makeIcon('list', 20))
  drawerToggle.addEventListener('click', () => {
    if (navDrawer.classList.toggle('nav-open')) refreshDrawerExtras()
  })

  // Backdrop
  document.getElementById('nav-drawer-backdrop')
    .addEventListener('click', () => navDrawer.classList.remove('nav-open'))

  // Import button
  document.querySelector('.top-bar-brand').addEventListener('click', e => {
    e.preventDefault()
    navigate('grid')
    navDrawer.classList.remove('nav-open')
  })

  const importBtn = document.getElementById('top-bar-import-btn')
  importBtn.addEventListener('click', () => store.emit(events.IMPORT_REQUESTED))

  // Search shortcut hint follows the platform's modifier key
  const kbd = document.querySelector('.search-kbd')
  if (kbd && /Mac/i.test(navigator.platform)) kbd.textContent = '⌘ K'

  // Download indicator icon
  const dlIndicatorIcon = document.querySelector('.dl-indicator-icon')
  if (dlIndicatorIcon) dlIndicatorIcon.appendChild(makeIcon('download-simple', 20))

  // Profile avatar
  setupAvatar(settings)

  // Color picker swatch
  setupColorSwatch()

  // Media-type filter (all / images / videos)
  setupMediaFilter()

  // Search input — fires only on Enter or icon click, clears immediately when emptied
  const searchInput     = document.getElementById('top-bar-search')
  const searchSubmitBtn = document.getElementById('search-submit-btn')
  const swatchBtn       = document.getElementById('color-swatch-btn')
  initDownloader(searchInput, swatchBtn)

  const emitSearch = () =>
    store.emit(events.SEARCH_QUERY_CHANGED, { query: searchInput.value.trim() || null })

  searchInput.addEventListener('input', () => {
    checkUrl(searchInput.value)
    // Reset grid immediately when input is cleared
    if (!searchInput.value.trim()) emitSearch()
  })
  // Shared submit for Enter + the search button. Secret blt_ commands are
  // dispatched here and NEVER trigger a normal search.
  const submitSearch = async () => {
    const value = searchInput.value.trim()
    if (value.startsWith('blt_')) {
      const handled = await runDevCommand(value)
      if (!handled) searchInput.value = ''   // unknown blt_ command — clear, don't search
      return
    }
    // A URL starts a download; anything else is a search. (Enter used to go through
    // handleSwatchClick, which cancels the running download — so searching while a
    // video downloaded silently killed it and threw the query away.)
    if (isUrl(value)) { await startDownloadFromInput(); return }
    if (value) emitSearch()
  }

  searchInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') { e.preventDefault(); await submitSearch() }
  })
  searchSubmitBtn?.addEventListener('click', submitSearch)

  // No browser context menu on the app chrome — except in text fields, where people
  // right-click → Paste (the usual way to drop a link into the search bar).
  document.addEventListener('contextmenu', e => {
    if (e.target.closest?.('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, [contenteditable="true"]')) return
    e.preventDefault()
  })

  document.addEventListener('keydown', e => {
    if (
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C'))
    ) {
      e.preventDefault()
      return
    }
  }, true)

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      searchInput.focus()
      searchInput.select()
    }
    if (e.key === 'Escape' && document.activeElement === searchInput) {
      searchInput.blur()
    }
  })
}

// ─── Profile avatar + dropdown ───────────────────────────────────
function setupAvatar(settings) {
  const avatarBtn = document.getElementById('top-bar-avatar')

  // The photo is set in bloot apps (licensing.js mirrors it into profile_image) and
  // qooti only shows it; without one, the initial on its colour.
  let photo = settings?.profile_image || ''
  let name  = settings?.display_name || 'U'
  let dropdown = null
  const paintAvatar = el => {
    el.replaceChildren()
    if (photo) {
      const img = document.createElement('img')
      img.src = photo
      img.alt = ''
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block'
      img.onerror = () => { photo = ''; paint() }   // a damaged photo file: the initial instead
      el.appendChild(img)
      el.style.background = 'transparent'
    } else {
      el.textContent = name.charAt(0).toUpperCase()
      el.style.background = avatarColor(name)
    }
  }
  const paint = () => {
    paintAvatar(avatarBtn)
    if (!dropdown) return
    paintAvatar(dropdown.querySelector('.pd-avatar'))
    dropdown.querySelector('.pd-name').textContent = name
  }
  paint()

  store.on(events.SETTINGS_CHANGED, ({ key, value }) => {
    if (key === 'profile_image') photo = value || ''
    else if (key === 'display_name') name = value || 'U'
    else return
    paint()
  })

  // Build dropdown
  dropdown = buildProfileDropdown(name, name.charAt(0).toUpperCase(), avatarBtn.style.background)

  let open = false
  avatarBtn.addEventListener('click', e => {
    e.stopPropagation()
    open = !open
    if (open) {
      const rect = avatarBtn.getBoundingClientRect()
      dropdown.style.right = `${window.innerWidth - rect.right}px`
      dropdown.style.top   = `${rect.bottom + 6}px`
      dropdown.classList.remove('hidden')
      // restart entrance animation on each open
      dropdown.style.animation = 'none'
      void dropdown.offsetWidth
      dropdown.style.animation = ''
    } else {
      dropdown.classList.add('hidden')
    }
  })

  document.addEventListener('click', () => {
    if (open) { open = false; dropdown.classList.add('hidden') }
  })
  dropdown.addEventListener('click', e => e.stopPropagation())
}

// Guide G3: who you are (avatar, name, plan), then the places you go from here.
function buildProfileDropdown(displayName, initial, avatarBg) {
  const el = document.createElement('div')
  el.className = 'profile-dropdown hidden'

  const head = document.createElement('div')
  head.className = 'pd-head'
  const av = document.createElement('span')
  av.className = 'pd-avatar'
  const src = document.querySelector('#top-bar-avatar img')?.src
  if (src) { const img = document.createElement('img'); img.src = src; img.alt = ''; av.appendChild(img) }
  else { av.textContent = initial; av.style.background = avatarBg }
  const who = document.createElement('span')
  who.className = 'pd-who'
  who.innerHTML = `<span class="pd-name"></span><span class="pd-sub" data-i18n="account.bloot">${t('account.bloot')}</span>`
  who.querySelector('.pd-name').textContent = displayName
  head.append(av, who)
  if (getPlan() === 'pro') {
    const badge = document.createElement('span')
    badge.className = 'pd-plan'
    badge.textContent = 'Pro'
    head.appendChild(badge)
  }
  el.appendChild(head)
  el.appendChild(Object.assign(document.createElement('div'), { className: 'pd-divider' }))

  const menuItems = [
    { i18nKey: 'nav.settings',            icon: 'sliders',                 view: 'settings',   tab: 'general' },
    { i18nKey: 'nav.activity',            icon: 'clock-counter-clockwise', view: 'activity',   tab: null },
    { i18nKey: 'nav.milestones',          icon: 'trophy',                  view: 'milestones', tab: null },
    { i18nKey: 'feedback.menu',           icon: 'feedback',                action: 'feedback' },
    null,
    { i18nKey: 'account.manage',          icon: 'arrow-square-out',        action: 'account' },
  ]

  for (const item of menuItems) {
    if (!item) {
      const div = document.createElement('div')
      div.className = 'pd-divider'
      el.appendChild(div)
      continue
    }
    const btn = document.createElement('button')
    btn.className = 'pd-item'
    btn.appendChild(makeIcon(item.icon, 16))
    const labelSpan = document.createElement('span')
    labelSpan.dataset.i18n = item.i18nKey
    labelSpan.textContent = t(item.i18nKey)
    btn.appendChild(labelSpan)
    btn.addEventListener('click', () => {
      el.classList.add('hidden')
      if (item.action === 'feedback') { openFeedbackModal(); return }
      if (item.action === 'account') { openHub('account'); return }
      if (item.tab) showTab(item.tab)  // set active tab before navigate triggers render
      navigate(item.view)
    })
    el.appendChild(btn)
  }

  document.getElementById('overlays').appendChild(el)
  return el
}

// Hash display name to a consistent accent color
function avatarColor(name) {
  const palette = ['#7C3AED','#2563EB','#059669','#D97706','#DC2626','#DB2777','#0891B2']
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xFFFF
  return palette[h % palette.length]
}

// ─── Color swatch ────────────────────────────────────────────────
function setupColorSwatch() {
  const btn = document.getElementById('color-swatch-btn')

  btn.addEventListener('click', async e => {
    e.stopPropagation()
    const handled = await handleSwatchClick()
    if (handled) return

    // Toggle: a second click on the swatch closes the open picker instead of reopening.
    if (isColorPickerOpen()) { closeColorPicker(); return }

    openColorPicker(btn, {
      initialColor: activeColorFilter,
      initialTolerance: activeColorTolerance,
      onSearch: (hex, tolerance) => {
        activeColorFilter = hex
        activeColorTolerance = tolerance ?? 'normal'
        btn.style.setProperty('--swatch-color', hex)   // .has-color shows a solid swatch of this
        btn.classList.add('has-color')
        store.emit(events.SEARCH_COLOR_CHANGED, { hex, tolerance: activeColorTolerance })
      },
      onClear: clearColor,
    })
  })

  function clearColor() {
    activeColorFilter = null
    activeColorTolerance = 'normal'
    btn.style.removeProperty('--swatch-color')
    btn.classList.remove('has-color')
    store.emit(events.SEARCH_COLOR_CHANGED, { hex: null })
  }
  store.on(events.FILTER_CLEAR_REQUESTED, ({ which }) => { if (which === 'color') clearColor() })
}

// ─── Media-type filter (all / images / videos) ───────────────────
let activeMediaFilter = null   // null | 'image' | 'video'

function setupMediaFilter() {
  const btn  = document.getElementById('media-filter-btn')
  const icon = document.getElementById('media-filter-icon')
  if (!btn || !icon) return

  const OPTIONS = [
    { key: 'all',   i18n: 'media.all',    icon: 'squares-four' },
    { key: 'image', i18n: 'media.images', icon: 'image'        },
    { key: 'video', i18n: 'media.videos', icon: 'video-camera' },
  ]
  const TYPES = { image: ['image', 'gif'], video: ['video'] }

  const menu = document.createElement('div')
  menu.className = 'media-filter-menu hidden'
  document.getElementById('overlays').appendChild(menu)

  let open = false

  const setIcon = name => {
    icon.style.maskImage = `url('/icons/${name}.svg')`
    icon.style.webkitMaskImage = `url('/icons/${name}.svg')`
  }

  function render() {
    const active = activeMediaFilter ?? 'all'
    menu.innerHTML = OPTIONS.map(o => `
      <button class="mf-item${o.key === active ? ' active' : ''}" data-key="${o.key}">
        <span class="icon icon-16" style="mask-image:url('/icons/${o.icon}.svg');-webkit-mask-image:url('/icons/${o.icon}.svg')" aria-hidden="true"></span>
        <span class="mf-label">${t(o.i18n)}</span>
        ${o.key === active ? `<span class="mf-check icon icon-14" style="mask-image:url('/icons/check.svg');-webkit-mask-image:url('/icons/check.svg')" aria-hidden="true"></span>` : ''}
      </button>`).join('')
    menu.querySelectorAll('.mf-item').forEach(el =>
      el.addEventListener('click', () => { select(el.dataset.key); close() }))
  }

  function position() {
    const r = btn.getBoundingClientRect()
    menu.style.top  = `${r.bottom + 6}px`
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`
  }

  function openMenu() { render(); menu.classList.remove('hidden'); position(); open = true; btn.classList.add('menu-open') }
  function close()    { menu.classList.add('hidden'); open = false; btn.classList.remove('menu-open') }

  function select(key) {
    activeMediaFilter = key === 'all' ? null : key
    setIcon(key === 'all' ? 'funnel' : OPTIONS.find(o => o.key === key).icon)
    btn.classList.toggle('has-filter', !!activeMediaFilter)
    btn.title = t(activeMediaFilter ? OPTIONS.find(o => o.key === key).i18n : 'media.filter')
    store.emit(events.SEARCH_MEDIA_CHANGED, { types: activeMediaFilter ? TYPES[activeMediaFilter] : null })
  }

  btn.addEventListener('click', e => { e.stopPropagation(); open ? close() : openMenu() })
  document.addEventListener('click', () => { if (open) close() })
  menu.addEventListener('click', e => e.stopPropagation())
  store.on(events.FILTER_CLEAR_REQUESTED, ({ which }) => { if (which === 'media') select('all') })
  window.addEventListener('resize', () => { if (open) position() })
  document.addEventListener('i18n:changed', () => { if (open) render() })
}

// ─── Drawer nav ──────────────────────────────────────────────────
function buildDrawerNav() {
  const primary   = document.getElementById('drawer-nav-primary')
  const secondary = document.getElementById('drawer-nav-secondary')

  for (const { view, icon, labelKey } of PRIMARY_NAV) {
    primary.appendChild(makeNavItem(view, icon, labelKey))
  }
  for (const { view, icon, labelKey } of SECONDARY_NAV) {
    secondary.appendChild(makeNavItem(view, icon, labelKey))
  }
  document.querySelector(`.nav-item[data-view="${currentView}"]`)?.classList.add('active')
}

// Collections list + storage meter, refreshed each time the drawer opens.
async function refreshDrawerExtras() {
  const section = document.getElementById('drawer-collections-section')
  const list    = document.getElementById('drawer-collections')
  const storage = document.getElementById('drawer-storage')
  const [cols, vault] = await Promise.all([
    api.listCollections().catch(() => []),
    api.getVaultInfo().catch(() => null),
  ])

  list.replaceChildren(...cols.map(col => {
    const btn = document.createElement('button')
    btn.className = 'nav-col'
    const dot = document.createElement('span')
    dot.className = 'nav-col-dot'
    const name = document.createElement('span')
    name.className = 'nav-col-name'
    name.textContent = col.name
    btn.append(dot, name)
    btn.addEventListener('click', () => {
      store.emit(events.COLLECTION_SELECTED, { id: col.id, name: col.name })
      navigate('grid')
      document.getElementById('nav-drawer').classList.remove('nav-open')
    })
    return btn
  }))
  section.hidden = cols.length === 0

  if (vault) {
    const used = vault.size_bytes ?? 0
    const total = used + (vault.disk_free_bytes ?? 0)
    document.getElementById('drawer-storage-text').textContent =
      `${t('nav.items', { n: (vault.total_items ?? 0).toLocaleString() })} · ${fmtBytes(used)}`
    document.getElementById('drawer-storage-fill').style.width =
      total ? `${Math.max(2, Math.min(100, used / total * 100))}%` : '0%'
  }
  storage.hidden = !vault
}

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024)        return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function makeNavItem(view, iconName, labelKey) {
  const btn = document.createElement('button')
  btn.className = 'nav-item'
  btn.dataset.view = view
  btn.appendChild(makeIcon(iconName, 16))

  const label = document.createElement('span')
  label.className = 'nav-label'
  label.dataset.i18n = labelKey
  // Real text now: the one-time data-i18n pass (initI18n) runs before the drawer is
  // built, so the old placeholder ('home', 'activity'…) stayed until a language switch.
  label.textContent = t(labelKey)
  btn.appendChild(label)

  btn.addEventListener('click', () => {
    navigate(view)
    document.getElementById('nav-drawer').classList.remove('nav-open')
  })
  return btn
}

// ─── Navigation ─────────────────────────────────────────────────
export function navigate(view) {
  if (view === currentView) return
  currentView = view

  // Crossfade between pages (View Transitions: the old page fades out, the new one fades
  // in rising 4 px, the title bar and top bar stay still — see global.css). Where the API
  // is missing, the new page just fades up on its own.
  const swap = (enterAnim) => {
    document.querySelectorAll('.view').forEach(el => { el.hidden = true })
    const target = document.getElementById(`view-${view}`)
    if (target) {
      target.hidden = false
      target.classList.remove('view-enter')
      if (enterAnim) {
        void target.offsetWidth  // force reflow so animation restarts
        target.classList.add('view-enter')
      }
    }
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view)
    })
    // Library bar by default; pages without search set their own on NAV_CHANGE
    setPageBar(null)
    store.emit(events.NAV_CHANGE, { view })
  }

  // Hidden/minimised window: switch at once (a transition would wait for the next frame).
  if (document.startViewTransition && !reducedMotion() && document.visibilityState === 'visible') {
    const vt = document.startViewTransition(() => swap(false))
    // A quick second switch skips this one — expected, not an error worth logging.
    for (const p of [vt.ready, vt.finished, vt.updateCallbackDone]) p?.catch(() => {})
  } else {
    swap(true)
  }
}

// ─── Splash ──────────────────────────────────────────────────────
function hideSplash() {
  const splash = document.getElementById('splash')
  splash.classList.add('hiding')
  setTimeout(() => splash.remove(), 280)
}

// ─── Title bar (Windows) ─────────────────────────────────────────
function setupTitleBar() {
  const bar = document.getElementById('title-bar')
  bar.hidden = false
  document.documentElement.classList.add('platform-windows')

  document.getElementById('btn-minimize').addEventListener('click', () => api.windowMinimize())
  document.getElementById('btn-maximize').addEventListener('click', () => api.windowMaximize())
  document.getElementById('btn-close').addEventListener('click',    () => api.windowClose())

  // Unfocused window: the bar fades back (guide B8)
  const root = document.documentElement
  window.addEventListener('blur',  () => root.classList.add('window-inactive'))
  window.addEventListener('focus', () => root.classList.remove('window-inactive'))
}

// ─── Toast notifications ─────────────────────────────────────────
// Guide H3: a small pill at the bottom centre — status icon + one line.
// `key`: a toast with the same key that is still showing isn't repeated — it takes the
// new text, stays up longer (and nods once). `action`: { label, onClick } adds a button.
const TOAST_ICON = { success: 'check-circle', info: 'info', warning: 'warning', error: 'warning' }
const _keyedToasts = new Map()   // key → { el, extend }
function showToast({ type = 'info', message, duration = 5000, key = null, action = null }) {
  const live = key && _keyedToasts.get(key)
  if (live) { live.extend(message); return }

  const el = document.createElement('div')
  el.className = `system-toast system-toast--${type}`
  el.appendChild(makeIcon(TOAST_ICON[type] ?? 'info', 16))
  const text = document.createElement('span')
  text.textContent = message
  el.appendChild(text)

  if (action?.label) {
    const btn = document.createElement('button')
    btn.className = 'system-toast__action'
    btn.textContent = action.label
    btn.addEventListener('click', () => { action.onClick?.(); dismiss() })
    el.appendChild(btn)
  }

  // Problems stay until read; everything else just fades away
  if (type === 'error' || type === 'warning') {
    const close = document.createElement('button')
    close.className = 'system-toast__close'
    close.setAttribute('aria-label', t('update.dismiss'))
    close.appendChild(makeIcon('x', 14))
    close.addEventListener('click', () => dismiss())
    el.appendChild(close)
  }

  const container = document.getElementById('toast-container') ?? (() => {
    const c = document.createElement('div')
    c.id = 'toast-container'
    document.body.appendChild(c)
    return c
  })()

  container.appendChild(el)

  let timer = setTimeout(dismiss, duration)

  if (key) {
    _keyedToasts.set(key, {
      el,
      extend(next) {
        if (next) text.textContent = next
        clearTimeout(timer)
        timer = setTimeout(dismiss, duration)
        el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }],
          { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
      },
    })
  }

  function dismiss() {
    clearTimeout(timer)
    if (key && _keyedToasts.get(key)?.el === el) _keyedToasts.delete(key)
    el.classList.add('system-toast--out')
    el.addEventListener('animationend', () => el.remove(), { once: true })
    setTimeout(() => el.remove(), 400)   // hidden window: animationend may not fire
  }
}

// The update notification now lives as a bar under the tag pills in the home
// grid (see grid.js → renderUpdateBar), driven by the same UPDATE_AVAILABLE
// event. No top-bar button anymore.

// ─── Store listeners ─────────────────────────────────────────────
function bindStoreListeners() {
  store.on(events.NAVIGATE, ({ view }) => navigate(view))
  store.on(events.SYSTEM_TOAST, showToast)
  store.on(events.SESSION_EXPIRED, () => {
    // bloot apps signed out (or its ticket ran out offline). Show the sign-in
    // screen on top of whatever is currently visible; it closes by itself once
    // bloot apps is signed in again.
    initOnboarding(document.getElementById('onboarding-root'))
  })
}

// ─── Boot ────────────────────────────────────────────────────────
async function boot() {
  const t0 = performance.now()
  initDiagnostics()   // start the activity trail + error capture for feedback reports
  log.info('start', {})
  try {
    const appInfo = await initTauriApi()

    if (appInfo.platform === 'windows') setupTitleBar()

    // Language first — everything below renders with t(). This used to be a bare
    // initI18n(), so a saved Uzbek choice was dropped on every restart.
    const settings = await api.getSettings()
    initI18n(settings.language)
    // blt_starter: preview as a brand-new user — must be in place before any view loads
    const starter = isStarterPreview()
    if (starter) { applyStarterPreview(api); showStarterPill() }
    bindStoreListeners()
    initPageBar()
    buildDrawerNav()

    applyVisualSettings(settings)
    setupTopBar(settings)

    // Bridge Tauri download events into the store (also wires update-available,
    // which the home grid picks up to show the update bar under the tag pills).
    await initDownloadListeners()

    // Start background OCR — PP-OCRv4 in a WASM worker (no native sidecar).
    // Only inside Tauri: it needs real vault files (browser mock has none).
    if ('__TAURI_INTERNALS__' in window) { await initOcr(); startOcr() }

    // Sync shared tag vocabulary from GitHub (fire-and-forget, silent)
    syncTagVocab()

    // Start auto-tag pipeline — model downloads once and caches permanently
    initAutoTag()

    // Object detection temporarily disabled (search pollution) — re-enable later:
    // initObjectTags()

    // Developer overlay (secret trigger: type blt_developer in search bar + Enter)
    initDeveloper()

    // Import modal
    initImporter()

    // Download tracking + top-bar indicator (must be before initExtension so
    // DOWNLOAD_STARTED emitted from extension.js is caught by the tracker)
    initDownloadTracker()
    initDownloadIndicator()

    // Init all modules.
    // Settings MUST init before the grid: it hydrates the getSetting() cache
    // (plan, etc.) that the grid reads on its very first reload(). Otherwise the
    // grid renders with an empty plan and shows the free teaser/200-cap to a Pro
    // user until a later validation happens to reload it.
    initSettings(document.getElementById('view-settings'), settings)
    initExtension()
    // The account comes from bloot apps' signed ticket (offline, ~1 ms). Awaited so
    // the grid's first render already knows the plan, and the sign-in decision below
    // is made on it.
    await initLicensing()
    initCardDetail()
    initGrid(document.getElementById('view-grid'), settings)
    initCollections(document.getElementById('view-collections'), settings)
    initBoards(document.getElementById('view-boards'), settings)
    initTags()
    initSearch(document.getElementById('view-search'), settings)
    initNotifications(document.getElementById('view-notifications'))
    initMilestones(document.getElementById('view-milestones'))
    initActivityView(document.getElementById('view-activity'))
    initDuplicates(document.getElementById('view-duplicates'))

    // Signed in = bloot apps is signed in on this computer; then qooti opens straight
    // into the library (zero clicks). Otherwise the one-step "Continue with bloot
    // apps" screen shows — also once for existing users from the typed-bloot-ID days.
    // Orientation is handled by the in-app spotlight tour.
    // (In the blt_starter preview everything runs from the first screen again.)
    const effectiveState  = isSignedIn() && !starter ? 'complete' : 'pending_login'
    if (effectiveState === 'complete' && settings.onboarding_state !== 'complete') {
      await api.setSetting('onboarding_state', 'complete')
    }
    const walkthroughDone = !!settings.walkthrough_done && !starter

    if (effectiveState !== 'complete') {
      initOnboarding(document.getElementById('onboarding-root'), { ...settings, onboarding_state: effectiveState })
      // When onboarding finishes it emits NAVIGATE → grid; start tour then (once only)
      if (!walkthroughDone) {
        let _tourStarted = false
        store.on(events.NAVIGATE, ({ view }) => {
          if (view === 'grid' && !_tourStarted) {
            _tourStarted = true
            setTimeout(startWalkthrough, 700)
          }
        })
      }
    } else {
      navigate('grid')
      if (!walkthroughDone) setTimeout(startWalkthrough, 700)

      // If the app was launched by double-clicking a .qooti file (cold start),
      // the backend stashed the path — pull it now and open the importer.
      try {
        const lf = await api.takeLaunchFile()
        if (lf) store.emit(events.QOOTI_FILE_OPEN, { path: lf })
      } catch {}
    }

    const elapsed = performance.now() - t0
    setTimeout(hideSplash, Math.max(0, 1000 - elapsed))
    log.info('ready', { ms: Math.round(elapsed) })
  } catch (err) {
    log.error('failed', { error: err })
    const splash = document.getElementById('splash')
    if (splash) {
      const splashErr = splash.querySelector('.splash-error')
      if (splashErr) { splashErr.textContent = 'Something went wrong — restart qooti'; splashErr.hidden = false }
    }
  }
}

boot()
