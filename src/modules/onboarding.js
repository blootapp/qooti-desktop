import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'

let root = null

// Onboarding is a single step: sign in with a bloot ID. Any non-complete state
// lands here. The display name/plan come from the bloot account lookup — there is
// no name/photo prompt and no full-screen guide (the in-app spotlight tour, started
// after this completes, covers orientation).
export function init(el, _settings) {
  root = el
  root.hidden = false
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

function renderLoginStep() {
  if (!root) return

  root.innerHTML = `
    <div class="ob-content">
      <h1 class="ob-heading">Welcome back</h1>
      <p class="ob-hint">Enter your bloot ID to continue.</p>
      <input class="ob-input" id="ob-bloot-id" placeholder="Your bloot ID"
             autocomplete="off" spellcheck="false" />
      <div id="ob-login-err" hidden
           style="font-size:13px;color:#F87171;margin-top:-4px;margin-bottom:2px"></div>
      <button class="btn btn-primary ob-btn" id="ob-signin">Continue</button>
      <button id="ob-get-id"
              style="margin-top:6px;background:none;border:none;cursor:pointer;font:inherit;font-size:13px;color:var(--text-secondary);opacity:0;animation:ob-item-in 0.9s cubic-bezier(0.16,1,0.3,1) 0.72s forwards;padding:8px 0;transition:color 0.15s">
        Don't have a bloot ID? <span style="color:var(--accent-link);font-weight:500">Get one →</span>
      </button>
    </div>
  `

  const input  = root.querySelector('#ob-bloot-id')
  const signIn = root.querySelector('#ob-signin')
  const getId  = root.querySelector('#ob-get-id')

  input.focus()

  const proceed = async () => {
    const id = input.value.trim()
    if (!id) { input.focus(); return }

    signIn.disabled = true
    signIn.textContent = 'Looking up…'

    const showErr = msg => {
      signIn.disabled = false
      signIn.textContent = 'Continue'
      const err = root.querySelector('#ob-login-err')
      err.textContent = msg
      err.hidden = false
      input.focus()
    }

    let data
    try {
      const res = await fetchWithRetry(`https://api.bloot.app/public/user/${encodeURIComponent(id)}`)
      if (res.status === 404) { showErr('bloot ID not found. Check and try again.'); return }
      if (!res.ok)            { showErr('Something went wrong. Try again.'); return }
      data = await res.json()
    } catch {
      showErr('Could not connect. Check your internet and try again.')
      return
    }

    await api.setSetting('bloot_id', id)
    if (data.display_name) await api.setSetting('display_name', data.display_name)
    if (data.plan)         await api.setSetting('plan', data.plan)

    signIn.textContent = 'Signing in…'
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
