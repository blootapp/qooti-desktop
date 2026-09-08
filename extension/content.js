// qooti content script — badge, pill, picker, notifications
;(function () {
  if (window.__qooticInjected) return
  window.__qooticInjected = true

  const logoUrl = chrome.runtime.getURL('icons/logo-solo.png')

  // ─── Settings ────────────────────────────────────────────────────
  let badgePosition = 'top-left'
  let showPicker    = true
  // Sites where the qooti badge must never appear. Defaults applied until the
  // user edits the list in the popup (which writes to chrome.storage.sync).
  let bannedSites   = ['flaticon.com', 'bloot.app']

  chrome.storage.sync.get(['badgePosition', 'showPicker', 'bannedSites'], res => {
    if (res.badgePosition)       badgePosition = res.badgePosition
    if (res.showPicker != null)  showPicker    = res.showPicker
    if (Array.isArray(res.bannedSites)) bannedSites = res.bannedSites
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return
    if (changes.badgePosition) badgePosition = changes.badgePosition.newValue
    if (changes.showPicker)    showPicker    = changes.showPicker.newValue
    if (changes.bannedSites)   bannedSites   = changes.bannedSites.newValue ?? []
  })

  // ─── Per-site badge position (persisted per hostname) ───────────
  const _hostname = location.hostname.replace(/^www\./, '')
  const _posKey   = `qooti_bp_${_hostname}`
  let customBadgePos = null  // { ratioX, ratioY } — fraction within media element

  chrome.storage.local.get([_posKey], res => {
    customBadgePos = res[_posKey] ?? null
  })

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

  function showNotification(message) {
    if (_toastEl) { clearTimeout(_toastTimer); _toastEl.remove(); _toastEl = null }

    const toast = document.createElement('div')
    toast.className = 'qooti-toast'
    toast.setAttribute('data-qooti', '1')
    toast.innerHTML = `
      <img class="qooti-toast-logo" src="${logoUrl}" alt="qooti" />
      <div class="qooti-toast-body">
        <span class="qooti-toast-title">qooti is not running</span>
        <span class="qooti-toast-msg">${message}</span>
      </div>
      <svg class="qooti-toast-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    `
    toast.querySelector('.qooti-toast-close').addEventListener('click', () => dismissToast())
    document.body.appendChild(toast)
    _toastEl = toast
    requestAnimationFrame(() => toast.classList.add('qooti-toast--in'))
    _toastTimer = setTimeout(dismissToast, 5000)
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

  function isYouTube() {
    return location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be')
  }

  function getYouTubeVideoId() {
    try { return new URL(location.href).searchParams.get('v') || null } catch { return null }
  }

  // Returns true when this media element should show a multi-option pill
  function usePill(el) {
    return isYouTube() && el.tagName === 'VIDEO'
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

  // ─── Pill option definitions ──────────────────────────────────────
  const ICONS = {
    video:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
    image:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    link:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
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

  function getYouTubeOptions(videoEl) {
    // On the player page location.href is already the watch URL — use it directly.
    // On homepage/feed the watch URL comes from the card the video preview belongs to.
    const watchUrl = getYouTubeVideoId()
      ? location.href                                         // player page
      : getWatchUrlFromCard(getYouTubeCard(videoEl))         // homepage / feed

    const videoId = watchUrl
      ? new URL(watchUrl).searchParams.get('v')
      : null

    // Thumbnail: always the highest-res YouTube thumbnail for this video
    const thumbUrl = videoId
      ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
      : (videoEl.poster || null)

    // Title: pull from the card when available, fall back to page title
    let title = document.title
    try {
      const card    = getYouTubeCard(videoEl)
      const titleEl = card?.querySelector('#video-title, yt-formatted-string#video-title, .ytd-video-meta-block .title')
      if (titleEl?.textContent?.trim()) title = titleEl.textContent.trim()
    } catch {}

    const opts = []
    if (watchUrl) {
      opts.push({
        icon: ICONS.video, label: 'Video',
        payload: async () => ({ url: watchUrl, page_url: location.href, title, type: 'video', source_platform: 'youtube' })
      })
    }
    if (thumbUrl) {
      opts.push({
        icon: ICONS.image, label: 'Thumbnail',
        payload: async () => ({ url: thumbUrl, page_url: location.href, title, type: 'image', source_platform: 'youtube' })
      })
    }
    if (watchUrl) {
      opts.push({
        icon: ICONS.link, label: 'Link',
        payload: async () => ({ url: watchUrl, page_url: location.href, title, type: 'link', source_platform: 'youtube' })
      })
    }
    if (videoId) {
      opts.push({
        icon: ICONS.camera, label: 'Frame',
        action: badge => screenshotFrame(videoEl, badge)
      })
    }
    return opts
  }

  // ─── Badge state ──────────────────────────────────────────────────
  let currentBadge  = null
  let currentTarget = null
  let cursorWatcher = null
  let scrollWatcher = null
  let _dragActive   = false

  const MIN_SIZE = 100

  function isValidMedia(el) {
    if (el.tagName === 'VIDEO') return true
    if (el.tagName === 'IMG') {
      const w = el.naturalWidth  || el.offsetWidth
      const h = el.naturalHeight || el.offsetHeight
      return w >= MIN_SIZE && h >= MIN_SIZE
    }
    return false
  }

  // ─── Badge positioning ────────────────────────────────────────────
  function isRightAnchored() {
    return badgePosition === 'top-right' || badgePosition === 'bottom-right'
  }

  function getBadgeOffset() {
    const G = 8
    switch (badgePosition) {
      case 'top-right':    return { top: G, right: G,    bottom: 'auto', left: 'auto' }
      case 'bottom-left':  return { top: 'auto', right: 'auto', bottom: G, left: G }
      case 'bottom-right': return { top: 'auto', right: G,    bottom: G, left: 'auto' }
      default:             return { top: G, right: 'auto', bottom: 'auto', left: G }
    }
  }

  function positionBadge(badge, el) {
    if (_dragActive) return  // don't fight the drag
    const rect        = el.getBoundingClientRect()
    const expandRight = badge._expandRight
    if (customBadgePos && rect.width > 0 && rect.height > 0) {
      // ratioX/Y are the logo button's position within the element.
      // Clamp to 32px (logo size) so the logo itself never leaves the frame.
      const G        = 4
      const logoLeft = Math.max(rect.left + G, Math.min(rect.left + rect.width  * customBadgePos.ratioX, rect.right  - 32 - G))
      const logoTop  = Math.max(rect.top  + G, Math.min(rect.top  + rect.height * customBadgePos.ratioY, rect.bottom - 32 - G))
      if (expandRight) {
        // Logo is the left edge of the badge → use left CSS
        Object.assign(badge.style, { position: 'fixed', left: `${logoLeft}px`, top: `${logoTop}px`, right: 'auto', bottom: 'auto' })
      } else {
        // Logo is the right edge of the badge → anchor via right CSS so logo stays fixed during pill expansion
        Object.assign(badge.style, { position: 'fixed', right: `${window.innerWidth - logoLeft - 32}px`, top: `${logoTop}px`, left: 'auto', bottom: 'auto' })
      }
    } else {
      const off = getBadgeOffset()
      Object.assign(badge.style, {
        position: 'fixed',
        top:    off.top    !== 'auto' ? `${rect.top    + off.top}px`                         : 'auto',
        bottom: off.bottom !== 'auto' ? `${window.innerHeight - rect.bottom + off.bottom}px` : 'auto',
        left:   off.left   !== 'auto' ? `${rect.left   + off.left}px`                        : 'auto',
        right:  off.right  !== 'auto' ? `${window.innerWidth  - rect.right  + off.right}px`  : 'auto',
      })
    }
  }

  // ─── Badge DOM ───────────────────────────────────────────────────
  // expandRight: true  → [logo][options], pill grows rightward (use `left` CSS)
  //              false → [options][logo], pill grows leftward  (use `right` CSS)
  function createBadge(mediaEl, expandRight) {
    const wrap = document.createElement('div')
    wrap.className = 'qooti-badge'
    wrap.setAttribute('data-qooti', '1')
    wrap._expandRight = expandRight

    const logoBtn = document.createElement('button')
    logoBtn.className = 'qooti-badge-logo-btn'
    logoBtn.title = 'Save to qooti'
    const logoImg = document.createElement('img')
    logoImg.src = logoUrl
    logoImg.className = 'qooti-badge-logo'
    logoBtn.appendChild(logoImg)

    const optionsWrap = document.createElement('div')
    optionsWrap.className = 'qooti-badge-options'

    if (expandRight) {
      wrap.appendChild(logoBtn)
      wrap.appendChild(optionsWrap)
    } else {
      wrap.appendChild(optionsWrap)
      wrap.appendChild(logoBtn)
    }

    return wrap
  }

  // ─── Pill expansion ───────────────────────────────────────────────
  function expandToPill(badge, mediaEl) {
    const optionsWrap = badge.querySelector('.qooti-badge-options')
    if (!optionsWrap) return
    // Populate option buttons once (first hover only)
    if (!optionsWrap._populated) {
      optionsWrap._populated = true
      const opts = getYouTubeOptions(mediaEl)
      opts.forEach(opt => {
        const btn = document.createElement('button')
        btn.className = 'qooti-badge-opt'
        btn.title = opt.label
        btn.innerHTML = opt.icon
        btn.addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation()
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
    if (isCurrentSiteBanned()) return   // no badge on blocked sites
    if (currentTarget === el) return
    removeBadge(true)
    currentTarget = el
    // Expansion direction: left half of element → grow right; right half → grow left.
    // This ensures the logo is always the stationary anchor of the pill animation.
    const expandRight = customBadgePos ? (customBadgePos.ratioX < 0.5) : !isRightAnchored()
    const badge = createBadge(el, expandRight)
    positionBadge(badge, el)
    document.body.appendChild(badge)
    currentBadge = badge

    // Pre-warm the service worker now so it's awake by the time the user clicks.
    // MV3 SWs are suspended after ~30s of inactivity; waking takes 1-2s, making
    // the first save feel sluggish. This no-op message wakes it while user hovers.
    chrome.runtime.sendMessage({ action: 'wake' }, () => { void chrome.runtime.lastError })

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
        handleSave(el, badge)
      })
    }
    logoBtn.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return
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
            chrome.storage.local.set({ [_posKey]: customBadgePos })
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
    startScrollWatcher(el)
  }

  function startScrollWatcher(mediaEl) {
    stopScrollWatcher()
    scrollWatcher = () => {
      if (!currentBadge) return
      const rect = mediaEl.getBoundingClientRect()
      // Dismiss if the element has scrolled fully out of the viewport
      if (rect.bottom < 0 || rect.top > window.innerHeight
          || rect.right < 0 || rect.left > window.innerWidth) {
        removeBadge()
        return
      }
      positionBadge(currentBadge, mediaEl)
    }
    document.addEventListener('scroll', scrollWatcher, { capture: true, passive: true })
  }

  function stopScrollWatcher() {
    if (!scrollWatcher) return
    document.removeEventListener('scroll', scrollWatcher, { capture: true })
    scrollWatcher = null
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
    stopScrollWatcher()
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
  function getMediaPayload(el) {
    const pageUrl  = location.href
    const platform = detectPlatform(pageUrl)
    const isVideo  = el.tagName === 'VIDEO'
    const url = isVideo
      ? (el.src && !el.src.startsWith('blob:') ? el.src : pageUrl)
      : (el.currentSrc || el.src || pageUrl)
    return {
      url, page_url: pageUrl, title: document.title,
      type: isVideo ? 'video' : 'image',
      source_platform: platform,
      width:  el.naturalWidth  || el.videoWidth  || el.offsetWidth  || null,
      height: el.naturalHeight || el.videoHeight || el.offsetHeight || null,
    }
  }

  async function handleSave(mediaEl, badge) {
    await handleSaveWithPayload(badge, async () => getMediaPayload(mediaEl))
  }

  async function handleSaveWithPayload(badge, getPayload) {
    badge.classList.add('qooti-badge--saving')
    try {
      // Pre-flight: fast reachability check resolves in ~5 ms (ECONNREFUSED) or
      // ≤300 ms worst-case — far better than the 2-3 s save timeout would give us.
      const running = await checkRunning()
      if (!running) {
        badge.classList.remove('qooti-badge--saving')
        badge.classList.add('qooti-badge--error')
        showNotification('Start qooti to save media from your browser.')
        setTimeout(() => removeBadge(), 1200)
        return
      }
      const payload = await getPayload()
      const result  = await sendSave(payload)
      badge.classList.remove('qooti-badge--saving')
      badge.classList.add('qooti-badge--done')
      setTimeout(() => removeBadge(), 900)
      if (result.already_exists) {
        showAlreadyExistsToast(result.inspiration_id)
        return
      }
      // For real downloads (not instant frame captures) show a progress toast;
      // the collection picker will appear once the download finishes.
      if (result.ext_id && !result.is_frame) {
        showDownloadToast(result.ext_id, result.collections, result.inspiration_id)
      } else if (showPicker && result.collections?.length) {
        showCollectionPicker(result.collections, result.inspiration_id)
      }
    } catch (err) {
      badge.classList.remove('qooti-badge--saving')
      badge.classList.add('qooti-badge--error')
      const isOffline = err.message?.toLowerCase().includes('not running')
        || err.message?.toLowerCase().includes('failed to fetch')
        || err.message?.toLowerCase().includes('networkerror')
      if (isOffline) {
        showNotification('Start qooti to save media from your browser.')
      }
      console.error('[qooti] save failed:', err.message)
      setTimeout(() => removeBadge(), 1200)
    }
  }

  // ─── Screenshot capture + confirm toast ──────────────────────────
  async function screenshotFrame(videoEl, badge) {
    badge.classList.add('qooti-badge--saving')
    try {
      const { blob, dataUrl } = await captureFrameAsPng(videoEl)
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]) } catch {}
      badge.classList.remove('qooti-badge--saving')
      badge.classList.add('qooti-badge--done')
      setTimeout(() => removeBadge(), 900)
      showScreenshotToast(dataUrl)
    } catch {
      badge.classList.remove('qooti-badge--saving')
      badge.classList.add('qooti-badge--error')
      setTimeout(() => removeBadge(), 1200)
    }
  }

  // ─── Download progress toast ─────────────────────────────────────
  let _dlToast = null

  function showDownloadToast(extId, collections, inspirationId) {
    if (_dlToast) { _dlToast.remove(); _dlToast = null }

    const toast = document.createElement('div')
    toast.className = 'qooti-toast qooti-toast--dl'
    toast.setAttribute('data-qooti', '1')
    toast.innerHTML = `
      <img class="qooti-toast-logo" src="${logoUrl}" alt="qooti" />
      <div class="qooti-toast-dl-content">
        <div class="qooti-toast-dl-top">
          <span class="qooti-toast-title">Fetching media info…</span>
          <span class="qooti-toast-pct"></span>
        </div>
        <div class="qooti-toast-track">
          <div class="qooti-toast-fill qooti-toast-fill--pending"></div>
        </div>
      </div>
      <div class="qooti-toast-dl-actions">
        <button class="qooti-toast-dl-close qooti-toast-dl-hide" title="Run in background">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="3" y1="8" x2="13" y2="8"/>
          </svg>
        </button>
        <button class="qooti-toast-dl-close qooti-toast-dl-cancel" title="Cancel download">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>
          </svg>
        </button>
      </div>
    `

    const titleEl = toast.querySelector('.qooti-toast-title')
    const pctEl   = toast.querySelector('.qooti-toast-pct')
    const fillEl  = toast.querySelector('.qooti-toast-fill')

    let done      = false
    let pollCount = 0
    const MAX_POLLS = 400  // 400 × 450 ms ≈ 3 min client-side hard stop

    toast.querySelector('.qooti-toast-dl-hide').addEventListener('click', () => {
      done = true
      dismissDlToast()
    })

    toast.querySelector('.qooti-toast-dl-cancel').addEventListener('click', () => {
      done = true
      chrome.runtime.sendMessage({ action: 'cancel-download', ext_id: extId })
      dismissDlToast()
    })

    document.body.appendChild(toast)
    _dlToast = toast
    requestAnimationFrame(() => toast.classList.add('qooti-toast--in'))

    const PENDING_MSGS = [
      'Fetching media info…',
      'Analyzing the URL…',
      'Resolving source…',
      'Checking availability…',
      'Talking to the server…',
      'Almost ready to go…',
    ]
    const STARTING_MSGS = [
      'Connecting to source…',
      'Negotiating stream…',
      'Spinning up the download…',
      'Locking in quality…',
      'Hold tight…',
    ]

    ;(async () => {
      while (!done) {
        await new Promise(r => setTimeout(r, 450))
        if (!_dlToast || done) break
        const prog = await new Promise(r =>
          chrome.runtime.sendMessage({ action: 'get-progress', ext_id: extId }, r)
        ).catch(() => null)
        if (!prog || !_dlToast) break
        pollCount++

        if (pollCount > MAX_POLLS) {
          fillEl.classList.remove('qooti-toast-fill--pending')
          fillEl.style.width      = '100%'
          fillEl.style.background = 'rgba(239,68,68,0.75)'
          titleEl.textContent     = 'Download timed out'
          pctEl.textContent       = ''
          setTimeout(dismissDlToast, 4000)
          break
        }

        if (prog.status === 'queued') {
          titleEl.textContent = 'Waiting in queue…'
          pctEl.textContent   = ''

        } else if (prog.status === 'pending') {
          titleEl.textContent = PENDING_MSGS[Math.floor(pollCount / 2) % PENDING_MSGS.length]
          pctEl.textContent   = ''

        } else if (prog.status === 'downloading') {
          const pct = Math.round(prog.pct * 100)
          if (pct > 0) {
            titleEl.textContent = 'Downloading…'
            pctEl.textContent   = `${pct}%`
            fillEl.classList.remove('qooti-toast-fill--pending')
            fillEl.style.width  = `${pct}%`
          } else {
            titleEl.textContent = STARTING_MSGS[Math.floor(pollCount / 2) % STARTING_MSGS.length]
            pctEl.textContent   = ''
          }

        } else if (prog.status === 'finalizing') {
          fillEl.style.width  = '99%'
          titleEl.textContent = 'Saving to library…'
          pctEl.textContent   = ''

        } else if (prog.status === 'complete') {
          done = true
          fillEl.classList.remove('qooti-toast-fill--pending')
          fillEl.style.width = '100%'
          fillEl.style.background = 'rgba(255,255,255,0.9)'
          titleEl.textContent = 'Saved to qooti'
          pctEl.textContent   = ''
          const finalInspId = prog.inspiration_id
          if (finalInspId) {
            const viewBtn = document.createElement('button')
            viewBtn.className   = 'qooti-toast-view-btn'
            viewBtn.textContent = 'View'
            viewBtn.addEventListener('click', () => {
              chrome.runtime.sendMessage({ action: 'open-item', inspiration_id: finalInspId })
              dismissDlToast()
            })
            toast.querySelector('.qooti-toast-dl-top').appendChild(viewBtn)
          }
          setTimeout(() => {
            dismissDlToast()
            if (showPicker && collections?.length) {
              showCollectionPicker(collections, finalInspId ?? inspirationId)
            }
          }, finalInspId ? 2500 : 1400)

        } else if (prog.status === 'error') {
          done = true
          fillEl.classList.remove('qooti-toast-fill--pending')
          fillEl.style.width      = '100%'
          fillEl.style.background = 'rgba(239,68,68,0.75)'
          titleEl.textContent = 'Download failed'
          const errMsg = typeof prog.message === 'string' && prog.message.trim()
            ? prog.message.trim().replace(/^ERROR:\s*/i, '').slice(0, 80)
            : ''
          pctEl.textContent = errMsg
          setTimeout(dismissDlToast, errMsg ? 6000 : 4000)
        }
      }
    })()
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
    toast.className = 'qooti-toast qooti-toast--dl'
    toast.setAttribute('data-qooti', '1')
    toast.innerHTML = `
      <img class="qooti-toast-logo" src="${logoUrl}" alt="qooti" />
      <div class="qooti-toast-dl-content">
        <div class="qooti-toast-dl-top">
          <span class="qooti-toast-title">Already in your library</span>
          ${inspirationId ? '<button class="qooti-toast-view-btn">View</button>' : ''}
        </div>
      </div>
      <button class="qooti-toast-dl-close" title="Dismiss">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>
        </svg>
      </button>
    `
    if (inspirationId) {
      toast.querySelector('.qooti-toast-view-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'open-item', inspiration_id: inspirationId })
        dismissDlToast()
      })
    }
    toast.querySelector('.qooti-toast-dl-close').addEventListener('click', dismissDlToast)
    document.body.appendChild(toast)
    _dlToast = toast
    requestAnimationFrame(() => toast.classList.add('qooti-toast--in'))
    setTimeout(dismissDlToast, 4500)
  }

  function showScreenshotToast(dataUrl) {
    if (_dlToast) { _dlToast.remove(); _dlToast = null }

    const toast = document.createElement('div')
    toast.className = 'qooti-toast qooti-toast--dl'
    toast.setAttribute('data-qooti', '1')
    toast.innerHTML = `
      <img class="qooti-toast-logo" src="${logoUrl}" alt="qooti" />
      <div class="qooti-toast-dl-content">
        <div class="qooti-toast-dl-top">
          <span class="qooti-toast-title">Screenshot copied to clipboard</span>
        </div>
        <div class="qooti-toast-screenshot-row">
          <span class="qooti-toast-screenshot-sub">Save to qooti?</span>
          <button class="qooti-toast-screenshot-yes">Yes</button>
          <button class="qooti-toast-screenshot-no">No</button>
        </div>
      </div>
      <button class="qooti-toast-dl-close" title="Dismiss">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>
        </svg>
      </button>
      <div class="qooti-toast-drain" style="animation-duration:5000ms"></div>
    `

    const titleEl = toast.querySelector('.qooti-toast-title')
    const rowEl   = toast.querySelector('.qooti-toast-screenshot-row')
    let dismissed = false
    let autoTimer

    const dismiss = () => {
      if (dismissed) return
      dismissed = true
      clearTimeout(autoTimer)
      dismissDlToast()
    }

    toast.querySelector('.qooti-toast-screenshot-no').addEventListener('click', dismiss)
    toast.querySelector('.qooti-toast-dl-close').addEventListener('click', dismiss)

    toast.querySelector('.qooti-toast-screenshot-yes').addEventListener('click', async () => {
      if (dismissed) return
      dismissed = true
      clearTimeout(autoTimer)
      toast.querySelector('.qooti-toast-drain')?.remove()
      const yesBtn = toast.querySelector('.qooti-toast-screenshot-yes')
      const noBtn  = toast.querySelector('.qooti-toast-screenshot-no')
      yesBtn.disabled = true
      noBtn.disabled  = true
      yesBtn.textContent = 'Saving…'
      try {
        const running = await checkRunning()
        if (!running) {
          dismissDlToast()
          showNotification('Start qooti to save media from your browser.')
          return
        }
        const result = await sendSave({
          url: location.href, page_url: location.href, title: document.title,
          type: 'image', source_platform: 'youtube', data_url: dataUrl,
        })
        titleEl.textContent = result.already_exists ? 'Already in your library' : 'Saved to qooti'
        rowEl.remove()
        setTimeout(dismissDlToast, 2000)
      } catch {
        dismissDlToast()
      }
    })

    document.body.appendChild(toast)
    _dlToast = toast
    requestAnimationFrame(() => toast.classList.add('qooti-toast--in'))
    autoTimer = setTimeout(dismiss, 5000)
  }

  function sendSave(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'save', payload }, res => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
        if (!res?.ok) return reject(new Error(res?.error ?? 'Save failed'))
        resolve(res)
      })
    })
  }

  // Asks the SW to ping the desktop with a 300 ms timeout.
  // Returns false in ~5 ms when ECONNREFUSED (app not running).
  function checkRunning() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'check-running' }, res => {
        if (chrome.runtime.lastError) { resolve(false); return }
        resolve(res?.running ?? false)
      })
    })
  }

  // ─── Collection picker ───────────────────────────────────────────
  let _pickerEl    = null
  let _pickerTimer = null

  function showCollectionPicker(collections, inspirationId) {
    dismissPicker()
    const DURATION = 4500
    let remaining  = DURATION
    let lastTick   = Date.now()

    const picker = document.createElement('div')
    picker.className = 'qooti-picker'
    picker.setAttribute('data-qooti', '1')
    picker.innerHTML = `
      <div class="qooti-picker-head">
        <div class="qooti-picker-title-row">
          <div class="qooti-picker-check">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 8 6.5 11.5 13 4"/>
            </svg>
          </div>
          <span class="qooti-picker-title">Saved to qooti</span>
          <button class="qooti-picker-close" title="Skip">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <span class="qooti-picker-sub">Add to a collection</span>
      </div>
      <div class="qooti-picker-list"></div>
      <div class="qooti-picker-bar" style="animation-duration:${DURATION}ms"></div>
    `

    const list = picker.querySelector('.qooti-picker-list')
    for (const col of collections) list.appendChild(makeCollectionBtn(col.name, col.id, inspirationId))
    picker.querySelector('.qooti-picker-close').addEventListener('click', dismissPicker)

    // Pause auto-dismiss while hovered; resume on leave
    picker.addEventListener('mouseenter', () => {
      clearTimeout(_pickerTimer)
      remaining -= Date.now() - lastTick
      picker.querySelector('.qooti-picker-bar').style.animationPlayState = 'paused'
    })
    picker.addEventListener('mouseleave', () => {
      lastTick = Date.now()
      picker.querySelector('.qooti-picker-bar').style.animationPlayState = 'running'
      _pickerTimer = setTimeout(dismissPicker, Math.max(remaining, 800))
    })

    document.body.appendChild(picker)
    _pickerEl = picker
    requestAnimationFrame(() => picker.classList.add('qooti-picker--visible'))
    _pickerTimer = setTimeout(dismissPicker, DURATION)
  }

  function makeCollectionBtn(label, collectionId, inspirationId) {
    const btn = document.createElement('button')
    btn.className = 'qooti-picker-btn'
    btn.innerHTML = `
      <svg class="qooti-picker-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="qooti-picker-btn-label">${label}</span>
      <svg class="qooti-picker-btn-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 8 6.5 11.5 13 4"/>
      </svg>
    `
    btn.addEventListener('click', () => {
      dismissPicker()
      if (collectionId && inspirationId) {
        chrome.runtime.sendMessage({ action: 'add-to-collection', inspiration_id: inspirationId, collection_id: collectionId })
      }
    })
    return btn
  }

  function dismissPicker() {
    clearTimeout(_pickerTimer)
    if (!_pickerEl) return
    _pickerEl.classList.remove('qooti-picker--visible')
    const el = _pickerEl; _pickerEl = null
    setTimeout(() => el.remove(), 240)
  }

  // ─── Messages from background (context-menu save) ────────────────
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'show-picker' && showPicker && msg.collections?.length) {
      showCollectionPicker(msg.collections, msg.inspiration_id)
    }
  })

  // ─── Right-click dismiss ─────────────────────────────────────────
  // Right-clicking a media element suppresses its hover badge for the rest of
  // the page session. The WeakSet is keyed by element and lives only in this
  // content-script instance, so the badge returns automatically on reload /
  // navigation. The native context menu is left untouched (no preventDefault).
  const suppressedMedia = new WeakSet()

  document.addEventListener('contextmenu', e => {
    const onBadge = !!e.target?.closest?.('[data-qooti]')

    // Find the media under the cursor. The badge sits over the media's corner,
    // so look past our own overlay to the element behind it.
    let media = null
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (el.closest?.('[data-qooti]')) continue
      if ((el.tagName === 'IMG' || el.tagName === 'VIDEO') && isValidMedia(el)) { media = el; break }
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
  let _rafPending = false

  document.addEventListener('mousemove', e => {
    if (_rafPending) return
    _rafPending = true
    requestAnimationFrame(() => {
      _rafPending = false
      if (isCurrentSiteBanned()) return
      if (_dragActive) return
      const els = document.elementsFromPoint(e.clientX, e.clientY)
      for (const el of els) {
        // Stop if cursor is over our own injected badge / toast / picker
        if (el.closest?.('[data-qooti]')) return
        if ((el.tagName === 'IMG' || el.tagName === 'VIDEO') && isValidMedia(el)) {
          if (suppressedMedia.has(el)) return  // right-click-dismissed this page load
          if (el !== currentTarget) showBadge(el)
          return
        }
      }
    })
  }, { passive: true })

  // ─── App→extension download delegation ───────────────────────────
  // The app queues a URL when yt-dlp fails due to missing auth cookies (e.g. Instagram).
  // Content scripts never go dormant, so this heartbeat reliably wakes the background
  // service worker to poll for pending work every 3 seconds.
  setInterval(() => {
    chrome.runtime.sendMessage({ action: 'check-pending' }).catch(() => {})
  }, 3000)
})()
