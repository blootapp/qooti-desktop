import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { getSetting } from './settings.js'
import { makeLogger } from './logger.js'

const log = makeLogger('Detail')

const IS_TAURI = '__TAURI_INTERNALS__' in window

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

let backdropEl  = null
let modalEl     = null
let debugEl     = null
let currentItem = null
let currentTags = []
let allTags     = []
let itemsList   = []
let itemIndex   = 0

let allCollections        = []
let currentCollectionIds  = new Set()

let chordPending = false
let chordTimer   = null
let _viewTimer   = null

// ─── Init ─────────────────────────────────────────────────────────
export function init() {
  backdropEl = document.createElement('div')
  backdropEl.className = 'detail-backdrop'
  backdropEl.addEventListener('click', close)

  modalEl = document.createElement('div')
  modalEl.className = 'detail-modal'
  modalEl.setAttribute('aria-modal', 'true')
  modalEl.setAttribute('role', 'dialog')

  debugEl = document.createElement('div')
  debugEl.className = 'debug-modal'

  document.getElementById('overlays').append(backdropEl, modalEl, debugEl)

  document.addEventListener('keydown', e => {
    if (!modalEl.classList.contains('open')) return

    if (e.key === 'Escape') {
      if (debugEl.classList.contains('open')) { closeDebugModal(); return }
      close(); return
    }
    if (e.key === 'ArrowLeft')  { navigate(-1); return }
    if (e.key === 'ArrowRight') { navigate(1);  return }

    // Ctrl+B → T chord opens the debug modal
    if (e.ctrlKey && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      chordPending = true
      clearTimeout(chordTimer)
      chordTimer = setTimeout(() => { chordPending = false }, 600)
      return
    }
    if (chordPending && e.key.toLowerCase() === 't') {
      chordPending = false
      clearTimeout(chordTimer)
      e.preventDefault()
      openDebugModal()
    }
  })

  store.on(events.GRID_ITEM_DELETED, ({ id }) => {
    if (currentItem?.id === id) close()
  })

  store.on(events.CARD_OPEN, ({ item }) => open(item, [item], 0))
}

// ─── Open ─────────────────────────────────────────────────────────
export async function open(item, items = [], index = 0) {
  const wasOpen = modalEl.classList.contains('open')

  currentItem          = item
  itemsList            = items
  itemIndex            = index
  currentTags          = []
  allTags              = []
  allCollections       = []
  currentCollectionIds = new Set()

  // Debounce track_view so rapid arrow-key navigation doesn't inflate view_count.
  clearTimeout(_viewTimer)
  const trackedId = item.id
  _viewTimer = setTimeout(() => api.trackView(trackedId).catch(() => {}), 800)

  // Show backdrop immediately so the user gets instant visual feedback.
  // Keep the modal hidden until content is ready so the entrance animation
  // fires only once the correct height is known — no positional jump.
  backdropEl.classList.add('open')
  modalEl.innerHTML = ''

  const loadId = item.id
  const [tags, myTags, collections, myCollectionIds] = await Promise.all([
    api.listTags().catch(() => []),
    api.getTagsForInspiration(item.id).catch(() => []),
    api.listCollections().catch(() => []),
    api.getCollectionIdsForInspiration(item.id).catch(() => []),
  ])

  if (currentItem?.id !== loadId) return

  allTags              = tags
  currentTags          = myTags
  allCollections       = collections
  currentCollectionIds = new Set(myCollectionIds)
  render()

  if (!wasOpen) {
    // Let the browser lay out the rendered content first, then animate in.
    requestAnimationFrame(() => modalEl.classList.add('open'))
  }
}

// ─── Navigate prev/next ───────────────────────────────────────────
function navigate(dir) {
  const next = itemIndex + dir
  if (next < 0 || next >= itemsList.length) return
  open(itemsList[next], itemsList, next)
}

// ─── Close ────────────────────────────────────────────────────────
export function close() {
  clearTimeout(_viewTimer)
  modalEl.classList.remove('open')
  backdropEl.classList.remove('open')
  modalEl.addEventListener('transitionend', () => {
    if (!modalEl.classList.contains('open')) {
      modalEl.innerHTML = ''
      currentItem = null
    }
  }, { once: true })
}

// ─── Render ───────────────────────────────────────────────────────
function render() {
  if (!currentItem) return
  const item = currentItem

  const mediaSrc = IS_TAURI
    ? convertFileSrc(item.stored_path)
    : item.stored_path

  const dateStr = new Date(item.created_at).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })

  modalEl.innerHTML = `
    <div class="detail-modal-header">
      <button class="detail-close" id="dp-close" aria-label="Close">
        <span class="icon icon-18" style="mask-image:url('/icons/x.svg');-webkit-mask-image:url('/icons/x.svg')" aria-hidden="true"></span>
      </button>
    </div>

    <div class="detail-media-area">
      <div class="detail-media-wrap" id="dp-media"></div>
    </div>

    <div class="detail-info">
      <!-- Read-only view (default) -->
      <div class="detail-read" id="dp-read">
        <div class="detail-title-row">
          <div class="detail-read-title" id="dp-read-title">${escHtml(item.title ?? '')}</div>
          <div class="detail-title-actions">
            ${item.source_url ? `<button class="detail-orig-btn" id="dp-orig-btn" title="Go to original">
              <span class="icon icon-16" style="mask-image:url('/icons/arrow-square-out.svg');-webkit-mask-image:url('/icons/arrow-square-out.svg')" aria-hidden="true"></span>
            </button>` : ''}
            <button class="detail-coll-btn${currentCollectionIds.size > 0 ? ' active' : ''}" id="dp-coll-btn" title="Add to collection">
              <span class="icon icon-16" style="mask-image:url('/icons/folders.svg');-webkit-mask-image:url('/icons/folders.svg')" aria-hidden="true"></span>
            </button>
            <button class="detail-edit-toggle" id="dp-edit-toggle" title="Edit details">
              <span class="icon icon-16" style="mask-image:url('/icons/pencil-simple.svg');-webkit-mask-image:url('/icons/pencil-simple.svg')" aria-hidden="true"></span>
            </button>
          </div>
        </div>
        <div class="detail-read-tags" id="dp-read-tags"></div>
        <div class="detail-meta-row">
          <span class="detail-meta-date">${dateStr}</span>
          <span class="detail-meta-type">${escHtml(item.mime_type ?? item.type)}</span>
        </div>
      </div>

      <!-- Edit panel (hidden by default) -->
      <div class="detail-edit" id="dp-edit">
        <div class="detail-field">
          <label class="detail-label">Title</label>
          <input class="detail-input" id="dp-title" value="${escHtml(item.title ?? '')}"
            placeholder="Add a title…" maxlength="200" />
        </div>

        <div class="detail-field">
          <label class="detail-label">Tags</label>
          <div class="detail-tag-list" id="dp-tag-list"></div>
          <div class="detail-tag-picker">
            <input class="detail-tag-search" id="dp-tag-search" placeholder="Add tag…" autocomplete="off" />
            <div class="detail-tag-suggestions" id="dp-tag-sug" hidden></div>
          </div>
        </div>

        ${item.source_url ? `
          <div class="detail-field">
            <label class="detail-label">Source</label>
            <a class="detail-source-link" href="${escHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">
              ${item.source_platform ? `<strong>${escHtml(item.source_platform)}</strong> · ` : ''}${truncate(item.source_url, 55)}
            </a>
          </div>` : ''}

        <div class="detail-edit-actions">
          <button class="detail-delete-btn" id="dp-delete">
            <span class="icon icon-14" style="mask-image:url('/icons/trash.svg');-webkit-mask-image:url('/icons/trash.svg')" aria-hidden="true"></span>
            Delete
          </button>
          <div style="flex:1"></div>
          <button class="detail-cancel-btn" id="dp-cancel">Cancel</button>
          <button class="detail-save-btn"   id="dp-save">Save</button>
        </div>
      </div>
    </div>
  `

  // Media element
  const mediaWrap = modalEl.querySelector('#dp-media')
  if (item.type === 'video') {
    mediaWrap.appendChild(makeVideoPlayer(mediaSrc))
  } else {
    const img = document.createElement('img')
    img.src       = mediaSrc
    img.alt       = item.title ?? ''
    img.className = 'detail-media-el'
    img.loading   = 'lazy'
    img.decoding  = 'async'
    img.onload = () => { img.style.opacity = '1' }
    if (img.complete) img.style.opacity = '1'
    mediaWrap.appendChild(img)
  }

  // Close
  modalEl.querySelector('#dp-close').addEventListener('click', close)

  // Edit toggle + save/cancel
  const editToggle = modalEl.querySelector('#dp-edit-toggle')
  const readPanel  = modalEl.querySelector('#dp-read')
  const editPanel  = modalEl.querySelector('#dp-edit')
  const titleInput = modalEl.querySelector('#dp-title')
  let originalTitle = titleInput.value

  function openEdit() {
    originalTitle = titleInput.value
    editToggle.classList.add('active')
    readPanel.classList.add('is-hidden')
    editPanel.style.display = 'flex'
    requestAnimationFrame(() => requestAnimationFrame(() => {
      editPanel.classList.add('is-open')
    }))
    setTimeout(() => titleInput.focus(), 200)
  }

  function closeEdit() {
    editPanel.classList.remove('is-open')
    editPanel.style.display = ''
    readPanel.classList.remove('is-hidden')
    editToggle.classList.remove('active')
  }

  async function commitTitle() {
    const newTitle = titleInput.value.trim()
    await saveTitle(newTitle)
    const readTitleEl = modalEl.querySelector('#dp-read-title')
    if (readTitleEl) readTitleEl.textContent = newTitle || ''
  }

  editToggle.addEventListener('click', () => {
    editPanel.classList.contains('is-open') ? closeEdit() : openEdit()
  })

  const origBtn = modalEl.querySelector('#dp-orig-btn')
  if (origBtn) origBtn.addEventListener('click', () => api.openUrl(item.source_url))

  const sourceLink = modalEl.querySelector('.detail-source-link')
  if (sourceLink) sourceLink.addEventListener('click', e => {
    e.preventDefault()
    api.openUrl(item.source_url)
  })

  titleInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      await commitTitle()
      closeEdit()
    }
  })

  modalEl.querySelector('#dp-save').addEventListener('click', async () => {
    await commitTitle()
    closeEdit()
  })

  modalEl.querySelector('#dp-cancel').addEventListener('click', () => {
    titleInput.value = originalTitle
    closeEdit()
  })

  // Delete (inside edit panel)
  modalEl.querySelector('#dp-delete').addEventListener('click', async () => {
    try {
      await api.deleteInspiration(item.id)
      log.info('deleted', { id: item.id, type: item.type, title: item.title ?? '—' })
      sfx.delete()
      store.emit(events.GRID_ITEM_DELETED, { id: item.id })
      close()
    } catch (err) {
      console.error('[detail] delete failed:', err)
    }
  })

  renderReadTags()
  renderTagList()
  bindTagPicker()
  bindCollectionPicker()
}

// ─── Read-only tag pills ──────────────────────────────────────────
function renderReadTags() {
  const el = modalEl?.querySelector('#dp-read-tags')
  if (!el) return
  el.innerHTML = currentTags.length
    ? currentTags.map(t =>
        `<span class="detail-tag ${t.source === 'model' ? 'detail-tag--model' : 'detail-tag--user'}">${escHtml(t.name)}</span>`
      ).join('')
    : ''
}

// ─── Tag list ─────────────────────────────────────────────────────
function renderTagList() {
  const list = modalEl?.querySelector('#dp-tag-list')
  if (!list) return

  list.innerHTML = currentTags.length
    ? currentTags.map(t => `
        <span class="detail-tag ${t.source === 'model' ? 'detail-tag--model' : 'detail-tag--user'}">
          ${escHtml(t.name)}
          <button class="detail-tag-remove" data-tag-id="${t.id}" aria-label="Remove ${escHtml(t.name)}">×</button>
        </span>`).join('')
    : '<span class="detail-no-tags">No tags yet</span>'

  list.querySelectorAll('.detail-tag-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tagId = btn.dataset.tagId
      try {
        await api.untagInspiration(currentItem.id, tagId)
        log.info('tag_removed', { id: currentItem.id, tag: currentTags.find(t => t.id === tagId)?.name ?? tagId })
        currentTags = currentTags.filter(t => t.id !== tagId)
        renderTagList()
        renderReadTags()
        renderTagSuggestions('')
      } catch (err) { log.error('tag_remove_failed', { id: currentItem.id, tag: tagId, error: err }) }
    })
  })
}

// ─── Collection picker ────────────────────────────────────────────
function bindCollectionPicker() {
  const btn = modalEl.querySelector('#dp-coll-btn')
  if (!btn) return

  let popover = null

  function openPicker() {
    closePicker()
    popover = document.createElement('div')
    popover.className = 'dp-coll-popover'

    if (!allCollections.length) {
      popover.innerHTML = `<div class="dp-coll-empty">No collections yet</div>`
    } else {
      popover.innerHTML = allCollections.map(c => `
        <button class="dp-coll-item${currentCollectionIds.has(c.id) ? ' is-active' : ''}${c.locked ? ' is-locked' : ''}" data-coll-id="${escHtml(c.id)}" data-locked="${c.locked ? '1' : '0'}">
          <span class="dp-coll-check">${I('check', 12)}</span>
          <span class="dp-coll-name">${escHtml(c.name)}</span>
          ${c.locked ? `<span class="dp-coll-lock">${I('lock', 11)}</span>` : ''}
        </button>
      `).join('')
    }

    document.getElementById('overlays').appendChild(popover)

    const rect = btn.getBoundingClientRect()
    popover.style.cssText = `position:fixed;top:${rect.bottom + 6}px;right:${window.innerWidth - rect.right}px;z-index:500`

    popover.querySelectorAll('.dp-coll-item').forEach(row => {
      row.addEventListener('click', async e => {
        e.stopPropagation()
        if (row.dataset.locked === '1') {
          closePicker()
          store.emit(events.SYSTEM_TOAST, {
            type: 'info',
            message: 'This collection is read-only on the free plan. Upgrade to Pro to edit it.',
            duration: 4000,
          })
          return
        }
        const collId = row.dataset.collId
        const inColl = currentCollectionIds.has(collId)
        try {
          if (inColl) {
            await api.removeFromCollection(collId, currentItem.id)
            currentCollectionIds.delete(collId)
            log.info('collection_removed', { id: currentItem.id, collection: allCollections.find(c => c.id === collId)?.name ?? collId })
          } else {
            await api.addToCollection(collId, currentItem.id)
            currentCollectionIds.add(collId)
            log.info('collection_added', { id: currentItem.id, collection: allCollections.find(c => c.id === collId)?.name ?? collId })
          }
          row.classList.toggle('is-active', !inColl)
          btn.classList.toggle('active', currentCollectionIds.size > 0)
        } catch (err) { console.error('[detail] toggle collection failed:', err) }
      })
    })

    setTimeout(() => document.addEventListener('click', closePicker, { once: true }), 0)
  }

  function closePicker() {
    if (popover) { popover.remove(); popover = null }
  }

  btn.addEventListener('click', e => {
    e.stopPropagation()
    popover ? closePicker() : openPicker()
  })
}

// ─── Tag picker ───────────────────────────────────────────────────
function bindTagPicker() {
  const searchInput = modalEl.querySelector('#dp-tag-search')
  if (!searchInput) return

  searchInput.addEventListener('focus', () => renderTagSuggestions(searchInput.value))
  searchInput.addEventListener('input', () => renderTagSuggestions(searchInput.value))
  searchInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const name = searchInput.value.trim()
      if (!name) return
      const existing = allTags.find(t => t.name.toLowerCase() === name.toLowerCase())
      existing ? await addTagToCard(existing.id) : await createAndAddTag(name)
      searchInput.value = ''
      renderTagSuggestions('')
    } else if (e.key === 'Escape') {
      searchInput.blur()
      clearSuggestions()
    }
  })
  searchInput.addEventListener('click', e => e.stopPropagation())
  document.addEventListener('click', clearSuggestions)
}

function renderTagSuggestions(query) {
  const sugEl     = modalEl?.querySelector('#dp-tag-sug')
  const searchInput = modalEl?.querySelector('#dp-tag-search')
  if (!sugEl || !searchInput) return

  if (getSetting('tag_recommendations_enabled', 'false') === 'false') {
    sugEl.innerHTML = ''; sugEl.hidden = true; return
  }

  const myTagIds = new Set(currentTags.map(t => t.id))
  const q = query.trim().toLowerCase()
  const filtered = allTags
    .filter(t => !myTagIds.has(t.id) && (q === '' || t.name.toLowerCase().includes(q)))
    .slice(0, 8)

  if (!filtered.length && !q) { sugEl.innerHTML = ''; sugEl.hidden = true; return }

  let html = filtered.map(t =>
    `<button class="detail-tag-sug" data-tag-id="${t.id}">${escHtml(t.name)}</button>`
  ).join('')

  if (q && !allTags.some(t => t.name.toLowerCase() === q)) {
    html += `<button class="detail-tag-sug detail-tag-create" data-create="${escHtml(q)}">Create "${escHtml(q)}"</button>`
  }

  sugEl.innerHTML = html
  sugEl.hidden = false

  // Position fixed so it escapes the overflow scroll container
  const rect = searchInput.getBoundingClientRect()
  sugEl.style.cssText = `
    position: fixed;
    top: ${rect.bottom + 4}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    z-index: 300;
  `

  sugEl.querySelectorAll('.detail-tag-sug').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      if (btn.dataset.create) await createAndAddTag(btn.dataset.create)
      else await addTagToCard(btn.dataset.tagId)
      if (searchInput) searchInput.value = ''
      renderTagSuggestions('')
    })
  })
}

function clearSuggestions() {
  const sugEl = modalEl?.querySelector('#dp-tag-sug')
  if (sugEl) { sugEl.innerHTML = ''; sugEl.hidden = true }
}

async function addTagToCard(tagId) {
  try {
    await api.tagInspiration(currentItem.id, tagId)
    const tag = allTags.find(t => t.id === tagId)
    log.info('tag_added', { id: currentItem.id, tag: tag?.name ?? tagId })
    if (tag && !currentTags.find(t => t.id === tagId)) currentTags.push(tag)
    renderTagList()
    renderReadTags()
  } catch (err) { log.error('tag_add_failed', { id: currentItem.id, tag: tagId, error: err }) }
}

async function createAndAddTag(name) {
  try {
    const tag = await api.createTag(name)
    log.info('tag_created', { name, tagId: tag.id })
    allTags.push(tag)
    store.emit(events.TAG_CREATED, { tag })
    await addTagToCard(tag.id)
  } catch (err) { log.error('tag_create_failed', { name, error: err }) }
}

// ─── Title save ───────────────────────────────────────────────────
async function saveTitle(value) {
  if (!currentItem) return
  try {
    await api.updateInspiration(currentItem.id, { title: value || null })
    log.info('title_edited', { id: currentItem.id, title: value || '(cleared)' })
    currentItem.title = value || null
    store.emit(events.GRID_ITEM_UPDATED, { inspiration: { ...currentItem } })
  } catch (err) { log.error('title_edit_failed', { id: currentItem.id, error: err }) }
}

// ─── Custom video player ──────────────────────────────────────────
function makeVideoPlayer(src) {
  const wrap = document.createElement('div')
  wrap.className = 'video-player'

  const vid = document.createElement('video')
  vid.src = src
  vid.playsInline = true
  vid.className = 'detail-media-el'
  vid.style.opacity = '1'

  // Controls bar
  const controls = document.createElement('div')
  controls.className = 'vp-controls'

  // Play/pause
  const playBtn = document.createElement('button')
  playBtn.className = 'vp-btn'

  // Time display
  const timeEl  = document.createElement('span')
  timeEl.className = 'vp-time'
  const curEl  = document.createElement('span')
  const sepEl  = document.createElement('span')
  sepEl.textContent = ' / '
  const durEl  = document.createElement('span')
  durEl.textContent = '0:00'
  curEl.textContent = '0:00'
  timeEl.append(curEl, sepEl, durEl)

  // Progress bar
  const prog  = document.createElement('div')
  prog.className = 'vp-progress'
  const track = document.createElement('div')
  track.className = 'vp-track'
  const fill  = document.createElement('div')
  fill.className = 'vp-fill'
  const thumb = document.createElement('div')
  thumb.className = 'vp-thumb'
  track.append(fill, thumb)
  prog.append(track)

  // Volume
  const volWrap  = document.createElement('div')
  volWrap.className = 'vp-vol-wrap'
  const muteBtn  = document.createElement('button')
  muteBtn.className = 'vp-btn'
  const volSlider = document.createElement('input')
  volSlider.type  = 'range'
  volSlider.className = 'vp-vol'
  volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.01'

  // Restore persisted volume
  const _savedVol   = parseFloat(localStorage.getItem('__qooti_vol')   ?? '1')
  const _savedMuted = localStorage.getItem('__qooti_muted') === '1'
  vid.volume       = _savedVol
  vid.muted        = _savedMuted
  volSlider.value  = String(_savedMuted ? 0 : _savedVol)

  volWrap.append(muteBtn, volSlider)

  // Fullscreen
  const fsBtn = document.createElement('button')
  fsBtn.className = 'vp-btn'
  fsBtn.title = 'Fullscreen'

  controls.append(playBtn, timeEl, prog, volWrap, fsBtn)
  wrap.append(vid, controls)

  // ── Icon helpers ──
  const setPlayIcon  = () => { playBtn.innerHTML = I('play',  16); playBtn.title = 'Play' }
  const setPauseIcon = () => { playBtn.innerHTML = I('pause', 16); playBtn.title = 'Pause' }
  const setSpeaker   = () => { muteBtn.innerHTML = I(vid.muted || vid.volume === 0 ? 'speaker-slash' : 'speaker-high', 16); muteBtn.title = vid.muted ? 'Unmute' : 'Mute' }
  const setFsIcon    = () => { fsBtn.innerHTML   = I(document.fullscreenElement ? 'arrows-in' : 'arrows-out', 16) }

  setPlayIcon(); setSpeaker(); setFsIcon()

  // ── Time format ──
  function fmt(s) {
    const t = Math.round(s || 0)
    const m = Math.floor(t / 60)
    return `${m}:${String(t % 60).padStart(2, '0')}`
  }

  // ── Video events ──
  vid.addEventListener('loadedmetadata', () => { durEl.textContent = fmt(vid.duration) })
  vid.addEventListener('timeupdate', () => {
    curEl.textContent = fmt(vid.currentTime)
    if (!vid.duration) return
    const pct = (vid.currentTime / vid.duration) * 100
    fill.style.width = `${pct}%`
    thumb.style.left = `${pct}%`
  })
  vid.addEventListener('play',  setPauseIcon)
  vid.addEventListener('pause', setPlayIcon)
  vid.addEventListener('ended', () => { setPlayIcon(); vid.currentTime = 0 })

  // ── Play/pause toggle ──
  playBtn.addEventListener('click', () => vid.paused ? vid.play().catch(() => {}) : vid.pause())
  vid.addEventListener('click', () => vid.paused ? vid.play().catch(() => {}) : vid.pause())

  // ── Seek (pointer capture — no global listeners needed) ──
  prog.addEventListener('pointerdown', e => {
    prog.setPointerCapture(e.pointerId)
    seekTo(e)
    e.preventDefault()
  })
  prog.addEventListener('pointermove', e => { if (prog.hasPointerCapture(e.pointerId)) seekTo(e) })
  prog.addEventListener('pointerup',   e => { prog.releasePointerCapture(e.pointerId) })

  function seekTo(e) {
    const r = prog.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    if (vid.duration) vid.currentTime = pct * vid.duration
  }

  // ── Volume ──
  function saveVol() {
    localStorage.setItem('__qooti_vol',   String(vid.volume))
    localStorage.setItem('__qooti_muted', vid.muted ? '1' : '0')
  }
  muteBtn.addEventListener('click', () => {
    vid.muted = !vid.muted
    volSlider.value = vid.muted ? '0' : String(vid.volume)
    setSpeaker(); saveVol()
  })
  volSlider.addEventListener('input', () => {
    vid.volume = parseFloat(volSlider.value)
    vid.muted  = vid.volume === 0
    setSpeaker(); saveVol()
  })

  // ── Fullscreen ──
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else wrap.requestFullscreen().catch(() => {})
  })
  document.addEventListener('fullscreenchange', setFsIcon)

  requestAnimationFrame(() => vid.play().catch(() => {}))

  return wrap
}

// ─── Helpers ──────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return ''
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str
}

// ─── Debug modal (Ctrl+B → T) ─────────────────────────────────────
async function openDebugModal() {
  if (!currentItem) return
  const fresh = await api.getInspiration(currentItem.id).catch(() => null)
  const item = fresh ? { ...currentItem, ...fresh } : currentItem
  const palette  = parsePalette(item.palette)
  const autoTags = parseAutoTags(item.auto_tag_confidence)
  const ocrStatus = item.ocr_status ?? 'pending'

  debugEl.innerHTML = `
    <div class="debug-header">
      <span class="debug-title">Debug · ${escHtml(item.id)}</span>
      <button class="debug-close" id="dbg-close">ESC</button>
    </div>
    <div class="debug-body">

      <div class="debug-section">
        <div class="debug-section-label">Extracted Text</div>
        <div class="debug-ocr-status">
          <span class="debug-badge debug-badge--${ocrStatus}">${ocrStatus}</span>
          ${item.ocr_language ? `<span class="debug-dim">· ${escHtml(item.ocr_language)}</span>` : ''}
        </div>
        <pre class="debug-pre">${escHtml(item.ocr_text || '—')}</pre>
      </div>

      <div class="debug-section">
        <div class="debug-section-label">Color Palette</div>
        ${palette.length
          ? `<div class="debug-palette">${palette.map(hex =>
              `<div class="debug-swatch" style="background:${hex}" title="${hex}">
                <span class="debug-swatch-label">${hex}</span>
              </div>`).join('')}</div>`
          : '<span class="debug-dim">Not extracted yet</span>'}
      </div>

      <div class="debug-section">
        <div class="debug-section-label">Auto-tag Confidence</div>
        ${autoTags.length
          ? autoTags.map(({ tag, score }) =>
              `<div class="debug-conf-row">
                <span class="debug-conf-name">${escHtml(tag)}</span>
                <div class="debug-conf-bar"><div class="debug-conf-fill" style="width:${Math.round(score * 100)}%"></div></div>
                <span class="debug-conf-pct">${Math.round(score * 100)}%</span>
              </div>`).join('')
          : '<span class="debug-dim">No auto-tags</span>'}
      </div>

      <div class="debug-section">
        <div class="debug-section-label">Metadata</div>
        <table class="debug-table">
          <tr><td>ID</td><td>${escHtml(item.id)}</td></tr>
          <tr><td>Type</td><td>${escHtml(item.type)}${item.mime_type ? ' · ' + escHtml(item.mime_type) : ''}</td></tr>
          <tr><td>Auto-tag model</td><td>${escHtml(item.auto_tag_model ?? '—')}</td></tr>
          <tr><td>Auto-tag status</td><td>${escHtml(item.auto_tag_status ?? '—')}</td></tr>
          <tr><td>File hash</td><td>${item.file_hash ? escHtml(item.file_hash.slice(0, 20)) + '…' : '—'}</td></tr>
          <tr><td>pHash</td><td>${item.phash ? escHtml(item.phash.slice(0, 20)) + '…' : '—'}</td></tr>
          <tr><td>Source</td><td>${escHtml(item.source_platform ?? '—')}</td></tr>
          <tr><td>Source URL</td><td class="debug-url">${item.source_url ? escHtml(truncate(item.source_url, 55)) : '—'}</td></tr>
          <tr><td>Created</td><td>${new Date(item.created_at).toISOString()}</td></tr>
          <tr><td>Updated</td><td>${new Date(item.updated_at).toISOString()}</td></tr>
        </table>
      </div>

    </div>
  `

  debugEl.querySelector('#dbg-close').addEventListener('click', closeDebugModal)
  debugEl.classList.add('open')
}

function closeDebugModal() {
  debugEl.classList.remove('open')
}

function parsePalette(json) {
  if (!json) return []
  try {
    const arr = typeof json === 'string' ? JSON.parse(json) : json
    return Array.isArray(arr) ? arr.filter(h => typeof h === 'string') : []
  } catch { return [] }
}

function parseAutoTags(json) {
  if (!json) return []
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json
    return Object.entries(obj)
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
  } catch { return [] }
}
