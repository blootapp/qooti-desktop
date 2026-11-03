// Motion helpers — the JS side of the motion rules in global.css (:root tokens).
// Only opacity and transform are animated (Web Animations API, so nothing has to be
// cleaned up afterwards), distances stay small, nothing bounces, exits are quicker than
// entrances, and only what is on screen moves. With "reduce motion" on, movement turns
// into a plain fade.

export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'
export const EASE_IN  = 'cubic-bezier(0.4, 0, 1, 1)'
export const DUR = { fast: 150, normal: 220, slow: 300, exit: 140 }

const MAX_MOVING = 60     // more than this changing at once → one quiet crossfade instead
const MARGIN     = 60     // px around the viewport that still counts as "on screen"
const GLIDE_MAX  = 360    // px — longer moves fade in place instead of flying across

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

const onScreen = (r, vp) => r.bottom > vp.top - MARGIN && r.top < vp.bottom + MARGIN && r.width > 0

/** Positions of the cards currently on screen, by item id — taken before a re-render. */
export function snapshotCards(scrollEl) {
  const vp = scrollEl.getBoundingClientRect()
  const out = new Map()
  for (const card of scrollEl.querySelectorAll('.card[data-id]:not(.free-teaser-card)')) {
    const r = card.getBoundingClientRect()
    if (onScreen(r, vp)) out.set(card.dataset.id, { rect: r, el: card })
  }
  return out
}

/** Cards on screen that won't be in the new result fade out where they were, on a layer
 *  clipped to the grid, while the new grid is built underneath. */
export function ghostOut(scrollEl, before, keepIds) {
  if (!before?.size || reducedMotion()) return
  const leaving = [...before.entries()].filter(([id]) => !keepIds.has(id))
  if (!leaving.length || leaving.length > MAX_MOVING) return
  const vp = scrollEl.getBoundingClientRect()
  const layer = document.createElement('div')
  layer.style.cssText = `position:fixed;left:${vp.left}px;top:${vp.top}px;width:${vp.width}px;height:${vp.height}px;overflow:hidden;pointer-events:none;z-index:5`
  for (const [, { rect, el }] of leaving) {
    const g = el.cloneNode(true)
    g.querySelectorAll('video').forEach(v => v.remove())
    g.querySelectorAll('img').forEach(i => { i.style.display = 'block'; i.classList.add('loaded') })
    g.style.cssText = `position:absolute;margin:0;left:${rect.left - vp.left}px;top:${rect.top - vp.top}px;width:${rect.width}px`
    layer.appendChild(g)
    g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }],
      { duration: DUR.exit, easing: EASE_IN, fill: 'forwards' })
  }
  document.body.appendChild(layer)
  setTimeout(() => layer.remove(), DUR.exit + 40)
}

/** After the grid was rebuilt: cards that stayed glide from where they were to where they
 *  are now; new ones on screen fade in with a short top-to-bottom cascade (≤ 120 ms in
 *  total). Off-screen cards don't animate. With no `before` this is the first-load cascade. */
export function playGridChange(scrollEl, before) {
  const vp = scrollEl.getBoundingClientRect()
  const moving = []
  const entering = []
  for (const card of scrollEl.querySelectorAll('.card[data-id]:not(.free-teaser-card)')) {
    const r = card.getBoundingClientRect()
    if (!onScreen(r, vp)) continue
    const old = before?.get(card.dataset.id)
    const dx = old ? old.rect.left - r.left : 0
    const dy = old ? old.rect.top - r.top : 0
    // Short moves glide; a card crossing the screen (a reshuffle) would only add noise,
    // so it fades in at its new place instead.
    if (old && Math.hypot(dx, dy) <= Math.max(GLIDE_MAX, 2.2 * r.width)) {
      const s = old.rect.width / r.width
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(s - 1) > 0.005) moving.push({ card, dx, dy, s })
    } else {
      entering.push({ card, r })
    }
  }

  const masonry = scrollEl.querySelector('.masonry')
  if (moving.length + entering.length > MAX_MOVING || (reducedMotion() && (moving.length || entering.length))) {
    masonry?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.normal, easing: EASE_OUT })
    return
  }

  for (const { card, dx, dy, s } of moving) {
    card.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${s})`, transformOrigin: '0 0' },
       { transform: 'none', transformOrigin: '0 0' }],
      { duration: DUR.slow, easing: EASE_OUT })
  }

  entering.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
  const step = entering.length > 1 ? Math.min(18, 120 / (entering.length - 1)) : 0
  entering.forEach(({ card }, i) => {
    card.animate(
      [{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
      { duration: DUR.slow, delay: moving.length ? DUR.exit / 2 + i * step : i * step, easing: EASE_OUT, fill: 'backwards' })
  })
}

/** Remove one element: it fades and shrinks a touch, then the elements after it in the
 *  same container glide into the gap (up a masonry column, or across CSS columns).
 *  `done` runs once it is out of the DOM. */
export function removeWithFlow(el, done) {
  if (!el?.isConnected || el.dataset.leaving) return
  el.dataset.leaving = '1'
  el.style.pointerEvents = 'none'
  const finish = () => {
    const parent = el.parentElement
    const followers = parent ? [...parent.children].filter(c => c !== el && (el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)) : []
    const was = followers.map(c => c.getBoundingClientRect())
    el.remove()
    done?.()
    if (reducedMotion()) return
    const vh = window.innerHeight
    followers.forEach((c, k) => {
      const now = c.getBoundingClientRect()
      if (now.bottom < -MARGIN || now.top > vh + MARGIN) return
      const dx = was[k].left - now.left
      const dy = was[k].top - now.top
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: DUR.slow, easing: EASE_OUT })
      }
    })
  }
  if (reducedMotion()) { finish(); return }
  const a = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }],
    { duration: DUR.exit, easing: EASE_IN, fill: 'forwards' })
  whenDone(a, DUR.exit, finish)
}

/** Run `fn` once when animation `a` ends — or after `ms` anyway: a hidden or minimised
 *  window doesn't advance animations, and a removal must never get stuck half-way. */
function whenDone(a, ms, fn) {
  let ran = false
  const once = () => { if (!ran) { ran = true; fn() } }
  a.onfinish = once
  a.oncancel = once
  setTimeout(once, ms + 80)
}

/** Remove a block from a vertical list: fade out, then close the space smoothly (instead
 *  of the rows below snapping up). */
export function collapseOut(el, done) {
  if (!el?.isConnected || el.dataset.leaving) return
  el.dataset.leaving = '1'
  el.style.pointerEvents = 'none'
  if (reducedMotion()) { el.remove(); done?.(); return }
  const h = el.getBoundingClientRect().height
  const cs = getComputedStyle(el)
  el.style.overflow = 'hidden'
  const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.exit, easing: EASE_IN, fill: 'forwards' })
  whenDone(fade, DUR.exit, () => {
    const shut = el.animate(
      [{ height: `${h}px`, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
       { height: '0px', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' }],
      { duration: DUR.normal, easing: EASE_OUT, fill: 'forwards' })
    whenDone(shut, DUR.normal, () => { el.remove(); done?.() })
  })
}

/** Gentle appearance for a block that has just been inserted. */
export function fadeIn(el, { y = 4, delay = 0 } = {}) {
  if (!el || reducedMotion()) return
  el.animate([{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'none' }],
    { duration: DUR.normal, delay, easing: EASE_OUT, fill: 'backwards' })
}
