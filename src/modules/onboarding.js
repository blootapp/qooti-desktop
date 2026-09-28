import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { registerDevice } from './licensing.js'
import { t, setLang, currentLang } from './i18n.js'

let root = null
let returning = false   // signed in on this install before (e.g. after a device reset)

// Onboarding is a single step: sign in with a bloot ID. Any non-complete state
// lands here. The display name/plan come from the bloot account lookup — there is
// no name/photo prompt and no full-screen guide (the in-app spotlight tour, started
// after this completes, covers orientation).
export function init(el, settings) {
  root = el
  root.hidden = false
  returning = !!(settings?.returning || settings?.display_name || settings?.onboarding_state === 'complete')
  renderLoginStep()
}

const IS_TAURI = '__TAURI_INTERNALS__' in window

// Retries transient network failures (e.g. a dropped QUIC/HTTP3 connection — the
// retry lands on the HTTP/2 fallback). Only thrown network errors are retried;
// real HTTP responses (200/404/5xx) return on the first try.
async function fetchWithRetry(url, tries = 3) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, { cache: 'no-store' })
    } catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

function renderLoginStep(typed = '') {
  if (!root) return

  const lang = currentLang()
  const langBtn = (code, label) => `<button class="ob-lang" data-lang="${code}" aria-pressed="${lang === code}"
      style="background:none;border:none;cursor:pointer;font:inherit;font-size:12px;padding:4px 6px;color:var(${lang === code ? '--text-primary' : '--text-secondary'});font-weight:${lang === code ? 600 : 400}">${label}</button>`

  root.innerHTML = `
    <div class="ob-content">
      <h1 class="ob-heading">${t(returning ? 'onboarding.login.welcome_back' : 'onboarding.login.welcome')}</h1>
      <p class="ob-hint">${t('onboarding.login.hint')}</p>
      <input class="ob-input" id="ob-bloot-id" placeholder="${t('onboarding.login.placeholder')}"
             autocomplete="off" spellcheck="false" />
      <div id="ob-login-err" hidden
           style="font-size:13px;color:#F87171;margin-top:-4px;margin-bottom:2px"></div>
      <button class="btn btn-primary ob-btn" id="ob-signin">${t('action.continue')}</button>
      <button id="ob-get-id"
              style="margin-top:6px;background:none;border:none;cursor:pointer;font:inherit;font-size:13px;color:var(--text-secondary);opacity:0;animation:ob-item-in 0.9s cubic-bezier(0.16,1,0.3,1) 0.72s forwards;padding:8px 0;transition:color 0.15s">
        ${t('onboarding.login.no_id')} <span style="color:var(--accent-link);font-weight:500">${t('onboarding.login.get_one')}</span>
      </button>
      <div style="display:flex;gap:2px;justify-content:center;margin-top:10px;opacity:0;animation:ob-item-in 0.9s cubic-bezier(0.16,1,0.3,1) 0.8s forwards">
        ${langBtn('en', 'English')}${langBtn('uz', "O'zbekcha")}
      </div>
    </div>
  `

  const input  = root.querySelector('#ob-bloot-id')
  const signIn = root.querySelector('#ob-signin')
  const getId  = root.querySelector('#ob-get-id')

  input.value = typed
  input.focus()

  // First-launch language pick: most of our users want Uzbek before they've ever
  // reached Settings. Persisted like the Settings switch (settings.js listens).
  root.querySelectorAll('.ob-lang').forEach(btn => btn.addEventListener('click', async () => {
    const next = btn.dataset.lang
    if (next === currentLang()) return
    setLang(next)
    renderLoginStep(input.value)
    try {
      await api.setSetting('language', next)
      store.emit(events.SETTINGS_CHANGED, { key: 'language', value: next })
    } catch {}
  }))

  const proceed = async () => {
    const id = input.value.trim()
    if (!id) { input.focus(); return }

    signIn.disabled = true
    signIn.textContent = t('onboarding.login.looking_up')

    const showErr = msg => {
      signIn.disabled = false
      signIn.textContent = t('action.continue')
      const err = root.querySelector('#ob-login-err')
      err.textContent = msg
      err.hidden = false
      input.focus()
    }

    let data
    try {
      const res = await fetchWithRetry(`https://api.bloot.app/public/user/${encodeURIComponent(id)}`)
      if (res.status === 404) { showErr(t('onboarding.login.not_found')); return }
      if (!res.ok)            { showErr(t('error.generic')); return }
      data = await res.json()
    } catch {
      showErr(t('onboarding.login.offline'))
      return
    }

    await api.setSetting('bloot_id', id)
    if (data.display_name) await api.setSetting('display_name', data.display_name)
    if (data.plan)         await api.setSetting('plan', data.plan)

    // Stamp the login moment (so a later admin device-reset logs us out) and
    // bind this install to the account. Failures here never block sign-in.
    await api.setSetting('logged_in_at', String(Date.now()))
    try { await registerDevice(id) } catch {}

    signIn.textContent = t('onboarding.login.signing_in')
    await complete()
  }

  signIn.addEventListener('click', proceed)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') proceed() })

  getId.addEventListener('click', async () => {
    const url = 'https://account.bloot.app'
    if (IS_TAURI) {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
    } else {
      window.open(url, '_blank')
    }
  })
}

async function complete() {
  await api.setSetting('onboarding_state', 'complete')
  root.hidden = true
  store.emit(events.NAVIGATE, { view: 'grid' })
}
