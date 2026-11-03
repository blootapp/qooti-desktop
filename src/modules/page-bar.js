// Top bar on pages without search (guide D1 Collections, D2 inside a collection, I1
// Settings). Menu + logo and downloads + avatar stay exactly where they are in the
// library; only the centre and the action change:
//   centre — the page title instead of the search bar, optionally "Collections ›" in
//            front (a link back) and a quiet item count after it
//   right  — the page's own action in place of Import (primary or secondary)
// setPageBar(null) brings the library bar back. main.js resets it on every page change;
// the page then sets its own on NAV_CHANGE.

let _onCrumb  = null
let _onAction = null

const $ = id => document.getElementById(id)

export function initPageBar() {
  $('page-bar-crumb')?.addEventListener('click', () => _onCrumb?.())
  $('page-bar-action')?.addEventListener('click', () => _onAction?.())

  // Shortcuts for "back" while a back pill is showing — only when nothing else wants
  // the key: not while typing, and not while a dialog, menu or the item viewer is open.
  const overlayOpen = () => !!document.querySelector(
    '.detail-modal.open, .import-modal.is-open, .dlg-overlay.dlg-visible, .upgrade-modal-backdrop, .ctx-menu, .cp-popover, .sm-menu, .nav-drawer.nav-open')
  document.addEventListener('keydown', e => {
    if (!_onCrumb || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key !== 'Escape' && e.key !== 'Backspace') return
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || overlayOpen()) return
    e.preventDefault()
    _onCrumb()
  })
  document.addEventListener('mouseup', e => {
    if (e.button === 3 && _onCrumb && !overlayOpen()) { e.preventDefault(); _onCrumb() }   // mouse "back" button
  })
}

/** spec: { title, crumb?: { label, onClick }, count?, action?: { label, primary?, onClick } } | null */
export function setPageBar(spec) {
  const on = !!spec
  $('top-bar')?.classList.toggle('is-page', on)
  $('page-bar-title').hidden = !on
  document.querySelector('.top-bar-search-wrap').hidden = on
  $('top-bar-import-btn').hidden = on

  // The way back: a "← Collections" pill (guide D2), also reachable by Esc, Backspace
  // (outside text fields) and the mouse's back button — see initPageBar.
  const crumb = $('page-bar-crumb')
  crumb.hidden = !spec?.crumb
  $('page-bar-crumb-label').textContent = spec?.crumb?.label ?? ''
  crumb.setAttribute('aria-label', spec?.crumb ? `Back to ${spec.crumb.label}` : '')
  _onCrumb = spec?.crumb?.onClick ?? null

  $('page-bar-name').textContent = spec?.title ?? ''
  setPageBarCount(spec?.count ?? '')

  const action = $('page-bar-action')
  action.hidden = !spec?.action
  action.textContent = spec?.action?.label ?? ''
  action.classList.toggle('is-primary', !!spec?.action?.primary)
  _onAction = spec?.action?.onClick ?? null
}

/** The count can arrive later (it's fetched) — update just that. */
export function setPageBarCount(text) {
  const el = $('page-bar-count')
  if (!el) return
  el.textContent = text || ''
  el.hidden = !text
}
