// Full-screen infinite-canvas board editor (Miro/Milanote-style).
//
// The board document lives entirely in `doc = { viewport, elements[] }`. Element
// geometry is in WORLD space; the `.board-world` layer is transformed by the
// viewport (translate + scale), so panning/zooming is a single GPU transform.
// Div elements (image/text/note/rect/ellipse/frame) are absolutely positioned in
// world space; vector elements (pen/connector) are drawn in an SVG layer that lives
// inside the world (so they scale with it). Selection UI is drawn in a screen-space
// overlay computed from each node's on-screen rect, so handles stay crisp at any zoom.

import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from './tauri-api.js'
import store from './store.js'
import * as events from './events.js'
import { t } from './i18n.js'
import { sfx } from './sfx.js'
import { makeLogger } from './logger.js'
import { openColorPicker } from './color-picker.js'

const log = makeLogger('BoardEditor')
const IS_TAURI = '__TAURI_INTERNALS__' in window
const SVGNS = 'http://www.w3.org/2000/svg'

const NOTE_COLORS = ['#ffd666', '#ffa39e', '#b7eb8f', '#91d5ff', '#d3adf7', '#ffffff']
const MIN_ZOOM = 0.05, MAX_ZOOM = 6

let _dialogOpen = null
async function getOpenDialog() {
  if (!IS_TAURI) return null
  if (!_dialogOpen) ({ open: _dialogOpen } = await import('@tauri-apps/plugin-dialog'))
  return _dialogOpen
}

// ─── Module-level editor state ───────────────────────────────────
let root = null            // .board-editor overlay
let canvas = null          // interaction surface
let world = null           // transformed layer
let svg = null             // vector layer (inside world)
let overlay = null         // screen-space selection UI
let els = null             // .board-els container (inside world)

let boardId = null
let onCloseCb = null
let doc = null             // { viewport:{x,y,zoom}, elements:[] }
let tool = 'select'
let sel = new Set()        // selected element ids
const nodeMap = new Map()  // id -> DOM node (div or svg <g>)

let spaceHeld = false
let drag = null            // active pointer session
let history = [], histIndex = -1
let saveTimer = null
let canvasRect = null

// ─── Public entry ────────────────────────────────────────────────
export async function openBoardEditor(id, { onClose } = {}) {
  boardId = id
  onCloseCb = onClose
  tool = 'select'; sel = new Set(); nodeMap.clear(); drag = null

  let board
  try { board = await api.getBoard(id) }
  catch (err) { log.error('load_failed', { error: err }); return }

  assetsDir = board.assets_dir || ''
  boardName = board.name || 'Untitled board'
  try { doc = JSON.parse(board.doc || '{}') } catch { doc = {} }
  if (!doc.viewport) doc.viewport = { x: 0, y: 0, zoom: 1 }
  if (!Array.isArray(doc.elements)) doc.elements = []

  buildChrome()
  mountAll()
  applyViewport()
  history = [snapshot()]; histIndex = 0
  requestAnimationFrame(() => root.classList.add('is-open'))
}

let assetsDir = ''
let boardName = ''

// ─── DOM scaffold ────────────────────────────────────────────────
const I = (name, size = 18) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

function buildChrome() {
  root = document.createElement('div')
  root.className = 'board-editor'
  root.innerHTML = `
    <div class="board-topbar">
      <button class="board-tb-btn board-done" title="${t('board.done')}">${I('arrow-left', 18)}<span>${t('board.done')}</span></button>
      <input class="board-name-input" value="${escAttr(boardName)}" spellcheck="false" />
      <div class="board-tb-spacer"></div>
      <button class="board-tb-btn" data-act="undo" title="${t('board.undo')}">${I('arrow-u-up-left', 18)}</button>
      <button class="board-tb-btn" data-act="redo" title="${t('board.redo')}">${I('arrow-u-up-right', 18)}</button>
      <div class="board-tb-sep"></div>
      <button class="board-tb-btn" data-act="zoomout" title="−">${I('minus', 16)}</button>
      <button class="board-tb-btn board-zoom-label" data-act="fit" title="${t('board.zoom_fit')}">100%</button>
      <button class="board-tb-btn" data-act="zoomin" title="+">${I('plus', 16)}</button>
      <div class="board-tb-sep"></div>
      <button class="board-tb-btn" data-act="export" title="${t('boards.export')}">${I('arrow-square-out', 18)}</button>
    </div>
    <div class="board-toolbar">
      ${toolBtn('select', 'cursor')}
      ${toolBtn('pan', 'hand')}
      <div class="board-tool-sep"></div>
      <div class="board-tool-wrap">
        <button class="board-tool board-tool-main" data-wrap="image" title="${t('board.add_image')}">${I('image', 20)}</button>
        <div class="board-tool-menu" data-menu="image">
          <button data-src="library">${I('squares-four', 15)}<span>${t('board.from_library')}</span></button>
          <button data-src="files">${I('upload-simple', 15)}<span>${t('board.from_files')}</span></button>
          <button data-src="paste">${I('clipboard', 15)}<span>${t('board.paste')}</span></button>
        </div>
      </div>
      ${toolBtn('text', 'text-t')}
      ${toolBtn('note', 'note')}
      <div class="board-tool-wrap">
        <button class="board-tool board-tool-main" data-wrap="shape" title="${t('board.tool.rect')}"><span class="board-shape-glyph board-shape-glyph--rect"></span></button>
        <div class="board-tool-menu" data-menu="shape">
          <button data-shape="rect"><span class="board-shape-glyph board-shape-glyph--rect"></span><span>${t('board.tool.rect')}</span></button>
          <button data-shape="ellipse"><span class="board-shape-glyph board-shape-glyph--ellipse"></span><span>${t('board.tool.ellipse')}</span></button>
          <button data-shape="frame">${I('frame-corners', 15)}<span>${t('board.tool.frame')}</span></button>
        </div>
      </div>
      ${toolBtn('pen', 'pencil-simple')}
      ${toolBtn('connector', 'line-segment')}
    </div>
    <div class="board-canvas">
      <div class="board-world">
        <svg class="board-svg" xmlns="${SVGNS}">
          <defs>
            <marker id="board-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#9fb0c3"></path>
            </marker>
          </defs>
        </svg>
        <div class="board-els"></div>
      </div>
      <div class="board-overlay"></div>
    </div>
  `
  document.body.appendChild(root)

  canvas  = root.querySelector('.board-canvas')
  world   = root.querySelector('.board-world')
  svg     = root.querySelector('.board-svg')
  els     = root.querySelector('.board-els')
  overlay = root.querySelector('.board-overlay')

  // Topbar
  root.querySelector('.board-done').addEventListener('click', close)
  const nameInput = root.querySelector('.board-name-input')
  nameInput.addEventListener('change', () => renameBoard(nameInput.value.trim() || 'Untitled board'))
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur() })
  root.querySelectorAll('.board-tb-btn[data-act]').forEach(b =>
    b.addEventListener('click', () => topbarAction(b.dataset.act)))

  // Tools
  root.querySelectorAll('.board-tool[data-tool]').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)))
  // Grouped tools (image / shape) open a small menu
  root.querySelectorAll('.board-tool-main[data-wrap]').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); toggleWrap(b.closest('.board-tool-wrap')) }))
  root.querySelectorAll('.board-tool-menu[data-menu="image"] button').forEach(b =>
    b.addEventListener('click', () => { closeWraps(); addImageFrom(b.dataset.src) }))
  root.querySelectorAll('.board-tool-menu[data-menu="shape"] button').forEach(b =>
    b.addEventListener('click', () => { closeWraps(); setTool(b.dataset.shape) }))
  document.addEventListener('pointerdown', closeWrapsOnOutside, true)

  // Interaction
  canvas.addEventListener('pointerdown', onCanvasPointerDown)
  canvas.addEventListener('pointermove', onHover)
  canvas.addEventListener('pointerleave', () => { if (!drag) { hoverId = null; clearAnchors() } })
  canvas.addEventListener('wheel', onWheel, { passive: false })
  overlay.addEventListener('pointerdown', onOverlayPointerDown)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('paste', onPaste)
  // File drop onto the canvas
  canvas.addEventListener('dragover', e => { e.preventDefault() })
  canvas.addEventListener('drop', onDrop)

  setTool('select')
}

function toolBtn(name, icon) {
  return `<button class="board-tool" data-tool="${name}" title="${t('board.tool.' + name)}">${I(icon, 20)}</button>`
}

// ─── Coordinate helpers ──────────────────────────────────────────
function vp() { return doc.viewport }
function freshRect() { canvasRect = canvas.getBoundingClientRect(); return canvasRect }
function screenToWorld(sx, sy) {
  const r = canvasRect || freshRect()
  return { x: (sx - r.left - vp().x) / vp().zoom, y: (sy - r.top - vp().y) / vp().zoom }
}

// ─── Viewport ────────────────────────────────────────────────────
function applyViewport() {
  const v = vp()
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
  const lbl = root.querySelector('.board-zoom-label')
  if (lbl) lbl.textContent = `${Math.round(v.zoom * 100)}%`
  hoverId = null; clearAnchors()
  updateOverlay()
}

function zoomAt(sx, sy, factor) {
  const v = vp()
  const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor))
  const r = freshRect()
  const wx = (sx - r.left - v.x) / v.zoom
  const wy = (sy - r.top - v.y) / v.zoom
  v.zoom = nz
  v.x = sx - r.left - wx * nz
  v.y = sy - r.top - wy * nz
  applyViewport()
  scheduleSave()
}

function fitToScreen() {
  const list = doc.elements
  const r = freshRect()
  if (!list.length) { vp().x = r.width / 2; vp().y = r.height / 2; vp().zoom = 1; applyViewport(); return }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of list) {
    const b = worldBounds(el)
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  }
  const pad = 80
  const bw = maxX - minX, bh = maxY - minY
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh, 1.5)))
  vp().zoom = zoom
  vp().x = (r.width - bw * zoom) / 2 - minX * zoom
  vp().y = (r.height - bh * zoom) / 2 - minY * zoom
  applyViewport(); scheduleSave()
}

function onWheel(e) {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12)
  } else {
    vp().x -= e.deltaX; vp().y -= e.deltaY
    applyViewport(); scheduleSave()
  }
}

// ─── Element model helpers ───────────────────────────────────────
function uid() { return 'e' + Math.random().toString(36).slice(2, 9) }
function topZ() { return doc.elements.reduce((m, e) => Math.max(m, e.z || 0), 0) }
function findEl(id) { return doc.elements.find(e => e.id === id) }

// world bounding box for any element kind (for fit / marquee / connectors)
function worldBounds(el) {
  if (el.kind === 'pen') {
    const xs = el.points.map(p => p[0]), ys = el.points.map(p => p[1])
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }
  if (el.kind === 'connector') {
    const a = endpointResolve(el.from).pt, b = endpointResolve(el.to).pt
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
  }
  const dom = nodeMap.get(el.id)
  const w = el.w ?? (dom ? dom.offsetWidth : 120)
  const h = el.h ?? (dom ? dom.offsetHeight : 80)
  return { x: el.x, y: el.y, w, h }
}

// ─── Mount / build nodes ─────────────────────────────────────────
function mountAll() {
  els.innerHTML = ''
  nodeMap.clear()
  const sorted = [...doc.elements].sort((a, b) => (a.z || 0) - (b.z || 0))
  for (const el of sorted) {
    if (el.kind === 'pen' || el.kind === 'connector') continue
    const node = buildDivNode(el)
    els.appendChild(node)
    nodeMap.set(el.id, node)
    applyGeom(el)
  }
  redrawVectors()
}

function buildDivNode(el) {
  const node = document.createElement('div')
  node.className = `board-el board-el--${el.kind}`
  node.dataset.id = el.id
  node.style.zIndex = String(el.z || 0)

  if (el.kind === 'image') {
    const img = document.createElement('img')
    img.draggable = false
    img.src = imgSrc(el)
    img.addEventListener('load', () => {
      if ((!el.w || !el.h) && img.naturalWidth) {
        const scale = Math.min(1, 360 / img.naturalWidth)
        el.w = Math.round(img.naturalWidth * scale)
        el.h = Math.round(img.naturalHeight * scale)
        applyGeom(el); if (sel.has(el.id)) updateOverlay()
      }
    })
    node.appendChild(img)
  } else if (el.kind === 'text') {
    node.style.color = el.color || 'var(--text-primary)'
    node.style.fontSize = (el.size || 20) + 'px'
    node.textContent = el.text || ''
    node.addEventListener('dblclick', () => editText(el, node))
  } else if (el.kind === 'note') {
    node.style.background = el.color || NOTE_COLORS[0]
    const body = document.createElement('div')
    body.className = 'board-note-body'
    body.textContent = el.text || ''
    node.appendChild(body)
    node.addEventListener('dblclick', () => editText(el, body))
  } else if (el.kind === 'rect' || el.kind === 'ellipse') {
    node.style.background = el.fill || 'rgba(255,255,255,0.06)'
    node.style.border = `2px solid ${el.stroke || 'var(--accent-link, #6BA3FF)'}`
    if (el.kind === 'ellipse') node.style.borderRadius = '50%'
  } else if (el.kind === 'frame') {
    const label = document.createElement('div')
    label.className = 'board-frame-label'
    label.textContent = el.label || 'Frame'
    label.addEventListener('dblclick', () => editFrameLabel(el, label))
    node.appendChild(label)
  }
  return node
}

function applyGeom(el) {
  const node = nodeMap.get(el.id)
  if (!node) return
  node.style.left = el.x + 'px'
  node.style.top = el.y + 'px'
  if (el.w != null) node.style.width = el.w + 'px'
  if (el.h != null && el.kind !== 'text') node.style.height = el.h + 'px'
  node.style.zIndex = String(el.z || 0)
}

function imgSrc(el) {
  if (el.asset) return IS_TAURI ? convertFileSrc(assetsDir + '/' + el.asset) : (assetsDir + '/' + el.asset)
  return el.url || ''
}

// ─── Vector layer (pen + connectors) ─────────────────────────────
function redrawVectors() {
  // wipe everything except <defs>
  ;[...svg.querySelectorAll('.board-vec')].forEach(n => n.remove())
  for (const el of doc.elements) {
    if (el.kind === 'pen') drawPen(el)
    else if (el.kind === 'connector') drawConnector(el)
  }
}

function drawPen(el) {
  const path = document.createElementNS(SVGNS, 'path')
  path.setAttribute('class', 'board-vec board-pen')
  path.setAttribute('d', penPath(el.points))
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', el.color || '#e6e6e6')
  path.setAttribute('stroke-width', String(el.width || 3))
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  path.dataset.id = el.id
  if (sel.has(el.id)) path.classList.add('is-selected')
  path.addEventListener('pointerdown', e => vectorPointerDown(e, el))
  svg.appendChild(path)
}

function penPath(pts) {
  if (!pts.length) return ''
  return 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')
}

// Connection anchors: the 4 side midpoints (Miro-style). A connector endpoint is
// either { el, anchor } (bound to a side of an element — follows it), { el } (legacy,
// routes to the nearest edge), or a free { x, y } point.
const ANCHOR_SIDES = ['t', 'r', 'b', 'l']
function anchorPoint(b, side) {
  if (side === 't') return { x: b.x + b.w / 2, y: b.y }
  if (side === 'r') return { x: b.x + b.w, y: b.y + b.h / 2 }
  if (side === 'b') return { x: b.x + b.w / 2, y: b.y + b.h }
  return { x: b.x, y: b.y + b.h / 2 } // 'l'
}
function nearestAnchor(b, pt) {
  let best = 't', bd = Infinity
  for (const s of ANCHOR_SIDES) {
    const a = anchorPoint(b, s), d = (a.x - pt.x) ** 2 + (a.y - pt.y) ** 2
    if (d < bd) { bd = d; best = s }
  }
  return best
}
// Resolve an endpoint to { pt, box? }. `box` present ⇒ route to edge (legacy center attach).
function endpointResolve(end) {
  if (end.el) {
    const el = findEl(end.el)
    if (el) {
      const b = worldBounds(el)
      if (end.anchor) return { pt: anchorPoint(b, end.anchor) }
      return { pt: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, box: b }
    }
  }
  return { pt: { x: end.x, y: end.y } }
}

function rectEdge(box, toward) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2
  const dx = toward.x - cx, dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const sx = (box.w / 2) / Math.abs(dx || 1e-6)
  const sy = (box.h / 2) / Math.abs(dy || 1e-6)
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

function drawConnector(el) {
  const A = endpointResolve(el.from), B = endpointResolve(el.to)
  let a = A.pt, b = B.pt
  if (A.box) a = rectEdge(A.box, B.pt)
  if (B.box) b = rectEdge(B.box, A.pt)
  // hit path (fat, transparent) for easy selection
  const hit = document.createElementNS(SVGNS, 'path')
  hit.setAttribute('class', 'board-vec board-conn-hit')
  hit.setAttribute('d', `M${a.x},${a.y} L${b.x},${b.y}`)
  hit.setAttribute('stroke', 'transparent')
  hit.setAttribute('stroke-width', '14')
  hit.setAttribute('fill', 'none')
  hit.dataset.id = el.id
  hit.addEventListener('pointerdown', e => vectorPointerDown(e, el))
  svg.appendChild(hit)

  const path = document.createElementNS(SVGNS, 'path')
  path.setAttribute('class', 'board-vec board-conn')
  path.setAttribute('d', `M${a.x},${a.y} L${b.x},${b.y}`)
  path.setAttribute('stroke', el.color || '#9fb0c3')
  path.setAttribute('stroke-width', String(el.width || 2.5))
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke-linecap', 'round')
  if (el.style !== 'line') path.setAttribute('marker-end', 'url(#board-arrow)')
  if (sel.has(el.id)) path.classList.add('is-selected')
  path.dataset.id = el.id
  svg.appendChild(path)
}

function hasConnectors() { return doc.elements.some(e => e.kind === 'connector') }

// ─── Tools ───────────────────────────────────────────────────────
function setTool(name) {
  tool = name
  root.querySelectorAll('.board-tool').forEach(b =>
    b.classList.toggle('is-active', b.dataset.tool === name || (name === 'rect' && b.dataset.tool === 'rect')))
  // pan/select cursor
  canvas.dataset.tool = name
  canvas.classList.toggle('is-pan', name === 'pan')
  canvas.classList.toggle('is-create', ['text', 'note', 'rect', 'ellipse', 'frame'].includes(name))
}

function toggleWrap(wrap) {
  const open = wrap.classList.contains('is-open')
  closeWraps()
  if (!open) wrap.classList.add('is-open')
}
function closeWraps() { root?.querySelectorAll('.board-tool-wrap.is-open').forEach(w => w.classList.remove('is-open')) }
function closeWrapsOnOutside(e) { if (!e.target.closest('.board-tool-wrap')) closeWraps() }

function topbarAction(act) {
  if (act === 'undo') return undo()
  if (act === 'redo') return redo()
  if (act === 'zoomin') { const r = freshRect(); return zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2) }
  if (act === 'zoomout') { const r = freshRect(); return zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2) }
  if (act === 'fit') return fitToScreen()
  if (act === 'export') return exportBoard()
}

// ─── Pointer interaction ─────────────────────────────────────────
function onCanvasPointerDown(e) {
  if (e.target.isContentEditable) return  // let text editing capture the click
  if (e.button === 1 || spaceHeld || tool === 'pan') { startPan(e); return }
  if (e.button !== 0) return
  freshRect()

  const hitNode = e.target.closest('.board-el')
  const w0 = screenToWorld(e.clientX, e.clientY)

  if (['text', 'note', 'rect', 'ellipse', 'frame'].includes(tool)) {
    createElementAt(tool, w0)
    return
  }
  if (tool === 'pen') { startPen(e, w0); return }
  if (tool === 'connector') { startConnector(e, w0, hitNode); return }

  // select tool
  if (hitNode) {
    const id = hitNode.dataset.id
    if (e.shiftKey) { sel.has(id) ? sel.delete(id) : sel.add(id) }
    else if (!sel.has(id)) { sel = new Set([id]) }
    refreshSelection()
    startMove(e)
  } else {
    if (!e.shiftKey) { sel = new Set(); refreshSelection() }
    startMarquee(e)
  }
}

function onOverlayPointerDown(e) {
  const anchor = e.target.closest('.board-anchor')
  if (anchor) { e.stopPropagation(); startConnectorFromAnchor(anchor.dataset.el, anchor.dataset.anchor, e); return }
  const handle = e.target.closest('.board-handle')
  if (handle) { e.stopPropagation(); startResize(e, handle.dataset.dir) }
}

function bindDrag(onMove, onUp) {
  drag = { onMove, onUp }
  hoverId = null; clearAnchors()
  window.addEventListener('pointermove', dragMove)
  window.addEventListener('pointerup', dragUp)
}
function dragMove(e) { drag?.onMove(e) }
function dragUp(e) {
  const d = drag; drag = null
  window.removeEventListener('pointermove', dragMove)
  window.removeEventListener('pointerup', dragUp)
  d?.onUp?.(e)
}

// Pan
function startPan(e) {
  const v = vp(); const sx = e.clientX, sy = e.clientY; const ox = v.x, oy = v.y
  canvas.classList.add('is-panning')
  bindDrag(
    ev => { v.x = ox + (ev.clientX - sx); v.y = oy + (ev.clientY - sy); applyViewport() },
    () => { canvas.classList.remove('is-panning'); scheduleSave() }
  )
}

// Move selection
function startMove(e) {
  const start = screenToWorld(e.clientX, e.clientY)
  const items = [...sel].map(id => { const el = findEl(id); return { el, x0: el.x, y0: el.y, pts: el.kind === 'pen' ? el.points.map(p => [...p]) : null } }).filter(i => i.el)
  let moved = false
  const conns = hasConnectors()
  bindDrag(
    ev => {
      const p = screenToWorld(ev.clientX, ev.clientY)
      const dx = p.x - start.x, dy = p.y - start.y
      if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true
      for (const it of items) {
        if (it.el.kind === 'pen') { it.el.points = it.pts.map(pt => [pt[0] + dx, pt[1] + dy]) }
        else { it.el.x = it.x0 + dx; it.el.y = it.y0 + dy; applyGeom(it.el) }
      }
      if (items.some(i => i.el.kind === 'pen')) redrawVectors()
      else if (conns) redrawVectors()
      updateOverlay()
    },
    () => { if (moved) commit() }
  )
}

// Marquee select
function startMarquee(e) {
  const box = document.createElement('div')
  box.className = 'board-marquee'
  overlay.appendChild(box)
  const sx = e.clientX, sy = e.clientY
  const r = canvasRect
  bindDrag(
    ev => {
      const x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY)
      const w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy)
      box.style.cssText = `left:${x - r.left}px;top:${y - r.top}px;width:${w}px;height:${h}px`
    },
    ev => {
      box.remove()
      const x0 = Math.min(sx, ev.clientX), y0 = Math.min(sy, ev.clientY)
      const x1 = Math.max(sx, ev.clientX), y1 = Math.max(sy, ev.clientY)
      if (Math.abs(x1 - x0) < 4 && Math.abs(y1 - y0) < 4) return
      const w0 = screenToWorld(x0, y0), w1 = screenToWorld(x1, y1)
      for (const el of doc.elements) {
        const b = worldBounds(el)
        if (b.x < w1.x && b.x + b.w > w0.x && b.y < w1.y && b.y + b.h > w0.y) sel.add(el.id)
      }
      refreshSelection()
    }
  )
}

// Resize (single selection)
function startResize(e, dir) {
  const id = [...sel][0]; const el = findEl(id); if (!el) return
  const b = worldBounds(el)
  const start = screenToWorld(e.clientX, e.clientY)
  const o = { x: b.x, y: b.y, w: b.w, h: b.h }
  const keepRatio = el.kind === 'image'
  const conns = hasConnectors()
  bindDrag(
    ev => {
      const p = screenToWorld(ev.clientX, ev.clientY)
      let dx = p.x - start.x, dy = p.y - start.y
      let nx = o.x, ny = o.y, nw = o.w, nh = o.h
      if (dir.includes('e')) nw = Math.max(20, o.w + dx)
      if (dir.includes('s')) nh = Math.max(20, o.h + dy)
      if (dir.includes('w')) { nw = Math.max(20, o.w - dx); nx = o.x + (o.w - nw) }
      if (dir.includes('n')) { nh = Math.max(20, o.h - dy); ny = o.y + (o.h - nh) }
      if (keepRatio && o.w && o.h) {
        const ratio = o.w / o.h
        if (dir === 'e' || dir === 'w') nh = nw / ratio
        else if (dir === 'n' || dir === 's') nw = nh * ratio
        else nh = nw / ratio
        if (dir.includes('n')) ny = o.y + (o.h - nh)
        if (dir.includes('w')) nx = o.x + (o.w - nw)
      }
      el.x = nx; el.y = ny; el.w = nw; el.h = nh
      applyGeom(el); if (conns) redrawVectors(); updateOverlay()
    },
    () => commit()
  )
}

// Pen
function startPen(e, w0) {
  const el = { id: uid(), kind: 'pen', points: [[w0.x, w0.y]], color: '#e6e6e6', width: 3, z: topZ() + 1 }
  doc.elements.push(el)
  bindDrag(
    ev => { const p = screenToWorld(ev.clientX, ev.clientY); el.points.push([p.x, p.y]); redrawVectors() },
    () => { if (el.points.length < 2) doc.elements.pop(); else { sel = new Set([el.id]); refreshSelection() } commit() }
  )
}

// Connector — shared drag: the endpoint follows the cursor and snaps to the nearest
// side anchor of whatever element it's dragged over (Miro-style), else stays a free point.
function beginConnectorDrag(from, sourceId, startPt) {
  const el = { id: uid(), kind: 'connector', from, to: { x: startPt.x, y: startPt.y }, style: 'arrow', color: '#9fb0c3', width: 2.5, z: topZ() + 1 }
  doc.elements.push(el)
  redrawVectors()
  bindDrag(
    ev => {
      const p = screenToWorld(ev.clientX, ev.clientY)
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.board-el')
      if (over && over.dataset.id !== sourceId) {
        const tb = worldBounds(findEl(over.dataset.id))
        const side = nearestAnchor(tb, p)
        el.to = { el: over.dataset.id, anchor: side }
        renderAnchors(over.dataset.id, { snap: side })
      } else {
        el.to = { x: p.x, y: p.y }
        clearAnchors()
      }
      redrawVectors()
    },
    () => {
      clearAnchors()
      const a = endpointResolve(el.from).pt, b = endpointResolve(el.to).pt
      if (!el.from.el && !el.to.el && Math.hypot(a.x - b.x, a.y - b.y) < 8) doc.elements.pop()
      else { sel = new Set([el.id]); refreshSelection() }
      commit()
    }
  )
}

// Connector TOOL: drag from anywhere (attaches to whole element on start).
function startConnector(e, w0, hitNode) {
  let from
  if (hitNode) { const b = worldBounds(findEl(hitNode.dataset.id)); from = { el: hitNode.dataset.id, anchor: nearestAnchor(b, w0) } }
  else from = { x: w0.x, y: w0.y }
  beginConnectorDrag(from, hitNode?.dataset.id, w0)
}

// Miro-style: drag straight from a hover connection dot — no tool needed.
function startConnectorFromAnchor(elId, side, e) {
  freshRect()
  sel = new Set(); refreshSelection()
  const start = anchorPoint(worldBounds(findEl(elId)), side)
  beginConnectorDrag({ el: elId, anchor: side }, elId, start)
}

function vectorPointerDown(e, el) {
  if (tool !== 'select') return
  e.stopPropagation()
  freshRect()
  if (e.shiftKey) { sel.has(el.id) ? sel.delete(el.id) : sel.add(el.id) }
  else sel = new Set([el.id])
  refreshSelection()
  if (el.kind === 'pen') startMove(e)
}

// ─── Element creation ────────────────────────────────────────────
function createElementAt(kind, w) {
  const z = topZ() + 1
  let el
  if (kind === 'text') el = { id: uid(), kind, x: w.x, y: w.y, text: '', color: '#e6e6e6', size: 22, z }
  else if (kind === 'note') el = { id: uid(), kind, x: w.x - 100, y: w.y - 80, w: 200, h: 160, text: '', color: NOTE_COLORS[0], z }
  else if (kind === 'rect') el = { id: uid(), kind, x: w.x - 100, y: w.y - 70, w: 200, h: 140, fill: 'rgba(255,255,255,0.05)', stroke: '#6BA3FF', z }
  else if (kind === 'ellipse') el = { id: uid(), kind, x: w.x - 90, y: w.y - 60, w: 180, h: 120, fill: 'rgba(255,255,255,0.05)', stroke: '#6BA3FF', z }
  else if (kind === 'frame') el = { id: uid(), kind, x: w.x - 200, y: w.y - 150, w: 400, h: 300, label: 'Frame', z }
  doc.elements.push(el)
  const node = buildDivNode(el)
  els.appendChild(node); nodeMap.set(el.id, node); applyGeom(el)
  sel = new Set([el.id]); refreshSelection()
  setTool('select')
  commit()
  if (kind === 'text') editText(el, node)
  else if (kind === 'note') editText(el, node.querySelector('.board-note-body'))
}

function editText(el, target) {
  target.setAttribute('contenteditable', 'true')
  target.classList.add('is-editing')
  target.focus()
  const range = document.createRange(); range.selectNodeContents(target); range.collapse(false)
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range)
  const done = () => {
    target.removeAttribute('contenteditable'); target.classList.remove('is-editing')
    el.text = target.textContent
    target.removeEventListener('blur', done)
    if (el.kind === 'text' && !el.text.trim()) { removeElement(el.id) }
    updateOverlay(); commit()
  }
  target.addEventListener('blur', done)
}

function editFrameLabel(el, target) {
  target.setAttribute('contenteditable', 'true'); target.focus()
  const done = () => { target.removeAttribute('contenteditable'); el.label = target.textContent || 'Frame'; target.removeEventListener('blur', done); commit() }
  target.addEventListener('blur', done)
}

// ─── Image sources ───────────────────────────────────────────────
async function addImageFrom(src) {
  if (src === 'library') return openLibraryPicker()
  if (src === 'files') return addImagesFromFiles()
  if (src === 'paste') return pasteImageFromClipboard()
}

async function placeImageAsset(assetRef, natW, natH) {
  const r = freshRect()
  const center = screenToWorld(r.left + r.width / 2, r.top + r.height / 2)
  const scale = natW ? Math.min(1, 360 / natW) : 1
  const w = natW ? Math.round(natW * scale) : 260, h = natH ? Math.round(natH * scale) : 200
  const el = { id: uid(), kind: 'image', asset: assetRef.asset, x: center.x - w / 2, y: center.y - h / 2, w, h, z: topZ() + 1 }
  doc.elements.push(el)
  const node = buildDivNode(el); els.appendChild(node); nodeMap.set(el.id, node); applyGeom(el)
  sel = new Set([el.id]); refreshSelection(); commit()
}

async function addImagesFromFiles() {
  const open = await getOpenDialog(); if (!open) return
  const picked = await open({ multiple: true, filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }] }).catch(() => null)
  if (!picked) return
  const paths = Array.isArray(picked) ? picked : [picked]
  for (const p of paths) {
    try {
      const ref = await api.addBoardAssetFromPath(boardId, p)
      const dim = await imageDims(imgSrcFromRef(ref))
      await placeImageAsset(ref, dim.w, dim.h)
    } catch (err) { log.error('add_file_failed', { error: err }) }
  }
}

function imgSrcFromRef(ref) { return IS_TAURI ? convertFileSrc(ref.abs) : ref.abs }

function imageDims(src) {
  return new Promise(res => {
    const img = new Image()
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => res({ w: 0, h: 0 })
    img.src = src
  })
}

async function pasteImageFromClipboard() {
  try {
    const items = await navigator.clipboard.read()
    for (const it of items) {
      const type = it.types.find(t => t.startsWith('image/'))
      if (type) {
        const blob = await it.getType(type)
        await addImageBlob(blob, type.split('/')[1] || 'png')
        return
      }
    }
    store.emit(events.SYSTEM_TOAST, { type: 'info', message: t('board.paste'), duration: 1500 })
  } catch (err) { log.warn('clipboard_read_failed', { error: String(err) }) }
}

async function addImageBlob(blob, ext) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const ref = await api.addBoardAssetFromData(boardId, bytes, ext)
  const dim = await imageDims(imgSrcFromRef(ref))
  await placeImageAsset(ref, dim.w, dim.h)
}

function onPaste(e) {
  if (!root || !document.body.contains(root)) return
  const editing = document.querySelector('.board-el .is-editing, .board-el[contenteditable="true"]')
  if (editing) return
  const items = e.clipboardData?.items || []
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const file = it.getAsFile()
      if (file) { e.preventDefault(); addImageBlob(file, it.type.split('/')[1] || 'png'); return }
    }
  }
  // URL paste → remote image, best-effort persist
  const text = e.clipboardData?.getData('text')?.trim()
  if (text && /^https?:\/\/\S+\.(png|jpe?g|webp|gif|avif|bmp)(\?\S*)?$/i.test(text)) {
    e.preventDefault(); addImageUrl(text)
  }
}

async function addImageUrl(url) {
  try {
    const resp = await fetch(url)
    const blob = await resp.blob()
    const ext = (blob.type.split('/')[1] || url.split('.').pop() || 'png').split('?')[0]
    await addImageBlob(blob, ext)
  } catch {
    // CORS or offline — keep the remote URL directly (won't be embedded on export)
    const r = freshRect(); const c = screenToWorld(r.left + r.width / 2, r.top + r.height / 2)
    const el = { id: uid(), kind: 'image', url, x: c.x - 130, y: c.y - 100, w: 260, h: 200, z: topZ() + 1 }
    doc.elements.push(el); const node = buildDivNode(el); els.appendChild(node); nodeMap.set(el.id, node); applyGeom(el)
    sel = new Set([el.id]); refreshSelection(); commit()
  }
}

async function onDrop(e) {
  e.preventDefault()
  const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'))
  for (const f of files) await addImageBlob(f, f.type.split('/')[1] || 'png')
}

// ── Library picker ──
// Searchable + lazily paginated so large libraries never block the UI (only ~60
// thumbnails load at a time, more on scroll). Search uses the server-side FTS index.
async function openLibraryPicker() {
  const PAGE = 60
  const modal = document.createElement('div')
  modal.className = 'board-lib-backdrop'
  modal.innerHTML = `
    <div class="board-lib">
      <div class="board-lib-head">
        <div class="board-lib-search-wrap">
          ${I('magnifying-glass', 16)}
          <input class="board-lib-search" type="text" placeholder="${escAttr(t('board.library_search'))}" spellcheck="false" />
          <button class="board-lib-color" title="${escAttr(t('board.filter_color'))}" aria-label="${escAttr(t('board.filter_color'))}">
            <span class="board-lib-color-dot"></span>
          </button>
        </div>
        <button class="board-lib-close" aria-label="Close">${I('x', 16)}</button>
      </div>
      <div class="board-lib-scroll">
        <div class="board-lib-grid"></div>
        <div class="board-lib-sentinel"></div>
        <div class="board-lib-empty" hidden>${t('board.library_empty')}</div>
      </div>
    </div>`
  root.appendChild(modal)
  requestAnimationFrame(() => modal.classList.add('is-open'))

  const grid = modal.querySelector('.board-lib-grid')
  const scroll = modal.querySelector('.board-lib-scroll')
  const sentinel = modal.querySelector('.board-lib-sentinel')
  const emptyEl = modal.querySelector('.board-lib-empty')
  const searchInput = modal.querySelector('.board-lib-search')
  const colorBtn = modal.querySelector('.board-lib-color')
  const colorDot = modal.querySelector('.board-lib-color-dot')

  let query = '', page = 0, loading = false, done = false, token = 0
  let colorFilter = null, colorTol = 'normal'

  function updateColorBtn() {
    if (colorFilter) { colorDot.style.background = colorFilter; colorBtn.classList.add('is-active') }
    else { colorDot.style.background = ''; colorBtn.classList.remove('is-active') }
  }
  colorBtn.addEventListener('click', e => {
    e.stopPropagation()
    openColorPicker(colorBtn, {
      initialColor: colorFilter, initialTolerance: colorTol,
      onSearch: (hex, tol) => { colorFilter = hex; colorTol = tol; updateColorBtn(); loadPage(true) },
      onClear: () => { colorFilter = null; updateColorBtn(); loadPage(true) },
    })
  })

  async function loadPage(reset) {
    if (loading || (done && !reset)) return
    loading = true
    const myToken = reset ? ++token : token
    if (reset) { page = 0; done = false; grid.innerHTML = ''; emptyEl.hidden = true }
    let items = []
    try {
      items = await api.listInspirations({ media_types: ['image', 'gif'], query: query || null, color: colorFilter, color_tolerance: colorTol, sort: 'recent', page, limit: PAGE })
    } catch (err) { log.error('lib_list_failed', { error: err }) }
    if (myToken !== token) { loading = false; return }  // a newer search superseded this
    if (items.length < PAGE) done = true
    for (const it of items) grid.appendChild(cell(it))
    page++
    loading = false
    emptyEl.hidden = grid.children.length > 0
    // if the first page didn't fill the scroll area, pull the next one
    if (!done && scroll.scrollHeight <= scroll.clientHeight + 40) loadPage(false)
  }

  function cell(it) {
    const thumb = it.thumbnail_path || it.stored_path
    const b = document.createElement('button')
    b.className = 'board-lib-cell'
    if (it.title) b.title = it.title
    const img = document.createElement('img')
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''
    img.src = IS_TAURI ? convertFileSrc(thumb) : thumb
    b.appendChild(img)
    b.addEventListener('click', async () => {
      close()
      try {
        const ref = await api.addBoardAssetFromPath(boardId, it.stored_path)
        const dim = await imageDims(imgSrcFromRef(ref))
        await placeImageAsset(ref, dim.w, dim.h)
      } catch (err) { log.error('lib_add_failed', { error: err }) }
    })
    return b
  }

  const io = new IntersectionObserver(es => { if (es[0].isIntersecting) loadPage(false) }, { root: scroll, rootMargin: '300px' })
  io.observe(sentinel)

  let searchTimer = null
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { query = searchInput.value.trim(); loadPage(true) }, 200)
  })

  const close = () => { io.disconnect(); modal.classList.remove('is-open'); setTimeout(() => modal.remove(), 240) }
  modal.querySelector('.board-lib-close').addEventListener('click', close)
  modal.addEventListener('pointerdown', e => { if (e.target === modal) close() })
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close() } })

  await loadPage(true)
  setTimeout(() => searchInput.focus(), 40)
}

// ─── Hover connection anchors (Miro-style) ───────────────────────
let hoverId = null

function onHover(e) {
  if (drag) return
  if (e.target.closest('.board-anchor') || e.target.closest('.board-handle')) return
  if (tool !== 'select') { if (hoverId) { hoverId = null; clearAnchors() } return }
  const node = e.target.closest('.board-el')
  const id = node ? node.dataset.id : null
  if (id !== hoverId) { hoverId = id; renderAnchors(id) }
}

function clearAnchors() { overlay?.querySelectorAll('.board-anchor').forEach(n => n.remove()) }

function renderAnchors(id, opts = {}) {
  clearAnchors()
  if (!id) return
  const el = findEl(id)
  if (!el || el.kind === 'pen' || el.kind === 'connector') return
  const v = vp(), b = worldBounds(el)
  for (const s of ANCHOR_SIDES) {
    const a = anchorPoint(b, s)
    const dot = document.createElement('div')
    dot.className = 'board-anchor' + (opts.snap === s ? ' is-snap' : '')
    dot.dataset.el = id; dot.dataset.anchor = s
    dot.style.left = (v.x + a.x * v.zoom) + 'px'
    dot.style.top = (v.y + a.y * v.zoom) + 'px'
    overlay.appendChild(dot)
  }
}

// ─── Selection overlay ───────────────────────────────────────────
function refreshSelection() {
  els.querySelectorAll('.board-el.is-selected').forEach(n => n.classList.remove('is-selected'))
  for (const id of sel) nodeMap.get(id)?.classList.add('is-selected')
  redrawVectors()  // reflect selected state on vectors
  updateOverlay()
}

function updateOverlay() {
  if (!overlay) return
  overlay.querySelectorAll('.board-selbox, .board-handle').forEach(n => n.remove())
  if (!sel.size) return
  const r = canvasRect || freshRect()
  // union of selected screen rects
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let count = 0
  for (const id of sel) {
    const rect = screenRectOf(id); if (!rect) continue
    count++
    minX = Math.min(minX, rect.left); minY = Math.min(minY, rect.top)
    maxX = Math.max(maxX, rect.right); maxY = Math.max(maxY, rect.bottom)
  }
  if (!count) return
  const box = document.createElement('div')
  box.className = 'board-selbox'
  box.style.cssText = `left:${minX - r.left}px;top:${minY - r.top}px;width:${maxX - minX}px;height:${maxY - minY}px`
  overlay.appendChild(box)
  // Resize handles only for a single div element
  if (sel.size === 1) {
    const el = findEl([...sel][0])
    if (el && el.kind !== 'pen' && el.kind !== 'connector' && el.kind !== 'text') {
      // Corner-only resize handles — the 4 side midpoints are reserved for connection anchors.
      for (const dir of ['nw', 'ne', 'se', 'sw']) {
        const h = document.createElement('div')
        h.className = `board-handle board-handle--${dir}`
        h.dataset.dir = dir
        overlay.appendChild(h)
      }
      positionHandles(minX - r.left, minY - r.top, maxX - minX, maxY - minY)
    }
  }
}

function positionHandles(x, y, w, h) {
  const pos = {
    nw: [x, y], n: [x + w / 2, y], ne: [x + w, y],
    e: [x + w, y + h / 2], se: [x + w, y + h], s: [x + w / 2, y + h],
    sw: [x, y + h], w: [x, y + h / 2],
  }
  overlay.querySelectorAll('.board-handle').forEach(hEl => {
    const [hx, hy] = pos[hEl.dataset.dir]
    hEl.style.left = hx + 'px'; hEl.style.top = hy + 'px'
  })
}

function screenRectOf(id) {
  const node = nodeMap.get(id)
  if (node) { const rr = node.getBoundingClientRect(); return { left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom } }
  // vector element
  const el = findEl(id); if (!el) return null
  const b = worldBounds(el); const v = vp(); const r = canvasRect || freshRect()
  return {
    left: r.left + v.x + b.x * v.zoom, top: r.top + v.y + b.y * v.zoom,
    right: r.left + v.x + (b.x + b.w) * v.zoom, bottom: r.top + v.y + (b.y + b.h) * v.zoom,
  }
}

// ─── Delete / edit commands ──────────────────────────────────────
function removeElement(id) {
  const i = doc.elements.findIndex(e => e.id === id)
  if (i >= 0) doc.elements.splice(i, 1)
  nodeMap.get(id)?.remove(); nodeMap.delete(id)
  sel.delete(id)
  // drop connectors that referenced it
  doc.elements = doc.elements.filter(e => !(e.kind === 'connector' && (e.from.el === id || e.to.el === id)))
  redrawVectors()
}

function deleteSelection() {
  if (!sel.size) return
  for (const id of [...sel]) removeElement(id)
  sel = new Set(); refreshSelection(); commit()
}

function bringToFront() { const tz = topZ(); for (const id of sel) { const el = findEl(id); if (el) { el.z = tz + 1; applyGeom(el) } } redrawVectors(); commit() }
function sendToBack() { const min = doc.elements.reduce((m, e) => Math.min(m, e.z || 0), 0); for (const id of sel) { const el = findEl(id); if (el) { el.z = min - 1; applyGeom(el) } } redrawVectors(); commit() }

// ─── Keyboard ────────────────────────────────────────────────────
function onKeyDown(e) {
  if (!root || !document.body.contains(root)) return
  const typing = e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'
  if (e.code === 'Space' && !typing) { spaceHeld = true; canvas.classList.add('is-pan'); e.preventDefault(); return }
  if (typing) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection() }
  else if (e.key === 'Escape') { if (sel.size) { sel = new Set(); refreshSelection() } else close() }
  else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); sel = new Set(doc.elements.map(el => el.id)); refreshSelection() }
  else if (e.key === 'v') setTool('select')
  else if (e.key === 'h') setTool('pan')
  else if (e.key === 't') setTool('text')
  else if (e.key === 'n') setTool('note')
  else if (e.key === 'p') setTool('pen')
  else if (e.key === 'c') setTool('connector')
  else if (e.key === ']') bringToFront()
  else if (e.key === '[') sendToBack()
}
function onKeyUp(e) { if (e.code === 'Space') { spaceHeld = false; canvas.classList.remove('is-pan') } }

// ─── History + autosave ──────────────────────────────────────────
function snapshot() { return JSON.stringify(doc) }
function commit() {
  history = history.slice(0, histIndex + 1)
  history.push(snapshot())
  if (history.length > 60) history.shift()
  histIndex = history.length - 1
  scheduleSave()
}
function loadSnapshot(s) {
  doc = JSON.parse(s)
  if (!doc.viewport) doc.viewport = { x: 0, y: 0, zoom: 1 }
  mountAll(); applyViewport(); refreshSelection()
}
function undo() { if (histIndex > 0) { histIndex--; sel = new Set(); loadSnapshot(history[histIndex]); scheduleSave() } }
function redo() { if (histIndex < history.length - 1) { histIndex++; sel = new Set(); loadSnapshot(history[histIndex]); scheduleSave() } }

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 600)
}
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null
  const thumb = doc.elements.find(e => e.kind === 'image' && e.asset)?.asset ?? null
  try { await api.saveBoard(boardId, JSON.stringify(doc), thumb, doc.elements.length) }
  catch (err) { log.error('save_failed', { error: err }) }
}

async function renameBoard(name) {
  boardName = name
  try { await api.renameBoard(boardId, name) } catch (err) { log.error('rename_failed', { error: err }) }
}

async function exportBoard() {
  await saveNow()
  const { save } = await import('@tauri-apps/plugin-dialog')
  const savePath = await save({ title: t('boards.export'), defaultPath: `${boardName}.qbord`, filters: [{ name: 'qooti Board', extensions: ['qbord'] }] }).catch(() => null)
  if (!savePath) return
  try { await api.exportBoard(boardId, savePath); sfx.success() }
  catch (err) { log.error('export_failed', { error: err }) }
}

// ─── Close ───────────────────────────────────────────────────────
async function close() {
  await saveNow()
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('keyup', onKeyUp, true)
  window.removeEventListener('paste', onPaste)
  document.removeEventListener('pointerdown', closeWrapsOnOutside, true)
  root.classList.remove('is-open')
  const el = root
  setTimeout(() => { el.remove() }, 300)
  root = null
  onCloseCb?.()
}

// ─── utils ───────────────────────────────────────────────────────
function escAttr(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') }
