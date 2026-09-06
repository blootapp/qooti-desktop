import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { open as openDetail } from './card-detail.js'
import { isOpen as isImporterOpen } from './importer.js'
import { getTagLabel } from './auto-tag.js'
import { showPrompt } from './dialog.js'
import { t } from './i18n.js'
import { getSetting } from './settings.js'
import { makeLogger } from './logger.js'

const log = makeLogger('Grid')

const FREE_ITEM_LIMIT  = 200
const FREE_ITEM_TEASER = 40

const IS_TAURI = '__TAURI_INTERNALS__' in window

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

// ─── State ───────────────────────────────────────────────────────
let container       = null
let gridEl          = null   // first masonry section (kept for compat)
let gridEls         = []     // all masonry sections, created dynamically each render
let currentColCount = 4
let _resizeObserver = null
let _resizeTimer    = null
let importing       = false
let renderedItems   = []

let _reloadGen = 0        // incremented on every reload; stale async callbacks bail out when gen differs
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
  sort:           null,
  page:  0,
  limit: 100,
}

// ─── Init ────────────────────────────────────────────────────────
export function init(el, _settings) {
  container = el
  renderShell()
  loadFilters()
  bindDragDrop()

  store.on(events.GRID_RELOAD,       ()           => reload())
  store.on(events.GRID_ITEM_ADDED,   ()           => reload())
  store.on(events.GRID_ITEM_DELETED, ({ id })          => { removeCard(id); checkEmpty() })
  store.on(events.GRID_ITEM_UPDATED, ({ inspiration }) => updateCardTitle(inspiration))
  store.on(events.TAG_CREATED,       ()           => refreshTagChips())
  store.on(events.TAG_DELETED,       ()           => refreshTagChips())
  store.on(events.FILES_DROPPED, ({ paths }) => { if (!isImporterOpen()) importPaths(paths) })
  store.on(events.SEARCH_QUERY_CHANGED, ({ query }) => {
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
  store.on(events.COLLECTION_SELECTED, ({ id, name }) => {
    enterCollectionMode(id, name ?? id)
  })
  store.on(events.COLLECTION_DELETED, () => {
    if (filter.collectionId) exitCollectionMode(false)
    else reload()
  })
  store.on(events.NAV_CHANGE, ({ view }) => {
    if (view !== 'grid' && filter.collectionId) exitCollectionMode(false)
  })
  store.on(events.AUTO_TAG_BATCH_DONE, ({ ids }) => refreshCardPills(ids))
  store.on(events.UPDATE_AVAILABLE, (info) => {
    _pendingUpdate = info
    log.info('update_available', { version: info?.version })
    renderUpdateBar()
  })
  // Re-render the (imperatively built) update bar text when the language changes.
  document.addEventListener('i18n:changed', () => renderUpdateBar())

  // Propagate dominant collection tags to untagged items once on startup.
  // No reload needed — the auto-tagger picks up the queued items and
  // emits AUTO_TAG_BATCH_DONE → refreshCardPills() when done.
  api.applyCollectionTagSuggestions().catch(() => {})

  reload()
}

// ─── Collection mode ─────────────────────────────────────────────
function enterCollectionMode(id, name) {
  filter.collectionId = id
  filter.tagIds = []
  filter.page   = 0

  const topbar     = document.getElementById('collection-topbar')
  const nameEl     = document.getElementById('collection-topbar-name')
  const searchWrap = document.querySelector('.top-bar-search-wrap')
  const chipsBar   = container?.querySelector('#filter-chips-bar')

  if (nameEl) nameEl.textContent = name
  if (topbar) topbar.hidden = false
  if (searchWrap) searchWrap.hidden = true
  if (chipsBar) chipsBar.hidden = true
  renderUpdateBar()  // hides the update bar while in collection mode

  // Swap left bar
  document.getElementById('top-bar-left').hidden = true
  document.getElementById('col-left-nav').hidden = false

  // Swap right bar
  document.getElementById('top-bar-right').hidden = true
  document.getElementById('col-right-nav').hidden = false

  // Wire nav buttons (clone to clear previous listeners)
  function rewire(id, handler) {
    const el = document.getElementById(id)
    if (!el) return
    const fresh = el.cloneNode(true)
    el.replaceWith(fresh)
    fresh.addEventListener('click', handler)
  }

  rewire('col-nav-home',        () => exitCollectionMode(false))
  rewire('col-nav-collections', () => exitCollectionMode(true))
  rewire('col-nav-export', async () => {
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
  })

  reload()
}

function exitCollectionMode(navigateToCollections) {
  filter.collectionId = null
  filter.tagIds = []
  filter.page   = 0

  const topbar     = document.getElementById('collection-topbar')
  const searchWrap = document.querySelector('.top-bar-search-wrap')
  const chipsBar   = container?.querySelector('#filter-chips-bar')

  if (topbar) topbar.hidden = true
  if (searchWrap) searchWrap.hidden = false
  if (chipsBar) chipsBar.hidden = false
  renderUpdateBar()  // restore the update bar (if a version is pending)

  document.getElementById('top-bar-left').hidden = false
  document.getElementById('col-left-nav').hidden = true
  document.getElementById('top-bar-right').hidden = false
  document.getElementById('col-right-nav').hidden = true

  if (navigateToCollections) {
    store.emit(events.NAVIGATE, { view: 'collections' })
  } else {
    reload()
  }
}

// ─── Shell ───────────────────────────────────────────────────────
function renderShell() {
  container.innerHTML = `
    <div class="filter-chips-bar" id="filter-chips-bar">
      <button class="chip active" data-filter="all"><span class="icon icon-14" style="mask-image:url('/icons/shuffle.svg');-webkit-mask-image:url('/icons/shuffle.svg')" aria-hidden="true"></span>qootify</button>
      <button class="chip" data-filter="recent" data-i18n="filter.recent">${t('filter.recent')}</button>
    </div>

    <div class="update-bar" id="update-bar" hidden>
      ${I('download-simple', 16)}
      <span class="update-bar-text" id="update-bar-text"></span>
      <button class="update-bar-btn" id="update-bar-btn"></button>
      <button class="update-bar-dismiss" id="update-bar-dismiss" aria-label="">${I('x', 12)}</button>
    </div>

    <div class="grid-scroll" id="grid-scroll"></div>

    <div class="drop-overlay hidden" id="drop-overlay">
      <div class="drop-overlay-box">
        ${I('upload-simple', 28)}
        <span class="drop-overlay-label" data-i18n="grid.drop">${t('grid.drop')}</span>
      </div>
    </div>
  `

  gridEl  = null
  gridEls = []

  if (_resizeObserver) _resizeObserver.disconnect()
  const scrollEl = container.querySelector('#grid-scroll')
  _resizeObserver = new ResizeObserver(onGridResize)
  _resizeObserver.observe(scrollEl)

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
// Clicking Update downloads + installs it, then the app restarts.
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
    btn.textContent = t('update.installing')
    btn.disabled    = true
    log.info('update_install_started', { version })
    try {
      await api.applyUpdate()   // backend downloads, installs, then restarts the app
    } catch (err) {
      log.warn('update_install_failed', { error: String(err) })
      btn.textContent = t('update.failed')
      btn.disabled    = false
      store.emit(events.SYSTEM_TOAST, {
        type: 'error',
        message: t('update.toast_fail', { error: String(err) }),
        duration: 8000,
      })
    }
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

  bar.querySelector('[data-filter="all"]').addEventListener('click', e => {
    filter.collectionId = null; filter.tagIds = []; filter.sort = null; filter.page = 0
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

    for (const tag of tags) {
      if ((tag.usage_count ?? 0) > 0) bar.appendChild(makeTagChip(tag))
    }
  } catch (err) {
    console.error('[grid] loadFilters failed:', err)
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
  const chip = makeChip(tag.name, () => {
    filter.collectionId = null; filter.tagIds = [tag.id]; filter.page = 0
    setActiveChip(chip); reload()
  })
  chip.dataset.tagId = tag.id
  chip.classList.add('chip--tag')
  return chip
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
function bindDragDrop() {
  const overlay = container.querySelector('#drop-overlay')

  const showOverlay = () => overlay.classList.remove('hidden')
  const hideOverlay = () => overlay.classList.add('hidden')

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

// ─── Import ───────────────────────────────────────────────────────
async function importPaths(paths) {
  if (!paths.length || importing) return
  importing = true

  const total    = paths.length
  const showRing = total > 1
  const task     = showRing
    ? window.__progressRing?.startTask('import', { label: 'Importing' })
    : null

  let anyImported = false

  try {
    for (let i = 0; i < total; i++) {
      task?.update(i / total)
      try {
        const result = await api.importFiles([paths[i]])
        if (result.imported.length) anyImported = true
      } catch (err) {
        console.error('[grid] import error:', paths[i], err)
      }
    }

    if (anyImported) { sfx.success(); reload() }
    task?.finish()
  } catch (err) {
    console.error('[grid] import failed:', err)
    task?.fail('Import failed')
  } finally {
    importing = false
  }
}

// ─── Data ────────────────────────────────────────────────────────
async function reload() {
  const gen = ++_reloadGen
  try {
    const isFree = getSetting('plan') === 'free' || !getSetting('plan')
    const colCount = calcColCount()
    const teaserSlots = colCount * 3

    const [items, planInfo] = await Promise.all([
      api.listInspirations({
        collection_id: filter.collectionId ?? undefined,
        tag_ids: filter.tagIds.length ? filter.tagIds : undefined,
        query:   filter.query ?? undefined,
        color_filter:     filter.color ?? undefined,
        color_tolerance:  filter.color ? filter.colorTolerance : undefined,
        // Free plan always fetches by recency so the visible pool is always the
        // 200 most recently imported items. Qootify shuffle happens client-side.
        sort:    isFree ? 'recent' : (filter.sort ?? undefined),
        page:    filter.page,
        limit:   isFree ? (FREE_ITEM_LIMIT + FREE_ITEM_TEASER) : filter.limit,
      }),
      isFree ? api.getFreePlanInfo() : Promise.resolve(null),
    ])

    if (gen !== _reloadGen) return  // superseded by a newer reload

    // Snap so that REGULAR (non-shelf) items fill complete rows.
    // Pre-count regular items in the response so we can snap to a multiple of
    // colCount that doesn't exceed what actually exists — otherwise the last
    // grid segment gets an un-alignable remainder and orphan cards appear.
    let totalSnap
    if (isFree) {
      const regularInResponse = items.filter(i => !isShortForm(i)).length
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
    // Qootify: pool is the fixed set of most-recent items; shuffle their order client-side
    if (isFree && filter.sort === null) {
      visibleItems = visibleItems.slice().sort(() => Math.random() - 0.5)
    }

    const teaserItems  = (isFree && items.length > totalSnap)
      ? items.slice(totalSnap, totalSnap + teaserSlots)
      : []
    const extraCount = planInfo ? Math.max(0, planInfo.item_total - totalSnap) : 0

    render(visibleItems, colCount, isFree)

    // Await recommendations first so teaser is always the final element —
    // nothing gets appended after it, preventing the banner from disappearing
    // when a stale reco resolve races against a fresh render.
    let recoExtra = []
    if (!filter.collectionId && !filter.query && !filter.color && !filter.tagIds.length) {
      recoExtra = await loadRecommendations(visibleItems, gen) ?? []
    } else {
      container?.querySelector('#grid-scroll')?.querySelectorAll('.reco-grid').forEach(s => s.remove())
    }

    if (gen !== _reloadGen) return  // superseded during reco load

    const showTeaser = teaserItems.length > 0 && planInfo && planInfo.item_total > FREE_ITEM_LIMIT
    if (showTeaser) renderFreeTeaser(teaserItems, extraCount, colCount)

    // Cache the fully-resolved view so a resize can re-lay-out from it without
    // re-querying or re-shuffling. Order is preserved exactly as rendered.
    _lastView = { visibleItems, recoExtra, isFree, teaserItems, extraCount, showTeaser }
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
  const { visibleItems, recoExtra, isFree, teaserItems, extraCount, showTeaser } = _lastView
  _animateCards = false
  try {
    render(visibleItems, colCount, isFree)
    if (recoExtra.length) renderReco(recoExtra, visibleItems)
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
  _lastView.recoExtra    = _lastView.recoExtra.filter(i => i.id !== id)
}
function _lastViewPatch(insp) {
  if (!_lastView) return
  for (const arr of [_lastView.visibleItems, _lastView.recoExtra]) {
    const i = arr.findIndex(x => x.id === insp.id)
    if (i !== -1) arr[i] = { ...arr[i], ...insp }
  }
}

function renderFreeTeaser(teaserItems, extraCount, colCount) {
  const scrollEl = container?.querySelector('#grid-scroll')
  if (!scrollEl) return

  const openUpgrade = () => api.openUrl('https://account.bloot.app/')

  const wrap = document.createElement('div')
  wrap.className = 'free-teaser-wrap'

  // Real cards rendered blurred — fills exactly 2 complete rows
  const teaserGrid = document.createElement('div')
  teaserGrid.className = 'inspiration-grid free-teaser-grid'

  // Prefer items that already have a thumbnail — videos without one render blank
  // until the video file loads, making the blurred teaser look broken.
  const withThumbs = teaserItems.filter(i => i.thumbnail_path)
  const teaserSource = withThumbs.length >= 3 ? withThumbs : teaserItems

  const needed = colCount * 3
  const padded = Array.from({ length: needed }, (_, i) => teaserSource[i % teaserSource.length])
  padded.forEach(item => {
    const card = makeCard(item, -1)
    card.classList.add('free-teaser-card')
    teaserGrid.appendChild(card)
  })
  wrap.appendChild(teaserGrid)

  // Centered overlay with frosted-glass banner
  const overlay = document.createElement('div')
  overlay.className = 'free-teaser-overlay'
  overlay.innerHTML = `
    <div class="free-teaser-banner">
      <div class="free-teaser-banner__lock">${I('lock', 20)}</div>
      <p class="free-teaser-banner__count">${extraCount} more items in your vault</p>
      <p class="free-teaser-banner__sub">Free plan shows your 200 most recent items.<br>Upgrade to Pro for unlimited access.</p>
      <button class="free-teaser-banner__cta">Upgrade to Pro ${I('arrow-right', 14)}</button>
    </div>
  `
  overlay.querySelector('.free-teaser-banner__cta').addEventListener('click', openUpgrade)
  wrap.appendChild(overlay)

  scrollEl.appendChild(wrap)

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

  scrollEl.innerHTML = ''
  gridEls = []

  if (!items.length) {
    const grid = _makeGridEl()
    grid.innerHTML = `
      <div class="empty-state">
        ${I('image', 32)}
        <span class="empty-state-title">Nothing here yet</span>
        <p class="empty-state-body">Add your first inspiration — drag &amp; drop files,<br>or paste a link to download.</p>
        <button class="empty-state-btn" id="empty-add-btn">${I('plus', 16)}Add inspiration</button>
      </div>
    `
    grid.querySelector('#empty-add-btn')?.addEventListener('click', () => store.emit(events.IMPORT_REQUESTED))
    scrollEl.appendChild(grid)
    gridEl = grid
    return
  }

  const shortForm = items.filter(isShortForm)
  const regular   = items.filter(i => !isShortForm(i))
  const sfChunks  = chunkShortForm(shortForm)

  // Use the column count measured before the DOM was cleared — avoids the
  // scrollbar-disappears-on-clear discrepancy that causes off-by-one column counts.
  currentColCount   = Math.max(1, colCount ?? calcColCount())
  const aboveFold   = currentColCount * 2
  const betweenRows = currentColCount * 3

  // Slice regular items into segments interleaved between shelves:
  // segment[0] = aboveFold items before first shelf
  // segment[1..N-1] = betweenRows items between each pair of shelves
  // segment[N] = all remaining items after last shelf
  const segments = []
  if (!sfChunks.length) {
    segments.push(regular)
  } else {
    let rem = [...regular]
    segments.push(rem.splice(0, aboveFold))
    for (let i = 1; i < sfChunks.length; i++) segments.push(rem.splice(0, betweenRows))
    segments.push(rem)
  }

  // Guarantee no orphan card in the last row: trim any partial last row from
  // the final grid segment. This is the definitive fix — regardless of any
  // upstream count mismatch, the last segment always ends on a complete row.
  if (trimOrphans && currentColCount > 1 && segments.length > 0) {
    const last = segments[segments.length - 1]
    const orphans = last.length % currentColCount
    if (orphans > 0) last.splice(last.length - orphans, orphans)
  }

  // Map every item to its index in `items` once (O(n)) so per-card lookups
  // below are O(1) instead of items.indexOf() (which made rendering O(n²)).
  const indexOfItem = new Map(items.map((item, i) => [item, i]))

  let _dealIdx = 0
  for (let i = 0; i < segments.length; i++) {
    const grid = _makeGridEl(i === 0 ? 'inspiration-grid' : null)
    segments[i].forEach(item => {
      const card = makeCard(item, indexOfItem.get(item))
      if (_animateCards) {
        card.classList.add('deal-in')
        card.style.animationDelay = `${Math.min(_dealIdx++, 20) * 22}ms`
      }
      grid.appendChild(card)
    })
    scrollEl.appendChild(grid)
    if (i < sfChunks.length) scrollEl.appendChild(makeShelf(sfChunks[i], items, indexOfItem))
  }

  gridEl = gridEls[0] ?? null
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
  title.textContent = 'Short-form'

  const count = document.createElement('span')
  count.className = 'shelf-count'
  count.textContent = `${shortItems.length} video${shortItems.length !== 1 ? 's' : ''}`

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
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
    img.addEventListener('load',  () => img.classList.add('loaded'), { once: true })
    img.addEventListener('error', () => img.classList.add('loaded'), { once: true })
    media.appendChild(img)

    const vid = document.createElement('video')
    vid.src         = videoSrc(item)
    vid.muted       = true
    vid.preload     = 'none'
    vid.playsInline = true
    vid.style.cssText = 'display:none;width:100%;height:100%;object-fit:cover'
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

  card.addEventListener('click', () => openDetail(item, renderedItems, idx))
  card.addEventListener('contextmenu', e => {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, item, idx)
  })

  card.append(media, titleEl)
  return card
}

function makeCard(item, idx) {
  const card = document.createElement('div')
  card.className = 'card'
  card.dataset.id   = item.id
  card.dataset.type = item.type

  // ── Media ──
  const media = document.createElement('div')
  media.className = 'card-media'

  if (item.type === 'video') {
    if (item.thumbnail_path) {
      // Stored thumbnail → instant <img>; <video> loaded only on hover
      const img = document.createElement('img')
      img.loading   = 'lazy'
      img.decoding  = 'async'
      img.draggable = false
      img.alt = item.title ?? ''
      img.src = itemSrc(item)
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
      img.addEventListener('load',  () => img.classList.add('loaded'), { once: true })
      img.addEventListener('error', () => img.classList.add('loaded'), { once: true })
      media.appendChild(img)

      const vid = document.createElement('video')
      vid.src         = videoSrc(item)
      vid.muted       = true
      vid.preload     = 'none'
      vid.playsInline = true
      vid.style.cssText = 'display:none;width:100%;height:100%;object-fit:cover'
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
      // No thumbnail yet — seek video to avoid solid intro frame; generate thumbnail in background
      const vid = document.createElement('video')
      vid.src         = videoSrc(item)
      vid.muted       = true
      vid.preload     = 'metadata'
      vid.playsInline = true
      vid.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
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
    img.addEventListener('load', () => {
      img.classList.add('loaded')
      if (IS_TAURI && !item.palette) extractAndSavePalette(item)
    }, { once: true })
    img.addEventListener('error', () => img.classList.add('loaded'), { once: true })
    media.appendChild(img)
  }

  // ── Hover overlay (delete + model pills only — no title) ──
  const overlay = document.createElement('div')
  overlay.className = 'card-hover-overlay'
  overlay.innerHTML = `
    <div class="card-overlay-top">
      <button class="card-action-btn" data-action="copy" title="${t('card.save_copy')}">${I('copy', 14)}</button>
    </div>
  `
  overlay.querySelector('[data-action="copy"]').addEventListener('click', e => {
    e.stopPropagation()
    handleCopy(item, e.currentTarget)
  })

  const suggestionsEl = makeSuggestions(item)
  if (suggestionsEl) media.appendChild(suggestionsEl)

  media.appendChild(overlay)

  // ── Title revealed below the image on hover ──
  const titleEl = document.createElement('div')
  titleEl.className = 'card-title'
  titleEl.textContent = item.title ?? ''

  // ── Pill labels (platform + collection) ──
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

  // Open detail modal on click (not on action buttons or suggestion rows)
  card.addEventListener('click', e => {
    if (e.target.closest('[data-action]') || e.target.closest('.suggestion-item')) return
    openDetail(item, renderedItems, idx)
  })

  card.addEventListener('contextmenu', e => {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, item, idx)
  })

  card.appendChild(media)
  card.appendChild(titleEl)
  card.appendChild(meta)
  return card
}

// ─── Tag suggestion question rows ────────────────────────────────────────────

function makeSuggestions(item) {
  const autoTags = parseAutoTags(item.auto_tag_confidence)
  if (!autoTags.length) return null
  const wrap = document.createElement('div')
  wrap.className = 'card-suggestions'
  for (const { tag } of autoTags) {
    wrap.appendChild(makeSuggestionRow(item, tag))
  }
  return wrap
}

function makeSuggestionRow(item, canonicalTag) {
  const displayName = getTagLabel(canonicalTag)
  const row = document.createElement('div')
  row.className = 'suggestion-item'

  const sparkle = document.createElement('span')
  sparkle.className = 'icon icon-14 suggestion-sparkle'
  sparkle.style.cssText = `mask-image:url('/icons/sparkle.svg');-webkit-mask-image:url('/icons/sparkle.svg')`
  sparkle.setAttribute('aria-hidden', 'true')

  const q = document.createElement('span')
  q.className = 'suggestion-q'
  q.innerHTML = t('suggest.question', { name: `<strong>${displayName}</strong>` })

  const yes = document.createElement('button')
  yes.className = 'suggestion-yes'
  yes.title = t('suggest.yes_title', { name: displayName })
  yes.textContent = t('suggest.yes')

  const no = document.createElement('button')
  no.className = 'suggestion-no'
  no.title = t('suggest.not_this')
  no.innerHTML = I('x', 14)

  yes.addEventListener('click', e => { e.stopPropagation(); applySuggestion(item, canonicalTag, displayName, row) })
  no.addEventListener('click',  e => { e.stopPropagation(); dismissSuggestion(item, canonicalTag, row) })

  row.append(sparkle, q, yes, no)
  return row
}

async function applySuggestion(item, canonicalTag, displayName, row) {
  row.classList.add('suggestion-saving')
  try {
    const existing = await api.listTags()
    let tag = existing.find(t => t.name.toLowerCase() === displayName.toLowerCase())
    const isNew = !tag
    if (!tag) tag = await api.createTag(displayName, 'model')
    await api.tagInspiration(item.id, tag.id)
    log.info('suggestion_accepted', { id: item.id, tag: displayName, model: item.auto_tag_model ?? '—', new_tag: isNew })
    store.emit(events.TAG_CREATED, { tag })
    removeSuggestionRow(item, canonicalTag, row)
  } catch (err) {
    log.error('suggestion_accept_failed', { id: item.id, tag: displayName, error: err })
    row.classList.remove('suggestion-saving')
  }
}

function dismissSuggestion(item, canonicalTag, row) {
  log.info('suggestion_dismissed', { id: item.id, tag: getTagLabel(canonicalTag) })
  removeSuggestionRow(item, canonicalTag, row)
}

function removeSuggestionRow(item, tagId, row) {
  // Remove from in-memory confidence and persist to DB
  try {
    const conf = JSON.parse(item.auto_tag_confidence || '{}')
    delete conf[tagId]
    item.auto_tag_confidence = JSON.stringify(conf)
    api.finalizeAutoTagResult(item.id, item.auto_tag_confidence, item.auto_tag_model ?? null, 'done')
      .catch(e => console.error('[grid] update confidence failed:', e))
  } catch { /* ignore */ }

  row.classList.add('suggestion-leaving')
  setTimeout(() => {
    const wrap = row.parentElement
    row.remove()
    if (wrap && !wrap.querySelector('.suggestion-item')) wrap.remove()
  }, 180)
}

// ─── Parse auto_tag_confidence JSON → sorted array ───────────
function parseAutoTags(json) {
  if (!json) return []
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json
    return Object.entries(obj)
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)   // show top 3 suggestions
  } catch {
    return []
  }
}

function itemSrc(item) {
  const path = item.thumbnail_path ?? item.stored_path
  return IS_TAURI ? convertFileSrc(path) : path
}

function videoSrc(item) {
  return IS_TAURI ? convertFileSrc(item.stored_path) : item.stored_path
}

// ─── Recommendation shelves ──────────────────────────────────────

async function loadRecommendations(allItems, gen = _reloadGen) {
  const scrollEl = container?.querySelector('#grid-scroll')
  if (!scrollEl) return []

  scrollEl.querySelectorAll('.reco-grid').forEach(s => s.remove())

  try {
    const [rediscover, becauseYou, haventSeen] = await Promise.all([
      api.listRediscover(20),
      api.listBecauseYouViewed(20),
      api.listHaventSeen(20),
    ])

    if (gen !== _reloadGen) return []  // superseded while awaiting reco APIs

    // Merge all three lists, skip anything already visible in the main grid
    const seen = new Set(allItems.map(i => i.id))
    const extra = []
    for (const item of [...rediscover, ...becauseYou, ...haventSeen]) {
      if (!seen.has(item.id)) { seen.add(item.id); extra.push(item) }
    }
    if (!extra.length) return []

    renderReco(extra, allItems)
    return extra
  } catch (err) {
    console.error('[grid] loadRecommendations failed:', err)
    return []
  }
}

// Build and append the recommendation grid from an already-resolved `extra`
// list. Split out of loadRecommendations so relayout() can re-render reco cards
// on resize without re-fetching. Respects the _animateCards flag.
function renderReco(extra, allItems) {
  const scrollEl = container?.querySelector('#grid-scroll')
  if (!scrollEl) return

  const grid = document.createElement('div')
  grid.className = 'inspiration-grid reco-grid'
  gridEls.push(grid)

  // Combined list so card-detail arrow navigation covers reco cards too
  const combined = [...allItems, ...extra]
  let _dealIdx = 0
  extra.forEach((item, i) => {
    const card = makeCard(item, allItems.length + i)
    if (_animateCards) {
      card.classList.add('deal-in')
      card.style.animationDelay = `${Math.min(_dealIdx++, 20) * 22}ms`
    }
    grid.appendChild(card)
  })
  renderedItems = combined

  scrollEl.appendChild(grid)
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
  // 12px = .inspiration-grid padding (6px × 2 sides). scrollbar-gutter:stable
  // keeps clientWidth constant regardless of overflow, so this is reliable.
  const availW = Math.max(0, scrollEl.clientWidth - 12)
  const cols = Math.max(1, Math.floor((availW + gap) / (minW + gap)))

  // Write back to CSS so .inspiration-grid uses exactly this count —
  // eliminates any possibility of CSS auto-fill resolving a different value.
  document.documentElement.style.setProperty('--grid-cols', cols)
  return cols
}

function onGridResize() {
  clearTimeout(_resizeTimer)
  _resizeTimer = setTimeout(() => {
    const newCount = calcColCount()
    // Re-lay-out from cache (no DB round-trip, no re-shuffle) rather than reload.
    if (newCount !== currentColCount) relayout()
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

function showContextMenu(x, y, item, idx) {
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
    btn.innerHTML = `${I(icon, 14)}<span>${label}</span>`
    btn.addEventListener('click', () => { closeCtxMenu(); onClick() })
    menu.appendChild(btn)
  }

  addBtn('pencil-simple', t('action.edit'),   false, () => openDetail(item, renderedItems, idx))
  addBtn('copy',          t('action.copy'),   false, () => handleCopy(item, null))
  if (item.source_url) {
    addBtn('arrow-square-out', t('ctx.source'), false, () => api.openUrl(item.source_url))
  }

  // "Collect" row — submenu populates async, opened via JS mouseenter (not CSS :hover)
  const colRow = document.createElement('div')
  colRow.className = 'ctx-item ctx-item-has-sub'
  colRow.tabIndex = 0
  colRow.innerHTML = `${I('plus', 14)}<span>${t('ctx.collect')}</span><span class="ctx-sub-arrow">${I('caret-up', 14)}</span>`

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
  const openSub  = () => { clearTimeout(_subCloseTimer); submenu.style.display = 'flex' }
  const closeSub = () => { _subCloseTimer = setTimeout(() => { submenu.style.display = 'none' }, 80) }
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
        <span class="ctx-col-icon ${inCol ? 'ctx-col-icon--in' : ''}">${I(inCol ? 'check-circle' : 'plus-circle', 14)}</span>
        <span>${escHtml(col.name)}</span>
        ${col.locked ? `<span class="ctx-col-lock">${I('lock', 11)}</span>` : ''}
      `
      btn.addEventListener('click', () => {
        if (col.locked) {
          store.emit(events.SYSTEM_TOAST, {
            type: 'info',
            message: t('collection.readonly_free'),
            duration: 4000,
          })
          return
        }
        const wasMember = btn.dataset.member === '1'
        const iconEl    = btn.querySelector('.ctx-col-icon')
        const nowMember = !wasMember
        btn.dataset.member = nowMember ? '1' : '0'
        iconEl.className = 'ctx-col-icon' + (nowMember ? ' ctx-col-icon--in' : '')
        iconEl.innerHTML = I(nowMember ? 'check-circle' : 'plus-circle', 14)
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
    createBtn.innerHTML = `${I('plus', 14)}<span>${t('collection.new_title')}</span>`
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

  const divider = document.createElement('div')
  divider.className = 'ctx-divider'
  menu.appendChild(divider)

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
    if (top + menuH > window.innerHeight - gap)
      top = cardRect.top - menuH - gap

    menu.style.left = `${left}px`
    menu.style.top  = `${top}px`
  } else {
    // Fallback: position near cursor, clamped to viewport
    const menuRect = menu.getBoundingClientRect()
    if (x + menuRect.width  > window.innerWidth)  menu.style.left = `${x - menuRect.width}px`
    if (y + menuRect.height > window.innerHeight) menu.style.top  = `${y - menuRect.height}px`
  }


  // Flip submenu right-to-left if the bar is near the right edge
  const barLeft = parseFloat(menu.style.left)
  if (barLeft + 175 > window.innerWidth - gap)
    submenu.classList.add('ctx-submenu--left')

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

  // Find and remove the card from whichever grid segment holds it
  let fromIdx = -1
  for (let i = 0; i < gridEls.length; i++) {
    const c = gridEls[i].querySelector(`.card[data-id="${id}"]`)
    if (c) { c.remove(); fromIdx = i; break }
  }

  // Cascade: pull the first card from each subsequent segment to fill
  // the empty slot left at the bottom of the segment where the deletion occurred.
  // This prevents a visual gap at segment boundaries (between shelves).
  if (fromIdx !== -1) {
    for (let i = fromIdx; i < gridEls.length - 1; i++) {
      const first = gridEls[i + 1].querySelector('.card')
      if (first) gridEls[i].appendChild(first)
    }
  }

  // Keep in-memory list in sync for detail-modal arrow navigation
  const pos = renderedItems.findIndex(item => item.id === id)
  if (pos !== -1) renderedItems.splice(pos, 1)
  _lastViewRemove(id)  // so a later resize relayout doesn't resurrect the card
}

async function refreshCardPills(ids) {
  // Only fetch items that are actually rendered right now.
  const targets = ids.filter(id => queryCard(id))
  if (!targets.length) return

  // Fetch all in parallel instead of one blocking round-trip per id.
  const items = await Promise.all(
    targets.map(id => api.getInspiration(id).catch(() => null))
  )

  items.forEach((item, i) => {
    if (!item) return
    const id = targets[i]
    // Re-query: the grid may have re-rendered while awaiting.
    const card = queryCard(id)
    if (!card) return

    // Sync in-memory item so removeSuggestionRow has fresh confidence
    const idx = renderedItems.findIndex(r => r.id === id)
    if (idx !== -1) renderedItems[idx] = item
    _lastViewPatch(item)

    card.querySelector('.card-suggestions')?.remove()

    const suggestionsEl = makeSuggestions(item)
    if (!suggestionsEl) return

    const media = card.querySelector('.card-media')
    const hoverOverlay = card.querySelector('.card-hover-overlay')
    media.insertBefore(suggestionsEl, hoverOverlay)
  })
}

function checkEmpty() {
  const scrollEl = container?.querySelector('#grid-scroll')
  if (scrollEl && allCards().length === 0) render([])
}

// ─── Helpers ─────────────────────────────────────────────────────
function updateCardTitle(inspiration) {
  const idx = renderedItems.findIndex(i => i.id === inspiration.id)
  if (idx !== -1) renderedItems[idx] = { ...renderedItems[idx], ...inspiration }
  _lastViewPatch(inspiration)

  const card = queryCard(inspiration.id)
  if (card) {
    const t = card.querySelector('.card-title')
    if (t) t.textContent = inspiration.title ?? ''
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
