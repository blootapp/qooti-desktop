import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'
import { tagLabel, searchLabels, visibleConcepts, conceptLabel, getConcept, keyLabel, parseConfidence, isVisibleKey, mediaOf, tagConceptId, sameNameKey, readableName } from './lenses.js'
import { openSimilarCanvas } from './similar-canvas.js'
import { makeLogger } from './logger.js'
import { confirmDeleteItem, isDialogOpen } from './dialog.js'
import { canCrop, openCrop } from './crop-tool.js'
import { reducedMotion, EASE_OUT, EASE_IN } from './motion.js'
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
let _stage       = null   // the stage now: { el, media, img, nat, refit, tools, cropBtn, enh }
let _panelCtl    = null   // the panel's Edit: { editing(), saveAndCloseEdit() }
let _crop        = null   // the open crop (crop-tool.js), or null
let _cropOpening = false  // between C and the crop being up (the Upscaled view crossfades first)

const isTyping = el => !!el?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')

// ─── Init ─────────────────────────────────────────────────────────
export function init() {
  backdropEl = document.createElement('div')
  backdropEl.className = 'detail-backdrop'
  backdropEl.addEventListener('click', onBackdropClick)

  modalEl = document.createElement('div')
  modalEl.className = 'detail-modal'
  modalEl.setAttribute('aria-modal', 'true')
  modalEl.setAttribute('role', 'dialog')

  debugEl = document.createElement('div')
  debugEl.className = 'debug-modal'

  document.getElementById('overlays').append(backdropEl, modalEl, debugEl)

  document.addEventListener('keydown', e => {
    if (!modalEl.classList.contains('open')) return
    if (isDialogOpen()) return   // the dialog on top owns the keyboard

    // Crop mode owns the keyboard: arrows move the frame, Enter saves, Esc cancels
    if (_crop?.isOpen()) { _crop.handleKey(e); return }
    if (_cropOpening) return

    if (e.key === 'Escape') {
      if (debugEl.classList.contains('open')) { closeDebugModal(); return }
      close(); return
    }
    // Not while typing a title or a tag: there the arrows move the caret
    if (e.key === 'ArrowLeft'  && !isTyping(e.target)) { navigate(-1); return }
    if (e.key === 'ArrowRight' && !isTyping(e.target)) { navigate(1);  return }

    // C: crop the picture (no modifier keys, not while typing)
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isTyping(e.target)) {
      if (_stage?.cropBtn && !_stage.cropBtn.disabled) { e.preventDefault(); startCrop() }
      return
    }

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

  // Lens data changed (the language, a lens on or off, an update): Tag lens tags show
  // their names in the app's language, and the picker lists what's on now
  store.on(events.LENS_LOADED, () => {
    if (!currentItem || !modalEl.classList.contains('open')) return
    renderReadTags()
    renderTagList()
    const sugEl = modalEl.querySelector('#dp-tag-sug')
    const searchInput = modalEl.querySelector('#dp-tag-search')
    if (sugEl && !sugEl.hidden && searchInput) renderTagSuggestions(searchInput.value)
  })
}

// ─── Open ─────────────────────────────────────────────────────────
export async function open(item, items = [], index = 0) {
  const wasOpen = modalEl.classList.contains('open')

  // Another item while a crop is open (a toast's Show, the extension): the crop goes
  _crop?.destroy(); _crop = null
  _stage = null; _panelCtl = null

  // The player's own list. Opened on its own (Find similar's centre picture) it's a list of
  // one, so a crop saved as a copy still goes right after the original (← goes back to it)
  const listed = Array.isArray(items) && items[index]?.id === item.id
  currentItem          = item
  itemsList            = listed ? items : [item]
  itemIndex            = listed ? index : 0
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
  // The item is read again too: Activity, Duplicates and Downloads open partial records,
  // and crop needs mime_type and has_original
  const [tags, myTags, collections, myCollectionIds, fresh] = await Promise.all([
    api.listTags().catch(() => []),
    api.getTagsForInspiration(item.id).catch(() => []),
    api.listCollections().catch(() => []),
    api.getCollectionIdsForInspiration(item.id).catch(() => []),
    api.getInspiration(item.id).catch(() => null),
  ])

  if (currentItem?.id !== loadId) return

  if (fresh && fresh.id === loadId) currentItem = mergeFresh(item, fresh)
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
  _crop?.destroy(); _crop = null
  _stageRO?.disconnect(); _stageRO = null
  modalEl.classList.remove('open')
  backdropEl.classList.remove('open')
  modalEl.addEventListener('transitionend', () => {
    if (!modalEl.classList.contains('open')) {
      modalEl.innerHTML = ''
      currentItem = null
      _stage = null
      _panelCtl = null
    }
  }, { once: true })
}

// ─── Render ───────────────────────────────────────────────────────
// The stage (the picture or video, its tools) and the panel (the item's details) are
// built apart, so a saved crop can switch the panel to the updated item or to the copy
// while the picture stays where it is (swapPanel).
function render() {
  if (!currentItem) return
  const item = currentItem
  modalEl.innerHTML = `
    <div class="dp-stage" id="dp-stage">
      <div class="detail-media-wrap" id="dp-media"></div>
    </div>
    <aside class="dp-panel">${panelHtml(item)}</aside>
  `
  setupStage(item)
  renderNav()
  bindPanel(item)
}

const toSrc = p => (IS_TAURI ? convertFileSrc(p) : p)
const sameSrc = (a, b) => { try { return new URL(a, location.href).href === new URL(b, location.href).href } catch { return a === b } }

// Media element. The media box is sized to the item's own aspect ratio and contained
// in the stage (fitMedia) — first from the stored ratio (no layout jump), then from
// the real pixel size once known — and re-fitted whenever the stage resizes.
function setupStage(item) {
  const stage = modalEl.querySelector('#dp-stage')
  const media = modalEl.querySelector('#dp-media')
  const itemAr = item.aspect_ratio && item.aspect_ratio > 0 ? item.aspect_ratio : 1
  const st = { el: stage, media, img: null, tools: null, cropBtn: null, enh: null, nat: { w: itemAr * 1000, h: 1000, cap: Infinity } }
  st.refit = () => {
    fitMedia(stage, media, st.nat.w, st.nat.h, st.nat.cap)
    // The crop frame's layer sits in the same grid cell, at the same size (not clipped,
    // so the handles can sit on the picture's edges)
    const layer = stage.querySelector('.crop-layer')
    if (layer) { layer.style.width = media.style.width; layer.style.height = media.style.height }
  }
  _stage = st
  _stageRO?.disconnect()
  _stageRO = new ResizeObserver(() => st.refit())
  _stageRO.observe(stage)
  st.refit()

  const mediaSrc = toSrc(item.stored_path)
  if (item.type === 'video') {
    media.appendChild(makeVideoPlayer(mediaSrc, (w, h, dur) => {
      st.nat = { w, h, cap: MAX_UPSCALE }; st.refit()
      for (const sel of ['#dp-type', '#dp-meta-type']) {
        const typeEl = modalEl.querySelector(sel)
        if (typeEl && dur) typeEl.textContent = typeLabel(item, dur)
      }
    }))
    return
  }

  const img = document.createElement('img')
  img.src       = mediaSrc
  img.alt       = item.title ?? ''
  img.className = 'detail-media-el'
  img.decoding  = 'async'
  st.img = img
  const onLoad = () => {
    img.style.opacity = '1'
    if (img.naturalWidth) { st.nat = { w: img.naturalWidth, h: img.naturalHeight, cap: MAX_UPSCALE }; st.refit() }
    syncCropButton()
  }
  img.addEventListener('load', onLoad)   // also fires after Original ⇄ Enhanced swaps and a crop
  media.appendChild(img)

  // Picture tools under the picture, at the stage's bottom right: Upscale, then Crop
  // pinned at the right end (Upscale's label changing or appearing never moves it)
  const tools = document.createElement('div')
  tools.className = 'dp-tools'
  stage.appendChild(tools)
  st.tools = tools
  // AI enhance: button (with subtle magic shimmer) → badge + Original⇄Enhanced toggle.
  // Crop waits while it runs (syncCropButton).
  st.enh = setupEnhanceUI(item, img, tools, mediaSrc, syncCropButton)
  setupCropButton(item)
  if (img.complete) onLoad()
}

// Prev / next on the stage edges (same as ← / →). Built again when the list changes
// (a crop saved as a copy joins it, right after the original).
function renderNav() {
  const stage = modalEl.querySelector('#dp-stage')
  if (!stage) return
  stage.querySelectorAll('.dp-nav').forEach(b => b.remove())
  if (itemsList.length <= 1) return
  const make = dir => {
    const b = document.createElement('button')
    b.className = `dp-nav dp-nav--${dir < 0 ? 'prev' : 'next'}`
    b.id = dir < 0 ? 'dp-prev' : 'dp-next'
    b.setAttribute('aria-label', tr(dir < 0 ? 'detail.prev' : 'detail.next'))
    b.innerHTML = I(dir < 0 ? 'caret-left' : 'caret-right', 18)
    b.disabled = dir < 0 ? itemIndex <= 0 : itemIndex >= itemsList.length - 1
    b.addEventListener('click', () => navigate(dir))
    return b
  }
  const before = stage.querySelector('.dp-tools')
  stage.insertBefore(make(-1), before)
  stage.insertBefore(make(1), before)
}

function panelHtml(item) {
  const dateStr = new Date(item.created_at).toLocaleDateString(currentLang() === 'uz' ? 'uz-Latn' : undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
  const sourceLabel = item.source_platform || hostOf(item.source_url)
  const swatches = parsePalette(item.palette)
  return `
      <div class="dp-panel-top">
        ${item.source_url
          ? `<button class="dp-source" id="dp-orig-btn" title="${tr('detail.go_original')}"><span class="dp-source-dot" style="background:${platformColor(item.source_platform)}"></span><span>${escHtml(sourceLabel)}</span>${I('arrow-square-out', 14)}</button>`
          : `<span class="dp-source dp-source--local"><span class="dp-source-dot"></span><span>${tr('detail.local')}</span></span>`}
        <button class="detail-close" id="dp-close" aria-label="${tr('action.close')}">${I('x', 16)}</button>
      </div>

      <div class="detail-info">
        <!-- Read-only view (default) -->
        <div class="detail-read" id="dp-read">
          <div class="dp-head">
            <h2 class="detail-read-title${item.title ? '' : ' is-empty'}" id="dp-read-title">${escHtml(item.title || tr('detail.untitled'))}</h2>
            <p class="dp-meta">${tr('detail.added')} ${dateStr} · <span id="dp-meta-type">${escHtml(typeLabel(item))}</span></p>
          </div>

          <div class="dp-actions">
            ${item.type === 'image' ? `<button class="dp-action" id="dp-similar-btn">${tr('detail.find_similar')}</button>` : ''}
            <button class="dp-action" id="dp-coll-btn">${tr('detail.add_to_collection')}</button>
            <button class="dp-action" id="dp-edit-toggle">${tr('action.edit')}</button>
          </div>

          <hr class="dp-divider" />

          ${swatches.length ? `
            <section class="dp-section">
              <h3 class="dp-section-label">${tr('detail.colors')}</h3>
              <div class="dp-swatches">${swatches.map(h => `
                <button class="dp-swatch-cell" data-hex="${escHtml(h)}" title="${escHtml(tr('detail.copy_hex'))}">
                  <span class="dp-swatch" style="background:${escHtml(h)}"></span>
                  <span class="dp-hex">${escHtml(h.toUpperCase())}</span>
                </button>`).join('')}</div>
            </section>` : ''}

          <section class="dp-section">
            <h3 class="dp-section-label">${tr('detail.tags')}</h3>
            <div class="detail-read-tags" id="dp-read-tags"></div>
            <button class="dp-add-tag" id="dp-add-tag">${I('plus', 14)}<span>${tr('detail.add_tag')}</span></button>
          </section>

          <section class="dp-section">
            <h3 class="dp-section-label">${tr('detail.details')}</h3>
            <dl class="dp-facts">
              <dt>${tr('detail.type')}</dt><dd id="dp-type">${escHtml(typeLabel(item))}</dd>
              ${item.source_url ? `<dt>${tr('detail.source')}</dt><dd><a href="#" class="dp-fact-link" id="dp-fact-source">${escHtml(hostOf(item.source_url))}</a></dd>` : ''}
              <dt>${tr('detail.added')}</dt><dd>${dateStr}</dd>
              <dt>${tr('detail.collection')}</dt><dd id="dp-fact-coll">${escHtml(collectionNames() || '—')}</dd>
            </dl>
          </section>
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
            <button class="detail-delete-btn" id="dp-delete">${tr('action.delete')}</button>
            <div style="flex:1"></div>
            <button class="detail-cancel-btn" id="dp-cancel">${tr('action.cancel')}</button>
            <button class="detail-save-btn"   id="dp-save">${tr('action.save')}</button>
          </div>
        </div>
      </div>
      <p class="dp-hint">${I('arrow-left', 12)}${I('arrow-right', 12)} ${tr('detail.hint_browse')} · <kbd>Esc</kbd> ${tr('detail.hint_close')}</p>`
}

// The panel shows `item` now (a saved crop: the updated item, or the copy). The picture
// and an open crop's controls stay; under is-cropping the new details start hidden and
// fade in as the crop controls fade out.
function swapPanel(item) {
  const panel = modalEl.querySelector('.dp-panel')
  if (!panel) return
  const keep = panel.querySelector('.crop-ui')
  for (const el of [...panel.children]) if (el !== keep) el.remove()
  const tpl = document.createElement('template')
  tpl.innerHTML = panelHtml(item)
  panel.insertBefore(tpl.content, keep)
  void panel.offsetHeight   // their hidden state is computed before is-cropping goes
  bindPanel(item)
}

function bindPanel(item) {
  // Close (while cropping: cancels the crop, the same as Esc)
  modalEl.querySelector('#dp-close').addEventListener('click', onCloseClick)

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

  // Crop starts from view mode: a title typed in Edit is saved first, like its Save
  _panelCtl = {
    editing: () => editPanel.style.display === 'flex',
    saveAndCloseEdit: async () => { await commitTitle(); closeEdit() },
  }

  editToggle.addEventListener('click', () => {
    editPanel.classList.contains('is-open') ? closeEdit() : openEdit()
  })

  const origBtn = modalEl.querySelector('#dp-orig-btn')
  if (origBtn) origBtn.addEventListener('click', () => api.openUrl(item.source_url))
  modalEl.querySelector('#dp-fact-source')?.addEventListener('click', e => {
    e.preventDefault()
    api.openUrl(item.source_url)
  })

  // "Add tag" jumps into edit with the tag field focused
  modalEl.querySelector('#dp-add-tag').addEventListener('click', () => {
    openEdit()
    setTimeout(() => modalEl.querySelector('#dp-tag-search')?.focus(), 220)
  })

  // Click a colour to copy its hex — repeated clicks reuse one toast instead of stacking
  modalEl.querySelectorAll('.dp-swatch-cell').forEach(cell => cell.addEventListener('click', () => {
    navigator.clipboard?.writeText(cell.dataset.hex).then(() =>
      store.emit(events.SYSTEM_TOAST, { type: 'success', message: tr('detail.hex_copied', { hex: cell.dataset.hex.toUpperCase() }), duration: 2000, key: 'hex-copied' })
    ).catch(() => {})
  }))

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
    if (!(await confirmDeleteItem())) return
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

function onCloseClick() {
  if (_crop?.isOpen()) { if (!_crop.isBusy()) _crop.cancel(); return }
  if (_cropOpening) return
  close()
}

// A click on the dark backdrop: while cropping it cancels the crop (the player stays)
function onBackdropClick() {
  if (_crop?.isOpen()) { if (!_crop.isBusy()) _crop.cancel(); return }
  if (_cropOpening) return
  close()
}

// ─── Crop (images only; crop-tool.js) ─────────────────────────────
// A round button with the crop icon, the last of the picture tools (shortcut C). It's
// there for JPEG, PNG and WebP pictures, waits until the picture has loaded and while
// Upscale runs, and goes for one under 64 px on a side (not for a saved crop: crop mode
// is where Restore original is).
function setupCropButton(item) {
  const st = _stage
  if (!st?.tools) return
  st.cropBtn?.remove()
  st.cropBtn = null
  if (!canCrop(item)) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dp-tool-btn'
  btn.title = tr('crop.button')
  btn.setAttribute('aria-label', tr('crop.button'))
  btn.innerHTML = I('crop', 16)
  btn.disabled = true
  btn.addEventListener('click', () => startCrop())
  st.tools.appendChild(btn)
  st.cropBtn = btn
  syncCropButton()
}

function syncCropButton() {
  const st = _stage
  const btn = st?.cropBtn
  const img = st?.img
  if (!btn || !img) return
  if (!img.complete || !img.naturalWidth) { btn.disabled = true; return }
  if (!canCrop(currentItem, img)) { btn.remove(); st.cropBtn = null; return }
  // Not while Upscale runs: its copy is of the picture as it is now
  btn.disabled = !!st.enh?.isWorking()
}

const wait = ms => new Promise(r => setTimeout(r, ms))
const withTimeout = (p, ms) => Promise.race([p, wait(ms)])

// The same picture again, another file (Enhanced ⇄ stored, the item reloaded): the old
// pixels stay on top and fade away once the new file is ready, so nothing blinks.
// Resolves when the new file has loaded.
async function crossfadeImg(img, swap) {
  const ghost = img.cloneNode()
  ghost.removeAttribute('id')
  ghost.classList.add('dp-img-ghost')
  ghost.style.opacity = '1'
  img.after(ghost)
  swap()
  try { await withTimeout(img.decode(), 4000) } catch { /* shown when it loads */ }
  ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reducedMotion() ? 150 : 220, easing: EASE_OUT, fill: 'forwards' })
    .finished.catch(() => {}).finally(() => ghost.remove())
}

async function startCrop() {
  const st = _stage
  if (!st?.img || !st.cropBtn || st.cropBtn.disabled || st.enh?.isWorking() || _crop || _cropOpening) return
  if (!modalEl.classList.contains('open') || isDialogOpen()) return
  const item = currentItem
  _cropOpening = true
  let wasEnhanced = false
  try {
    if (_panelCtl?.editing()) await _panelCtl.saveAndCloseEdit()
    // What you frame is what gets saved: the stored picture, not the Upscaled copy (the
    // same framing, so nothing moves)
    wasEnhanced = !!st.enh?.isShowingEnhanced()
    if (wasEnhanced) await crossfadeImg(st.img, () => st.enh.show(false))
    if (currentItem !== item || _stage !== st || !modalEl.classList.contains('open')) return
    const img = st.img
    if (!img.naturalWidth) return
    if (!canCrop(item, img)) {
      st.cropBtn?.remove(); st.cropBtn = null
      if (wasEnhanced) crossfadeImg(img, () => st.enh.show(true))
      return
    }
    st.nat = { w: img.naturalWidth, h: img.naturalHeight, cap: MAX_UPSCALE }
    st.refit()
    _crop = openCrop({
      item,
      stage: st.el,
      media: st.media,
      panel: modalEl.querySelector('.dp-panel'),
      natW: img.naturalWidth,
      natH: img.naturalHeight,
      closeBtn: modalEl.querySelector('#dp-close'),
      prepare:  (updated, mode) => prepareCrop(updated, mode),
      commit:   c => commitCrop(c),
      restored: r => commitRestore(r),
      reload:   () => reloadForCrop(),
      show:     id => showExisting(id),
      onClose:  reason => cropClosed(reason, wasEnhanced),
    })
    log.info('crop_opened', { id: item.id })
  } finally {
    _cropOpening = false
  }
}

function cropClosed(reason, wasEnhanced) {
  _crop = null
  const st = _stage
  if (reason === 'gone') { close(); return }
  if (!st) return
  // Cancel, or a picture crop can't work on: the Enhanced view comes back if it was on
  const unchanged = reason === 'cancel' || reason === 'unsupported'
  if (unchanged && wasEnhanced && st.enh && currentItem?.enhanced_path) crossfadeImg(st.img, () => st.enh.show(true))
  // A picture crop can't work on loses its button (canCrop remembers it)
  if (reason === 'unsupported') setupCropButton(currentItem)
  requestAnimationFrame(() => {
    if (_stage !== st || _crop) return
    const next = st.cropBtn ?? st.tools?.querySelector('button:not(:disabled)') ?? modalEl.querySelector('#dp-close')
    next?.focus({ preventScroll: true })
  })
}

// Before the saved crop is shown: its picture is loaded and decoded off-screen (and for a
// copy, its tags and collections are read), so the swap happens in one frame
async function prepareCrop(updated, mode) {
  const src = toSrc(updated.stored_path)
  const pre = new Image()
  pre.decoding = 'async'
  pre.src = src
  const [, extra] = await Promise.all([
    withTimeout(pre.decode().catch(() => {}), 4000),
    mode === 'copy'
      ? Promise.all([
          api.getTagsForInspiration(updated.id).catch(() => null),
          api.getCollectionIdsForInspiration(updated.id).catch(() => null),
        ])
      : null,
  ])
  return { src, w: pre.naturalWidth, h: pre.naturalHeight, tags: extra?.[0] ?? null, collectionIds: extra?.[1] ?? null }
}

// Save / Save as copy: the cropped picture grows from where the frame was to its fitted
// place, inside the stage, while the dimmed old picture under it fades away. The panel
// switches to the updated item (or the copy) under the crop controls as they fade.
async function commitCrop({ item: updated, mode, frameRect, prepared, finish }) {
  const st = _stage
  if (!st?.img || !updated) { finish(); return }
  const { el: stage, media, img } = st

  // The old picture, still dimmed outside the frame, as a ghost under the new one
  const ghost = media.cloneNode(true)
  ghost.removeAttribute('id')
  ghost.classList.add('dp-media-ghost')
  for (const v of ['--cx', '--cy', '--cw', '--ch']) ghost.style.setProperty(v, stage.style.getPropertyValue(v))
  const sr = stage.getBoundingClientRect(), mr = media.getBoundingClientRect()
  Object.assign(ghost.style, { left: `${mr.left - sr.left}px`, top: `${mr.top - sr.top}px`, width: `${mr.width}px`, height: `${mr.height}px` })
  stage.insertBefore(ghost, media)

  // The player's own list: a copy goes right after the original (← goes back to it); a
  // replaced item takes its place. The grid's list is never touched.
  itemsList = itemsList.slice()
  if (itemsList[itemIndex]?.id !== currentItem?.id) { itemsList = [currentItem]; itemIndex = 0 }
  if (mode === 'copy') {
    itemsList.splice(itemIndex + 1, 0, updated)
    itemIndex += 1
    if (Array.isArray(prepared?.tags)) currentTags = prepared.tags
    if (Array.isArray(prepared?.collectionIds)) currentCollectionIds = new Set(prepared.collectionIds)
  } else if (itemsList[itemIndex]?.id === updated.id) {
    itemsList[itemIndex] = updated
  }
  currentItem = updated

  swapPanel(updated)
  renderNav()

  // The new picture, in its fitted place…
  img.src = prepared?.src ?? toSrc(updated.stored_path)
  img.alt = updated.title ?? ''
  st.nat = prepared?.w
    ? { w: prepared.w, h: prepared.h, cap: MAX_UPSCALE }
    : { w: (updated.aspect_ratio > 0 ? updated.aspect_ratio : 1) * 1000, h: 1000, cap: MAX_UPSCALE }
  finish()   // the frame and the shade leave the stage in this same frame
  st.refit()
  rebuildTools(updated)

  // …grows there from the frame (FLIP)
  const to = media.getBoundingClientRect()
  const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reducedMotion() ? 150 : 220, easing: EASE_OUT, fill: 'forwards' })
  fade.finished.catch(() => {}).finally(() => ghost.remove())
  if (!reducedMotion() && frameRect?.width && to.width) {
    media.style.transformOrigin = '0 0'
    const grow = media.animate([
      { transform: `translate(${frameRect.left - to.left}px, ${frameRect.top - to.top}px) scale(${frameRect.width / to.width}, ${frameRect.height / to.height})` },
      { transform: 'none' },
    ], { duration: 300, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' })
    grow.finished.catch(() => {}).finally(() => { media.style.transformOrigin = '' })
  } else {
    media.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 })   // reduced motion: a fade, nothing grows
  }

  if (mode === 'copy') {
    store.emit(events.GRID_RELOAD)   // as after an import: the grid shows the copy
    store.emit(events.SYSTEM_TOAST, { type: 'success', message: tr('crop.copied'), duration: 3000 })
  } else {
    store.emit(events.ITEM_FILE_CHANGED, { inspiration: { ...updated }, cause: 'crop' })
  }
  sfx.success?.()
}

// Restore original: the crop UI leaves and the picture crossfades to the original; the
// box takes the original's shape at the crossover, while the picture is hidden
async function commitRestore({ item: updated, finish }) {
  const st = _stage
  if (!st?.img || !updated) { finish(); return }
  const img = st.img
  itemsList = itemsList.slice()
  if (itemsList[itemIndex]?.id === updated.id) itemsList[itemIndex] = updated
  currentItem = updated
  swapPanel(updated)
  finish()

  const src = toSrc(updated.stored_path)
  const pre = new Image()
  pre.src = src
  const reduced = reducedMotion()
  const out = img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 75 : 140, easing: EASE_IN, fill: 'forwards' })
  await Promise.all([out.finished.catch(() => {}), withTimeout(pre.decode().catch(() => {}), 4000)])
  if (_stage !== st || currentItem?.id !== updated.id) { out.cancel(); return }
  img.src = src
  img.alt = updated.title ?? ''
  st.nat = pre.naturalWidth
    ? { w: pre.naturalWidth, h: pre.naturalHeight, cap: MAX_UPSCALE }
    : { w: (updated.aspect_ratio > 0 ? updated.aspect_ratio : 1) * 1000, h: 1000, cap: MAX_UPSCALE }
  st.refit()
  rebuildTools(updated)
  out.cancel()
  img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 75 : 220, easing: EASE_OUT })
  store.emit(events.ITEM_FILE_CHANGED, { inspiration: { ...updated }, cause: 'restore' })
}

// Upscale and Crop for the item's picture now (a crop drops the Upscaled copy; Upscale
// comes back for a small result)
function rebuildTools(item) {
  const st = _stage
  if (!st?.tools || !st.img) return
  st.tools.querySelector('.enh-ctrl')?.remove()
  st.enh = setupEnhanceUI(item, st.img, st.tools, toSrc(item.stored_path), syncCropButton)
  setupCropButton(item)
}

// 'changed': read the item again; the stage shows its picture as it is now
async function reloadForCrop() {
  const st = _stage
  const id = currentItem?.id
  const fresh = id ? await api.getInspiration(id).catch(() => null) : null
  if (!fresh || _stage !== st || currentItem?.id !== id) return null
  currentItem = mergeFresh(currentItem, fresh)
  const src = toSrc(fresh.stored_path)
  if (!sameSrc(src, st.img.src)) {
    await crossfadeImg(st.img, () => { st.img.src = src })
    if (st.img.naturalWidth) { st.nat = { w: st.img.naturalWidth, h: st.img.naturalHeight, cap: MAX_UPSCALE }; st.refit() }
  }
  return { item: currentItem, natW: st.img.naturalWidth, natH: st.img.naturalHeight }
}

// "Already in your library · Show": the item the same crop was saved as before
async function showExisting(id) {
  const i = itemsList.findIndex(x => x.id === id)
  if (i !== -1) { open(itemsList[i], itemsList, i); return }
  const it = await api.getInspiration(id).catch(() => null)
  if (it) open(it, [it], 0)
}

// A fresh record over the one the player was given: list-only fields (a card's collection
// names) aren't in get_inspiration, so they're kept
function mergeFresh(item, fresh) {
  const merged = { ...item, ...fresh }
  if (fresh.collection_names == null && item.collection_names != null) merged.collection_names = item.collection_names
  return merged
}

// ─── Read-only tag pills ──────────────────────────────────────────
// tagLabel: a Tag lens tag shows its name in the app's language, any other tag as typed.
// Tags from suggestions ('lens', and the retired 'model') look like the rest anyway.
function tagClass(t) {
  return t.source === 'lens' || t.source === 'model' ? 'detail-tag--model' : 'detail-tag--user'
}

function renderReadTags() {
  const el = modalEl?.querySelector('#dp-read-tags')
  if (!el) return
  el.innerHTML = currentTags.length
    ? currentTags.map(t =>
        `<span class="detail-tag ${tagClass(t)}">${escHtml(tagLabel(t))}</span>`
      ).join('')
    : ''
}

// ─── Tag list ─────────────────────────────────────────────────────
function renderTagList() {
  const list = modalEl?.querySelector('#dp-tag-list')
  if (!list) return

  list.innerHTML = currentTags.length
    ? currentTags.map(t => `
        <span class="detail-tag ${tagClass(t)}">
          ${escHtml(tagLabel(t))}
          <button class="detail-tag-remove" data-tag-id="${escHtml(String(t.id))}" aria-label="${escHtml(tr('detail.remove_tag', { name: tagLabel(t) }))}">×</button>
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
          <span class="dp-coll-folder">${I('folder', 16)}</span>
          <span class="dp-coll-name">${escHtml(c.name)}</span>
          ${c.locked ? `<span class="dp-coll-lock">${I('lock', 11)}</span>` : `<span class="dp-coll-check">${I('check', 14)}</span>`}
        </button>
      `).join('')
    }

    document.getElementById('overlays').appendChild(popover)

    const rect = btn.getBoundingClientRect()
    popover.style.cssText = `position:fixed;top:${rect.bottom + 6}px;left:${rect.left}px;z-index:500`

    popover.querySelectorAll('.dp-coll-item').forEach(row => {
      row.addEventListener('click', async e => {
        e.stopPropagation()
        if (row.dataset.locked === '1') {
          closePicker()
          store.emit(events.SYSTEM_TOAST, {
            type: 'info',
            message: tr('collection.readonly_toast'),
            duration: 5000,
            key: 'collection-locked',
            action: { label: tr('collections.upgrade'), onClick: () => api.openUrl('https://account.bloot.app/') },
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
          const fact = modalEl.querySelector('#dp-fact-coll')
          if (fact) fact.textContent = collectionNames() || '—'
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

// ─── Tag picker (spec §7) ─────────────────────────────────────────
// Offers the library's tags (your own, imported and Tag lens tags, most used first),
// then the other tags of the Tag lenses that are on, including the ones you add by hand
// (a tag two lenses share is offered once). Typing finds them by their names
// in English and in Uzbek; each shows its name in the app's language. Nothing new can
// be typed into a tag (decision 6): Enter picks the first match. It works whether tag
// suggestions are on or off.
const PICKER_MAX = 8

function bindTagPicker() {
  const searchInput = modalEl.querySelector('#dp-tag-search')
  if (!searchInput) return

  searchInput.addEventListener('focus', () => renderTagSuggestions(searchInput.value))
  searchInput.addEventListener('input', () => renderTagSuggestions(searchInput.value))
  searchInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!searchInput.value.trim()) return
      const first = pickerEntries(searchInput.value)[0]
      if (!first) return   // "No matching tags" is showing
      await pickEntry(first)
      searchInput.value = ''
      renderTagSuggestions('')
    } else if (e.key === 'Escape') {
      searchInput.blur()
      clearSuggestions()
    }
  })
  searchInput.addEventListener('click', e => e.stopPropagation())
  // A click inside the list (its scroll bar, the "No matching tags" line) keeps it open
  modalEl.querySelector('#dp-tag-sug')?.addEventListener('click', e => e.stopPropagation())
  document.addEventListener('click', clearSuggestions)
}

// A concept the installed lenses still have (a newer lens file can retire one)
function isLiveConcept(id) {
  const c = id ? getConcept(id) : null
  return !!c && c.active !== false && c.active !== 0
}

// What typed text and names are compared on: one case, one apostrophe (o' = o‘ = oʻ),
// single spaces
function matchKey(s) {
  return String(s ?? '').normalize('NFC').toLowerCase().replace(/[‘’ʻʼ`´']/g, "'").replace(/\s+/g, ' ').trim()
}

// 0 = the whole name, 1 = its start, 2 = the start of a word in it, 3 = anywhere; 9 = no
function matchRank(names, q) {
  let best = 9
  for (const name of names) {
    const k = matchKey(name)
    if (k === q) return 0
    if (k.startsWith(q)) best = Math.min(best, 1)
    else if (k.split(/[\s/(),.:-]+/).some(w => w.startsWith(q))) best = Math.min(best, 2)
    else if (k.includes(q)) best = Math.min(best, 3)
  }
  return best
}

/** What the picker offers this item for `query`, best match first:
 *  [{ tagId, conceptId, label, names }]. A row with a conceptId goes through
 *  add_concept_tag; any other is an existing tag, linked as it is. */
function pickerEntries(query) {
  const q = matchKey(query)
  const mine       = new Set(currentTags.map(t => t.id))
  const myConcepts = new Set(currentTags.map(tagConceptId).filter(Boolean))
  // A Tag lens tag whose English or Uzbek name the item already has as a people's tag
  // (typed or imported) isn't offered: the item would show the same name twice (§0b.2)
  const peoplesNames = new Set(currentTags
    .filter(t => t.source === 'user' || t.source === 'import')
    .map(t => sameNameKey(t.name)).filter(Boolean))
  const nameTaken  = names => names.some(n => peoplesNames.has(sameNameKey(n)))
  const listed     = new Set()
  const entries    = []
  // One name, one tag (tagging.rs): the one people's tag with the English label of a lens tag
  // that has no tag yet is that tag. One row: picking it goes through add_concept_tag, and Rust
  // links this people's tag (it stands for the concept from then on)
  const untagged = new Map()   // same-name key of the English label → concept
  {
    const tagged = new Set(allTags.map(tagConceptId).filter(Boolean))
    for (const c of visibleConcepts()) if (!tagged.has(c.id)) untagged.set(sameNameKey(conceptLabel(c.id, 'en')), c)
    const people = new Map()
    for (const t of allTags) {
      if (t.source === 'user' || t.source === 'import') people.set(sameNameKey(t.name), (people.get(sameNameKey(t.name)) ?? 0) + 1)
    }
    for (const [k, n] of people) if (n !== 1) untagged.delete(k)
  }
  // The library's tags first, most used first (list_tags' order)
  for (const tag of allTags) {
    if (mine.has(tag.id)) continue
    let cid   = tagConceptId(tag)
    let names = searchLabels(tag)
    const same = !cid && (tag.source === 'user' || tag.source === 'import') ? untagged.get(sameNameKey(tag.name)) : null
    if (same) { cid = same.id; names = [...new Set([...names, ...searchLabels(same)])] }
    if (cid && (myConcepts.has(cid) || nameTaken(names))) continue
    if (cid) listed.add(cid)
    entries.push({ tagId: tag.id, conceptId: isLiveConcept(cid) ? cid : null, label: tagLabel(tag), names })
  }
  // Then the other tags of the Tag lenses that are on, in lens order
  for (const c of visibleConcepts()) {
    if (myConcepts.has(c.id) || listed.has(c.id)) continue
    const names = searchLabels(c)
    if (nameTaken(names)) continue
    entries.push({ tagId: null, conceptId: c.id, label: conceptLabel(c.id), names })
  }
  if (!q) return entries.filter(e => e.label)
  // A match in the name the app shows comes first; a match only in the other language's
  // name after it (4 and up), so Enter never picks a tag whose shown name doesn't match
  const rank = e => {
    const shown = matchRank([e.label], q)
    return shown < 9 ? shown : 4 + matchRank(e.names, q)
  }
  return entries
    .map((e, i) => ({ e, i, rank: rank(e) }))
    .filter(x => x.rank < 9 && x.e.label)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(x => x.e)
}

function renderTagSuggestions(query) {
  const sugEl       = modalEl?.querySelector('#dp-tag-sug')
  const searchInput = modalEl?.querySelector('#dp-tag-search')
  if (!sugEl || !searchInput) return

  const typed   = query.trim()
  const entries = pickerEntries(typed).slice(0, PICKER_MAX)
  if (!entries.length && !typed) { sugEl.innerHTML = ''; sugEl.hidden = true; return }

  // The first match looks hovered while typing: Enter picks it. "No matching tags" is a
  // plain line, not a choice (no hover, no pointer).
  sugEl.innerHTML = entries.length
    ? entries.map((en, i) =>
        `<button class="detail-tag-sug${typed && i === 0 ? ' is-first' : ''}" data-i="${i}">${escHtml(en.label)}</button>`
      ).join('')
    : `<div class="detail-tag-sug detail-tag-sug--empty" role="status">${escHtml(tr('lens.detail.no_match'))}</div>`
  sugEl.hidden = false
  // The list opens right under the field (global.css), on screen (fitSuggestions)
  fitSuggestions(sugEl, searchInput)

  sugEl.querySelectorAll('button.detail-tag-sug').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const entry = entries[Number(btn.dataset.i)]
      if (entry) await pickEntry(entry)
      if (searchInput) searchInput.value = ''
      renderTagSuggestions('')
    })
  })
}

function clearSuggestions() {
  const sugEl = modalEl?.querySelector('#dp-tag-sug')
  if (sugEl) { sugEl.innerHTML = ''; sugEl.hidden = true }
}

// Keeps the list on screen. When it reaches past the bottom of the panel's scroll area, the
// panel scrolls up just enough to show it, but never so far that the field itself goes out
// of view. A list still taller than the room left under the field scrolls inside itself:
// in a short window the panel sits under the picture and has room for about 3 rows.
const SUG_MIN_PX = 72   // two rows
function fitSuggestions(sugEl, input) {
  sugEl.style.maxHeight = ''
  sugEl.scrollTop = 0   // the first match (Enter picks it) shows at the top
  const box = sugEl.closest('.detail-info')
  if (!box) return
  const floor = () => Math.min(box.getBoundingClientRect().bottom, window.innerHeight) - 8
  const over  = sugEl.getBoundingClientRect().bottom - floor()
  if (over <= 0) return
  const room = input.getBoundingClientRect().top - 8 - box.getBoundingClientRect().top
  if (room > 0) box.scrollTop += Math.min(over, room)
  const r = sugEl.getBoundingClientRect()
  if (r.bottom > floor()) sugEl.style.maxHeight = `${Math.max(SUG_MIN_PX, Math.floor(floor() - r.top))}px`
}

// A Tag lens tag goes through add_concept_tag: Rust finds or makes the lens tag (or takes
// your own tag with its name: one name, one tag), links it and counts the card's question
// about it as answered. Any other tag (your own, or one whose lens no longer has it) is
// linked as it is.
async function pickEntry(entry) {
  const item = currentItem
  if (!item) return
  try {
    let tag
    if (entry.conceptId) {
      tag = await api.addConceptTag(item.id, entry.conceptId)
    } else {
      await api.tagInspiration(item.id, entry.tagId)
      tag = allTags.find(t => t.id === entry.tagId) ?? null
    }
    log.info('tag_added', { id: item.id, tag: entry.conceptId ?? tag?.name ?? entry.tagId })
    if (!tag?.id) { await reloadTags(item.id); return }
    // A people's tag the add made its concept's tag (one name, one tag) comes back with the concept
    const at = allTags.findIndex(t => t.id === tag.id)
    if (at === -1) allTags.push(tag)
    else allTags[at] = tag
    // The grid reads this item again: its card may have been asking about this tag
    store.emit(events.TAG_CREATED, { tag, inspirationId: item.id })
    if (currentItem?.id !== item.id) return   // moved on to another item meanwhile
    if (!currentTags.some(t => t.id === tag.id)) currentTags.push(tag)
    renderTagList()
    renderReadTags()
  } catch (err) {
    log.error('tag_add_failed', { id: item.id, tag: entry.conceptId ?? entry.tagId, error: err })
  }
}

// The item's tags and the library's, read again (when an add didn't say what it linked)
async function reloadTags(itemId) {
  const [tags, mine] = await Promise.all([
    api.listTags().catch(() => null),
    api.getTagsForInspiration(itemId).catch(() => null),
  ])
  if (currentItem?.id !== itemId) return
  if (Array.isArray(tags)) allTags = tags
  if (Array.isArray(mine)) currentTags = mine
  renderTagList()
  renderReadTags()
}

// ─── Title save ───────────────────────────────────────────────────
async function saveTitle(value) {
  if (!currentItem) return
  try {
    await api.updateInspiration(currentItem.id, { title: value || '' })   // null would mean "leave it"
    log.info('title_edited', { id: currentItem.id, title: value || '(cleared)' })
    currentItem.title = value || null
    store.emit(events.GRID_ITEM_UPDATED, { inspiration: { ...currentItem } })
  } catch (err) { log.error('title_edit_failed', { id: currentItem.id, error: err }) }
}

// ─── AI enhance (images only) ─────────────────────────────────────
// Overlays the image with a subtle always-on "magic" Enhance button; once enhanced,
// shows an "Enhanced" badge (top-left) and an Original⇄Enhanced toggle. The heavy
// upscale runs on a background thread in Rust, so the UI stays responsive.
// It sits in the picture tools row (`tools`), left of the crop button. → { isShowingEnhanced,
// show(enhanced), isWorking }: crop frames the stored picture and brings the Enhanced view
// back after, and waits while an upscale runs. `onChange` is called when one starts or ends.
function setupEnhanceUI(item, img, tools, origSrc, onChange = null) {
  const LOW_RES_MAX = 1200   // longest side (px); above this an image isn't "low-res" so we don't offer Enhance
  let showingEnhanced = !!item.enhanced_path   // default to the enhanced view once it exists
  let working = false

  const ctrl = document.createElement('div')
  ctrl.className = 'enh-ctrl'
  tools.prepend(ctrl)

  function applyView() {
    const es = item.enhanced_path ? toSrc(item.enhanced_path) : null
    const next = (showingEnhanced && es) ? es : origSrc
    if (!sameSrc(next, img.src)) img.src = next   // the same file again would load it again
    const t = ctrl.querySelector('.enh-toggle')
    if (t) {
      t.querySelector('[data-v="orig"]').classList.toggle('is-active', !showingEnhanced)
      t.querySelector('[data-v="enh"]').classList.toggle('is-active',  showingEnhanced)
    }
  }

  async function onEnhance() {
    const btn = ctrl.querySelector('.enh-btn')
    if (!btn || working) return
    working = true
    const from = item.stored_path
    btn.classList.add('is-working')
    btn.querySelector('.enh-btn-label').textContent = tr('enhance.working')
    onChange?.()
    let path = null, failed = null
    try { path = await api.enhanceImage(item.id) } catch (err) { failed = err }
    working = false
    // The player moved on meanwhile (another item, or this one's picture changed and its
    // tools were built again): the copy is of the picture as it was, so this stage is left
    // alone. The grid card still gets its badge.
    if (!ctrl.isConnected || currentItem?.id !== item.id || currentItem?.stored_path !== from) {
      if (!failed) store.emit(events.GRID_RELOAD)
      return
    }
    if (failed) {
      log.warn('enhance failed:', String(failed))
      btn.classList.remove('is-working')
      btn.classList.add('is-error')
      btn.querySelector('.enh-btn-label').textContent = tr('enhance.failed')
      setTimeout(() => {
        btn.classList.remove('is-error')
        btn.querySelector('.enh-btn-label').textContent = tr('enhance.label')
      }, 2600)
      onChange?.()
      return
    }
    item.enhanced_path = path
    showingEnhanced = true
    renderControl()
    applyView()
    onChange?.()
    sfx.success?.()
    store.emit(events.GRID_RELOAD)   // surface the badge on the grid card too
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
        <span class="icon icon-16" style="mask-image:url('/icons/upscale.svg');-webkit-mask-image:url('/icons/upscale.svg')" aria-hidden="true"></span>
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

  return {
    isShowingEnhanced: () => showingEnhanced && !!item.enhanced_path,
    show(enhanced) { showingEnhanced = !!enhanced; applyView() },
    isWorking: () => working,
  }
}

// ─── Custom video player ──────────────────────────────────────────
// Custom video player: a floating frosted control bar over the video (hides while
// playing and idle), a centre play affordance while paused, and a scrubber with the
// buffered range, a handle and a hover time tip. `onMeta(w, h, duration)` reports the
// real video size so the stage can fit it.
let _fsListener = null   // the open player's fullscreen listener (one player at a time)

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
  // Until the player is gone: a listener on the document would keep every opened video alive
  const onFullscreen = () => {
    if (!wrap.isConnected) { document.removeEventListener('fullscreenchange', onFullscreen); return }
    setFsIcon()
  }
  if (_fsListener) document.removeEventListener('fullscreenchange', _fsListener)
  _fsListener = onFullscreen
  document.addEventListener('fullscreenchange', onFullscreen)

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
  if (fmt && kind !== 'gif') parts.push(fmt.replace('quicktime', 'mov').replace('x-matroska', 'mkv').toUpperCase())
  const d = durationSecs ?? item.duration_secs
  if (kind === 'video' && d) parts.push(fmtDuration(d))
  return parts.join(' · ')
}

/** Names of the collections this item is in, comma-separated. */
function collectionNames() {
  return allCollections.filter(c => currentCollectionIds.has(c.id)).map(c => c.name).join(', ')
}

/** Brand dot for the source line. */
function platformColor(p) {
  return { pinterest: '#E60023', youtube: '#FF0000', instagram: '#E1306C', tiktok: '#25F4EE', behance: '#1769FF', dribbble: '#EA4C89', telegram: '#2AABEE' }[(p || '').toLowerCase()] ?? 'var(--text-muted)'
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
  const autoTags = debugSuggestions(item)
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
        <div class="debug-section-label">Tag lens suggestions</div>
        ${autoTags.length
          ? autoTags.map(({ key, score, label, shown }) =>
              `<div class="debug-conf-row" title="${escHtml(key)}${shown ? '' : ' · not on cards (no lens that is on shows it on this media, or suggestions are off)'}"${shown ? '' : ' style="opacity:0.5"'}>
                <span class="debug-conf-name">${escHtml(label || (key.startsWith('col:') ? 'Collection hint' : readableName(key)))}</span>
                <div class="debug-conf-bar"><div class="debug-conf-fill" style="width:${pct(score)}%"></div></div>
                <span class="debug-conf-pct">${pct(score)}%</span>
              </div>`).join('')
          : '<span class="debug-dim">No suggestions</span>'}
      </div>

      <div class="debug-section">
        <div class="debug-section-label">Metadata</div>
        <table class="debug-table">
          <tr><td>ID</td><td>${escHtml(item.id)}</td></tr>
          <tr><td>Type</td><td>${escHtml(item.type)}${item.mime_type ? ' · ' + escHtml(item.mime_type) : ''}</td></tr>
          <tr><td>Auto-tag model</td><td>${escHtml(item.auto_tag_model ?? '—')}</td></tr>
          <tr><td>Auto-tag status</td><td>${escHtml(item.auto_tag_status ?? '—')}</td></tr>
          <tr><td>Auto-tag sig</td><td>${escHtml(item.auto_tag_sig ?? '—')}</td></tr>
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

// Every stored suggestion key, best score first: its label, and whether this item's card
// shows it (lenses.js's display rule for the item's media; a key of a lens that's off, or
// one no lens shows on this media, stays stored but hidden)
function debugSuggestions(item) {
  const media = mediaOf(item)
  return Object.entries(parseConfidence(item?.auto_tag_confidence))
    .map(([key, score]) => ({ key, score: Number(score) || 0, label: keyLabel(key), shown: isVisibleKey(key, media) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
}

function pct(score) {
  return Math.max(0, Math.min(100, Math.round(score * 100)))
}
