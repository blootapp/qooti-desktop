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
