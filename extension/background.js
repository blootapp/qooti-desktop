// qooti Chrome Extension — background service worker
// Handles: pairing with the desktop, collection caching, save requests.

const DESKTOP = 'http://127.0.0.1:1420'
const STORAGE_KEY  = 'qooti_key'
const COLLECTIONS_KEY  = 'qooti_collections'
const COLLECTIONS_TTL  = 5 * 60 * 1000  // 5 minutes

// ─── Connection ──────────────────────────────────────────────────

async function getKey() {
  const res = await chrome.storage.local.get(STORAGE_KEY)
  return res[STORAGE_KEY] ?? null
}

async function setKey(key) {
  await chrome.storage.local.set({ [STORAGE_KEY]: key })
}

// Ping the desktop. Returns { version, platform } or null if offline.
async function ping() {
  try {
    const r = await fetch(`${DESKTOP}/extension/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// Ultra-fast reachability check — used before save to detect "not running" quickly.
// ECONNREFUSED from the OS is near-instant; the 300 ms cap handles slow networks/firewalls.
async function quickPing() {
  try {
    const r = await fetch(`${DESKTOP}/extension/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(300),
    })
    return r.ok
  } catch {
    return false
  }
}

// Auto-pair on first install. Desktop generates and returns the key.
// Subsequent calls with no existing key also re-pair (e.g. after reinstall).
async function pair() {
  try {
    const r = await fetch(`${DESKTOP}/extension/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(800),
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
  if (!key) return []
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
  if (!key) throw new Error('qooti is not running')
  const post = k => fetch(`${DESKTOP}/extension/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Qooti-Key': k },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  })
  let r = await post(key)
  // Stale key (desktop was reinstalled/reset) → re-pair once and retry, so saving
  // keeps working without the user having to manually reconnect the extension.
  if (r.status === 401) {
    const fresh = await repair()
    if (fresh) r = await post(fresh)
  }
  if (!r.ok) {
    const text = await r.text()
    throw new Error(text || `HTTP ${r.status}`)
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

// ─── Context menu ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'qooti-save',
    title: 'Save to qooti',
    contexts: ['image', 'video', 'page'],
  })
  // Auto-pair on install (fire and forget)
  ensurePaired()
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'qooti-save') return
  const url      = info.srcUrl ?? info.pageUrl ?? tab?.url ?? ''
  const pageUrl  = tab?.url ?? ''
  const title    = tab?.title ?? ''
  const type     = info.mediaType === 'image' ? 'image' : 'video'
  const platform = detectPlatform(pageUrl)
  try {
    const result = await saveItem({ url, page_url: pageUrl, title, type, source_platform: platform })
    // Notify content script to show picker
    if (tab?.id) {
      const cols = await getCollections()
      chrome.tabs.sendMessage(tab.id, {
        action: 'show-picker',
        collections: cols,
        inspiration_id: result.inspiration_id ?? null,
      }).catch(() => {})
    }
  } catch (e) {
    console.error('[qooti] context menu save failed:', e)
  }
})

// ─── Message handler (from content.js) ──────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // No-op wake message — content script sends this on badge hover to pre-warm
  // the service worker before the user clicks, eliminating the 1-2s SW startup lag.
  if (msg.action === 'wake') { sendResponse({ ok: true }); return }

  // Fast reachability check called by content.js before every save.
  // Resolves in ~5ms (ECONNREFUSED) or ~300ms worst-case, so the UI can
  // show "not running" almost instantly instead of waiting out a 2-3 s timeout.
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
        // Attach browser cookies for sites that block unauthenticated downloads.
        // The desktop writes these to a temp file and passes --cookies to yt-dlp,
        // avoiding the locked-SQLite-database error from --cookies-from-browser.
        let payload = msg.payload
        const cookieDomain = needsCookies(payload?.url || payload?.page_url || '')
        if (cookieDomain) {
          const cookieKey = Object.keys(COOKIE_DOMAINS).find(k =>
            (payload?.url || '').includes(k) || (payload?.page_url || '').includes(k)
          )
          const domain = cookieKey ? COOKIE_DOMAINS[cookieKey][0] : cookieDomain
          const cookies = await getCookiesAsNetscape(domain)
          if (cookies) payload = { ...payload, _cookies: cookies }
        }
        const result = await saveItem(payload)
        const cols   = await getCollections()
        sendResponse({
          ok:             true,
          already_exists: result.already_exists  ?? false,
          collections:    cols,
          inspiration_id: result.inspiration_id  ?? null,
          ext_id:         result.ext_id           ?? null,
          is_frame:       result.is_frame          ?? false,
        })
      } catch (e) {
        sendResponse({ ok: false, error: e.message })
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
          signal: AbortSignal.timeout(2000),
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
    // Called by content.js every 3 s to wake the service worker and check whether
    // the app has queued a URL that needs extension cookies to download.
    ;(async () => {
      // ensurePaired() re-attempts pairing if the key is missing — handles the case
      // where the extension was installed while the desktop app was not running.
      const key = await ensurePaired()
      if (!key) { sendResponse(null); return }
      try {
        const r = await fetch(`${DESKTOP}/extension/pending-download`, {
          headers: { 'X-Qooti-Key': key },
          signal: AbortSignal.timeout(1500),
        })
        if (!r.ok) { sendResponse(null); return }
        const data = await r.json()
        if (!data.url) { sendResponse({ pending: false }); return }

        // Run the same save flow used for user-initiated saves.
        const url = data.url
        let payload = {
          url,
          page_url: url,
          type: 'video',
          source_platform: detectPlatform(url),
        }
        const cookieDomain = needsCookies(url)
        if (cookieDomain) {
          const domainKey = Object.keys(COOKIE_DOMAINS).find(k =>
            url.includes(k)
          )
          const domain = domainKey ? COOKIE_DOMAINS[domainKey][0] : cookieDomain
          const cookies = await getCookiesAsNetscape(domain)
          if (cookies) payload = { ...payload, _cookies: cookies }
        }
        await saveItem(payload)
        sendResponse({ pending: true, ok: true })
      } catch (e) {
        console.error('[qooti] check-pending failed:', e)
        sendResponse({ pending: false, error: e.message })
      }
    })()
    return true
  }

  if (msg.action === 'get-status') {
    ;(async () => {
      const info = await ping()
      const key  = await getKey()
      sendResponse({ connected: !!info && !!key, version: info?.version ?? null })
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

  if (msg.action === 'disconnect') {
    chrome.storage.local.remove([STORAGE_KEY, COLLECTIONS_KEY, COLLECTIONS_KEY + '_ts'])
    sendResponse({ ok: true })
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
