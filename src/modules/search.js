import { convertFileSrc } from '@tauri-apps/api/core'
import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'

const IS_TAURI = '__TAURI_INTERNALS__' in window
const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

let container = null
let filter = { query: '', color: null, type: null, source: null }
let reloadTimer = null

export function init(el) {
  container = el

  store.on(events.NAV_CHANGE, ({ view }) => {
    if (view === 'search') { render(); reload() }
  })
  store.on(events.SEARCH_QUERY_CHANGED, ({ query }) => {
    filter.query = query || ''
    const input = container?.querySelector('.sp-input')
    if (input && input !== document.activeElement) input.value = filter.query
    debounceReload()
  })
  store.on(events.SEARCH_COLOR_CHANGED, ({ hex }) => {
    filter.color = hex || null
    debounceReload()
  })
}

function debounceReload() {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(reload, 200)
}

function render() {
  if (!container) return
  container.innerHTML = `
    <div class="search-page">
      <div class="sp-hero">
        <div class="sp-input-wrap">
          ${I('magnifying-glass', 18)}
          <input class="sp-input" placeholder="Search your library…"
            autocomplete="off" spellcheck="false" value="${escHtml(filter.query ?? '')}" />
        </div>
      </div>
      <div class="sp-filters">
        <div class="sp-filter-row">
          <button class="chip ${!filter.type     ? 'active' : ''}" data-type="">All types</button>
          <button class="chip ${filter.type==='image' ? 'active':''}" data-type="image">Images</button>
          <button class="chip ${filter.type==='video' ? 'active':''}" data-type="video">Videos</button>
          <button class="chip ${filter.type==='link'  ? 'active':''}" data-type="link">Links</button>
        </div>
        <div class="sp-filter-row">
          <button class="chip ${!filter.source      ? 'active':''}" data-source="">All sources</button>
          <button class="chip ${filter.source==='chrome' ? 'active':''}" data-source="chrome">Chrome</button>
          <button class="chip ${filter.source==='local'  ? 'active':''}" data-source="local">Local</button>
        </div>
      </div>
      <div class="sp-results" id="sp-results"></div>
    </div>
  `

  const input = container.querySelector('.sp-input')
  input.addEventListener('input', () => {
    filter.query = input.value.trim()
    store.emit(events.SEARCH_QUERY_CHANGED, { query: filter.query || null })
    debounceReload()
  })

  container.querySelectorAll('[data-type]').forEach(btn =>
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-type]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      filter.type = btn.dataset.type || null
      reload()
    })
  )
  container.querySelectorAll('[data-source]').forEach(btn =>
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-source]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      filter.source = btn.dataset.source || null
      reload()
    })
  )
}

async function reload() {
  const el = container?.querySelector('#sp-results')
  if (!el) return
  try {
    let items = await api.listInspirations({
      query: filter.query || undefined,
      color: filter.color || undefined,
      limit: 120,
    })
    if (filter.type === 'image') items = items.filter(i => i.type === 'image' || i.type === 'gif')
    else if (filter.type)        items = items.filter(i => i.type === filter.type)
    if (filter.source === 'chrome') items = items.filter(i => i.source_platform === 'chrome')
    if (filter.source === 'local')  items = items.filter(i => !i.source_platform)
    renderResults(el, items)
  } catch (err) {
    console.error('[search] reload failed:', err)
  }
}

function renderResults(el, items) {
  el.innerHTML = ''
  if (!items.length) {
    el.innerHTML = `
      <div class="empty-state">
        ${I('magnifying-glass', 32)}
        <span class="empty-state-title">${filter.query ? 'No results' : 'Search your library'}</span>
        <p class="empty-state-body">${filter.query
          ? `Nothing matched &ldquo;${escHtml(filter.query)}&rdquo;`
          : 'Type above, or use the type and source filters.'}</p>
      </div>`
    return
  }
  const grid = document.createElement('div')
  grid.className = 'inspiration-grid'
  items.forEach(item => grid.appendChild(makeCard(item)))
  el.appendChild(grid)
}

function makeCard(item) {
  const card = document.createElement('div')
  card.className = 'card'
  const media = document.createElement('div')
  media.className = 'card-media'

  if (item.type === 'video') {
    const vid = document.createElement('video')
    vid.src = src(item); vid.muted = true; vid.preload = 'metadata'; vid.playsInline = true
    media.appendChild(vid)
    media.addEventListener('mouseenter', () => vid.play().catch(() => {}))
    media.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0 })
  } else {
    const img = document.createElement('img')
    img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false
    img.alt = item.title ?? ''; img.src = src(item)
    img.addEventListener('load',  () => img.classList.add('loaded'), { once: true })
    img.addEventListener('error', () => img.classList.add('loaded'), { once: true })
    media.appendChild(img)
  }

  const overlay = document.createElement('div')
  overlay.className = 'card-hover-overlay'
  overlay.innerHTML = `
    <div class="card-overlay-top"></div>
    ${item.title ? `<div class="card-overlay-title">${escHtml(item.title)}</div>` : ''}
  `
  media.appendChild(overlay)

  card.appendChild(media)
  return card
}

function escHtml(str) {
  if (!str) return ''
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function src(item) {
  const p = item.thumbnail_path ?? item.stored_path
  return IS_TAURI ? convertFileSrc(p) : p
}
