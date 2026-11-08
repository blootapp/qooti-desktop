// qooti extension settings — the connection, saving, where the button hides, sign-in
// for videos, language. The popup only shows the connection and the current site.

const $ = id => document.getElementById(id)

// ─── Connection ──────────────────────────────────────────────────

let statusTimer = null
let lastStatus  = null

async function refreshStatus() {
  const res = lastStatus = await send({ action: 'get-status' })
  renderStatus()
  clearTimeout(statusTimer)
  const pending = res?.running && !res?.connected && res?.pairing === 'pending'
  statusTimer = setTimeout(refreshStatus, pending ? 1500 : 5000)
}

function renderStatus() {
  const res = lastStatus
  const pairing = res?.running && !res?.connected ? res.pairing : null
  $('status-dot').classList.toggle('status-dot--on', !!res?.connected)
  $('app-version').textContent = res?.version ?? ''
  $('app-status').textContent = res?.connected ? t('set.app.connected')
    : pairing === 'pending' ? t('set.app.pending')
    : pairing === 'denied' ? t('set.app.denied')
    : res?.running ? t('status.connecting') : t('set.app.not_running')
  const btn = $('btn-app')
  btn.hidden = !!res?.connected || pairing === 'pending' || (!!res?.running && !pairing)
  btn.dataset.do = pairing === 'denied' ? 'connect' : 'open'
  btn.textContent = pairing === 'denied' ? t('popup.connect_again') : t('common.open_qooti')
  // Free plan: the card (Pro, or qooti not connected: no Plan section)
  renderPlanCard($('set-plan'), res?.connected ? res.plan : null)
  $('plan-section').hidden = $('set-plan').hidden
}

$('set-plan').querySelector('.plan-upgrade').addEventListener('click', () => {
  chrome.tabs.create({ url: PLAN_URL })
})

$('btn-app').addEventListener('click', async () => {
  const btn = $('btn-app')
  btn.disabled = true
  if (btn.dataset.do === 'connect') await send({ action: 'pair-now' })
  else await send({ action: 'open-app' })
  btn.disabled = false
  refreshStatus()
})

// ─── Switches kept in the browser's synced settings ──────────────

function bindToggle(id, key, onChange) {
  const row = $(id)
  const render = on => row.setAttribute('aria-checked', String(on))
  chrome.storage.sync.get(key).then(res => render(res[key] !== false))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[key]) render(changes[key].newValue !== false)
  })
  row.addEventListener('click', async () => {
    const on = row.getAttribute('aria-checked') !== 'true'
    render(on)
    await chrome.storage.sync.set({ [key]: on })
    onChange?.(on)
  })
}

bindToggle('toggle-picker', 'showPicker')
// qooti also shows (or not) its own download toasts for saves from the browser
bindToggle('toggle-progress', 'showDownloadPanel', on => {
  send({ action: 'set-pref', key: 'show_download_toast', value: on ? 'true' : 'false' })
})

// ─── Sites where the save button stays hidden ────────────────────
// Small chips, newest first. The card shows two lines of them; "+N more" opens the
// rest right there for up to INLINE_MAX sites, and a page of its own (with a search
// field) for longer lists.

const INLINE_MAX = 20

let sites = []          // as stored: oldest first
let expanded = false    // the card shows every chip (only while ≤ INLINE_MAX)
let fresh = null        // a site just added: its chip lights up once
let freshTimer = null
let note = null         // the line under the field: { key, bad }

const newestFirst = () => [...sites].reverse()
const countText = n => t(n === 1 ? 'set.hidden.count_one' : 'set.hidden.count', { n })

function chip(host) {
  const el = document.createElement('span')
  el.className = host === fresh ? 'chip chip--new' : 'chip'
  const name = document.createElement('span')
  name.className = 'chip-host'
  name.textContent = host
  const x = document.createElement('button')
  x.type = 'button'
  x.className = 'chip-x'
  x.title = t('set.hidden.remove', { host })
  x.setAttribute('aria-label', x.title)
  x.innerHTML = '<span class="icon icon--close"></span>'
  x.addEventListener('click', () => removeSite(host, el))
  el.append(name, x)
  return el
}

const moreBtn = document.createElement('button')
moreBtn.type = 'button'
moreBtn.className = 'chips-more'
moreBtn.addEventListener('click', () => {
  if (sites.length > INLINE_MAX) return openSheet()
  expanded = !expanded
  fold()
})

function renderSites() {
  const n = sites.length
  $('sites-sub').textContent = n ? t('set.hidden.sub') : t('set.hidden.none')
  $('sites-count').textContent = n ? countText(n) : ''
  if (n > INLINE_MAX) expanded = false
  const box = $('site-chips')
  box.hidden = !n
  box.replaceChildren(...newestFirst().map(chip), moreBtn)
  fold()
  renderNote()
  if (!sheet.hidden) renderSheet()
}

// Two lines of chips, then "+N more" — or every chip and "Show less" when opened.
function fold() {
  const box = $('site-chips')
  const chips = [...box.querySelectorAll('.chip')]
  for (const c of chips) c.hidden = false
  moreBtn.hidden = true
  if (box.hidden) return
  const lines = [...new Set(chips.map(c => c.offsetTop))]
  if (lines.length <= 2) { expanded = false; return }
  const n = chips.length
  moreBtn.hidden = false
  if (n > INLINE_MAX) {
    moreBtn.setAttribute('aria-haspopup', 'dialog')
    moreBtn.removeAttribute('aria-expanded')
  } else {
    moreBtn.removeAttribute('aria-haspopup')
    moreBtn.setAttribute('aria-expanded', String(expanded))
    if (expanded) { moreBtn.textContent = t('set.hidden.less'); return }
  }
  // Everything from the first chip on line three goes behind the button
  const cut = lines[2]
  const first = chips.findIndex(c => c.offsetTop >= cut)
  const shown = chips.slice(0, first)
  for (const c of chips.slice(first)) c.hidden = true
  const label = () => { moreBtn.textContent = t('set.hidden.more', { n: n - shown.length }) }
  label()
  // The button itself has to fit on line two
  while (moreBtn.offsetTop >= cut && shown.length > 1) { shown.pop().hidden = true; label() }
}

async function removeSite(host, el) {
  // The keyboard stays put: on the next chip's ×, else the one before, else the field
  const box = el.parentElement
  const at = [...box.querySelectorAll('.chip')].indexOf(el)
  const hadFocus = el.contains(document.activeElement)
  sites = await setHiddenSites(sites.filter(h => h !== host))
  renderSites()
  if (!hadFocus) return
  const xs = [...box.querySelectorAll('.chip:not([hidden]) .chip-x')]
  const fallback = box === $('sheet-chips') ? $('sheet-search') : moreBtn.hidden ? $('site-input') : moreBtn
  ;(xs[at] ?? xs[at - 1] ?? fallback).focus()
}

function showNote(key, bad = false) {
  note = key ? { key, bad } : null
  renderNote()
}
function renderNote() {
  const el = $('site-note')
  el.hidden = !note
  el.textContent = note ? t(note.key) : ''
  el.classList.toggle('field-note--bad', !!note?.bad)
  $('site-field').classList.toggle('input--bad', !!note?.bad)
}

$('site-form').addEventListener('submit', async e => {
  e.preventDefault()
  const input = $('site-input')
  const host = normHost(input.value)
  if (!looksLikeHost(host)) { showNote('set.hidden.bad', true); input.focus(); return }
  input.value = ''
  // Already hidden there (the site itself, or a site it belongs to): that chip moves
  // to the front instead of a second one
  const covered = sites.find(s => hostMatches(host, s))
  const site = covered ?? host
  fresh = site
  clearTimeout(freshTimer)
  freshTimer = setTimeout(() => { fresh = null }, 1600)
  note = covered ? { key: 'set.hidden.dupe', bad: false } : null
  sites = await setHiddenSites([...sites.filter(h => h !== site), site])
  renderSites()
})
$('site-input').addEventListener('input', () => { if (note) showNote(null) })

// Changed in the popup (or on another computer through sync)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.bannedSites) return
  const next = changes.bannedSites.newValue ?? []
  if (next.length === sites.length && next.every((h, i) => h === sites[i])) return
  sites = next
  renderSites()
})

// Chips wrap by width: fold again when the card gets wider or narrower, and once
// the font has loaded (it changes every chip's width)
let foldedAt = 0
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width)
  if (w && w !== foldedAt) { foldedAt = w; fold() }
}).observe($('site-chips'))
document.fonts?.addEventListener('loadingdone', () => fold())

// ─── All hidden sites on one page ────────────────────────────────
// It is a step in the tab's history, so the browser's Back button closes it too.

const sheet = $('sites-sheet')
const behindSheet = [document.querySelector('body > .topbar'), document.querySelector('main')]

function renderSheet() {
  const search = $('sheet-search').value.trim()
  const q = search.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '')
  const list = newestFirst().filter(h => h.includes(q))
  $('sheet-chips').replaceChildren(...list.map(chip))
  const n = sites.length
  $('sheet-sub').textContent = n ? t('set.hidden.sub') : t('set.hidden.none')
  $('sheet-count').textContent = n ? countText(n) : ''
  const empty = $('sheet-empty')
  empty.hidden = !n || list.length > 0
  empty.textContent = empty.hidden ? '' : t('set.hidden.no_match', { q: search })
}

function showSheet(open) {
  if (open === !sheet.hidden) return
  sheet.hidden = !open
  document.body.classList.toggle('has-sheet', open)
  for (const el of behindSheet) el.inert = open
  if (open) {
    $('sheet-search').value = ''
    renderSheet()
    sheet.scrollTop = 0
    $('sheet-search').focus()
  } else {
    fold()
    ;(moreBtn.hidden ? $('site-input') : moreBtn).focus()
  }
}

function openSheet() {
  history.pushState({ sheet: true }, '', '#hidden-sites')
  showSheet(true)
}
function closeSheet() {
  if (history.state?.sheet) history.back()    // popstate closes it
  else showSheet(false)
}
addEventListener('popstate', () => showSheet(!!history.state?.sheet))

$('sheet-close').addEventListener('click', closeSheet)
$('sheet-search').addEventListener('input', renderSheet)
sheet.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeSheet() }
})

// ─── Sign-in for Instagram and TikTok videos ─────────────────────
// An optional permission: the browser asks the user, and it can be taken back here.

const SIGNIN = { permissions: ['cookies'], origins: ['https://*.instagram.com/*', 'https://*.tiktok.com/*'] }

async function renderSignin() {
  const on = await chrome.permissions.contains(SIGNIN).catch(() => false)
  $('toggle-signin').setAttribute('aria-checked', String(on))
}

$('toggle-signin').addEventListener('click', async () => {
  $('signin-note').hidden = true
  if ($('toggle-signin').getAttribute('aria-checked') === 'true') {
    await chrome.permissions.remove(SIGNIN).catch(() => {})
  } else {
    // Asked straight from the click: the browser shows its own question
    const granted = await chrome.permissions.request(SIGNIN).catch(() => false)
    if (!granted) $('signin-note').hidden = false
  }
  renderSignin()
})
chrome.permissions.onAdded.addListener(renderSignin)
chrome.permissions.onRemoved.addListener(renderSignin)

// ─── Language ────────────────────────────────────────────────────

async function renderLang() {
  const { lang } = await chrome.storage.sync.get('lang')
  const current = lang === 'en' || lang === 'uz' ? lang : 'auto'
  for (const b of $('lang').querySelectorAll('[data-lang]')) b.setAttribute('aria-checked', String(b.dataset.lang === current))
}

$('lang').addEventListener('click', e => {
  const b = e.target.closest('[data-lang]')
  if (b) chrome.storage.sync.set({ lang: b.dataset.lang })
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.lang || changes.appLang)) renderAll()
})

// ─── Start ───────────────────────────────────────────────────────

async function renderAll() {
  await loadLang()
  document.title = `${t('set.title')} — qooti`
  $('ext-version').textContent = chrome.runtime.getManifest().version
  $('link-privacy').href = siteUrl('/privacy')
  $('link-help').href = siteUrl('/help')
  renderStatus()
  renderSites()
  renderLang()
}

;(async () => {
  sites = await getHiddenSites()
  await renderAll()
  renderSignin()
  refreshStatus()
  // Reloaded while the full list was open: open it again (if the list is still long)
  if (history.state?.sheet) {
    if (sites.length > INLINE_MAX) showSheet(true)
    else history.replaceState(null, '', location.pathname)
  }
  // Sent here from a message on a page ("Settings"): show that part
  const part = document.getElementById(location.hash.slice(1))
  if (part?.classList.contains('section')) {
    part.scrollIntoView({ block: 'start' })
    part.classList.add('section--flash')
  }
})()
