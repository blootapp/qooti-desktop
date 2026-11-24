// Guide H3b: while an update downloads and installs, the window shows the logo, what is
// happening and a progress line until qooti restarts itself. The line follows the real
// download (updater.rs sends "update-progress"), then runs on its own while the update
// installs. The home update bar and Settings › About both start it here.
//
// Fixed slots, so nothing moves when the words change: the status line and the size line
// keep their height whatever they say, and the size uses figures of equal width.
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { t } from './i18n.js'
import { makeLogger } from './logger.js'

const log = makeLogger('Update')
const MB = 1_000_000   // decimal megabytes, like bloot apps shows its downloads

/** Puts the screen up; returns the function that takes it down again. */
function show(version) {
  const el = document.createElement('div')
  el.className = 'splash splash--updating'
  el.innerHTML = `
    <img class="splash-logo" src="/assets/brand/lockup-white.svg" alt="qooti" />
    <span class="splash-status" role="status"></span>
    <span class="splash-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span></span></span>
    <span class="splash-size"></span>`
  const status = el.querySelector('.splash-status')
  const bar    = el.querySelector('.splash-bar')
  const fill   = bar.firstElementChild
  const size   = el.querySelector('.splash-size')
  status.textContent = t('update.downloading_to', { version })
  bar.setAttribute('aria-label', status.textContent)

  const onProgress = store.on(events.UPDATE_PROGRESS, p => {
    if (p?.phase === 'installing') {
      status.textContent = t('update.installing_to', { version })
      bar.classList.remove('is-determinate')
      bar.removeAttribute('aria-valuenow')
      fill.style.width = ''
      size.textContent = t('update.restarts')
      return
    }
    const done = Math.round((p?.downloaded ?? 0) / MB)
    if (p?.total > 0) {
      const pct = Math.min(100, (p.downloaded / p.total) * 100)
      bar.classList.add('is-determinate')
      bar.setAttribute('aria-valuenow', String(Math.round(pct)))
      fill.style.width = `${pct}%`
      size.textContent = t('update.size', { done, total: Math.round(p.total / MB) })
    } else {
      // The server didn't say how big it is: the line keeps running, the size still counts up.
      size.textContent = t('update.size_unknown', { done })
    }
  })

  document.body.appendChild(el)
  return () => { store.off(events.UPDATE_PROGRESS, onProgress); el.remove() }
}

/**
 * Downloads and installs `version` behind the updating screen. On success it never comes
 * back: qooti closes for the installer (Windows) or restarts itself (macOS). Resolves
 * false when it failed: the screen goes away and a toast says why.
 */
export async function installUpdate(version) {
  log.info('update_install_started', { version })
  const hide = show(version)
  try {
    await api.applyUpdate()
    return true
  } catch (err) {
    hide()
    log.warn('update_install_failed', { error: String(err) })
    store.emit(events.SYSTEM_TOAST, {
      type: 'error',
      message: t('update.toast_fail'),
      duration: 8000,
    })
    return false
  }
}
