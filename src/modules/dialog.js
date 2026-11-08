// Shared in-app dialog — replaces native prompt() / confirm()
import { t } from './i18n.js'

let _overlay = null

/** True while a dialog is on screen — other key handlers should stand aside. */
export function isDialogOpen() {
  // Any dialog: this file's, or one a module builds on the same overlay styles
  return !!_overlay?.classList.contains('dlg-visible') || !!document.querySelector('.dlg-overlay.dlg-visible')
}

/** "Are you sure?" before an item is deleted. Resolves true only when the user confirms. */
export function confirmDeleteItem() {
  return showConfirm({
    title: t('item.delete_title'),
    message: t('item.delete_msg'),
    danger: true,
    confirmLabel: t('action.delete'),
  })
}

function getOverlay() {
  if (!_overlay) {
    _overlay = document.createElement('div')
    _overlay.className = 'dlg-overlay'
    document.body.appendChild(_overlay)
    // The header's X behaves like Cancel (or OK when a dialog has nothing to cancel)
    _overlay.addEventListener('click', e => {
      if (!e.target.closest('[data-dlg-close]')) return
      ;(_overlay.querySelector('#_dlg-cancel') ?? _overlay.querySelector('#_dlg-ok'))?.click()
    })
  }
  return _overlay
}

// Guide H: title on the left, X on the right — no icon tile.
function header(title) {
  return `
    <div class="dlg-header">
      <div class="dlg-title">${escHtml(title)}</div>
      <button class="dlg-close" data-dlg-close aria-label="Close">${I('x', 16)}</button>
    </div>`
}

export function showPrompt({ title, placeholder = '', value = '', confirmLabel = 'Create', icon = null }) {
  return new Promise(resolve => {
    const overlay = getOverlay()
    overlay.innerHTML = `
      <div class="dlg-box">
        ${header(title)}
        <input class="dlg-input" placeholder="${escHtml(placeholder)}" value="${escHtml(value)}"
          autocomplete="off" spellcheck="false" />
        <div class="dlg-actions">
          <button class="dlg-btn dlg-btn--ghost" id="_dlg-cancel">${escHtml(t('action.cancel'))}</button>
          <button class="dlg-btn dlg-btn--primary" id="_dlg-ok">${escHtml(confirmLabel)}</button>
        </div>
      </div>
    `
    overlay.classList.add('dlg-visible')

    let settled = false
    const close = val => {
      if (settled) return
      settled = true
      overlay.classList.remove('dlg-visible')
      resolve(val)
    }

    const input  = overlay.querySelector('.dlg-input')
    const okBtn  = overlay.querySelector('#_dlg-ok')
    const cancel = overlay.querySelector('#_dlg-cancel')

    requestAnimationFrame(() => { input.focus(); input.select() })

    okBtn.addEventListener('click', () => close(input.value.trim() || null))
    cancel.addEventListener('click', () => close(null))
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); close(input.value.trim() || null) }
      if (e.key === 'Escape') { e.preventDefault(); close(null) }
    })
    overlay.addEventListener('pointerdown', e => {
      if (e.target === overlay) close(null)
    }, { once: true })
  })
}

// Without checkboxLabel: resolves true/false.
// With checkboxLabel:    resolves { ok: true, checked: bool } or false.
export function showConfirm({ title, message = '', danger = false, confirmLabel = 'Confirm', cancelLabel = 'Cancel', icon = null, checkboxLabel = null }) {
  return new Promise(resolve => {
    const overlay = getOverlay()
    overlay.innerHTML = `
      <div class="dlg-box">
        ${header(title)}
        ${message ? `<div class="dlg-message">${escHtml(message)}</div>` : ''}
        ${checkboxLabel ? `
        <label class="dlg-check-row">
          <input type="checkbox" id="_dlg-chk" />
          <span class="dlg-check-label">${escHtml(checkboxLabel)}</span>
        </label>` : ''}
        <div class="dlg-actions">
          <button class="dlg-btn dlg-btn--ghost" id="_dlg-cancel">${escHtml(cancelLabel)}</button>
          <button class="dlg-btn ${danger ? 'dlg-btn--danger' : 'dlg-btn--primary'}" id="_dlg-ok">${escHtml(confirmLabel)}</button>
        </div>
      </div>
    `
    overlay.classList.add('dlg-visible')

    let settled = false
    const close = val => {
      if (settled) return
      settled = true
      overlay.classList.remove('dlg-visible')
      document.removeEventListener('keydown', onKey)
      resolve(val)
    }

    const confirm = () => {
      if (!checkboxLabel) { close(true); return }
      const checked = overlay.querySelector('#_dlg-chk')?.checked ?? false
      close({ ok: true, checked })
    }

    function onKey(e) {
      if (e.key === 'Enter')  { e.preventDefault(); confirm() }
      if (e.key === 'Escape') { e.preventDefault(); close(false) }
    }

    overlay.querySelector('#_dlg-ok').addEventListener('click', confirm)
    overlay.querySelector('#_dlg-cancel').addEventListener('click', () => close(false))
    overlay.addEventListener('pointerdown', e => {
      if (e.target === overlay) close(false)
    }, { once: true })
    document.addEventListener('keydown', onKey)

    requestAnimationFrame(() => overlay.querySelector('#_dlg-ok').focus())
  })
}

export function showAlert({ title, message = '', danger = false, icon = null, okLabel = 'OK' }) {
  return new Promise(resolve => {
    const overlay = getOverlay()
    overlay.innerHTML = `
      <div class="dlg-box">
        ${header(title)}
        ${message ? `<div class="dlg-message dlg-message--pre">${escHtml(message)}</div>` : ''}
        <div class="dlg-actions">
          <button class="dlg-btn dlg-btn--primary" id="_dlg-ok">${escHtml(okLabel)}</button>
        </div>
      </div>
    `
    overlay.classList.add('dlg-visible')

    let settled = false
    const close = () => {
      if (settled) return
      settled = true
      overlay.classList.remove('dlg-visible')
      document.removeEventListener('keydown', onKey)
      resolve()
    }

    function onKey(e) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); close() }
    }

    overlay.querySelector('#_dlg-ok').addEventListener('click', close)
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close() }, { once: true })
    document.addEventListener('keydown', onKey)

    requestAnimationFrame(() => overlay.querySelector('#_dlg-ok').focus())
  })
}

// Three-button variant for the "already in library" duplicate flow.
// Resolves to: 'view' | 'download' | null (cancel / backdrop click)
export function showDuplicateDialog({ title, message = '' }) {
  return new Promise(resolve => {
    const overlay = getOverlay()
    overlay.innerHTML = `
      <div class="dlg-box">
        ${header(title)}
        ${message ? `<div class="dlg-message">${escHtml(message)}</div>` : ''}
        <div class="dlg-actions">
          <button class="dlg-btn dlg-btn--ghost"      id="_dlg-cancel">${escHtml(t('action.cancel'))}</button>
          <button class="dlg-btn dlg-btn--secondary"  id="_dlg-view">${escHtml(t('dlg.dup.view'))}</button>
          <button class="dlg-btn dlg-btn--primary"    id="_dlg-ok">${escHtml(t('dlg.dup.anyway'))}</button>
        </div>
      </div>
    `
    overlay.classList.add('dlg-visible')

    let settled = false
    const close = val => {
      if (settled) return
      settled = true
      overlay.classList.remove('dlg-visible')
      document.removeEventListener('keydown', onKey)
      resolve(val)
    }

    function onKey(e) {
      if (e.key === 'Enter')  { e.preventDefault(); close('download') }
      if (e.key === 'Escape') { e.preventDefault(); close(null) }
    }

    overlay.querySelector('#_dlg-ok').addEventListener('click',     () => close('download'))
    overlay.querySelector('#_dlg-view').addEventListener('click',   () => close('view'))
    overlay.querySelector('#_dlg-cancel').addEventListener('click', () => close(null))
    overlay.addEventListener('pointerdown', e => {
      if (e.target === overlay) close(null)
    }, { once: true })
    document.addEventListener('keydown', onKey)

    requestAnimationFrame(() => overlay.querySelector('#_dlg-ok').focus())
  })
}

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

function escHtml(str) {
  if (!str) return ''
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
