import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { open as openDetail } from './card-detail.js'
import { openSimilarCanvas } from './similar-canvas.js'
import { isOpen as isImporterOpen, openWith as openImporterWith } from './importer.js'
import { visibleSuggestions, parseConfidence, tagLabel, getTag, questionsNamedLike, tagConceptId, isLoaded as lensesLoaded } from './lenses.js'
import { startupBusy } from './role-step.js'
import { linksPending } from './browser-queue.js'
import { showPrompt, confirmDeleteItem, isDialogOpen } from './dialog.js'
import { t } from './i18n.js'
import { getSetting } from './settings.js'
import { getPlan } from './licensing.js'
import { makeLogger } from './logger.js'
import * as motion from './motion.js'
import { setPageBar, setPageBarCount } from './page-bar.js'
import { installUpdate } from './update-screen.js'
import { matchRealShape } from './media-shape.js'

const log = makeLogger('Grid')

const FREE_ITEM_LIMIT  = 200
const FREE_ITEM_TEASER = 40
// Pro is unlimited — fetch effectively everything (there's no infinite-scroll
// pagination, so a low limit would silently hide items from paying users).
const PRO_ITEM_LIMIT   = 100000

const IS_TAURI = '__TAURI_INTERNALS__' in window
const EXT_URL  = 'https://chromewebstore.google.com/detail/feopgkjmnlaokclcpphaejjlpgdncdjf'

let _saveDialog  = null
async function getSaveDialog() {
  if (!IS_TAURI) return null
  if (!_saveDialog) ({ save: _saveDialog } = await import('@tauri-apps/plugin-dialog'))
  return _saveDialog
}

// ─── Icon helper ─────────────────────────────────────────────────
const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

// ─── Platform → brand icon ───────────────────────────────────────
const PLATFORM_ICONS = {
  youtube:   'brand-youtube',
  instagram: 'brand-instagram',
  pinterest: 'brand-pinterest',
  x:         'brand-x',
  twitter:   'brand-x',
  tiktok:    'brand-tiktok',
  behance:   'brand-behance',
  dribbble:  'brand-dribbble',
  reddit:    'brand-reddit',
  linkedin:  'brand-linkedin',
  chrome:    'brand-chrome',
}

function platformIcon(platform) {
  if (!platform) return 'hard-drive'
  return PLATFORM_ICONS[platform.toLowerCase()] ?? 'link-simple'
}

// The user is Pro if EITHER the validated license cache OR the persisted setting
// says so. Trusting both prevents a stale preferences.plan (e.g. on the first
// boot after upgrading, before the plan re-validates against the server) from
// wrongly flashing the free teaser/200-cap at a paying user.
function isFreePlan() {
  const cachePlan = getPlan()            // last validated plan (licensing.js cache)
  const prefPlan  = getSetting('plan')
  const isPro = (cachePlan && cachePlan.startsWith('pro')) ||
                (prefPlan  && prefPlan.startsWith('pro'))
  return !isPro
}

// ─── State ───────────────────────────────────────────────────────
let container       = null
let gridEl          = null   // first masonry section (kept for compat)
let gridEls         = []     // all masonry sections, created dynamically each render
let currentColCount = 4
let _resizeObserver = null
let _resizeTimer    = null
let renderedItems   = []

let _shuffleN  = 0        // qootify presses — each one asks reco.rs for a fresh order
let _reloadGen = 0       // incremented on every reload; stale async callbacks bail out when gen differs
let _parallaxCleanup = null  // removes the teaser scroll listener on next render

// Snapshot of the last reload() result, used by relayout() so a resize can
// re-lay-out with the new column count WITHOUT re-querying the DB or
// re-shuffling the qootify order. Null until the first reload completes.
let _lastView = null
// When false, cards are built without the deal-in cascade / image fade-in.
// Set only during relayout (a resize is not a content change — it shouldn't
// re-animate). relayout is fully synchronous and resets this in a finally, so
// an async reload's later reco render always sees it back at true.
let _animateCards = true

let _ctxMenu = null
let _hoverItem = null   // card under the pointer — Ctrl+C copies it
let _ctxListeners = null

// Set when the backend emits update-available (30 s after launch). Drives the
// update bar under the tag pills; survives grid re-renders (see renderShell).
let _pendingUpdate = null

const SHELF_ASPECT_THRESHOLD = 0.67
const SHELF_CARD_HEIGHT      = 240
const SHELF_CHUNK_SIZE       = 20  // short-form videos per shelf row

const filter = {
  collectionId:   null,
  tagIds:         [],
  query:          null,
  color:          null,
  colorTolerance: 'normal',
  mediaTypes:     null,   // null = all; ['image','gif'] = images; ['video'] = videos
  sort:           null,
  page:  0,
  limit: 100,
}

// ─── Init ────────────────────────────────────────────────────────
export function init(el, _settings) {
  container = el
  renderShell()
  const syncOffline = () => { const b = container.querySelector('#offline-bar'); if (b) b.hidden = navigator.onLine }
  window.addEventListener('online', syncOffline)
  window.addEventListener('offline', syncOffline)
  loadFilters()
  bindDragDrop()

  // Ctrl/⌘+C copies the hovered item to the clipboard (Copy left the card menu)
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c' || !_hoverItem) return
    if (e.target.closest?.('input, textarea, [contenteditable]') || String(window.getSelection())) return
    e.preventDefault()
    handleCopy(_hoverItem, null)
  })

  store.on(events.GRID_RELOAD,       ()           => reload())
  store.on(events.GRID_ITEM_ADDED,   ()           => reload())
  store.on(events.GRID_ITEM_DELETED, ({ id })          => { removeCard(id); checkEmpty() })
  store.on(events.GRID_ITEM_UPDATED, ({ inspiration }) => updateCardTitle(inspiration))
  // Crop Save / Restore original replaced the item's picture: its card takes the new file,
  // shape and colour in place (it sits behind the player, so nothing animates)
  store.on(events.ITEM_FILE_CHANGED, ({ inspiration }) => refreshCardFile(inspiration))
  // A tag was added somewhere. When it went onto one item (the detail panel's tag picker
  // says which), that card's question may be answered now: read the item again.
  store.on(events.TAG_CREATED,       p            => { forgetHintsOf(p?.tag); refreshTagChips(); if (p?.inspirationId) refreshCardPills([p.inspirationId]) })
  store.on(events.TAG_DELETED,       ()           => refreshTagChips())
  // Guide B5 → F1: a drop opens Import with the files already listed.
  store.on(events.FILES_DROPPED, ({ paths }) => { if (!isImporterOpen()) openImporterWith(paths) })
  store.on(events.SEARCH_QUERY_CHANGED, ({ query }) => {
    // No-op resets (e.g. the search bar clearing itself after a download) must not
    // reload — on the shuffled home view that reshuffled the whole grid.
    if ((query || null) === filter.query) return
    if (query) log.info('search', { query })
    filter.query = query || null
    filter.page  = 0
    reload()
  })
  store.on(events.SEARCH_COLOR_CHANGED, ({ hex, tolerance }) => {
    if (hex) log.info('color_search', { color: hex, tolerance: tolerance ?? filter.colorTolerance })
    filter.color = hex || null
    // Tolerance now travels with the color from the picker (see color-picker.js).
    if (tolerance) filter.colorTolerance = tolerance
    filter.page  = 0
    reload()
  })
  store.on(events.SEARCH_MEDIA_CHANGED, ({ types }) => {
    filter.mediaTypes = (types && types.length) ? types : null
    filter.page = 0
    reload()
  })
  store.on(events.COLLECTION_SELECTED, ({ id, name }) => {
    enterCollectionMode(id, name ?? id)
  })
  // Home or the logo while a collection is open: back to the whole library
  store.on(events.GRID_HOME, () => { if (filter.collectionId) exitCollectionMode(false) })
  store.on(events.COLLECTION_DELETED, () => {
    if (filter.collectionId) exitCollectionMode(false)
    else reload()
  })
  store.on(events.NAV_CHANGE, ({ view }) => {
    if (view !== 'grid') _suggestTip?.hide()
    // Leaving for another page: that page owns the bar now, so don't reset it here
    if (view !== 'grid' && filter.collectionId) exitCollectionMode(false, { keepBar: true })
    // main.js resets the bar on every page change — put the collection's back
    if (view === 'grid' && _collectionBar) setPageBar(_collectionBar)
  })
  store.on(events.AUTO_TAG_BATCH_DONE, ({ ids }) => refreshCardPills(ids))
  // Tag lens (spec §5.6): lens data arrived or changed (a lens turned on or off, an
  // update, the suggestions switch, the tag list, the language), so every card asks its
  // question again and every tag chip says its name again. A language change relabels at
  // once, from the lens data already here; LENS_LOADED follows with the fresh data.
  // A tag a chip stands for may be gone (a lens update joined it into the people's tag with its
  // name: one name, one tag): the chips are read again.
  store.on(events.LENS_LOADED, () => { syncAllCardRows(); relabelTagChips(); if (hasGoneTagChips()) refreshTagChips() })
  document.addEventListener('i18n:changed', () => { syncAllCardRows(); relabelTagChips() })
  // Rows can't be measured while the grid is hidden (another page): fit them once it shows
  store.on(events.NAV_CHANGE, ({ view }) => {
    if (view === 'grid') requestAnimationFrame(() => { _fitQueue.clear(); fitRows(allRows()) })
  })
  store.on(events.UPDATE_AVAILABLE, (info) => {
    _pendingUpdate = info
    log.info('update_available', { version: info?.version })
    renderUpdateBar()
  })
  // Re-render the (imperatively built) update bar text when the language changes.
  document.addEventListener('i18n:changed', () => renderUpdateBar())

  // The free/Pro state is decided at render time. When the licence validates
  // after boot (or an upgrade completes), the plan can flip to Pro — reload so
  // the free-plan blocker/limit disappears without the user restarting the app.
  const reloadOnPlanFlip = () => {
    const nowFree = isFreePlan()
    if (_lastView && _lastView.isFree !== nowFree) reload()
  }
  store.on(events.LICENSE_STATUS_CHANGED, reloadOnPlanFlip)
  // Also react the instant the `plan` setting itself flips — the Settings page
  // updates the plan via its own fetch (setSetting('plan')) which doesn't fire
  // LICENSE_STATUS_CHANGED, so without this the grid would keep showing the free
  // teaser/limit for a few seconds after upgrading until the next validation.
  store.on(events.SETTINGS_CHANGED, ({ key }) => { if (key === 'plan') reloadOnPlanFlip() })

  // Collection hints, once on startup: an untagged item in a collection whose items
  // mostly share a tag is asked about that tag (stored as a `col:<tag id>` key; Rust only
  // writes them while tag suggestions are on). Sent before the first reload, which reads
  // the items after it.
  api.applyCollectionTagSuggestions().catch(() => {})

  reload()
}

// ─── Collection mode ─────────────────────────────────────────────
// Inside a collection the top bar keeps its layout (guide D2): only the centre changes to
// "Collections › <name> · N items" and the action becomes Export.
let _collectionBar = null   // the page-bar spec while a collection is open

function enterCollectionMode(id, name) {
  filter.collectionId = id
  filter.tagIds = []
  filter.page   = 0

  const chipsBar = container?.querySelector('#filter-chips-bar')
  if (chipsBar) chipsBar.hidden = true
  container?.classList.add('in-collection')   // grid keeps a gap under the top bar
  renderUpdateBar()  // hides the update bar while in collection mode

  _collectionBar = {
    crumb:  { label: t('nav.collections'), onClick: () => exitCollectionMode(true) },
    title:  name,
    action: { label: t('action.export'), onClick: () => exportCollection(id, name) },
  }
  setPageBar(_collectionBar)
  api.listCollections().then(cols => {
    const col = cols.find(c => c.id === id)
    if (!col || filter.collectionId !== id) return
    _collectionBar.count = t(col.item_count === 1 ? 'collections.items_one' : 'collections.items_many', { n: col.item_count ?? 0 })
    setPageBarCount(_collectionBar.count)
  }).catch(() => {})

  reload()
}

async function exportCollection(id, name) {
  const save = await getSaveDialog()
  if (!save) return
  const savePath = await save({
    title: t('collection.export_title'),
    defaultPath: `${name}.qooti`,
    filters: [{ name: 'qooti Pack', extensions: ['qooti'] }],
  })
  if (!savePath) return
  try {
    await api.exportCollection(id, savePath)
    sfx.success()
  } catch (err) {
    console.error('[grid] export collection failed:', err)
  }
}

function exitCollectionMode(navigateToCollections, { keepBar = false } = {}) {
  filter.collectionId = null
  filter.tagIds = []
  filter.page   = 0
  _collectionBar = null

  const chipsBar = container?.querySelector('#filter-chips-bar')
  if (chipsBar) chipsBar.hidden = false
  container?.classList.remove('in-collection')
  renderUpdateBar()  // restore the update bar (if a version is pending)

  if (navigateToCollections) {
    store.emit(events.NAVIGATE, { view: 'collections' })
  } else if (!keepBar) {
    setPageBar(null)
  }
  // Read the whole library again on every way out, "Collections ›" too: without it the grid
  // kept the collection's items and Home showed them (owner's bug, 2026-11-20)
  reload()
}

// Colour / media-type filters on (guide G2): the tag row becomes removable filter chips
// The colour / media-type filters show as removable chips at the start of the tag row,
// so the tags stay available while a filter is on (no count, no "Clear all").
function renderActiveFilters() {
  const bar = container?.querySelector('#active-filters')
  if (!bar) return
  const on = !filter.collectionId && !filter.query && (filter.color || filter.mediaTypes)
  bar.hidden = !on
  if (!on) return
  const chips = []
  if (filter.color) chips.push(`<button class="chip active-filter" data-clear="color"><span class="af-swatch" style="background:${escHtml(filter.color)}"></span>${escHtml(filter.color.toUpperCase())}${I('x', 12)}</button>`)
  if (filter.mediaTypes) chips.push(`<button class="chip active-filter" data-clear="media">${I(filter.mediaTypes.includes('video') ? 'video-camera' : 'image', 14)}${t(filter.mediaTypes.includes('video') ? 'media.videos' : 'media.images')}${I('x', 12)}</button>`)
  bar.innerHTML = chips.join('')
  bar.querySelectorAll('[data-clear]').forEach(b => b.addEventListener('click', () => {
    const which = b.dataset.clear
    if (which === 'color' && filter.color) store.emit(events.FILTER_CLEAR_REQUESTED, { which: 'color' })
    if (which === 'media' && filter.mediaTypes) store.emit(events.FILTER_CLEAR_REQUESTED, { which: 'media' })
  }))
}

// Filters other than the collection itself (search, colour, tags, media type)
function hasNarrowingFilter() {
  return !!(filter.query || filter.color || filter.tagIds.length || filter.mediaTypes)
}

// ─── Shell ───────────────────────────────────────────────────────
// Placeholder tiles shown until the first page arrives (guide B0); render() replaces them.
function skeletonHtml() {
  const cols = Math.max(1, Math.floor((container.clientWidth - 48 + 8) / (220 + 8)) || 6)
  const heights = [130, 230, 210, 225, 100, 240, 180, 150, 260, 120, 200, 170]
  const col = c => `<div class="masonry-col">${[0, 1, 2, 3].map(r =>
    `<div class="skel-tile" style="height:${heights[(c * 5 + r * 7) % heights.length]}px"></div>`).join('')}</div>`
  return `<div class="masonry skel-grid">${Array.from({ length: cols }, (_, c) => col(c)).join('')}</div>`
}

function renderShell() {
  container.innerHTML = `
    <div class="filter-chips-bar" id="filter-chips-bar">
      <span class="active-filters" id="active-filters" hidden></span>
      <button class="chip active" data-filter="all"><span class="icon icon-14" style="mask-image:url('/icons/shuffle.svg');-webkit-mask-image:url('/icons/shuffle.svg')" aria-hidden="true"></span>qootify</button>
      <button class="chip" data-filter="recent" data-i18n="filter.recent">${t('filter.recent')}</button>
      ${[70, 44, 64, 90, 76].map(w => `<span class="chip-skel" style="width:${w}px"></span>`).join('')}
    </div>

    <div class="search-head" id="search-head" hidden>
      <span class="search-head-count" id="search-head-count"></span>
      <span class="search-head-sub">${t('search.matches_in')}</span>
    </div>

    <!-- Update / offline (H3, H5): float over the top of the grid — the grid never moves -->
    <div class="grid-notices">
      <div class="grid-notices-stack">
        <div class="update-bar" id="update-bar" hidden>
          <span class="update-bar-badge">${I('bell', 16)}</span>
          <span class="update-bar-text" id="update-bar-text"></span>
          <button class="update-bar-dismiss" id="update-bar-dismiss">${t('update.later')}</button>
          <button class="update-bar-btn" id="update-bar-btn"></button>
        </div>

        <div class="update-bar offline-bar" id="offline-bar" ${navigator.onLine ? 'hidden' : ''}>
          <span class="update-bar-badge">${I('wifi-high', 16)}</span>
          <span class="update-bar-text">${t('offline.bar')}</span>
        </div>
      </div>
    </div>

    <div class="grid-scroll" id="grid-scroll">${skeletonHtml()}</div>

    <div class="drop-overlay hidden" id="drop-overlay">
      <div class="drop-overlay-box">
        ${I('upload-simple', 20)}
        <span class="drop-overlay-label" data-i18n="grid.drop">${t('grid.drop')}</span>
        <span class="drop-overlay-sub" data-i18n="grid.drop_sub">${t('grid.drop_sub')}</span>
      </div>
    </div>

    <button class="scroll-top-btn" id="scroll-top-btn" title="${t('grid.scroll_top')}" aria-label="${t('grid.scroll_top')}">
      ${I('caret-up', 20)}
    </button>
  `

  gridEl  = null
  gridEls = []

  if (_resizeObserver) _resizeObserver.disconnect()
  const scrollEl = container.querySelector('#grid-scroll')
  _resizeObserver = new ResizeObserver(onGridResize)
  _resizeObserver.observe(scrollEl)

  // Scroll-to-top button: appears once scrolled past ~1.5 screens, returns to row 1.
  const scrollTopBtn = container.querySelector('#scroll-top-btn')
  if (scrollTopBtn) {
    let shown = false
    scrollEl.addEventListener('scroll', () => {
      const should = scrollEl.scrollTop > scrollEl.clientHeight * 1.5
      if (should !== shown) { shown = should; scrollTopBtn.classList.toggle('visible', should) }
    }, { passive: true })
    scrollTopBtn.addEventListener('click', () => scrollEl.scrollTo({ top: 0, behavior: 'smooth' }))
  }

  // Drag-to-scroll for filter chips bar
  const bar = container.querySelector('#filter-chips-bar')
  let _dragDown = false, _dragStartX = 0, _dragScrollLeft = 0, _dragged = false

  bar.addEventListener('mousedown', e => {
    _dragDown = true
    _dragged = false
    _dragStartX = e.pageX - bar.offsetLeft
    _dragScrollLeft = bar.scrollLeft
    bar.style.cursor = 'grabbing'
  })

  bar.addEventListener('mousemove', e => {
    if (!_dragDown) return
    const x = e.pageX - bar.offsetLeft
    const delta = x - _dragStartX
    if (Math.abs(delta) > 4) _dragged = true
    bar.scrollLeft = _dragScrollLeft - delta
  })

  const endDrag = () => {
    _dragDown = false
    bar.style.cursor = ''
  }
  bar.addEventListener('mouseup', endDrag)
  bar.addEventListener('mouseleave', endDrag)

  // Suppress chip click events that were actually drags
  bar.addEventListener('click', e => {
    if (_dragged) {
      e.stopImmediatePropagation()
      _dragged = false
    }
  }, true)

  // Restore the update bar if a new version was detected before this render.
  renderUpdateBar()
}

// ─── Update bar ──────────────────────────────────────────────────
// Shown under the tag pills when the backend reports a newer version.
// Clicking Update downloads + installs it behind the updating screen (update-screen.js),
// then the app restarts.
function renderUpdateBar() {
  const bar = container?.querySelector('#update-bar')
  if (!bar) return
  if (!_pendingUpdate || filter.collectionId) { bar.hidden = true; return }

  const { version } = _pendingUpdate
  const textEl = bar.querySelector('#update-bar-text')
  const btn    = bar.querySelector('#update-bar-btn')
  const dismiss = bar.querySelector('#update-bar-dismiss')

  textEl.textContent = t('update.ready', { version })
  btn.textContent    = t('update.btn')
  btn.disabled       = false
  dismiss.setAttribute('aria-label', t('update.dismiss'))
  dismiss.title      = t('update.dismiss')
  bar.hidden = false

  // .onclick (not addEventListener) so re-renders never stack duplicate handlers.
  btn.onclick = async () => {
    // The updating screen covers the window and shows the download's progress; the
    // bar's buttons only wait underneath it.
    btn.disabled     = true
    dismiss.disabled = true
    if (await installUpdate(version)) return   // qooti closes or restarts by itself
    btn.textContent  = t('update.failed')
    btn.disabled     = false
    dismiss.disabled = false
  }
  dismiss.onclick = () => {
    bar.hidden = true
    log.info('update_dismissed', { version })
  }
}

// ─── Filter chips ─────────────────────────────────────────────────
async function loadFilters() {
  const bar = container.querySelector('#filter-chips-bar')
  if (!bar) return

  // qootify: every press deals a fresh order (a new shuffle number for reco.rs); other
  // reloads keep the current number, so imports/deletes don't reshuffle the home grid.
  bar.querySelector('[data-filter="all"]').addEventListener('click', e => {
    filter.collectionId = null; filter.tagIds = []; filter.sort = null; filter.page = 0
    _shuffleN++
    setActiveChip(e.currentTarget); reload()
  })
  bar.querySelector('[data-filter="recent"]').addEventListener('click', e => {
    filter.collectionId = null; filter.tagIds = []; filter.sort = 'recent'; filter.page = 0
    setActiveChip(e.currentTarget); reload()
  })

  // Color-match tolerance now lives inside the color picker popover
  // (color-picker.js) and arrives via SEARCH_COLOR_CHANGED — no chips here.

  try {
    const tags = await api.listTags()
    bar.querySelectorAll('.chip-skel').forEach(el => el.remove())

    for (const tag of tags) {
      if ((tag.usage_count ?? 0) > 0) bar.appendChild(makeTagChip(tag))
    }
  } catch (err) {
    console.error('[grid] loadFilters failed:', err)
    bar.querySelectorAll('.chip-skel').forEach(el => el.remove())
  }
}

function makeChip(label, onClick) {
  const btn = document.createElement('button')
  btn.className = 'chip'
  btn.textContent = label
  btn.addEventListener('click', onClick)
  return btn
}

function makeTagChip(tag) {
  // tagLabel: a Tag lens tag shows its name in the app's language, any other tag as typed
  const chip = makeChip(tagLabel(tag), () => {
    filter.collectionId = null; filter.tagIds = [tag.id]; filter.page = 0
    setActiveChip(chip); reload()
  })
  chip.dataset.tagId = tag.id
  chip._tag = tag
  chip.classList.add('chip--tag')
  // Rebuilt chips (a tag was added or removed) keep the tag filter that's on
  if (!filter.collectionId && filter.tagIds[0] === tag.id) chip.classList.add('active')
  return chip
}

// The tag chips' names again, in the app's language (a language change, new lens data)
function relabelTagChips() {
  container?.querySelectorAll('#filter-chips-bar .chip--tag').forEach(chip => {
    const tag = getTag(chip.dataset.tagId) ?? chip._tag
    const label = tag ? tagLabel(tag) : ''
    if (label && chip.textContent !== label) chip.textContent = label
  })
}

// A tag chip whose tag the lens data's tag list (list_tags, read with it) doesn't have any more
function hasGoneTagChips() {
  if (!lensesLoaded()) return false
  return [...(container?.querySelectorAll('#filter-chips-bar .chip--tag') ?? [])].some(chip => !getTag(chip.dataset.tagId))
}

async function refreshTagChips() {
  const bar = container.querySelector('#filter-chips-bar')
  if (!bar) return
  try {
    const tags = await api.listTags()
    // Remove all existing tag chips
    bar.querySelectorAll('.chip--tag').forEach(c => c.remove())
    // Re-add sorted by usage_count, skip zero
    for (const tag of tags) {
      if ((tag.usage_count ?? 1) === 0) continue
      bar.appendChild(makeTagChip(tag))
    }
    // If active filter was a removed tag, reset to "all"
    if (filter.tagIds.length && !tags.find(t => t.id === filter.tagIds[0] && (t.usage_count ?? 1) > 0)) {
      filter.tagIds = []; filter.page = 0
      setActiveChip(bar.querySelector('[data-filter="all"]'))
      reload()
    }
  } catch (err) {
    console.error('[grid] refreshTagChips failed:', err)
  }
}

function setActiveChip(el) {
  container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'))
  el?.classList.add('active')
}

// ─── Drag-drop ───────────────────────────────────────────────────
// Guide B5: files dragged anywhere over the window → the library dims under an 85% scrim
// with one dashed outline. Not while the import window is open (its own drop zone
// reacts then). In the desktop app the drag comes from Tauri (FILES_DRAG); the page's
// own drag events below only fire in a browser.
function bindDragDrop() {
  const overlay = container.querySelector('#drop-overlay')
  let leaveTimer = null

  const showOverlay = () => {
    if (isImporterOpen()) return
    clearTimeout(leaveTimer)
    overlay.classList.remove('hidden', 'is-leaving')
  }
  // Fade out (is-leaving) before hiding, so it never just vanishes.
  const hideOverlay = () => {
    if (overlay.classList.contains('hidden') || overlay.classList.contains('is-leaving')) return
    overlay.classList.add('is-leaving')
    leaveTimer = setTimeout(() => overlay.classList.replace('is-leaving', 'hidden'), 160)
  }

  store.on(events.FILES_DRAG, ({ phase }) => {
    if (phase === 'enter' || phase === 'over') showOverlay()
    else hideOverlay()
  })

  container.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    showOverlay()
  })

  container.addEventListener('dragleave', e => {
    if (e.relatedTarget && container.contains(e.relatedTarget)) return
    hideOverlay()
  })

  container.addEventListener('dragover', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
  })

  container.addEventListener('drop', e => {
    e.preventDefault()
    hideOverlay()
  })
}

function hasFiles(e) {
  return e.dataTransfer?.types?.includes('Files') ?? false
}

// ─── Data ────────────────────────────────────────────────────────
async function reload() {
  const gen = ++_reloadGen
  try {
    const isFree = isFreePlan()
    const colCount = calcColCount()

    const [items, planInfo] = await Promise.all([
      api.listInspirations({
        collection_id: filter.collectionId ?? undefined,
        tag_ids: filter.tagIds.length ? filter.tagIds : undefined,
        query:   filter.query ?? undefined,
        color_filter:     filter.color ?? undefined,
        color_tolerance:  filter.color ? filter.colorTolerance : undefined,
        media_types:      filter.mediaTypes ?? undefined,
        // Free plan always fetches by recency so the visible pool is always the
        // 200 most recently imported items. Qootify shuffle happens client-side.
        sort:    isFree ? 'recent' : (filter.sort ?? undefined),
        page:    filter.page,
        limit:   isFree ? (FREE_ITEM_LIMIT + FREE_ITEM_TEASER) : PRO_ITEM_LIMIT,
      }),
      isFree ? api.getFreePlanInfo() : Promise.resolve(null),
    ])

    if (gen !== _reloadGen) return  // superseded by a newer reload

    // Snap so that REGULAR (non-shelf) items fill complete rows.
    // Pre-count regular items in the response so we can snap to a multiple of
    // colCount that doesn't exceed what actually exists — otherwise the last
    // grid segment gets an un-alignable remainder and orphan cards appear.
    // Snap regular items to complete rows for the free-plan teaser layout — but
    // ONLY on the unfiltered home grid, and only when there are enough regular
    // items to fill at least one full row. Filtered views (tag/collection/search/
    // color) and small libraries must show everything, otherwise a handful of
    // items snaps to zero and the empty state wrongly appears.
    const isFilteredView = !!(filter.collectionId || filter.query || filter.color || filter.tagIds.length || filter.mediaTypes)
    const regularInResponse = items.filter(i => !isShortForm(i)).length
    const applyFreeSnap = isFree && !isFilteredView && regularInResponse >= colCount

    let totalSnap
    if (applyFreeSnap) {
      const regularSnap = Math.floor(Math.min(regularInResponse, FREE_ITEM_LIMIT) / colCount) * colCount
      totalSnap = 0
      let regularCount = 0
      for (const item of items) {
        if (regularCount >= regularSnap) break
        totalSnap++
        if (!isShortForm(item)) regularCount++
      }
    } else {
      totalSnap = items.length
    }

    let visibleItems = items.slice(0, totalSnap)

    // Qootify home: a taste-aware shuffle (reco.rs — items that look like what you've been
    // opening/saving lately come up more, look-alikes kept apart, fresh order every launch),
    // computed over the visible pool only.
    const isHome = !isFilteredView && filter.sort === null
    let ordered = null
    if (isHome && visibleItems.length) {
      const ids = visibleItems.map(i => i.id)
      const order = await api.tasteOrder(ids, _shuffleN).catch(err => { log.warn('tasteOrder failed:', String(err)); return null })
      if (gen !== _reloadGen) return
      if (order?.length) {
        const byId = new Map(visibleItems.map(i => [i.id, i]))
        ordered = order.map(id => byId.get(id)).filter(Boolean)
        const placed = new Set(order)
        for (const i of visibleItems) if (!placed.has(i.id)) ordered.push(i)
      }
    }
    if (ordered) {
      visibleItems = ordered
    } else if (isFree && filter.sort === null) {
      // Free plan: pool is the fixed set of most-recent items; shuffle their order client-side
      visibleItems = visibleItems.slice().sort(() => Math.random() - 0.5)
    }

    const teaserItems  = (isFree && items.length > totalSnap) ? items.slice(totalSnap) : []
    const extraCount = planInfo ? Math.max(0, planInfo.item_total - totalSnap) : 0

    render(visibleItems, colCount, applyFreeSnap)

    const showTeaser = teaserItems.length > 0 && planInfo && planInfo.item_total > FREE_ITEM_LIMIT
    if (showTeaser) renderFreeTeaser(teaserItems, extraCount, colCount)

    // Cache the fully-resolved view so a resize can re-lay-out from it without
    // re-querying or re-shuffling. Order is preserved exactly as rendered.
    _lastView = { visibleItems, isFree, teaserItems, extraCount, showTeaser }
  } catch (err) {
    console.error('[grid] reload failed:', err)
  }
}

// Re-lay-out the current view at a new column count using the cached result of
// the last reload — no DB round-trip and no re-shuffle (a resize is not a
// content change). Falls back to a full reload if nothing is cached yet.
function relayout() {
  if (!_lastView) { reload(); return }
  const colCount = calcColCount()
  const { visibleItems, isFree, teaserItems, extraCount, showTeaser } = _lastView
  _animateCards = false
  try {
    render(visibleItems, colCount, isFree)
    if (showTeaser) renderFreeTeaser(teaserItems, extraCount, colCount)
  } finally {
    _animateCards = true
  }
}

// Keep the relayout cache in sync with in-place grid mutations, so a resize
// after a delete/edit doesn't resurrect or revert a card.
function _lastViewRemove(id) {
  if (!_lastView) return
  _lastView.visibleItems = _lastView.visibleItems.filter(i => i.id !== id)
}
function _lastViewPatch(insp) {
  if (!_lastView) return
  const arr = _lastView.visibleItems
  const i = arr.findIndex(x => x.id === insp.id)
  if (i !== -1) arr[i] = { ...arr[i], ...insp }
}

function renderFreeTeaser(teaserItems, extraCount, colCount) {
  const masonry = gridEl
  const state = _masonryState
  if (!masonry?.classList.contains('masonry') || !state) return

  const openUpgrade = () => api.openUrl('https://account.bloot.app/')

  // Blurred real cards CONTINUE the main grid's columns (guide B-screens), so each
  // column runs straight on from its last clear card. A separate grid below would
  // start on one straight line and leave an empty band under the shorter columns.
  // Source: the items past the cap first, then the visible ones in a fresh order,
  // so a few items don't repeat over and over. Videos without a thumbnail render
  // blank until the file loads, so they're left out.
  const shows = i => i.type !== 'video' || i.thumbnail_path
  const seen = new Set()
  const pool = [...teaserItems, ...renderedItems.slice().sort(() => Math.random() - 0.5)]
    .filter(i => shows(i) && !seen.has(i.id) && seen.add(i.id))
  if (!pool.length) return

  // Fill every column past a fixed bottom edge, which then crops them evenly —
  // no ragged ends with empty canvas between them.
  // Measure the laid-out columns: the masonry's own heights are estimates and drift
  // over 200 cards, which left the bottom edge below the real cards (blank band).
  const scrollEl = container?.querySelector('#grid-scroll')
  state.colEls.forEach((c, i) => { state.colHeight[i] = c.offsetHeight + state.gap })
  state.colW = state.colEls[0].clientWidth || state.colW
  const clearBottom = Math.max(...state.colHeight)
  const bottom = clearBottom + Math.max(420, Math.round((scrollEl?.clientHeight ?? 600) * 0.7))
  const before = new Set(masonry.querySelectorAll('.card'))
  for (let n = 0; Math.min(...state.colHeight) < bottom && n < 400; n++) {
    fillMasonryCols(state, [pool[n % pool.length]], -1)
  }
  masonry.querySelectorAll('.card').forEach(c => { if (!before.has(c)) c.classList.add('free-teaser-card') })
  masonry.classList.add('has-free-teaser')
  masonry.style.height = `${Math.round(bottom)}px`

  // Fade + banner start under the longest clear column, so no clear card is dimmed
  const overlay = document.createElement('div')
  overlay.className = 'free-teaser-overlay'
  overlay.innerHTML = `
    <div class="free-teaser-banner">
      <p class="free-teaser-banner__count">${t('teaser.count', { n: extraCount.toLocaleString() })}</p>
      <p class="free-teaser-banner__sub">${t('teaser.sub')}</p>
      <button class="free-teaser-banner__cta">${t('teaser.cta')}</button>
    </div>
  `
  overlay.style.top = `${Math.round(clearBottom)}px`
  overlay.querySelector('.free-teaser-banner__cta').addEventListener('click', openUpgrade)
  masonry.appendChild(overlay)
}

// ─── Render ──────────────────────────────────────────────────────
function isShortForm(item) {
  return item.type === 'video' && item.aspect_ratio != null && item.aspect_ratio < SHELF_ASPECT_THRESHOLD
}

function render(items, colCount, trimOrphans = false) {
  const scrollEl = container?.querySelector('#grid-scroll')
  if (!scrollEl) return
  if (_parallaxCleanup) { _parallaxCleanup(); _parallaxCleanup = null }
  renderedItems = items
  _clearThumbQueue()

  // On a relayout (resize) suppress the per-card image fade so the grid doesn't
  // blink. Persists on the container until the next render, covering images that
  // load lazily after the relayout. deal-in is suppressed separately in JS.
  scrollEl.classList.toggle('no-card-anim', !_animateCards)

  // Content change (not a resize): remember where the on-screen cards are, and fade out
  // the ones that won't be in the new result, so the new grid can glide from the old one.
  const before = _animateCards ? motion.snapshotCards(scrollEl) : null
  if (before) motion.ghostOut(scrollEl, before, new Set(items.map(i => i.id)))

  _suggestTip?.hide()   // its row is about to go
  scrollEl.innerHTML = ''
  gridEls = []

  renderActiveFilters()

  // Search (guide E1): the tag row gives way to a result count
  const searching = !!filter.query && !filter.collectionId
  container.classList.toggle('is-searching', searching)
  const head = container.querySelector('#search-head')
  if (head) {
    head.hidden = !searching || !items.length
    container.querySelector('#search-head-count').textContent =
      t(items.length === 1 ? 'search.result_one' : 'search.results', { n: items.length.toLocaleString() })
  }

  // An empty library hands the one primary action to the empty state, so the
  // top-bar Import steps down to secondary (guide B4).
  const filtered = !!(filter.collectionId || filter.query || filter.color || filter.tagIds.length || filter.mediaTypes)
  document.body.classList.toggle('library-empty', !items.length && !filtered)

  if (!items.length && searching) {
    const grid = _makeGridEl()
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-state-icon">${I('magnifying-glass', 20)}</span>
        <span class="empty-state-title">${t('search.none_title', { q: escHtml(filter.query) })}</span>
        <p class="empty-state-body">${t('search.none_body')}</p>
        <button class="empty-state-btn empty-state-btn--secondary" id="empty-clear-search">${t('search.clear')}</button>
      </div>
    `
    grid.querySelector('#empty-clear-search').addEventListener('click', () => {
      const input = document.getElementById('top-bar-search')
      if (input) input.value = ''
      store.emit(events.SEARCH_QUERY_CHANGED, { query: null })
    })
    scrollEl.appendChild(grid)
    gridEl = grid
    if (before) motion.fadeIn(grid)
    return
  }

  if (!items.length && filter.collectionId && !hasNarrowingFilter()) {
    const grid = _makeGridEl()
    const name = document.getElementById('page-bar-name')?.textContent ?? ''
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-state-icon">${I('folder', 20)}</span>
        <span class="empty-state-title">${t('empty.collection.title', { name: escHtml(name) })}</span>
        <p class="empty-state-body">${t('empty.collection.body')}</p>
        <button class="empty-state-btn" id="empty-add-btn">${t('empty.collection.btn')}</button>
      </div>
    `
    grid.querySelector('#empty-add-btn')?.addEventListener('click', () => store.emit(events.IMPORT_REQUESTED))
    scrollEl.appendChild(grid)
    gridEl = grid
    if (before) motion.fadeIn(grid)
    return
  }

  if (!items.length) {
    const grid = _makeGridEl()
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-state-icon">${I('image', 20)}</span>
        <span class="empty-state-title">${t('empty.grid.title')}</span>
        <p class="empty-state-body">${t('empty.grid.body')}</p>
        <button class="empty-state-btn" id="empty-add-btn">${t('empty.grid.btn')}</button>
        <p class="empty-state-foot">${t('empty.grid.web')} <a href="#" id="empty-ext-link">${t('empty.grid.ext')}</a></p>
      </div>
    `
    grid.querySelector('#empty-add-btn')?.addEventListener('click', () => store.emit(events.IMPORT_REQUESTED))
    grid.querySelector('#empty-ext-link')?.addEventListener('click', e => {
      e.preventDefault()
      api.openUrl(EXT_URL)
    })
    scrollEl.appendChild(grid)
    gridEl = grid
    if (before) motion.fadeIn(grid)
    return
  }

  // ── Masonry (waterfall) layout ──
  // Everything — images AND short-form videos — flows into ONE shortest-column
  // masonry, each card at its native aspect ratio (no crop, no shelves). Column
  // count is responsive (calcColCount → --grid-min-width breakpoints). Items are
  // placed in order into whichever column is currently shortest, so reading order
  // is preserved as much as possible while the column bottoms stay level.
  currentColCount = Math.max(1, colCount ?? calcColCount())
  const masonry = buildMasonry(items, 0)
  masonry.classList.add('inspiration-grid')   // keep for context-menu + empty-state hooks
  // Cards that were already on screen keep their image (no fade from the placeholder).
  if (before?.size) {
    for (const card of masonry.querySelectorAll('.card[data-id]')) {
      if (before.has(card.dataset.id)) card.classList.add('no-fade')
    }
  }
  scrollEl.appendChild(masonry)
  gridEls.push(masonry)
  gridEl = masonry
  flushFit()   // narrow cards get the icon-only Add before the first paint
  if (before) motion.playGridChange(scrollEl, before)
  // after the entrance motion has settled, so the tip points at the row's final spot
  setTimeout(maybeShowSuggestTip, 500)
}

// Build a shortest-column masonry (waterfall) from `items`, each card at its
// native aspect ratio. Items are placed in order into whichever column is
// currently shortest, so reading order is preserved as much as possible while
// column bottoms stay level. `idxBase` offsets card indices for card-detail
// navigation (reco cards continue numbering after the main grid). Column heights
// are computed from aspect_ratio + gap at the current column width — no measuring.
// Layout state of the main grid's masonry, kept so recommendations can CONTINUE
// the same columns instead of starting a fresh section below. A separate section
// leaves an ugly empty band under the ragged bottom of the main-grid columns.
let _masonryState = null

// Place `items` into the shortest column of an existing masonry, in order.
function fillMasonryCols(state, items, idxBase) {
  const { colEls, colHeight, colW, gap } = state
  items.forEach((item, i) => {
    let s = 0
    for (let c = 1; c < colEls.length; c++) if (colHeight[c] < colHeight[s]) s = c

    // Entrance motion is applied after layout, to on-screen cards only (motion.playGridChange).
    const card = makeCard(item, idxBase + i)
    // Card height at this column width → used only to balance the columns
    // (images still lazy-load natively via loading="lazy").
    const ar = item.aspect_ratio && item.aspect_ratio > 0 ? item.aspect_ratio : 1
    colHeight[s] += colW / ar + gap

    colEls[s].appendChild(card)
  })
}

function buildMasonry(items, idxBase = 0) {
  const scrollEl = container?.querySelector('#grid-scroll')
  const cols   = Math.max(1, currentColCount)
  const gap    = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--grid-gap')) || 4
  const availW = Math.max(0, (scrollEl?.clientWidth ?? 0) - 12)   // 12 = .masonry padding (6 × 2)
  const colW   = Math.max(1, (availW - (cols - 1) * gap) / cols)

  const masonry = document.createElement('div')
  masonry.className = 'masonry'
  masonry.style.setProperty('--masonry-cols', cols)

  const colEls    = []
  const colHeight = new Array(cols).fill(0)
  for (let c = 0; c < cols; c++) {
    const col = document.createElement('div')
    col.className = 'masonry-col'
    masonry.appendChild(col)
    colEls.push(col)
  }

  const state = { colEls, colHeight, colW, gap }
  fillMasonryCols(state, items, idxBase)
  _masonryState = state
  return masonry
}

function _makeGridEl(id = null) {
  const grid = document.createElement('div')
  grid.className = 'inspiration-grid'
  if (id) grid.id = id
  gridEls.push(grid)
  return grid
}

// ─── Short-form shelf ─────────────────────────────────────────────
function makeShelf(shortItems, allItems, indexOfItem = null) {
  const shelf = document.createElement('div')
  shelf.className = 'short-form-shelf'

  // ── Header ──
  const header = document.createElement('div')
  header.className = 'shelf-header'

  const titleWrap = document.createElement('div')
  titleWrap.className = 'shelf-title-wrap'

  const title = document.createElement('span')
  title.className = 'shelf-title'
  title.textContent = t('grid.shortform')

  const count = document.createElement('span')
  count.className = 'shelf-count'
  count.textContent = shortItems.length === 1 ? t('grid.n_videos_one') : t('grid.n_videos', { n: shortItems.length })

  titleWrap.append(title, count)

  const nav = document.createElement('div')
  nav.className = 'shelf-nav'

  const prevBtn = document.createElement('button')
  prevBtn.className = 'shelf-nav-btn'
  prevBtn.title = t('grid.scroll_left')
  prevBtn.innerHTML = I('caret-left', 14)
  prevBtn.disabled = true

  const nextBtn = document.createElement('button')
  nextBtn.className = 'shelf-nav-btn'
  nextBtn.title = t('grid.scroll_right')
  nextBtn.innerHTML = I('caret-right', 14)

  nav.append(prevBtn, nextBtn)
  header.append(titleWrap, nav)

  // ── Track ──
  const track = document.createElement('div')
  track.className = 'shelf-track'

  shortItems.forEach(item => track.appendChild(
    makeShelfCard(item, indexOfItem ? indexOfItem.get(item) : allItems.indexOf(item))
  ))

  const SCROLL_STEP = 800
  prevBtn.addEventListener('click', () => track.scrollBy({ left: -SCROLL_STEP, behavior: 'smooth' }))
  nextBtn.addEventListener('click', () => track.scrollBy({ left:  SCROLL_STEP, behavior: 'smooth' }))

  function updateNav() {
    prevBtn.disabled = track.scrollLeft <= 0
    nextBtn.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1
  }
  track.addEventListener('scroll', updateNav, { passive: true })
  requestAnimationFrame(updateNav)

  shelf.append(header, track)
  return shelf
}

function makeShelfCard(item, idx) {
  const cardWidth = Math.round(SHELF_CARD_HEIGHT * (item.aspect_ratio ?? 0.5625))

  const card = document.createElement('div')
  card.className = 'shelf-card'
  card.dataset.id   = item.id
  card.dataset.type = item.type
  card.style.width  = `${cardWidth}px`

  const media = document.createElement('div')
  media.className = 'shelf-card-media'
  media.style.height = `${SHELF_CARD_HEIGHT}px`

  if (item.thumbnail_path) {
    const img = document.createElement('img')
    img.loading   = 'lazy'
    img.decoding  = 'async'
    img.draggable = false
    img.alt = item.title ?? ''
    img.src = itemSrc(item)
    // contain, never cover: this shelf isn't drawn any more, but if it comes back it
    // must not cut pictures either
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block'
    img.addEventListener('load',  () => img.classList.add('loaded'), { once: true })
    img.addEventListener('error', () => img.classList.add('loaded'), { once: true })
    media.appendChild(img)

    const vid = document.createElement('video')
    vid.src         = videoSrc(item)
    vid.muted       = true
    vid.preload     = 'none'
    vid.playsInline = true
    vid.style.cssText = 'display:none;width:100%;height:100%;object-fit:contain'
    media.appendChild(vid)

    media.addEventListener('mouseenter', () => {
      img.style.display = 'none'
      vid.style.display = 'block'
      vid.currentTime = 0
      vid.play().catch(() => {})
    })
    media.addEventListener('mouseleave', () => {
      vid.pause()
      vid.style.display = 'none'
      img.style.display = 'block'
    })
  } else {
    const vid = document.createElement('video')
    vid.src         = videoSrc(item)
    vid.muted       = true
    vid.preload     = 'metadata'
    vid.playsInline = true
    seekToThumbnailFrame(vid)
    media.appendChild(vid)
    media.addEventListener('mouseenter', () => { vid.currentTime = 0; vid.play().catch(() => {}) })
    media.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = vid._thumbTime ?? 0 })
    queueThumbnail(item, card)
  }

  if (item.duration_secs != null) {
    const badge = document.createElement('span')
    badge.className = 'card-duration'
    badge.textContent = formatDuration(item.duration_secs)
    media.appendChild(badge)
  }

  const titleEl = document.createElement('div')
  titleEl.className = 'shelf-card-title'
  titleEl.textContent = item.title ?? ''

  card.addEventListener('click', () => { _suggestTip?.hide(); openDetail(item, renderedItems, idx) })
  card.addEventListener('contextmenu', e => {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, item, idx)
  })
  card.addEventListener('mouseenter', () => { _hoverItem = item })
  card.addEventListener('mouseleave', () => { if (_hoverItem === item) _hoverItem = null })

  card.append(media, titleEl)
  return card
}

// A title worth showing on a card. Auto-generated import filenames
// ("image_7776bcc1-…", "IMG_1234", "video-2024") are just noise, so treat
// them as untitled and show nothing rather than a UUID.
function displayTitle(item) {
  const raw = (item.title ?? '').trim()
  if (!raw) return ''
  if (/^(image|img|photo|video|vid|screenshot|download|file)[_-][0-9a-f]{4,}[0-9a-f-]*$/i.test(raw)) return ''
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return ''
  return raw
}

// The colour that covers most of the picture — the stored palette lists the most
// frequent colour first (palette_from_path).
function placeholderColor(palette) {
  let list
  try { list = typeof palette === 'string' ? JSON.parse(palette) : palette } catch { return null }
  return Array.isArray(list) ? (list.find(c => /^#[0-9a-f]{6}$/i.test(c)) ?? null) : null
}

function makeCard(item, idx) {
  const card = document.createElement('div')
  card.className = 'card'
  card.dataset.id   = item.id
  card.dataset.type = item.type

  // ── Media ──
  const media = document.createElement('div')
  media.className = 'card-media'
  // Native aspect ratio (width/height) drives the masonry card height — no crop.
  // Falls back to 1 for items whose ratio hasn't been computed/backfilled yet. Once the
  // picture (or video) has loaded, the box takes its real shape if the saved one is off
  // (matchRealShape), and the media is fitted inside, never cut (object-fit: contain).
  const ar = item.aspect_ratio && item.aspect_ratio > 0 ? item.aspect_ratio : 1
  media.style.aspectRatio = String(ar)
  // Until the image arrives, show the picture's own main colour instead of grey.
  const tint = placeholderColor(item.palette)
  if (tint) media.style.backgroundColor = tint
  // Every load: the first one, and a new file after a crop (refreshCardFile)
  const fitImg = img => img.addEventListener('load', () => matchRealShape(item, media, img.naturalWidth, img.naturalHeight))
  const fitVid = vid => vid.addEventListener('loadedmetadata', () => matchRealShape(item, media, vid.videoWidth, vid.videoHeight))

  if (item.type === 'video') {
    if (item.thumbnail_path) {
      // Stored thumbnail → instant <img>; <video> loaded only on hover. The thumbnail is
      // a frame grab at the video's display size, so its shape is the video's.
      const img = document.createElement('img')
      img.loading   = 'lazy'
      img.decoding  = 'async'
      img.draggable = false
      img.alt = item.title ?? ''
      img.src = itemSrc(item)
      img.style.cssText = 'width:100%;height:100%;display:block'
      fitImg(img)
      img.addEventListener('load',  () => img.classList.add('loaded'), { once: true })
      img.addEventListener('error', () => img.classList.add('loaded'), { once: true })
      media.appendChild(img)

      const vid = document.createElement('video')
      vid.src         = videoSrc(item)
      vid.muted       = true
      vid.preload     = 'none'
      vid.playsInline = true
      vid.style.cssText = 'display:none;width:100%;height:100%'
      fitVid(vid)
      media.appendChild(vid)

      media.addEventListener('mouseenter', () => {
        img.style.display = 'none'
        vid.style.display = 'block'
        vid.currentTime = 0
        vid.play().catch(() => {})
      })
      media.addEventListener('mouseleave', () => {
        vid.pause()
        vid.style.display = 'none'
        img.style.display = 'block'
      })
    } else {
      // No thumbnail yet — seek video to avoid solid intro frame; generate thumbnail in background.
      // Chromium reports the turned (display) size, so phone videos saved as 16:9 come right.
      const vid = document.createElement('video')
      vid.src         = videoSrc(item)
      vid.muted       = true
      vid.preload     = 'metadata'
      vid.playsInline = true
      vid.style.cssText = 'width:100%;height:100%;display:block'
      fitVid(vid)
      seekToThumbnailFrame(vid)
      media.appendChild(vid)
      media.addEventListener('mouseenter', () => { vid.currentTime = 0; vid.play().catch(() => {}) })
      media.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = vid._thumbTime ?? 0 })
      queueThumbnail(item, card)
    }

    if (item.duration_secs != null) {
      const badge = document.createElement('span')
      badge.className = 'card-duration'
      badge.textContent = formatDuration(item.duration_secs)
      media.appendChild(badge)
    }
  } else {
    const img = document.createElement('img')
    img.loading   = 'lazy'
    img.decoding  = 'async'
    img.draggable = false
    img.alt = item.title ?? ''
    img.src = itemSrc(item)
    fitImg(img)
    img.addEventListener('load', () => {
      img.classList.add('loaded')
      if (IS_TAURI && !item.palette) extractAndSavePalette(item)
    }, { once: true })
    img.addEventListener('error', () => img.classList.add('loaded'), { once: true })
    media.appendChild(img)
  }

  // ── "Enhanced" badge (top-left) for AI-upscaled images ──
  if (item.type === 'image' && item.enhanced_path) {
    const eb = document.createElement('span')
    eb.className = 'card-enh-badge'
    eb.title = t('enhance.badge')
    eb.innerHTML = `${I('sparkle', 11)}<span>${t('enhance.badge')}</span>`
    media.appendChild(eb)
  }

  // ── Hover actions (top-right): save a copy, more (collecting lives in the card menu) ──
  const overlay = document.createElement('div')
  overlay.className = 'card-hover-overlay'
  overlay.innerHTML = `
    <div class="card-overlay-top">
      <button class="card-action-btn" data-action="save" title="${t('card.save_copy')}">${I('download-simple', 14)}</button>
      <button class="card-action-btn" data-action="more" title="${t('card.more')}">${I('dots-three', 14)}</button>
    </div>
  `
  const menuAt = (btn, openCollect) => {
    const r = btn.getBoundingClientRect()
    showContextMenu(r.left, r.bottom, item, idx, { openCollect })
  }
  overlay.querySelector('[data-action="save"]').addEventListener('click', e => {
    e.stopPropagation(); handleSaveCopy(item)
  })
  overlay.querySelector('[data-action="more"]').addEventListener('click', e => {
    e.stopPropagation(); menuAt(e.currentTarget, false)
  })

  media.appendChild(overlay)

  // ── Unified bottom caption: title + platform/collection pills + auto-tag
  //    prompt, stacked in one gradient scrim so nothing overlaps. Title + pills
  //    are hover-only; a pending suggestion keeps the caption visible (compact)
  //    and the rest expands on hover. Absolutely positioned → adds no masonry
  //    height, so every card stays exactly its media's native ratio. ──
  const caption = document.createElement('div')
  caption.className = 'card-caption'

  const titleText = displayTitle(item)
  if (titleText) {
    const titleEl = document.createElement('div')
    titleEl.className = 'card-title'
    titleEl.textContent = titleText
    caption.appendChild(titleEl)
  }

  const meta = document.createElement('div')
  meta.className = 'card-meta'

  const iconName   = platformIcon(item.source_platform)
  const iconHtml   = `<span class="icon icon-12" style="mask-image:url('/icons/${iconName}.svg');-webkit-mask-image:url('/icons/${iconName}.svg')" aria-hidden="true"></span>`
  const platformText = item.source_platform
    ? item.source_platform.charAt(0).toUpperCase() + item.source_platform.slice(1)
    : 'Local'

  const colNames = (() => {
    try { return item.collection_names ? JSON.parse(item.collection_names) : [] }
    catch { return [] }
  })()
  const colLabel = colNames.length > 0
    ? (colNames.length > 1 ? `${colNames[0]} +${colNames.length - 1}` : colNames[0])
    : null

  const colFolderHtml = `<span class="icon icon-12" style="mask-image:url('/icons/folder.svg');-webkit-mask-image:url('/icons/folder.svg')" aria-hidden="true"></span>`

  meta.innerHTML = `
    <span class="card-label card-label--platform">${iconHtml}${platformText}</span>
    ${colLabel ? `<span class="card-label card-label--collection">${colFolderHtml}${escHtml(colLabel)}</span>` : ''}
  `
  caption.appendChild(meta)

  const suggestionsEl = makeSuggestions(item)
  if (suggestionsEl) {
    card.classList.add('has-suggestion')
    caption.appendChild(suggestionsEl)
  }

  // Open detail modal on click (not on action buttons or suggestion rows)
  card.addEventListener('click', e => {
    if (e.target.closest('[data-action]') || e.target.closest('.suggestion-item')) return
    _suggestTip?.hide()   // the tip only shows over the grid itself
    openDetail(item, renderedItems, idx)
  })

  card.addEventListener('contextmenu', e => {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, item, idx)
  })
  card.addEventListener('mouseenter', () => { _hoverItem = item })
  card.addEventListener('mouseleave', () => { if (_hoverItem === item) _hoverItem = null })

  card.appendChild(media)
  card.appendChild(caption)
  return card
}

// ─── Tag suggestion question rows ────────────────────────────────────────────
// A card asks about one suggested tag at a time: "tag · Add · ×" (spec §5.6, §8.3).
// Which suggestions may show, and in which order, is lenses.js's display rule (§0c): a
// key shows when a lens that's on shows it on this item's media (a picture or a video),
// and ranks with the first such lens, specialist lenses first; at most 3 for a picture and
// 2 for a video, nothing before the lens data has loaded, unknown keys never. Add and ×
// answer in Rust (answer_suggestion, with the lens that showed the row): Add links the
// tag; both remember the answer and drop the key. The answered row slides out and the
// next question rises in its place.

const ROW_LEAVE_MS   = 180   // .suggestion-leaving (global.css) fades out in 0.18 s
const MAPS_CHUNK     = 500   // items per get_suggestion_maps call (Rust takes up to 1000)
// Questions answered in this session (`<item id>|<key>`). Rust drops an answered key
// at once, but an item read just before that would bring the question back.
const _answered = new Set()
// Collection hints that left every item in this session (`col:<tag id>`): the tag now stands for
// a concept (one name, one tag: a people's tag that Add or the picker made a concept's tag), so
// the lenses ask about it and Rust removed its hints from every item (settle_concept_tag)
const _goneHints = new Set()

/** The questions an item's card may ask, best first: [{ key, score, label, lens, … }]. */
function parseAutoTags(item) {
  if (!item) return []
  const conf = { ...parseConfidence(item.auto_tag_confidence) }
  let changed = false
  for (const key of Object.keys(conf)) {
    if (_answered.has(`${item.id}|${key}`) || _goneHints.has(key)) { delete conf[key]; changed = true }
  }
  return visibleSuggestions(changed ? { ...item, auto_tag_confidence: conf } : item)
}

function makeSuggestions(item) {
  const first = parseAutoTags(item)[0]
  if (!first) return null
  const wrap = document.createElement('div')
  wrap.className = 'card-suggestions'
  // One question at a time — three stacked rows covered a third of the image on
  // every tagged card. Answering it brings up the next one (removeSuggestionRow).
  wrap.appendChild(makeSuggestionRow(item, first))
  return wrap
}

function makeSuggestionRow(item, suggestion) {
  const row = document.createElement('div')
  row.className = 'suggestion-item'
  row.dataset.key = suggestion.key
  row.dataset.lens = suggestion.lens ?? ''   // the lens that shows it, for the answer

  const sparkle = document.createElement('span')
  sparkle.className = 'icon icon-14 suggestion-sparkle'
  sparkle.style.cssText = `mask-image:url('/icons/tag.svg');-webkit-mask-image:url('/icons/tag.svg')`
  sparkle.setAttribute('aria-hidden', 'true')

  // Just the tag — the one-time tip (maybeShowSuggestTip) explains what the row is
  const q = document.createElement('span')
  q.className = 'suggestion-q'
  q.appendChild(document.createElement('strong'))

  const yes = document.createElement('button')
  yes.className = 'suggestion-yes'

  const no = document.createElement('button')
  no.className = 'suggestion-no'
  no.innerHTML = I('x', 14)

  yes.addEventListener('click', e => { e.stopPropagation(); applySuggestion(item, row) })
  no.addEventListener('click',  e => { e.stopPropagation(); dismissSuggestion(item, row) })

  row.append(sparkle, q, yes, no)
  labelRow(row, suggestion.label)
  return row
}

// A row's words in the app's language: the tag's name, Add and the two tooltips.
// Another language only swaps the words; the question stays and nothing moves.
function labelRow(row, label) {
  const name = row.querySelector('.suggestion-q strong')
  const yes  = row.querySelector('.suggestion-yes')
  const no   = row.querySelector('.suggestion-no')
  if (!name || !yes || !no) return
  if (name.textContent !== label) name.textContent = label
  const addTitle = t('lens.card.add_title', { name: label })
  if (yes.title !== addTitle) { yes.title = addTitle; yes.setAttribute('aria-label', addTitle) }
  const notThis = t('lens.card.dismiss')
  if (no.title !== notThis) { no.title = notThis; no.setAttribute('aria-label', notThis) }
  // A new row, or Add in another language: the word first, then measured (fitRows)
  const word = t('lens.card.add')
  if (row.dataset.addWord !== word) {
    row.dataset.addWord = word
    setAddLook(row, false)
    _fitQueue.add(row)
  }
}

// ── Narrow cards: an icon-only Add (spec §7) ──
// When a card leaves the tag's name under ~60 px (compact density, the longer Uzbek
// words), Add shows as a round check button with the same tooltip, and the name gets
// the room the word took. Measured once laid out; the word's width is remembered, so a
// card that has grown wide enough gets the word back.
const NARROW_LABEL_PX = 60
const _fitQueue = new Set()   // rows waiting to be measured (flushFit, once they're on the page)
let _fitFrame = 0             // the frame that measures them (scheduleFit)

function setAddLook(row, narrow) {
  const yes = row.querySelector('.suggestion-yes')
  if (!yes) return
  row.dataset.narrow = narrow ? '1' : '0'
  yes.classList.toggle('suggestion-yes--icon', narrow)
  if (narrow) yes.innerHTML = I('check', 12)
  else yes.textContent = row.dataset.addWord || t('lens.card.add')
}

// Reads every row first, then changes the ones that need it (one layout, no thrashing)
function fitRows(rows) {
  const changes = []
  for (const row of rows) {
    if (!row?.isConnected || row.classList.contains('suggestion-leaving')) continue
    const q   = row.querySelector('.suggestion-q')
    const yes = row.querySelector('.suggestion-yes')
    if (!q || !yes || !row.offsetWidth) continue   // not laid out: the grid is hidden
    const narrow = row.dataset.narrow === '1'
    // The room the name would have next to the word
    const room = narrow ? q.clientWidth - ((Number(row.dataset.addW) || 0) - yes.offsetWidth) : q.clientWidth
    if (!narrow && room < NARROW_LABEL_PX) changes.push([row, true, yes.offsetWidth])
    else if (narrow && room >= NARROW_LABEL_PX) changes.push([row, false, 0])
  }
  for (const [row, narrow, wordW] of changes) {
    if (narrow) row.dataset.addW = String(wordW)
    setAddLook(row, narrow)
  }
}

// Measures the waiting rows now (one layout of the grid). render() calls it before the
// first paint; everything else goes through scheduleFit.
function flushFit() {
  if (!_fitQueue.size) return
  const rows = [..._fitQueue]
  _fitQueue.clear()
  fitRows(rows)
}

// Measures the waiting rows once, in the next frame, before it's painted (so the wide Add
// never flashes). Measuring lays out the whole grid, and that costs the same for one row
// as for a thousand: rows that arrive together (a re-score of the library brings thousands)
// are measured together, never one card at a time.
function scheduleFit() {
  if (_fitFrame) return
  _fitFrame = requestAnimationFrame(() => {
    _fitFrame = 0
    flushFit()
  })
}

function allRows() {
  return allCards().map(c => c.querySelector('.card-suggestions .suggestion-item'))
}

// ── Keeping a card's question up to date ──

/** The in-memory item a card was drawn from (refreshCardPills keeps it fresh). */
function itemForCard(card) {
  const id = card?.dataset.id
  if (!id) return null
  return renderedItems.find(r => r.id === id) ?? _lastView?.teaserItems?.find(r => r.id === id) ?? null
}

function latestItem(item) {
  return renderedItems.find(r => r.id === item.id) ?? item
}

// Puts a card's current question in place: a fresh row that rises (suggestion-rise on
// .card-suggestions), or none, and then the caption goes back to hover-only. The row is
// measured in the next frame, with every other new row (scheduleFit).
function showRow(card, item) {
  card.querySelector('.card-suggestions')?.remove()
  const wrap = makeSuggestions(item)
  if (!wrap) { card.classList.remove('has-suggestion'); return }
  card.querySelector('.card-caption')?.appendChild(wrap)
  card.classList.add('has-suggestion')
  scheduleFit()
}

// Runs `fn` once a row has faded out (ROW_LEAVE_MS). Rows that start leaving in the same
// task are swapped together, in one timer: a lens update can change thousands of
// questions at once, and a timer per card would let a frame (and a measuring of the whole
// grid) in between every few of them.
let _leaveBatch = null
function afterRowLeaves(fn) {
  if (!_leaveBatch) {
    const batch = _leaveBatch = []
    queueMicrotask(() => { if (_leaveBatch === batch) _leaveBatch = null })
    setTimeout(() => {
      for (const f of batch) {
        try { f() } catch (err) { log.warn('row_swap_failed', { error: err }) }
      }
    }, ROW_LEAVE_MS)
  }
  _leaveBatch.push(fn)
}

// The pointer is on the card, or the keyboard focus is in it (a button clicked with the
// mouse keeps the focus too, but that one doesn't count)
function isCardBusy(card) {
  if (card.matches(':hover')) return true
  const el = document.activeElement
  if (!el || el === document.body || !card.contains(el)) return false
  try { return el.matches(':focus-visible') } catch { return true }   // a webview without :focus-visible
}

// Brings one card's question up to date (new scores, a lens on or off, the language).
// The same question only gets its words again. Another question replaces the row (it
// slides out, the new one rises), but never under the pointer or the keyboard focus:
// that waits until both have left the card, so nothing changes under a click.
function syncCardRow(card, item) {
  if (!card?.isConnected || !item) return
  const row = card.querySelector('.card-suggestions .suggestion-item')
  // Being answered: removeSuggestionRow puts the next question up itself
  if (row && (row.classList.contains('suggestion-saving') || row.classList.contains('suggestion-leaving'))) return
  const next = parseAutoTags(item)[0] ?? null
  if ((row?.dataset.key ?? null) === (next?.key ?? null)) {
    if (row && next) { labelRow(row, next.label); row.dataset.lens = next.lens ?? '' }
    return
  }
  if (isCardBusy(card)) { syncWhenIdle(card); return }
  if (!row) { showRow(card, item); return }
  row.classList.add('suggestion-leaving')
  afterRowLeaves(() => {
    if (card.isConnected) showRow(card, itemForCard(card) ?? item)
  })
}

// Waits until the pointer and the keyboard focus have left the card, then syncs it once
function syncWhenIdle(card) {
  if (card._rowSyncWaiting) return
  card._rowSyncWaiting = true
  // A moment later, so :hover and the focus have moved on
  const check = () => setTimeout(() => {
    if (!card.isConnected || isCardBusy(card)) return
    card.removeEventListener('pointerleave', check)
    card.removeEventListener('focusout', check)
    card._rowSyncWaiting = false
    const item = itemForCard(card)
    if (item) { syncCardRow(card, item); scheduleFit() }
  }, 0)
  card.addEventListener('pointerleave', check)
  card.addEventListener('focusout', check)
}

// Every card on the grid (lens data changed, or the language)
function syncAllCardRows() {
  const byId = new Map()
  for (const i of _lastView?.teaserItems ?? []) byId.set(i.id, i)
  for (const i of renderedItems) byId.set(i.id, i)
  for (const card of allCards()) {
    const item = byId.get(card.dataset.id)
    if (item) syncCardRow(card, item)
  }
  scheduleFit()   // the rows that only got new words (another language) are measured too
  maybeShowSuggestTip()
}

// ─── One-time tip for tag suggestions ─────────────────────────────
// The suggestion row is just "tag · Add · ×", so the first time one is on screen a small
// tip explains it. Got it / Add / × mark it seen for good; scrolling or leaving only
// hides it (it comes back next time).
// One coach mark at a time, and only over the grid itself: while start-up's own steps run
// (the sign-in screen, the role step, the welcome tour and the extension promo after it,
// and the moment between them: role-step.js startupBusy), an item is open, a dialog is up
// or "Links from your browser" is about to open (browser-queue.js linksPending: it would
// cover the tip), the tip waits and looks again a moment later.
const SUGGEST_TIP_KEY = 'qooti-tip-tag-suggest'
const TIP_RETRY_MS = 1000
let _suggestTip = null
let _tipRetry   = null

function tipMustWait() {
  return startupBusy() || isDialogOpen() || linksPending() || !!document.querySelector('.detail-modal.open')
}

function maybeShowSuggestTip() {
  if (_suggestTip) return
  try { if (localStorage.getItem(SUGGEST_TIP_KEY)) return } catch { return }
  if (tipMustWait()) {
    _tipRetry ??= setTimeout(() => { _tipRetry = null; maybeShowSuggestTip() }, TIP_RETRY_MS)
    return
  }
  requestAnimationFrame(() => {
    const scrollEl = container?.querySelector('#grid-scroll')
    if (!scrollEl || container.hidden || _suggestTip) return
    if (tipMustWait()) { maybeShowSuggestTip(); return }   // something opened meanwhile
    const vp = scrollEl.getBoundingClientRect()
    const row = [...scrollEl.querySelectorAll('.card:not(.free-teaser-card) .suggestion-item')].find(r => {
      const b = r.getBoundingClientRect()
      return b.width > 0 && b.top > vp.top + 8 && b.bottom < vp.bottom - 8
    })
    if (!row) return

    const tip = document.createElement('div')
    tip.className = 'coach-tip'
    tip.setAttribute('role', 'dialog')
    tip.innerHTML = `
      <p class="coach-tip-title">${t('suggest.tip_title')}</p>
      <p class="coach-tip-body">${t('suggest.tip_body')}</p>
      <button class="coach-tip-ok">${t('suggest.tip_ok')}</button>`
    document.getElementById('overlays').appendChild(tip)

    // Above the row (below it if there's no room), arrow pointing at it
    const b = row.getBoundingClientRect()
    const w = tip.offsetWidth, h = tip.offsetHeight
    const left = Math.min(Math.max(8, b.left + b.width / 2 - w / 2), window.innerWidth - w - 8)
    let top = b.top - h - 10
    const below = top < vp.top + 8
    if (below) top = b.bottom + 10
    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
    tip.classList.toggle('is-below', below)
    tip.style.setProperty('--arrow-x', `${b.left + b.width / 2 - left}px`)

    const hide = () => {
      tip.remove()
      scrollEl.removeEventListener('scroll', hide)
      window.removeEventListener('resize', hide)
      _suggestTip = null
    }
    const seen = () => { try { localStorage.setItem(SUGGEST_TIP_KEY, '1') } catch {} ; hide() }
    tip.querySelector('.coach-tip-ok').addEventListener('click', seen)
    row.addEventListener('click', seen, { once: true })   // Add or × answers it too
    scrollEl.addEventListener('scroll', hide, { passive: true })
    window.addEventListener('resize', hide)
    _suggestTip = { hide }
  })
}

// Add: Rust links the Tag lens tag (made on first use) or the hinted collection tag,
// remembers the answer and drops the key → the Tag. With it go the item's other questions
// that ask the name it now has (§0b.2), here as in Rust. A collection hint whose tag is gone
// meanwhile, or a question whose name the item already has, gives null: Rust has dropped the
// key without an answer, and the row goes.
async function applySuggestion(item, row) {
  const key = row.dataset.key
  if (!key || row.classList.contains('suggestion-saving') || row.classList.contains('suggestion-leaving')) return
  row.classList.add('suggestion-saving')
  const isHint = key.startsWith('col:')
  try {
    const tag = await api.answerSuggestion(item.id, key, 'added', row.dataset.lens || null)
    if (tag) log.info('suggestion_accepted', { id: item.id, key })
    else log.info('suggestion_gone', { id: item.id, key })
    forgetSuggestion(item, key)
    if (tag) {
      for (const k of questionsNamedLike(tag, parseConfidence(latestItem(item).auto_tag_confidence))) forgetSuggestion(item, k)
    }
    if (tag) store.emit(events.TAG_CREATED, { tag })
    removeSuggestionRow(item, row)
  } catch (err) {
    log.error('suggestion_accept_failed', { id: item.id, key, error: err })
    if (!isHint) { row.classList.remove('suggestion-saving'); return }
    // A hint that can't be added would fail the same way on every click: it goes, as a "no"
    forgetSuggestion(item, key)
    removeSuggestionRow(item, row)
    api.answerSuggestion(item.id, key, 'dismissed', null)
      .catch(e => log.warn('suggestion_dismiss_failed', { id: item.id, key, error: e }))
  }
}

// ×: the row goes at once; Rust remembers the answer, so the question never comes back
function dismissSuggestion(item, row) {
  const key = row.dataset.key
  if (!key || row.classList.contains('suggestion-saving') || row.classList.contains('suggestion-leaving')) return
  log.info('suggestion_dismissed', { id: item.id, key })
  forgetSuggestion(item, key)
  removeSuggestionRow(item, row)
  api.answerSuggestion(item.id, key, 'dismissed', row.dataset.lens || null)
    .catch(err => log.warn('suggestion_dismiss_failed', { id: item.id, key, error: err }))
}

// A tag that stands for a concept is never asked about by a collection hint: when a tag comes
// back from Add or the picker with a concept, its hints leave every card here too, at once (a
// card would otherwise ask about the tag its item has just been given, or ask it twice)
function forgetHintsOf(tag) {
  if (!tag?.id || !tagConceptId(tag)) return
  const key = `col:${tag.id}`
  if (_goneHints.has(key)) return
  _goneHints.add(key)
  const cards = cardMap()
  const asked = new Map()   // id → an in-memory copy that holds the hint
  for (const index of itemIndexes()) {
    for (const [id, copy] of index) {
      if (!asked.has(id) && key in parseConfidence(copy.auto_tag_confidence)) asked.set(id, copy)
    }
  }
  for (const [id, copy] of asked) {
    const card = cards.get(id)
    if (card) syncCardRow(card, itemForCard(card) ?? copy)
  }
}

// An answered key leaves the in-memory item too (Rust has dropped it from the stored
// suggestions), so the next row, a resize or a late re-read never ask it again
function forgetSuggestion(item, key) {
  _answered.add(`${item.id}|${key}`)
  const copies = new Set([item, renderedItems.find(r => r.id === item.id), _lastView?.visibleItems?.find(r => r.id === item.id)])
  for (const copy of copies) {
    if (!copy) continue
    const conf = { ...parseConfidence(copy.auto_tag_confidence) }
    if (!(key in conf)) continue
    delete conf[key]
    copy.auto_tag_confidence = JSON.stringify(conf)
  }
}

// The answered row slides out, then the next question (if any) rises in its place, or
// the caption goes back to hover-only
function removeSuggestionRow(item, row) {
  row.classList.add('suggestion-leaving')
  const card = row.closest('.card')
  afterRowLeaves(() => {
    row.remove()
    if (card?.isConnected) showRow(card, latestItem(item))
  })
}

function itemSrc(item) {
  const path = item.thumbnail_path ?? item.stored_path
  return IS_TAURI ? convertFileSrc(path) : path
}

function videoSrc(item) {
  return IS_TAURI ? convertFileSrc(item.stored_path) : item.stored_path
}

// ─── Video thumbnail generation (one-time per item) ──────────────
// Generates a JPEG from the video frame at 10% duration using an off-screen
// canvas, saves it to the vault, and updates the DB. Subsequent renders use
// <img> (instant, browser-cached) instead of a decoded <video> seek.
//
// Generation is deferred until the card enters the viewport (+500px margin)
// so we never process items the user hasn't scrolled to yet. The queue and
// all pending observers are cancelled when the grid rerenders, preventing
// stale background work after a filter/collection change.

const _thumbQueue   = []
let   _thumbActive  = 0
const THUMB_CONCURRENCY = 2

// card element → item; observed until it enters the viewport
const _thumbPending  = new Map()
const _thumbObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    const item = _thumbPending.get(entry.target)
    if (!item) continue
    _thumbObserver.unobserve(entry.target)
    _thumbPending.delete(entry.target)
    if (!item.thumbnail_path) { _thumbQueue.push(item); _drainThumbQueue() }
  }
}, { rootMargin: '500px' })

function queueThumbnail(item, el) {
  if (!IS_TAURI || item.thumbnail_path) return
  _thumbPending.set(el, item)
  _thumbObserver.observe(el)
}

function _clearThumbQueue() {
  _thumbQueue.length = 0
  for (const el of _thumbPending.keys()) _thumbObserver.unobserve(el)
  _thumbPending.clear()
}

function _drainThumbQueue() {
  while (_thumbActive < THUMB_CONCURRENCY && _thumbQueue.length > 0) {
    const item = _thumbQueue.shift()
    if (item.thumbnail_path) continue  // generated by a parallel job while queued
    _thumbActive++
    _generateThumbnail(item)
      .then(path => {
        item.thumbnail_path = path
        const ri = renderedItems.findIndex(r => r.id === item.id)
        if (ri !== -1) renderedItems[ri].thumbnail_path = path
      })
      .catch(e => console.warn('[grid] thumb gen failed:', item.id, e))
      .finally(() => { _thumbActive--; _drainThumbQueue() })
  }
}

function _generateThumbnail(item) {
  return new Promise((resolve, reject) => {
    const vid = document.createElement('video')
    vid.crossOrigin = 'anonymous'
    vid.src         = videoSrc(item)
    vid.muted       = true
    vid.preload     = 'metadata'
    vid.playsInline = true

    const cleanup = () => { vid.src = ''; vid.load() }

    vid.addEventListener('loadedmetadata', () => {
      vid.currentTime = vid.duration > 0 ? Math.min(vid.duration * 0.1, 5) : 1
    }, { once: true })

    vid.addEventListener('seeked', () => {
      try {
        const MAX_W  = 640
        const vw     = vid.videoWidth  || MAX_W
        const vh     = vid.videoHeight || 360
        const scale  = Math.min(1, MAX_W / vw)
        const canvas = document.createElement('canvas')
        canvas.width  = Math.round(vw * scale)
        canvas.height = Math.round(vh * scale)
        canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(async blob => {
          cleanup()
          if (!blob) { reject(new Error('toBlob failed')); return }
          try {
            const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
            const path  = await api.saveThumbnail(item.id, bytes)
            resolve(path)
          } catch (e) { reject(e) }
        }, 'image/jpeg', 0.82)
      } catch (e) { cleanup(); reject(e) }
    }, { once: true })

    vid.addEventListener('error', e => { cleanup(); reject(e) }, { once: true })
  })
}

// ─── Short-form chunking ──────────────────────────────────────────
// Groups items into runs of SHELF_CHUNK_SIZE.
// Remainder < SHELF_CHUNK_SIZE is merged into the previous chunk (no half-full rows).
function chunkShortForm(items) {
  const chunks = []
  let rem = [...items]
  while (rem.length > 0) {
    if (rem.length <= SHELF_CHUNK_SIZE || rem.length - SHELF_CHUNK_SIZE < SHELF_CHUNK_SIZE) {
      chunks.push(rem); break
    }
    chunks.push(rem.splice(0, SHELF_CHUNK_SIZE))
  }
  return chunks
}

// ─── Column count helpers ─────────────────────────────────────────
function calcColCount() {
  const scrollEl = container?.querySelector('#grid-scroll')
  if (!scrollEl) return Math.max(1, currentColCount)

  const style = getComputedStyle(document.documentElement)
  const minW  = parseFloat(style.getPropertyValue('--grid-min-width')) || 300
  const gap   = parseFloat(style.getPropertyValue('--grid-gap'))       || 4
  // 48px = .inspiration-grid padding (24px × 2 sides). scrollbar-gutter:stable
  // keeps clientWidth constant regardless of overflow, so this is reliable.
  // While the grid view is hidden (e.g. on the Settings page) clientWidth is 0.
  // Don't recompute to 1 column then — it corrupts the cached layout and flashes
  // the first card full-width for a moment when the grid is shown again.
  if (scrollEl.clientWidth === 0) return Math.max(1, currentColCount)
  const availW = Math.max(0, scrollEl.clientWidth - 48)
  const cols = Math.max(1, Math.floor((availW + gap) / (minW + gap)))

  // Write back to CSS so .inspiration-grid uses exactly this count —
  // eliminates any possibility of CSS auto-fill resolving a different value.
  document.documentElement.style.setProperty('--grid-cols', cols)
  return cols
}

function onGridResize() {
  clearTimeout(_resizeTimer)
  _resizeTimer = setTimeout(() => {
    // Ignore resize ticks while the grid is hidden (width 0) — those come from
    // switching to another view and must not trigger a 1-column relayout.
    const scrollEl = container?.querySelector('#grid-scroll')
    if (!scrollEl || scrollEl.clientWidth === 0) return
    const newCount = calcColCount()
    // Re-lay-out from cache (no DB round-trip, no re-shuffle) rather than reload.
    if (newCount !== currentColCount) relayout()
    else fitRows(allRows())   // same columns, wider or narrower cards: Add word or icon again
  }, 200)
}

// ─── Grid query helpers (covers all masonry sections) ─────────────
function queryCard(id) {
  for (const g of gridEls) {
    const c = g.querySelector(`.card[data-id="${id}"]`)
    if (c) return c
  }
  return null
}

function allCards() {
  return gridEls.flatMap(g => [...g.querySelectorAll('.card')])
}

function bothGrids() {
  return gridEls
}

// ─── Context menu ────────────────────────────────────────────────

function closeCtxMenu() {
  if (!_ctxMenu) return
  _ctxMenu.remove()
  _ctxMenu = null
  if (_ctxListeners) {
    document.removeEventListener('mousedown', _ctxListeners.down)
    document.removeEventListener('keydown',   _ctxListeners.key)
    window.removeEventListener('scroll',      _ctxListeners.scroll, true)
    _ctxListeners = null
  }
  allCards().forEach(c => { c.classList.remove('ctx-dimmed'); c.classList.remove('ctx-selected') })
  setTimeout(() => bothGrids().forEach(g => g.classList.remove('ctx-open')), 320)
}

function showContextMenu(x, y, item, idx, { openCollect = false } = {}) {
  closeCtxMenu()

  // Measure card rect BEFORE applying ctx classes — ctx-selected adds scale(1.03)
  // which would skew the bounding rect used for menu sizing/centering.
  const cardEl   = queryCard(item.id)
  const mediaEl  = cardEl?.querySelector('.card-media')
  const cardRect = (mediaEl ?? cardEl)?.getBoundingClientRect()

  // Enable transition on grid cards, dim all except the target, ring the target
  bothGrids().forEach(g => g.classList.add('ctx-open'))
  allCards().forEach(c => {
    if (c.dataset.id !== item.id) c.classList.add('ctx-dimmed')
    else c.classList.add('ctx-selected')
  })

  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  _ctxMenu = menu
  menu.style.left = `${x}px`
  menu.style.top  = `${y}px`

  function addBtn(icon, label, danger, onClick) {
    const btn = document.createElement('button')
    btn.className = 'ctx-item' + (danger ? ' ctx-item--danger' : '')
    btn.innerHTML = `${I(icon, 16)}<span>${label}</span>`
    btn.addEventListener('click', () => { closeCtxMenu(); onClick() })
    menu.appendChild(btn)
  }

  // Guide B6: Source · Collect · Delete. Opening and copying live on the card itself
  // (click opens it; the hover actions save a copy).
  if (item.source_url) {
    addBtn('arrow-square-out', t('ctx.source'), false, () => api.openUrl(item.source_url))
  }

  // "Collect" row — submenu populates async, opened via JS mouseenter (not CSS :hover)
  const colRow = document.createElement('div')
  colRow.className = 'ctx-item ctx-item-has-sub'
  colRow.tabIndex = 0
  colRow.innerHTML = `${I('plus', 16)}<span>${t('ctx.collect')}</span>`

  const submenu = document.createElement('div')
  submenu.className = 'ctx-submenu'
  const loadingEl = document.createElement('div')
  loadingEl.className = 'ctx-empty-sub'
  loadingEl.textContent = t('ctx.loading')
  submenu.appendChild(loadingEl)
  colRow.appendChild(submenu)
  menu.appendChild(colRow)

  // JS-driven open/close so scrolling inside the submenu can't break the hover chain
  let _subCloseTimer = null
  const openSub  = () => {
    clearTimeout(_subCloseTimer)
    submenu.style.display = 'flex'
    colRow.classList.add('sub-open')
    // Centre the list over the card, just inside its ring (the bar is centred on the card)
    const rr = colRow.getBoundingClientRect(), mr = menu.getBoundingClientRect()
    submenu.style.left = `${mr.left + mr.width / 2 - rr.left}px`
    if (cardRect) submenu.style.width = `${Math.max(200, cardRect.width - 10)}px`
  }
  const closeSub = () => { _subCloseTimer = setTimeout(() => { submenu.style.display = 'none'; colRow.classList.remove('sub-open') }, 80) }
  colRow.addEventListener('mouseenter', openSub)
  colRow.addEventListener('mouseleave', e => { if (!submenu.contains(e.relatedTarget)) closeSub() })
  submenu.addEventListener('mouseenter', openSub)
  submenu.addEventListener('mouseleave', e => { if (!colRow.contains(e.relatedTarget)) closeSub() })

  // Populate submenu in background — fetch collections + membership in parallel
  Promise.all([
    api.listCollections(),
    api.getCollectionIdsForInspiration(item.id),
  ]).then(([collections, memberIds]) => {
    if (!_ctxMenu) return
    submenu.innerHTML = ''
    const memberSet = new Set(memberIds)

    // Scrollable list — capped at 5 visible items (5 × 34px = 170px)
    const scrollArea = document.createElement('div')
    scrollArea.className = 'ctx-submenu-scroll'

    for (const col of collections) {
      const inCol = memberSet.has(col.id)
      const btn   = document.createElement('button')
      btn.className = 'ctx-item ctx-col-row' + (col.locked ? ' ctx-col-row--locked' : '')
      btn.dataset.member = inCol ? '1' : '0'
      btn.innerHTML = `
        <span class="ctx-col-icon">${I('folder', 16)}</span>
        <span class="ctx-col-name">${escHtml(col.name)}</span>
        ${col.locked ? `<span class="ctx-col-lock">${I('lock', 12)}</span>` : `<span class="ctx-col-check">${I('check', 14)}</span>`}
      `
      btn.addEventListener('click', () => {
        if (col.locked) {
          // One toast however often it's tried — a retry keeps it up longer
          store.emit(events.SYSTEM_TOAST, {
            type: 'info',
            message: t('collection.readonly_toast'),
            duration: 5000,
            key: 'collection-locked',
            action: { label: t('collections.upgrade'), onClick: () => api.openUrl('https://account.bloot.app/') },
          })
          return
        }
        const wasMember = btn.dataset.member === '1'
        const nowMember = !wasMember
        btn.dataset.member = nowMember ? '1' : '0'
        if (nowMember) { memberSet.add(col.id);    log.info('collection_added',   { id: item.id, collection: col.name }); api.addToCollection(col.id, item.id).catch(e => log.error('collection_add_failed', { error: e })) }
        else           { memberSet.delete(col.id); log.info('collection_removed', { id: item.id, collection: col.name }); api.removeFromCollection(col.id, item.id).catch(e => log.error('collection_remove_failed', { error: e })) }
        updateCardCollectionPill(cardEl, collections, memberSet)
      })
      scrollArea.appendChild(btn)
    }
    submenu.appendChild(scrollArea)

    // "New collection" outside the scroll area — always fully visible
    const createWrap = document.createElement('div')
    createWrap.className = 'ctx-submenu-create'
    const createBtn = document.createElement('button')
    createBtn.className = 'ctx-item ctx-col-create'
    createBtn.innerHTML = `${I('folder-plus', 16)}<span>${t('collection.new_title')}</span>`
    createBtn.addEventListener('click', async () => {
      closeCtxMenu()
      const name = await showPrompt({ title: t('collection.new_title'), placeholder: t('collection.name_ph'), icon: 'folder' })
      if (!name) return
      try {
        await api.createCollection(name)
        log.info('collection_created', { name })
        store.emit(events.COLLECTION_CREATED)
      } catch (err) {
        log.error('collection_create_failed', { name, error: err })
      }
    })
    createWrap.appendChild(createBtn)
    submenu.appendChild(createWrap)
  }).catch(() => {
    if (!_ctxMenu) return
    submenu.innerHTML = ''
    const err = document.createElement('div')
    err.className = 'ctx-empty-sub'
    err.textContent = t('grid.could_not_load')
    submenu.appendChild(err)
  })

  addBtn('trash', t('action.delete'), true, () => handleDelete(item.id))

  document.body.appendChild(menu)

  // Position bar under the card image
  const gap = 10
  const isCompact     = document.documentElement.classList.contains('density-compact')
  const isComfortable = document.documentElement.classList.contains('density-comfortable')

  if (cardRect) {
    // Compact: icon-only, span full card width. All other densities auto-size from content.
    if (isCompact) menu.style.width = `${cardRect.width}px`

    const { width: menuW, height: menuH } = menu.getBoundingClientRect()

    let left = cardRect.left + (cardRect.width - menuW) / 2
    left = Math.max(gap, Math.min(left, window.innerWidth - menuW - gap))

    let top = cardRect.bottom + gap
    if (top + menuH > window.innerHeight - gap) {
      top = cardRect.top - menuH - gap
      menu.classList.add('ctx-menu--above')   // the Collect list then opens downward, over the card
    }

    menu.style.left = `${left}px`
    menu.style.top  = `${top}px`
  } else {
    // Fallback: position near cursor, clamped to viewport
    const menuRect = menu.getBoundingClientRect()
    if (x + menuRect.width  > window.innerWidth)  menu.style.left = `${x - menuRect.width}px`
    if (y + menuRect.height > window.innerHeight) menu.style.top  = `${y - menuRect.height}px`
  }


  if (openCollect) openSub()

  // Close on outside click, Escape, or scroll (but not scroll inside the menu itself)
  const down   = e => { if (!menu.contains(e.target)) closeCtxMenu() }
  const key    = e => { if (e.key === 'Escape') closeCtxMenu() }
  const scroll = e => { if (!menu.contains(e.target)) closeCtxMenu() }
  _ctxListeners = { down, key, scroll }
  setTimeout(() => {
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown',   key)
    window.addEventListener('scroll',      scroll, { capture: true, passive: true })
  }, 0)
}

// ─── Actions ─────────────────────────────────────────────────────
// "Save a copy" — copies the original file into a folder the user picks.
async function handleSaveCopy(item) {
  if (!IS_TAURI || !item.stored_path) return
  const { open } = await import('@tauri-apps/plugin-dialog')
  const dir = await open({ directory: true, title: t('card.save_copy') }).catch(() => null)
  if (!dir) return
  try {
    await api.copyFileToFolder(item.stored_path, dir)
    store.emit(events.SYSTEM_TOAST, { type: 'success', message: t('card.saved_copy') })
  } catch (err) {
    log.error('save_copy_failed', { error: err })
    store.emit(events.SYSTEM_TOAST, { type: 'error', message: t('card.save_copy_failed') })
  }
}

async function handleCopy(item, btn) {
  const prev = btn?.innerHTML
  try {
    if (btn) { btn.innerHTML = I('check', 14); btn.style.color = '#10b981' }

    if (item.type === 'video') {
      // Copy the actual file to the OS clipboard (pasteable in Finder/Explorer)
      await api.copyFileToClipboard(item.stored_path)
      store.emit(events.SYSTEM_TOAST, { type: 'success', message: t('card.copy_video_ok') })
    } else {
      // Images/GIFs: fetch file, re-encode as PNG, write to clipboard
      const url  = IS_TAURI ? convertFileSrc(item.stored_path) : item.stored_path
      const blob = await fetch(url).then(r => r.blob())
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width  = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      bitmap.close()
      const png = await new Promise(res => canvas.toBlob(res, 'image/png'))
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      store.emit(events.SYSTEM_TOAST, { type: 'success', message: t('card.copy_image_ok') })
    }
  } catch (err) {
    console.error('[grid] copy failed:', err)
    if (btn) { btn.innerHTML = I('x', 14); btn.style.color = 'var(--error)' }
    store.emit(events.SYSTEM_TOAST, { type: 'error', message: t('card.copy_failed', { error: String(err) }) })
  } finally {
    if (btn) setTimeout(() => { btn.innerHTML = prev; btn.style.color = '' }, 1200)
  }
}

async function handleDelete(id) {
  if (!(await confirmDeleteItem())) return
  try {
    await api.deleteInspiration(id)
    log.info('deleted', { id })
    sfx.delete()
    removeCard(id)
    store.emit(events.GRID_ITEM_DELETED, { id })
    refreshTagChips()
  } catch (err) {
    log.error('delete_failed', { id, error: err })
  }
}

function removeCard(id) {
  const scrollEl = container?.querySelector('#grid-scroll')
  if (!scrollEl) return

  // Remove from short-form shelves (shelf cards don't participate in cascade)
  scrollEl.querySelectorAll(`.short-form-shelf [data-id="${id}"]`).forEach(el => el.remove())

  // Find the card in whichever grid segment holds it: it fades and shrinks a touch, then
  // the cards below it glide up into the gap (motion.removeWithFlow).
  for (let i = 0; i < gridEls.length; i++) {
    const c = gridEls[i].querySelector(`.card[data-id="${id}"]`)
    if (!c) continue
    motion.removeWithFlow(c, () => {
      // Cascade: pull the first card from each subsequent segment to fill the empty
      // slot left at the bottom of the segment where the deletion occurred.
      for (let k = i; k < gridEls.length - 1; k++) {
        const first = gridEls[k + 1].querySelector('.card')
        if (first) gridEls[k].appendChild(first)
      }
      checkEmpty()
    })
    break
  }

  // Keep in-memory list in sync for detail-modal arrow navigation
  const pos = renderedItems.findIndex(item => item.id === id)
  if (pos !== -1) renderedItems.splice(pos, 1)
  _lastViewRemove(id)  // so a later resize relayout doesn't resurrect the card
}

// Rust has scored these items (or a tag went onto one): read their suggestions again and
// bring their cards' questions up to date (spec §0b.8). One refresh runs at a time and
// later ids wait in a queue, so a re-score of the whole library (an autotag:scored per 500
// items, all within a second) is read 500 cards per get_suggestion_maps call. Only cards
// on the grid are read. A row is only rebuilt when its question changes, and never under
// the pointer or the keyboard focus (syncCardRow).
const _pillQueue = new Set()   // ids waiting to be read again, oldest first
let _pillBusy = false

function refreshCardPills(ids) {
  for (const id of Array.isArray(ids) ? ids : []) {
    if (id != null) _pillQueue.add(String(id))
  }
  if (!_pillBusy && _pillQueue.size) runPillQueue().catch(err => log.warn('refresh_failed', { error: err }))
}

async function runPillQueue() {
  _pillBusy = true
  try {
    while (_pillQueue.size) {
      // The next ids whose card is on the grid (the others are dropped)
      const onGrid = cardMap()
      const chunk  = []
      for (const id of _pillQueue) {
        _pillQueue.delete(id)
        if (onGrid.has(id)) chunk.push(id)
        if (chunk.length === MAPS_CHUNK) break
      }
      if (!chunk.length) continue
      let maps
      try {
        maps = await api.getSuggestionMaps(chunk)
      } catch (err) {
        log.warn('suggestion_maps_failed', { n: chunk.length, error: err })
        continue
      }
      applySuggestionMaps(chunk, maps)
    }
  } finally {
    _pillBusy = false
  }
  maybeShowSuggestTip()   // suggestions can arrive after the grid was drawn
}

// The read suggestions go into every in-memory copy of each item, changed in place so the
// card's own handlers see them too (answers, the next question and resizes read them),
// and each card asks its question again
function applySuggestionMaps(ids, maps) {
  if (!maps || typeof maps !== 'object') return
  const cards  = cardMap()   // looked up again: the grid may have re-rendered while awaiting
  const copies = itemIndexes()
  for (const id of ids) {
    const m = maps[id]
    if (!m || typeof m !== 'object') continue   // not in the library any more
    const fields = { auto_tag_confidence: m.conf ?? null }
    if ('model' in m) fields.auto_tag_model = m.model ?? null
    let item = null
    for (const index of copies) {
      const copy = index.get(id)
      if (copy) { Object.assign(copy, fields); item ??= copy }
    }
    const card = cards.get(id)
    if (card && item) syncCardRow(card, item)
  }
  scheduleFit()
}

// id → card on the grid (the real one, not a blurred free-plan teaser copy of it)
function cardMap() {
  const m = new Map()
  for (const c of allCards()) {
    if (!m.has(c.dataset.id) || m.get(c.dataset.id).classList.contains('free-teaser-card')) m.set(c.dataset.id, c)
  }
  return m
}

// id → item, for each in-memory list a card's item can come from: what's rendered, the
// relayout cache and the free-plan teaser (each list once; itemForCard's order)
function itemIndexes() {
  const lists = new Set([renderedItems, _lastView?.visibleItems, _lastView?.teaserItems].filter(Array.isArray))
  return [...lists].map(list => new Map(list.map(r => [r.id, r])))
}

function checkEmpty() {
  const scrollEl = container?.querySelector('#grid-scroll')
  if (scrollEl && allCards().length === 0) render([])
}

// ─── A new picture file for one item (crop Save, Restore original) ──
// The item's new fields go into every in-memory copy, and each of its cards (teaser
// copies too) takes the new file, shape and main colour in place. The new file has a new
// name, so the webview can't show a cached old picture. The Upscaled copy went with the
// old file, so its badge goes; the card's question is the new one (the lens scores of the
// old framing were dropped). No animation: it's a resize, behind the player.
function refreshCardFile(insp) {
  if (!insp?.id) return
  const fields = { ...insp }
  if (fields.collection_names == null) delete fields.collection_names   // get_inspiration leaves it out
  let item = null
  for (const index of itemIndexes()) {
    const copy = index.get(insp.id)
    if (copy) { Object.assign(copy, fields); item ??= copy }
  }
  item ??= insp
  for (const card of allCards()) {
    if (card.dataset.id !== insp.id) continue
    const media = card.querySelector('.card-media')
    if (!media) continue
    media.style.aspectRatio = String(item.aspect_ratio > 0 ? item.aspect_ratio : 1)
    media.style.backgroundColor = placeholderColor(item.palette) ?? ''
    const img = media.querySelector('img')
    if (img) img.src = itemSrc(item)
    media.querySelector('.card-enh-badge')?.remove()
    syncCardRow(card, item)
  }
  scheduleFit()
}

// ─── Helpers ─────────────────────────────────────────────────────
function updateCardTitle(inspiration) {
  const idx = renderedItems.findIndex(i => i.id === inspiration.id)
  if (idx !== -1) renderedItems[idx] = { ...renderedItems[idx], ...inspiration }
  _lastViewPatch(inspiration)

  const card = queryCard(inspiration.id)
  if (card) {
    const newTitle = displayTitle(inspiration)
    let t = card.querySelector('.card-title')
    if (newTitle && !t) {
      // Card had no title (e.g. was a UUID filename) — create one at the top of the caption.
      t = document.createElement('div')
      t.className = 'card-title'
      card.querySelector('.card-caption')?.prepend(t)
    }
    if (t) {
      if (newTitle) t.textContent = newTitle
      else t.remove()   // edited back to a junk/empty title → hide it
    }
  }

  const shelfCard = container?.querySelector(`#grid-scroll .short-form-shelf [data-id="${inspiration.id}"]`)
  if (shelfCard) {
    const t = shelfCard.querySelector('.shelf-card-title')
    if (t) t.textContent = inspiration.title ?? ''
  }
}

function updateCardCollectionPill(cardEl, collections, memberSet) {
  if (!cardEl) return
  const existing = cardEl.querySelector('.card-label--collection')
  const names    = collections.filter(c => memberSet.has(c.id)).map(c => c.name)
  const label    = names.length === 0 ? null
    : names.length > 1 ? `${names[0]} +${names.length - 1}`
    : names[0]
  if (!label) { existing?.remove(); return }
  const folderIcon = `<span class="icon icon-12" style="mask-image:url('/icons/folder.svg');-webkit-mask-image:url('/icons/folder.svg')" aria-hidden="true"></span>`
  if (existing) {
    existing.innerHTML = `${folderIcon}${escHtml(label)}`
  } else {
    const pill = document.createElement('span')
    pill.className = 'card-label card-label--collection'
    pill.innerHTML = `${folderIcon}${escHtml(label)}`
    cardEl.querySelector('.card-meta')?.appendChild(pill)
  }
}

function escHtml(str) {
  if (!str) return ''
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// Seek to 10% of duration (max 5 s) so cards don't show a solid intro frame.
// Stored on the element so mouseleave can restore the thumbnail position.
function seekToThumbnailFrame(vid) {
  vid.addEventListener('loadedmetadata', () => {
    const t = vid.duration > 0 ? Math.min(vid.duration * 0.1, 5) : 0
    vid._thumbTime = t
    vid.currentTime = t
  }, { once: true })
}

function formatDuration(secs) {
  const s = Math.round(secs)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
  return `${m}:${String(ss).padStart(2,'0')}`
}

// ─── Palette extraction ───────────────────────────────────────────
async function extractAndSavePalette(item) {
  try {
    const colors = await api.extractPalette(item.id, item.stored_path)
    if (colors.length) item.palette = JSON.stringify(colors)
  } catch (err) {
    console.error('[grid] palette extraction failed:', err)
  }
}
