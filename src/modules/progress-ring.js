// Progress ring around the top-bar search bar — SVG-based for rounded caps.
// API is unchanged:
//   const task = startTask('id', { label, indeterminate })
//   task.update(0.42)
//   task.finish()
//   task.fail('Error message')

const tasks = new Map()

const NS  = 'http://www.w3.org/2000/svg'
const RX  = 8   // border-radius matching --radius-md
const SW  = 2   // stroke width

let _svg  = null
let _arc  = null
let _peri = 0   // perimeter of the rect
let _off  = 0   // dashoffset to place the fill start at 12-o'clock
let _raf  = null

function wrap()    { return document.getElementById('search-ring-wrap') }
function labelEl() { return document.getElementById('ring-label') }

// ─── SVG bootstrap ────────────────────────────────────────────
function initSvg() {
  if (_svg) return
  const el = wrap()
  if (!el) return

  _svg = document.createElementNS(NS, 'svg')
  _svg.setAttribute('aria-hidden', 'true')
  Object.assign(_svg.style, {
    position: 'absolute', inset: '0',
    width: '100%', height: '100%',
    overflow: 'visible', pointerEvents: 'none',
    zIndex: '0', opacity: '0',
    transition: 'opacity 0.3s',
  })

  _arc = document.createElementNS(NS, 'rect')
  _arc.setAttribute('rx', RX)
  _arc.setAttribute('stroke-linecap', 'round')
  _arc.setAttribute('stroke-width', SW)
  _arc.setAttribute('fill', 'none')
  _arc.style.stroke = 'var(--accent)'
  _arc.style.transition = 'stroke-dasharray 0.4s, stroke 0.15s'

  _svg.appendChild(_arc)
  el.appendChild(_svg)
  recomputeGeometry()
}

function recomputeGeometry() {
  if (!_arc) return
  const el = wrap()
  if (!el) return

  const { width: W, height: H } = el.getBoundingClientRect()
  if (!W) return

  // Inset the rect by SW/2 on each side so the centered stroke sits on the border
  const rw = W - SW
  const rh = H - SW
  _arc.setAttribute('x',      SW / 2)
  _arc.setAttribute('y',      SW / 2)
  _arc.setAttribute('width',  rw)
  _arc.setAttribute('height', rh)

  _peri = _arc.getTotalLength()

  // SVG rect path starts at (x+RX, y) and traverses CLOCKWISE:
  //   top-straight → top-right corner → right-straight → bottom-right corner
  //   → bottom-straight → [BOTTOM-LEFT CORNER] → left-straight → top-left corner → …
  //
  // Distance to the bottom-left corner from the path start:
  //   2*(rw - 2*RX)   top straight + bottom straight
  // + (rh - 2*RX)     right straight
  // + π*RX            top-right corner arc + bottom-right corner arc  (each = π*RX/2)
  const D = 2 * (rw - 2 * RX) + (rh - 2 * RX) + Math.PI * RX

  // dashoffset = _peri - D  →  filled dash begins at path position D (bottom-left corner)
  _off = _peri - D
}

// ─── Indeterminate animation ───────────────────────────────────
function startIndeterminate() {
  stopIndeterminate()
  const arcLen = _peri * 0.35
  _arc.style.transition = 'stroke 0.15s'
  _arc.style.strokeDasharray = `${arcLen} ${_peri - arcLen}`

  let t0 = null
  const PERIOD = 1300

  const tick = ts => {
    if (!t0) t0 = ts
    const frac = ((ts - t0) % PERIOD) / PERIOD
    _arc.style.strokeDashoffset = _off - frac * _peri
    _raf = requestAnimationFrame(tick)
  }
  _raf = requestAnimationFrame(tick)
}

function stopIndeterminate() {
  if (_raf) { cancelAnimationFrame(_raf); _raf = null }
}

// ─── Determinate render ────────────────────────────────────────
function setDeterminate(pct) {
  stopIndeterminate()
  const fillLen = Math.max(0, pct * _peri)
  const gapLen  = Math.max(0, _peri - fillLen)
  _arc.style.transition     = 'stroke-dasharray 0.4s, stroke 0.15s'
  _arc.style.strokeDasharray  = `${fillLen} ${gapLen}`
  _arc.style.strokeDashoffset = _off
}

// ─── Core sync ────────────────────────────────────────────────
function sync() {
  const el = wrap()
  if (!el) return

  initSvg()

  if (tasks.size === 0) {
    _svg.style.opacity = '0'
    el.classList.remove('ring-active', 'ring-indeterminate', 'ring-error')
    stopIndeterminate()
    setLabel('')
    return
  }

  recomputeGeometry()

  const entries        = [...tasks.values()]
  const hasIndeterminate = entries.some(t => t.indeterminate)
  const hasError       = entries.some(t => t.error)
  const pct = hasIndeterminate
    ? 0
    : entries.reduce((s, t) => s + t.pct, 0) / entries.length
  const active = entries[entries.length - 1]

  el.classList.add('ring-active')
  el.classList.toggle('ring-indeterminate', hasIndeterminate)
  el.classList.toggle('ring-error', hasError)

  _svg.style.opacity = '1'
  _arc.style.stroke = hasError
    ? 'var(--error)'
    : (active.color ?? 'var(--accent)')

  if (hasIndeterminate) {
    startIndeterminate()
  } else {
    setDeterminate(pct)
  }

  const pctText = hasIndeterminate ? '' : ` · ${Math.round(pct * 100)}%`
  setLabel(active.label ? active.label + pctText : '')
}

function setLabel(text) {
  const el = labelEl()
  if (!el) return
  el.textContent = text
  el.classList.toggle('ring-label-visible', !!text)
}

function remove(id, delay) {
  setTimeout(() => { tasks.delete(id); sync() }, delay)
}

// ─── Public API ───────────────────────────────────────────────
export function startTask(id, {
  label         = '',
  color         = null,
  indeterminate = false,
} = {}) {
  tasks.set(id, { pct: 0, label, color, indeterminate, error: false })
  sync()

  return {
    update(pct) {
      const t = tasks.get(id)
      if (!t) return
      t.pct           = Math.min(1, Math.max(0, pct))
      t.indeterminate = false
      t.error         = false
      sync()
    },

    setLabel(text) {
      const t = tasks.get(id)
      if (!t) return
      t.label = text
      sync()
    },

    finish() {
      const t = tasks.get(id)
      if (!t) return
      t.pct           = 1
      t.indeterminate = false
      t.error         = false
      sync()
      remove(id, 700)
    },

    fail(message = 'Failed') {
      const t = tasks.get(id)
      if (!t) return
      t.label         = message
      t.error         = true
      t.indeterminate = false
      sync()
      remove(id, 1600)
    },
  }
}
