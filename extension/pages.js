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
// Stored as bare hosts, oldest first (settings shows the newest first); the page
// script matches subdomains too.

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
  const sites = [...new Set(list)]
  await chrome.storage.sync.set({ bannedSites: sites })
  return sites
}

// "Ban YouTube": the site's own name — known names keep their spelling, others are the
// main word of the address (hostinger.com → Hostinger, web.telegram.org → Telegram).
const SITE_NAMES = {
  'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'linkedin.com': 'LinkedIn', 'tiktok.com': 'TikTok',
  'github.com': 'GitHub', 'x.com': 'X', 'twitter.com': 'X', 'chatgpt.com': 'ChatGPT', 'deviantart.com': 'DeviantArt',
  'artstation.com': 'ArtStation', 'soundcloud.com': 'SoundCloud', 'imdb.com': 'IMDb', 'ebay.com': 'eBay',
  'bbc.co.uk': 'BBC', 'bbc.com': 'BBC', 'cnn.com': 'CNN', 'nytimes.com': 'The New York Times',
}
function siteName(host) {
  for (const [h, name] of Object.entries(SITE_NAMES)) if (host === h || host.endsWith('.' + h)) return name
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host   // an address, not a name
  const parts = host.split('.')
  let i = parts.length - 2
  // country endings in two parts: example.co.uk, example.com.au
  if (i > 0 && parts[i].length <= 3 && parts[parts.length - 1].length === 2) i--
  const word = parts[Math.max(0, i)] || host
  return word.charAt(0).toUpperCase() + word.slice(1)
}

// ─── Free plan card (popup and Settings) ─────────────────────────
// Today's downloads from the browser against the Free limit, and the way to Pro.
// `plan` is what get-status says: { plan: 'free', used, limit } | { plan: 'pro' } | null.

const PLAN_URL = 'https://account.bloot.app/plan/'

function renderPlanCard(card, plan) {
  if (!card) return
  const free = plan?.plan === 'free' && plan.limit > 0
  card.hidden = !free
  if (!free) return
  const used = Math.max(0, Math.min(plan.used, plan.limit))
  const full = used >= plan.limit
  card.querySelector('.plan-fill').style.width = `${Math.round(used / plan.limit * 100)}%`
  card.querySelector('.plan-used').textContent = t('plan.used', { used, limit: plan.limit })
  card.querySelector('.plan-left').textContent = t('plan.left', { n: plan.limit - used })
  card.querySelector('.plan-pill').hidden = !full
  card.querySelector('.plan-note').hidden = !full
}
