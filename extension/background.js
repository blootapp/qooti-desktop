// qooti Chrome Extension — background service worker
// Handles: pairing with the desktop, collection caching, save requests.
importScripts('i18n.js')

const DESKTOP = 'http://127.0.0.1:1420'
const STORAGE_KEY  = 'qooti_key'
const COLLECTIONS_KEY  = 'qooti_collections'
const COLLECTIONS_TTL  = 5 * 60 * 1000  // 5 minutes

// What we keep is for the extension's own pages only, never for its script inside web
// pages (a hostile page that broke into that script finds nothing to read). The
// connection key and the collection names live in session storage, which pages can't
// reach and which ends with the browser — qooti hands a browser it knows its key again
// at once. Where the button was dragged on each site stays in local storage, closed
// to pages too.
const secrets = chrome.storage.session
try { chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {}) } catch {}
// Up to 1.2 the key and the collection names were in local storage
chrome.storage.local.remove([STORAGE_KEY, COLLECTIONS_KEY, COLLECTIONS_KEY + '_ts'])

// Why a save didn't happen, as a code the page script words in the user's language
// (i18n.js 'err.*').
class UserError extends Error {
  constructor(code, kind = 'failed') { super(code); this.code = code; this.kind = kind }
}

// ─── Language ────────────────────────────────────────────────────

const i18n = globalThis.qootiI18n
async function applyLang() {
  const { lang, appLang } = await chrome.storage.sync.get(['lang', 'appLang'])
  i18n.use(i18n.pick(lang, appLang))
  chrome.contextMenus.update('qooti-save', { title: i18n.t('menu.save') }, () => { void chrome.runtime.lastError })
}
applyLang()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.lang || changes.appLang)) applyLang()
})

// ─── Connection ──────────────────────────────────────────────────

async function getKey() {
  const res = await secrets.get(STORAGE_KEY)
  return res[STORAGE_KEY] ?? null
}

async function setKey(key) {
  await secrets.set({ [STORAGE_KEY]: key })
}

// Ping the desktop. Returns { version, platform, lang } or null if it isn't running.
async function ping(timeout = 1500) {
  try {
    const r = await fetch(`${DESKTOP}/extension/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeout),
    })
    if (!r.ok) return null
    const info = await r.json()
    // The extension speaks the app's language unless the user picked one here.
    if (info?.lang === 'en' || info?.lang === 'uz') {
      const { appLang } = await chrome.storage.sync.get('appLang')
      if (appLang !== info.lang) chrome.storage.sync.set({ appLang: info.lang })
    }
    return info
  } catch {
    return null
  }
}

// Ultra-fast reachability check — used before save to detect "not running" quickly.
// ECONNREFUSED from the OS is near-instant; the 400 ms cap handles slow networks/firewalls.
async function quickPing() {
  return !!(await ping(400))
}

// Pairing. qooti 1.2+ asks the user first ("Connect your browser?"): it answers 202
// while asking, 200 with this browser's own key once allowed, 403 after a no. Older
// versions hand out the key straight away. Asking again is cheap — qooti only shows
// the question once — so a pending pairing is simply retried by the calls below (the
// visible tab checks in every few seconds).
let pairState = null      // null | 'pending' | 'denied'
let deniedAt  = 0
const DENIED_PAUSE = 10 * 60 * 1000   // after a no, qooti doesn't ask again for 10 minutes

async function pair({ askAgain = false } = {}) {
  if (pairState === 'denied' && !askAgain && Date.now() - deniedAt < DENIED_PAUSE) return null
  try {
    const r = await fetch(`${DESKTOP}/extension/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ask_again: askAgain }),
      signal: AbortSignal.timeout(1500),
    })
    if (r.status === 202) { pairState = 'pending'; return null }
    if (r.status === 403) { pairState = 'denied'; deniedAt = Date.now(); return null }
    if (!r.ok) return null
    const data = await r.json()
    if (data.key) {
      pairState = null
      await setKey(data.key)
      return data.key
    }
    return null
  } catch {
    return null
  }
}

// Why there's no key yet, as a user-facing error.
function notPairedError(running) {
  if (pairState === 'pending') return new UserError('allowIt', 'pairing')
  if (pairState === 'denied')  return new UserError('notAllowed', 'pairing-denied')
  return new UserError(running ? 'noConnect' : 'notRunning', running ? 'failed' : 'offline')
}

// Ensure the extension is paired. Called lazily before any authenticated request.
async function ensurePaired() {
  let key = await getKey()
  if (key) return key
  key = await pair()
  return key
}

// Force a fresh pairing. Used when the desktop rejects our stored key (401) —
// e.g. after the app was reinstalled/reset and generated a new pairing key, so
// our cached key is stale. Clears it and pairs again so the user never has to
// manually reconnect.
async function repair() {
  await secrets.remove(STORAGE_KEY)
  return pair()
}

// ─── Collections ─────────────────────────────────────────────────

// Returns [{ id, name }] cached up to 5 minutes.
async function getCollections() {
  const stored = await secrets.get([COLLECTIONS_KEY, COLLECTIONS_KEY + '_ts'])
  const ts   = stored[COLLECTIONS_KEY + '_ts'] ?? 0
  const data = stored[COLLECTIONS_KEY]
  if (data && Date.now() - ts < COLLECTIONS_TTL) return data

  const key = await ensurePaired()
  if (!key) return data ?? []
  try {
    const r = await fetch(`${DESKTOP}/extension/collections`, {
      headers: { 'X-Qooti-Key': key },
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return data ?? []
    const cols = await r.json()
    await secrets.set({
      [COLLECTIONS_KEY]: cols,
      [COLLECTIONS_KEY + '_ts']: Date.now(),
    })
    return cols
  } catch {
    return data ?? []
  }
}

function invalidateCollectionsCache() {
  secrets.remove([COLLECTIONS_KEY, COLLECTIONS_KEY + '_ts'])
}

// ─── Save ────────────────────────────────────────────────────────

async function saveItem(payload) {
  const key = await ensurePaired()
  if (!key) throw notPairedError(await quickPing())
  const post = k => fetch(`${DESKTOP}/extension/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Qooti-Key': k },
    body: JSON.stringify(payload),
    // Generous: the desktop answers in milliseconds, but a big frame capture or a
    // busy library can take a few seconds — a short cap turned those into failures.
    signal: AbortSignal.timeout(10000),
  })
  let r
  try {
    r = await post(key)
    // Stale key (desktop was reinstalled/reset) → re-pair once and retry, so saving
    // keeps working without the user having to manually reconnect.
    if (r.status === 401) {
      const fresh = await repair()
      if (!fresh) throw notPairedError(true)
      r = await post(fresh)
    }
  } catch (e) {
    if (e instanceof UserError) throw e   // e.g. qooti is asking whether to connect
    if (e?.name === 'TimeoutError') throw new UserError('busy')
    const running = await quickPing()
    throw new UserError(running ? 'failed' : 'notRunning', running ? 'failed' : 'offline')
  }
  if (r.status === 401 || r.status === 403) throw new UserError('noConnect')
  if (r.status === 400) {
    const why = await r.json().catch(() => ({}))
    if (why.error === 'private_address') throw new UserError('privateNet')
  }
  if (!r.ok) {
    console.warn('[qooti] save rejected', r.status)
    throw new UserError('failed')
  }
  return await r.json()
}

// ─── Saved while qooti is closed ─────────────────────────────────
// With qooti closed a save isn't lost: the link waits here (local storage, which pages
// can't read) and goes over to qooti once it runs again, where qooti asks what to
// download from each ("Links from your browser"). A link leaves this list only once
// qooti has it.

const QUEUE_KEY   = 'qooti_queue'
const QUEUE_MAX   = 500
const QUEUE_ALARM = 'qooti-queue'

async function readQueue() {
  const { [QUEUE_KEY]: q } = await chrome.storage.local.get(QUEUE_KEY)
  return Array.isArray(q) ? q : []
}

// One change at a time: two quick saves must not write over each other's list.
let queueLock = Promise.resolve()
function changeQueue(fn) {
  const run = queueLock.then(async () => {
    const q = await readQueue()
    const next = fn(q)
    if (next) await chrome.storage.local.set({ [QUEUE_KEY]: next })
    return next ?? q
  })
  queueLock = run.catch(() => {})
  return run
}

// Keeps a (cleaned) save for later. → how many links wait now.
async function queueAdd(payload) {
  const item = {
    id:              crypto.randomUUID(),
    url:             payload.url,
    page_url:        payload.page_url ?? '',
    title:           payload.title ?? '',
    type:            payload.type === 'video' ? 'video' : 'image',
    source_platform: payload.source_platform ?? null,
    thumbnail_url:   payload.thumbnail_url ?? null,
    saved_at:        Date.now(),
  }
  if (payload.data_url) item.data_url = payload.data_url
  // What the user picked here; qooti's list starts on it
  item.choice = item.data_url ? 'frame' : item.type === 'video' ? 'video' : 'image'
  const q = await changeQueue(q => {
    // The same link twice is one entry (frames are always new)
    if (!item.data_url && q.some(x => !x.data_url && x.url === item.url)) return null
    if (q.length >= QUEUE_MAX) throw new UserError('queueFull', 'offline')
    return [...q, item]
  })
  chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 1 })
  return q.length
}

// Hands the waiting links to qooti when it runs and this browser is connected. Safe to
// call often: one run at a time, and a quick no-op when nothing waits.
let flushing = null
function flushQueue() {
  if (!flushing) flushing = handOverAll().catch(() => 0).finally(() => { flushing = null })
  return flushing
}

async function handOverAll() {
  const q = await readQueue()
  if (!q.length) { chrome.alarms.clear(QUEUE_ALARM); return 0 }
  if (!(await quickPing())) return q.length
  let key = await ensurePaired()
  if (!key) return q.length
  for (const item of q) {
    let res = await handOver(item, key)
    if (res === 'stale') {
      key = await repair()
      if (!key) break
      res = await handOver(item, key)
    }
    if (res !== 'ok') break
    await changeQueue(cur => cur.filter(x => x.id !== item.id))
  }
  const left = (await readQueue()).length
  if (!left) chrome.alarms.clear(QUEUE_ALARM)
  return left
}

// → 'ok' (qooti has it, or will never take it), 'stale' (our key is old) or 'later'
async function handOver(item, key) {
  try {
    const r = await fetch(`${DESKTOP}/extension/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Qooti-Key': key },
      body: JSON.stringify(item),
      signal: AbortSignal.timeout(15000),
    })
    if (r.ok) return 'ok'
    if (r.status === 401) return 'stale'
    if (r.status === 404) {
      // A qooti from before the list: save it the usual way instead
      const { id, choice, saved_at, ...rest } = item
      const clean = cleanPayload(rest)
      if (clean) await saveItem(clean)
      return 'ok'
    }
    if (r.status === 400) {
      // qooti can't take this one (it never will) — unless its list is full for now
      const why = await r.text().catch(() => '')
      return why.includes('queue_full') ? 'later' : 'ok'
    }
    return 'later'
  } catch {
    return 'later'
  }
}

chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === QUEUE_ALARM) flushQueue() })
chrome.runtime.onStartup.addListener(() => { flushQueue() })

// Free or Pro, and today's saves on Free — for the Free plan card. Null when qooti
// can't say (an older qooti, or not connected).
async function getPlan(key) {
  try {
    const r = await fetch(`${DESKTOP}/extension/plan`, {
      headers: { 'X-Qooti-Key': key },
      signal: AbortSignal.timeout(1500),
    })
    if (!r.ok) return null
    const p = await r.json()
    if (p?.plan === 'pro') return { plan: 'pro' }
    if (p?.plan === 'free' && Number.isFinite(p.used) && Number.isFinite(p.limit)) return { plan: 'free', used: p.used, limit: p.limit }
    return null
  } catch {
    return null
  }
}

// Returns 'ok', or 'locked' when the collection takes no new items on the Free plan.
async function addToCollection(inspirationId, collectionId) {
  const key = await ensurePaired()
  if (!key) throw new UserError('notRunning', 'offline')
  const r = await fetch(`${DESKTOP}/extension/add-to-collection`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Qooti-Key': key,
    },
    body: JSON.stringify({ inspiration_id: inspirationId, collection_id: collectionId }),
    signal: AbortSignal.timeout(5000),
  })
  if (r.status === 403) return 'locked'
  if (!r.ok) throw new UserError('failed')
  return 'ok'
}

// Save + collections in parallel (they don't depend on each other), shaped for the
// content script.
async function saveAndDescribe(payload) {
  const { payload: withSignin, signin, site } = await withCookies(payload)
  const [result, cols] = await Promise.all([saveItem(withSignin), getCollections()])
  return {
    ok:             true,
    already_exists: result.already_exists  ?? false,
    queued:         result.queued          ?? false,
    collections:    cols,
    inspiration_id: result.inspiration_id  ?? null,
    ext_id:         result.ext_id          ?? null,
    is_frame:       result.is_frame        ?? false,
    signin,         // 'off' → this site's videos may need the sign-in the user hasn't shared
    signin_site:    site ? SIGNIN_SITES[site].name : null,
  }
}

// ─── What a page may ask for ─────────────────────────────────────
// The script inside web pages describes what to save; only these fields, in these
// shapes, ever reach qooti (never a file on this computer or anyone's cookies).

const MAX_FRAME = 24 * 1024 * 1024   // a captured video frame, as a data URL

function cleanPayload(p) {
  if (!p || typeof p !== 'object') return null
  const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : undefined
  const web = v => {
    if (typeof v !== 'string' || v.length > 8192) return undefined
    try {
      const u = new URL(v)
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined
    } catch { return undefined }
  }
  const size = v => Number.isFinite(v) && v > 0 && v < 100000 ? Math.round(v) : null
  const out = {
    url:             web(p.url),
    page_url:        web(p.page_url),
    title:           text(p.title, 500) ?? '',
    type:            ['image', 'video', 'page'].includes(p.type) ? p.type : 'image',
    source_platform: /^[a-z]{1,20}$/.test(p.source_platform ?? '') ? p.source_platform : null,
    thumbnail_url:   web(p.thumbnail_url),
    width:           size(p.width),
    height:          size(p.height),
  }
  if (p.data_url !== undefined) {
    const ok = typeof p.data_url === 'string' && p.data_url.length <= MAX_FRAME
      && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.data_url)
    if (!ok) return null
    out.data_url = p.data_url
  }
  return out.url ? out : null
}

// Ids qooti handed out (downloads, items, collections) — letters, digits, dashes.
const isId = v => typeof v === 'string' && /^[\w-]{1,64}$/.test(v)

// A page that saves non-stop is up to something.
const recentSaves = new Map()   // tab id → times
function tooManySaves(tabId) {
  const now = Date.now()
  const times = (recentSaves.get(tabId) ?? []).filter(t => now - t < 60000)
  times.push(now)
  recentSaves.set(tabId, times)
  return times.length > 30
}

// ─── Sign-in for videos (Instagram, TikTok) ──────────────────────
// Some of their videos only download for a signed-in person. Only when the user has
// allowed it in Settings (an optional permission), and only the sign-in cookies the
// downloader needs, go to qooti with that one save. qooti writes them to a temporary
// file for the download and deletes it after.

const SIGNIN_SITES = {
  instagram: {
    name: 'Instagram',
    hosts: ['instagram.com', 'instagr.am'],
    origin: 'https://*.instagram.com/*',
    domain: 'instagram.com',
    cookies: ['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur', 'datr'],
  },
  tiktok: {
    name: 'TikTok',
    hosts: ['tiktok.com'],
    origin: 'https://*.tiktok.com/*',
    domain: 'tiktok.com',
    cookies: ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss', 'ttwid',
      'tt_chain_token', 'msToken', 's_v_web_id', 'tt_csrf_token', 'odin_tt', 'store-idc', 'tt-target-idc'],
  },
}

function signinSite(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return Object.keys(SIGNIN_SITES).find(id => SIGNIN_SITES[id].hosts.some(h => host === h || host.endsWith('.' + h))) ?? null
  } catch { return null }
}

const signinAllowed = id => chrome.permissions.contains({ permissions: ['cookies'], origins: [SIGNIN_SITES[id].origin] }).catch(() => false)

// → { payload, site, signin: null (not such a site) | 'on' | 'off' (not allowed) }
async function withCookies(payload) {
  const site = signinSite(payload?.url || '')
  if (!site) return { payload, site, signin: null }
  if (!(await signinAllowed(site))) return { payload, site, signin: 'off' }
  const cookies = await signinCookies(SIGNIN_SITES[site])
  return { payload: cookies ? { ...payload, _cookies: cookies } : payload, site, signin: 'on' }
}

// The site's sign-in cookies as a Netscape cookie file, or null.
async function signinCookies(site) {
  const all = await chrome.cookies.getAll({ domain: site.domain }).catch(() => [])
  const wanted = all.filter(c => site.cookies.includes(c.name))
  if (!wanted.length) return null
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of wanted) {
    const d   = c.domain.startsWith('.') ? c.domain : '.' + c.domain
    const sub = c.hostOnly ? 'FALSE' : 'TRUE'
    const sec = c.secure   ? 'TRUE'  : 'FALSE'
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0
    lines.push(`${d}\t${sub}\t${c.path}\t${sec}\t${exp}\t${c.name}\t${c.value}`)
  }
  return lines.join('\n')
}

// ─── The on-page look ────────────────────────────────────────────
// Nothing of ours is web-accessible — a page could otherwise tell qooti is installed
// by asking for one of its files. The page script gets its styles, icons and fonts
// from here instead.

const UI_ICONS = ['mark', 'toast-mark', 'spinner', 'warning', 'check-circle', 'close', 'chevron-up', 'folder', 'lock', 'opt-video', 'opt-image', 'opt-frame']
const TINTED   = new Set(['close', 'chevron-up', 'folder', 'lock', 'opt-video', 'opt-image', 'opt-frame'])
const FONTS    = { sans: 'fonts/Geist-Variable.woff2', mono: 'fonts/GeistMono-Variable.woff2' }

let uiKit = null
async function getUiKit() {
  if (uiKit) return uiKit
  const text = path => fetch(chrome.runtime.getURL(path)).then(r => r.text())
  const [css, ...svgs] = await Promise.all([text('ui.css'), ...UI_ICONS.map(n => text(`icons/ui/${n}.svg`))])
  uiKit = { css, icons: Object.fromEntries(UI_ICONS.map((n, i) => [n, inlineSvg(svgs[i], TINTED.has(n))])) }
  return uiKit
}

// An icon file made fit to sit inside our UI: no ids, clip paths or style attributes
// (a strict page blocks style="" and reports it); tinted ones take the text colour.
function inlineSvg(svg, tinted) {
  let s = svg.replace(/<\?xml[^>]*>/, '').replace(/<defs>[\s\S]*?<\/defs>/g, '')
    .replace(/\s(id|style|clip-path|preserveAspectRatio|overflow|xmlns:xlink)="[^"]*"/g, '')
  if (tinted) s = s.replace(/\sfill="(?!none)[^"]*"/g, ' fill="currentColor"')
  return s.replace('<svg', '<svg aria-hidden="true" focusable="false"').replace(/\s+/g, ' ').trim()
}

async function fontData(kind) {
  const path = FONTS[kind]
  if (!path) return null
  const bytes = new Uint8Array(await fetch(chrome.runtime.getURL(path)).then(r => r.arrayBuffer()))
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// ─── Context menu ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: onInstalled also fires on updates, and re-creating an existing
  // id throws.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'qooti-save',
      title: i18n.t('menu.save'),
      contexts: ['image', 'video', 'page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    })
    applyLang()
  })
  // Auto-pair on install (fire and forget); an update keeps waiting links — hand them over
  ensurePaired().then(() => flushQueue())
})

// Right-click → Save to qooti. The page's own script shows the same progress and
// messages as the on-page button; on pages it can't run on (browser pages, the
// Web Store), the toolbar icon shows ✓ or ! instead.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'qooti-save') return
  const pageUrl = tab?.url ?? info.pageUrl ?? ''
  let payload
  if (info.mediaType === 'image' && info.srcUrl && !/^(data|blob):/.test(info.srcUrl)) {
    payload = { url: info.srcUrl, page_url: pageUrl, title: tab?.title ?? '', type: 'image' }
  } else {
    // A video element, or the page itself: video pages download the video; any other
    // page saves its preview image (the content script finds it — type 'page').
    const src = info.mediaType === 'video' && info.srcUrl && !info.srcUrl.startsWith('blob:') ? info.srcUrl : null
    const url = src ?? pageUrl
    payload = { url, page_url: pageUrl, title: tab?.title ?? '', type: (src || isVideoPage(url)) ? 'video' : 'page' }
  }
  payload.source_platform = detectPlatform(payload.url) ?? detectPlatform(pageUrl)

  if (tab?.id != null) {
    try {
      const handled = await chrome.tabs.sendMessage(tab.id, { action: 'context-save', payload }, { frameId: 0 })
      if (handled?.ok) return
    } catch { /* no content script on this page */ }
  }
  const clean = payload.type === 'page' ? null : cleanPayload(payload)
  if (!clean) { flashIcon(tab?.id, false); return }   // a page needs the page's script
  try {
    await saveAndDescribe(clean)
    flashIcon(tab?.id, true)
  } catch (e) {
    // qooti is closed: the link waits for it
    if (e?.kind === 'offline') {
      try { await queueAdd(clean); flashIcon(tab?.id, true); return } catch {}
    }
    flashIcon(tab?.id, false)
    console.warn('[qooti] context menu save failed:', e?.code)
  }
})

function flashIcon(tabId, ok) {
  if (tabId == null) return
  chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#16A34A' : '#DC2626' })
  chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' })
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 4000)
}

// ─── Messages ────────────────────────────────────────────────────
// Two kinds of callers: our own pages (popup, settings) and our script inside web pages.
// The second runs next to sites we don't control, so it gets only what saving needs —
// it can't connect, change settings or read anything stored — and what it sends is
// checked like anything else from the web.

const OWN_PAGES = chrome.runtime.getURL('')
const fromOwnPage = sender => sender?.id === chrome.runtime.id && (sender.url ?? '').startsWith(OWN_PAGES)
const fromWebPage = sender => sender?.id === chrome.runtime.id && !!sender.tab && /^https?:\/\//.test(sender.url ?? '')

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
const positionKey = sender => `qooti_bp_${hostOf(sender.url)}`

// Everything the page script may ask
const PAGE_ACTIONS = {
  // No-op: sent on hover so the worker is awake by the time the user clicks.
  'wake': async () => ({ ok: true }),

  'ui-kit':  async () => getUiKit(),
  'ui-font': async msg => ({ data: await fontData(msg.font) }),

  // Fast reachability check before every save.
  'check-running': async () => ({ running: await quickPing() }),

  'save': async (msg, sender) => {
    const payload = cleanPayload(msg.payload)
    if (!payload) return { ok: false, error: 'failed', kind: 'failed' }
    if (tooManySaves(sender.tab.id)) return { ok: false, error: 'busy', kind: 'failed' }
    try {
      return await saveAndDescribe(payload)
    } catch (e) {
      return { ok: false, error: e instanceof UserError ? e.code : 'failed', kind: e?.kind ?? 'failed' }
    }
  },

  // qooti is closed: keep the link until it opens (qooti then asks what to download).
  'queue-save': async (msg, sender) => {
    const payload = cleanPayload(msg.payload)
    if (!payload) return { ok: false, error: 'failed', kind: 'failed' }
    if (tooManySaves(sender.tab.id)) return { ok: false, error: 'busy', kind: 'failed' }
    try {
      return { ok: true, queued: await queueAdd(payload) }
    } catch (e) {
      return { ok: false, error: e instanceof UserError ? e.code : 'failed', kind: 'offline' }
    }
  },

  'get-progress': async msg => {
    if (!isId(msg.ext_id)) return null
    const key = await ensurePaired()
    if (!key) return null
    const r = await fetch(`${DESKTOP}/extension/download-progress/${msg.ext_id}`, {
      headers: { 'X-Qooti-Key': key },
      signal: AbortSignal.timeout(2500),
    })
    return r.ok ? await r.json() : null
  },

  'cancel-download': async msg => {
    if (!isId(msg.ext_id)) return { ok: false }
    const key = await ensurePaired()
    if (key) {
      await fetch(`${DESKTOP}/extension/cancel/${msg.ext_id}`, {
        method: 'POST',
        headers: { 'X-Qooti-Key': key },
        signal: AbortSignal.timeout(2000),
      }).catch(() => {})
    }
    return { ok: true }
  },

  'open-item': async msg => {
    if (!isId(msg.inspiration_id)) return { ok: false }
    const key = await ensurePaired()
    if (key) {
      await fetch(`${DESKTOP}/extension/open-item`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Qooti-Key': key },
        body: JSON.stringify({ inspiration_id: msg.inspiration_id }),
        signal: AbortSignal.timeout(3000),
      })
    }
    return { ok: true }
  },

  // Launch (or bring forward) the desktop app through its qooti:// link. Chrome asks
  // once whether to allow opening qooti; the current page stays where it is.
  'open-app': async (msg, sender) => {
    const tabId = sender.tab?.id ?? (fromOwnPage(sender) && Number.isInteger(msg.tab_id) ? msg.tab_id : null)
    if (tabId != null) await chrome.tabs.update(tabId, { url: 'qooti://open' })
    else await chrome.tabs.create({ url: 'qooti://open' })
    return { ok: true }
  },

  'add-to-collection': async msg => {
    if (!isId(msg.inspiration_id) || !isId(msg.collection_id)) return { ok: false }
    try {
      const result = await addToCollection(msg.inspiration_id, msg.collection_id)
      invalidateCollectionsCache()
      return { ok: result === 'ok', locked: result === 'locked' }
    } catch {
      return { ok: false }
    }
  },

  // Called by the visible tab's content script every few seconds: the app queues a
  // URL here when it needs this browser's sign-in to download it (e.g. Instagram).
  'check-pending': async () => {
    // Don't try to pair while the desktop isn't running.
    const key = (await getKey()) ?? ((await quickPing()) ? await pair() : null)
    if (!key) return null
    // qooti is up and knows this browser: hand over links saved while it was closed
    flushQueue()
    try {
      const r = await fetch(`${DESKTOP}/extension/pending-download`, {
        headers: { 'X-Qooti-Key': key },
        signal: AbortSignal.timeout(1500),
      })
      if (!r.ok) return null
      const data = await r.json()
      const payload = cleanPayload({ url: data.url, page_url: data.url, type: 'video', source_platform: detectPlatform(data.url ?? '') })
      if (!payload) return { pending: false }
      const { payload: withSignin, signin, site } = await withCookies(payload)
      await saveItem(withSignin)
      // Not allowed to use this site's sign-in: the page says where to allow it.
      return { pending: true, ok: true, signin, site: site ? SIGNIN_SITES[site].name : null }
    } catch (e) {
      console.warn('[qooti] check-pending failed:', e?.code)
      return { pending: false }
    }
  },

  // Where the user dragged the button on this site (only ever the asking page's own site).
  'get-position': async (msg, sender) => {
    const key = positionKey(sender)
    return { pos: (await chrome.storage.local.get(key))[key] ?? null }
  },
  'set-position': async (msg, sender) => {
    const { ratioX, ratioY } = msg.pos ?? {}
    if (![ratioX, ratioY].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return { ok: false }
    await chrome.storage.local.set({ [positionKey(sender)]: { ratioX, ratioY } })
    return { ok: true }
  },

  // "Settings" in a message on the page: the extension's settings, at that part.
  'open-settings': async msg => {
    const part = msg.part === 'signin' ? '#signin' : ''
    await chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') + part })
    return { ok: true }
  },
}

// …and what only our own pages may ask
const OWN_PAGE_ACTIONS = {
  'check-running': PAGE_ACTIONS['check-running'],
  'open-app':      PAGE_ACTIONS['open-app'],

  'get-status': async () => {
    const info = await ping()
    const key  = info ? await ensurePaired() : await getKey()
    const connected = !!info && !!key
    if (connected) flushQueue()   // links saved while qooti was closed go over now
    const [queued, plan] = await Promise.all([
      readQueue().then(q => q.length),
      connected ? getPlan(key) : null,
    ])
    return {
      running:   !!info,
      connected,
      version:   info?.version ?? null,
      pairing:   info && !key ? pairState : null,   // 'pending' | 'denied' | null
      queued,    // links waiting for qooti
      plan,      // { plan: 'free', used, limit } | { plan: 'pro' } | null
    }
  },

  // "Connect again", after the user said no in qooti.
  'pair-now': async () => {
    const key = await pair({ askAgain: true })
    return { ok: !!key, pairing: key ? null : pairState }
  },

  // Mirror a setting into the app (only the ones qooti knows about).
  'set-pref': async msg => {
    if (msg.key !== 'show_download_toast' || !['true', 'false'].includes(msg.value)) return { ok: false }
    const key = await getKey()
    if (!key) return { ok: false }
    await fetch(`${DESKTOP}/extension/set-pref`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Qooti-Key': key },
      body: JSON.stringify({ key: msg.key, value: msg.value }),
      signal: AbortSignal.timeout(2000),
    })
    return { ok: true }
  },
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const action = typeof msg?.action === 'string' ? msg.action : ''
  const table = fromOwnPage(sender) ? OWN_PAGE_ACTIONS : fromWebPage(sender) ? PAGE_ACTIONS : null
  const handler = table && Object.hasOwn(table, action) ? table[action] : null
  if (!handler) { sendResponse(null); return }
  handler(msg, sender).then(sendResponse, () => sendResponse(null))
  return true
})

// ─── Helpers ─────────────────────────────────────────────────────

function detectPlatform(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '')
    if (h.includes('youtube.com') || h.includes('youtu.be')) return 'youtube'
    if (h.includes('instagram.com'))  return 'instagram'
    if (h.includes('pinterest.com') || h.includes('pinterest.co')) return 'pinterest'
    if (h.includes('tiktok.com'))     return 'tiktok'
    if (h.includes('behance.net'))    return 'behance'
    if (h.includes('dribbble.com'))   return 'dribbble'
    if (h.includes('twitter.com') || h.includes('x.com')) return 'x'
    if (h.includes('reddit.com'))     return 'reddit'
    if (h.includes('vimeo.com'))      return 'vimeo'
  } catch {}
  return null
}

// Pages whose URL is itself a video the desktop can download.
function isVideoPage(url) {
  try {
    const u = new URL(url)
    const h = u.hostname.replace(/^www\.|^m\./, '')
    if (h === 'youtu.be') return true
    if (h.endsWith('youtube.com')) return u.pathname === '/watch' || /^\/(shorts|live)\//.test(u.pathname)
    if (h.endsWith('instagram.com')) return /^\/(p|reel|reels|tv)\//.test(u.pathname)
    if (h.endsWith('tiktok.com')) return u.pathname.includes('/video/')
    if (h.endsWith('vimeo.com')) return /^\/\d+/.test(u.pathname)
    if (h === 'x.com' || h.endsWith('twitter.com')) return u.pathname.includes('/status/')
  } catch {}
  return false
}
