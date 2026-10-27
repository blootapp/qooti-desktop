// Boards list view — create / open / rename / export / delete storyboards.
// A card opens the full-screen infinite-canvas editor (board-editor.js).
import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { showPrompt, showConfirm } from './dialog.js'
import { makeLogger } from './logger.js'
import { t } from './i18n.js'

const log = makeLogger('Boards')
const IS_TAURI = '__TAURI_INTERNALS__' in window

let _dialogs = null
async function getDialogs() {
  if (!IS_TAURI) return null
  if (!_dialogs) {
    const d = await import('@tauri-apps/plugin-dialog')
    _dialogs = { save: d.save, open: d.open }
  }
  return _dialogs
}

let container = null

export function init(el) {
  container = el
  store.on(events.NAV_CHANGE, ({ view }) => { if (view === 'boards') reload() })
}

async function reload() {
  try {
    render(await api.listBoards())
  } catch (err) {
    console.error('[boards] reload failed:', err)
  }
}

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

function render(boards) {
  if (!container) return
  container.innerHTML = `
    <div class="boards-page">
      <div class="boards-header">
        <h1 class="boards-title">${t('boards.title')}</h1>
        <div class="boards-header-actions">
          <button class="btn btn-ghost" id="boards-import">${I('upload-simple')}${t('boards.import')}</button>
          <button class="btn btn-accent" id="boards-new">${I('plus')}${t('boards.new')}</button>
        </div>
      </div>
      <div class="boards-grid" id="boards-grid"></div>
    </div>
  `

  const grid = container.querySelector('#boards-grid')
  if (!boards.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <span class="icon icon-32" style="mask-image:url('/icons/squares-four.svg');-webkit-mask-image:url('/icons/squares-four.svg');opacity:0.2" aria-hidden="true"></span>
        <span class="empty-state-title">${t('boards.empty_title')}</span>
        <p class="empty-state-body">${t('boards.empty_body')}</p>
      </div>
    `
  } else {
    for (const b of boards) grid.appendChild(makeCard(b))
  }

  container.querySelector('#boards-new').addEventListener('click', promptCreate)
  container.querySelector('#boards-import').addEventListener('click', importBoard)
}

function makeCard(board) {
  const card = document.createElement('div')
  card.className = 'board-card'
  const cover = board.thumb
    ? `<img src="${escHtml(toSrc(board.thumb))}" alt="" loading="lazy" decoding="async" />`
    : `<span class="board-card-icon icon icon-28" style="mask-image:url('/icons/squares-four.svg');-webkit-mask-image:url('/icons/squares-four.svg')" aria-hidden="true"></span>`
  const coverAttrs = board.thumb ? '' : ` style="background:${coverGradient(board.name)}"`
  const n = board.element_count ?? 0
  const countLabel = n === 1 ? t('boards.one_item') : t('boards.n_items').replace('{n}', n)

  card.innerHTML = `
    <div class="board-card-cover"${coverAttrs}>${cover}</div>
    <div class="board-card-info">
      <span class="board-card-name">${escHtml(board.name)}</span>
      <span class="board-card-meta">${countLabel} · ${relativeDate(board.updated_at)}</span>
    </div>
    <button class="board-card-menu-btn" title="${t('boards.options')}" aria-label="${t('boards.options')}">···</button>
  `

  card.addEventListener('click', e => {
    if (e.target.closest('.board-card-menu-btn')) return
    openBoard(board)
  })
  card.querySelector('.board-card-menu-btn').addEventListener('click', e => {
    e.stopPropagation(); showCardMenu(card, board)
  })
  card.addEventListener('contextmenu', e => { e.preventDefault(); showCardMenu(card, board) })
  return card
}

async function openBoard(board) {
  const { openBoardEditor } = await import('./board-editor.js')
  openBoardEditor(board.id, { onClose: reload })
}

async function promptCreate() {
  const name = await showPrompt({ title: t('boards.new'), placeholder: t('boards.name_placeholder'), icon: 'squares-four' })
  if (name === null) return
  try {
    const board = await api.createBoard(name || '')
    log.info('created', { id: board.id })
    sfx.success()
    openBoard(board)
  } catch (err) {
    console.error('[boards] create failed:', err)
  }
}

async function importBoard() {
  const dl = await getDialogs()
  if (!dl) return
  const path = await dl.open({
    title: t('boards.import'),
    filters: [{ name: 'qooti Board', extensions: ['qbord'] }],
  })
  if (!path) return
  try {
    await api.importBoard(Array.isArray(path) ? path[0] : path)
    sfx.success()
    reload()
  } catch (err) {
    log.error('import_failed', { error: err })
    store.emit(events.SYSTEM_TOAST, { type: 'error', message: t('boards.import_failed'), duration: 4000 })
  }
}

// ─── Context menu ────────────────────────────────────────────────
let _menu = null, _menuListeners = null

function closeMenu() {
  if (!_menu) return
  _menu.remove(); _menu = null
  if (_menuListeners) {
    document.removeEventListener('mousedown', _menuListeners.down)
    document.removeEventListener('keydown', _menuListeners.key)
    window.removeEventListener('scroll', _menuListeners.scroll, true)
    _menuListeners = null
  }
}

function showCardMenu(card, board) {
  closeMenu()
  const rect = card.getBoundingClientRect()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'
  _menu = menu

  const addBtn = (icon, label, danger, onClick) => {
    const btn = document.createElement('button')
    btn.className = 'ctx-item' + (danger ? ' ctx-item--danger' : '')
    btn.innerHTML = `${I(icon, 14)}<span>${label}</span>`
    btn.addEventListener('click', () => { closeMenu(); onClick() })
    menu.appendChild(btn)
  }

  addBtn('pencil-simple', t('boards.rename'), false, async () => {
    const name = await showPrompt({ title: t('boards.rename'), placeholder: t('boards.name_placeholder'), icon: 'squares-four', value: board.name })
    if (!name || name === board.name) return
    try { await api.renameBoard(board.id, name); reload() }
    catch (err) { log.error('rename_failed', { error: err }) }
  })

  addBtn('arrow-square-out', t('boards.export'), false, async () => {
    const dl = await getDialogs()
    if (!dl) return
    const savePath = await dl.save({ title: t('boards.export'), defaultPath: `${board.name}.qbord`, filters: [{ name: 'qooti Board', extensions: ['qbord'] }] })
    if (!savePath) return
    try { await api.exportBoard(board.id, savePath); sfx.success() }
    catch (err) { log.error('export_failed', { error: err }) }
  })

  const divider = document.createElement('div')
  divider.className = 'ctx-divider'
  menu.appendChild(divider)

  addBtn('trash', t('boards.delete'), true, async () => {
    const ok = await showConfirm({ title: t('boards.delete'), message: t('boards.delete_confirm').replace('{name}', board.name), confirmLabel: t('boards.delete'), danger: true })
    if (!ok) return
    try { await api.deleteBoard(board.id); sfx.delete(); reload() }
    catch (err) { log.error('delete_failed', { error: err }) }
  })

  document.body.appendChild(menu)
  const gap = 10
  const { width: mw, height: mh } = menu.getBoundingClientRect()
  let left = rect.left + (rect.width - mw) / 2
  left = Math.max(gap, Math.min(left, window.innerWidth - mw - gap))
  let top = rect.bottom + gap
  if (top + mh > window.innerHeight - gap) top = rect.top - mh - gap
  menu.style.left = `${left}px`; menu.style.top = `${top}px`

  setTimeout(() => {
    _menuListeners = {
      down: e => { if (!menu.contains(e.target)) closeMenu() },
      key: e => { if (e.key === 'Escape') closeMenu() },
      scroll: () => closeMenu(),
    }
    document.addEventListener('mousedown', _menuListeners.down)
    document.addEventListener('keydown', _menuListeners.key)
    window.addEventListener('scroll', _menuListeners.scroll, true)
  }, 0)
}

// ─── helpers ─────────────────────────────────────────────────────
function toSrc(path) { return IS_TAURI ? convertFileSrc(path) : path }

function escHtml(s) {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function coverGradient(name) {
  const palettes = [
    ['#1a1a2e', '#16213e'], ['#0d1b2a', '#1b2838'], ['#1a0a2e', '#2d1b69'],
    ['#0a1628', '#0f2d4a'], ['#1c1c1c', '#2d2d2d'], ['#0d2137', '#1a3a52'], ['#200a0a', '#3d1515'],
  ]
  let h = 0
  for (const c of name || 'b') h = (h * 31 + c.charCodeAt(0)) & 0xFFFF
  const [a, b] = palettes[h % palettes.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}

function relativeDate(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000)
  if (days === 0) return t('boards.today')
  if (days === 1) return t('boards.yesterday')
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}
