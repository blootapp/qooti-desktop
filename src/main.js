import './styles/global.css'
import { makeLogger } from './modules/logger.js'
import store from './modules/store.js'

const log = makeLogger('Boot')
import * as events from './modules/events.js'
import { initTauriApi, initDownloadListeners, api } from './modules/tauri-api.js'
import { initI18n, t } from './modules/i18n.js'
import { init as initGrid } from './modules/grid.js'
import { init as initCollections } from './modules/collections.js'
import { init as initTags } from './modules/tags.js'
import { init as initSearch } from './modules/search.js'
import { init as initSettings, showTab, applyVisualSettings, syncAccountIfStale } from './modules/settings.js'
import { init as initOnboarding } from './modules/onboarding.js'
import { init as initLicensing } from './modules/licensing.js'
import { init as initNotifications } from './modules/notifications.js'
import { init as initMilestones } from './modules/milestones.js'
import { init as initExtension } from './modules/extension.js'
import { openColorPicker } from './modules/color-picker.js'
import { startTask } from './modules/progress-ring.js'
import { initDownloader, checkUrl, handleSwatchClick } from './modules/downloader.js'
import { init as initCardDetail } from './modules/card-detail.js'
import { init as initOcr, startIndexing as startOcr } from './modules/ocr.js'
import { initAutoTag } from './modules/auto-tag.js'
import { initDeveloper } from './modules/developer.js'
import { syncTagVocab } from './modules/tag-sync.js'
import { init as initImporter } from './modules/importer.js'
import { init as initDownloadTracker } from './modules/download-tracker.js'
import { init as initDownloadIndicator } from './modules/download-indicator.js'
import { init as initActivityView } from './modules/activity-view.js'
import { startWalkthrough } from './modules/walkthrough.js'

// Expose progress API globally so download handlers can reach it
window.__progressRing = { startTask }

// ─── Nav config ─────────────────────────────────────────────────
const PRIMARY_NAV = [
  { view: 'grid',        icon: 'house',            labelKey: 'nav.home' },
  { view: 'collections', icon: 'folder',           labelKey: 'nav.collections' },
  { view: 'search',      icon: 'magnifying-glass', labelKey: 'nav.search' },
]

const SECONDARY_NAV = [
  { view: 'activity',      icon: 'clock-counter-clockwise', labelKey: 'nav.activity'   },
  { view: 'milestones',    icon: 'trophy',            labelKey: 'nav.milestones' },
  { view: 'settings',      icon: 'gear',              labelKey: 'nav.settings'   },
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
  drawerToggle.appendChild(makeIcon('list', 18))
  drawerToggle.addEventListener('click', () => navDrawer.classList.toggle('nav-open'))

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
  importBtn.appendChild(makeIcon('plus', 18))
  importBtn.title = 'Import'
  importBtn.addEventListener('click', () => store.emit(events.IMPORT_REQUESTED))

  // Download indicator icon (SVG injected here so it picks up currentColor)
  const dlIndicatorIcon = document.querySelector('.dl-indicator-icon')
  if (dlIndicatorIcon) {
    dlIndicatorIcon.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="10,3 10,13"/><polyline points="6,10 10,14 14,10"/><line x1="4" y1="17" x2="16" y2="17"/></svg>`
  }

  // Profile avatar
  setupAvatar(settings)

  // Color picker swatch
  setupColorSwatch()

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
  searchInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const handled = await handleSwatchClick()
      if (!handled && searchInput.value.trim()) emitSearch()
    }
  })
  searchSubmitBtn?.addEventListener('click', async () => {
    const handled = await handleSwatchClick()
    if (!handled && searchInput.value.trim()) emitSearch()
  })

  document.addEventListener('contextmenu', e => e.preventDefault())

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
  const displayName = settings?.display_name || 'U'
  const initial = displayName.charAt(0).toUpperCase()

  const avatarBtn = document.getElementById('top-bar-avatar')

  if (settings?.profile_image) {
    avatarBtn.textContent = ''
    const img = document.createElement('img')
    img.src = settings.profile_image
    img.alt = displayName
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block'
    avatarBtn.appendChild(img)
    avatarBtn.style.background = 'transparent'
  } else {
    avatarBtn.textContent = initial
    avatarBtn.style.background = avatarColor(displayName)
  }

  store.on(events.SETTINGS_CHANGED, ({ key, value }) => {
    if (key !== 'profile_image') return
    avatarBtn.innerHTML = ''
    const img = document.createElement('img')
    img.src = value
    img.alt = displayName
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block'
    avatarBtn.appendChild(img)
    avatarBtn.style.background = 'transparent'
  })

  // Build dropdown
  const dropdown = buildProfileDropdown(displayName, initial, avatarBtn.style.background)

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

function buildProfileDropdown(_displayName, _initial, _avatarBg) {
  const el = document.createElement('div')
  el.className = 'profile-dropdown hidden'

  const menuItems = [
    { i18nKey: 'settings.tab.general',    icon: 'user-circle',     view: 'settings',    tab: 'general'    },
    { i18nKey: 'settings.tab.appearance', icon: 'palette',          view: 'settings',    tab: 'appearance' },
    null,
    { i18nKey: 'settings.tab.downloads',  icon: 'download-simple', view: 'settings',    tab: 'downloads'  },
    null,
    { i18nKey: 'nav.milestones',          icon: 'trophy',           view: 'milestones',  tab: null },
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

    openColorPicker(btn, {
      initialColor: activeColorFilter,
      initialTolerance: activeColorTolerance,
      onSearch: (hex, tolerance) => {
        activeColorFilter = hex
        activeColorTolerance = tolerance ?? 'normal'
        btn.style.color = hex   // tints the painting icon via currentColor mask
        btn.classList.add('has-color')
        store.emit(events.SEARCH_COLOR_CHANGED, { hex, tolerance: activeColorTolerance })
      },
      onClear: () => {
        activeColorFilter = null
        activeColorTolerance = 'normal'
        btn.style.color = ''
        btn.classList.remove('has-color')
        store.emit(events.SEARCH_COLOR_CHANGED, { hex: null })
      },
    })
  })
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
}

function makeNavItem(view, iconName, labelKey) {
  const btn = document.createElement('button')
  btn.className = 'nav-item'
  btn.dataset.view = view
  btn.appendChild(makeIcon(iconName))

  const label = document.createElement('span')
  label.className = 'nav-label'
  label.dataset.i18n = labelKey
  label.textContent = labelKey.split('.').pop()
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

  document.querySelectorAll('.view').forEach(el => { el.hidden = true })
  const target = document.getElementById(`view-${view}`)
  if (target) {
    target.hidden = false
    target.classList.remove('view-enter')
    void target.offsetWidth  // force reflow so animation restarts
    target.classList.add('view-enter')
  }

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view)
  })

  store.emit(events.NAV_CHANGE, { view })
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
}

// ─── Toast notifications ─────────────────────────────────────────
function showToast({ type = 'info', message, duration = 5000 }) {
  const el = document.createElement('div')
  el.className = `system-toast system-toast--${type}`
  el.textContent = message

  const close = document.createElement('button')
  close.className = 'system-toast__close'
  close.setAttribute('aria-label', 'Dismiss')
  close.textContent = '×'
  close.addEventListener('click', () => dismiss())
  el.appendChild(close)

  const container = document.getElementById('toast-container') ?? (() => {
    const c = document.createElement('div')
    c.id = 'toast-container'
    document.body.appendChild(c)
    return c
  })()

  container.appendChild(el)

  let timer = setTimeout(dismiss, duration)

  function dismiss() {
    clearTimeout(timer)
    el.classList.add('system-toast--out')
    el.addEventListener('animationend', () => el.remove(), { once: true })
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
    // User account was deleted on the server mid-session. Show the login
    // screen on top of whatever is currently visible.
    initOnboarding(document.getElementById('onboarding-root'), { onboarding_state: 'pending_login' })
  })
}

// ─── Boot ────────────────────────────────────────────────────────
async function boot() {
  const t0 = performance.now()
  log.info('start', {})
  try {
    const appInfo = await initTauriApi()

    if (appInfo.platform === 'windows') setupTitleBar()

    initI18n()
    bindStoreListeners()
    buildDrawerNav()

    const settings = await api.getSettings()
    applyVisualSettings(settings)
    setupTopBar(settings)

    // Bridge Tauri download events into the store (also wires update-available,
    // which the home grid picks up to show the update bar under the tag pills).
    await initDownloadListeners()

    // Start background OCR — PP-OCRv4 in a WASM worker (no native sidecar).
    // Only inside Tauri: it needs real vault files (browser mock has none).
    if ('__TAURI_INTERNALS__' in window) { await initOcr(); startOcr() }

    // Sync display name + plan from server (throttled to once per 5 days, fire-and-forget)
    syncAccountIfStale(settings)

    // Sync shared tag vocabulary from GitHub (fire-and-forget, silent)
    syncTagVocab()

    // Start auto-tag pipeline — model downloads once and caches permanently
    initAutoTag()

    // Developer overlay (secret trigger: type blt_developer in search bar + Enter)
    initDeveloper()

    // Import modal
    initImporter()

    // Download tracking + top-bar indicator (must be before initExtension so
    // DOWNLOAD_STARTED emitted from extension.js is caught by the tracker)
    initDownloadTracker()
    initDownloadIndicator()

    // Init all modules
    initExtension()
    initLicensing()
    initCardDetail()
    initGrid(document.getElementById('view-grid'), settings)
    initCollections(document.getElementById('view-collections'), settings)
    initTags()
    initSearch(document.getElementById('view-search'), settings)
    initSettings(document.getElementById('view-settings'), settings)
    initNotifications(document.getElementById('view-notifications'))
    initMilestones(document.getElementById('view-milestones'))
    initActivityView(document.getElementById('view-activity'))

    // First launch (and any non-complete state) goes straight to the bloot ID
    // sign-in — no name/photo prompt, no full-screen guide. Onboarding is a
    // single step now; orientation is handled by the in-app spotlight tour.
    const onboardingState = settings.onboarding_state ?? 'pending_login'
    // If onboarding was previously completed but bloot_id is now missing
    // (e.g. cleared after a 404, or a corrupted preferences row), require sign-in.
    const effectiveState  = (onboardingState === 'complete' && !settings.bloot_id)
      ? 'pending_login'
      : onboardingState
    const walkthroughDone = !!settings.walkthrough_done

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
