// qooti content script — badge, pill, picker, notifications
;(function () {
  if (window.__qooticInjected) return
  window.__qooticInjected = true

  const i18n = globalThis.qootiI18n
  const t = (key, vars) => i18n.t(key, vars)

  // ─── Our look ────────────────────────────────────────────────────
  // Styles, icons and fonts come from the extension itself (background.js getUiKit):
  // none of its files can be fetched by web pages, so a page can't tell qooti is
  // installed by asking for one.
  let kit = null
  const kitReady = new Promise(resolve => safeSend({ action: 'ui-kit' }, res => { kit = res?.css ? res : null; resolve(kit) }))
  const icon = name => kit?.icons?.[name] ?? ''
  const ico  = name => `<span class="qooti-ico">${icon(name)}</span>`
  const toastMark = () => `<span class="qooti-toast-mark">${icon('toast-mark')}</span>`

  // Names made up for each page: our element and fonts don't say qooti (a page can list
  // a document's elements and fonts).
  const letters = n => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')
  const HOST_TAG  = `${letters(5)}-${letters(5)}`
  const FONT_SANS = letters(10)
  const FONT_MONO = letters(10)

  // Fonts arrive as data and are added to the page under those names, once each.
  const fontsAsked = new Set()
  function useFont(kind, family) {
    if (fontsAsked.has(kind)) return
    fontsAsked.add(kind)
    safeSend({ action: 'ui-font', font: kind }, res => {
      if (!res?.data) return
      try {
        const bytes = Uint8Array.from(atob(res.data), c => c.charCodeAt(0))
        document.fonts.add(new FontFace(family, bytes.buffer, { weight: '100 900' }))
      } catch {}
    })
  }

  // ─── Our UI lives in a sealed box ────────────────────────────────
  // The button, the toasts and the collection picker sit in a closed shadow root: the
  // page's own scripts can't read them (your collection names, what you just saved) or
  // reach in to press them, and the page's CSS can't bend them. Clicks also count only
  // when a person made them (`real`).
  let _uiHost = null
  let _uiRoot = null

  function uiRoot() {
    if (_uiRoot && _uiHost.isConnected) return _uiRoot
    const host = _uiHost = document.createElement(HOST_TAG)
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;visibility:hidden'
    ;(document.documentElement || document.body).appendChild(host)
    const root = host.attachShadow({ mode: 'closed' })
    // Shown once styled. Adopted sheets don't go through the page's style rules (CSP);
    // a <style> is the fallback.
    kitReady.then(k => {
      if (!k) return
      const css = k.css.replaceAll("'qooti Geist Mono'", `'${FONT_MONO}'`).replaceAll("'qooti Geist'", `'${FONT_SANS}'`)
      try {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(css)
        root.adoptedStyleSheets = [sheet]
      } catch {
        const style = document.createElement('style')
        style.textContent = css
        root.prepend(style)
      }
      host.style.visibility = ''
    })
    useFont('sans', FONT_SANS)
    _uiRoot = root
    return root
  }

  // Our element as the page's hit tests see it (what's inside is hidden behind it).
  const isOurs = e => !!e && !!_uiHost && (e === _uiHost || _uiHost.contains(e))

  // Wrap a handler so only a real click (not one a page script made up) runs it.
  const real = fn => e => { if (e.isTrusted) fn(e) }

  // ─── Settings ────────────────────────────────────────────────────
  let badgePosition = 'top-left'
  let showPicker    = true
  // Sites where the qooti badge must never appear. Defaults applied until the
  // user edits the list in the extension (which writes to chrome.storage.sync).
  let bannedSites   = ['flaticon.com']
  let langSetting   = 'auto'
  let appLang       = null

  chrome.storage.sync.get(['badgePosition', 'showPicker', 'bannedSites', 'lang', 'appLang'], res => {
    if (res.badgePosition)       badgePosition = res.badgePosition
    if (res.showPicker != null)  showPicker    = res.showPicker
    if (Array.isArray(res.bannedSites)) bannedSites = res.bannedSites
    langSetting = res.lang ?? 'auto'
    appLang     = res.appLang ?? null
    i18n.use(i18n.pick(langSetting, appLang))
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return
    if (changes.badgePosition) badgePosition = changes.badgePosition.newValue
    if (changes.showPicker)    showPicker    = changes.showPicker.newValue
    if (changes.bannedSites)   bannedSites   = changes.bannedSites.newValue ?? []
    if (changes.lang)          langSetting   = changes.lang.newValue ?? 'auto'
    if (changes.appLang)       appLang       = changes.appLang.newValue ?? null
    if (changes.lang || changes.appLang) i18n.use(i18n.pick(langSetting, appLang))
  })

  // ─── Per-site badge position ─────────────────────────────────────
  // Kept by the extension (pages can't read our storage); a page only ever gets its own.
  let customBadgePos = null  // { ratioX, ratioY } — fraction within media element
  safeSend({ action: 'get-position' }, res => { customBadgePos = res?.pos ?? null })

  // Normalise any user-typed entry to a bare host: strips scheme (http/https),
  // path/query, port, and a leading "www." — so "https://www.flaticon.com/x"
  // and "flaticon.com" both become "flaticon.com".
  function normHost(v) {
    return String(v || '')
      .trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, '')   // scheme
      .split('/')[0]                 // path/query/hash
      .split(':')[0]                 // port
      .replace(/^www\./, '')         // www.
  }

  function isCurrentSiteBanned() {
    const host = normHost(location.hostname)
    return bannedSites.some(entry => {
      const s = normHost(entry)
      return s && (host === s || host.endsWith('.' + s))
    })
  }

  // ─── Notification toast ──────────────────────────────────────────
  let _toastEl    = null
  let _toastTimer = null

  // A short message in plain words: { title, message, tone: 'error'|'info', action: { label, onClick } }.
  function showMessage({ title, message = '', tone = 'error', action = null, duration = 6000 }) {
    if (_toastEl) { clearTimeout(_toastTimer); _toastEl.remove(); _toastEl = null }

    const toast = document.createElement('div')
    // Figma Page toast · Type=Message: bare mark, text, action on the right, ×.
    // Type=Upgrade (free limit) keeps the mark tile and has no ×.
    const upgrade = action?.variant === 'upgrade'
    toast.className = `qooti-toast ${upgrade ? 'qooti-toast--upgrade' : 'qooti-toast--message'} qooti-toast--${tone}`
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status')
    toast.innerHTML = `
      ${toastMark()}
      <div class="qooti-toast-body">
        <span class="qooti-toast-title"></span>
        <span class="qooti-toast-msg"></span>
      </div>
      <button class="qooti-btn qooti-btn--secondary qooti-toast-action" hidden></button>
      ${upgrade ? '' : `<button class="qooti-icon-btn qooti-toast-close">${ico('close')}</button>`}
    `
    toast.querySelector('.qooti-toast-close')?.setAttribute('title', t('common.dismiss'))
    toast.querySelector('.qooti-toast-close')?.setAttribute('aria-label', t('common.dismiss'))
    toast.querySelector('.qooti-toast-title').textContent = title
    toast.querySelector('.qooti-toast-msg').textContent = message
    if (!message) toast.querySelector('.qooti-toast-msg').remove()
    if (action) {
      const btn = toast.querySelector('.qooti-toast-action')
      btn.hidden = false
      btn.textContent = action.label
      if (action.variant) btn.classList.replace('qooti-btn--secondary', `qooti-btn--${action.variant}`)
      btn.addEventListener('click', real(() => { action.onClick(); dismissToast() }))
    }
    toast.querySelector('.qooti-toast-close')?.addEventListener('click', real(() => dismissToast()))
    toast.addEventListener('mouseenter', () => clearTimeout(_toastTimer))
    toast.addEventListener('mouseleave', () => { _toastTimer = setTimeout(dismissToast, 2500) })
    uiRoot().appendChild(toast)
    _toastEl = toast
    requestAnimationFrame(() => toast.classList.add('qooti-toast--in'))
    _toastTimer = setTimeout(dismissToast, duration)
  }

  function openApp() {
    safeSend({ action: 'open-app' })
  }

  // The plan page on the account site, where Free becomes Pro.
  const upgradeAction = () => ({
    label: t('common.upgrade'), variant: 'upgrade',
    onClick: () => window.open('https://account.bloot.app/plan/', '_blank', 'noopener'),
  })

  // The extension isn't connected to qooti yet: qooti is asking ("Connect your
  // browser?"), or the user said no there.
  function showPairingMessage(err) {
    if (err.kind === 'pairing') {
      showMessage({ tone: 'info', title: t('pair.pending.title'), message: err.message, action: { label: t('common.open_qooti'), onClick: openApp }, duration: 9000 })
    } else {
      showMessage({ title: t('pair.denied.title'), message: err.message, duration: 8000 })
    }
  }

  function showNotRunning() {
    showMessage({
      title: t('offline.title'),
      message: t('offline.msg'),
      action: { label: t('common.open_qooti'), onClick: openApp },
      duration: 8000,
    })
  }

  // A video that needs the user's sign-in on a site they haven't let qooti use yet.
  function showSigninNeeded(site) {
    showMessage({
      tone: 'info',
      title: t('signin.title'),
      message: t('signin.msg', { site }),
      action: { label: t('common.settings'), onClick: () => safeSend({ action: 'open-settings', part: 'signin' }) },
      duration: 10000,
    })
  }

  // chrome.runtime.sendMessage throws once the extension was updated/reloaded while
  // this page stayed open ("Extension context invalidated") — never let that surface.
  function extensionAlive() { try { return !!chrome.runtime?.id } catch { return false } }
  function safeSend(msg, cb) {
    if (!extensionAlive()) { cb?.(null); return }
    try {
      chrome.runtime.sendMessage(msg, res => { void chrome.runtime.lastError; cb?.(res ?? null) })
    } catch { cb?.(null) }
  }

  function dismissToast() {
    clearTimeout(_toastTimer)
    if (!_toastEl) return
    _toastEl.classList.remove('qooti-toast--in')
    const el = _toastEl
    _toastEl = null
    setTimeout(() => el.remove(), 240)
  }

  // ─── Platform helpers ────────────────────────────────────────────
  function detectPlatform(url) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '')
      if (h.includes('youtube.com') || h.includes('youtu.be')) return 'youtube'
      if (h.includes('instagram.com'))  return 'instagram'
      if (h.includes('pinterest.'))     return 'pinterest'
      if (h.includes('tiktok.com'))     return 'tiktok'
      if (h.includes('behance.net'))    return 'behance'
      if (h.includes('dribbble.com'))   return 'dribbble'
      if (h.includes('twitter.com') || h.includes('x.com')) return 'x'
      if (h.includes('reddit.com'))     return 'reddit'
      if (h.includes('vimeo.com'))      return 'vimeo'
    } catch {}
    return null
  }

  function getYouTubeVideoId() {
    try { return new URL(location.href).searchParams.get('v') || null } catch { return null }
  }

  // YouTube videos and video thumbnails open into options (video, thumbnail, frame).
  const YT_THUMB_RE = /i\.ytimg\.com\/(?:vi|vi_webp|an_webp)\/([\w-]{11})\//
  function usePill(el) {
    return SITE === 'youtube' && (el.tagName === 'VIDEO' || YT_THUMB_RE.test(el.currentSrc || el.src || ''))
  }

  // ─── Frame capture ───────────────────────────────────────────────
  function captureFrameAsPng(videoEl) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas')
      canvas.width  = videoEl.videoWidth  || 1280
      canvas.height = videoEl.videoHeight || 720
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('toBlob returned null'))
        const reader = new FileReader()
        reader.onload  = () => resolve({ blob, dataUrl: reader.result })
        reader.onerror = reject
        reader.readAsDataURL(blob)
      }, 'image/png')
    })
  }

  // YouTube card selector — covers homepage grid, search results, sidebar, playlists.
  const YT_CARD_SEL = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-reel-item-renderer',
    'ytd-playlist-video-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
    '[data-video-id]',
  ].join(',')

  // Find the YouTube card that visually contains a given element.
  // Uses elementsFromPoint on the element's bounding-rect centre so it works
  // even when the <video> (ytd-video-preview) is a portal not inside the card DOM.
  function getYouTubeCard(el) {
    // Fast path: el is already inside the card
    const byDom = el.closest(YT_CARD_SEL)
    if (byDom) return byDom
    // Positional fallback: find which card sits behind the element on screen
    try {
      const r  = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      const cx = r.left + r.width  / 2
      const cy = r.top  + r.height / 2
      return document.elementsFromPoint(cx, cy).find(e => e.matches(YT_CARD_SEL)) || null
    } catch { return null }
  }

  // Extract a canonical watch URL from a YouTube card element.
  // Returns null if no video link is found — callers must handle this.
  function getWatchUrlFromCard(card) {
    if (!card) return null
    // Prefer data-video-id — set by YouTube on most card roots
    if (card.dataset.videoId) return `https://www.youtube.com/watch?v=${card.dataset.videoId}`
    // Fall back to the first watch/shorts/live anchor inside the card
    const a = card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"], a[href*="/live/"]')
    if (!a) return null
    try {
      const u  = new URL(a.getAttribute('href'), location.origin)
      const id = u.searchParams.get('v')
        || u.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1]
        || null
      return id ? `https://www.youtube.com/watch?v=${id}` : null
    } catch { return null }
  }

  // The video a YouTube media element stands for: the open video for the main player,
  // otherwise the thumbnail's own id or the card's link (never the page's video —
  // a preview in the sidebar is a different video).
  function youTubeVideoId(el) {
    if (el.closest?.('#movie_player') && getYouTubeVideoId()) return getYouTubeVideoId()
    const fromSrc = (el.currentSrc || el.src || '').match(YT_THUMB_RE)?.[1]
    if (fromSrc) return fromSrc
    const watchUrl = getWatchUrlFromCard(getYouTubeCard(el))
    try { return watchUrl ? new URL(watchUrl).searchParams.get('v') : null } catch { return null }
  }

  function getYouTubeOptions(videoEl) {
    const videoId  = youTubeVideoId(videoEl)
    const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null

    // Thumbnail: always the highest-res YouTube thumbnail for this video
    const thumbUrl = videoId
      ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
      : (videoEl.poster || null)

    // Title: pull from the card when available, fall back to page title
    let title = document.title.replace(/ - YouTube$/, '')
    try {
      const card    = videoEl.closest('#movie_player') ? null : getYouTubeCard(videoEl)
      const titleEl = card?.querySelector('#video-title, yt-formatted-string#video-title, .ytd-video-meta-block .title, h3 a, h3 span[role="text"]')
      if (titleEl?.textContent?.trim()) title = titleEl.textContent.trim()
    } catch {}

    const opts = []
    if (watchUrl) {
      opts.push({
        icon: ico('opt-video'), label: t('yt.video'),
        payload: async () => ({ url: watchUrl, page_url: location.href, title, type: 'video', source_platform: 'youtube', thumbnail_url: thumbUrl })
      })
    }
    if (thumbUrl) {
      opts.push({
        icon: ico('opt-image'), label: t('yt.thumbnail'),
        payload: async () => ({ url: thumbUrl, page_url: location.href, title, type: 'image', source_platform: 'youtube' })
      })
    }
    if (videoId && videoEl.tagName === 'VIDEO') {
      opts.push({
        icon: ico('opt-frame'), label: t('yt.frame'),
        action: badge => screenshotFrame(videoEl, badge)
      })
    }
    return opts
  }

  // ─── Badge state ──────────────────────────────────────────────────
  let currentBadge  = null
  let currentTarget = null
  let cursorWatcher = null
  let _dragActive   = false

  // ─── Which media get the button ──────────────────────────────────
  // General rules for every site, plus site rules for the big inspiration sites.
  // Each media element is judged once per size (images grow as they load).
  const verdicts = new WeakMap()

  function isValidMedia(el) {
    if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO') return false
    const r = el.getBoundingClientRect()
    const w = Math.round(r.width), h = Math.round(r.height)
    const known = verdicts.get(el)
    if (known && known.w === w && known.h === h) return known.ok
    let ok = false
    try { ok = w > 0 && h > 0 && judgeMedia(el, w, h) } catch {}
    verdicts.set(el, { w, h, ok })
    return ok
  }

  function judgeMedia(el, w, h) {
    if (isAd(el)) return false
    const site = SITE_RULES[SITE]?.judge?.(el, w, h)
    if (site !== undefined) return site
    return judgeGeneral(el, w, h)
  }

  const minSide = (w, h) => Math.min(w, h)
  // Big enough to be content: thumbnails pass (YouTube's "Up next" is ~168×94), icons don't.
  const bigEnough = (w, h) => minSide(w, h) >= 80 && w * h >= 15000

  function judgeGeneral(el, w, h) {
    const src = el.currentSrc || el.src || ''
    // Known video-thumbnail servers always pass, whatever the size
    if (/^https?:\/\/[^/]*(ytimg\.com|vimeocdn\.com)\//.test(src) && minSide(w, h) >= 60) return true
    if (!bigEnough(w, h)) return false
    if (Math.max(w, h) / minSide(w, h) > 4) return false                 // banners, dividers
    if (looksLikeAvatar(el, w, h)) return false
    if (looksLikeUi(el, src)) return false
    // Interface areas — unless the picture is big (a hero image in a page header)
    if (minSide(w, h) < 200 && el.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="toolbar"], [role="tablist"], [role="menu"]')) return false
    if (minSide(w, h) < 150 && el.closest('button, [role="button"]')) return false
    // Small muted autoplay loops are ads or decoration (never used alone: size decides)
    if (el.tagName === 'VIDEO' && el.muted && el.loop && el.autoplay && !el.controls && w * h < 40000) return false
    return true
  }

  // Round, roughly square pictures are profile photos.
  function looksLikeAvatar(el, w, h) {
    if (/\b(avatar|profile (picture|photo|image))\b/i.test(el.alt || '')) return true
    if (Math.abs(w - h) > Math.max(w, h) * 0.1 || minSide(w, h) > 220) return false
    for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
      const rad = getComputedStyle(e).borderTopLeftRadius
      const px = rad.endsWith('%') ? parseFloat(rad) / 100 * w : parseFloat(rad)
      if (px >= minSide(w, h) * 0.4) return true
    }
    return false
  }

  // Logos, icons, emoji, sprites — by class/id names and file paths, not by alt text
  // (a real design can be called "logo design").
  const UI_NAME_RE = /^(.*[-_])?(avatar|userpic|profile-?pic(ture)?|logo|icon|emoji|sprite|favicon)([-_].*)?$/i
  function looksLikeUi(el, src) {
    if (/\/(avatars?|profile_images|emojis?|icons?|sprites?|favicons?)\//i.test(src.split('?')[0])) return true
    for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) {
      const names = [e.id, ...(typeof e.className === 'string' ? e.className.split(/\s+/) : [])]
      if (names.some(n => n && UI_NAME_RE.test(n))) return true
    }
    return false
  }

  // Ads: served from an ad network, or sitting in a slot the site marks as an ad.
  const AD_HOST_RE = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|amazon-adsystem\.com|adnxs\.com|taboola\.com|outbrain\.com|criteo\.(com|net)|moatads\.com|adsrvr\.org|teads\.tv)$/i
  const AD_NAME_RE = /^(ad|ads|adv|advert|advertisement|adsbygoogle|sponsor|sponsored|promoted|dfp|gpt)([-_].*)?$|(^|[-_])(ad|ads|advert|advertisement|sponsored|promoted)$/i
  function isAd(el) {
    try { if (AD_HOST_RE.test(new URL(el.currentSrc || el.src, location.href).hostname)) return true } catch {}
    for (let e = el, i = 0; e && e !== document.body && i < 10; e = e.parentElement, i++) {
      if (e.tagName === 'INS' && e.classList.contains('adsbygoogle')) return true
      const names = [e.id, ...(typeof e.className === 'string' ? e.className.split(/\s+/) : [])]
      if (names.some(n => n && AD_NAME_RE.test(n))) return true
      if (e.hasAttribute('data-ad-slot') || e.hasAttribute('data-google-query-id')) return true
      if (/^(advertisement|sponsored|ad)$/i.test(e.getAttribute('aria-label') || '')) return true
    }
    return false
  }

  // ─── Site rules ──────────────────────────────────────────────────
  // judge(el, w, h) → true / false, or undefined to fall back to the general rules.
  // payload(el) → fields that replace the general save payload.
  const SITE = (() => {
    const h = location.hostname.replace(/^www\./, '')
    if (/(^|\.)youtube\.com$/.test(h))   return 'youtube'
    if (/(^|\.)pinterest\./.test(h))     return 'pinterest'
    if (/(^|\.)instagram\.com$/.test(h)) return 'instagram'
    if (/(^|\.)behance\.net$/.test(h))   return 'behance'
    if (/(^|\.)cosmos\.so$/.test(h))     return 'cosmos'
    return null
  })()

  const absUrl = href => { try { return new URL(href, location.href).href } catch { return null } }

  const SITE_RULES = {
    youtube: {
      // YouTube's hover preview (animated thumbnail, then an inline player) lies over
      // the thumbnail: it's part of the card, except its own buttons (mute, captions).
      partOfCard(e) {
        return !!e.closest('ytd-video-preview, #video-preview, #inline-preview-player, animated-thumbnail-overlay-view-model') && !e.closest(CONTROL_SEL)
      },
      judge(el, w, h) {
        if (el.closest('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-banner-promo-renderer, ytd-companion-slot-renderer, ytd-action-companion-ad-renderer, ytd-player-legacy-desktop-watch-ads-renderer, .ytp-ad-module, .ytp-ad-player-overlay, .video-ads')) return false
        if (el.closest('#avatar, #channel-thumbnail, #author-thumbnail, yt-img-shadow, yt-avatar-shape, ytd-comment-view-model, ytd-comment-renderer, ytd-comment-simplebox-renderer, #masthead')) return false
        if (el.tagName === 'VIDEO') return w >= 160 && h >= 90
        if (YT_THUMB_RE.test(el.currentSrc || el.src || '')) return w >= 100
        return undefined
      },
    },
    pinterest: {
      judge(el, w, h) {
        if (el.closest('[data-test-id*="avatar" i], [data-test-id="user-avatar"]')) return false
        const size = (el.currentSrc || el.src || '').match(/pinimg\.com\/(\d+)x(\d+)?\//)
        if (size && Number(size[1]) <= 75) return false                // 30x30 / 60x60 / 75x75 avatars
        const card = el.closest('[data-test-id="pin"], [data-test-id="pinWrapper"], [data-grid-item="true"]')
        if (card && /\b(Promoted by|Sponsored)\b/.test(card.innerText || '')) return false
        return undefined
      },
      payload(el) {
        const card = el.closest('[data-test-id="pin"], [data-test-id="pinWrapper"], [data-grid-item="true"]')
        const pin = absUrl(card?.querySelector('a[href*="/pin/"]')?.getAttribute('href') || el.closest('a[href*="/pin/"]')?.getAttribute('href') || '')
        if (el.tagName === 'VIDEO') return { url: pin || location.href, page_url: pin || location.href, type: 'video' }
        return pin ? { page_url: pin } : {}
      },
    },
    instagram: {
      judge(el) {
        if (/profile picture|highlight story picture|story/i.test(el.alt || '')) return false
        if (el.closest('header, [role="button"][aria-label*="story" i], a[href*="/stories/"]')) return false
        return undefined
      },
      payload(el) {
        // The post this media belongs to: its own link on grids, the post's link in feeds.
        const POST = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]'
        const href = el.closest(POST)?.getAttribute('href')
          || el.closest('article')?.querySelector('a[href*="/p/"] time, a[href*="/reel/"] time')?.closest('a')?.getAttribute('href')
          || el.closest('article')?.querySelector(POST)?.getAttribute('href')
        const post = absUrl(href || '') || (/\/(p|reels?)\//.test(location.pathname) ? location.href : null)
        const isVideo = el.tagName === 'VIDEO' || /^Video by/i.test(el.alt || '') || /\/reels?\//.test(post || '')
        if (isVideo && post) return { url: post, page_url: post, type: 'video' }
        return post ? { page_url: post } : {}
      },
    },
    behance: {
      judge(el) {
        if (el.closest('.rf-ribbon, [aria-label="Featured in"], [class*="Avatar"], [class*="avatar"], [class*="ToolIcon"], [class*="Owner"]')) return false
        return undefined
      },
      payload(el) {
        // Covers: the project link sits beside the picture in the same cover
        const card = el.closest('.js-project-cover, [class*="ProjectCoverNeue-root"]')
        const href = card?.querySelector('a[href*="/gallery/"]')?.getAttribute('href') || el.closest('a[href*="/gallery/"]')?.getAttribute('href')
        const project = absUrl(href || '')?.split('?')[0]
        return project ? { page_url: project } : {}
      },
    },
    cosmos: {
      judge(el, w, h) {
        if (el.matches('[data-testid^="element-"]') || el.closest('[data-testid^="element-tile"]')) return minSide(w, h) >= 60
        return undefined
      },
      payload(el) {
        // cdn.cosmos.so/<id>?format=webp&w=400 → the original file
        const src = el.currentSrc || el.src || ''
        return /^https:\/\/cdn\.cosmos\.so\//.test(src) ? { url: src.split('?')[0] } : {}
      },
    },
  }

  // YouTube draws several things over one thumbnail as you hover (an animated image,
  // then a preview player): the button belongs to the card's own thumbnail, so it
  // doesn't jump or vanish while those come and go. The watch page's player is itself.
  function youTubeAnchor(el) {
    if (el.closest('#movie_player')) return el
    const card = getYouTubeCard(el)
    if (!card) return el
    let best = null, bestArea = 0
    for (const img of card.querySelectorAll('img')) {
      if (!/i\.ytimg\.com\/(?:vi|vi_webp)\//.test(img.currentSrc || img.src || '')) continue
      const area = areaOf(img)
      if (area > bestArea) { best = img; bestArea = area }
    }
    return best && bestArea >= 100 * 56 ? best : el
  }

  // Two hovered elements that are the same thing on screen (YouTube plays a preview
  // video or an animated image over the thumbnail you're on).
  function sameItem(a, b) {
    if (a === b) return true
    if (SITE !== 'youtube' || !a || !b) return false
    const card = getYouTubeCard(a)
    return !!card && card === getYouTubeCard(b)
  }

  // Is something of the page's own sitting over the media where the pointer is?
  // Empty layers the size of the media (Instagram, Behance, YouTube previews) are
  // fine; menus, popups, dialogs, buttons and text are not.
  const MODAL_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [role="menu"], [role="listbox"], [role="tooltip"]'
  const CONTROL_SEL = 'a, button, input, select, textarea, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"]'
  const areaOf = e => { const r = e.getBoundingClientRect(); return r.width * r.height }

  // An empty layer laid over the card itself (Instagram, Behance, YouTube previews):
  // covers most of the media and isn't much bigger than it.
  function isCardLayer(e, mediaRect) {
    const r = e.getBoundingClientRect()
    const mediaArea = mediaRect.width * mediaRect.height
    const overlapW = Math.min(r.right, mediaRect.right) - Math.max(r.left, mediaRect.left)
    const overlapH = Math.min(r.bottom, mediaRect.bottom) - Math.max(r.top, mediaRect.top)
    return overlapW > 0 && overlapH > 0 && overlapW * overlapH >= mediaArea * 0.6 && r.width * r.height <= mediaArea * 2.5
  }

  function isCovered(stack, index, media) {
    if (index === 0) return false
    const mediaArea = areaOf(media)
    for (let k = 0; k < index; k++) {
      const e = stack[k]
      if (e.contains(media)) continue
      const modal = e.closest(MODAL_SEL)
      if (modal && !modal.contains(media)) return true
      if (areaOf(e) > mediaArea * 3) return true                      // a panel or backdrop over it
    }
    const top = stack[0]
    const mediaRect = media.getBoundingClientRect()
    const control = top.closest(CONTROL_SEL)
    if (control && !control.contains(media) && !isCardLayer(control, mediaRect)) return true
    const ownText = [...top.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
    if (ownText && !top.contains(media) && !isCardLayer(top, mediaRect)) return true
    return false
  }

  // ─── Badge positioning ────────────────────────────────────────────
  // A spot is where the logo button sits, in px from the media's top-left corner.
  // Sites put their own buttons on images (Pinterest's Save, board picker and Visit
  // site; Behance's Moodboard; Cosmos' Save): try the corners first, then walk the
  // edges, and never cover something of theirs.
  const BADGE = 32, EDGE_GAP = 8, STEP = 40

  function spotCandidates(r) {
    const left = EDGE_GAP, right = r.width - EDGE_GAP - BADGE
    const top = EDGE_GAP, bottom = r.height - EDGE_GAP - BADGE
    const corners = {
      'top-left': { dx: left, dy: top }, 'top-right': { dx: right, dy: top },
      'bottom-left': { dx: left, dy: bottom }, 'bottom-right': { dx: right, dy: bottom },
    }
    const out = [corners[badgePosition] ?? corners['top-left'], ...Object.values(corners)]
    if (customBadgePos) {
      const clamp = (v, max) => Math.max(EDGE_GAP, Math.min(v, max))
      out.unshift({ dx: clamp(r.width * customBadgePos.ratioX, right), dy: clamp(r.height * customBadgePos.ratioY, bottom) })
    }
    for (let dy = top + STEP; dy < bottom; dy += STEP) out.push({ dx: left, dy }, { dx: right, dy })
    for (let dx = left + STEP; dx < right; dx += STEP) out.push({ dx, dy: top }, { dx, dy: bottom })
    return out
  }

  function pickSpot(el) {
    const r = el.getBoundingClientRect()
    if (r.width < BADGE + 2 * EDGE_GAP || r.height < BADGE + 2 * EDGE_GAP) return null
    const controls = siteControlsOn(el)
    return spotCandidates(r).find(spot => spotIsFree(el, spot, controls)) ?? null
  }

  // The site's own buttons, links and icons drawn on this media's card. Measured, not
  // just hit-tested: rounded or click-through buttons slip between probe points.
  const SITE_CONTROL_SEL = 'a, button, input, select, textarea, svg, [role="button"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"])'
  function siteControlsOn(el) {
    const r = el.getBoundingClientRect()
    const mediaArea = r.width * r.height
    // The card: the widest ancestor that still hugs the media
    let card = el.parentElement
    for (let a = el.parentElement, i = 0; a && a !== document.body && i < 8; a = a.parentElement, i++) {
      if (areaOf(a) > mediaArea * 3) break
      card = a
    }
    if (!card || card === document.body) return []
    const out = []
    for (const c of card.querySelectorAll(SITE_CONTROL_SEL)) {
      if (isOurs(c) || c.contains(el) || el.contains(c)) continue
      const q = c.getBoundingClientRect()
      if (q.width < 4 || q.height < 4 || isCardLayer(c, r)) continue    // the card's own link layer
      const cs = getComputedStyle(c)
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue
      out.push(q)
    }
    return out
  }

  function spotIsFree(el, spot, controls = siteControlsOn(el)) {
    const r = el.getBoundingClientRect()
    const x0 = r.left + spot.dx, y0 = r.top + spot.dy
    if (x0 < 0 || y0 < 0 || x0 + BADGE > window.innerWidth || y0 + BADGE > window.innerHeight) return false
    const P = 4   // keep this much clear around the button
    // 1. Nothing of theirs measured within reach of the button
    for (const q of controls) {
      if (q.left < x0 + BADGE + P && q.right > x0 - P && q.top < y0 + BADGE + P && q.bottom > y0 - P) return false
    }
    // 2. Nothing else drawn there either (labels, headers, things outside the card):
    //    the button's centre and a ring around it
    const probes = [[x0 + BADGE / 2, y0 + BADGE / 2], [x0 - P, y0 - P], [x0 + BADGE + P, y0 - P], [x0 - P, y0 + BADGE + P], [x0 + BADGE + P, y0 + BADGE + P],
      [x0 + BADGE / 2, y0 - P], [x0 + BADGE / 2, y0 + BADGE + P], [x0 - P, y0 + BADGE / 2], [x0 + BADGE + P, y0 + BADGE / 2]]
    for (const [px, py] of probes) {
      for (const e of document.elementsFromPoint(Math.max(0, px), Math.max(0, py))) {
        if (isOurs(e)) continue
        if (e === el || e.contains(el) || el.contains(e)) break   // reached the media: nothing on top
        if (isCardLayer(e, r)) continue                       // an empty layer over the card
        if (SITE_RULES[SITE]?.partOfCard?.(e)) continue        // the site's own hover preview
        if (!drawsOver(e, el, r)) continue                    // an invisible wrapper, a faint gradient
        return false                                          // a button, label, header… sits here
      }
    }
    return true
  }

  // Does the site draw something of its own here — a control, an icon or picture, a
  // label, a solid panel? Transparent wrappers and soft gradients don't count.
  function drawsOver(e, media, mediaRect) {
    const control = e.closest(CONTROL_SEL)
    if (control && !control.contains(media) && !isCardLayer(control, mediaRect)) return true
    if (e.tagName === 'IMG' || e.tagName === 'VIDEO' || e.tagName === 'CANVAS' || e.closest('svg')) return true
    if ([...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return true
    const cs = getComputedStyle(e)
    if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false
    const rgba = cs.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1].split(',')
    const alpha = !rgba ? 0 : rgba.length < 4 ? 1 : parseFloat(rgba[3])
    return alpha >= 0.5
  }

  // Put the logo button at (logoLeft, logoTop). Anchored on the side the options
  // open from, so the logo stays put while the pill grows.
  function placeLogo(badge, logoLeft, logoTop) {
    if (badge._expandRight) {
      Object.assign(badge.style, { position: 'fixed', left: `${logoLeft}px`, top: `${logoTop}px`, right: 'auto', bottom: 'auto' })
    } else {
      Object.assign(badge.style, { position: 'fixed', right: `${window.innerWidth - logoLeft - BADGE}px`, top: `${logoTop}px`, left: 'auto', bottom: 'auto' })
    }
  }

  // Sites draw their own hover buttons after the pointer arrives (Pinterest), so keep
  // looking while the button is up and move out of their way — or leave if there's
  // no room any more.
  function watchSpot(badge, el) {
    const timer = setInterval(() => {
      if (currentBadge !== badge) { clearInterval(timer); return }
      if (!el.isConnected || !areaOf(el)) { clearInterval(timer); removeBadge(); return }
      // Follow the media if the page moves or resizes it (YouTube cards, masonry grids)
      positionBadge(badge, el)
      // Even under the pointer: if their button appeared beneath ours, ours moves.
      if (badge._state || _dragActive) return
      if (spotIsFree(el, badge._spot)) return
      clearInterval(timer)
      removeBadge(true)
      showBadge(el)
    }, 200)
  }

  function positionBadge(badge, el) {
    if (_dragActive || !badge._spot) return  // don't fight the drag
    const rect = el.getBoundingClientRect()
    placeLogo(badge, rect.left + badge._spot.dx, rect.top + badge._spot.dy)
  }

  // ─── Badge DOM ───────────────────────────────────────────────────
  // expandRight: true  → [logo][options], pill grows rightward (use `left` CSS)
  //              false → [options][logo], pill grows leftward  (use `right` CSS)
  function createBadge(mediaEl, expandRight) {
    const wrap = document.createElement('div')
    wrap.className = 'qooti-badge'
    wrap._expandRight = expandRight

    const logoBtn = document.createElement('button')
    logoBtn.className = 'qooti-badge-logo-btn'
    logoBtn.title = t('save.button')
    const logo = document.createElement('span')
    logo.className = 'qooti-badge-logo'
    logo.innerHTML = icon('mark')
    logoBtn.appendChild(logo)

    const optionsWrap = document.createElement('div')
    optionsWrap.className = 'qooti-badge-options'
    const divider = document.createElement('span')
    divider.className = 'qooti-badge-divider'

    if (expandRight) wrap.append(logoBtn, divider, optionsWrap)
    else             wrap.append(optionsWrap, divider, logoBtn)

    return wrap
  }

  // ─── Pill expansion ───────────────────────────────────────────────
  function expandToPill(badge, mediaEl) {
    const optionsWrap = badge.querySelector('.qooti-badge-options')
    if (!optionsWrap || badge._state) return
    // Populate option buttons once (first hover only)
    if (!optionsWrap._populated) {
      optionsWrap._populated = true
      const opts = getYouTubeOptions(mediaEl)
      opts.forEach(opt => {
        const btn = document.createElement('button')
        btn.className = 'qooti-badge-opt'
        btn.setAttribute('aria-label', opt.label)
        btn.innerHTML = opt.icon
        // Instant label under the pill (the options strip clips its own overflow, so
        // the tooltip lives on the badge — see .qooti-badge[data-tip] in content.css).
        btn.addEventListener('mouseenter', () => { badge.dataset.tip = opt.label })
        btn.addEventListener('mouseleave', () => { delete badge.dataset.tip })
        btn.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation()
          if (!e.isTrusted) return
          if (opt.action) opt.action(badge)
          else handleSaveWithPayload(badge, opt.payload)
        })
        optionsWrap.appendChild(btn)
      })
      // Force reflow so the first transition starts from max-width: 0
      badge.getBoundingClientRect()
    }
    badge.classList.add('qooti-badge--pill')
  }

  function collapsePill(badge) {
    badge.classList.remove('qooti-badge--pill')
  }

  // ─── Show / hide badge ───────────────────────────────────────────
  function showBadge(el) {
    if (!kit) return                    // our look hasn't arrived yet
    if (isCurrentSiteBanned()) return   // no badge on blocked sites
    if (currentTarget === el) return
    // No free spot on the media → no button (right-click still saves it).
    const spot = pickSpot(el)
    if (!spot) return
    removeBadge(true)
    currentTarget = el
    // Expansion direction: left half of element → grow right; right half → grow left.
    // This ensures the logo is always the stationary anchor of the pill animation.
    const expandRight = spot.dx < el.getBoundingClientRect().width / 2
    const badge = createBadge(el, expandRight)
    badge._spot = spot
    positionBadge(badge, el)
    uiRoot().appendChild(badge)
    currentBadge = badge
    watchSpot(badge, el)

    // Pre-warm the service worker now so it's awake by the time the user clicks.
    // MV3 SWs are suspended after ~30s of inactivity; waking takes 1-2s, making
    // the first save feel sluggish. This no-op message wakes it while user hovers.
    safeSend({ action: 'wake' })

    const logoBtn = badge.querySelector('.qooti-badge-logo-btn')

    // ── Drag to reposition ──────────────────────────────────────────
    let _dragHappened = false

    if (usePill(el)) {
      // Circle at rest; expands to pill on hover, collapses when cursor leaves
      badge.addEventListener('mouseenter', () => expandToPill(badge, el))
      badge.addEventListener('mouseleave', () => { if (!_dragActive) collapsePill(badge) })
    } else {
      // Regular media: logo click saves directly (unless it was a drag)
      logoBtn.addEventListener('click', e => {
        if (_dragHappened) { _dragHappened = false; return }
        e.preventDefault(); e.stopPropagation()
        if (!e.isTrusted) return
        handleSave(el, badge)
      })
    }
    logoBtn.addEventListener('mousedown', ev => {
      if (ev.button !== 0 || !ev.isTrusted) return
      ev.preventDefault()
      const startX = ev.clientX
      const startY = ev.clientY
      // Anchor to the LOGO button, not the full badge — avoids drift when
      // the pill is expanded and the badge left edge is far from the logo.
      const logoBtnRect0 = logoBtn.getBoundingClientRect()
      const offX = ev.clientX - logoBtnRect0.left
      const offY = ev.clientY - logoBtnRect0.top
      _dragHappened = false

      const onMove = mv => {
        if (!_dragActive && Math.hypot(mv.clientX - startX, mv.clientY - startY) > 5) {
          _dragActive   = true
          _dragHappened = true
          badge.style.transition = 'none'
          stopCursorWatcher()
        }
        if (_dragActive) {
          const elRect  = el.getBoundingClientRect()
          const G       = 4
          const logoLeft = Math.max(elRect.left + G, Math.min(mv.clientX - offX, elRect.right  - 32 - G))
          const logoTop  = Math.max(elRect.top  + G, Math.min(mv.clientY - offY, elRect.bottom - 32 - G))
          if (badge._expandRight) {
            badge.style.left  = `${logoLeft}px`
            badge.style.right = 'auto'
          } else {
            badge.style.right = `${window.innerWidth - logoLeft - 32}px`
            badge.style.left  = 'auto'
          }
          badge.style.top    = `${logoTop}px`
          badge.style.bottom = 'auto'
        }
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true)
        document.removeEventListener('mouseup',   onUp,   true)
        if (_dragActive) {
          _dragActive            = false
          badge.style.transition = ''
          const elRect = el.getBoundingClientRect()
          if (elRect.width > 0 && elRect.height > 0) {
            // Use logo button's actual position as the anchor — not the badge's
            // left edge, which shifts when the pill is expanded during drag.
            const lr     = logoBtn.getBoundingClientRect()
            const ratioX = (lr.left - elRect.left) / elRect.width
            const ratioY = (lr.top  - elRect.top)  / elRect.height
            customBadgePos = { ratioX, ratioY }
            badge._spot = { dx: lr.left - elRect.left, dy: lr.top - elRect.top }
            safeSend({ action: 'set-position', pos: customBadgePos })
            const nowExpandRight = ratioX < 0.5
            badge._expandRight = nowExpandRight
            if (nowExpandRight) {
              badge.style.left  = `${lr.left}px`
              badge.style.right = 'auto'
            } else {
              badge.style.right = `${window.innerWidth - lr.right}px`
              badge.style.left  = 'auto'
            }
          }
          startCursorWatcher(el)
        }
      }

      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup',   onUp,   true)
    })

    startCursorWatcher(el)
  }

  function startCursorWatcher(mediaEl) {
    stopCursorWatcher()
    cursorWatcher = e => {
      const { clientX: x, clientY: y } = e
      if (hitTest(x, y, mediaEl)) return
      if (currentBadge && hitTest(x, y, currentBadge)) return
      stopCursorWatcher()
      removeBadge()
    }
    document.addEventListener('mousemove', cursorWatcher, { passive: true })
  }

  function stopCursorWatcher() {
    if (!cursorWatcher) return
    document.removeEventListener('mousemove', cursorWatcher)
    cursorWatcher = null
  }

  function hitTest(x, y, el) {
    const r = el.getBoundingClientRect()
    const P = 6
    return x >= r.left - P && x <= r.right + P && y >= r.top - P && y <= r.bottom + P
  }

  function removeBadge(immediate = false) {
    stopCursorWatcher()
    if (!currentBadge) return
    if (immediate) {
      currentBadge.remove()
    } else {
      currentBadge.classList.add('qooti-badge--hide')
      const el = currentBadge
      setTimeout(() => el.remove(), 180)
    }
    currentBadge = null
    currentTarget = null
  }

  // ─── Save flow ───────────────────────────────────────────────────
  // Pick the largest candidate the browser knows about for an <img>. `currentSrc`
  // is only the one chosen for the current viewport/DPR — often not the biggest in
  // the `srcset`. The app then applies CDN-specific hi-res rewriting (Pinterest →
  // /originals/, X → name=orig, …) with a safe fallback on top of this URL.
  function largestImageSrc(el) {
    const abs = (u) => { try { return new URL(u, location.href).href } catch { return u } }
    let best = el.currentSrc || el.src || ''
    let bestW = 0
    // The <img>'s own srcset plus any <picture><source srcset> around it (Behance).
    const sets = [el.getAttribute && el.getAttribute('srcset')]
    if (el.parentElement?.tagName === 'PICTURE') {
      for (const s of el.parentElement.querySelectorAll('source[srcset]')) sets.push(s.getAttribute('srcset'))
    }
    for (const ss of sets) {
      if (!ss) continue
      for (const part of ss.split(',')) {
        const sp = part.trim().split(/\s+/)
        const u = sp[0], d = sp[1]
        if (!u || u.startsWith('data:')) continue
        const w = d && d.endsWith('w') ? parseInt(d, 10)
                : d && d.endsWith('x') ? Math.round(parseFloat(d) * 1000)
                : 1
        if (w >= bestW) { bestW = w; best = abs(u) }
      }
    }
    return (best && !best.startsWith('data:')) ? best : (el.src || '')
  }

  function getMediaPayload(el) {
    const pageUrl  = location.href
    const platform = detectPlatform(pageUrl)
    const isVideo  = el.tagName === 'VIDEO'
    const url = isVideo
      ? (el.src && !el.src.startsWith('blob:') ? el.src : pageUrl)
      : (() => { const b = largestImageSrc(el); return (b && !b.startsWith('blob:')) ? b : pageUrl })()
    const payload = {
      url, page_url: pageUrl, title: document.title,
      type: isVideo ? 'video' : 'image',
      source_platform: platform,
      thumbnail_url: isVideo && el.poster ? el.poster : undefined,
      width:  el.naturalWidth  || el.videoWidth  || el.offsetWidth  || null,
      height: el.naturalHeight || el.videoHeight || el.offsetHeight || null,
    }
    let site = {}
    try { site = SITE_RULES[SITE]?.payload?.(el) ?? {} } catch {}
    return { ...payload, ...site }
  }

  async function handleSave(mediaEl, badge) {
    await handleSaveWithPayload(badge, async () => getMediaPayload(mediaEl))
  }

  // Every state keeps the same surface; only the icon and the word change.
  // Saved keeps the qooti mark (the toast / picker says what happened) and fades
  // after 1.5 s; an error stays until hover ends.
  const BADGE_STATES = {
    saving: { icon: 'spinner', label: '' },
    done:   { icon: null,      label: '' },
    error:  { icon: 'warning', label: 'save.error' },
  }

  function setBadgeState(badge, state) {
    if (!badge) return
    badge.classList.remove('qooti-badge--saving', 'qooti-badge--done', 'qooti-badge--error', 'qooti-badge--pill')
    delete badge.dataset.tip
    badge.querySelector('.qooti-badge-label')?.remove()
    if (!state) {   // back to the plain button
      delete badge._state
      badge.querySelector('.qooti-badge-logo').innerHTML = icon('mark')
      return
    }
    const def = BADGE_STATES[state]
    badge._state = state
    badge.querySelector('.qooti-badge-logo').innerHTML = icon(def.icon ?? 'mark')
    badge.classList.add(`qooti-badge--${state}`)
    if (def.label) {
      const label = document.createElement('span')
      label.className = 'qooti-badge-label'
      label.textContent = t(def.label)
      badge.querySelector('.qooti-badge-logo-btn').after(label)
    }
    if (state === 'done') setTimeout(() => { if (currentBadge === badge) removeBadge() }, 1500)
  }

  // What the picker shows on top: the saved picture, its title and site.
  function previewOf(payload) {
    let source = ''
    try { source = new URL(payload?.page_url || location.href).hostname.replace(/^www\./, '') } catch {}
    const image = payload?.data_url || (payload?.type === 'image' ? payload.url : null) || payload?.thumbnail_url || null
    return { image, title: payload?.title || document.title, source }
  }

  // `badge` is null for right-click saves (no on-page button involved).
  async function handleSaveWithPayload(badge, getPayload) {
    const setBadge = state => setBadgeState(badge, state)
    let preview = null
    let payload = null
    setBadge('saving')
    try {
      // Pre-flight: fast reachability check resolves in ~5 ms (ECONNREFUSED) or
      // ≤400 ms worst-case. qooti closed: the link waits for it instead.
      const running = await checkRunning()
      if (!running) {
        payload = await getPayload()
        await keepForLater(badge, payload)
        return
      }
      payload = await getPayload()
      preview = previewOf(payload)
      const result  = await sendSave(payload)
      setBadge('done')
      if (result.already_exists) {
        showAlreadyExistsToast(result.inspiration_id)
        return
      }
      if (result.queued) {
        showMessage({
          tone: 'info',
          title: t('later.title'),
          action: upgradeAction(),
          message: t('code.limit'),
          duration: 9000,
        })
        return
      }
      // For real downloads (not instant frame captures) show a progress toast;
      // the collection picker will appear once the download finishes.
      if (result.ext_id && !result.is_frame) {
        showDownloadToast(result.ext_id, result.collections, result.inspiration_id, preview, result)
      } else if (showPicker && result.collections?.length) {
        showCollectionPicker(result.collections, result.inspiration_id, preview)
      }
    } catch (err) {
      // qooti closed between the check and the save: keep the link all the same
      if (err.kind === 'offline' && payload) { await keepForLater(badge, payload); return }
      const pairing = err.kind === 'pairing' || err.kind === 'pairing-denied'
      // Not connected yet isn't a failed save: the button stays as it was, the toast explains
      setBadge(pairing ? null : 'error')
      if (err.kind === 'offline') showNotRunning()
      else if (pairing) showPairingMessage(err)
      else showMessage({ title: t('fail.title'), message: err.message || t('fail.retry') })
    }
  }

  // qooti isn't running: the link waits in the extension, and qooti asks what to
  // download from it when it opens. Only if even that fails, "qooti isn't open".
  async function keepForLater(badge, payload) {
    const res = await new Promise(resolve => safeSend({ action: 'queue-save', payload }, resolve))
    if (res?.ok) {
      setBadgeState(badge, 'done')
      showMessage({
        tone: 'info',
        title: t('queue.title'),
        message: t('queue.msg'),
        action: { label: t('common.open_qooti'), onClick: openApp },
        duration: 8000,
      })
    } else {
      setBadgeState(badge, 'error')
      showNotRunning()
    }
  }

  // ─── Screenshot capture + confirm toast ──────────────────────────
  async function screenshotFrame(videoEl, badge) {
    setBadgeState(badge, 'saving')
    try {
      const { blob, dataUrl } = await captureFrameAsPng(videoEl)
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]) } catch {}
      setBadgeState(badge, 'done')
      showScreenshotToast(dataUrl)
    } catch {
      setBadgeState(badge, 'error')
      showMessage({ title: t('frame.fail.title'), message: t('frame.fail.msg') })
    }
  }

  // ─── Download progress toast ─────────────────────────────────────
  let _dlToast = null

  // `save` is what saving answered: `signin` 'off' when this site's videos may need a
  // sign-in the user hasn't let qooti use.
  function showDownloadToast(extId, collections, inspirationId, preview, save = {}) {
    if (_dlToast) { _dlToast.remove(); _dlToast = null }

    const toast = document.createElement('div')
    toast.className = 'qooti-toast qooti-toast--progress'
    toast.setAttribute('role', 'status')
    toast.innerHTML = `
      ${toastMark()}
      <div class="qooti-toast-body">
        <div class="qooti-toast-top">
          <span class="qooti-toast-title"></span>
          <span class="qooti-toast-pct"></span>
        </div>
        <div class="qooti-toast-track">
          <div class="qooti-toast-fill qooti-toast-fill--pending"></div>
        </div>
      </div>
      <div class="qooti-toast-actions">
        <button class="qooti-icon-btn qooti-toast-dl-hide">${ico('chevron-up')}</button>
        <button class="qooti-icon-btn qooti-toast-dl-cancel">${ico('close')}</button>
      </div>
    `
    toast.querySelector('.qooti-toast-title').textContent = t('dl.ready')
    for (const [sel, key] of [['.qooti-toast-dl-hide', 'dl.hide'], ['.qooti-toast-dl-cancel', 'dl.cancel']]) {
      toast.querySelector(sel).title = t(key)
      toast.querySelector(sel).setAttribute('aria-label', t(key))
    }
    useFont('mono', FONT_MONO)

    const titleEl = toast.querySelector('.qooti-toast-title')
    const pctEl   = toast.querySelector('.qooti-toast-pct')
    const fillEl  = toast.querySelector('.qooti-toast-fill')

    let done      = false
    let pollCount = 0
    // Long videos can legitimately take a while; qooti's own watchdog ends stuck
    // downloads, this only stops watching (≈ 30 min) — never reports a false failure.
    const MAX_POLLS = 3600

    toast.querySelector('.qooti-toast-dl-hide').addEventListener('click', real(() => {
      done = true
      dismissDlToast()
    }))

    toast.querySelector('.qooti-toast-dl-cancel').addEventListener('click', real(() => {
      done = true
      safeSend({ action: 'cancel-download', ext_id: extId })
      dismissDlToast()
    }))

    uiRoot().appendChild(toast)
    _dlToast = toast
    requestAnimationFrame(() => toast.classList.add('qooti-toast--in'))

    // Real steps reported by qooti (the stage label arrives in `speed` while pct is 0).
    const STAGES = [
      [/preparing youtube/i,  'stage.youtube_once'],
      [/setting up youtube/i, 'stage.youtube'],
      [/reading/i,            'stage.reading'],
      [/unlocking/i,          'stage.unlocking'],
      [/starting/i,           'stage.starting'],
      [/finishing/i,          'stage.finishing'],
      [/720p/i,               'stage.lower'],
      [/retrying/i,           'stage.retrying'],
    ]
    const stageText = label => { const key = STAGES.find(([re]) => re.test(label || ''))?.[1]; return key ? t(key) : null }
    const subEl = document.createElement('span')
    subEl.className = 'qooti-toast-sub'
    toast.querySelector('.qooti-toast-body').appendChild(subEl)

    let lastTitle = '', sameSince = Date.now()
    const setTitle = text => {
      if (text !== lastTitle) { lastTitle = text; sameSince = Date.now(); subEl.textContent = '' }
      titleEl.textContent = text
      // Honest reassurance instead of fake progress when a step takes a while.
      if (Date.now() - sameSince > 20000 && !subEl.textContent) subEl.textContent = t('dl.slow')
    }

    ;(async () => {
      let misses = 0
      while (!done) {
        await new Promise(r => setTimeout(r, 500))
        if (!_dlToast || done) break
        const prog = await new Promise(r => safeSend({ action: 'get-progress', ext_id: extId }, r))
        if (!_dlToast || done) break
        if (!prog) {
          // qooti closed or the extension reloaded mid-download: say so once, calmly.
          if (++misses >= 6) {
            done = true
            setTitle(t('dl.lost.title'))
            subEl.textContent = t('dl.lost.msg')
            setTimeout(dismissDlToast, 5000)
          }
          continue
        }
        misses = 0
        pollCount++

        if (pollCount > MAX_POLLS) {
          done = true
          setTitle(t('dl.long.title'))
          subEl.textContent = t('dl.long.msg')
          setTimeout(dismissDlToast, 5000)
          break
        }

        if (prog.status === 'queued') {
          setTitle(t('dl.queued'))
          pctEl.textContent = ''

        } else if (prog.status === 'pending') {
          setTitle(t('dl.ready'))
          pctEl.textContent = ''

        } else if (prog.status === 'downloading') {
          const pct = Math.round(prog.pct * 100)
          if (pct > 0) {
            setTitle(t('dl.downloading'))
            pctEl.textContent   = `${pct}%`
            fillEl.classList.remove('qooti-toast-fill--pending')
            fillEl.style.width  = `${pct}%`
          } else {
            setTitle(stageText(prog.speed) ?? t('dl.ready'))
            pctEl.textContent   = ''
          }

        } else if (prog.status === 'finalizing') {
          fillEl.classList.remove('qooti-toast-fill--pending')
          fillEl.style.width  = '99%'
          setTitle(t('dl.adding'))
          pctEl.textContent   = ''

        } else if (prog.status === 'complete') {
          done = true
          const finalInspId = prog.inspiration_id
          // Picking a collection is the next step: open it straight away, next to
          // the toast (which stays a few seconds with View).
          if (showPicker && collections?.length) {
            showCollectionPicker(collections, finalInspId ?? inspirationId, preview)
          }
          // Done: full bar, View opens the item in qooti, × dismisses.
          toast.classList.add('qooti-toast--done')
          fillEl.classList.remove('qooti-toast-fill--pending')
          fillEl.style.width = '100%'
          setTitle(t('saved'))
          pctEl.textContent   = ''
          const actions = toast.querySelector('.qooti-toast-actions')
          actions.innerHTML = ''
          actions.style.gap = '6px'
          if (finalInspId) {
            const viewBtn = document.createElement('button')
            viewBtn.className   = 'qooti-btn qooti-btn--secondary'
            viewBtn.textContent = t('common.view')
            viewBtn.addEventListener('click', real(() => {
              safeSend({ action: 'open-item', inspiration_id: finalInspId })
              dismissDlToast()
            }))
            actions.appendChild(viewBtn)
          }
          const closeBtn = document.createElement('button')
          closeBtn.className = 'qooti-icon-btn'
          closeBtn.title = t('common.dismiss')
          closeBtn.setAttribute('aria-label', t('common.dismiss'))
          closeBtn.innerHTML = ico('close')
          closeBtn.addEventListener('click', real(dismissDlToast))
          actions.appendChild(closeBtn)
          // Stays while the pointer is on it and while the collection picker is open,
          // then a little longer — so View can be reached after picking a collection too.
          const closeThis = () => {
            if (_dlToast !== toast) return
            if (_pickerEl) { doneTimer = setTimeout(closeThis, 2000); return }
            dismissDlToast()
          }
          let doneTimer = setTimeout(closeThis, 8000)   // the picker's 6 s + 2 s
          toast.addEventListener('mouseenter', () => clearTimeout(doneTimer))
          toast.addEventListener('mouseleave', () => { doneTimer = setTimeout(closeThis, 2500) })

        } else if (prog.status === 'cancelled') {
          done = true
          dismissDlToast()

        } else if (prog.status === 'error') {
          done = true
          fillEl.classList.remove('qooti-toast-fill--pending')
          fillEl.classList.add('qooti-toast-fill--error')
          fillEl.style.width      = '100%'
          pctEl.textContent = ''
          const code = errorCode(prog)
          subEl.textContent = t('code.' + code)
          if (code === 'limit') {
            // The free daily limit: saved for midnight, and Pro is offered here too.
            setTitle(t('later.title'))
            const actions = toast.querySelector('.qooti-toast-actions')
            actions.innerHTML = ''
            const upgrade = upgradeAction()
            const up = document.createElement('button')
            up.className = 'qooti-btn qooti-btn--upgrade'
            up.textContent = upgrade.label
            up.addEventListener('click', real(() => { upgrade.onClick(); dismissDlToast() }))
            actions.appendChild(up)
            setTimeout(() => { if (_dlToast === toast) dismissDlToast() }, 9000)
          } else if (code === 'signin' && save.signin === 'off' && save.signin_site) {
            // It needed the sign-in the user hasn't shared: say where to allow it.
            dismissDlToast()
            showSigninNeeded(save.signin_site)
          } else {
            setTitle(t('fail.title'))
            setTimeout(dismissDlToast, 7000)
          }
        }
      }
    })()
  }

  // Why a download failed, as a code the page words in the user's language. qooti 1.2+
  // sends the code; older versions send English wording (1.0.6+) or raw downloader
  // text — recognised here, never shown as is.
  const ERROR_WORDS = [
    ['limit',              ['daily limit']],
    ['private_address',    ['own network', 'private_address']],
    ['youtube_setup',      ["couldn't set up youtube"]],
    ['not_video',          ["link isn't a video"]],
    ['timeout',            ['too long', 'timed out', 'timeout']],
    ['unavailable',        ['private, removed', 'private video', 'unavailable', 'removed']],
    ['age_bot',            ['age or bot', 'not a bot', 'confirm your age', 'age-restricted']],
    ['signin',             ['sign in', 'login', 'logged-in', 'cookies']],
    ['unsupported',        ["can't save from this link", 'unsupported url']],
    ['refused',            ['refused the download', 'http error 403', 'http error 429']],
    ['missing_downloader', ['downloader is missing']],
    ['nothing_found',      ['no video or image']],
    ['add_failed',         ["couldn't add it to your library"]],
    ['image_failed',       ["couldn't save this image"]],
    ['network',            ['connect', 'network']],
    ['generic',            ["couldn't save this"]],
  ]
  function errorCode(prog) {
    if (typeof prog?.code === 'string' && i18n.has('code.' + prog.code)) return prog.code
    const m = (typeof prog?.message === 'string' ? prog.message : '').toLowerCase()
    return ERROR_WORDS.find(([, words]) => words.some(w => m.includes(w)))?.[0] ?? 'unknown'
  }

  function dismissDlToast() {
    if (!_dlToast) return
    _dlToast.classList.remove('qooti-toast--in')
    const el = _dlToast; _dlToast = null
    setTimeout(() => el.remove(), 240)
  }

  function showAlreadyExistsToast(inspirationId) {
    if (_dlToast) { _dlToast.remove(); _dlToast = null }
    const toast = document.createElement('div')
    toast.className = 'qooti-toast'
    toast.setAttribute('role', 'status')
    toast.innerHTML = `
      ${toastMark()}
      <div class="qooti-toast-body">
        <span class="qooti-toast-title"></span>
      </div>
      <div class="qooti-toast-actions qooti-toast-actions--wide">
        ${inspirationId ? '<button class="qooti-btn qooti-btn--secondary qooti-toast-view"></button>' : ''}
        <button class="qooti-icon-btn qooti-toast-dismiss">${ico('close')}</button>
      </div>
    `
    toast.querySelector('.qooti-toast-title').textContent = t('already')
    const dismissBtn = toast.querySelector('.qooti-toast-dismiss')
    dismissBtn.title = t('common.dismiss')
    dismissBtn.setAttribute('aria-label', t('common.dismiss'))
    if (inspirationId) {
      toast.querySelector('.qooti-toast-view').textContent = t('common.view')
      toast.querySelector('.qooti-toast-view').addEventListener('click', real(() => {
        safeSend({ action: 'open-item', inspiration_id: inspirationId })
        dismissDlToast()
      }))
    }
    toast.querySelector('.qooti-toast-dismiss').addEventListener('click', real(dismissDlToast))
    uiRoot().appendChild(toast)
    _dlToast = toast
    requestAnimationFrame(() => toast.classList.add('qooti-toast--in'))
    setTimeout(dismissDlToast, 4500)
  }

  function showScreenshotToast(dataUrl) {
    if (_dlToast) { _dlToast.remove(); _dlToast = null }

    const toast = document.createElement('div')
    toast.className = 'qooti-toast'
    toast.setAttribute('role', 'status')
    toast.innerHTML = `
      ${toastMark()}
      <div class="qooti-toast-body">
        <span class="qooti-toast-title"></span>
        <span class="qooti-toast-msg"></span>
      </div>
      <div class="qooti-toast-actions">
        <button class="qooti-btn qooti-btn--muted qooti-toast-screenshot-no"></button>
        <button class="qooti-btn qooti-btn--primary qooti-toast-screenshot-yes"></button>
      </div>
    `
    toast.querySelector('.qooti-toast-title').textContent = t('shot.title')
    toast.querySelector('.qooti-toast-msg').textContent = t('shot.msg')
    toast.querySelector('.qooti-toast-screenshot-no').textContent = t('common.no')
    toast.querySelector('.qooti-toast-screenshot-yes').textContent = t('common.save')

    const titleEl = toast.querySelector('.qooti-toast-title')
    const rowEl   = toast.querySelector('.qooti-toast-actions')
    let dismissed = false
    let autoTimer

    const dismiss = () => {
      if (dismissed) return
      dismissed = true
      clearTimeout(autoTimer)
      dismissDlToast()
    }

    toast.querySelector('.qooti-toast-screenshot-no').addEventListener('click', real(dismiss))
    // Pause the auto-close while the pointer is on it.
    toast.addEventListener('mouseenter', () => clearTimeout(autoTimer))
    toast.addEventListener('mouseleave', () => { if (!dismissed) autoTimer = setTimeout(dismiss, 3000) })

    toast.querySelector('.qooti-toast-screenshot-yes').addEventListener('click', real(async () => {
      if (dismissed) return
      dismissed = true
      clearTimeout(autoTimer)
      const yesBtn = toast.querySelector('.qooti-toast-screenshot-yes')
      const noBtn  = toast.querySelector('.qooti-toast-screenshot-no')
      yesBtn.disabled = true
      noBtn.disabled  = true
      yesBtn.textContent = t('common.saving')
      const frame = {
        url: location.href, page_url: location.href, title: document.title,
        type: 'image', source_platform: 'youtube', data_url: dataUrl,
      }
      try {
        const running = await checkRunning()
        if (!running) {
          // qooti closed: the frame waits as a picture until it opens
          dismissDlToast()
          await keepForLater(null, frame)
          return
        }
        const result = await sendSave(frame)
        titleEl.textContent = result.already_exists ? t('already') : t('saved')
        rowEl.remove()
        toast.querySelector('.qooti-toast-msg')?.remove()
        setTimeout(dismissDlToast, 2000)
      } catch (err) {
        dismissDlToast()
        if (err.kind === 'offline') await keepForLater(null, frame)
        else if (err.kind === 'pairing' || err.kind === 'pairing-denied') showPairingMessage(err)
        else showMessage({ title: t('fail.title'), message: err.message || t('fail.retry') })
      }
    }))

    uiRoot().appendChild(toast)
    _dlToast = toast
    requestAnimationFrame(() => toast.classList.add('qooti-toast--in'))
    autoTimer = setTimeout(dismiss, 8000)
  }

  // Rejects with an Error whose message is user-facing (background.js sends a code).
  function sendSave(payload) {
    return new Promise((resolve, reject) => {
      if (!extensionAlive()) {
        const e = new Error(t('reload')); e.kind = 'failed'
        return reject(e)
      }
      safeSend({ action: 'save', payload }, res => {
        if (res?.ok) return resolve(res)
        const e = new Error(t('err.' + (res?.error ?? 'failed')))
        e.kind = res?.kind ?? 'failed'
        reject(e)
      })
    })
  }

  // Asks the SW to ping the desktop with a 400 ms timeout.
  // Returns false in ~5 ms when ECONNREFUSED (app not running).
  function checkRunning() {
    return new Promise(resolve => {
      if (!extensionAlive()) { resolve(true); return }   // let sendSave explain
      safeSend({ action: 'check-running' }, res => resolve(res?.running ?? false))
    })
  }

  // ─── Collection picker ───────────────────────────────────────────
  let _pickerEl    = null
  let _pickerTimer = null

  function showCollectionPicker(collections, inspirationId, preview = null) {
    dismissPicker()
    const DURATION = 6000
    let remaining  = DURATION
    let lastTick   = Date.now()

    const picker = document.createElement('div')
    picker.className = 'qooti-picker'
    picker.setAttribute('role', 'dialog')
    picker.setAttribute('aria-label', t('saved'))
    picker.innerHTML = `
      ${preview?.image ? `
      <div class="qooti-picker-preview-wrap">
        <div class="qooti-picker-preview">
          <img alt="" referrerpolicy="no-referrer" />
          <div class="qooti-picker-meta">
            <span class="qooti-picker-meta-title"></span>
            <span class="qooti-picker-meta-src"></span>
          </div>
        </div>
      </div>` : ''}
      <div class="qooti-picker-head">
        <span class="qooti-picker-check">${icon('check-circle')}</span>
        <span class="qooti-picker-title"></span>
        <button class="qooti-icon-btn qooti-picker-close">${ico('close')}</button>
      </div>
      <span class="qooti-picker-sub"></span>
      <div class="qooti-picker-list"></div>
      <div class="qooti-picker-bar"></div>
    `
    picker.querySelector('.qooti-picker-title').textContent = t('saved')
    picker.querySelector('.qooti-picker-sub').textContent = t('picker.sub')
    picker.querySelector('.qooti-picker-close').title = t('common.close')
    picker.querySelector('.qooti-picker-close').setAttribute('aria-label', t('common.close'))

    if (preview?.image) {
      const img = picker.querySelector('.qooti-picker-preview img')
      img.addEventListener('error', () => img.remove())   // hotlink-protected → plain surface
      img.src = preview.image
      picker.querySelector('.qooti-picker-meta-title').textContent = preview.title || ''
      picker.querySelector('.qooti-picker-meta-src').textContent = preview.source || ''
    }

    // Collections that take new items first; locked ones (Free plan) after, greyed out.
    const list = picker.querySelector('.qooti-picker-list')
    const open = collections.filter(c => !c.locked), locked = collections.filter(c => c.locked)
    for (const col of [...open, ...locked]) list.appendChild(makeCollectionBtn(col, inspirationId))
    picker.querySelector('.qooti-picker-close').addEventListener('click', real(dismissPicker))

    // Pause auto-dismiss while hovered; resume on leave
    const bar = picker.querySelector('.qooti-picker-bar')
    bar.style.animationDuration = `${DURATION}ms`   // from script: strict pages block style="" in markup
    picker.addEventListener('mouseenter', () => {
      clearTimeout(_pickerTimer)
      remaining -= Date.now() - lastTick
      bar.style.animationPlayState = 'paused'
    })
    picker.addEventListener('mouseleave', () => {
      lastTick = Date.now()
      bar.style.animationPlayState = 'running'
      _pickerTimer = setTimeout(dismissPicker, Math.max(remaining, 800))
    })

    uiRoot().appendChild(picker)
    _pickerEl = picker
    requestAnimationFrame(() => picker.classList.add('qooti-picker--visible'))
    _pickerTimer = setTimeout(dismissPicker, DURATION)
  }

  function makeCollectionBtn(col, inspirationId) {
    const btn = document.createElement('button')
    btn.className = 'qooti-picker-btn'
    btn.innerHTML = `
      ${ico(col.locked ? 'lock' : 'folder')}
      <span class="qooti-picker-btn-label"></span>
    `
    btn.querySelector('.qooti-picker-btn-label').textContent = col.name
    if (col.locked) {
      // Free plan: shown so the list matches the app, but it can't take new items.
      btn.classList.add('qooti-picker-btn--locked')
      btn.disabled = true
      btn.title = t('picker.locked')
      btn.setAttribute('aria-label', t('picker.locked_aria', { name: col.name }))
      return btn
    }
    btn.addEventListener('click', real(() => {
      dismissPicker()
      if (col.id && inspirationId) addToCollection(col, inspirationId)
    }))
    return btn
  }

  // Add the saved item to a collection, then say where it went.
  function addToCollection(col, inspirationId) {
    safeSend({ action: 'add-to-collection', inspiration_id: inspirationId, collection_id: col.id }, res => {
      // This answer takes the place of the "Saved to qooti" toast.
      if (_dlToast?.classList.contains('qooti-toast--done')) dismissDlToast()
      if (res?.ok) {
        showMessage({ tone: 'info', title: t('col.added', { name: col.name }), duration: 3500 })
      } else if (res?.locked) {
        showMessage({ title: t('col.locked.title', { name: col.name }), message: t('col.locked.msg') })
      } else {
        showMessage({ title: t('col.fail.title', { name: col.name }), message: t('col.fail.msg') })
      }
    })
  }

  function dismissPicker() {
    clearTimeout(_pickerTimer)
    if (!_pickerEl) return
    _pickerEl.classList.remove('qooti-picker--visible')
    const el = _pickerEl; _pickerEl = null
    setTimeout(() => el.remove(), 240)
  }

  // ─── Messages from background (context-menu save) ────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'context-save') {
      let payload = msg.payload
      if (payload?.type === 'page') {
        // Not a video page: save the page's preview image, if it has one.
        const img = pagePreviewImage()
        if (!img) {
          showMessage({ tone: 'info', title: t('nothing.title'), message: t('nothing.msg') })
          sendResponse({ ok: true })
          return
        }
        payload = { ...payload, url: img, type: 'image' }
      }
      handleSaveWithPayload(null, async () => payload)
      sendResponse({ ok: true })
    }
  })

  // The picture a page shares as its preview (og/twitter image), made absolute.
  function pagePreviewImage() {
    const sel = 'meta[property="og:image:secure_url"], meta[property="og:image"], meta[name="twitter:image"], meta[name="twitter:image:src"]'
    for (const m of document.querySelectorAll(sel)) {
      const v = m.getAttribute('content')
      if (!v) continue
      try { return new URL(v, location.href).href } catch {}
    }
    return null
  }

  // ─── Right-click dismiss ─────────────────────────────────────────
  // Right-clicking a media element suppresses its hover badge for the rest of
  // the page session. The WeakSet is keyed by element and lives only in this
  // content-script instance, so the badge returns automatically on reload /
  // navigation. The native context menu is left untouched (no preventDefault).
  const suppressedMedia = new WeakSet()

  document.addEventListener('contextmenu', e => {
    const onBadge = isOurs(e.target)

    // Find the media under the cursor. The badge sits over the media's corner,
    // so look past our own overlay to the element behind it.
    let media = null
    for (const hit of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (isOurs(hit)) continue
      const el = hit.tagName === 'IMG' || hit.tagName === 'VIDEO' ? hit : mediaInside(hit, e.clientX, e.clientY)
      if (el && isValidMedia(el)) { media = el; break }
    }
    // Right-clicking the badge chip itself → fall back to the media it belongs to.
    if (!media && onBadge) media = currentTarget

    if (media) {
      suppressedMedia.add(media)
      if (currentTarget === media) removeBadge(true)  // hide any live badge now
    }

    // Swallow the browser's native context menu only when the click landed on
    // our badge — a right-click on the bare media still gets "Save image as…".
    if (onBadge) e.preventDefault()
  }, { capture: true })

  // ─── Media detection ─────────────────────────────────────────────
  // elementsFromPoint scans the full z-stack at the cursor position, so it
  // finds <video> and <img> elements even when an overlay div sits on top
  // and intercepts pointer events (Instagram reels, YouTube overlays, etc.).
  // The button appears once the pointer rests on the media for HOVER_DELAY,
  // never while the page scrolls.
  const HOVER_DELAY = 50
  const REST_RADIUS = 12      // px the pointer may drift and still count as resting
  let _rafPending = false
  let _pointer = null         // last pointer position
  let _pendingShow = null     // { el, x, y, timer }
  let _scrolling = false
  let _scrollEndTimer = null

  function cancelPendingShow() {
    if (!_pendingShow) return
    clearTimeout(_pendingShow.timer)
    _pendingShow = null
  }

  function scheduleShow(el, x, y) {
    if (_pendingShow && _pendingShow.el === el && Math.hypot(x - _pendingShow.x, y - _pendingShow.y) < REST_RADIUS) return
    cancelPendingShow()
    const pending = { el, x, y }
    pending.timer = setTimeout(() => {
      if (_pendingShow !== pending) return
      _pendingShow = null
      if (!_scrolling && !_dragActive) showBadge(el)
    }, HOVER_DELAY)
    _pendingShow = pending
  }

  // Some sites make the picture itself ignore the pointer (Behance covers), so it never
  // shows up under the cursor: look for it inside the card that does.
  function mediaInside(box, x, y) {
    if (box === document.body || box === document.documentElement) return null
    if (areaOf(box) > window.innerWidth * window.innerHeight * 0.6) return null
    for (const m of box.querySelectorAll('img, video')) {
      const r = m.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m
    }
    return null
  }

  function lookAt(x, y) {
    if (isCurrentSiteBanned() || _dragActive || _scrolling) return
    const els = document.elementsFromPoint(x, y)
    for (let i = 0; i < els.length; i++) {
      let el = els[i]
      // Stop if cursor is over our own injected badge / toast / picker
      if (isOurs(el)) { cancelPendingShow(); return }
      if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO' && i < 8) el = mediaInside(el, x, y) ?? el
      if ((el.tagName === 'IMG' || el.tagName === 'VIDEO') && isValidMedia(el)) {
        if (isCovered(els, i, el)) { cancelPendingShow(); return }
        const anchor = SITE === 'youtube' ? youTubeAnchor(el) : el
        const target = anchor !== el && isValidMedia(anchor) ? anchor : el
        if (suppressedMedia.has(target)) { cancelPendingShow(); return }  // right-click-dismissed this page load
        if (currentTarget && sameItem(target, currentTarget)) { cancelPendingShow(); return }
        scheduleShow(target, x, y)
        return
      }
    }
    cancelPendingShow()
  }

  document.addEventListener('mousemove', e => {
    _pointer = { x: e.clientX, y: e.clientY }
    if (_rafPending) return
    _rafPending = true
    requestAnimationFrame(() => {
      _rafPending = false
      lookAt(_pointer.x, _pointer.y)
    })
  }, { passive: true })

  // Scrolling the page (or the box the media is in) hides the button; it comes
  // back for whatever is under the pointer once scrolling has stopped. Scrolling
  // elsewhere (a carousel ticking by) is ignored.
  document.addEventListener('scroll', e => {
    const t = e.target
    const relevant = t === document || t === document.documentElement || t === document.body
      || (currentTarget && t.contains?.(currentTarget))
      || (_pendingShow && t.contains?.(_pendingShow.el))
    if (!relevant || _dragActive) return
    _scrolling = true
    cancelPendingShow()
    if (currentBadge) removeBadge()
    clearTimeout(_scrollEndTimer)
    _scrollEndTimer = setTimeout(() => {
      _scrolling = false
      if (_pointer) lookAt(_pointer.x, _pointer.y)
    }, 250)
  }, { capture: true, passive: true })

  // ─── App→extension download delegation ───────────────────────────
  // The app queues a URL when yt-dlp fails due to missing auth cookies (e.g. Instagram).
  // Content scripts never go dormant, so this heartbeat reliably wakes the background
  // service worker to poll for pending work every 3 seconds.
  // Only the visible tab asks (it used to be every open tab, every 3 s), and it
  // stops for good once the extension is reloaded/updated under this page.
  const _pendingTimer = setInterval(() => {
    if (!extensionAlive()) { clearInterval(_pendingTimer); return }
    if (document.visibilityState !== 'visible') return
    safeSend({ action: 'check-pending' }, res => {
      if (res?.pending && res.signin === 'off' && res.site) showSigninNeeded(res.site)
    })
  }, 3000)
})()
