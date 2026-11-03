// Canvas-based HSV color picker popover.
// Usage: openColorPicker(anchorEl, { initialColor, initialTolerance, onSearch, onClear })

import { t } from './i18n.js'

const RECENT_KEY = 'qooti-recent-colors'
let activePopover = null

// ─── Color math ──────────────────────────────────────────────────
function hsvToRgb(h, s, v) {
  s /= 100; v /= 100
  const c = v * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if      (h < 60)  { r=c; g=x; }
  else if (h < 120) { r=x; g=c; }
  else if (h < 180) { g=c; b=x; }
  else if (h < 240) { g=x; b=c; }
  else if (h < 300) { r=x; b=c; }
  else              { r=c; b=x; }
  return { r: Math.round((r+m)*255), g: Math.round((g+m)*255), b: Math.round((b+m)*255) }
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min
  let h = 0
  const s = max === 0 ? 0 : d / max
  const v = max
  if (max !== min) {
    if      (max === r) h = ((g-b)/d + (g<b?6:0)) / 6
    else if (max === g) h = ((b-r)/d + 2) / 6
    else                h = ((r-g)/d + 4) / 6
  }
  return { h: h*360, s: s*100, v: v*100 }
}

function toHex({ r, g, b }) {
  return '#' + [r,g,b].map(n => Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0')).join('')
}

function fromHex(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : null
}

function isHex(s) { return /^#[0-9a-fA-F]{6}$/.test(s) }

// ─── Recent colors (localStorage) ────────────────────────────────
function getRecents() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { return [] }
}
function addRecent(hex) {
  const arr = [hex, ...getRecents().filter(c => c !== hex)].slice(0, 6)
  localStorage.setItem(RECENT_KEY, JSON.stringify(arr))
}

// ─── Public API ───────────────────────────────────────────────────
// Opens under the search bar at its full width (anchor = the colour button inside it).
export function openColorPicker(anchor, { initialColor = null, initialTolerance = 'normal', onSearch, onClear } = {}) {
  if (activePopover) { activePopover._close(); activePopover = null }

  // Initial color state in HSV
  let hsv = { h: 0, s: 100, v: 50 }
  if (initialColor) {
    const rgb = fromHex(initialColor)
    if (rgb) hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
  }

  // Colour-match tolerance has no control in this layout; the current one is kept
  // and travels with the colour on Search.
  const tolerance = ['strict', 'normal', 'broad'].includes(initialTolerance) ? initialTolerance : 'normal'

  // ── Build DOM ──
  const el = document.createElement('div')
  el.className = 'cp-popover'
  el.innerHTML = `
    <div class="cp-canvas-wrap">
      <canvas class="cp-canvas"></canvas>
      <div class="cp-cursor"></div>
    </div>
    <input type="range" class="cp-hue" min="0" max="360" step="1" aria-label="${t('cp.hue')}" />
    <div class="cp-bar">
      <label class="cp-hex-pill">
        <span class="cp-preview"></span>
        <input class="cp-hex" maxlength="7" spellcheck="false" aria-label="${t('cp.hex')}" />
      </label>
      <button class="cp-add" title="${t('cp.save_colour')}" aria-label="${t('cp.save_colour')}">
        <span class="icon icon-14" style="mask-image:url('/icons/plus.svg');-webkit-mask-image:url('/icons/plus.svg')" aria-hidden="true"></span>
      </button>
      <div class="cp-recents"></div>
      <span class="cp-spacer"></span>
      ${initialColor ? `<button class="cp-clear">${t('cp.clear')}</button>` : ''}
      <button class="cp-search">${t('cp.search')}</button>
    </div>
  `

  document.getElementById('overlays').appendChild(el)
  activePopover = el

  // ── Element refs ──
  const wrap      = el.querySelector('.cp-canvas-wrap')
  const canvas    = el.querySelector('.cp-canvas')
  const cursorEl  = el.querySelector('.cp-cursor')
  const hueSlider = el.querySelector('.cp-hue')
  const hexInput  = el.querySelector('.cp-hex')
  const preview   = el.querySelector('.cp-preview')
  const recentsEl = el.querySelector('.cp-recents')

  // ── Position: under the search bar, same left edge and width ──
  const bar = (anchor.closest('.top-bar-search-wrap') ?? anchor).getBoundingClientRect()
  const width = Math.max(320, bar.width)
  el.style.width = `${width}px`
  el.style.left  = `${Math.max(8, Math.min(bar.left, window.innerWidth - width - 8))}px`
  el.style.top   = `${bar.bottom + 6}px`

  // Colour field: wide, about 0.38 of its width tall; drawn at device resolution.
  const fieldW = width - 18   // popover padding 8 × 2 + border
  const fieldH = Math.round(Math.min(220, Math.max(150, fieldW * 0.38)))
  wrap.style.height = `${fieldH}px`
  const dpr = window.devicePixelRatio || 1
  canvas.width  = Math.round(fieldW * dpr)
  canvas.height = Math.round(fieldH * dpr)
  const ctx = canvas.getContext('2d')

  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect()
    if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, bar.top - r.height - 8)}px`
  })

  // ── Draw canvas ──
  function draw() {
    const W = canvas.width, H = canvas.height
    const { r, g, b } = hsvToRgb(hsv.h, 100, 100)

    // Horizontal: white → pure hue
    const gH = ctx.createLinearGradient(0, 0, W, 0)
    gH.addColorStop(0, '#fff')
    gH.addColorStop(1, `rgb(${r},${g},${b})`)
    ctx.fillStyle = gH
    ctx.fillRect(0, 0, W, H)

    // Vertical overlay: transparent → black
    const gV = ctx.createLinearGradient(0, 0, 0, H)
    gV.addColorStop(0, 'rgba(0,0,0,0)')
    gV.addColorStop(1, '#000')
    ctx.fillStyle = gV
    ctx.fillRect(0, 0, W, H)

    // Cursor (CSS px), kept inside the rounded field
    const inset = 6
    cursorEl.style.left = `${inset + (hsv.s / 100) * (fieldW - inset * 2)}px`
    cursorEl.style.top  = `${inset + (1 - hsv.v / 100) * (fieldH - inset * 2)}px`

    // Sync controls (don't overwrite the hex while it's being typed)
    const hex = toHex(hsvToRgb(hsv.h, hsv.s, hsv.v))
    preview.style.background = hex
    if (document.activeElement !== hexInput) hexInput.value = hex
  }

  // ── Canvas drag ──
  let dragging = false
  function pickAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect()
    hsv.s = Math.max(0, Math.min(100, ((clientX - r.left) / r.width)  * 100))
    hsv.v = Math.max(0, Math.min(100, (1 - (clientY - r.top) / r.height) * 100))
    draw()
  }
  function onMouseMove(e) { if (dragging) pickAt(e.clientX, e.clientY) }
  function onMouseUp()    { dragging = false }

  wrap.addEventListener('mousedown', e => { dragging = true; pickAt(e.clientX, e.clientY) })
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup',   onMouseUp)

  // ── Hue slider ──
  hueSlider.value = Math.round(hsv.h)
  hueSlider.addEventListener('input', () => { hsv.h = +hueSlider.value; draw() })

  // ── Hex input ──
  hexInput.addEventListener('input', () => {
    const val = hexInput.value.startsWith('#') ? hexInput.value : '#' + hexInput.value
    if (isHex(val)) {
      const rgb = fromHex(val)
      hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
      hueSlider.value = Math.round(hsv.h)
      draw()
    }
  })
  hexInput.addEventListener('blur', draw)
  hexInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('.cp-search').click() })

  // ── Saved colours (+ saves the current one; they appear next to it) ──
  function renderRecents() {
    recentsEl.innerHTML = ''
    for (const c of getRecents().slice(0, 5)) {
      const btn = document.createElement('button')
      btn.className = 'cp-recent-swatch'
      btn.style.background = c
      btn.title = c
      btn.addEventListener('click', () => {
        const rgb = fromHex(c)
        hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
        hueSlider.value = Math.round(hsv.h)
        draw()
      })
      recentsEl.appendChild(btn)
    }
  }

  el.querySelector('.cp-add').addEventListener('click', () => {
    addRecent(toHex(hsvToRgb(hsv.h, hsv.s, hsv.v)))
    renderRecents()
  })

  // ── Close ──
  function close() {
    el.remove()
    activePopover = null
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup',   onMouseUp)
    document.removeEventListener('mousedown', onOutside)
  }
  el._close = close

  // ── Actions ──
  el.querySelector('.cp-clear')?.addEventListener('click', () => { close(); onClear?.() })
  el.querySelector('.cp-search').addEventListener('click', () => {
    const hex = toHex(hsvToRgb(hsv.h, hsv.s, hsv.v))
    addRecent(hex)
    close()
    onSearch?.(hex, tolerance)
  })

  // ── Outside click dismisses ──
  // Use anchor.contains() so a click on the trigger's inner icon isn't treated as
  // "outside" (which would close on mousedown, then the click would reopen). The
  // trigger's own click handler owns open/close toggling.
  function onOutside(e) {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close()
  }
  requestAnimationFrame(() => document.addEventListener('mousedown', onOutside))

  // ── Init ──
  draw()
  renderRecents()

  return close
}

/** True while the color picker popover is open. */
export function isColorPickerOpen() { return !!activePopover }

/** Close the color picker if it's open (no-op otherwise). */
export function closeColorPicker() { activePopover?._close() }
