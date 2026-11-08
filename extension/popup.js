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
  // Links saved while qooti was closed wait for it
  const queued = res?.queued ?? 0
  $('closed-text').textContent = !queued ? t('popup.closed.text')
    : queued === 1 ? t('popup.closed.queue_one') : t('popup.closed.queue', { n: queued })

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
  renderBan()
  renderPlanCard($('plan'), res?.connected ? res.plan : null)
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

// ─── Collection picker (same switch as on the Settings page) ─────

{
  const row = $('toggle-picker')
  const render = on => row.setAttribute('aria-checked', String(on))
  chrome.storage.sync.get('showPicker').then(res => render(res.showPicker !== false))
  row.addEventListener('click', () => {
    const on = row.getAttribute('aria-checked') !== 'true'
    render(on)
    chrome.storage.sync.set({ showPicker: on })
  })
}

// ─── Ban / Unban the site in this tab ────────────────────────────
// Banned = the save button stays hidden there (Settings → Hidden on these sites).

function renderBan() {
  const banned = !!currentHost && hiddenSites.some(s => hostMatches(currentHost, s))
  const btn = $('btn-ban')
  btn.hidden = !currentHost
  if (currentHost) btn.textContent = t(banned ? 'popup.unban' : 'popup.ban', { site: siteName(currentHost) })
  $('hint').textContent = banned ? t('popup.hidden_here') : t('popup.how')
}

$('btn-ban').addEventListener('click', async () => {
  if (!currentHost) return
  const banned = hiddenSites.some(s => hostMatches(currentHost, s))
  hiddenSites = await setHiddenSites(banned
    ? hiddenSites.filter(s => !hostMatches(currentHost, s))
    : [...hiddenSites, currentHost])
  renderBan()
})

// The plan page on the account site, where Free becomes Pro
$('plan').querySelector('.plan-upgrade').addEventListener('click', () => {
  chrome.tabs.create({ url: PLAN_URL })
  window.close()
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
