// Fullscreen, pannable + zoomable "similarity canvas" (a DOM/CSS board — not <canvas>,
// so images stay crisp and interactive). Opens from the player: the focused item sits at
// the centre and perceptually-similar items spread around it like a moodboard. Click a
// surrounding item to re-centre on it and keep exploring; click the centred item to open
// it in the normal player; the X (top-right) reverses the animation back to the player.
// Images only.

import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from './tauri-api.js'
import { makeLogger } from './logger.js'

const log = makeLogger('SimCanvas')
const IS_TAURI = '__TAURI_INTERNALS__' in window

const FOCUS_SIZE  = 300      // px — the centred item
const TILE_SIZE   = 158      // px — each similar item
const RING_START  = 250      // px — radius of the first placement
const RING_STEP   = 92       // px — radial growth (phyllotaxis spiral)
const GOLDEN      = 2.399963229728653  // golden angle (radians)
const MAX_SIMILAR = 60
const MIN_ZOOM = 0.2, MAX_ZOOM = 3
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

let _el = null            // overlay root
let _board = null         // pan/zoom transform layer
let _onOpen = null        // (item) => open the normal player
let _originRect = null    // player media rect, for the reverse animation
let _pan = { x: 0, y: 0 }
let _zoom = 1
let _cleanup = []
let _busy = false         // guards during recenter transitions

const wait = ms => new Promise(r => setTimeout(r, ms))
const center = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
const toSrc = it => { const p = it.thumbnail_path || it.stored_path; return IS_TAURI ? convertFileSrc(p) : p }

function applyTransform() {
  if (_board) _board.style.transform = `translate(${_pan.x}px, ${_pan.y}px) scale(${_zoom})`
}
function animateBoard(on) {
  if (_board) _board.style.transition = on ? `transform 0.5s ${EASE}` : 'none'
}

// Size a tile to the item's own aspect ratio (longest side = `longSide`) so images are
// never cropped to a square.
function tileDims(item, longSide) {
  const ar = item.aspect_ratio && item.aspect_ratio > 0 ? item.aspect_ratio : 1  // width / height
  return ar >= 1
    ? { w: longSide, h: Math.round(longSide / ar) }
    : { w: Math.round(longSide * ar), h: longSide }
}

function makeTile(item, longSide, x, y, isFocus) {
  const tile = document.createElement('div')
  tile.className = 'simcanvas-tile' + (isFocus ? ' is-focus' : '')
  const { w, h } = tileDims(item, longSide)
  tile.style.width  = `${w}px`
  tile.style.height = `${h}px`
  tile.style.left = `${x}px`
  tile.style.top  = `${y}px`
  const img = document.createElement('img')
  img.src = toSrc(item)
  img.alt = item.title ?? ''
  img.draggable = false
  tile.appendChild(img)
  tile._item  = item
  tile._pos   = { x, y }
  tile._focus = isFocus
  return tile
}

// Place similar tiles around the focus in a phyllotaxis spiral — index 0 (most similar)
// lands nearest the centre. Each is added faded/shrunk then eased in (staggered).
function addSimilars(sims) {
  sims.slice(0, MAX_SIMILAR).forEach((it, i) => {
    const angle  = i * GOLDEN
    const radius = RING_START + RING_STEP * Math.sqrt(i)
    const tile = makeTile(it, TILE_SIZE, Math.cos(angle) * radius, Math.sin(angle) * radius, false)
    tile.style.opacity = '0'
    tile.style.transform = 'translate(-50%, -50%) scale(0.6)'
    _board.appendChild(tile)
    requestAnimationFrame(() => {
      tile.style.transition = `opacity 0.45s ease ${Math.min(i * 8, 260)}ms, transform 0.45s ${EASE} ${Math.min(i * 8, 260)}ms`
      tile.style.opacity = '1'
      tile.style.transform = 'translate(-50%, -50%) scale(1)'
    })
  })
}

async function loadFocus(item, { grow = false } = {}) {
  _board.innerHTML = ''
  const f = makeTile(item, FOCUS_SIZE, 0, 0, true)
  _board.appendChild(f)
  if (grow) {
    // Start at similar-tile size (it was just clicked) and grow into the focus.
    f.style.transform = `translate(-50%, -50%) scale(${TILE_SIZE / FOCUS_SIZE})`
    requestAnimationFrame(() => {
      f.style.transition = `transform 0.4s ${EASE}`
      f.style.transform = 'translate(-50%, -50%) scale(1)'
    })
  }
  try {
    const sims = await api.findSimilar(item.id, MAX_SIMILAR)
    if (_el) addSimilars(sims)
  } catch (e) { log.warn('findSimilar failed:', String(e)) }
}

function handleTileClick(tile) {
  if (_busy) return
  if (tile._focus) { const it = tile._item; close(false); _onOpen?.(it); return }
  recenter(tile)
}

// Click a similar tile → glide it to the centre, fade the rest, then rebuild with it as
// the new focus (its own similar items bloom around it).
async function recenter(tile) {
  _busy = true
  animateBoard(true)
  _pan = { x: -tile._pos.x * _zoom, y: -tile._pos.y * _zoom }
  applyTransform()
  for (const t of _board.querySelectorAll('.simcanvas-tile')) {
    if (t !== tile) { t.style.transition = 'opacity 0.35s ease'; t.style.opacity = '0' }
  }
  await wait(380)
  if (!_el) return
  animateBoard(false)
  _pan = { x: 0, y: 0 }; _zoom = 1; applyTransform()
  await loadFocus(tile._item, { grow: true })
  _busy = false
}

function wireInteractions() {
  let dragging = false, moved = false, sx = 0, sy = 0, sp = null, downTile = null

  const onDown = e => {
    if (e.button && e.button !== 0) return
    dragging = true; moved = false; sx = e.clientX; sy = e.clientY; sp = { ..._pan }
    // Record the pressed tile NOW — setPointerCapture makes pointerup target the overlay,
    // so e.target on release would no longer be the tile.
    downTile = e.target.closest?.('.simcanvas-tile') || null
    animateBoard(false)
    try { _el.setPointerCapture(e.pointerId) } catch {}
  }
  const onMove = e => {
    if (!dragging) return
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (Math.abs(dx) + Math.abs(dy) > 5) moved = true
    _pan = { x: sp.x + dx, y: sp.y + dy }; applyTransform()
  }
  const onUp = () => {
    if (!dragging) return
    dragging = false
    if (!moved && downTile) handleTileClick(downTile)
    downTile = null
  }
  const onWheel = e => {
    e.preventDefault()
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, _zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
    const c = center()
    const bx = (e.clientX - c.x - _pan.x) / _zoom
    const by = (e.clientY - c.y - _pan.y) / _zoom
    _pan = { x: e.clientX - c.x - bx * nz, y: e.clientY - c.y - by * nz }
    _zoom = nz
    animateBoard(false); applyTransform()
  }
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(true) } }

  _el.addEventListener('pointerdown', onDown)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  _el.addEventListener('wheel', onWheel, { passive: false })
  document.addEventListener('keydown', onKey, true)
  _cleanup.push(() => {
    _el?.removeEventListener('pointerdown', onDown)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    _el?.removeEventListener('wheel', onWheel)
    document.removeEventListener('keydown', onKey, true)
  })
}

function close(reverse) {
  const el = _el, board = _board
  if (!el) return
  _el = null; _board = null; _busy = false
  for (const fn of _cleanup) fn()
  _cleanup = []

  if (reverse && _originRect && board) {
    board.style.transition = `transform 0.45s ${EASE}`
    const c = center()
    const z = Math.max(_originRect.width, _originRect.height) / FOCUS_SIZE
    board.style.transform =
      `translate(${_originRect.left + _originRect.width / 2 - c.x}px, ${_originRect.top + _originRect.height / 2 - c.y}px) scale(${z})`
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 460)
  } else {
    el.style.transition = 'opacity 0.2s ease'
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 200)
  }
}

/**
 * Open the similarity canvas for `item`, animating out from `originRect` (the player's
 * media rect). `onOpen(item)` is called when the user opens an item in the normal player.
 */
export async function openSimilarCanvas(item, originRect, { onOpen } = {}) {
  if (_el) close(false)
  _onOpen = onOpen ?? null
  _originRect = originRect ?? null

  _el = document.createElement('div')
  _el.className = 'simcanvas'
  _board = document.createElement('div')
  _board.className = 'simcanvas-board'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'simcanvas-close'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.innerHTML = `<span class="icon icon-18" style="mask-image:url('/icons/x.svg');-webkit-mask-image:url('/icons/x.svg')" aria-hidden="true"></span>`
  closeBtn.addEventListener('click', () => close(true))
  _el.append(_board, closeBtn)
  document.body.appendChild(_el)

  // Focus tile only at first; similar items fade in once fetched.
  _board.innerHTML = ''
  _board.appendChild(makeTile(item, FOCUS_SIZE, 0, 0, true))

  // Start with the board transformed so the focus tile overlays the player's media rect,
  // then ease to the home frame (focus shrinks to its tile size at screen centre).
  const c = center()
  const startZoom = originRect ? Math.max(originRect.width, originRect.height) / FOCUS_SIZE : 1
  const startPan  = originRect
    ? { x: originRect.left + originRect.width / 2 - c.x, y: originRect.top + originRect.height / 2 - c.y }
    : { x: 0, y: 0 }
  animateBoard(false)
  _pan = startPan; _zoom = startZoom; applyTransform()
  void _el.offsetWidth  // reflow so the start state paints before we animate

  requestAnimationFrame(() => {
    if (!_el) return
    _el.style.opacity = '1'
    animateBoard(true)
    _pan = { x: 0, y: 0 }; _zoom = 1; applyTransform()
  })

  wireInteractions()

  try {
    const sims = await api.findSimilar(item.id, MAX_SIMILAR)
    if (_el) addSimilars(sims)
  } catch (e) { log.warn('findSimilar failed:', String(e)) }
}
