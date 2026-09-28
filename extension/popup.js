// qooti popup script

const statusDot  = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const versionEl  = document.getElementById('footer-version')
const cardReady  = document.getElementById('card-ready')
const cardClosed = document.getElementById('card-closed')
const openBtn    = document.getElementById('btn-open')

const EXT_VERSION = chrome.runtime.getManifest().version

// ─── Connection status ───────────────────────────────────────────

function renderStatus(res) {
  statusDot.className = 'status-dot'
  if (res?.connected) {
    statusDot.classList.add('status-dot--on')
    statusText.textContent = 'Connected'
  } else if (res?.running) {
    statusDot.classList.add('status-dot--wait')
    statusText.textContent = 'Connecting…'
  } else {
    statusDot.classList.add('status-dot--off')
    statusText.textContent = 'Not open'
  }
  cardReady.hidden  = !res?.connected
  cardClosed.hidden = !!res?.running
  versionEl.textContent = `Extension ${EXT_VERSION}` + (res?.version ? ` · qooti ${res.version}` : '')
}

function checkStatus() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'get-status' }, res => {
      void chrome.runtime.lastError
      renderStatus(res)
      resolve(res)
    })
  })
}

checkStatus()

// "Open qooti" launches the app via its qooti:// link, then waits for it to come up.
openBtn.addEventListener('click', async () => {
  openBtn.disabled = true
  openBtn.textContent = 'Opening…'
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
  chrome.runtime.sendMessage({ action: 'open-app', tab_id: tab?.id ?? null }, () => { void chrome.runtime.lastError })
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const res = await checkStatus()
    if (res?.running) return
  }
  openBtn.disabled = false
  openBtn.textContent = 'Open qooti'
})

// Reflect state on both the visual switch and the ARIA role="switch" row.
function renderToggle(row, sw, on) {
  sw.classList.toggle('toggle-switch--on', on)
  row.setAttribute('aria-checked', String(on))
}

// ─── Collection picker toggle ────────────────────────────────────

let pickerEnabled = true
const pickerRow      = document.getElementById('picker-toggle-row')
const pickerToggleEl = document.getElementById('picker-toggle')

chrome.storage.sync.get('showPicker', res => {
  pickerEnabled = res.showPicker !== false
  renderToggle(pickerRow, pickerToggleEl, pickerEnabled)
})

pickerRow.addEventListener('click', () => {
  pickerEnabled = !pickerEnabled
  chrome.storage.sync.set({ showPicker: pickerEnabled })
  renderToggle(pickerRow, pickerToggleEl, pickerEnabled)
})

// ─── Download panel toggle ───────────────────────────────────────

let panelEnabled = true
const panelRow      = document.getElementById('panel-toggle-row')
const panelToggleEl = document.getElementById('panel-toggle')

chrome.storage.sync.get('showDownloadPanel', res => {
  panelEnabled = res.showDownloadPanel !== false
  renderToggle(panelRow, panelToggleEl, panelEnabled)
})

panelRow.addEventListener('click', () => {
  panelEnabled = !panelEnabled
  chrome.storage.sync.set({ showDownloadPanel: panelEnabled })
  renderToggle(panelRow, panelToggleEl, panelEnabled)
  chrome.runtime.sendMessage({
    action: 'set-pref',
    key: 'show_download_toast',
    value: panelEnabled ? 'true' : 'false',
  }, () => { void chrome.runtime.lastError })
})

// ─── Hidden-on sites ─────────────────────────────────────────────
// The qooti button never appears on these sites. Entries are stored as bare
// hosts; content.js matches the current page (www/scheme-insensitive).

const DEFAULT_BANNED = ['flaticon.com', 'bloot.app']
const banInput   = document.getElementById('ban-input')
const banAddBtn  = document.getElementById('ban-add-btn')
const banList    = document.getElementById('ban-list')
const banCurrent = document.getElementById('btn-ban-current')
let bannedSites = []
let currentHost = null

// "https://www.flaticon.com/x" and "flaticon.com" → "flaticon.com"
function normHost(v) {
  return String(v || '')
    .trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^www\./, '')
}

// A plausible site name — stops "hello" or "a b" from being added by accident.
const looksLikeHost = h => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)

function isBanned(host) {
  return bannedSites.some(s => host === s || host.endsWith('.' + s))
}

function renderCurrent() {
  if (!currentHost) { banCurrent.hidden = true; return }
  banCurrent.hidden = false
  banCurrent.textContent = isBanned(currentHost)
    ? `Show the button on ${currentHost} again`
    : `Hide on ${currentHost}`
}

function renderBanList() {
  banList.innerHTML = ''
  if (!bannedSites.length) {
    const li = document.createElement('li')
    li.className = 'ban-empty'
    li.textContent = 'The button shows on every site.'
    banList.appendChild(li)
  }
  for (const host of bannedSites) {
    const li = document.createElement('li')
    li.className = 'ban-item'
    const span = document.createElement('span')
    span.className = 'ban-item-host'
    span.textContent = host
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ban-remove'
    btn.setAttribute('aria-label', `Show the button on ${host} again`)
    btn.title = 'Show the button here again'
    btn.textContent = '×'
    btn.addEventListener('click', () => removeBan(host))
    li.append(span, btn)
    banList.appendChild(li)
  }
  renderCurrent()
}

function saveBanned() { chrome.storage.sync.set({ bannedSites }) }

function addHost(host) {
  if (!host || bannedSites.includes(host)) return
  bannedSites.push(host)
  bannedSites.sort()
  saveBanned()
  renderBanList()
}

function addBan() {
  const host = normHost(banInput.value)
  if (!looksLikeHost(host)) {
    banInput.classList.add('ban-input--bad')
    banInput.focus()
    return
  }
  banInput.value = ''
  banInput.classList.remove('ban-input--bad')
  banInput.focus()
  addHost(host)
}

function removeBan(host) {
  bannedSites = bannedSites.filter(h => h !== host)
  saveBanned()
  renderBanList()
}

banCurrent.addEventListener('click', () => {
  if (!currentHost) return
  if (isBanned(currentHost)) bannedSites = bannedSites.filter(s => !(currentHost === s || currentHost.endsWith('.' + s)))
  else bannedSites.push(currentHost)
  bannedSites.sort()
  saveBanned()
  renderBanList()
})

chrome.storage.sync.get('bannedSites', res => {
  if (Array.isArray(res.bannedSites)) {
    bannedSites = res.bannedSites
  } else {
    bannedSites = DEFAULT_BANNED.slice()   // seed defaults on first open
    saveBanned()
  }
  renderBanList()
})

// The site in the current tab, for the one-click "Hide on …" button (activeTab).
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  try {
    const u = new URL(tab?.url ?? '')
    if (u.protocol === 'http:' || u.protocol === 'https:') currentHost = normHost(u.hostname)
  } catch {}
  renderCurrent()
}).catch(() => {})

banAddBtn.addEventListener('click', addBan)
banInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addBan() } })
banInput.addEventListener('input', () => banInput.classList.remove('ban-input--bad'))
