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
}

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

let sites = []

function renderSites() {
  const list = $('site-list')
  list.innerHTML = ''
  for (const host of sites) {
    const li = document.createElement('li')
    li.className = 'site'
    const name = document.createElement('span')
    name.className = 'site-host'
    name.textContent = host
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'icon-btn'
    remove.title = t('set.hidden.remove', { host })
    remove.setAttribute('aria-label', remove.title)
    remove.innerHTML = '<span class="icon icon--close"></span>'
    remove.addEventListener('click', async () => {
      sites = await setHiddenSites(sites.filter(h => h !== host))
      renderSites()
    })
    li.append(name, remove)
    list.appendChild(li)
  }
  $('sites-sub').textContent = sites.length ? t('set.hidden.sub') : t('set.hidden.none')
}

function showSiteError(show) {
  $('site-field').classList.toggle('input--bad', show)
  $('site-error').hidden = !show
}

$('site-form').addEventListener('submit', async e => {
  e.preventDefault()
  const input = $('site-input')
  const host = normHost(input.value)
  if (!looksLikeHost(host)) { showSiteError(true); input.focus(); return }
  showSiteError(false)
  input.value = ''
  sites = await setHiddenSites([...sites, host])
  renderSites()
})
$('site-input').addEventListener('input', () => showSiteError(false))

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.bannedSites) { sites = changes.bannedSites.newValue ?? []; renderSites() }
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
  // Sent here from a message on a page ("Settings"): show that part
  const part = document.getElementById(location.hash.slice(1))
  if (part?.classList.contains('section')) {
    part.scrollIntoView({ block: 'start' })
    part.classList.add('section--flash')
  }
})()
