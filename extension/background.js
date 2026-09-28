// qooti Chrome Extension — background service worker
// Handles: pairing with the desktop, collection caching, save requests.

const DESKTOP = 'http://127.0.0.1:1420'
const STORAGE_KEY  = 'qooti_key'
const COLLECTIONS_KEY  = 'qooti_collections'
const COLLECTIONS_TTL  = 5 * 60 * 1000  // 5 minutes

// What users see when something goes wrong — never raw error text.
const MSG = {
  notRunning: 'qooti isn\'t open. Open qooti, then try again.',
  busy:       'qooti is busy right now. Please try again in a moment.',
  noConnect:  'Couldn\'t connect to qooti. Open qooti and try again.',
  failed:     'Couldn\'t save this. Please try again.',
}

// An error whose message is safe to show as-is.
class UserError extends Error {
  constructor(message, kind = 'failed') { super(message); this.kind = kind }
}

// ─── Connection ──────────────────────────────────────────────────

async function getKey() {
  const res = await chrome.storage.local.get(STORAGE_KEY)
  return res[STORAGE_KEY] ?? null
}

async function setKey(key) {
  await chrome.storage.local.set({ [STORAGE_KEY]: key })
}

// Ping the desktop. Returns { version, platform } or null if it isn't running.
async function ping(timeout = 1500) {
  try {
    const r = await fetch(`${DESKTOP}/extension/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeout),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// Ultra-fast reachability check — used before save to detect "not running" quickly.
// ECONNREFUSED from the OS is near-instant; the 400 ms cap handles slow networks/firewalls.
async function quickPing() {
  return !!(await ping(400))
}

// Auto-pair on first install. Desktop generates and returns the key.
// Subsequent calls with no existing key also re-pair (e.g. after reinstall).
async function pair() {
  try {
    const r = await fetch(`${DESKTOP}/extension/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(1500),
    })
    if (!r.ok) return null
    const data = await r.json()
    if (data.key) {
      await setKey(data.key)
      return data.key
    }
    return null
  } catch {
    return null
  }
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
  await chrome.storage.local.remove(STORAGE_KEY)
  return pair()
}

// ─── Collections ─────────────────────────────────────────────────

// Returns [{ id, name }] cached up to 5 minutes.
async function getCollections() {
  const stored = await chrome.storage.local.get([COLLECTIONS_KEY, COLLECTIONS_KEY + '_ts'])
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
    await chrome.storage.local.set({
      [COLLECTIONS_KEY]: cols,
      [COLLECTIONS_KEY + '_ts']: Date.now(),
    })
    return cols
  } catch {
    return data ?? []
  }
}

function invalidateCollectionsCache() {
  chrome.storage.local.remove([COLLECTIONS_KEY, COLLECTIONS_KEY + '_ts'])
}

// ─── Save ────────────────────────────────────────────────────────

async function saveItem(payload) {
  const key = await ensurePaired()
  if (!key) {
    const running = await quickPing()
    throw new UserError(running ? MSG.noConnect : MSG.notRunning, running ? 'failed' : 'offline')
  }
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
      if (fresh) r = await post(fresh)
    }
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new UserError(MSG.busy)
    const running = await quickPing()
    throw new UserError(running ? MSG.failed : MSG.notRunning, running ? 'failed' : 'offline')
  }
  if (r.status === 401 || r.status === 403) throw new UserError(MSG.noConnect)
  if (!r.ok) {
    console.warn('[qooti] save rejected', r.status, await r.text().catch(() => ''))
    throw new UserError(MSG.failed)
  }
  return await r.json()
}

async function addToCollection(inspirationId, collectionId) {
  const key = await ensurePaired()
  if (!key) return
  await fetch(`${DESKTOP}/extension/add-to-collection`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Qooti-Key': key,
    },
    body: JSON.stringify({ inspiration_id: inspirationId, collection_id: collectionId }),
    signal: AbortSignal.timeout(5000),
  })
}

// Attach browser cookies for sites that block unauthenticated downloads. The desktop
// writes these to a temp file and passes --cookies to yt-dlp.
async function withCookies(payload) {
  const domain = needsCookies(payload?.url || '') || needsCookies(payload?.page_url || '')
  if (!domain) return payload
  const cookies = await getCookiesAsNetscape(COOKIE_DOMAINS[domain][0])
  return cookies ? { ...payload, _cookies: cookies } : payload
}

// Save + collections in parallel (they don't depend on each other), shaped for the
// content script.
async function saveAndDescribe(payload) {
  const [result, cols] = await Promise.all([saveItem(await withCookies(payload)), getCollections()])
  return {
    ok:             true,
    already_exists: result.already_exists  ?? false,
    queued:         result.queued          ?? false,
    collections:    cols,
    inspiration_id: result.inspiration_id  ?? null,
    ext_id:         result.ext_id          ?? null,
    is_frame:       result.is_frame        ?? false,
  }
}

// ─── Context menu ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: onInstalled also fires on updates, and re-creating an existing
  // id throws.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'qooti-save',
      title: 'Save to qooti',
      contexts: ['image', 'video', 'page'],
    })
  })
  // Auto-pair on install (fire and forget)
  ensurePaired()
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
      const handled = await chrome.tabs.sendMessage(tab.id, { action: 'context-save', payload })
      if (handled?.ok) return
    } catch { /* no content script on this page */ }
  }
  if (payload.type === 'page') { flashIcon(tab?.id, false); return }   // needs the page's script
  try {
    await saveAndDescribe(payload)
    flashIcon(tab?.id, true)
  } catch (e) {
    flashIcon(tab?.id, false)
    console.warn('[qooti] context menu save failed:', e?.message)
  }
})

function flashIcon(tabId, ok) {
  if (tabId == null) return
  chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#16A34A' : '#DC2626' })
  chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' })
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 4000)
}

// ─── Message handler (from content.js / popup.js) ────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // No-op wake message — content script sends this on badge hover to pre-warm
  // the service worker before the user clicks, eliminating the 1-2s SW startup lag.
  if (msg.action === 'wake') { sendResponse({ ok: true }); return }

  // Fast reachability check called by content.js before every save.
  if (msg.action === 'check-running') {
    ;(async () => {
      const running = await quickPing()
      sendResponse({ running })
    })()
    return true
  }

  if (msg.action === 'save') {
    ;(async () => {
      try {
        sendResponse(await saveAndDescribe(msg.payload))
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof UserError ? e.message : MSG.failed, kind: e?.kind ?? 'failed' })
      }
    })()
    return true
  }

  if (msg.action === 'get-progress') {
    ;(async () => {
      try {
        const key = await ensurePaired()
        if (!key) { sendResponse(null); return }
        const r = await fetch(`${DESKTOP}/extension/download-progress/${msg.ext_id}`, {
          headers: { 'X-Qooti-Key': key },
          signal: AbortSignal.timeout(2500),
        })
        sendResponse(r.ok ? await r.json() : null)
      } catch {
        sendResponse(null)
      }
    })()
    return true
  }

  if (msg.action === 'cancel-download') {
    ;(async () => {
      try {
        const key = await ensurePaired()
        if (key) {
          await fetch(`${DESKTOP}/extension/cancel/${msg.ext_id}`, {
            method: 'POST',
            headers: { 'X-Qooti-Key': key },
            signal: AbortSignal.timeout(2000),
          })
        }
      } catch {}
      sendResponse({ ok: true })
    })()
    return true
  }

  if (msg.action === 'open-item') {
    ;(async () => {
      try {
        const key = await ensurePaired()
        if (key) {
          await fetch(`${DESKTOP}/extension/open-item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Qooti-Key': key },
            body: JSON.stringify({ inspiration_id: msg.inspiration_id }),
            signal: AbortSignal.timeout(3000),
          })
        }
        sendResponse({ ok: true })
      } catch {
        sendResponse({ ok: false })
      }
    })()
    return true
  }

  // Launch (or bring forward) the desktop app through its qooti:// link. Chrome asks
  // once whether to allow opening qooti; the current page stays where it is.
  if (msg.action === 'open-app') {
    ;(async () => {
      try {
        const tabId = msg.tab_id ?? sender?.tab?.id
        if (tabId != null) await chrome.tabs.update(tabId, { url: 'qooti://open' })
        else await chrome.tabs.create({ url: 'qooti://open' })
        sendResponse({ ok: true })
      } catch {
        sendResponse({ ok: false })
      }
    })()
    return true
  }

  if (msg.action === 'add-to-collection') {
    ;(async () => {
      try {
        await addToCollection(msg.inspiration_id, msg.collection_id)
        invalidateCollectionsCache()
        sendResponse({ ok: true })
      } catch (e) {
        sendResponse({ ok: false })
      }
    })()
    return true
  }

  if (msg.action === 'check-pending') {
    // Called by the visible tab's content script every few seconds: the app queues a
    // URL here when it needs this browser's sign-in to download it (e.g. Instagram).
    ;(async () => {
      // Don't try to pair while the desktop isn't running.
      const key = (await getKey()) ?? ((await quickPing()) ? await pair() : null)
      if (!key) { sendResponse(null); return }
      try {
        const r = await fetch(`${DESKTOP}/extension/pending-download`, {
          headers: { 'X-Qooti-Key': key },
          signal: AbortSignal.timeout(1500),
        })
        if (!r.ok) { sendResponse(null); return }
        const data = await r.json()
        if (!data.url) { sendResponse({ pending: false }); return }

        const url = data.url
        await saveItem(await withCookies({
          url,
          page_url: url,
          type: 'video',
          source_platform: detectPlatform(url),
        }))
        sendResponse({ pending: true, ok: true })
      } catch (e) {
        console.warn('[qooti] check-pending failed:', e?.message)
        sendResponse({ pending: false })
      }
    })()
    return true
  }

  if (msg.action === 'get-status') {
    ;(async () => {
      const info = await ping()
      const key  = info ? await ensurePaired() : await getKey()
      sendResponse({
        running:   !!info,
        connected: !!info && !!key,
        version:   info?.version ?? null,
      })
    })()
    return true
  }

  if (msg.action === 'get-collections') {
    ;(async () => {
      const cols = await getCollections()
      sendResponse({ collections: cols })
    })()
    return true
  }

  if (msg.action === 'set-pref') {
    ;(async () => {
      const key = await getKey()
      if (!key) { sendResponse({ ok: false }); return }
      try {
        await fetch(`${DESKTOP}/extension/set-pref`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Qooti-Key': key },
          body: JSON.stringify({ key: msg.key, value: msg.value }),
          signal: AbortSignal.timeout(2000),
        })
        sendResponse({ ok: true })
      } catch (e) {
        sendResponse({ ok: false })
      }
    })()
    return true
  }
})

// ─── Cookie export ───────────────────────────────────────────────

// Domains that require a logged-in session for yt-dlp to download.
const COOKIE_DOMAINS = {
  'instagram.com': ['instagram.com'],
  'instagr.am':    ['instagram.com'],
  'tiktok.com':    ['tiktok.com'],
}

function needsCookies(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return Object.keys(COOKIE_DOMAINS).find(d => host === d || host.endsWith('.' + d)) ?? null
  } catch { return null }
}

// Returns a Netscape-format cookie file string for the given domain, or null.
function getCookiesAsNetscape(domain) {
  return new Promise(resolve => {
    chrome.cookies.getAll({ domain }, cookies => {
      if (!cookies?.length) { resolve(null); return }
      const lines = ['# Netscape HTTP Cookie File']
      for (const c of cookies) {
        const d    = c.domain.startsWith('.') ? c.domain : '.' + c.domain
        const sub  = c.hostOnly ? 'FALSE' : 'TRUE'
        const sec  = c.secure   ? 'TRUE'  : 'FALSE'
        const exp  = c.expirationDate ? Math.floor(c.expirationDate) : 0
        lines.push(`${d}\t${sub}\t${c.path}\t${sec}\t${exp}\t${c.name}\t${c.value}`)
      }
      resolve(lines.join('\n'))
    })
  })
}

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
