// qooti popup — the connection at a glance, the save button on this site, and the way
// to the settings page (everything else lives there).

const $ = id => document.getElementById(id)

// The button never shows on bloot's own sites (manifest exclude_matches)
const NO_BUTTON = ['bloot.app', 'bloot-admin.pages.dev', 'bloot-dashboard.pages.dev', 'bloot-landing.pages.dev']

let lastStatus  = null
let pairingPoll = null
let currentHost = null
let hiddenSites = []

$('footer-version').textContent = `v${chrome.runtime.getManifest().version}`

// ─── Connection status ───────────────────────────────────────────

function renderStatus(res) {
  lastStatus = res ?? null
  const pairing = res?.running && !res?.connected ? res.pairing : null   // 'pending' | 'denied'
  $('status-dot').classList.toggle('status-dot--on', !!res?.connected)
  $('status-text').textContent = res?.connected ? t('status.connected')
    : pairing === 'pending' ? t('status.waiting')
    : pairing === 'denied' ? t('status.not_connected')
    : res?.running ? t('status.connecting') : t('status.not_running')
  $('closed').hidden = !!res?.running
  $('btn-open-footer').hidden = !res?.running

  // qooti asks the user before a browser may save into it
  $('pairing').hidden = !pairing
  if (pairing === 'pending') {
    $('pairing-title').textContent = t('pair.pending.title')
    $('pairing-text').textContent  = t('popup.pending.text')
  } else if (pairing === 'denied') {
    $('pairing-title').textContent = t('pair.denied.title')
    $('pairing-text').textContent  = t('popup.denied.text')
  }
  $('pairing-actions').hidden = pairing !== 'denied'
  // While qooti is asking, keep looking so the popup turns to Connected by itself
  clearTimeout(pairingPoll)
  if (pairing === 'pending') pairingPoll = setTimeout(checkStatus, 1500)

  $('ready').hidden = !res?.running || !!pairing
  renderHere()
}

async function checkStatus() {
  const res = await send({ action: 'get-status' })
  renderStatus(res)
  return res
}

async function openApp() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
  await send({ action: 'open-app', tab_id: tab?.id ?? null })
}

// "Open qooti" launches the app via its qooti:// link, then waits for it to come up.
$('btn-open').addEventListener('click', async () => {
  const btn = $('btn-open')
  btn.disabled = true
  btn.textContent = t('common.opening')
  await openApp()
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const res = await checkStatus()
    if (res?.running) return
  }
  btn.disabled = false
  btn.textContent = t('common.open_qooti')
})

$('btn-open-footer').addEventListener('click', async () => { await openApp(); window.close() })

// After a "Don't allow" in qooti: ask once more
$('btn-connect').addEventListener('click', async () => {
  $('btn-connect').disabled = true
  await send({ action: 'pair-now' })
  $('btn-connect').disabled = false
  checkStatus()
})

$('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
  window.close()
})

// ─── The save button on this site ────────────────────────────────

function renderHere() {
  const hidden = !!currentHost && hiddenSites.some(s => hostMatches(currentHost, s))
  $('here').hidden = !currentHost
  $('here-host').textContent = currentHost ?? ''
  $('here-toggle').setAttribute('aria-checked', String(!hidden))
  $('hint').textContent = hidden ? t('popup.hidden_here') : t('popup.how')
}

$('here-toggle').addEventListener('click', async () => {
  if (!currentHost) return
  const hidden = hiddenSites.some(s => hostMatches(currentHost, s))
  hiddenSites = await setHiddenSites(hidden
    ? hiddenSites.filter(s => !hostMatches(currentHost, s))
    : [...hiddenSites, currentHost])
  renderHere()
})

// ─── Start ───────────────────────────────────────────────────────

;(async () => {
  await loadLang()
  $('link-get').href = siteUrl('/download')
  hiddenSites = await getHiddenSites()
  // The site in the current tab (activeTab)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
  try {
    const u = new URL(tab?.url ?? '')
    const host = normHost(u.hostname)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !NO_BUTTON.some(s => hostMatches(host, s))) currentHost = host
  } catch {}
  checkStatus()
})()
