import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { t, setLang, currentLang } from './i18n.js'
import { check, getAccount, isSignedIn, openHub } from './licensing.js'
import { isStarterPreview } from './starter.js'

let root = null
let watching = null
let onIn = null

// qooti signs in through bloot apps — this screen only shows while bloot apps isn't
// signed in. One button opens bloot apps on its sign-in step; as soon as bloot apps
// is signed in (it brings qooti back to the front), qooti carries on by itself.
// The in-app spotlight tour, started after this completes, covers orientation.
export function init(el) {
  root = el
  root.hidden = false
  render()
  // Signed in from anywhere (this button, bloot apps' own window) → continue.
  if (onIn) store.off(events.HUB_SIGNED_IN, onIn)
  // (Not in the blt_starter preview: you're already signed in, so it would skip ahead.)
  if (isStarterPreview()) return
  onIn = () => { store.off(events.HUB_SIGNED_IN, onIn); onIn = null; complete() }
  store.on(events.HUB_SIGNED_IN, onIn)
}

function render(waiting = false) {
  if (!root) return
  const acc = getAccount()
  const missing = acc && !acc.hub_installed
  const expired = acc?.state === 'expired'

  const lang = currentLang()
  const langBtn = (code, label) => `<button class="ob-lang" data-lang="${code}" aria-pressed="${lang === code}"
      style="background:none;border:none;cursor:pointer;font:inherit;font-size:12px;padding:4px 6px;color:var(${lang === code ? '--text-primary' : '--text-secondary'});font-weight:${lang === code ? 600 : 400}">${label}</button>`

  const hint = missing ? t('onboarding.hub.missing') : expired ? t('onboarding.hub.expired') : t('onboarding.hub.hint')
  // Guide A0c (sign in) / A0d (waiting for bloot apps)
  root.innerHTML = `
    <img class="ob-logo" src="/assets/brand/lockup-white.svg" alt="qooti" draggable="false" />
    <div class="ob-content">
      ${waiting ? `
        <h1 class="ob-heading">${t('onboarding.hub.waiting_title')}</h1>
        <p class="ob-hint">${t('onboarding.hub.waiting_sub')}</p>
        <span class="ob-progress"><span></span></span>
        <button class="btn btn-ghost btn-sm ob-btn-quiet" id="ob-cancel">${t('action.cancel')}</button>
      ` : `
        <h1 class="ob-heading">${t('onboarding.hub.title')}</h1>
        <p class="ob-hint">${hint}</p>
        ${missing ? '' : `<button class="btn btn-primary ob-btn" id="ob-hub">${t('onboarding.hub.continue')}</button>`}
      `}
    </div>
    <div class="ob-langs">${langBtn('en', 'English')}${langBtn('uz', "O'zbekcha")}</div>
  `

  // First-launch language pick: most of our users want Uzbek before they've ever
  // reached Settings. Persisted like the Settings switch (settings.js listens).
  root.querySelectorAll('.ob-lang').forEach(btn => btn.addEventListener('click', async () => {
    const next = btn.dataset.lang
    if (next === currentLang()) return
    setLang(next)
    render(waiting)
    try {
      await api.setSetting('language', next)
      store.emit(events.SETTINGS_CHANGED, { key: 'language', value: next })
    } catch {}
  }))

  const go = async () => {
    // blt_starter preview: already signed in — show the waiting step (A0d) for a moment,
    // then carry on, without opening bloot apps
    if (isStarterPreview()) { render(true); setTimeout(() => complete(), 1600); return }
    if (!(await openHub('signin'))) { await check(); render(); return }
    render(true)
    // Watch closely while the user is in bloot apps (the 15 s background check is too slow here).
    clearInterval(watching)
    watching = setInterval(async () => { await check(); if (isSignedIn()) clearInterval(watching) }, 1000)
  }
  root.querySelector('#ob-hub')?.addEventListener('click', go)
  root.querySelector('#ob-cancel')?.addEventListener('click', () => { clearInterval(watching); render() })
}

// Guide A2: one calm note about where things live, shown once after the first sign-in.
const PRIVACY_KEY = 'qooti.ob.privacy_seen'
function showPrivacyNote() {
  return new Promise(resolve => {
    const preview = isStarterPreview()   // blt_starter: always show, never mark seen
    let seen = false
    try { seen = !preview && localStorage.getItem(PRIVACY_KEY) === '1' } catch {}
    if (seen || !root) { resolve(); return }
    root.innerHTML = `
      <img class="ob-logo" src="/assets/brand/lockup-white.svg" alt="qooti" draggable="false" />
      <div class="ob-content ob-content--left">
        <h1 class="ob-heading">${t('onboarding.privacy.title')}</h1>
        <p class="ob-hint">${t('onboarding.privacy.body')}</p>
        <button class="btn btn-primary btn-sm ob-btn-quiet" id="ob-privacy-ok">${t('onboarding.privacy.ok')}</button>
      </div>`
    root.querySelector('#ob-privacy-ok').addEventListener('click', () => {
      if (!preview) try { localStorage.setItem(PRIVACY_KEY, '1') } catch {}
      resolve()
    })
  })
}

async function complete() {
  clearInterval(watching)
  if (!isStarterPreview()) await api.setSetting('onboarding_state', 'complete')
  if (!root || root.hidden) return
  await showPrivacyNote()
  root.hidden = true
  store.emit(events.NAVIGATE, { view: 'grid' })
}
