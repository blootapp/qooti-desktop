// Shared by the popup and the settings page: the language, the hidden-sites list and
// talking to the background.

const i18n = globalThis.qootiI18n
const t = (key, vars) => i18n.t(key, vars)

// Picks the language (Settings → Language, else qooti's, else the browser's) and puts
// the words into every data-i18n element.
async function loadLang() {
  const { lang, appLang } = await chrome.storage.sync.get(['lang', 'appLang'])
  i18n.use(i18n.pick(lang, appLang))
  document.documentElement.lang = i18n.lang
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh)
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria))
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle)
    el.setAttribute('aria-label', t(el.dataset.i18nTitle))
  }
}

// A page on bloot.app, in the extension's language.
const siteUrl = path => `https://bloot.app${i18n.lang === 'uz' ? '/uz' : ''}${path}`

// Ask the background; null when it couldn't answer.
function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => { void chrome.runtime.lastError; resolve(res ?? null) })
  })
}

// ─── Sites where the save button stays hidden ────────────────────
// Stored as bare hosts; the page script matches subdomains too.

const DEFAULT_HIDDEN = ['flaticon.com']

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
const hostMatches = (host, entry) => host === entry || host.endsWith('.' + entry)

async function getHiddenSites() {
  const { bannedSites } = await chrome.storage.sync.get('bannedSites')
  if (Array.isArray(bannedSites)) return bannedSites
  await chrome.storage.sync.set({ bannedSites: DEFAULT_HIDDEN })   // first time: the defaults
  return DEFAULT_HIDDEN.slice()
}

async function setHiddenSites(list) {
  const sites = [...new Set(list)].sort()
  await chrome.storage.sync.set({ bannedSites: sites })
  return sites
}
