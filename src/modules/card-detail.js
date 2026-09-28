import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { getSetting } from './settings.js'
import { openSimilarCanvas } from './similar-canvas.js'
import { makeLogger } from './logger.js'
// `tr`, not `t`: this module uses `t` for tags / toggle elements in local scopes.
import { t as tr, currentLang } from './i18n.js'

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
let _stageRO     = null   // keeps the media fitted to the stage as the window resizes

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
  _stageRO?.disconnect(); _stageRO = null
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

  const itemAr = item.aspect_ratio && item.aspect_ratio > 0 ? item.aspect_ratio : 1

  const dateStr = new Date(item.created_at).toLocaleDateString(currentLang() === 'uz' ? 'uz-Latn' : undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
  const sourceLabel = item.source_platform || hostOf(item.source_url)
  const swatches = parsePalette(item.palette)
  const hasNav = itemsList.length > 1

  modalEl.innerHTML = `
    <div class="dp-stage" id="dp-stage">
      <div class="detail-media-wrap" id="dp-media"></div>
      ${hasNav ? `
        <button class="dp-nav dp-nav--prev" id="dp-prev" aria-label="${tr('detail.prev')}" ${itemIndex <= 0 ? 'disabled' : ''}>${I('caret-left', 18)}</button>
        <button class="dp-nav dp-nav--next" id="dp-next" aria-label="${tr('detail.next')}" ${itemIndex >= itemsList.length - 1 ? 'disabled' : ''}>${I('caret-right', 18)}</button>` : ''}
    </div>

    <aside class="dp-panel">
      <div class="dp-panel-top">
        ${item.source_url
          ? `<button class="dp-source" id="dp-orig-btn" title="${tr('detail.go_original')}"><span>${escHtml(sourceLabel)}</span>${I('arrow-square-out', 14)}</button>`
          : `<span class="dp-source dp-source--local">${tr('detail.local')}</span>`}
        <button class="detail-close" id="dp-close" aria-label="${tr('action.close')}">${I('x', 18)}</button>
      </div>

      <div class="detail-info">
        <!-- Read-only view (default) -->
        <div class="detail-read" id="dp-read">
          <h2 class="detail-read-title${item.title ? '' : ' is-empty'}" id="dp-read-title">${escHtml(item.title || tr('detail.untitled'))}</h2>

          <div class="dp-actions">
            ${item.type === 'image' ? `<button class="dp-action" id="dp-similar-btn">${I('magnifying-glass', 14)}<span>${tr('detail.find_similar')}</span></button>` : ''}
            <button class="dp-action${currentCollectionIds.size > 0 ? ' active' : ''}" id="dp-coll-btn" title="${tr('detail.add_to_collection')}">${I('folders', 14)}<span>${tr('detail.collection')}</span></button>
            <button class="dp-action" id="dp-edit-toggle" title="${tr('detail.edit')}">${I('pencil-simple', 14)}<span>${tr('action.edit')}</span></button>
          </div>

          <div class="detail-read-tags" id="dp-read-tags"></div>

          ${swatches.length ? `
            <div class="dp-colors">
              <div class="dp-section-label">${tr('detail.colors')}</div>
              <div class="dp-swatches">${swatches.map(h => `<span class="dp-swatch" style="background:${escHtml(h)}" title="${escHtml(h)}"></span>`).join('')}</div>
            </div>` : ''}

          <dl class="dp-facts">
            <dt>${tr('detail.added')}</dt><dd>${dateStr}</dd>
            <dt>${tr('detail.type')}</dt><dd id="dp-type">${escHtml(typeLabel(item))}</dd>
          </dl>
        </div>

        <!-- Edit panel (hidden by default) -->
        <div class="detail-edit" id="dp-edit">
          <div class="detail-field">
            <label class="detail-label">${tr('detail.title')}</label>
            <input class="detail-input" id="dp-title" value="${escHtml(item.title ?? '')}"
              placeholder="${tr('detail.title_ph')}" maxlength="200" />
          </div>

          <div class="detail-field">
            <label class="detail-label">${tr('detail.tags')}</label>
            <div class="detail-tag-list" id="dp-tag-list"></div>
            <div class="detail-tag-picker">
              <input class="detail-tag-search" id="dp-tag-search" placeholder="${tr('detail.tag_ph')}" autocomplete="off" />
              <div class="detail-tag-suggestions" id="dp-tag-sug" hidden></div>
            </div>
          </div>

          ${item.source_url ? `
            <div class="detail-field">
              <label class="detail-label">${tr('detail.source')}</label>
              <a class="detail-source-link" href="${escHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">
                ${item.source_platform ? `<strong>${escHtml(item.source_platform)}</strong> · ` : ''}${truncate(item.source_url, 55)}
              </a>
            </div>` : ''}

          <div class="detail-edit-actions">
            <button class="detail-delete-btn" id="dp-delete">
              ${I('trash', 14)}
              ${tr('action.delete')}
            </button>
            <div style="flex:1"></div>
            <button class="detail-cancel-btn" id="dp-cancel">${tr('action.cancel')}</button>
            <button class="detail-save-btn"   id="dp-save">${tr('action.save')}</button>
          </div>
        </div>
      </div>
    </aside>
  `

  // Media element. The media box is sized to the item's own aspect ratio and contained
  // in the stage (fitMedia) — first from the stored ratio (no layout jump), then from
  // the real pixel size once known — and re-fitted whenever the stage resizes.
  const stage     = modalEl.querySelector('#dp-stage')
  const mediaWrap = modalEl.querySelector('#dp-media')
  let nat = { w: itemAr * 1000, h: 1000, cap: Infinity }
  const refit = () => fitMedia(stage, mediaWrap, nat.w, nat.h, nat.cap)
  _stageRO?.disconnect()
  _stageRO = new ResizeObserver(refit)
  _stageRO.observe(stage)
  refit()

  if (item.type === 'video') {
    mediaWrap.appendChild(makeVideoPlayer(mediaSrc, (w, h, dur) => {
      nat = { w, h, cap: MAX_UPSCALE }; refit()
      const typeEl = modalEl.querySelector('#dp-type')
      if (typeEl && dur) typeEl.textContent = typeLabel(item, dur)
    }))
  } else {
    const img = document.createElement('img')
    img.src       = mediaSrc
    img.alt       = item.title ?? ''
    img.className = 'detail-media-el'
    img.decoding  = 'async'
    const onLoad = () => {
      img.style.opacity = '1'
      if (img.naturalWidth) { nat = { w: img.naturalWidth, h: img.naturalHeight, cap: MAX_UPSCALE }; refit() }
    }
    img.addEventListener('load', onLoad)   // also fires after Original ⇄ Enhanced swaps
    mediaWrap.appendChild(img)
    if (img.complete) onLoad()
    // AI enhance: button (with subtle magic shimmer) → badge + Original⇄Enhanced toggle.
    setupEnhanceUI(item, img, mediaWrap, mediaSrc)
  }

  // Prev / next on the stage edges (same as ← / →).
  modalEl.querySelector('#dp-prev')?.addEventListener('click', () => navigate(-1))
  modalEl.querySelector('#dp-next')?.addEventListener('click', () => navigate(1))

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
    if (readTitleEl) {
      readTitleEl.textContent = newTitle || tr('detail.untitled')
      readTitleEl.classList.toggle('is-empty', !newTitle)
    }
  }

  editToggle.addEventListener('click', () => {
    editPanel.classList.contains('is-open') ? closeEdit() : openEdit()
  })

  const origBtn = modalEl.querySelector('#dp-orig-btn')
  if (origBtn) origBtn.addEventListener('click', () => api.openUrl(item.source_url))

  // Find similar — expand into the fullscreen similarity canvas (animates out from the
  // media). Clicking the centred item there re-opens the normal player for it.
  const similarBtn = modalEl.querySelector('#dp-similar-btn')
  if (similarBtn) similarBtn.addEventListener('click', () => {
    const mediaEl = modalEl.querySelector('.detail-media-el') || modalEl.querySelector('#dp-media')
    openSimilarCanvas(item, mediaEl?.getBoundingClientRect(), { onOpen: it => open(it) })
  })

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
          <button class="detail-tag-remove" data-tag-id="${t.id}" aria-label="${escHtml(tr('detail.remove_tag', { name: t.name }))}">×</button>
        </span>`).join('')
    : `<span class="detail-no-tags">${tr('detail.no_tags')}</span>`

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
      popover.innerHTML = `<div class="dp-coll-empty">${tr('collections.empty.title')}</div>`
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
            message: tr('collection.readonly_free'),
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

// ─── AI enhance (images only) ─────────────────────────────────────
// Overlays the image with a subtle always-on "magic" Enhance button; once enhanced,
// shows an "Enhanced" badge (top-left) and an Original⇄Enhanced toggle. The heavy
// upscale runs on a background thread in Rust, so the UI stays responsive.
function setupEnhanceUI(item, img, mediaWrap, origSrc) {
  const toSrc = p => (IS_TAURI ? convertFileSrc(p) : p)
  const LOW_RES_MAX = 1200   // longest side (px); above this an image isn't "low-res" so we don't offer Enhance
  let showingEnhanced = !!item.enhanced_path   // default to the enhanced view once it exists

  const ctrl = document.createElement('div')
  ctrl.className = 'enh-ctrl'
  mediaWrap.appendChild(ctrl)

  function applyView() {
    const es = item.enhanced_path ? toSrc(item.enhanced_path) : null
    img.src = (showingEnhanced && es) ? es : origSrc
    const t = ctrl.querySelector('.enh-toggle')
    if (t) {
      t.querySelector('[data-v="orig"]').classList.toggle('is-active', !showingEnhanced)
      t.querySelector('[data-v="enh"]').classList.toggle('is-active',  showingEnhanced)
    }
  }

  async function onEnhance() {
    const btn = ctrl.querySelector('.enh-btn')
    if (!btn || btn.classList.contains('is-working')) return
    btn.classList.add('is-working')
    btn.querySelector('.enh-btn-label').textContent = tr('enhance.working')
    try {
      const path = await api.enhanceImage(item.id)
      item.enhanced_path = path
      showingEnhanced = true
      renderControl()
      applyView()
      sfx.success?.()
      store.emit(events.GRID_RELOAD)   // surface the badge on the grid card too
    } catch (err) {
      log.warn('enhance failed:', String(err))
      btn.classList.remove('is-working')
      btn.classList.add('is-error')
      btn.querySelector('.enh-btn-label').textContent = tr('enhance.failed')
      setTimeout(() => {
        btn.classList.remove('is-error')
        btn.querySelector('.enh-btn-label').textContent = tr('enhance.label')
      }, 2600)
    }
  }

  async function onDeleteEnhanced() {
    const del = ctrl.querySelector('.enh-del')
    if (del) del.disabled = true
    try {
      await api.deleteEnhanced(item.id)
      item.enhanced_path = null
      showingEnhanced = false
      renderControl()
      applyView()
      store.emit(events.GRID_RELOAD)   // drop the grid-card badge too
    } catch (err) {
      log.warn('delete enhanced failed:', String(err))
      if (del) del.disabled = false
    }
  }

  function showEnhanceButton() {
    ctrl.innerHTML = `
      <button class="enh-btn" title="${tr('enhance.title')}">
        <span class="enh-btn-shine" aria-hidden="true"></span>
        <span class="spinner-ring enh-btn-spinner" aria-hidden="true"></span>
        <span class="icon icon-14" style="mask-image:url('/icons/sparkle.svg');-webkit-mask-image:url('/icons/sparkle.svg')" aria-hidden="true"></span>
        <span class="enh-btn-label">${tr('enhance.label')}</span>
      </button>`
    ctrl.querySelector('.enh-btn').addEventListener('click', onEnhance)
  }

  function renderControl() {
    if (item.enhanced_path) {
      ctrl.innerHTML = `
        <div class="enh-toggle" role="group" aria-label="${tr('enhance.compare')}">
          <button class="enh-toggle-opt" data-v="orig">${tr('enhance.original')}</button>
          <button class="enh-toggle-opt" data-v="enh">${tr('enhance.enhanced')}</button>
        </div>
        <button class="enh-del" title="${tr('enhance.remove')}">
          <span class="icon icon-14" style="mask-image:url('/icons/trash.svg');-webkit-mask-image:url('/icons/trash.svg')" aria-hidden="true"></span>
        </button>`
      ctrl.querySelector('[data-v="orig"]').addEventListener('click', () => { showingEnhanced = false; applyView() })
      ctrl.querySelector('[data-v="enh"]').addEventListener('click',  () => { showingEnhanced = true;  applyView() })
      ctrl.querySelector('.enh-del').addEventListener('click', onDeleteEnhanced)
      return
    }
    // Not enhanced → only offer Enhance for low-res images (nothing to gain on big ones).
    ctrl.innerHTML = ''
    const decide = () => {
      const long = Math.max(img.naturalWidth || 0, img.naturalHeight || 0)
      if (long > 0 && long <= LOW_RES_MAX) showEnhanceButton()
    }
    if (img.complete && img.naturalWidth) decide()
    else img.addEventListener('load', decide, { once: true })
  }

  renderControl()
  applyView()
}

// ─── Custom video player ──────────────────────────────────────────
// Custom video player: a floating frosted control bar over the video (hides while
// playing and idle), a centre play affordance while paused, and a scrubber with the
// buffered range, a handle and a hover time tip. `onMeta(w, h, duration)` reports the
// real video size so the stage can fit it.
function makeVideoPlayer(src, onMeta) {
  const wrap = document.createElement('div')
  wrap.className = 'video-player is-paused'

  const vid = document.createElement('video')
  vid.src = src
  vid.playsInline = true
  vid.className = 'detail-media-el'
  vid.style.opacity = '1'

  const center = document.createElement('div')
  center.className = 'vp-center'
  center.innerHTML = I('play', 24)

  // Control bar
  const bar = document.createElement('div')
  bar.className = 'vp-bar'

  const playBtn = document.createElement('button')
  playBtn.className = 'vp-btn vp-play'

  const curEl = document.createElement('span')
  curEl.className = 'vp-time'
  curEl.textContent = '0:00'

  const scrub  = document.createElement('div')
  scrub.className = 'vp-scrub'
  const track  = document.createElement('div')
  track.className = 'vp-track'
  const buffer = document.createElement('div')
  buffer.className = 'vp-buffer'
  const fill   = document.createElement('div')
  fill.className = 'vp-fill'
  const handle = document.createElement('div')
  handle.className = 'vp-handle'
  const tip    = document.createElement('div')
  tip.className = 'vp-tip'
  track.append(buffer, fill, handle)
  scrub.append(track, tip)

  const durEl = document.createElement('span')
  durEl.className = 'vp-time vp-time--dur'
  durEl.textContent = '0:00'

  const volWrap   = document.createElement('div')
  volWrap.className = 'vp-vol-wrap'
  const muteBtn   = document.createElement('button')
  muteBtn.className = 'vp-btn'
  const volSlider = document.createElement('input')
  volSlider.type  = 'range'
  volSlider.className = 'vp-vol'
  volSlider.min = '0'; volSlider.max = '1'; volSlider.step = '0.01'
  volWrap.append(muteBtn, volSlider)

  // Restore persisted volume
  const _savedVol   = parseFloat(localStorage.getItem('__qooti_vol')   ?? '1')
  const _savedMuted = localStorage.getItem('__qooti_muted') === '1'
  vid.volume       = _savedVol
  vid.muted        = _savedMuted
  volSlider.value  = String(_savedMuted ? 0 : _savedVol)

  const fsBtn = document.createElement('button')
  fsBtn.className = 'vp-btn'
  fsBtn.title = tr('player.fullscreen')

  bar.append(playBtn, curEl, scrub, durEl, volWrap, fsBtn)
  wrap.append(vid, center, bar)

  // ── Icons ──
  const setPlayIcon  = () => { playBtn.innerHTML = I('play',  16); playBtn.title = tr('player.play') }
  const setPauseIcon = () => { playBtn.innerHTML = I('pause', 16); playBtn.title = tr('player.pause') }
  const setSpeaker   = () => { muteBtn.innerHTML = I(vid.muted || vid.volume === 0 ? 'speaker-slash' : 'speaker-high', 16); muteBtn.title = vid.muted ? tr('player.unmute') : tr('player.mute') }
  const setFsIcon    = () => { fsBtn.innerHTML   = I(document.fullscreenElement ? 'arrows-in' : 'arrows-out', 16) }
  setPlayIcon(); setSpeaker(); setFsIcon()

  // ── Idle: hide the bar (and cursor) a moment after the pointer stops, while playing ──
  let idleTimer = null
  const wake = () => {
    wrap.classList.remove('is-idle')
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!vid.paused && !scrub.classList.contains('is-dragging') && !bar.matches(':hover')) wrap.classList.add('is-idle')
    }, 2200)
  }
  wrap.addEventListener('pointermove', wake)
  wrap.addEventListener('pointerleave', () => { if (!vid.paused) wrap.classList.add('is-idle') })

  // ── Video events ──
  vid.addEventListener('loadedmetadata', () => {
    durEl.textContent = fmtDuration(vid.duration)
    onMeta?.(vid.videoWidth, vid.videoHeight, vid.duration)
  })
  const updateBuffer = () => {
    if (!vid.duration) return
    let end = 0
    for (let i = 0; i < vid.buffered.length; i++) {
      if (vid.buffered.start(i) <= vid.currentTime + 0.5) end = Math.max(end, vid.buffered.end(i))
    }
    buffer.style.width = `${(end / vid.duration) * 100}%`
  }
  vid.addEventListener('progress', updateBuffer)
  vid.addEventListener('timeupdate', () => {
    curEl.textContent = fmtDuration(vid.currentTime)
    if (!vid.duration) return
    const pct = (vid.currentTime / vid.duration) * 100
    fill.style.width  = `${pct}%`
    handle.style.left = `${pct}%`
    updateBuffer()
  })
  vid.addEventListener('play',  () => { setPauseIcon(); wrap.classList.remove('is-paused'); wake() })
  vid.addEventListener('pause', () => { setPlayIcon(); wrap.classList.add('is-paused'); wrap.classList.remove('is-idle') })
  vid.addEventListener('ended', () => { setPlayIcon(); wrap.classList.add('is-paused'); vid.currentTime = 0 })

  // ── Play/pause ──
  const toggle = () => (vid.paused ? vid.play().catch(() => {}) : vid.pause())
  playBtn.addEventListener('click', toggle)
  vid.addEventListener('click', toggle)

  // ── Scrub (pointer capture) + hover time tip ──
  const pctAt = e => {
    const r = scrub.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  const showTip = pct => {
    const w = scrub.clientWidth
    tip.textContent = fmtDuration(pct * (vid.duration || 0))
    const half = tip.offsetWidth / 2
    tip.style.left = `${Math.max(half, Math.min(w - half, pct * w))}px`
  }
  scrub.addEventListener('pointerdown', e => {
    scrub.setPointerCapture(e.pointerId)
    scrub.classList.add('is-dragging')
    const pct = pctAt(e)
    if (vid.duration) vid.currentTime = pct * vid.duration
    showTip(pct)
    e.preventDefault()
  })
  scrub.addEventListener('pointermove', e => {
    const pct = pctAt(e)
    showTip(pct)
    if (scrub.hasPointerCapture(e.pointerId) && vid.duration) vid.currentTime = pct * vid.duration
  })
  const endDrag = e => { if (scrub.hasPointerCapture(e.pointerId)) scrub.releasePointerCapture(e.pointerId); scrub.classList.remove('is-dragging') }
  scrub.addEventListener('pointerup', endDrag)
  scrub.addEventListener('pointercancel', endDrag)

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
const MAX_UPSCALE = 2   // small media may be enlarged to fill the stage, but no blurrier than 2×

/** Size `box` to the media's aspect ratio, as large as fits inside the stage's content
 *  area (upscaling by at most `maxScale`), so rounded corners and overlays hug the real
 *  picture instead of a letterbox around it. */
function fitMedia(stage, box, natW, natH, maxScale = Infinity) {
  if (!stage || !box || !natW || !natH) return
  const cs = getComputedStyle(stage)
  const availW = stage.clientWidth  - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const availH = stage.clientHeight - parseFloat(cs.paddingTop)  - parseFloat(cs.paddingBottom)
  if (availW <= 0 || availH <= 0) return
  const k = Math.min(availW / natW, availH / natH, maxScale)
  box.style.width  = `${Math.round(natW * k)}px`
  box.style.height = `${Math.round(natH * k)}px`
}

function fmtDuration(s) {
  const t = Math.max(0, Math.round(s || 0))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** "Video · MP4 · 0:24", "Image · JPEG", "GIF" — readable, not a raw MIME type. */
function typeLabel(item, durationSecs) {
  const kind = item.type === 'gif' ? 'gif' : item.type === 'video' ? 'video' : 'image'
  const parts = [tr(`detail.kind.${kind}`)]
  const fmt = (item.mime_type || '').split('/')[1]
  if (fmt && kind !== 'gif') parts.push(fmt.replace('quicktime', 'mov').toUpperCase())
  const d = durationSecs ?? item.duration_secs
  if (kind === 'video' && d) parts.push(fmtDuration(d))
  return parts.join(' · ')
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url ?? '' }
}

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
