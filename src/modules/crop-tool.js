// Crop in the image player (spec B). card-detail.js owns the player — the picture, its
// size on the stage, the panel's details — and opens this for one picture:
//  • the stage: a frame with 8 handles over the picture (its outside dimmed, thirds lines
//    while it moves), dragged by pointer zones (the handles only draw), or the keyboard;
//  • the panel: Aspect ratio (Free / 1:1 / 4:5 / 16:9 / 9:16), the size in pixels, Restore
//    original (items saved with Save), and Save as copy · Cancel · Save in fixed slots;
//  • the commands: crop_image / restore_original, and what each error means to a person.
// The frame is kept in pixels of the picture as shown (the stored file, EXIF applied) and
// drawn from four fractions on the stage (--cx --cy --cw --ch), so the hole in the shade
// and the frame move together and keep the same part of the picture when the window
// resizes. Motion follows the house rules: ease-out in, ease-in-out moves, exits shorter,
// a little give past the picture's edge, nothing travelling.

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { t } from './i18n.js'
import { makeLogger } from './logger.js'
import { reducedMotion } from './motion.js'
import { showConfirm } from './dialog.js'

const log = makeLogger('Crop')

const CROP_TYPES   = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
const CROP_EXT     = /\.(jpe?g|png|webp)$/i
export const CROP_MIN_SIDE = 64   // a smaller picture gets no crop button (B2), unless it's a saved crop

const MIN_PX       = 32      // the frame's shortest side: 32 picture px…
const MIN_SCREEN   = 40      // …or 40 screen px, whichever is larger (capped at the picture)
const RUBBER_K     = 0.25    // past the picture's edge the frame follows ¼ of the pointer…
const RUBBER_MAX   = 8       // …and never more than 8 px, then settles back
const CORNER_HALF  = 12      // a 24 × 24 zone centred on each corner
const SIDE_BAND    = 8       // ±8 px along each side
const KEY_STEP     = 0.01    // arrows: 1 % of the picture (at least 1 px)
const GRID_HIDE_MS = 400     // thirds lines stay this long after the last key
const HANDLES_MIN  = 72      // side handles hide on a side shorter than this (screen px)
const STAY         = 2 ** 31 - 1   // an error toast stays until it's closed

const PRESETS = [
  { id: 'free', r: null },
  { id: '1:1',  r: 1 },
  { id: '4:5',  r: 4 / 5 },
  { id: '16:9', r: 16 / 9 },
  { id: '9:16', r: 9 / 16 },
]
const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move',
}
const ERROR_TEXT = {
  unreadable:  'crop.err.unreadable',
  too_big:     'crop.err.too_big',
  too_small:   'crop.err.too_small',
  disk:        'crop.err.disk',
  unsupported: 'crop.err.unsupported',
}

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

// ─── Which pictures can be cropped ──────────────────────────────────
// Pictures Rust turned away as 'unsupported' (an animated WebP or PNG: the import stores
// them like still ones): no crop button for them again while the app is open
const _cantCrop = new Set()
const cantCropKey = item => `${item.id}\n${item.stored_path}`

/** JPEG, PNG and WebP pictures (by MIME type, else by the file's extension), at least
 *  64 px on both sides once `img` has loaded. A crop saved with Save keeps the button
 *  whatever its size: crop mode is where Restore original is. GIFs, videos, AVIF and
 *  HEIC: no. Rust has the last word (animated WebP and APNG come back as 'unsupported',
 *  and then the button goes). */
export function canCrop(item, img = null) {
  if (!item || item.type !== 'image') return false
  if (_cantCrop.has(cantCropKey(item))) return false
  const mime = String(item.mime_type || '').toLowerCase()
  const ok = mime ? CROP_TYPES.has(mime) : CROP_EXT.test(String(item.stored_path || '').split(/[?#]/)[0])
  if (!ok) return false
  if (img?.complete && img.naturalWidth) {
    return !!item.has_original || (img.naturalWidth >= CROP_MIN_SIDE && img.naturalHeight >= CROP_MIN_SIDE)
  }
  return true
}

// ─── Easing (the same curves as global.css) ─────────────────────────
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = t => ((ax * t + bx) * t + cx) * t
  const sy = t => ((ay * t + by) * t + cy) * t
  return p => {
    if (p <= 0) return 0
    if (p >= 1) return 1
    let lo = 0, hi = 1, t = p
    for (let i = 0; i < 24; i++) {
      if (sx(t) < p) lo = t; else hi = t
      t = (lo + hi) / 2
    }
    return sy(t)
  }
}
const EASE_MOVE = bezier(0.77, 0, 0.175, 1)   // moves: ease-in-out
const EASE_OUT  = bezier(0.22, 1, 0.36, 1)    // settling back: ease-out, no overshoot

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const wait  = ms => new Promise(r => setTimeout(r, ms))
const esc   = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Where a span of `size` near `start` sits inside 0…limit (centred when it's longer)
function span(start, size, limit) {
  return size >= limit ? (limit - size) / 2 : clamp(start, 0, limit - size)
}

// ─── Open ───────────────────────────────────────────────────────────
/**
 * ctx: {
 *   item, stage, media, panel, natW, natH, closeBtn,
 *   prepare(updated, mode) → Promise<prepared>   load the new picture before it's shown
 *   commit({ item, mode, frameRect, prepared, finish })   swap in the saved crop
 *   restored({ item, finish })                            show the original again
 *   reload() → Promise<{ item, natW, natH } | null>       after 'changed'
 *   show(id)                                              open another item ("Show")
 *   onClose(reason)   'cancel' | 'saved' | 'restored' | 'gone' | 'unsupported'
 * }
 * → { isOpen, isBusy, cancel, handleKey, destroy }
 */
export function openCrop(ctx) {
  const { stage, media, panel } = ctx
  // ✕ cancels the crop while it's open (the player stays), so meanwhile it's called Cancel
  const closeBtn   = ctx.closeBtn
  const closeLabel = closeBtn?.getAttribute('aria-label') ?? null
  closeBtn?.setAttribute('aria-label', t('action.cancel'))
  let item   = ctx.item
  let W      = ctx.natW
  let H      = ctx.natH
  let rect   = { x: 0, y: 0, w: W, h: H }   // where the frame is: always inside the picture
  let shown  = { ...rect }                  // where it's drawn (a little past an edge while dragged)
  let preset = 'free'
  let open   = true
  let busy   = false
  let drag   = null
  let tween  = 0
  let gridTimer = 0

  // ── Stage: the shade (clipped to the picture, rounded corners kept) and the frame ──
  const shade = document.createElement('div')
  shade.className = 'crop-shade'
  shade.innerHTML = '<div class="crop-hole"></div>'
  media.appendChild(shade)

  const layer = document.createElement('div')
  layer.className = 'crop-layer'
  layer.innerHTML = `
    <div class="crop-frame" tabindex="0" role="group" aria-label="${esc(t('crop.area'))}" aria-describedby="crop-size">
      <div class="crop-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      ${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(z => `<span class="crop-h crop-h--${z}" aria-hidden="true"></span>`).join('')}
    </div>`
  layer.style.width  = media.style.width
  layer.style.height = media.style.height
  media.after(layer)
  const frame = layer.querySelector('.crop-frame')

  // ── Panel: it swaps its content the way Edit does; the header row stays ──
  const ui = document.createElement('div')
  ui.className = 'crop-ui'
  ui.innerHTML = `
    <div class="crop-body">
      <section class="dp-section">
        <h3 class="dp-section-label" id="crop-aspect-label">${esc(t('crop.aspect'))}</h3>
        <div class="crop-presets" role="group" aria-labelledby="crop-aspect-label">
          ${PRESETS.map((p, i) => `
            <button type="button" class="crop-preset${p.id === preset ? ' is-active' : ''}" data-preset="${p.id}" aria-pressed="${p.id === preset}" style="--i:${i}">
              <span class="crop-preset-label">${p.id === 'free' ? esc(t('crop.free')) : p.id}</span>
              <span class="crop-preset-check">${I('check', 14)}</span>
            </button>`).join('')}
        </div>
      </section>
      <section class="dp-section">
        <h3 class="dp-section-label">${esc(t('crop.size'))}</h3>
        <p class="crop-size" id="crop-size"></p>
      </section>
      <div class="crop-restore-slot"></div>
    </div>
    <div class="crop-foot">
      <button type="button" class="crop-btn crop-btn--secondary" data-act="copy">${esc(t('crop.save_copy'))}</button>
      <div class="crop-foot-row">
        <button type="button" class="crop-btn crop-btn--ghost" data-act="cancel">${esc(t('action.cancel'))}</button>
        <button type="button" class="crop-btn crop-btn--primary" data-act="save">${esc(t('action.save'))}</button>
      </div>
    </div>
    <p class="dp-hint crop-hint"><kbd>Enter</kbd> ${esc(t('crop.hint_save'))} · <kbd>Esc</kbd> ${esc(t('crop.hint_cancel'))}</p>`
  panel.appendChild(ui)
  const sizeEl    = ui.querySelector('#crop-size')
  const copyBtn   = ui.querySelector('[data-act="copy"]')
  const cancelBtn = ui.querySelector('[data-act="cancel"]')
  const saveBtn   = ui.querySelector('[data-act="save"]')
  const presetBtns = [...ui.querySelectorAll('.crop-preset')]
  let restoreBtn  = null

  function renderRestore() {
    const slot = ui.querySelector('.crop-restore-slot')
    slot.innerHTML = item.has_original
      ? `<button type="button" class="dp-action crop-restore">${I('arrow-counter-clockwise', 14)}<span>${esc(t('crop.restore'))}</span></button>`
      : ''
    restoreBtn = slot.querySelector('.crop-restore')
    restoreBtn?.addEventListener('click', () => restore())
  }
  renderRestore()

  presetBtns.forEach(b => b.addEventListener('click', () => setPreset(b.dataset.preset)))
  copyBtn.addEventListener('click', () => save('copy'))
  saveBtn.addEventListener('click', () => save('replace'))
  cancelBtn.addEventListener('click', () => cancel())

  // ── Pointer: zones over the frame (the handles only draw) ──
  stage.addEventListener('pointerdown', onPointerDown)
  stage.addEventListener('pointermove', onPointerMove)
  stage.addEventListener('pointerup', onPointerUp)
  stage.addEventListener('pointercancel', onPointerUp)

  commitRect(rect)
  panel.classList.add('has-crop')
  void panel.offsetHeight   // the details' visible state is computed first, so they fade out
  panel.classList.add('is-cropping')
  stage.classList.add('is-cropping')
  requestAnimationFrame(() => {
    if (!open) return
    stage.classList.add('crop-in')
    ui.classList.add('is-in')
  })
  frame.focus({ preventScroll: true })

  // ── Geometry ──
  function ratio() { return PRESETS.find(p => p.id === preset)?.r ?? null }
  // Screen px per picture px
  function scale() { return (parseFloat(layer.style.width) || layer.getBoundingClientRect().width || W) / W }

  function minSize(k) {
    const m = Math.max(MIN_PX, MIN_SCREEN / k)
    return { w: Math.min(W, m), h: Math.min(H, m) }
  }

  // How far the frame shows past the picture's edge for an overshoot of `over` picture px
  function rubber(over, k) {
    if (!(over > 0) || reducedMotion()) return 0
    return Math.min(over * k * RUBBER_K, RUBBER_MAX) / k
  }

  // Edges rounded, as Rust rounds them (so the size shown is the size saved)
  function pixelRect(r) {
    const x0 = clamp(Math.round(r.x), 0, W), y0 = clamp(Math.round(r.y), 0, H)
    const x1 = clamp(Math.round(r.x + r.w), 0, W), y1 = clamp(Math.round(r.y + r.h), 0, H)
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
  }

  // Nothing to save while the frame is still the whole picture
  function canSave() {
    const p = pixelRect(rect)
    return p.w > 0 && p.h > 0 && !(p.x0 === 0 && p.y0 === 0 && p.x1 === W && p.y1 === H)
  }

  function draw(r) {
    shown = r
    const s = stage.style
    s.setProperty('--cx', (r.x / W).toFixed(6))
    s.setProperty('--cy', (r.y / H).toFixed(6))
    s.setProperty('--cw', (r.w / W).toFixed(6))
    s.setProperty('--ch', (r.h / H).toFixed(6))
    const k = scale()
    frame.classList.toggle('no-ns', r.w * k < HANDLES_MIN)
    frame.classList.toggle('no-ew', r.h * k < HANDLES_MIN)
  }

  function commitRect(r) {
    rect = r
    draw(r)
    updateReadout()
  }

  function updateReadout() {
    const p = pixelRect(rect)
    sizeEl.textContent = t('crop.size_value', { w: p.w, h: p.h })
    if (!busy) {
      const ok = canSave()
      saveBtn.disabled = !ok
      copyBtn.disabled = !ok
    }
  }

  function stopTween() {
    if (!tween) return
    cancelAnimationFrame(tween)
    tween = 0
    draw(rect)
  }

  // The frame moves to `target` (which is where it is from now on: the size, the buttons
  // and the next key press use it at once)
  function tweenTo(target, dur, ease) {
    cancelAnimationFrame(tween)
    tween = 0
    rect = target
    updateReadout()
    if (dur <= 0 || reducedMotion()) { draw(target); return }
    const from = { ...shown }
    const t0 = performance.now()
    const step = now => {
      const p = Math.min(1, (now - t0) / dur)
      const e = ease(p)
      draw({
        x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e,
        w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e,
      })
      tween = p < 1 ? requestAnimationFrame(step) : 0
    }
    tween = requestAnimationFrame(step)
  }

  // ── Presets ──
  // The largest frame of that shape (in picture pixels) that fits, centred on the current
  // frame's centre, then shifted to stay inside. Back to Free: the frame stays.
  function setPreset(id) {
    if (!open || busy || !PRESETS.some(p => p.id === id)) return
    preset = id
    for (const b of presetBtns) {
      const on = b.dataset.preset === id
      b.classList.toggle('is-active', on)
      b.setAttribute('aria-pressed', String(on))
    }
    const r = ratio()
    if (r) {
      const [w, h] = W / H > r ? [H * r, H] : [W, W / r]
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
      tweenTo({ x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h }, 220, EASE_MOVE)
    }
    frame.focus({ preventScroll: true })   // so Enter saves
  }

  // ── Dragging ──
  function zoneAt(px, py, L) {
    const fx = shown.x / W * L.width, fy = shown.y / H * L.height
    const fw = shown.w / W * L.width, fh = shown.h / H * L.height
    // Small frame: the zones shrink to a quarter of it, so moving always stays possible
    const c = Math.min(CORNER_HALF, fw / 4, fh / 4)
    const b = Math.min(SIDE_BAND, fw / 4, fh / 4)
    const left = Math.abs(px - fx) <= c, right = Math.abs(px - (fx + fw)) <= c
    const top = Math.abs(py - fy) <= c, bottom = Math.abs(py - (fy + fh)) <= c
    if (top && left) return 'nw'
    if (top && right) return 'ne'
    if (bottom && left) return 'sw'
    if (bottom && right) return 'se'
    const inX = px >= fx && px <= fx + fw, inY = py >= fy && py <= fy + fh
    if (inX && Math.abs(py - fy) <= b) return 'n'
    if (inX && Math.abs(py - (fy + fh)) <= b) return 's'
    if (inY && Math.abs(px - fx) <= b) return 'w'
    if (inY && Math.abs(px - (fx + fw)) <= b) return 'e'
    return inX && inY ? 'move' : null
  }

  function onPointerDown(e) {
    if (!open || busy || e.button !== 0) return
    const L = layer.getBoundingClientRect()
    if (!L.width) return
    const zone = zoneAt(e.clientX - L.left, e.clientY - L.top, L)
    if (!zone) return
    e.preventDefault()
    stopTween()
    drag = { zone, r0: { ...rect }, x0: e.clientX, y0: e.clientY, k: L.width / W, id: e.pointerId }
    try { stage.setPointerCapture(e.pointerId) } catch {}
    stage.style.cursor = CURSORS[zone]
    layer.classList.add('is-adjusting')
    frame.focus({ preventScroll: true })
  }

  function onPointerMove(e) {
    if (!open) return
    if (drag) {
      if (e.pointerId !== drag.id) return
      const dX = (e.clientX - drag.x0) / drag.k
      const dY = (e.clientY - drag.y0) / drag.k
      const next = dragRect(drag.zone, drag.r0, dX, dY, drag.k, e.shiftKey)
      rect = next.settled
      draw(next.shown)   // follows the pointer 1:1, no tween while held
      updateReadout()
      return
    }
    if (busy) { stage.style.cursor = ''; return }
    const L = layer.getBoundingClientRect()
    const zone = L.width ? zoneAt(e.clientX - L.left, e.clientY - L.top, L) : null
    stage.style.cursor = zone ? CURSORS[zone] : ''
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return
    drag = null
    try { if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId) } catch {}
    layer.classList.remove('is-adjusting')
    // Past the picture's edge: it settles back inside
    if (shown.x !== rect.x || shown.y !== rect.y || shown.w !== rect.w || shown.h !== rect.h) tweenTo(rect, 220, EASE_OUT)
  }

  function dragRect(zone, r0, dX, dY, k, shift) {
    const min = minSize(k)
    if (zone === 'move') {
      const mx = slide(r0.x + dX, W - r0.w, k), my = slide(r0.y + dY, H - r0.h, k)
      return { settled: { x: mx.v, y: my.v, w: r0.w, h: r0.h }, shown: { x: mx.s, y: my.s, w: r0.w, h: r0.h } }
    }
    const corner = zone.length === 2
    // Free: Shift on a corner keeps the frame's current shape
    const r = ratio() ?? (corner && shift ? r0.w / r0.h : null)
    if (!r) return freeResize(zone, r0, dX, dY, k, min)
    return corner ? ratioCorner(zone, r0, dX, dY, k, min, r) : ratioSide(zone, r0, dX, dY, k, min, r)
  }

  // A position kept in 0…hi; past either edge it shows a little way out
  function slide(v, hi, k) {
    if (v < 0) return { v: 0, s: -rubber(-v, k) }
    if (v > hi) return { v: hi, s: hi + rubber(v - hi, k) }
    return { v, s: v }
  }

  // Free: each dragged side on its own. The picture's edge gives a little; the minimum
  // size is a hard stop.
  function freeResize(zone, r0, dX, dY, k, min) {
    let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h
    let sx0 = x0, sy0 = y0, sx1 = x1, sy1 = y1
    if (zone.includes('w')) [x0, sx0] = lowEdge(x0 + dX, Math.max(0, x1 - min.w), k)
    if (zone.includes('e')) [x1, sx1] = highEdge(x1 + dX, Math.min(W, x0 + min.w), W, k)
    if (zone.includes('n')) [y0, sy0] = lowEdge(y0 + dY, Math.max(0, y1 - min.h), k)
    if (zone.includes('s')) [y1, sy1] = highEdge(y1 + dY, Math.min(H, y0 + min.h), H, k)
    return {
      settled: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      shown:   { x: sx0, y: sy0, w: sx1 - sx0, h: sy1 - sy0 },
    }
  }
  function lowEdge(v, max, k) {
    if (v > max) return [max, max]
    if (v < 0) return [0, -rubber(-v, k)]
    return [v, v]
  }
  function highEdge(v, min, limit, k) {
    if (v < min) return [min, min]
    if (v > limit) return [limit, limit + rubber(v - limit, k)]
    return [v, v]
  }

  // A corner with a shape: the opposite corner stays, the frame follows whichever of the
  // pointer's two directions gives the larger frame
  function ratioCorner(zone, r0, dX, dY, k, min, r) {
    const east = zone.includes('e'), south = zone.includes('s')
    const ax = east ? r0.x : r0.x + r0.w
    const ay = south ? r0.y : r0.y + r0.h
    const cx = (east ? r0.x + r0.w : r0.x) + dX
    const cy = (south ? r0.y + r0.h : r0.y) + dY
    const want = Math.max(east ? cx - ax : ax - cx, (south ? cy - ay : ay - cy) * r)
    const roomW = east ? W - ax : ax
    const roomH = south ? H - ay : ay
    const maxW = Math.min(roomW, roomH * r)
    const minW = Math.min(maxW, Math.max(min.w, min.h * r))
    const w = clamp(want, minW, maxW)
    let sw = w
    if (want > maxW) {
      sw = roomH * r < roomW
        ? (roomH + rubber(want / r - roomH, k)) * r
        : roomW + rubber(want - roomW, k)
    }
    const at = ww => ({ x: east ? ax : ax - ww, y: south ? ay : ay - ww / r, w: ww, h: ww / r })
    return { settled: at(w), shown: at(sw) }
  }

  // A side with a shape: that side moves; the other dimension follows, centred on the
  // frame's centre line, and stays inside the picture
  function ratioSide(zone, r0, dX, dY, k, min, r) {
    if (zone === 'e' || zone === 'w') {
      const left = r0.x, right = r0.x + r0.w, mid = r0.y + r0.h / 2
      const want = zone === 'e' ? r0.w + dX : r0.w - dX
      const roomW = zone === 'e' ? W - left : right
      const maxW = Math.min(roomW, H * r)
      const minW = Math.min(maxW, Math.max(min.w, min.h * r))
      const w = clamp(want, minW, maxW)
      let sw = w
      if (want > maxW) sw = H * r < roomW ? (H + rubber(want / r - H, k)) * r : roomW + rubber(want - roomW, k)
      const at = ww => ({ x: zone === 'e' ? left : right - ww, y: span(mid - ww / r / 2, ww / r, H), w: ww, h: ww / r })
      return { settled: at(w), shown: at(sw) }
    }
    const top = r0.y, bottom = r0.y + r0.h, mid = r0.x + r0.w / 2
    const want = zone === 's' ? r0.h + dY : r0.h - dY
    const roomH = zone === 's' ? H - top : bottom
    const maxH = Math.min(roomH, W / r)
    const minH = Math.min(maxH, Math.max(min.h, min.w / r))
    const h = clamp(want, minH, maxH)
    let sh = h
    if (want > maxH) sh = W / r < roomH ? (W + rubber(want * r - W, k)) / r : roomH + rubber(want - roomH, k)
    const at = hh => ({ x: span(mid - hh * r / 2, hh * r, W), y: zone === 's' ? top : bottom - hh, w: hh * r, h: hh })
    return { settled: at(h), shown: at(sh) }
  }

  // ── Keyboard ──
  function flashGrid() {
    layer.classList.add('is-adjusting')
    clearTimeout(gridTimer)
    gridTimer = setTimeout(() => { if (!drag) layer.classList.remove('is-adjusting') }, GRID_HIDE_MS)
  }

  function onArrow(e) {
    const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
    stopTween()
    const stepX = Math.max(1, KEY_STEP * W), stepY = Math.max(1, KEY_STEP * H)
    if (!e.shiftKey) {
      commitRect({ ...rect, x: clamp(rect.x + dx * stepX, 0, W - rect.w), y: clamp(rect.y + dy * stepY, 0, H - rect.h) })
    } else {
      // Shift: the right side (← →) or the bottom side (↑ ↓) out or in. With a shape, the
      // bottom-right corner moves and the shape is kept.
      const min = minSize(scale())
      const r = ratio()
      const { x, y, w, h } = rect
      if (r) {
        const maxW = Math.min(W - x, (H - y) * r)
        const minW = Math.min(maxW, Math.max(min.w, min.h * r))
        const nw = clamp(dx ? w + dx * stepX : (h + dy * stepY) * r, minW, maxW)
        commitRect({ x, y, w: nw, h: nw / r })
      } else if (dx) {
        commitRect({ x, y, h, w: clamp(w + dx * stepX, Math.min(min.w, W - x), W - x) })
      } else {
        commitRect({ x, y, w, h: clamp(h + dy * stepY, Math.min(min.h, H - y), H - y) })
      }
    }
    flashGrid()
  }

  // Tab: frame → presets → Restore original → Save as copy → Cancel → Save → ✕
  function cycleFocus(dir) {
    const list = [frame, ...presetBtns, restoreBtn, copyBtn, cancelBtn, saveBtn, ctx.closeBtn]
      .filter(el => el?.isConnected && !el.disabled && el.getClientRects().length)
    if (!list.length) return
    const i = list.indexOf(document.activeElement)
    const next = i === -1 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length
    list[next].focus()
  }

  // Called by the player for every key while cropping. Nothing else in the player reacts
  // meanwhile (← → don't browse; C does nothing).
  function handleKey(e) {
    if (!open) return false
    const k = e.key
    if (k === 'Escape') {
      e.preventDefault()
      if (!busy) cancel()
      return true
    }
    if (busy) {
      if (k === 'Tab' || k === 'Enter' || k === ' ' || k.startsWith('Arrow')) e.preventDefault()
      return true
    }
    if (k === 'Tab') {
      e.preventDefault()
      cycleFocus(e.shiftKey ? -1 : 1)
      return true
    }
    if (k === 'Enter') {
      const a = document.activeElement
      if (a?.tagName === 'BUTTON' || a?.tagName === 'A') return true   // buttons keep their own Enter
      e.preventDefault()
      if (canSave()) save('replace')
      return true
    }
    if (k.startsWith('Arrow') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      onArrow(e)
      return true
    }
    return true
  }

  // ── Save, Save as copy ──
  function setBusy(on, which = null) {
    busy = on
    layer.classList.toggle('is-busy', on)
    if (on) stage.style.cursor = ''
    for (const b of ui.querySelectorAll('button')) b.disabled = on
    if (on) {
      if (which === 'copy') copyBtn.textContent = t('crop.saving')
      if (which === 'replace') saveBtn.textContent = t('crop.saving')
    } else {
      copyBtn.textContent = t('crop.save_copy')
      saveBtn.textContent = t('action.save')
      updateReadout()
    }
  }

  function toastError(key) {
    store.emit(events.SYSTEM_TOAST, { type: 'error', message: t(key), key: 'crop-error', duration: STAY })
  }

  async function save(mode) {
    if (!open || busy || !canSave()) return
    stopTween()
    // Fractions of the picture as shown, kept inside 0…1 (Rust refuses anything outside)
    const x = clamp(rect.x / W, 0, 1), y = clamp(rect.y / H, 0, 1)
    const args = { id: item.id, x, y, w: clamp(rect.w / W, 0, 1 - x), h: clamp(rect.h / H, 0, 1 - y), mode }
    setBusy(true, mode)
    let updated
    try {
      updated = await api.cropImage(args)
    } catch (err) {
      if (!open) return
      setBusy(false)
      onCropError(err, mode)
      return
    }
    if (!open) return
    const p = pixelRect(rect)
    log.info(mode === 'copy' ? 'saved_copy' : 'cropped', { id: item.id, ...(mode === 'copy' ? { copy: updated?.id } : {}), size: `${p.w}x${p.h}` })
    let prepared = null
    try { prepared = await ctx.prepare(updated, mode) } catch (err) { log.warn('crop_preload_failed', { id: item.id, error: err }) }
    if (!open) return
    // The crop lines go first; the dimmed outside stays until the new picture covers it
    layer.classList.add('is-leaving')
    await wait(reducedMotion() ? 0 : 120)
    if (!open) return
    const frameRect = frame.getBoundingClientRect()
    try {
      await ctx.commit({ item: updated, mode, frameRect, prepared, finish: () => close('saved', { stageNow: true }) })
    } catch (err) {
      log.error('crop_show_failed', { id: item.id, error: err })
    }
    if (open) close('saved', { stageNow: true })   // saved either way: crop mode ends
  }

  function onCropError(err, mode) {
    const code = String(err?.message ?? err ?? '')
    log.warn('crop_failed', { id: item.id, mode, error: code })
    if (code.startsWith('already_saved:')) {
      const other = code.slice('already_saved:'.length)
      store.emit(events.SYSTEM_TOAST, {
        type: 'info',
        message: t('import.already_one'),
        key: 'import-already',
        action: other ? { label: t('import.show'), onClick: () => ctx.show?.(other) } : null,
      })
      close('cancel')
      return
    }
    if (code === 'busy' || code === 'no_change') { frame.focus({ preventScroll: true }); return }
    if (code === 'not_found') {
      toastError('crop.err.gone')
      close('gone', { animate: false })
      return
    }
    if (code === 'changed') {
      toastError('crop.err.changed')
      reloadAfterChange()
      return
    }
    if (code === 'unsupported') {
      // An animated WebP or PNG: no retry can work, so crop mode closes and the button goes
      _cantCrop.add(cantCropKey(item))
      toastError(ERROR_TEXT.unsupported)
      close('unsupported')
      return
    }
    toastError(ERROR_TEXT[code] ?? 'crop.err.generic')
    frame.focus({ preventScroll: true })
  }

  // 'changed': the item's picture changed meanwhile. The player shows the item as it is
  // now, and the frame starts again from its whole picture.
  async function reloadAfterChange() {
    setBusy(true)
    let fresh = null
    try { fresh = await ctx.reload?.() } catch (err) { log.warn('crop_reload_failed', { id: item.id, error: err }) }
    if (!open) return
    setBusy(false)
    if (!fresh) return
    item = fresh.item ?? item
    if (fresh.natW > 0 && fresh.natH > 0) { W = fresh.natW; H = fresh.natH }
    renderRestore()
    setPreset('free')
    stopTween()
    commitRect({ x: 0, y: 0, w: W, h: H })
    frame.focus({ preventScroll: true })
  }

  // ── Restore original ──
  async function restore() {
    if (!open || busy || !item.has_original) return
    const ok = await showConfirm({
      title: t('crop.restore_title'),
      message: t('crop.restore_msg'),
      confirmLabel: t('crop.restore_ok'),
      cancelLabel: t('action.cancel'),
    })
    if (!open) return
    if (!ok) { restoreBtn?.focus(); return }
    setBusy(true, 'restore')
    let updated
    try {
      updated = await api.restoreOriginal(item.id)
    } catch (err) {
      if (!open) return
      setBusy(false)
      const code = String(err?.message ?? err ?? '')
      log.warn('restore_failed', { id: item.id, error: code })
      if (code === 'not_found') {
        toastError('crop.err.gone')
        close('gone', { animate: false })
        return
      }
      toastError(code === 'original_missing' ? 'crop.err.original_missing' : 'crop.err.restore')
      restoreBtn?.focus()
      return
    }
    if (!open) return
    log.info('restored', { id: item.id })
    try {
      await ctx.restored({ item: updated, finish: () => close('restored') })
    } catch (err) {
      log.error('restore_show_failed', { id: item.id, error: err })
    }
    if (open) close('restored')
  }

  // ── Cancel / close ──
  function cancel() {
    if (!open || busy) return
    close('cancel')
  }

  // ✕ is Close again (after a save the panel has a new ✕, which says Close already)
  function giveBackClose() {
    if (closeBtn?.isConnected && closeLabel != null) closeBtn.setAttribute('aria-label', closeLabel)
  }

  // The crop UI leaves: the panel's details come back under its controls as they fade.
  // stageNow: the frame and the shade go at once (a saved crop's picture is swapped in
  // the same frame).
  function close(reason, { animate = true, stageNow = false } = {}) {
    if (!open) return
    open = false
    busy = false
    drag = null
    cancelAnimationFrame(tween)
    clearTimeout(gridTimer)
    stage.removeEventListener('pointerdown', onPointerDown)
    stage.removeEventListener('pointermove', onPointerMove)
    stage.removeEventListener('pointerup', onPointerUp)
    stage.removeEventListener('pointercancel', onPointerUp)
    stage.style.cursor = ''
    stage.classList.remove('crop-in', 'is-cropping')
    panel.classList.remove('is-cropping')
    giveBackClose()
    ui.classList.remove('is-in')
    ui.classList.add('is-out')
    const quick = !animate || reducedMotion()
    const removeStage = () => {
      shade.remove()
      layer.remove()
      if (!stage.querySelector('.crop-layer')) ['--cx', '--cy', '--cw', '--ch'].forEach(v => stage.style.removeProperty(v))
    }
    const removePanel = () => {
      ui.remove()
      if (!panel.querySelector('.crop-ui')) panel.classList.remove('has-crop')
    }
    if (stageNow || quick) removeStage()
    else setTimeout(removeStage, 140)
    if (quick) removePanel()
    else setTimeout(removePanel, 140)
    ctx.onClose?.(reason)
  }

  // The player went away (closed, or opened another item): no motion, no callbacks
  function destroy() {
    if (!open) return
    open = false
    cancelAnimationFrame(tween)
    clearTimeout(gridTimer)
    stage.removeEventListener('pointerdown', onPointerDown)
    stage.removeEventListener('pointermove', onPointerMove)
    stage.removeEventListener('pointerup', onPointerUp)
    stage.removeEventListener('pointercancel', onPointerUp)
    shade.remove()
    layer.remove()
    ui.remove()
    stage.classList.remove('crop-in', 'is-cropping')
    panel.classList.remove('is-cropping', 'has-crop')
    giveBackClose()
  }

  return {
    isOpen: () => open,
    isBusy: () => busy,
    cancel,
    handleKey,
    destroy,
  }
}
