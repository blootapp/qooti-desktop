// The role question (Tag lens, spec §0.3 and §8.1): "What describes you best?"
//
// One full-window step in the first-run look (onboarding.js, the .ob-* classes in
// global.css): three cards in the fixed lens order, each with the lens's name and summary
// from the lens files, one choice, then Continue. Continue calls apply_role through lenses.js:
// only that role's lens turns on, tag suggestions turn on, and the settings cache learns
// user_role and the switch. The lenses can be changed later in Settings › Library › Tag lens.
//
// main.js shows it after the library has opened and before the walkthrough tour, whenever
// no role is saved yet: new users, the sign-in path, and existing users once, on their first
// launch of this version. The blt_starter preview shows it again but saves nothing. In the
// browser mock it shows by default; ?role=motion|design|thumbnail starts with a role chosen.
//
// Keyboard: the arrow keys (and Home/End) move the choice, Enter chooses (= Continue).
//
// It also keeps the "first-run steps" hold (holdFirstRunSteps, startupBusy): dialogs that open
// by themselves at start-up wait while it is held, so nothing covers this step or slips into
// the gap before the tour.

import store from './store.js'
import * as events from './events.js'
import { t, currentLang, setLang } from './i18n.js'
import { getSetting, setSetting } from './settings.js'
import { isStarterPreview } from './starter.js'
import { LENS_ORDER, getLens, isLoaded, lensName, lensSummary, applyRole } from './lenses.js'
import { reducedMotion, DUR, EASE_IN } from './motion.js'
import { makeLogger } from './logger.js'

const log = makeLogger('RoleStep')

// Each role's picture: the app's own line icons. A lens added later without one gets the tag.
const ROLE_ICON = { motion: 'video-camera', design: 'palette', thumbnail: 'brand-youtube' }
const LANGS = [['en', 'English'], ['uz', 'O‘zbekcha']]   // each in its own language, never translated
const iconHtml = name =>
  `<span class="icon rs-option-glyph" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

const NO_DATA_MS   = 10_000   // still no lens data by then: close, and ask again next launch
const MAX_FAILURES = 3        // saving keeps failing: let the user in, and ask again next launch

let _active = null            // the promise of the step on screen
let _firstRunHolds = 0        // holdFirstRunSteps() calls not released yet

/** True while the question should be asked: no role saved yet (and always in the blt_starter preview). */
export function needsRoleStep() {
  return isStarterPreview() || !getSetting('user_role', '')
}

/**
 * Shows the step; resolves when it closes, with the chosen role, or null when it closed
 * without one (the lens data never arrived, or saving kept failing: it asks again next launch).
 * Never rejects. While it is up, the first-run steps are held (startupBusy).
 */
export function showRoleStep() {
  if (!_active) {
    const release = holdFirstRunSteps()
    _active = new Promise(resolve => open(resolve)).finally(() => { release(); _active = null })
  }
  return _active
}

// ─── First-run steps ─────────────────────────────────────────────
// Dialogs that open by themselves at start-up ("Links from your browser" in browser-queue.js,
// a .qooti file qooti was opened with in main.js) wait until startupBusy() is false. main.js
// holds the first-run steps from start-up until the walkthrough tour is on screen (or until the
// role step is done when there is no tour), and this step holds them while it is up. Without
// the hold, such a dialog opened on top of this step, or in the half second before the tour.

/** Marks the first-run steps as running. Call the returned function once when they're done. */
export function holdFirstRunSteps() {
  _firstRunHolds++
  let released = false
  return () => {
    if (released) return
    released = true
    _firstRunHolds = Math.max(0, _firstRunHolds - 1)
  }
}

/**
 * True while start-up is still showing its own steps: the first-run steps are held, or the
 * sign-in screen, this step, the walkthrough tour or the tour's closing extension promo is on
 * screen. A dialog that opens by itself waits until this is false.
 */
export function startupBusy() {
  if (_firstRunHolds > 0) return true
  if (document.querySelector('.role-step, .wt-root')) return true
  const signIn = document.getElementById('onboarding-root')
  if (signIn && !signIn.hidden) return true
  return !!document.getElementById('ep-get')   // the extension promo after the tour (walkthrough.js)
}

function open(resolve) {
  const preview = isStarterPreview()   // replays first run: nothing is saved
  let selected  = null                 // the chosen role (lens id)
  let busy      = false                // Continue is saving
  let failures  = 0
  let closed    = false
  let noDataTimer = null
  let renderedHtml = null              // the cards' markup on screen (null: placeholders)

  const root = document.createElement('div')
  root.className = 'role-step'
  root.tabIndex = -1
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-labelledby', 'rs-title')
  // No logo here: the language switch is the only thing in the corner. Every text that
  // changes with the language sits in a fixed slot, so switching moves nothing.
  root.innerHTML = `
    <div class="rs-lang" role="radiogroup" aria-label="Language">
      ${LANGS.map(([code, label]) => `<button type="button" class="rs-lang-btn" role="radio" data-lang="${code}" lang="${code}">${label}</button>`).join('')}
    </div>
    <div class="rs-content">
      <h1 class="rs-title" id="rs-title"></h1>
      <p class="rs-body"></p>
      <div class="rs-options" role="radiogroup" aria-labelledby="rs-title"></div>
      <p class="rs-note" aria-live="polite"></p>
      <button type="button" class="btn btn-primary ob-btn rs-continue" disabled></button>
    </div>`
  const titleEl     = root.querySelector('#rs-title')
  const bodyEl      = root.querySelector('.rs-body')
  const optionsEl   = root.querySelector('.rs-options')
  const noteEl      = root.querySelector('.rs-note')
  const continueBtn = root.querySelector('.rs-continue')
  const langEl      = root.querySelector('.rs-lang')

  // The roles on offer: the lenses of the fixed order that are installed
  const roles = () => (isLoaded() ? LENS_ORDER.map(id => getLens(id)).filter(Boolean) : [])
  const optionFor = role => [...optionsEl.querySelectorAll('.rs-option')].find(el => el.dataset.role === role) ?? null

  function paintText() {
    titleEl.textContent     = t('lens.role.title')
    bodyEl.textContent      = t('lens.role.body')
    continueBtn.textContent = t('lens.role.continue')
    const lang = currentLang()
    for (const b of langEl.querySelectorAll('.rs-lang-btn')) b.setAttribute('aria-checked', b.dataset.lang === lang ? 'true' : 'false')
  }

  // The language switch: saved like Settings › Language (the preview only switches, saves nothing)
  langEl.addEventListener('click', e => {
    const code = e.target.closest('.rs-lang-btn')?.dataset.lang
    if (!code || code === currentLang()) return
    if (preview) setLang(code)
    else setSetting('language', code).catch(err => { log.warn('language_save_failed', { error: err }); setLang(code) })
  })

  function paintOptions() {
    const list = roles()
    if (!list.length) {
      // Before the lens data arrives: three flat blocks in the cards' place (guide B0)
      if (!optionsEl.querySelector('.rs-option--skeleton')) {
        renderedHtml = null
        optionsEl.setAttribute('aria-busy', 'true')
        optionsEl.innerHTML = LENS_ORDER.map((_, i) => `
          <div class="rs-option rs-option--skeleton" aria-hidden="true">
            <span class="rs-option-icon"></span>
            <span class="rs-option-text">
              <span class="rs-option-name"><span class="rs-skel" style="width:${[72, 84, 64][i % 3]}%"></span></span>
              <span class="rs-option-sub"><span class="rs-skel" style="width:${[58, 50, 62][i % 3]}%"></span></span>
            </span>
            <span class="rs-radio"></span>
          </div>`).join('')
      }
      if (!noDataTimer) noDataTimer = setTimeout(giveUp, NO_DATA_MS)
      paintSelection()
      return
    }
    clearTimeout(noDataTimer)
    noDataTimer = null
    if (selected && !list.some(l => l.id === selected)) selected = null
    const html = list.map(l => `
      <button type="button" class="rs-option" role="radio" aria-checked="false" data-role="${esc(l.id)}">
        <span class="rs-option-icon">${iconHtml(ROLE_ICON[l.id] ?? 'tag')}</span>
        <span class="rs-option-text">
          <span class="rs-option-name">${esc(lensName(l))}</span>
          <span class="rs-option-sub">${esc(lensSummary(l))}</span>
        </span>
        <span class="rs-radio" aria-hidden="true"></span>
      </button>`).join('')
    // LENS_LOADED also fires when nothing shown here changed (tags, the switch): keep the
    // same cards then, so a press in progress, the hover and the focus all stay
    if (html !== renderedHtml) {
      const focusedRole = document.activeElement?.closest?.('.rs-option')?.dataset.role ?? null
      optionsEl.removeAttribute('aria-busy')
      optionsEl.innerHTML = html
      renderedHtml = html
      if (focusedRole) optionFor(focusedRole)?.focus({ preventScroll: true })
    }
    paintSelection()
  }

  // The choice shows in the selection colour only: nothing moves (§8.1)
  function paintSelection() {
    const opts = [...optionsEl.querySelectorAll('.rs-option[data-role]')]
    const tabStop = selected ?? opts[0]?.dataset.role
    for (const el of opts) {
      const on = el.dataset.role === selected
      el.setAttribute('aria-checked', on ? 'true' : 'false')
      el.tabIndex = el.dataset.role === tabStop ? 0 : -1   // one tab stop for the group
    }
    continueBtn.disabled = !selected || busy
  }

  function choose(role, { focus = true } = {}) {
    if (busy || closed || !role || !roles().some(l => l.id === role)) return
    selected = role
    noteEl.textContent = ''
    paintSelection()
    if (focus) optionFor(role)?.focus({ preventScroll: true })
  }

  async function submit() {
    if (!selected || busy || closed) return
    busy = true
    paintSelection()
    continueBtn.setAttribute('aria-busy', 'true')
    noteEl.textContent = ''
    if (preview) { finish(selected); return }
    try {
      await applyRole(selected)   // apply_role + the settings cache (user_role, the switch) + reload
      log.info('chosen', { role: selected })
      finish(selected)
    } catch (err) {
      failures++
      log.warn('apply_failed', { role: selected, attempt: failures, error: err })
      busy = false
      continueBtn.removeAttribute('aria-busy')
      if (failures >= MAX_FAILURES) { finish(null); return }
      noteEl.textContent = t('lens.role.failed')
      paintSelection()
    }
  }

  function giveUp() {
    noDataTimer = null
    if (roles().length) return
    log.warn('no_lens_data', { waited_ms: NO_DATA_MS })
    finish(null)
  }

  // The step has the keyboard unless something sits on top of it: a dialog, or the sign-in
  // screen (it shows over this step if bloot apps signs out meanwhile).
  function ownsKeyboard() {
    if (closed || document.querySelector('.dlg-overlay.dlg-visible')) return false
    const signIn = document.getElementById('onboarding-root')
    if (signIn && !signIn.hidden) return false
    const a = document.activeElement
    return !a || a === document.body || root.contains(a)
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !ownsKeyboard()) return
    const ids = roles().map(l => l.id)
    if (!ids.length) return
    const focusedRole = document.activeElement?.closest?.('.rs-option')?.dataset.role ?? null
    const at = ids.indexOf(selected ?? focusedRole)
    let next = null
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight': next = ids[at < 0 ? 0 : (at + 1) % ids.length]; break
      case 'ArrowUp':
      case 'ArrowLeft':  next = ids[at < 0 ? ids.length - 1 : (at - 1 + ids.length) % ids.length]; break
      case 'Home':       next = ids[0]; break
      case 'End':        next = ids[ids.length - 1]; break
      case ' ':
        if (!focusedRole) return             // Space on Continue: the button's own click
        next = focusedRole
        break
      case 'Enter':
        if (document.activeElement === continueBtn) return   // the button's own click
        e.preventDefault()
        e.stopPropagation()
        if (focusedRole) choose(focusedRole)
        submit()
        return
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    choose(next)
  }

  optionsEl.addEventListener('click', e => {
    const opt = e.target.closest('.rs-option[data-role]')
    if (opt) choose(opt.dataset.role)
  })
  continueBtn.addEventListener('click', submit)
  window.addEventListener('keydown', onKey, true)   // before the app's own shortcuts
  const onLoaded = store.on(events.LENS_LOADED, () => paintOptions())
  const onLang = () => { paintText(); paintOptions() }
  document.addEventListener('i18n:changed', onLang)

  // Nothing behind the step takes focus or clicks while it is up
  const inerted = []
  for (const id of ['app', 'nav-drawer']) {
    const el = document.getElementById(id)
    if (el && !el.hasAttribute('inert')) { el.setAttribute('inert', ''); inerted.push(el) }
  }

  function finish(result) {
    if (closed) return
    closed = true
    clearTimeout(noDataTimer)
    window.removeEventListener('keydown', onKey, true)
    store.off(events.LENS_LOADED, onLoaded)
    document.removeEventListener('i18n:changed', onLang)
    for (const el of inerted) el.removeAttribute('inert')
    resolve(result)
    // Out: a short fade (exits are quicker than entrances), then gone
    root.style.pointerEvents = 'none'
    if (reducedMotion() || typeof root.animate !== 'function') { root.remove(); return }
    root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.exit, easing: EASE_IN, fill: 'forwards' })
      .finished.then(() => root.remove(), () => root.remove())
    setTimeout(() => root.remove(), DUR.exit + 250)   // a hidden window may never finish the animation
  }

  try {
    paintText()
    paintOptions()
    // Just under the sign-in screen (same canvas): a sign-in that's needed again covers the step
    const signIn = document.getElementById('onboarding-root')
    if (signIn?.parentNode === document.body) document.body.insertBefore(root, signIn)
    else document.body.appendChild(root)
    root.focus({ preventScroll: true })
    log.info('shown', { preview, lenses_loaded: isLoaded() })
  } catch (err) {
    // Never leave the app inert behind a step that didn't open: ask again next launch
    log.error('open_failed', { error: err })
    finish(null)
  }
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
