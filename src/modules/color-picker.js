// Canvas-based HSV color picker popover.
// Usage: openColorPicker(anchorEl, { initialColor, onSearch, onClear })

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
export function openColorPicker(anchor, { initialColor = null, initialTolerance = 'normal', onSearch, onClear } = {}) {
  if (activePopover) { activePopover._close(); activePopover = null }

  // Initial color state in HSV
  let hsv = { h: 0, s: 100, v: 50 }
  if (initialColor) {
    const rgb = fromHex(initialColor)
    if (rgb) hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
  }

  // Color-match tolerance (Strict / Normal / Broad) — lives in the picker so it
  // travels with the color on Search, instead of as separate filter-bar chips.
  const TOLERANCES = ['strict', 'normal', 'broad']
  let tolerance = TOLERANCES.includes(initialTolerance) ? initialTolerance : 'normal'

  // ── Build DOM ──
  const el = document.createElement('div')
  el.className = 'cp-popover'
  el.innerHTML = `
    <div class="cp-canvas-wrap">
      <canvas class="cp-canvas"></canvas>
      <div class="cp-cursor"></div>
    </div>
    <div class="cp-controls">
      <div class="cp-hue-wrap">
        <input type="range" class="cp-hue" min="0" max="360" step="1" />
      </div>
      <div class="cp-hex-row">
        <div class="cp-preview"></div>
        <input class="cp-hex" maxlength="7" spellcheck="false" />
        <button class="cp-copy" title="Copy hex">
          <span class="icon icon-14" style="mask-image:url('/icons/copy.svg');-webkit-mask-image:url('/icons/copy.svg')"></span>
        </button>
      </div>
      <div class="cp-recents-row">
        <div class="cp-recents"></div>
        <button class="cp-add" title="Save current color">+</button>
      </div>
      <div class="cp-tol-wrap">
        <span class="cp-tol-label">Color match</span>
        <div class="cp-tol-seg">
          <button class="cp-tol" data-tol="strict">Strict</button>
          <button class="cp-tol" data-tol="normal">Normal</button>
          <button class="cp-tol" data-tol="broad">Broad</button>
        </div>
      </div>
      <div class="cp-actions">
        <button class="cp-clear">Clear</button>
        <button class="cp-search">Search</button>
      </div>
    </div>
  `

  document.getElementById('overlays').appendChild(el)
  activePopover = el

  // ── Element refs ──
  const canvas    = el.querySelector('.cp-canvas')
  const cursorEl  = el.querySelector('.cp-cursor')
  const hueSlider = el.querySelector('.cp-hue')
  const hexInput  = el.querySelector('.cp-hex')
  const preview   = el.querySelector('.cp-preview')
  const recentsEl = el.querySelector('.cp-recents')

  // Set canvas size after append so getBoundingClientRect works
  canvas.width  = 248
  canvas.height = 160
  const ctx = canvas.getContext('2d')

  // ── Position: top-right corner of popover nearest to anchor ──
  const anchorRect = anchor.getBoundingClientRect()
  el.style.top   = `${anchorRect.bottom + 8}px`
  el.style.right = `${window.innerWidth - anchorRect.right}px`
  el.style.left  = 'auto'
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect()
    if (r.bottom > window.innerHeight - 8) el.style.top  = `${anchorRect.top - r.height - 8}px`
    if (r.left   < 8)                      { el.style.right = 'auto'; el.style.left = '8px' }
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

    // Cursor
    const cx = (hsv.s / 100) * W
    const cy = (1 - hsv.v / 100) * H
    cursorEl.style.left = `${cx}px`
    cursorEl.style.top  = `${cy}px`

    // Sync controls
    const hex = toHex(hsvToRgb(hsv.h, hsv.s, hsv.v))
    preview.style.background = hex
    hexInput.value = hex
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

  canvas.addEventListener('mousedown', e => { dragging = true; pickAt(e.clientX, e.clientY) })
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
      preview.style.background = val
      draw()
    }
  })

  // ── Copy hex ──
  el.querySelector('.cp-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(hexInput.value).catch(() => {})
  })

  // ── Recent swatches ──
  function renderRecents() {
    recentsEl.innerHTML = ''
    const colors = getRecents()
    for (let i = 0; i < 5; i++) {
      const btn = document.createElement('button')
      btn.className = 'cp-recent-swatch' + (colors[i] ? '' : ' empty')
      if (colors[i]) {
        btn.style.background = colors[i]
        btn.title = colors[i]
        btn.addEventListener('click', () => {
          const rgb = fromHex(colors[i])
          hsv = rgbToHsv(rgb.r, rgb.g, rgb.b)
          hueSlider.value = Math.round(hsv.h)
          draw()
        })
      } else {
        btn.disabled = true
      }
      recentsEl.appendChild(btn)
    }
  }

  el.querySelector('.cp-add').addEventListener('click', () => {
    addRecent(toHex(hsvToRgb(hsv.h, hsv.s, hsv.v)))
    renderRecents()
  })

  // ── Tolerance segmented control ──
  const tolSeg = el.querySelector('.cp-tol-seg')
  function renderTol() {
    tolSeg.querySelectorAll('.cp-tol').forEach(b => b.classList.toggle('active', b.dataset.tol === tolerance))
  }
  tolSeg.querySelectorAll('.cp-tol').forEach(btn => {
    btn.addEventListener('click', () => { tolerance = btn.dataset.tol; renderTol() })
  })
  renderTol()

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
  el.querySelector('.cp-clear').addEventListener('click', () => { close(); onClear?.() })
  el.querySelector('.cp-search').addEventListener('click', () => {
    const hex = toHex(hsvToRgb(hsv.h, hsv.s, hsv.v))
    addRecent(hex)
    close()
    onSearch?.(hex, tolerance)
  })

  // ── Outside click dismisses ──
  function onOutside(e) {
    if (!el.contains(e.target) && e.target !== anchor) close()
  }
  requestAnimationFrame(() => document.addEventListener('mousedown', onOutside))

  // ── Init ──
  draw()
  renderRecents()

  return close
}
