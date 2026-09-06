import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { openImageCropper } from './image-cropper.js'

let root = null

export function init(el, settings) {
  root = el
  root.hidden = false
  const state = settings.onboarding_state ?? 'pending_survey'
  showStep(state)
}

function showStep(state) {
  if (state === 'pending_login') {
    renderLoginStep()
  } else if (state === 'pending_survey' || state === 'pending_store') {
    renderNameStep()
  }
}

const PALETTE = ['#7C3AED','#2563EB','#059669','#D97706','#DC2626','#DB2777','#0891B2']

function avatarColor(name) {
  if (!name) return PALETTE[1]
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xFFFF
  return PALETTE[h % PALETTE.length]
}

const IS_TAURI = '__TAURI_INTERNALS__' in window

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
      const res = await fetch(`https://api.bloot.app/public/user/${encodeURIComponent(id)}`)
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

function renderNameStep() {
  if (!root) return

  const audio = new Audio('/assets/audio/firstinitialization.aac')
  audio.volume = 0.1
  audio.play().catch(() => {})

  let profileImageUrl = null

  root.innerHTML = `
    <div class="ob-content">
      <div class="ob-avatar-wrap">
        <button class="ob-avatar-pick" id="ob-avatar-btn" title="Choose profile photo">
          <span class="ob-avatar-initial" id="ob-avatar-initial">A</span>
          <img class="ob-avatar-img hidden" id="ob-avatar-img" alt="" />
        </button>
        <div class="ob-avatar-camera">
          <span class="icon icon-14"
            style="mask-image:url('/icons/camera.svg');-webkit-mask-image:url('/icons/camera.svg')"
            aria-hidden="true"></span>
        </div>
      </div>
      <h1 class="ob-heading">What should we call you?</h1>
      <p class="ob-hint">Just a name to personalize your experience.<br>You can change it anytime in settings.</p>
      <input class="ob-input" id="ob-name" placeholder="Your name" autocomplete="off" spellcheck="false" />
      <button class="btn btn-primary ob-btn" id="ob-continue">Continue</button>
    </div>
  `

  const avatarBtn     = root.querySelector('#ob-avatar-btn')
  const avatarInitial = root.querySelector('#ob-avatar-initial')
  const avatarImg     = root.querySelector('#ob-avatar-img')
  const input         = root.querySelector('#ob-name')
  const btn           = root.querySelector('#ob-continue')

  avatarBtn.style.background = avatarColor('')
  input.focus()

  input.addEventListener('input', () => {
    if (profileImageUrl) return
    const name = input.value.trim()
    avatarInitial.textContent = name ? name.charAt(0).toUpperCase() : 'A'
    avatarBtn.style.background = avatarColor(name || '')
  })

  avatarBtn.addEventListener('click', () => {
    openImageCropper({
      onSave: dataUrl => {
        profileImageUrl = dataUrl
        avatarImg.src = dataUrl
        avatarImg.classList.remove('hidden')
        avatarInitial.classList.add('hidden')
        avatarBtn.style.background = 'transparent'
      },
    })
  })

  const proceed = async () => {
    const name = input.value.trim()
    if (!name) { input.focus(); return }
    btn.disabled = true
    await api.setSetting('display_name', name)
    if (profileImageUrl) await api.setSetting('profile_image', profileImageUrl)
    showLocalCard()
  }

  btn.addEventListener('click', proceed)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') proceed() })
}

function showLocalCard() {
  if (!root) return
  root.innerHTML = `
    <div class="ob-content">
      <h1 class="ob-heading">Your library lives here.</h1>
      <p class="ob-hint">Everything you save stays on your device — private,<br>fast, and yours. No account needed to get started.</p>
      <button class="btn btn-primary ob-btn" id="ob-gotit">Get started</button>
    </div>
  `
  root.querySelector('#ob-gotit').addEventListener('click', showExtensionCard)
}

function showExtensionCard() {
  if (!root) return
  const EXT_URL = 'https://chromewebstore.google.com/detail/lifmjigeaehakiebfalcanlgjplbcdjf?utm_source=item-share-cb'

  root.innerHTML = `
    <div class="ob-content">
      <div style="width:64px;height:64px;border-radius:18px;background:rgba(27,79,216,0.12);display:flex;align-items:center;justify-content:center;margin-bottom:4px;color:#3B82F6">
        <span class="icon icon-28" style="mask-image:url('/icons/puzzle-piece.svg');-webkit-mask-image:url('/icons/puzzle-piece.svg')" aria-hidden="true"></span>
      </div>
      <h1 class="ob-heading">Save from anywhere on the web.</h1>
      <p class="ob-hint">The Chrome extension lets you drop any image into your vault in one click — while you browse. It's free.</p>
      <button class="btn btn-primary ob-btn" id="ob-get-ext">Get the Chrome extension →</button>
      <button id="ob-ext-skip" style="background:none;border:none;cursor:pointer;font:inherit;font-size:13px;color:var(--text-secondary);padding:10px 0;transition:color 0.15s">Maybe later</button>
    </div>
  `

  root.querySelector('#ob-get-ext').addEventListener('click', async () => {
    if (IS_TAURI) {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(EXT_URL)
    } else {
      window.open(EXT_URL, '_blank')
    }
    await complete()
  })

  root.querySelector('#ob-ext-skip').addEventListener('click', complete)
}

async function complete() {
  await api.setSetting('onboarding_state', 'complete')
  root.hidden = true
  store.emit(events.NAVIGATE, { view: 'grid' })
}
