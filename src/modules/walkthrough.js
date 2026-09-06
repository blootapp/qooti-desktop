import { api } from './tauri-api.js'
import { t } from './i18n.js'

const IS_TAURI = '__TAURI_INTERNALS__' in window
const EXT_URL  = 'https://chromewebstore.google.com/detail/lifmjigeaehakiebfalcanlgjplbcdjf?utm_source=item-share-cb'

const PAD = 6   // spotlight padding around target element

const STEP_DEFS = [
  { targetId: 'top-bar-import-btn', titleKey: 'wt.step1.title', bodyKey: 'wt.step1.body', cardPos: 'bottom-center' },
  { targetId: 'search-ring-wrap',   titleKey: 'wt.step2.title', bodyKey: 'wt.step2.body', cardPos: 'bottom-center' },
  { targetId: 'nav-drawer-toggle',  titleKey: 'wt.step3.title', bodyKey: 'wt.step3.body', cardPos: 'bottom-right'  },
  { targetId: null,                 titleKey: 'wt.step4.title', bodyKey: 'wt.step4.body', cardPos: 'center'        },
]

let _root       = null
let _spotlight  = null
let _card       = null
let _dotEls     = []
let _step       = 0
let _keyHandler = null

export function startWalkthrough() {
  if (_root) return
  _step = 0
  _build()
  // Snap to first position without animation, then enable transitions
  _spotlight.style.transition = 'none'
  _card.style.transition = 'none'
  _showStep(0)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    _spotlight.style.transition = ''
    _card.style.transition = ''
  }))
}

function _build() {
  _root = document.createElement('div')
  _root.className = 'wt-root'

  // Full-screen click blocker — prevents interacting with the app during the tour
  const blocker = document.createElement('div')
  blocker.className = 'wt-blocker'

  _spotlight = document.createElement('div')
  _spotlight.className = 'wt-spotlight'

  _card = document.createElement('div')
  _card.className = 'wt-card'
  _card.innerHTML = `
    <div class="wt-card-top">
      <div class="wt-dots" id="wt-dots"></div>
      <button class="wt-skip-btn" id="wt-skip">${t('wt.skip')}</button>
    </div>
    <h2 class="wt-title" id="wt-title"></h2>
    <p class="wt-desc"  id="wt-desc"></p>
    <div class="wt-card-bottom">
      <button class="wt-next-btn" id="wt-next">${t('wt.next')}</button>
    </div>
  `

  _root.append(blocker, _spotlight, _card)

  // Step dots
  const dotsEl = _card.querySelector('#wt-dots')
  _dotEls = STEP_DEFS.map(() => {
    const dot = document.createElement('span')
    dot.className = 'wt-dot'
    dotsEl.appendChild(dot)
    return dot
  })

  _card.querySelector('#wt-skip').addEventListener('click', _finish)
  _card.querySelector('#wt-next').addEventListener('click', _advance)

  _keyHandler = e => {
    if (e.key === 'Escape') { e.preventDefault(); _finish(); return }
    if (e.key === 'ArrowRight' || (e.key === ' ' && !e.target.closest('.wt-card'))) {
      e.preventDefault(); _advance()
    }
  }
  document.addEventListener('keydown', _keyHandler)

  document.getElementById('overlays').appendChild(_root)
}

function _showStep(idx) {
  _step = idx
  const s      = STEP_DEFS[idx]
  const isLast = idx === STEP_DEFS.length - 1

  // Update content
  _card.querySelector('#wt-title').textContent = t(s.titleKey)
  _card.querySelector('#wt-desc').textContent  = t(s.bodyKey)
  const nextBtn = _card.querySelector('#wt-next')
  nextBtn.textContent = isLast ? t('wt.getstarted') : t('wt.next')
  _card.querySelector('#wt-skip').style.visibility = isLast ? 'hidden' : ''

  // Step dots
  _dotEls.forEach((d, i) => d.classList.toggle('is-active', i === idx))

  // Re-trigger card entrance animation
  _card.classList.remove('wt-card--in')
  void _card.offsetWidth
  _card.classList.add('wt-card--in')

  if (s.targetId) {
    const target = document.getElementById(s.targetId)
    if (target) {
      const r = target.getBoundingClientRect()
      Object.assign(_spotlight.style, {
        top:          `${r.top    - PAD}px`,
        left:         `${r.left   - PAD}px`,
        width:        `${r.width  + PAD * 2}px`,
        height:       `${r.height + PAD * 2}px`,
        borderRadius: `${Math.min(10, r.height / 2 + PAD)}px`,
        opacity:      '1',
      })
      // Place card after current frame so offsetWidth is accurate
      requestAnimationFrame(() => _placeCard(r, s.cardPos))
    }
  } else {
    // No target — collapse spotlight to nothing, show dark backdrop
    Object.assign(_spotlight.style, {
      top:          '50%',
      left:         '50%',
      width:        '0',
      height:       '0',
      borderRadius: '50%',
      opacity:      '0',
    })
    Object.assign(_card.style, {
      top:       '50%',
      left:      '50%',
      transform: 'translate(-50%, -50%)',
    })
  }
}

function _placeCard(targetRect, pos) {
  const cardW = _card.offsetWidth  || 280
  const cardH = _card.offsetHeight || 150
  const gap   = PAD + 12
  const vw    = window.innerWidth
  const vh    = window.innerHeight
  const edge  = 12

  _card.style.transform = ''

  let top, left

  switch (pos) {
    case 'bottom-center':
      top  = targetRect.bottom + gap
      left = targetRect.left + targetRect.width / 2 - cardW / 2
      break
    case 'bottom-left':
      top  = targetRect.bottom + gap
      left = targetRect.left - PAD
      break
    case 'bottom-right':
      top  = targetRect.bottom + gap
      left = targetRect.right + PAD - cardW
      break
    case 'top':
      top  = targetRect.top - gap - cardH
      left = targetRect.left - PAD
      break
    default:
      top  = targetRect.bottom + gap
      left = targetRect.left - PAD
  }

  // Clamp to viewport
  left = Math.max(edge, Math.min(left, vw - cardW - edge))
  top  = Math.max(edge, Math.min(top,  vh - cardH - edge))

  _card.style.top  = `${top}px`
  _card.style.left = `${left}px`
}

function _advance() {
  if (_step >= STEP_DEFS.length - 1) { _finish(); return }
  _spotlight.style.transition = ''
  _card.style.transition = ''
  _showStep(_step + 1)
}

async function _finish() {
  document.removeEventListener('keydown', _keyHandler)
  _root.classList.add('wt-root--out')
  setTimeout(() => {
    _root?.remove()
    _root      = null
    _spotlight = null
    _card      = null
    _dotEls    = []
    _showExtensionPromo()
  }, 280)
  await api.setSetting('walkthrough_done', 'true').catch(() => {})
}

function _showExtensionPromo() {
  if (!document.getElementById('ep-keyframes')) {
    const s = document.createElement('style')
    s.id = 'ep-keyframes'
    s.textContent = `
      @keyframes ep-overlay-in { from { opacity:0 } to { opacity:1 } }
      @keyframes ep-card-in { from { opacity:0; transform:translateY(18px) scale(0.96) } to { opacity:1; transform:translateY(0) scale(1) } }
    `
    document.head.appendChild(s)
  }

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;animation:ep-overlay-in 0.25s ease forwards'

  const card = document.createElement('div')
  card.style.cssText = 'background:#1A1A1A;border:1px solid rgba(255,255,255,0.09);border-radius:16px;padding:28px 24px 20px;max-width:320px;width:90%;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px;animation:ep-card-in 0.32s cubic-bezier(0.16,1,0.3,1) forwards'
  card.innerHTML = `
    <div style="width:60px;height:60px;border-radius:16px;background:rgba(27,79,216,0.12);display:flex;align-items:center;justify-content:center;margin-bottom:2px">
      <span class="icon icon-28" style="color:#3B82F6;mask-image:url('/icons/puzzle-piece.svg');-webkit-mask-image:url('/icons/puzzle-piece.svg')" aria-hidden="true"></span>
    </div>
    <h2 style="margin:0;font-size:17px;font-weight:700;color:#EDEDF0;line-height:1.3">${t('ext.promo.title')}</h2>
    <p style="margin:0;font-size:13.5px;color:#9A9AA3;line-height:1.5">${t('ext.promo.body')}</p>
    <button id="ep-get" style="width:100%;margin-top:6px;padding:11px 0;border-radius:10px;background:#1B4FD8;border:none;cursor:pointer;font:inherit;font-size:14px;font-weight:600;color:#fff">${t('ext.promo.cta')}</button>
    <button id="ep-skip" style="background:none;border:none;cursor:pointer;font:inherit;font-size:13px;color:#9A9AA3;padding:6px 0">${t('ext.promo.skip')}</button>
  `

  overlay.appendChild(card)
  document.getElementById('overlays').appendChild(overlay)

  const close = () => overlay.remove()

  card.querySelector('#ep-get').addEventListener('click', async () => {
    if (IS_TAURI) {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(EXT_URL)
    } else {
      window.open(EXT_URL, '_blank')
    }
    close()
  })
  card.querySelector('#ep-skip').addEventListener('click', close)
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
}
