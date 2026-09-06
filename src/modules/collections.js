import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { showPrompt, showConfirm } from './dialog.js'
import { makeLogger } from './logger.js'

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

  container.innerHTML = `
    <div class="collections-page">
      <div class="collections-header">
        <h1 class="collections-title">Collections</h1>
        <button class="btn btn-ghost collections-new-btn" id="collections-new">
          <span class="icon icon-16" style="mask-image:url('/icons/plus.svg');-webkit-mask-image:url('/icons/plus.svg')" aria-hidden="true"></span>
          New collection
        </button>
      </div>
      <div class="collections-grid" id="collections-grid"></div>
    </div>
  `

  const grid = container.querySelector('#collections-grid')

  if (!cols.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <span class="icon icon-32" style="mask-image:url('/icons/folder.svg');-webkit-mask-image:url('/icons/folder.svg');opacity:0.2" aria-hidden="true"></span>
        <span class="empty-state-title">No collections yet</span>
        <p class="empty-state-body">Create your first collection to organise your inspiration.</p>
      </div>
    `
  } else {
    for (const col of cols) grid.appendChild(makeCard(col))
  }

  container.querySelector('#collections-new').addEventListener('click', () => promptCreate())
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

  addBtn('arrow-square-out', 'Export', false, async () => {
    const save = await getSaveDialog()
    if (!save) return
    const savePath = await save({
      title: 'Export collection',
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

  addBtn('pencil-simple', col.locked ? 'Edit (Pro)' : 'Edit', false, async () => {
    if (col.locked) { showCollectionLockedModal(); return }
    const name = await showPrompt({
      title: 'Rename collection',
      placeholder: 'Collection name…',
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

  addBtn('trash', 'Delete', true, async () => {
    const result = await showConfirm({
      title: 'Delete collection',
      message: `Delete "${col.name}"?`,
      confirmLabel: 'Delete',
      danger: true,
      checkboxLabel: 'Also delete all items inside',
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

function makeCard(col) {
  const card = document.createElement('div')
  card.className = 'col-card'
  const paths = parsePreviewPaths(col.preview_paths)
  const coverAttrs = paths.length ? '' : ` style="background:${coverGradient(col.name)}"`
  const countLabel = col.item_count === 1 ? '1 item' : `${col.item_count ?? 0} items`

  card.innerHTML = `
    <div class="col-card-cover"${coverAttrs}>
      ${buildCoverHtml(paths)}
    </div>
    <div class="col-card-overlay"></div>
    <div class="col-card-info">
      <span class="col-card-name">${escHtml(col.name)}</span>
      <span class="col-card-meta">${countLabel} · ${relativeDate(col.created_at)}</span>
    </div>
    ${col.locked ? `<span class="col-card-lock" title="Read-only on free plan">${I('lock', 13)}</span>` : ''}
    <button class="col-card-menu-btn" title="Options" aria-label="Collection options">···</button>
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

  card.addEventListener('contextmenu', e => {
    e.preventDefault()
    showColCtxMenu(card, col)
  })

  return card
}

async function promptCreate() {
  const name = await showPrompt({ title: 'New collection', placeholder: 'Collection name…', icon: 'folder' })
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
  modal.innerHTML = `
    <div class="upgrade-modal">
      <button class="upgrade-modal__close" aria-label="Close">${I('x', 16)}</button>
      <div class="upgrade-modal__icon">${I('folders', 32)}</div>
      <h2 class="upgrade-modal__title">Collection limit reached</h2>
      <p class="upgrade-modal__body">Free plan allows up to 3 collections. Upgrade to Pro for unlimited collections.</p>
      <button class="btn btn-accent upgrade-modal__cta">Upgrade to Pro</button>
    </div>
  `
  document.body.appendChild(modal)

  const close = () => modal.remove()
  modal.querySelector('.upgrade-modal__close').addEventListener('click', close)
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
  modal.innerHTML = `
    <div class="upgrade-modal">
      <button class="upgrade-modal__close" aria-label="Close">${I('x', 16)}</button>
      <div class="upgrade-modal__icon">${I('lock', 32)}</div>
      <h2 class="upgrade-modal__title">Collection is read-only</h2>
      <p class="upgrade-modal__body">Your free plan includes 3 editable collections. This collection is view-only. Upgrade to Pro to edit all collections.</p>
      <button class="btn btn-accent upgrade-modal__cta">Upgrade to Pro</button>
    </div>
  `
  document.body.appendChild(modal)

  const close = () => modal.remove()
  modal.querySelector('.upgrade-modal__close').addEventListener('click', close)
  modal.querySelector('.upgrade-modal__cta').addEventListener('click', () => {
    api.openUrl('https://account.bloot.app/')
    close()
  })
  modal.addEventListener('click', e => { if (e.target === modal) close() })
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

// Deterministic gradient from name hash
function coverGradient(name) {
  const palettes = [
    ['#1a1a2e', '#16213e'],
    ['#0d1b2a', '#1b2838'],
    ['#1a0a2e', '#2d1b69'],
    ['#0a1628', '#0f2d4a'],
    ['#1c1c1c', '#2d2d2d'],
    ['#0d2137', '#1a3a52'],
    ['#200a0a', '#3d1515'],
  ]
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xFFFF
  const [a, b] = palettes[h % palettes.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}

function escHtml(str) {
  if (!str) return ''
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function relativeDate(ts) {
  const diff = Date.now() - ts
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30)  return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}
