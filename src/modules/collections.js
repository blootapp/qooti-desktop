import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { showPrompt, showConfirm } from './dialog.js'
import { makeLogger } from './logger.js'
import { t } from './i18n.js'
import { open as openDetail } from './card-detail.js'
import * as motion from './motion.js'
import { setPageBar } from './page-bar.js'

const log = makeLogger('Collections')

const IS_TAURI = '__TAURI_INTERNALS__' in window

let _saveDialog = null
async function getSaveDialog() {
  if (!IS_TAURI) return null
  if (!_saveDialog) ({ save: _saveDialog } = await import('@tauri-apps/plugin-dialog'))
  return _saveDialog
}

let container = null

export function init(el) {
  container = el
  store.on(events.COLLECTION_CREATED, () => reload())
  store.on(events.COLLECTION_UPDATED, () => reload())
  store.on(events.COLLECTION_DELETED, () => reload())
  store.on(events.NAV_CHANGE, ({ view }) => { if (view === 'collections') reload() })
  document.addEventListener('i18n:changed', () => { if (container?.childElementCount) reload() })
}

async function reload() {
  try {
    const cols = await api.listCollections()
    render(cols)
  } catch (err) {
    console.error('[collections] reload failed:', err)
  }
}

function render(cols) {
  if (!container) return

  // Top bar (guide D1): no search — "Collections" in the centre and New collection as the
  // page's action. With no collections yet the empty state owns the primary action, so
  // the bar's steps down to secondary.
  if (!container.hidden) {
    setPageBar({
      title: t('nav.collections'),
      action: { label: t('collection.new_title'), primary: cols.length > 0, onClick: () => promptCreate() },
    })
  }

  // Guide D1: collection cards with a dashed "New collection" card last, then everything
  // that isn't in a collection yet. The title lives in the top bar, so no page header.
  container.innerHTML = `
    <div class="collections-page${cols.length ? '' : ' is-empty'}">
      <div class="collections-grid" id="collections-grid"></div>
      <section class="uncollected" id="uncollected" hidden>
        <div class="section-head"><h2>${t('collections.uncollected')}</h2><span class="section-head-count" id="uncollected-count"></span></div>
        <div class="uncollected-grid" id="uncollected-grid"></div>
      </section>
    </div>
  `

  const grid = container.querySelector('#collections-grid')

  if (!cols.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-state-icon">${I('folder', 20)}</span>
        <span class="empty-state-title">${t('collections.empty.title')}</span>
        <p class="empty-state-body">${t('collections.empty.body')}</p>
        <button class="empty-state-btn" id="collections-new">${t('collection.new_title')}</button>
      </div>
    `
  } else {
    for (const col of cols) grid.appendChild(makeCard(col))
    const add = document.createElement('button')
    add.className = 'col-card-new'
    add.innerHTML = `${I('plus', 16)}<span>${t('collection.new_title')}</span>`
    add.addEventListener('click', () => promptCreate())
    grid.appendChild(add)
    renderUncollected()
  }

  container.querySelector('#collections-new')?.addEventListener('click', () => promptCreate())
}

// "Not in a collection" — the newest items that aren't filed anywhere yet.
const UNCOLLECTED_MAX = 200
async function renderUncollected() {
  const section = container.querySelector('#uncollected')
  const list    = container.querySelector('#uncollected-grid')
  let items = []
  try { items = await api.listInspirations({ uncollected: true, sort: 'recent', limit: UNCOLLECTED_MAX }) } catch { return }
  if (!items.length || !section?.isConnected) return
  const full = items.length >= UNCOLLECTED_MAX
  const setCount = () => {
    container.querySelector('#uncollected-count').textContent =
      t('collections.items_many', { n: full ? `${UNCOLLECTED_MAX}+` : items.length })
  }
  setCount()
  list.replaceChildren(...items.map(it => {
    const tile = document.createElement('button')
    tile.className = 'uncol-tile'
    const ar = it.aspect_ratio > 0 ? it.aspect_ratio : 1
    tile.style.aspectRatio = String(Math.min(2, Math.max(0.5, ar)))
    const src = toSrc(it.thumbnail_path || it.stored_path)
    tile.innerHTML = it.type === 'video' && !it.thumbnail_path
      ? `<video src="${escHtml(src)}#t=1" muted preload="metadata" playsinline></video>`
      : `<img src="${escHtml(src)}" alt="" loading="lazy" decoding="async" draggable="false" />`
    if (it.duration_secs != null) tile.insertAdjacentHTML('beforeend', `<span class="card-duration">${fmtDur(it.duration_secs)}</span>`)
    tile.addEventListener('click', () => { if (!_justDragged) openDetail(it, items, items.indexOf(it)) })
    // Filed into a collection by drag: it isn't "not in a collection" any more
    enableTileDrag(tile, it, () => {
      items.splice(items.indexOf(it), 1)
      setCount()
      motion.removeWithFlow(tile, () => { if (!items.length) section.hidden = true })
    })
    return tile
  }))
  section.hidden = false
}

// ─── Drag an item onto a collection ──────────────────────────────
// Hold a "Not in a collection" tile and drag it onto a collection card to file it
// there. Pointer-driven, not HTML5 drag-and-drop: the desktop window keeps native
// drag-and-drop for importing files from outside.
const DRAG_START_PX = 6
const AUTOSCROLL_EDGE = 80
let _justDragged = false        // swallows the click that follows a drop

function enableTileDrag(tile, item, onFiled) {
  tile.addEventListener('dragstart', e => e.preventDefault())
  tile.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    const sx = e.clientX, sy = e.clientY
    let drag = null

    const move = ev => {
      if (!drag) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START_PX) return
        drag = startDrag(tile)
      }
      drag.moveTo(ev.clientX, ev.clientY)
    }
    const end = ev => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('keydown', esc)
      if (!drag) return
      const target = drag.end()
      _justDragged = true
      setTimeout(() => { _justDragged = false }, 0)
      if (target && ev.type === 'pointerup') fileInto(target, item, onFiled)
    }
    const esc = ev => { if (ev.key === 'Escape') end({ type: 'cancel' }) }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('keydown', esc)
  })
}

function startDrag(tile) {
  const ghost = document.createElement('div')
  ghost.className = 'col-drag-ghost'
  const media = tile.querySelector('img, video')
  if (media) ghost.appendChild(media.cloneNode())
  ghost.style.aspectRatio = tile.style.aspectRatio
  document.body.appendChild(ghost)
  tile.classList.add('is-dragging')
  document.body.classList.add('is-dragging-item')

  const scroller = scrollParent(container)
  let x = 0, y = 0, target = null, raf = 0

  const hitTest = () => {
    const card = document.elementFromPoint(x, y)?.closest('.col-card') ?? null
    if (card === target) return
    target?.classList.remove('is-drop-target')
    target = card
    target?.classList.add('is-drop-target')
  }
  // Near the top/bottom edge, scroll so the collections stay reachable from far down the list
  const tick = () => {
    if (scroller) {
      const r = scroller.getBoundingClientRect()
      const dy = y < r.top + AUTOSCROLL_EDGE ? -(r.top + AUTOSCROLL_EDGE - y)
               : y > r.bottom - AUTOSCROLL_EDGE ? (y - (r.bottom - AUTOSCROLL_EDGE)) : 0
      if (dy) { scroller.scrollTop += Math.max(-24, Math.min(24, dy / 3)); hitTest() }
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    moveTo(nx, ny) {
      x = nx; y = ny
      ghost.style.transform = `translate(${x - ghost.offsetWidth / 2}px, ${y - ghost.offsetHeight / 2}px) rotate(-2deg)`
      hitTest()
    },
    end() {
      cancelAnimationFrame(raf)
      ghost.remove()
      tile.classList.remove('is-dragging')
      document.body.classList.remove('is-dragging-item')
      target?.classList.remove('is-drop-target')
      return target
    },
  }
}

async function fileInto(card, item, onFiled) {
  const col = _colByCard.get(card)
  if (!col) return
  if (col.locked) { showCollectionLockedModal(); return }
  try {
    await api.addToCollection(col.id, item.id)
    log.info('collection_added', { id: item.id, collection: col.name, via: 'drag' })
    sfx.success()
    onFiled()
    // Refresh just that card (count + cover) so the page doesn't jump
    const fresh = (await api.listCollections()).find(c => c.id === col.id)
    if (fresh && card.isConnected) {
      const next = makeCard(fresh)
      card.replaceWith(next)
      next.classList.add('just-filed')
      next.addEventListener('animationend', () => next.classList.remove('just-filed'), { once: true })
    }
  } catch (err) {
    log.error('collection_add_failed', { id: item.id, collection: col.name, error: err })
  }
}

function scrollParent(el) {
  for (let p = el; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return document.scrollingElement
}

function fmtDur(s) {
  const n = Math.max(0, Math.round(s || 0))
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

let _colCtxMenu      = null
let _colCtxListeners = null

function getColGrid() {
  return container?.querySelector('.collections-grid') ?? null
}

function closeColCtxMenu() {
  if (!_colCtxMenu) return
  _colCtxMenu.remove()
  _colCtxMenu = null
  if (_colCtxListeners) {
    document.removeEventListener('mousedown', _colCtxListeners.down)
    document.removeEventListener('keydown',   _colCtxListeners.key)
    window.removeEventListener('scroll',      _colCtxListeners.scroll, true)
    _colCtxListeners = null
  }
  const grid = getColGrid()
  grid?.querySelectorAll('.col-card.ctx-dimmed').forEach(c => c.classList.remove('ctx-dimmed'))
  grid?.querySelectorAll('.col-card.ctx-selected').forEach(c => c.classList.remove('ctx-selected'))
  setTimeout(() => grid?.classList.remove('ctx-open'), 320)
}

function showColCtxMenu(triggerCard, col) {
  closeColCtxMenu()

  const grid    = getColGrid()
  const cardRect = triggerCard.getBoundingClientRect()

  grid?.classList.add('ctx-open')
  grid?.querySelectorAll('.col-card').forEach(c => {
    if (c !== triggerCard) c.classList.add('ctx-dimmed')
    else c.classList.add('ctx-selected')
  })

  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  _colCtxMenu = menu
  // Initial position — will be repositioned after measuring
  menu.style.left = '0px'
  menu.style.top  = '0px'

  function addBtn(icon, label, danger, onClick) {
    const btn = document.createElement('button')
    btn.className = 'ctx-item' + (danger ? ' ctx-item--danger' : '')
    btn.innerHTML = `${I(icon, 14)}<span>${label}</span>`
    btn.addEventListener('click', () => { closeColCtxMenu(); onClick() })
    menu.appendChild(btn)
  }

  addBtn('arrow-square-out', t('action.export'), false, async () => {
    const save = await getSaveDialog()
    if (!save) return
    const savePath = await save({
      title: t('collection.export_title'),
      defaultPath: `${col.name}.qooti`,
      filters: [{ name: 'qooti Pack', extensions: ['qooti'] }],
    })
    if (!savePath) return
    try {
      await api.exportCollection(col.id, savePath)
      log.info('exported', { collection: col.name, path: savePath })
      sfx.success()
    } catch (err) {
      log.error('export_failed', { collection: col.name, error: err })
    }
  })

  const divider = document.createElement('div')
  divider.className = 'ctx-divider'
  menu.appendChild(divider)

  addBtn('pencil-simple', col.locked ? t('collections.edit_pro') : t('action.edit'), false, async () => {
    if (col.locked) { showCollectionLockedModal(); return }
    const name = await showPrompt({
      title: t('collections.rename_title'),
      placeholder: t('collection.name_ph'),
      icon: 'folder',
      value: col.name,
    })
    if (!name || name === col.name) return
    try {
      await api.updateCollection(col.id, { name })
      log.info('renamed', { id: col.id, from: col.name, to: name })
      store.emit(events.COLLECTION_UPDATED, { collection: { ...col, name } })
    } catch (err) {
      log.error('rename_failed', { id: col.id, error: err })
    }
  })

  addBtn('trash', t('action.delete'), true, async () => {
    const result = await showConfirm({
      title: t('collections.delete_title'),
      message: t('collections.delete_message', { name: col.name }),
      confirmLabel: t('action.delete'),
      danger: true,
      checkboxLabel: t('collections.delete_items'),
    })
    if (!result) return
    const deleteItems = result.checked ?? false
    try {
      await api.deleteCollection(col.id, deleteItems)
      log.info('deleted', { id: col.id, name: col.name, deleted_items: deleteItems })
      sfx.delete()
      store.emit(events.COLLECTION_DELETED, { id: col.id })
    } catch (err) {
      log.error('delete_failed', { id: col.id, error: err })
    }
  })

  document.body.appendChild(menu)

  // Centre the menu bar below the card, clamped to viewport — same logic as grid.js
  const gap = 10
  const { width: menuW, height: menuH } = menu.getBoundingClientRect()
  let left = cardRect.left + (cardRect.width - menuW) / 2
  left = Math.max(gap, Math.min(left, window.innerWidth - menuW - gap))
  let top = cardRect.bottom + gap
  if (top + menuH > window.innerHeight - gap) top = cardRect.top - menuH - gap
  menu.style.left = `${left}px`
  menu.style.top  = `${top}px`

  setTimeout(() => {
    _colCtxListeners = {
      down:   e => { if (!menu.contains(e.target)) closeColCtxMenu() },
      key:    e => { if (e.key === 'Escape') closeColCtxMenu() },
      scroll: ()  => closeColCtxMenu(),
    }
    document.addEventListener('mousedown', _colCtxListeners.down)
    document.addEventListener('keydown',   _colCtxListeners.key)
    window.addEventListener('scroll',      _colCtxListeners.scroll, true)
  }, 0)
}

const _colByCard = new WeakMap()   // card element → collection, for drops

function makeCard(col) {
  const card = document.createElement('div')
  card.className = 'col-card'
  _colByCard.set(card, col)
  const paths = parsePreviewPaths(col.preview_paths)
  const coverAttrs = ''
  const countLabel = t(col.item_count === 1 ? 'collections.items_one' : 'collections.items_many', { n: col.item_count ?? 0 })

  card.innerHTML = `
    <div class="col-card-cover"${coverAttrs}>
      ${buildCoverHtml(paths)}
    </div>
    <div class="col-card-info">
      <div class="col-card-title">
        <span class="col-card-name">${escHtml(col.name)}</span>
        ${col.locked ? `<button class="col-card-lock" aria-label="${t('collections.readonly_tip')}" data-tooltip="${t('collections.readonly_tip')}">${I('lock', 12)}</button>` : ''}
      </div>
      <span class="col-card-meta">${countLabel} · ${relativeDate(col.created_at)}</span>
    </div>
    <button class="col-card-menu-btn" title="${t('collections.options')}" aria-label="${t('collections.options')}">···</button>
  `

  card.addEventListener('click', e => {
    if (e.target.closest('.col-card-menu-btn')) return
    store.emit(events.COLLECTION_SELECTED, { id: col.id, name: col.name })
    store.emit(events.NAVIGATE, { view: 'grid' })
  })

  card.querySelector('.col-card-menu-btn').addEventListener('click', e => {
    e.stopPropagation()
    showColCtxMenu(card, col)
  })

  // The lock explains itself on hover; a click offers the upgrade
  card.querySelector('.col-card-lock')?.addEventListener('click', e => {
    e.stopPropagation()
    showCollectionLockedModal()
  })

  card.addEventListener('contextmenu', e => {
    e.preventDefault()
    showColCtxMenu(card, col)
  })

  return card
}

async function promptCreate() {
  const name = await showPrompt({ title: t('collection.new_title'), placeholder: t('collection.name_ph'), icon: 'folder' })
  if (!name) return
  try {
    const col = await api.createCollection(name)
    log.info('created', { name, id: col.id })
    sfx.success()
    store.emit(events.COLLECTION_CREATED, { collection: col })
  } catch (err) {
    if (String(err).includes('UPGRADE_REQUIRED:collections_limit')) {
      showCollectionsUpgradeModal()
      return
    }
    console.error('[collections] create failed:', err)
  }
}

function showCollectionsUpgradeModal() {
  const existing = document.getElementById('collections-upgrade-modal')
  if (existing) { existing.remove() }

  const modal = document.createElement('div')
  modal.id = 'collections-upgrade-modal'
  modal.className = 'upgrade-modal-backdrop'
  modal.innerHTML = upgradeDialogHtml(t('collections.limit_title'), t('collections.limit_body'))
  document.body.appendChild(modal)

  const close = () => modal.remove()
  modal.querySelector('.upgrade-modal__close').addEventListener('click', close)
  modal.querySelector('.upgrade-modal__later').addEventListener('click', close)
  modal.querySelector('.upgrade-modal__cta').addEventListener('click', () => {
    api.openUrl('https://account.bloot.app/')
    close()
  })
  modal.addEventListener('click', e => { if (e.target === modal) close() })
}

function showCollectionLockedModal() {
  const existing = document.getElementById('collection-locked-modal')
  if (existing) { existing.remove() }

  const modal = document.createElement('div')
  modal.id = 'collection-locked-modal'
  modal.className = 'upgrade-modal-backdrop'
  modal.innerHTML = upgradeDialogHtml(t('collections.locked_title'), t('collections.locked_body'))
  document.body.appendChild(modal)

  const close = () => modal.remove()
  modal.querySelector('.upgrade-modal__close').addEventListener('click', close)
  modal.querySelector('.upgrade-modal__later').addEventListener('click', close)
  modal.querySelector('.upgrade-modal__cta').addEventListener('click', () => {
    api.openUrl('https://account.bloot.app/')
    close()
  })
  modal.addEventListener('click', e => { if (e.target === modal) close() })
}

// Small dialog: title + close, one line of copy, "Not now" and the primary "Upgrade to Pro"
function upgradeDialogHtml(title, body) {
  return `
    <div class="upgrade-modal" role="dialog" aria-modal="true">
      <div class="upgrade-modal__head">
        <h2 class="upgrade-modal__title">${title}</h2>
        <button class="upgrade-modal__close" aria-label="${t('action.close')}">${I('x', 16)}</button>
      </div>
      <p class="upgrade-modal__body">${body}</p>
      <div class="upgrade-modal__actions">
        <button class="dlg-btn dlg-btn--ghost upgrade-modal__later">${t('action.not_now')}</button>
        <button class="dlg-btn dlg-btn--primary upgrade-modal__cta">${t('collections.upgrade')}</button>
      </div>
    </div>`
}

function parsePreviewPaths(json) {
  if (!json) return []
  try { return JSON.parse(json).filter(Boolean) } catch { return [] }
}

function toSrc(path) {
  return IS_TAURI ? convertFileSrc(path) : path
}

function isVideoPath(p) {
  return /\.(mp4|webm|mov|avi|mkv)$/i.test(p)
}

function coverMediaEl(p) {
  const src = escHtml(toSrc(p))
  if (isVideoPath(p)) {
    return `<video src="${src}" muted preload="metadata" playsinline></video>`
  }
  return `<img src="${src}" alt="" loading="lazy" decoding="async" />`
}

function buildCoverHtml(paths) {
  if (!paths.length) {
    return `<span class="icon icon-28 col-card-icon" style="mask-image:url('/icons/folder.svg');-webkit-mask-image:url('/icons/folder.svg')" aria-hidden="true"></span>`
  }
  if (paths.length === 1) {
    return `<div class="col-preview-single">${coverMediaEl(paths[0])}</div>`
  }
  const side = paths.slice(1, 3).map(p =>
    `<div class="col-preview-small">${coverMediaEl(p)}</div>`
  ).join('')
  return `
    <div class="col-preview-mosaic">
      <div class="col-preview-main">${coverMediaEl(paths[0])}</div>
      <div class="col-preview-side">${side}</div>
    </div>`
}

function escHtml(str) {
  if (!str) return ''
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function relativeDate(ts) {
  const diff = Date.now() - ts
  const days = Math.floor(diff / 86400000)
  if (days === 0) return t('date.today')
  if (days === 1) return t('date.yesterday')
  if (days < 30)  return t('date.days_ago', { n: days })
  if (days < 365) return t('date.months_ago', { n: Math.floor(days / 30) })
  return t('date.years_ago', { n: Math.floor(days / 365) })
}
