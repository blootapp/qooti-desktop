// In-app feedback modal. Collects a message + a diagnostics snapshot and posts it
// to the worker, which forwards it to the maintainer's Telegram. Reuses the shared
// .dlg-* modal styling.
import { gatherDiagnostics } from './diagnostics.js'
import { t } from './i18n.js'

const API = 'https://api.bloot.app/public/feedback'

let _overlay = null
function getOverlay() {
  if (!_overlay) {
    _overlay = document.createElement('div')
    _overlay.className = 'dlg-overlay'
    document.body.appendChild(_overlay)
  }
  return _overlay
}

export function openFeedbackModal() {
  const overlay = getOverlay()
  overlay.innerHTML = `
    <div class="dlg-box fb-box">
      <div class="dlg-header">
        <div class="dlg-icon">${icon('note', 20)}</div>
        <div class="dlg-title">${esc(t('feedback.title'))}</div>
      </div>
      <div class="dlg-message">${esc(t('feedback.sub'))}</div>
      <textarea class="dlg-input fb-textarea" id="_fb-msg" rows="5"
        placeholder="${esc(t('feedback.placeholder'))}" maxlength="4000" spellcheck="true"></textarea>
      <div class="fb-note">${icon('info', 14)}<span>${esc(t('feedback.note'))}</span></div>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-btn--ghost"   id="_fb-cancel">${esc(t('feedback.cancel'))}</button>
        <button class="dlg-btn dlg-btn--primary" id="_fb-send">${esc(t('feedback.send'))}</button>
      </div>
    </div>
  `
  overlay.classList.add('dlg-visible')

  const box     = overlay.querySelector('.fb-box')
  const ta      = overlay.querySelector('#_fb-msg')
  const sendBtn = overlay.querySelector('#_fb-send')
  const cancel  = overlay.querySelector('#_fb-cancel')

  let settled = false
  const close = () => {
    if (settled) return
    settled = true
    overlay.classList.remove('dlg-visible')
    document.removeEventListener('keydown', onKey)
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
  }

  async function submit() {
    const message = ta.value.trim()
    if (!message) { ta.focus(); return }

    sendBtn.disabled = true
    cancel.disabled  = true
    sendBtn.textContent = t('feedback.sending')
    box.querySelector('.fb-error')?.remove()

    try {
      const diag = await gatherDiagnostics()
      const res = await fetch(API, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...diag, message }),
      })
      if (!res.ok) throw new Error('bad status ' + res.status)

      box.innerHTML = `
        <div class="dlg-header">
          <div class="dlg-icon">${icon('check-circle', 20)}</div>
          <div class="dlg-title">${esc(t('feedback.thanks_title'))}</div>
        </div>
        <div class="dlg-message">${esc(t('feedback.thanks_sub'))}</div>
        <div class="dlg-actions">
          <button class="dlg-btn dlg-btn--primary" id="_fb-done">${esc(t('feedback.done'))}</button>
        </div>
      `
      const done = box.querySelector('#_fb-done')
      done.addEventListener('click', close)
      done.focus()
    } catch (err) {
      console.error('[feedback] send failed:', err)
      sendBtn.disabled = false
      cancel.disabled  = false
      sendBtn.textContent = t('feedback.send')
      const errEl = document.createElement('div')
      errEl.className = 'fb-error'
      errEl.textContent = t('feedback.error')
      ta.after(errEl)
    }
  }

  sendBtn.addEventListener('click', submit)
  cancel.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close() }, { once: true })

  requestAnimationFrame(() => ta.focus())
}

const icon = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

function esc(s) {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
