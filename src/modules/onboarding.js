import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { t, setLang, currentLang } from './i18n.js'
import { check, getAccount, isSignedIn, openHub } from './licensing.js'

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
  root.innerHTML = `
    <div class="ob-content">
      <h1 class="ob-heading">${t('onboarding.login.welcome')}</h1>
      <p class="ob-hint">${hint}</p>
      ${missing ? '' : `
        <button class="btn btn-primary ob-btn" id="ob-hub" ${waiting ? 'disabled' : ''}>${waiting ? t('onboarding.hub.waiting') : t('onboarding.hub.continue')}</button>
        ${waiting ? `<button id="ob-hub-again"
            style="margin-top:6px;background:none;border:none;cursor:pointer;font:inherit;font-size:13px;color:var(--text-secondary);padding:8px 0">${t('onboarding.hub.reopen')}</button>` : ''}`}
      <div style="display:flex;gap:2px;justify-content:center;margin-top:10px;opacity:0;animation:ob-item-in 0.9s cubic-bezier(0.16,1,0.3,1) 0.8s forwards">
        ${langBtn('en', 'English')}${langBtn('uz', "O'zbekcha")}
      </div>
    </div>
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
    if (!(await openHub('signin'))) { await check(); render(); return }
    render(true)
    // Watch closely while the user is in bloot apps (the 15 s background check is too slow here).
    clearInterval(watching)
    watching = setInterval(async () => { await check(); if (isSignedIn()) clearInterval(watching) }, 1000)
  }
  root.querySelector('#ob-hub')?.addEventListener('click', go)
  root.querySelector('#ob-hub-again')?.addEventListener('click', go)
}

async function complete() {
  clearInterval(watching)
  await api.setSetting('onboarding_state', 'complete')
  if (!root || root.hidden) return
  root.hidden = true
  store.emit(events.NAVIGATE, { view: 'grid' })
}
