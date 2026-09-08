// qooti popup script

const statusDot  = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const versionEl  = document.getElementById('footer-version')

// ─── Connection status ───────────────────────────────────────────

chrome.runtime.sendMessage({ action: 'get-status' }, res => {
  if (res?.connected) {
    statusDot.classList.add('status-dot--on')
    statusText.textContent = 'Connected'
    if (res.version) versionEl.textContent = `Desktop v${res.version}`
  } else {
    statusDot.classList.add('status-dot--off')
    statusText.textContent = 'qooti not running'
  }
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
  })
})

// ─── Blocked sites ───────────────────────────────────────────────
// The qooti badge never appears on these sites. Entries are stored as bare
// hosts; content.js matches the current page (www/scheme-insensitive).

const DEFAULT_BANNED = ['flaticon.com', 'bloot.app']
const banInput  = document.getElementById('ban-input')
const banAddBtn = document.getElementById('ban-add-btn')
const banList   = document.getElementById('ban-list')
let bannedSites = []

// "https://www.flaticon.com/x" and "flaticon.com" → "flaticon.com"
function normHost(v) {
  return String(v || '')
    .trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^www\./, '')
}

function renderBanList() {
  banList.innerHTML = ''
  if (!bannedSites.length) {
    const li = document.createElement('li')
    li.className = 'ban-empty'
    li.textContent = 'No blocked sites'
    banList.appendChild(li)
    return
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
    btn.setAttribute('aria-label', `Remove ${host}`)
    btn.textContent = '×'
    btn.addEventListener('click', () => removeBan(host))
    li.append(span, btn)
    banList.appendChild(li)
  }
}

function saveBanned() { chrome.storage.sync.set({ bannedSites }) }

function addBan() {
  const host = normHost(banInput.value)
  banInput.value = ''
  banInput.focus()
  if (!host || bannedSites.includes(host)) return
  bannedSites.push(host)
  bannedSites.sort()
  saveBanned()
  renderBanList()
}

function removeBan(host) {
  bannedSites = bannedSites.filter(h => h !== host)
  saveBanned()
  renderBanList()
}

chrome.storage.sync.get('bannedSites', res => {
  if (Array.isArray(res.bannedSites)) {
    bannedSites = res.bannedSites
  } else {
    bannedSites = DEFAULT_BANNED.slice()   // seed defaults on first open
    saveBanned()
  }
  renderBanList()
})

banAddBtn.addEventListener('click', addBan)
banInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addBan() } })

// ─── Disconnect ──────────────────────────────────────────────────

document.getElementById('btn-disconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'disconnect' }, () => {
    statusDot.className = 'status-dot status-dot--off'
    statusText.textContent = 'Disconnected'
    document.getElementById('btn-disconnect').textContent = 'Reconnect'
    document.getElementById('btn-disconnect').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'get-status' }, () => window.close())
    }, { once: true })
  })
})
