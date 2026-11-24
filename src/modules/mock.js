// Mock data returned when running in the browser (outside Tauri).
// Swap stored_path for picsum URLs so cards render with real-looking images.
// This file is never imported in production — only tauri-api.js uses it.

import { EXT_URL } from './links.js'

const NOW = Date.now()
const DAY = 1000 * 60 * 60 * 24

// ─── Helpers ─────────────────────────────────────────────────────
const img  = (seed, w, h) => `https://picsum.photos/seed/${seed}/${w}/${h}`
const mins = n => NOW - n * 60 * 1000
const hexToRgb = hex => {
  const h = hex?.replace('#', '')
  if (h?.length !== 6) return null
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) }
}
const colorDist = (a, b) => {
  if (!a || !b) return Infinity
  return (a.r-b.r)**2 + (a.g-b.g)**2 + (a.b-b.b)**2
}
const days = n => NOW - n * DAY

// ─── Mock data ───────────────────────────────────────────────────
export const MOCK_SETTINGS = {
  lang: 'en',
  onboarding_state: 'complete',
  theme: 'dark',
  grid_density: 'default',
  accent_color: 'blue',
}
// ?lang=uz | en starts the preview in that language (Settings › Language changes it too)
{
  const l = new URLSearchParams(location.search).get('lang')
  if (l === 'uz' || l === 'en') MOCK_SETTINGS.language = l
}

// Stored Tag lens suggestions (spec §5.4): flat { concept id: score } maps plus a few
// collection hints (col:<tag id>). Every installed lens is scored, on or off; lenses.js
// shows only the keys a lens that's on shows on the item's media. Ids: the Tag lens section
// below. The pictures have aspect 0.8 (mock-17: 1), so they hold picture/any entries without
// the thumbnail lens's 16:9 gate; mock-18 is a video and holds motion's video entries. Items carry
// them in auto_tag_confidence, as the backend sends them (Rust's lens_suggestions column).
const MOCK_SUGGESTIONS = {
  'mock-01': { drone: 0.62, travel: 0.33, nature: 0.41 },
  'mock-02': { minimal: 0.78, product_photo: 0.36, liquid: 0.31 },
  'mock-03': { architecture: 0.58, dark_cinematic: 0.52, 'col:tag-1': 0.5 },
  'mock-04': { product_photo: 0.71, packaging: 0.47, beauty: 0.34, 'col:tag-1': 0.5 },
  'mock-05': { retro: 0.66, collage: 0.34, 'col:tag-2': 0.5 },
  'mock-07': { poster: 0.57, typography: 0.49 },
  'mock-08': { packaging: 0.74, typography: 0.38, map: 0.31 },
  'mock-10': { particles: 0.44, render_3d: 0.37 },
  'mock-11': { typography: 0.61, minimal: 0.52, poster: 0.33 },
  'mock-12': { portrait: 0.69, finance: 0.34, dark_cinematic: 0.38 },
  'mock-13': { illustration: 0.55, render_3d: 0.48 },
  'mock-15': { collage: 0.43, documentary: 0.42, minimal: 0.39 },
  'mock-16': { portrait: 0.47, gaming: 0.38, y2k: 0.35 },
  'mock-18': { typography: 0.61, music_video: 0.48 },
}

// Varied w×h gives each card a different natural height → real masonry effect
export const MOCK_INSPIRATIONS = [
  { id: 'mock-01', type: 'image', title: 'Mountain sunset',    stored_path: img('sunset',   400, 267), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: 'chrome', created_at: mins(5),  updated_at: mins(5)  },
  { id: 'mock-02', type: 'image', title: 'Minimal workspace',  stored_path: img('desk',     400, 500), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: null,     created_at: mins(30), updated_at: mins(30) },
  { id: 'mock-03', type: 'image', title: null,                 stored_path: img('city',     400, 600), mime_type: 'image/png',  ocr_text: '',  ocr_status: null,   source_platform: null,     created_at: days(1),  updated_at: days(1)  },
  { id: 'mock-04', type: 'image', title: 'Product reel',       stored_path: img('reel',     400, 300), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: 'chrome', created_at: days(2),  updated_at: days(2)  },
  { id: 'mock-05', type: 'image', title: 'Color palette ref',  stored_path: img('palette',  400, 480), mime_type: 'image/webp', ocr_text: '',  ocr_status: 'done', source_platform: null,     created_at: days(2),  updated_at: days(2)  },
  { id: 'mock-06', type: 'image', title: 'Loading animation',  stored_path: img('loader',   400, 400), mime_type: 'image/gif',  ocr_text: '',  ocr_status: null,   source_platform: 'chrome', created_at: days(3),  updated_at: days(3)  },
  { id: 'mock-07', type: 'image', title: null,                 stored_path: img('type',     400, 560), mime_type: 'image/jpeg', ocr_text: 'Design is intelligence made visible', ocr_status: 'done', source_platform: null, created_at: days(4), updated_at: days(4) },
  { id: 'mock-08', type: 'image', title: 'Brand identity',     stored_path: img('brand',    400, 320), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: 'chrome', created_at: days(5),  updated_at: days(5)  },
  { id: 'mock-09', type: 'image', title: null,                 stored_path: img('arch',     400, 250), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: null,   source_platform: null,     created_at: days(6),  updated_at: days(6)  },
  { id: 'mock-10', type: 'image', title: 'Motion study',       stored_path: img('motion',   400, 540), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: null,     created_at: days(7),  updated_at: days(7)  },
  { id: 'mock-11', type: 'image', title: 'Editorial layout',   stored_path: img('edit',     400, 460), mime_type: 'image/png',  ocr_text: '',  ocr_status: 'done', source_platform: null,     created_at: days(8),  updated_at: days(8)  },
  { id: 'mock-12', type: 'image', title: null,                 stored_path: img('portrait', 400, 580), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: 'chrome', created_at: days(10), updated_at: days(10) },
  { id: 'mock-13', type: 'image', title: 'Abstract forms',     stored_path: img('abstract', 400, 440), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: null,     created_at: days(11), updated_at: days(11) },
  { id: 'mock-14', type: 'image', title: null,                 stored_path: img('nature',   400, 280), mime_type: 'image/webp', ocr_text: '',  ocr_status: null,   source_platform: 'chrome', created_at: days(12), updated_at: days(12) },
  { id: 'mock-15', type: 'image', title: 'Layout study',       stored_path: img('layout',   400, 520), mime_type: 'image/png',  ocr_text: '',  ocr_status: 'done', source_platform: null,     created_at: days(14), updated_at: days(14) },
  { id: 'mock-16', type: 'image', title: null,                 stored_path: img('people',   400, 350), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: null,     created_at: days(15), updated_at: days(15) },
  // Saved square, the way the extension used to save every picture: a tall poster that a
  // preview must never cut (media-shape.js shows it whole and saves its real shape)
  { id: 'mock-17', type: 'image', title: 'Tall poster',        stored_path: img('poster',   400, 800), mime_type: 'image/jpeg', ocr_text: '',  ocr_status: 'done', source_platform: 'chrome', aspect_ratio: 1, created_at: days(16), updated_at: days(16) },
  // A video, so the cards show what a lens suggests on videos (§0c). Its poster is a picture:
  // hovering tries to play it and quietly fails, which the preview accepts
  { id: 'mock-18', type: 'video', title: 'Title sequence',     stored_path: img('titles',   640, 360), thumbnail_path: img('titles', 640, 360), mime_type: 'video/mp4', duration_secs: 12, aspect_ratio: 1.78, ocr_text: '', ocr_status: null, source_platform: null, created_at: days(17), updated_at: days(17) },
].map(item => ({
  thumbnail_path: null, aspect_ratio: 0.8, has_original: false, enhanced_path: null,
  file_hash: null, phash: null, phash_source: null, vault_id: null,
  source_url: null, palette: null, ocr_language: null,
  auto_tag_status: 'done',
  auto_tag_confidence: MOCK_SUGGESTIONS[item.id] ? JSON.stringify(MOCK_SUGGESTIONS[item.id]) : null,
  auto_tag_model: 'lens-1',
  auto_tag_sig: 'mock0lens0sig001',
  ...item,
}))

export const MOCK_COLLECTIONS = [
  { id: 'col-1', name: 'Branding',    visible_on_home: true,  created_at: days(30), updated_at: days(1) },
  { id: 'col-2', name: 'Typography',  visible_on_home: true,  created_at: days(25), updated_at: days(3) },
  { id: 'col-3', name: 'UI Patterns', visible_on_home: false, created_at: days(20), updated_at: days(5) },
]

// Tags people typed stay as typed (also one that stands for a concept: one name, one tag); lens
// tags (source 'lens', concept_id set) show their concept's label in the app's language —
// listTags joins `labels` like the backend. A lens tag is
// stored under its English label ("<label> (Tag lens)" while another tag has that name): what
// older versions show, never an id (an earlier build stored 'lens:<concept id>').
export const MOCK_TAGS = [
  { id: 'tag-1', name: 'minimal',            source: 'user', concept_id: null,           created_at: days(10), usage_count: 7 },
  { id: 'tag-2', name: 'typography',         source: 'user', concept_id: null,           created_at: days(9),  usage_count: 5 },
  { id: 'tag-3', name: 'Cinematic',          source: 'lens', concept_id: 'dark_cinematic', created_at: days(8),  usage_count: 3 },
  { id: 'tag-4', name: 'dark-mode',          source: 'user', concept_id: null,           created_at: days(7),  usage_count: 2 },
  { id: 'tag-5', name: 'Product shot',       source: 'lens', concept_id: 'product_photo', created_at: days(6),  usage_count: 1 },
  { id: 'tag-6', name: 'Poster',             source: 'lens', concept_id: 'poster',        created_at: days(5),  usage_count: 1 },
  // A tag no lens has any more keeps its name (§0c), also one of the thumbnail lens v1 whose id
  // has an underscore (stock_chart); one added by hand ("suggest": false)
  { id: 'tag-7', name: 'Mascot',             source: 'lens', concept_id: 'mascot',        created_at: days(4),  usage_count: 1 },
  { id: 'tag-11', name: 'Stock chart',       source: 'lens', concept_id: 'stock_chart',   created_at: days(4),  usage_count: 1 },
  { id: 'tag-8', name: 'Titles',             source: 'lens', concept_id: 'titles',        created_at: days(3),  usage_count: 1 },
  // One name, one tag: someone's own "ui" and the lens tag of UI, stored "UI (Tag lens)" while both
  // existed. The start makes them one tag (mockJoinSameNameTags): the people's "ui", which shows
  // the label UI. "minimal" and "typography" have lens labels too, but no lens tag yet: Add links them
  { id: 'tag-9',  name: 'ui',                source: 'user', concept_id: null,           created_at: days(2),  usage_count: 1 },
  { id: 'tag-10', name: 'UI (Tag lens)',     source: 'lens', concept_id: 'ui_design',    created_at: days(1),  usage_count: 3 },
]

// Mock tag assignments per inspiration
const MOCK_INSPIRATION_TAGS = {
  'mock-01': ['tag-1'],
  'mock-02': ['tag-1', 'tag-2'],
  'mock-07': ['tag-2'],
  'mock-08': ['tag-5'],
  'mock-10': ['tag-3'],
  'mock-11': ['tag-10'],
  'mock-12': ['tag-11'],
  'mock-13': ['tag-7'],
  'mock-15': ['tag-9', 'tag-10'],
  'mock-16': ['tag-10'],
  'mock-17': ['tag-6'],
  'mock-18': ['tag-8'],
}

export const MOCK_IMPORT_RESULT = { imported: [], skipped: [], existing: [] }

// ─── Mock API ────────────────────────────────────────────────────
// Each function mirrors the signature of the real api.* method.

let _inspirations = [...MOCK_INSPIRATIONS]
// ─── Notifications under the bell (design preview of announcements.rs) ──
// Four samples as announcements_list returns them: a pinned tip (read), news with a picture
// and a link button, an update with a screen button and a long message (More), an offer that
// pops up — 3 unread.
//  • ?ann=fresh: nothing cached yet — the first open shows skeleton cards until the check answers
//  • ?ann=empty: the server has nothing — the empty state
//  • ?ann=offline: every check fails — the cache stays, no error
//  • ?ann=popped: the offer popped up in an earlier session — no pop-up, still 3 unread
const _annMode = new URLSearchParams(location.search).get('ann') || ''
const ANN_PICTURE = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0338FA"/><stop offset="1" stop-color="#0A0A0A"/></linearGradient></defs>' +
  '<rect width="1200" height="600" fill="url(#g)"/>' +
  '<g fill="none" stroke="#F2F2F0" stroke-opacity=".2" stroke-width="2"><circle cx="900" cy="300" r="230"/><circle cx="900" cy="300" r="150"/><circle cx="900" cy="300" r="70"/></g>' +
  '<rect x="96" y="230" width="420" height="48" rx="24" fill="#F2F2F0" fill-opacity=".92"/>' +
  '<rect x="96" y="306" width="300" height="20" rx="10" fill="#F2F2F0" fill-opacity=".45"/></svg>')
const annSamples = () => [
  { id: 'ann_pinnedtip0000001', kind: 'tip', pinned: true, popup: false, read: true, seen: true, popped: false, test: false,
    title: { en: 'Find anything by colour', uz: 'Istalgan narsani rang bo‘yicha toping' },
    body: { en: 'Click the colour wheel in the search bar and pick a colour — qooti shows every picture that has it.', uz: 'Qidiruv qatoridagi rang g‘ildiragini bosing va rang tanlang — qooti shu rangli barcha rasmlarni ko‘rsatadi.' },
    button: null, image: null, published_at: days(6), ends_at: null },
  { id: 'ann_offerpro00000001', kind: 'offer', pinned: false, popup: true, read: false, seen: false, popped: false, test: false,
    title: { en: 'Get more with Pro', uz: 'Pro bilan ko‘proq imkoniyat' },
    body: { en: 'Unlimited items and collections, every Tag lens, and downloads without a daily limit.', uz: 'Cheksiz elementlar va to‘plamlar, barcha Tag lens’lar va kunlik cheklovsiz yuklab olish.' },
    button: { label: { en: 'Upgrade to Pro', uz: 'Pro’ga o‘tish' }, action: 'screen', target: 'upgrade' },
    image: null, published_at: mins(20), ends_at: null },
  { id: 'ann_newsextension001', kind: 'news', pinned: false, popup: false, read: false, seen: false, popped: false, test: false,
    title: { en: 'The qooti extension got faster', uz: 'qooti kengaytmasi tezlashdi' },
    body: { en: 'Save from YouTube, Pinterest and Instagram in one click.\nPick a collection right on the page.', uz: 'YouTube, Pinterest va Instagram’dan bir bosishda saqlang.\nTo‘plamni shu sahifaning o‘zida tanlang.' },
    button: { label: { en: 'Get the extension', uz: 'Kengaytmani olish' }, action: 'link', target: EXT_URL },
    image: { src: ANN_PICTURE, w: 1200, h: 600 }, published_at: mins(125), ends_at: null },
  { id: 'ann_updatetaglens001', kind: 'update', pinned: false, popup: false, read: false, seen: false, popped: false, test: false,
    title: { en: 'Tag lens is here', uz: 'Tag lens keldi' },
    body: { en: 'qooti now suggests tags for what you save, tuned to the work you do.\n\nPick the lens that fits you — motion, design or thumbnails — and qooti looks through your library in the background.\n\nYou decide: every suggestion waits for a click.\nTurn it on in Settings.', uz: 'qooti endi saqlaganlaringizga ishingizga mos teglar taklif qiladi.\n\nO‘zingizga mos lensni tanlang — motion, dizayn yoki thumbnail — qooti kutubxonangizni orqa fonda ko‘rib chiqadi.\n\nQarorni siz qabul qilasiz: har bir taklif bosishingizni kutadi.\nUni Sozlamalarda yoqing.' },
    button: { label: { en: 'Open settings', uz: 'Sozlamalarni ochish' }, action: 'screen', target: 'settings:library' },
    image: null, published_at: days(1), ends_at: null },
]
let _ann = _annMode === 'fresh' || _annMode === 'empty' ? [] : annSamples()
if (_annMode === 'popped') for (const a of _ann) a.popped = true
let _annLastSync = _ann.length ? mins(40) : null
const annList = synced => {
  const items = _ann.map(a => ({ ...a }))
    .sort((a, b) => (b.pinned - a.pinned) || (b.published_at - a.published_at))
  return { items, unread: items.filter(a => !a.read).length, last_sync: _annLastSync, next_check_s: 1800, synced }
}

export const mockApi = {
  getAppInfo:    () => Promise.resolve({ platform: 'web-mock', version: '1.0.0-dev' }),
  getSettings:   () => Promise.resolve({ ...MOCK_SETTINGS }),
  setSetting:    (key, value) => {
    MOCK_SETTINGS[key] = value
    // Like set_setting: turning suggestions on wakes the tagger (the preview's scan)
    if (key === 'tag_recommendations_enabled' && value === 'true') mockLensScan()
    return Promise.resolve()
  },

  windowMinimize:  () => Promise.resolve(),
  windowMaximize:  () => Promise.resolve(),
  windowClose:     () => Promise.resolve(),

  getAutostart:    ()  => Promise.resolve(false),
  setAutostart:    ()  => Promise.resolve(),

  listInspirations: (opts = {}) => {
    let items = [..._inspirations]
    if (opts.query) {
      const q = opts.query.toLowerCase()
      items = items.filter(i => {
        if (i.title?.toLowerCase().includes(q)) return true
        if (i.ocr_text?.toLowerCase().includes(q)) return true
        // Accepted tags only (never open suggestions): lens tags by their EN/UZ labels
        const tagIds = MOCK_INSPIRATION_TAGS[i.id] ?? []
        return MOCK_TAGS.some(t => tagIds.includes(t.id) && mockTagNames(t).some(n => n.toLowerCase().includes(q)))
      })
    }
    if (opts.uncollected) {
      const inCols = ['mock-01','mock-02','mock-03','mock-04','mock-05','mock-06','mock-07','mock-08']
      items = items.filter(i => !inCols.includes(i.id))
    }
    // A tag chip: items with ALL the given tags, like list_inspirations
    if (opts.tag_ids?.length) {
      items = items.filter(i => opts.tag_ids.every(tagId => (MOCK_INSPIRATION_TAGS[i.id] ?? []).includes(tagId)))
    }
    if (opts.collection_id) {
      // Mock: collections 1 contains first 4, col 2 contains 5-8
      const slices = { 'col-1': ['mock-01','mock-02','mock-03','mock-04'], 'col-2': ['mock-05','mock-06','mock-07','mock-08'] }
      const allowed = slices[opts.collection_id] ?? []
      items = items.filter(i => allowed.includes(i.id))
    }
    if (opts.color_filter) {
      const target = hexToRgb(opts.color_filter)
      const threshold = opts.color_tolerance === 'strict' ? 3000
                      : opts.color_tolerance === 'broad'  ? 50000
                      : 20000
      if (target) {
        items = items.filter(i => {
          if (!i.palette) return false
          const palette = typeof i.palette === 'string' ? JSON.parse(i.palette) : i.palette
          return palette.some(c => colorDist(hexToRgb(c), target) <= threshold)
        })
      }
    }
    const limit = opts.limit ?? 80
    const page  = opts.page ?? 0
    // Copies, like the app's IPC: what the page changes in its own lists isn't saved
    // until it calls a command (set_item_aspect, update_inspiration, …)
    return Promise.resolve(items.slice(page * limit, page * limit + limit).map(mockPublic))
  },

  getInspiration: id => Promise.resolve(mockPublic(_inspirations.find(i => i.id === id))),

  // set_item_aspect: 0.05–20, saved only when it differs by more than 1 %; clears the
  // tag signature so the Tag lens shape rules look again → true when saved
  setItemAspect: (id, ratio) => {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.05 || ratio > 20) return Promise.reject('bad_ratio')
    const item = _inspirations.find(i => i.id === id)
    if (!item || !(Math.abs((item.aspect_ratio ?? 0) - ratio) > 0.01 * ratio)) return Promise.resolve(false)
    item.aspect_ratio = ratio
    item.auto_tag_sig = null
    return Promise.resolve(true)
  },

  // Crop in the image player — the canvas section near the end of this file
  cropImage:       opts => mockCropImage(opts),
  restoreOriginal: id   => mockRestoreOriginal(id),

  updateInspiration: (id, fields) => {
    const item = _inspirations.find(i => i.id === id)
    if (item && fields.title !== undefined) item.title = fields.title
    return Promise.resolve()
  },

  deleteInspiration: id => {
    _inspirations = _inspirations.filter(i => i.id !== id)
    delete MOCK_INSPIRATION_TAGS[id]
    return Promise.resolve()
  },

  findDuplicates: () => {
    if (!new URLSearchParams(location.search).get('dups')) return Promise.resolve([])
    const copy = i => ({ id: i.id, kind: i.type, title: i.title, thumb: i.thumbnail_path ?? i.stored_path, created_at: i.created_at, collections: null })
    const pick = (from, n) => _inspirations.slice(from, from + n).map(copy).sort((a, b) => a.created_at - b.created_at)
    return Promise.resolve([
      { reason: 'exact',     distance: 0, items: pick(0, 3) },
      { reason: 'potential', distance: 0, items: pick(3, 2) },
    ].filter(g => g.items.length > 1))
  },
  markNotDuplicates: () => Promise.resolve(),

  importFiles: paths => {
    const NOW2 = Date.now()
    // A path naming an existing sample item ("…/mock-03.jpg") counts as already in the
    // library — like the real app does for identical files
    const existing = paths.map(p => _inspirations.find(i => p.includes(i.id))?.id).filter(Boolean)
    paths = paths.filter(p => !_inspirations.some(i => p.includes(i.id)))
    const imported = paths.map((p, idx) => {
      const id = `import-${NOW2}-${idx}`
      const item = { id, type: 'image', title: null, stored_path: img(id, 400, 500), thumbnail_path: null, aspect_ratio: 0.80, mime_type: 'image/jpeg', ocr_text: '', ocr_status: null, source_platform: null, source_url: null, palette: null, ocr_language: null, file_hash: null, phash: null, phash_source: null, vault_id: null, created_at: NOW2, updated_at: NOW2 }
      _inspirations.unshift(item)
      return item
    })
    return Promise.resolve({ imported, skipped: [], existing })
  },

  readImageAsBase64: () => Promise.resolve(''),

  claimOcrCandidates:  () => Promise.resolve([]),
  finalizeOcrResult:   () => Promise.resolve(),
  resetOcrStatus:      () => Promise.resolve(),
  queueFullOcrReindex: () => Promise.resolve(),
  getOcrStats:         () => Promise.resolve({ total: 12, done: 8, pending: 4, failed: 0, skipped: 0 }),

  listCollections:      ()     => Promise.resolve([...MOCK_COLLECTIONS]),
  createCollection:     name   => { const c = { id: `col-${Date.now()}`, name, visible_on_home: true, created_at: Date.now(), updated_at: Date.now() }; MOCK_COLLECTIONS.push(c); return Promise.resolve(c) },
  updateCollection:     ()     => Promise.resolve(),
  deleteCollection:     ()     => Promise.resolve(),
  exportCollection:     ()     => Promise.resolve(),
  getCollectionIdsForInspiration: () => Promise.resolve([]),
  addToCollection:      ()     => Promise.resolve(),
  removeFromCollection: ()     => Promise.resolve(),

  listTags: () => {
    // Compute usage_count live from MOCK_INSPIRATION_TAGS, then sort descending
    const tags = MOCK_TAGS.map(mockTagRow)
      .sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name))
    return Promise.resolve(tags)
  },
  getTagsForInspiration: id => {
    const ids = MOCK_INSPIRATION_TAGS[id] ?? []
    return Promise.resolve(MOCK_TAGS.filter(t => ids.includes(t.id)).map(mockTagRow))
  },
  createTag: (name, source) => {
    // Like create_tag: a lens tag whose label is the name becomes this people's tag, in place (one
    // name, one tag); otherwise a lens tag stored under that name moves on
    const lens = mockLensTagForPeoplesName(name)
    if (lens) {
      mockMakeRoomFor(name, lens.id)
      Object.assign(lens, { name, source: source ?? 'user' })
      return Promise.resolve(mockTagRow(lens))
    }
    const tag = { id: `tag-${Date.now()}`, name, source: source ?? 'user', concept_id: null, created_at: Date.now(), usage_count: 0 }
    mockMakeRoomFor(name)
    MOCK_TAGS.push(tag)
    return Promise.resolve(mockTagRow(tag))
  },
  deleteTag: id => {
    const at = MOCK_TAGS.findIndex(t => t.id === id)
    if (at !== -1) MOCK_TAGS.splice(at, 1)
    for (const k of Object.keys(MOCK_INSPIRATION_TAGS)) MOCK_INSPIRATION_TAGS[k] = MOCK_INSPIRATION_TAGS[k].filter(t => t !== id)
    return Promise.resolve()
  },
  // Like tag_item: a lens tag goes through the answer path; any other tag's own collection
  // hint goes, and so do the item's questions that ask the name it now has (spec §0b.2)
  tagInspiration: (insId, tagId) => {
    const tag = MOCK_TAGS.find(t => t.id === tagId)
    if (tag?.concept_id && mockConcept(tag.concept_id)) {
      return mockAnswerSuggestion(insId, tag.concept_id, 'added')
        .then(t => t ? undefined : Promise.reject('the item already has a tag with that name'))
    }
    if (!MOCK_INSPIRATION_TAGS[insId]) MOCK_INSPIRATION_TAGS[insId] = []
    if (!MOCK_INSPIRATION_TAGS[insId].includes(tagId)) MOCK_INSPIRATION_TAGS[insId].push(tagId)
    const item = _inspirations.find(i => i.id === insId)
    if (item) {
      const conf = mockConf(item)
      if (`col:${tagId}` in conf) { delete conf[`col:${tagId}`]; item.auto_tag_confidence = JSON.stringify(conf) }
      mockDropNamedLike(item, tagId)
    }
    return Promise.resolve()
  },
  untagInspiration: (insId, tagId) => {
    if (MOCK_INSPIRATION_TAGS[insId]) {
      MOCK_INSPIRATION_TAGS[insId] = MOCK_INSPIRATION_TAGS[insId].filter(id => id !== tagId)
    }
    return Promise.resolve()
  },

  reindexLibrary: () => Promise.resolve({ tags_rebuilt: MOCK_TAGS.length, media_requeued: _inspirations.filter(i => i.type === 'image').length }),
  extractPalette: () => Promise.resolve([]),

  getVaultInfo: () => Promise.resolve({ path: '~/Library/Application Support/app.bloot.qooti/vault', total_items: 16, size_bytes: 52428800 }),

  getLicenseCache:   () => Promise.resolve(null),
  // bloot apps account — ?hub=pro (default) | free | signed_out | expired | missing
  hubPrepare: () => Promise.resolve(),
  hubAccount: () => Promise.resolve(mockHubAccount()),
  hubOpen:    () => { _mockHub = 'pro'; return Promise.resolve() },
  hubRefresh: () => Promise.resolve(mockHubAccount()),
  clearLicenseCache: () => Promise.resolve(),
  listMilestones:  () => Promise.resolve([]),
  getFreePlanInfo: () => Promise.resolve({
    item_total: _inspirations.length, item_limit: 200, collections_used: MOCK_COLLECTIONS.length, collections_limit: 3,
    is_free: _mockHub === 'free', ext_limit: _mockHub === 'free' ? 10 : 4294967295, ext_used_today: 0,
  }),

  // Links from the browser (browser-queue.js) — ?bq=4 | 42 (none by default)
  browserQueueList:   () => Promise.resolve(_bq.map(i => ({ ...i }))),
  browserQueueStart:  picks => {
    const ids = new Set(picks.map(p => p.id))
    _bq = _bq.filter(i => !ids.has(i.id))
    const later = _mockHub === 'free' ? Math.max(0, picks.length - 10) : 0
    return Promise.resolve({ started: picks.length - later, already: 0, later })
  },
  browserQueueRemove: ids => { _bq = _bq.filter(i => !ids.includes(i.id)); return Promise.resolve() },

  announcementsList:       () => Promise.resolve(annList(false)),
  announcementsSync:       _lang => new Promise(resolve => setTimeout(() => {
    if (_annMode === 'offline') return resolve(annList(false))
    if (_annMode === 'fresh' && !_ann.length) _ann = annSamples()   // the first check brings them
    _annLastSync = Date.now()
    resolve(annList(true))
  }, _annMode === 'fresh' ? 2500 : 600)),
  announcementsEvent:      (id, kind) => {
    const a = _ann.find(i => i.id === id)
    if (a && kind === 'seen') { a.seen = true; a.read = true }
    console.debug(`[mock] announcement ${kind}: ${id}`)
    return Promise.resolve()
  },
  announcementsMarkRead:   ids => { for (const a of _ann) if (ids.includes(a.id)) a.read = true; return Promise.resolve(ids.length) },
  announcementsMarkPopped: id => { const a = _ann.find(i => i.id === id); if (a) a.popped = true; return Promise.resolve() },

  getMobileConnectionQr: () => Promise.resolve('MOCK-QR-KEY'),
  resetMobileConnectionKey: () => Promise.resolve('MOCK-QR-KEY'),
  answerExtensionPair:  () => Promise.resolve(),
  extensionPageReady:   () => Promise.resolve([]),
  listExtensionClients: () => Promise.resolve([{ origin: 'chrome-extension://mock', browser: 'Edge', approved_at: Date.now() - 86400000 }]),
  removeExtensionClient: () => Promise.resolve(),

  // Tag lens (spec §6.3) — data and behaviour in the Tag lens section at the end
  listLenses:       ()                           => Promise.resolve(mockLensRows()),
  listConcepts:     ()                           => Promise.resolve(mockConceptRows()),
  setLensEnabled:   (id, enabled)                => mockSetLensEnabled(id, enabled),
  applyRole:        role                         => mockApplyRole(role),
  installLenses:    files                        => mockInstallLenses(files),
  lensStatus:       ()                           => Promise.resolve(mockLensStatus()),
  lensStatusWatch:  on                           => { _lensWatched = !!on; return Promise.resolve(null) },
  getSuggestionMaps: ids                         => mockSuggestionMaps(ids),
  // lensId (the lens that showed the row) only goes into Rust's answer record
  answerSuggestion: (inspirationId, key, answer, lensId) => mockAnswerSuggestion(inspirationId, key, answer),
  addConceptTag:    (inspirationId, conceptId)   => mockAnswerSuggestion(inspirationId, conceptId, 'added'),
  retagAll:         ()                           => mockRetagAll(),
  taggingWake:      ()                           => Promise.resolve(),
  // Mock only: lenses.js asks this instead of the network for the lens catalogue
  mockFetch:        url                          => mockLensFetch(url),
  copyFileToFolder:     () => Promise.resolve(''),
  revealInFolder:       () => Promise.resolve(),

  finalizeDownload: (path, _url) => {
    const NOW2 = Date.now()
    const id   = `dl-${NOW2}`
    const item = { id, type: 'video', title: null, stored_path: path, thumbnail_path: null, aspect_ratio: 1.78, mime_type: 'video/mp4', ocr_text: '', ocr_status: null, source_platform: null, source_url: null, palette: null, ocr_language: null, file_hash: null, phash: null, phash_source: null, vault_id: null, created_at: NOW2, updated_at: NOW2 }
    _inspirations.unshift(item)
    return Promise.resolve(item)
  },

  cancelDownload: _id => Promise.resolve(),

  analyzeImportSource:   _path => Promise.resolve({ source_type: 'notion', media_count: 5, display_name: 'Mock Export' }),
  extractImportArchive:  (_path, _type) => Promise.resolve([]),
  importQooTiPack:       _path => Promise.resolve({ collection_id: 'mock-col', collection_name: 'Mock', imported_count: 0, skipped_count: 0 }),
  fetchYoutubeThumbnail: _url => Promise.resolve('/mock/thumb.jpg'),

  trackView:                     _id  => Promise.resolve(),
  applyCollectionTagSuggestions: ()   => Promise.resolve(0),
  listRediscover:                ()   => Promise.resolve([]),
  listBecauseYouViewed:          ()   => Promise.resolve([]),
  listHaventSeen:                ()   => Promise.resolve([]),
  // Stable for a given shuffle number, different for the next one (like reco.rs)
  tasteOrder: (ids, shuffle = 0) => {
    const h = s => [...s].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 16777619), 2166136261 ^ shuffle * 2654435761) >>> 0
    return Promise.resolve(shuffle ? ids.slice().sort((a, b) => h(a) - h(b)) : ids)
  },
  diagnosticsSnapshot:           ()   => Promise.reject(new Error('no backend in browser mode')),
  logFrontend:                   ()   => Promise.resolve(),
  // History (activity-view.js): the items as downloads and imports, newest first, without files
  // (placeholders); the last source is one this version doesn't know: it shows as "Unknown"
  listActivity: limit => Promise.resolve({ entries: _inspirations.slice(0, limit ?? 300).map((it, i) => ({
    kind: 'media', id: it.id, type: it.type, title: it.title, thumbnail_path: null, stored_path: null,
    source_platform: it.source_platform, created_at: it.created_at,
    import_source: ['file_import', 'extension', 'app_download', 'crop_copy', 'shared_link'][i % 5],
  })) }),
  // Preview: any link containing "dup" counts as already saved
  checkUrlExists:                url => Promise.resolve(/dup/.test(url) ? (_inspirations[0] ?? null) : null),
  openUrl:                       _url => Promise.resolve(),

  listBoards:            ()   => Promise.resolve([]),
  createBoard:           name => Promise.resolve({ id: `board-${Date.now()}`, name: name || 'Untitled board', doc: '{}', created_at: Date.now(), updated_at: Date.now(), thumb: null, element_count: 0 }),
  renameBoard:           ()   => Promise.resolve(),
  deleteBoard:           ()   => Promise.resolve(),
  getBoard:              id   => Promise.resolve({ id, name: 'Untitled board', doc: '{}', created_at: Date.now(), updated_at: Date.now(), assets_dir: '' }),
  saveBoard:             ()   => Promise.resolve(),
  addBoardAssetFromPath: ()   => Promise.resolve({ asset: 'mock.png', abs: '/mock/mock.png' }),
  addBoardAssetFromData: ()   => Promise.resolve({ asset: 'mock.png', abs: '/mock/mock.png' }),
  exportBoard:           ()   => Promise.resolve(),
  importBoard:           ()   => Promise.resolve({ id: `board-${Date.now()}`, name: 'Imported board', created_at: Date.now(), updated_at: Date.now(), thumb: null, element_count: 0 }),

  getVaultInfo:    () => Promise.resolve({
    path: 'C:\\Users\\Dev\\AppData\\Roaming\\qooti\\vault',
    default_path: 'C:\\Users\\Dev\\AppData\\Roaming\\qooti\\vault',
    total_items: 42,
    size_bytes: 1_500_000_000,
    disk_free_bytes: 20_000_000_000,
    is_default: true,
  }),
  pickVaultFolder: () => Promise.resolve('C:\\Users\\Dev\\Documents\\qooti-vault'),
  relocateVault:   (_newPath, _migrate) => Promise.resolve({ newPath: _newPath, filesMoved: 0 }),

  // Simulates a download: emits fake progress via store events after short delays
  downloadUrl: (url, _quality) => {
    const id = `mock-dl-${Date.now()}`
    import('./store.js').then(({ default: store }) =>
      import('./events.js').then(ev => {
        let pct = 0
        const tick = setInterval(() => {
          pct = Math.min(1, pct + 0.12)
          store.emit(ev.DOWNLOAD_PROGRESS, { download_id: id, pct, speed: '4.2MiB/s' })
          if (pct >= 1) {
            clearInterval(tick)
            store.emit(ev.DOWNLOAD_COMPLETE, { download_id: id, path: '/mock/video.mp4' })
          }
        }, 300)
      })
    )
    return Promise.resolve(id)
  },

  // App update (design preview): Check for updates finds 1.2.2 (?update=latest: none).
  // Installing plays an 81 MB download in ~6 s through UPDATE_PROGRESS, then stays on
  // "Installing" the way the real app does until it restarts (reload to start over).
  // ?update=fail breaks off half way with the updater's own error.
  checkForUpdate: () => new Promise(resolve => setTimeout(() =>
    resolve(new URLSearchParams(location.search).get('update') === 'latest' ? null : { version: '1.2.2', notes: '' }), 600)),
  applyUpdate: () => new Promise((_resolve, reject) => {
    const fail = new URLSearchParams(location.search).get('update') === 'fail'
    Promise.all([import('./store.js'), import('./events.js')]).then(([{ default: store }, ev]) => {
      const total = 80_907_094
      let downloaded = 0
      setTimeout(() => {
        const tick = setInterval(() => {
          downloaded = Math.min(total, downloaded + total / 60)
          store.emit(ev.UPDATE_PROGRESS, { phase: 'downloading', downloaded, total })
          if (fail && downloaded >= total / 2) {
            clearInterval(tick)
            reject('error decoding response body')
          } else if (downloaded >= total) {
            clearInterval(tick)
            store.emit(ev.UPDATE_PROGRESS, { phase: 'installing' })
          }
        }, 100)
      }, 700)   // the real one checks again first
    })
  }),
}

// ─── Links from the browser (design preview: ?bq=4 | 42) ─────────
const bqTile = (a, b) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='100'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><rect width='160' height='100' fill='url(#g)'/></svg>`)
const BQ_TILES = [['#e9e6e4', '#9da3ad'], ['#c0c4ca', '#8a9099'], ['#e5803b', '#b8603a'], ['#5468e0', '#6d6fa8'], ['#3d5059', '#4f7480'], ['#7b4a2c', '#a0612b'], ['#2c2328', '#4a3a3e']]
const BQ_SITES = {
  youtube:   { page: 'https://www.youtube.com/watch?v=', kind: 'video', titles: ['How Pentagram builds a brand system', 'Kinetic type in 30 seconds', 'Designing a type family, part 2', 'Swiss style in motion', 'Grid systems, explained'] },
  pinterest: { page: 'https://www.pinterest.com/pin/', kind: 'image', titles: ['Swiss poster, 1962', 'Bauhaus colour study', 'Packaging, matte black', 'Type specimen'] },
  instagram: { page: 'https://www.instagram.com/reel/', kind: 'video', titles: ['Studio tour, Copenhagen', 'Letterpress at work', 'Sketchbook flip'] },
  behance:   { page: 'https://www.behance.net/gallery/', kind: 'image', titles: ['Brand guidelines, Nordic', 'Annual report layout'] },
}
function bqItem(platform, i, ageMin, choice = null) {
  const s = BQ_SITES[platform]
  const [a, b] = BQ_TILES[(i * 3 + platform.length) % BQ_TILES.length]
  const host = new URL(s.page).hostname.replace(/^www\./, '')
  const video = s.kind === 'video'
  return {
    id: `bq-${platform}-${i}`, url: `${s.page}${i}`, page_url: `${s.page}${i}`,
    title: s.titles[i % s.titles.length] + (i >= s.titles.length ? ` (${i + 1})` : ''),
    kind: s.kind, site: host, source_platform: platform,
    choice: choice ?? (video ? 'video' : 'image'),
    formats: video ? ['video', 'thumbnail'] : ['image'],
    saved_at: NOW - ageMin * 60000, preview: bqTile(a, b),
  }
}
function makeBq(n) {
  if (n >= 10) {
    const out = []
    for (const [platform, count] of [['youtube', 23], ['pinterest', 12], ['instagram', 5], ['behance', 2]])
      for (let i = 0; i < count; i++) out.push(bqItem(platform, i, 30 + i * 47 + platform.length * 5))
    return out.slice(0, n)
  }
  return [bqItem('youtube', 0, 120), bqItem('pinterest', 0, 130), bqItem('instagram', 0, 60 * 26), bqItem('youtube', 1, 60 * 27, 'thumbnail')].slice(0, n)
}
let _bq = makeBq(Number(new URLSearchParams(location.search).get('bq') || 0))

// ─── bloot apps account (design preview) ─────────────────────────
let _mockHub = new URLSearchParams(location.search).get('hub') || 'pro'
function mockHubAccount() {
  const inn = _mockHub === 'pro' || _mockHub === 'free'
  return {
    state: inn ? 'signed_in' : _mockHub === 'expired' ? 'expired' : 'signed_out',
    name: inn ? 'Azizbek' : null, bloot_id: inn ? 'BLT-HBVAKCQSQVDJND' : null,
    tier: _mockHub === 'pro' ? 'pro' : 'free', pro_until: null, hub_installed: _mockHub !== 'missing',
  }
}

// ─── Tag lens (design preview) ───────────────────────────────────
// The three lenses in the fixed order of spec §0.2, with the content of the bundled files
// (lenses/src/*.json → src-tauri/lenses/qooti-lens-*.json) in the generated block below:
// every entry with its EN/UZ labels, group, media and aspect, the add-by-hand entries, and
// the borrows. A tag two lenses share (§0c) is one tag with an entry in each. Keep the ids
// used by MOCK_SUGGESTIONS and MOCK_TAGS at the top in step (mascot and stock_chart are retired tags).
//  • No role is chosen at first, so the role step shows. ?role=motion|design|thumbnail starts
//    with that role chosen (its lens on, suggestions on).
//  • Choosing a role, turning suggestions on, Re-tag all or a lens update plays ~4 s of
//    "Looking through your library" (LENS_STATUS twice a second, only while lensStatusWatch
//    is on, like the app), then AUTO_TAG_BATCH_DONE in chunks of 500 ids, like tagging.rs.
//  • "Check now": nothing new by default (the catalogue isn't published yet: 404);
//    ?lenscheck=updated finds the next design version (one more tag); ?lenscheck=offline can't connect;
//    ?lenscheck=big sends an index over the 64 KB limit (refused: shows as "Couldn't connect").
//  • ?mockitems=N (up to 5000) adds N more pictures with suggestions, to try a big grid.
// Tag lens content, generated from the lens sources by the port plan's gen-mock-lenses.mjs.
// Don't edit by hand: run the generator again when a lens changes. Sources:
//   lenses/src/motion.json v3 sha256 e2baf2b85cea32b9
//   lenses/src/design.json v3 sha256 459a03376fcd1901
//   lenses/src/thumbnail.json v2 sha256 8726d8e0714686e2
// Scored entries: lensConcept(id, en, uz, media, aspect, group). Add-by-hand entries ("suggest":
// false: in the picker and search, never suggested): handConcept(id, en, uz, group).
const lensConcept = (id, en, uz, media = 'any', aspect = null, group = null) => ({ id, label: { en, uz }, suggest: true, media, aspect, group })
const handConcept = (id, en, uz, group = null) => ({ id, label: { en, uz }, suggest: false, media: null, aspect: null, group })
const MOTION_GROUPS = {   // the owner's headings in the motion list
  commercial: { en: 'Commercial', uz: 'Reklama' },
  ui:         { en: 'UI', uz: 'UI' },
  motion:     { en: 'Motion', uz: 'Motion' },
  music:      { en: 'Music', uz: 'Musiqa' },
  cinematic:  { en: 'Cinematic', uz: 'Kinematografik' },
  social:     { en: 'Social', uz: 'Ijtimoiy tarmoqlar' },
  education:  { en: 'Education', uz: 'Ta’lim' },
  techniques: { en: 'Techniques', uz: 'Usullar' },
  niche:      { en: 'Niche', uz: 'Nisha' },
}
const MOCK_LENS_DEFS = [
  {
    id: 'motion', role: 'specialist', version: 3,
    name:    { en: 'Video editor / Motion designer', uz: 'Videomontajchi / Motion dizayner' },
    summary: { en: 'Ads, UI, 3D, music videos, film, social, tutorials', uz: 'Reklama, UI, 3D, kliplar, kino, ijtimoiy tarmoqlar, darslar' },
    borrows: [
      'fashion', 'food', 'architecture', 'ui_design', 'typography', 'render_3d',
      'collage', 'infographic', 'dark_cinematic', 'nature', 'retro',
    ],
    concepts: [
      lensConcept('commercial',     'Commercial',   'Reklama roligi',   'video', null, MOTION_GROUPS.commercial),
      handConcept('brand',          'Brand',        'Brend',            MOTION_GROUPS.commercial),
      handConcept('logo',           'Logo',         'Logotip',          MOTION_GROUPS.commercial),
      handConcept('ads',            'Ads',          'Reklama',          MOTION_GROUPS.commercial),
      lensConcept('packshot',       'Packshot',     'Pekshot',          'video', null, MOTION_GROUPS.commercial),
      lensConcept('fashion',        'Fashion',      'Moda',             'video', null, MOTION_GROUPS.commercial),
      lensConcept('beauty',         'Beauty',       'Kosmetika',        'any', null, MOTION_GROUPS.commercial),
      lensConcept('food',           'Food',         'Taom',             'video', null, MOTION_GROUPS.commercial),
      lensConcept('architecture',   'Architecture', 'Arxitektura',      'video', null, MOTION_GROUPS.commercial),
      lensConcept('aftermovie',     'Aftermovie',   'Tadbir videosi',   'video', null, MOTION_GROUPS.commercial),
      lensConcept('corporate',      'Corporate',    'Korporativ video', 'video', null, MOTION_GROUPS.commercial),
      lensConcept('ui_design',      'UI',           'UI',               'video', null, MOTION_GROUPS.ui),
      handConcept('saas',           'SaaS',         'SaaS',             MOTION_GROUPS.ui),
      lensConcept('explainer',      'Explainer',    'Ekspleyner',       'video', null, MOTION_GROUPS.ui),
      lensConcept('keynote',        'Keynote',      'Prezentatsiya',    'video', null, MOTION_GROUPS.ui),
      lensConcept('dashboard',      'Dashboard',    'Dashbord',         'video', null, MOTION_GROUPS.ui),
      handConcept('onboarding',     'Onboarding',   'Onbording',        MOTION_GROUPS.ui),
      lensConcept('character',      'Character',    'Personaj',         'any', null, MOTION_GROUPS.motion),
      lensConcept('abstract',       'Abstract',     'Abstrakt',         'any', null, MOTION_GROUPS.motion),
      handConcept('isometric',      'Isometric',    'Izometrik',        MOTION_GROUPS.motion),
      lensConcept('liquid',         'Liquid',       'Suyuqlik',         'any', null, MOTION_GROUPS.motion),
      handConcept('glitch',         'Glitch',       'Glitch',           MOTION_GROUPS.motion),
      lensConcept('particles',      'Particles',    'Zarrachalar',      'any', null, MOTION_GROUPS.motion),
      handConcept('loops',          'Loops',        'Looplar',          MOTION_GROUPS.motion),
      handConcept('generative',     'Generative',   'Generativ',        MOTION_GROUPS.motion),
      lensConcept('overlays',       'Overlays',     'Overleylar',       'video', null, MOTION_GROUPS.motion),
      lensConcept('typography',     'Typography',   'Tipografika',      'video'),
      lensConcept('render_3d',      '3D',           '3D',               'video'),
      lensConcept('collage',        'Collage',      'Kollaj',           'video'),
      handConcept('infographic',    'Infographics', 'Infografika'),
      lensConcept('stopmotion',     'Stopmotion',   'Stop-motion',      'video'),
      lensConcept('map',            'Map',          'Xarita',           'any'),
      handConcept('titles',         'Titles',       'Titrlar'),
      handConcept('lyrics',         'Lyrics',       'Qo‘shiq matni',    MOTION_GROUPS.music),
      lensConcept('music_video',    'Musicvideo',   'Klip',             'video', null, MOTION_GROUPS.music),
      handConcept('visualizer',     'Visualizer',   'Audio spektr',     MOTION_GROUPS.music),
      handConcept('teaser',         'Teaser',       'Tizer',            MOTION_GROUPS.music),
      lensConcept('concert',        'Concert',      'Konsert',          'any', null, MOTION_GROUPS.music),
      handConcept('canvas',         'Canvas',       'Spotify Canvas',   MOTION_GROUPS.music),
      lensConcept('dark_cinematic', 'Cinematic',    'Kinematografik',   'video', null, MOTION_GROUPS.cinematic),
      handConcept('short_film',     'Shortfilm',    'Qisqa film',       MOTION_GROUPS.cinematic),
      handConcept('fan_edit',       'Fanedit',      'Edit',             MOTION_GROUPS.cinematic),
      lensConcept('grading',        'Grading',      'Rang tuzatish',    'video', null, MOTION_GROUPS.cinematic),
      handConcept('one_shot',       'Oneshot',      'Bir dubl',         MOTION_GROUPS.cinematic),
      lensConcept('drone',          'Drone',        'Dron',             'any', null, MOTION_GROUPS.cinematic),
      lensConcept('travel',         'Travel',       'Sayohat',          'any', null, MOTION_GROUPS.cinematic),
      lensConcept('nature',         'Nature',       'Tabiat',           'video', null, MOTION_GROUPS.cinematic),
      lensConcept('documentary',    'Documentary',  'Hujjatli film',    'video', null, MOTION_GROUPS.cinematic),
      lensConcept('wedding',        'Wedding',      'To‘y',             'any', null, MOTION_GROUPS.cinematic),
      lensConcept('sports',         'Sports',       'Sport',            'video', null, MOTION_GROUPS.cinematic),
      handConcept('trailer',        'Trailer',      'Treyler'),
      handConcept('intro',          'Intro',        'Intro',            MOTION_GROUPS.social),
      handConcept('essay',          'Essay',        'Video esse',       MOTION_GROUPS.social),
      lensConcept('talking_head',   'Talkinghead',  'Kameraga nutq',    'video', null, MOTION_GROUPS.social),
      lensConcept('podcast',        'Podcast',      'Podkast',          'video', null, MOTION_GROUPS.social),
      handConcept('reels',          'Reels',        'Reels',            MOTION_GROUPS.social),
      handConcept('vibe',           'Vibe',         'Vayb',             MOTION_GROUPS.social),
      handConcept('velocity',       'Velocity',     'Velocity',         MOTION_GROUPS.social),
      lensConcept('vlog',           'Vlog',         'Vlog',             'video', null, MOTION_GROUPS.social),
      lensConcept('meme',           'Meme',         'Mem',              'picture'),
      lensConcept('tutorial',       'Tutorial',     'Video dars',       'video', null, MOTION_GROUPS.education),
      lensConcept('screencast',     'Screencast',   'Screencast',       'video', null, MOTION_GROUPS.education),
      handConcept('course',         'Course',       'Kurs',             MOTION_GROUPS.education),
      lensConcept('science',        'Science',      'Ilm-fan',          'any', null, MOTION_GROUPS.education),
      handConcept('transitions',    'Transitions',  'O‘tishlar',        MOTION_GROUPS.techniques),
      handConcept('ramps',          'Speed ramp',   'Speed ramp',       MOTION_GROUPS.techniques),
      handConcept('sound',          'Sound',        'Tovush',           MOTION_GROUPS.techniques),
      handConcept('rhythm',         'Rhythm',       'Ritm',             MOTION_GROUPS.techniques),
      lensConcept('text',           'Text',         'Matn',             'video', null, MOTION_GROUPS.techniques),
      handConcept('impact',         'Impact',       'Zarba',            MOTION_GROUPS.techniques),
      lensConcept('split_screen',   'Splitscreen',  'Split-ekran',      'video', null, MOTION_GROUPS.techniques),
      handConcept('rotoscoping',    'Rotoscoping',  'Rotoskoping',      MOTION_GROUPS.techniques),
      lensConcept('vfx',            'VFX',          'VFX',              'video', null, MOTION_GROUPS.techniques),
      lensConcept('chromakey',      'Chromakey',    'Xromakey',         'any', null, MOTION_GROUPS.techniques),
      handConcept('reveal',         'Reveal',       'Paydo bo‘lish',    MOTION_GROUPS.techniques),
      lensConcept('retro',          'Retro',        'Retro',            'video', null, MOTION_GROUPS.niche),
      lensConcept('y2k',            'Y2K',          'Y2K',              'any', null, MOTION_GROUPS.niche),
      lensConcept('ar',             'AR',           'AR',               'video', null, MOTION_GROUPS.niche),
      handConcept('projection',     'Projection',   'Proyeksiya',       MOTION_GROUPS.niche),
      handConcept('interactive',    'Interactive',  'Interaktiv',       MOTION_GROUPS.niche),
      lensConcept('anime',          'Anime',        'Anime',            'any'),
      handConcept('brutalist',      'Brutalist',    'Brutalizm'),
      lensConcept('gaming',         'Gaming',       'O‘yinlar',         'video'),
      handConcept('ai',             'AI',           'AI'),
    ],
  },
  {
    id: 'design', role: 'base', version: 3,
    name:    { en: 'Graphic designer / Social media post designer', uz: 'Grafik dizayner / SMD dizayneri' },
    summary: { en: 'Posters, SMD, UI, 3D, illustration', uz: 'Posterlar, SMD, UI, 3D, illyustratsiya' },
    borrows: [],
    concepts: [
      lensConcept('poster',         'Poster',       'Poster',         'picture'),
      lensConcept('typography',     'Typography',   'Tipografika',    'picture'),
      lensConcept('social_post',    'SMD',          'SMD',            'picture', [0.5, 1.3]),
      lensConcept('infographic',    'Infographics', 'Infografika',    'picture'),
      lensConcept('packaging',      'Packaging',    'Qadoq dizayni',  'picture'),
      lensConcept('ui_design',      'UI',           'UI',             'picture'),
      lensConcept('web_design',     'Website',      'Veb-sayt',       'picture'),
      lensConcept('icons',          'Icons',        'Ikonkalar',      'picture'),
      lensConcept('illustration',   'Illustration', 'Illyustratsiya', 'picture'),
      lensConcept('collage',        'Collage',      'Kollaj',         'picture'),
      lensConcept('render_3d',      '3D',           '3D',             'picture'),
      lensConcept('minimal',        'Minimal',      'Minimal',        'picture'),
      lensConcept('retro',          'Retro',        'Retro',          'picture'),
      lensConcept('dark_cinematic', 'Cinematic',    'Kinematografik', 'picture'),
      lensConcept('portrait',       'Portrait',     'Portret',        'picture'),
      lensConcept('fashion',        'Fashion',      'Moda',           'picture'),
      lensConcept('product_photo',  'Product shot', 'Tovar surati',   'picture'),
      lensConcept('food',           'Food',         'Taom',           'picture'),
      lensConcept('nature',         'Nature',       'Tabiat',         'picture'),
      lensConcept('architecture',   'Architecture', 'Arxitektura',    'picture'),
      lensConcept('interior',       'Interior',     'Interyer',       'picture'),
      lensConcept('space',          'Space',        'Kosmos',         'picture'),
      lensConcept('holiday',        'Holiday',      'Bayram',         'picture'),
      handConcept('logo',           'Logo',         'Logotip'),
      handConcept('brand',          'Brand',        'Brend'),
    ],
  },
  {
    id: 'thumbnail', role: 'specialist', version: 2,
    name:    { en: 'YouTube thumbnail designer', uz: 'YouTube muqova dizayneri' },
    summary: { en: 'Gaming, tech, finance, cooking, horror', uz: 'O‘yinlar, texnologiya, moliya, pazandachilik, qo‘rqinchli' },
    borrows: [
      'portrait', 'dark_cinematic', 'collage', 'render_3d', 'illustration', 'food',
      'nature', 'space',
    ],
    concepts: [
      lensConcept('manipulation',  'Manipulation',  'Manipulyatsiya',  'picture'),
      lensConcept('business',      'Business',      'Biznes',          'picture'),
      lensConcept('cooking',       'Cooking',       'Pazandachilik',   'picture'),
      lensConcept('design_diy',    'Design & DIY',  'Dizayn va DIY',   'picture'),
      lensConcept('education',     'Education',     'Ta’lim',          'picture'),
      lensConcept('entertainment', 'Entertainment', 'Ko‘ngilochar',    'picture'),
      lensConcept('finance',       'Finance',       'Moliya',          'picture'),
      lensConcept('fitness',       'Fitness',       'Fitnes',          'picture'),
      lensConcept('gaming',        'Gaming',        'O‘yinlar',        'picture'),
      lensConcept('horror',        'Horror',        'Qo‘rqinchli',     'picture', [1.6, 1.95]),
      lensConcept('music',         'Music',         'Musiqa',          'picture'),
      handConcept('pov',           'POV',           'POV'),
      lensConcept('podcast',       'Podcast',       'Podkast',         'picture', [1.6, 1.95]),
      lensConcept('politics',      'Politics',      'Siyosat',         'picture'),
      lensConcept('pop_science',   'Pop science',   'Ilmiy-ommabop',   'picture'),
      lensConcept('self_growth',   'Self-growth',   'Shaxsiy rivoj',   'picture'),
      lensConcept('sports',        'Sports',        'Sport',           'picture'),
      lensConcept('documentary',   'Documentary',   'Hujjatli film',   'picture'),
      lensConcept('tech',          'Technology',    'Texnologiya',     'picture'),
      lensConcept('travel_vlog',   'Travel & Vlog', 'Sayohat va vlog', 'picture'),
      lensConcept('tutorial',      'Tutorial',      'Video dars',      'picture', [1.6, 1.95]),
      lensConcept('youtube_niche', 'YouTube niche', 'YouTube nishasi', 'picture', [1.6, 1.95]),
    ],
  },
]

const _lensQs        = new URLSearchParams(location.search)
const LENS_SCAN_MS   = 4000
const _mockLenses    = MOCK_LENS_DEFS.map(d => ({ ...d, enabled: false, origin: 'bundled', updated_at: days(12) }))   // unix ms, like list_lenses
// Tags no lens has any more: kept (inactive) so their tags keep a name (the design lens dropped
// mascot; the thumbnail lens v2 dropped 9 of v1's tags, listed here with v1's labels as a library
// that had v1 keeps them)
const _retiredConcepts = [
  { id: 'mascot',        lens_id: 'design',    label: { en: 'Mascot',         uz: 'Maskot' } },
  { id: 'reaction_face', lens_id: 'thumbnail', label: { en: 'Reaction face',  uz: 'Yuz ifodasi' } },
  { id: 'before_after',  lens_id: 'thumbnail', label: { en: 'Before & after', uz: 'Oldin va keyin' } },
  { id: 'versus',        lens_id: 'thumbnail', label: { en: 'Versus',         uz: 'Bellashuv' } },
  { id: 'arrows',        lens_id: 'thumbnail', label: { en: 'Arrows',         uz: 'Strelkalar' } },
  { id: 'top_list',      lens_id: 'thumbnail', label: { en: 'Top list',       uz: 'Top ro‘yxat' } },
  { id: 'true_crime',    lens_id: 'thumbnail', label: { en: 'True crime',     uz: 'Kriminal' } },
  { id: 'stock_chart',   lens_id: 'thumbnail', label: { en: 'Stock chart',    uz: 'Birja grafigi' } },
  { id: 'money',         lens_id: 'thumbnail', label: { en: 'Money',          uz: 'Pul' } },
  { id: 'history',       lens_id: 'thumbnail', label: { en: 'History',        uz: 'Tarix' } },
]
const _lensAnswers   = new Map()    // `${item id}|${key}` → 'added' | 'dismissed'
let _lensScan        = null         // the running "Looking through your library"
let _lensWatched     = false        // lensStatusWatch: LENS_STATUS events are sent only while on
const MOCK_SCORE_CHUNK    = 500     // tagging.rs CHUNK: one autotag:scored per 500 items
const MOCK_MAPS_MAX       = 1000    // get_suggestion_maps takes at most this many ids
const MOCK_CATALOGUE_IDS  = ['motion', 'design', 'thumbnail']   // what install_lenses takes (§0b.5)

const _presetRole = _mockLenses.find(l => l.id === _lensQs.get('role'))
if (_presetRole) {
  _presetRole.enabled = true
  MOCK_SETTINGS.user_role = _presetRole.id
  MOCK_SETTINGS.tag_recommendations_enabled = 'true'
}

// Store events the backend would send (lens:changed, lens:status, autotag:scored arrive
// through auto-tag.js in the app; here they're emitted straight into the store)
function mockLensEmit(name, payload) {
  Promise.all([import('./store.js'), import('./events.js')])
    .then(([{ default: store }, ev]) => store.emit(ev[name], payload))
}

function mockConcept(id) {
  for (const l of _mockLenses) {
    const c = l.concepts.find(x => x.id === id)
    if (c) return c
  }
  return _retiredConcepts.find(c => c.id === id) ?? null
}

function mockConf(item) {
  try {
    const o = JSON.parse(item?.auto_tag_confidence || '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

function mockLensRows() {
  return _mockLenses.map(l => ({
    id: l.id, role: l.role, version: l.version, enabled: l.enabled, origin: l.origin,
    name: { ...l.name }, summary: { ...l.summary }, updated_at: l.updated_at,
    concepts: l.concepts.map(c => c.id), borrows: [...(l.borrows ?? [])],
  }))
}

// list_concepts: one row per tag. lens_id is the first lens (fixed order) that has it;
// entries are every lens's entry (media null when added by hand); group the first one given;
// borrowed_by the specialists that borrow it. Retired tags last, by id, without entries.
function mockConceptRows() {
  const rows = new Map()
  for (const l of _mockLenses) {
    for (const c of l.concepts) {
      if (!rows.has(c.id)) {
        const borrowers = _mockLenses.filter(s => s.role === 'specialist' && s.borrows?.includes(c.id)).map(s => s.id)
        rows.set(c.id, { id: c.id, lens_id: l.id, labels: { ...c.label }, group: null, active: true, entries: [], borrowed_by: borrowers })
      }
      const row = rows.get(c.id)
      row.entries.push({ lens_id: l.id, media: c.suggest === false ? null : c.media, suggest: c.suggest !== false })
      if (!row.group && c.group) row.group = { ...c.group }
    }
  }
  const retired = _retiredConcepts.filter(c => !rows.has(c.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const c of retired) {
    rows.set(c.id, { id: c.id, lens_id: c.lens_id, labels: { ...c.label }, group: null, active: false, entries: [], borrowed_by: [] })
  }
  return [...rows.values()]
}

// A tag as list_tags returns it: usage counted live; a lens tag carries its concept's labels
function mockTagRow(t) {
  const c = t.concept_id ? mockConcept(t.concept_id) : null
  return {
    ...t,
    concept_id: t.concept_id ?? null,
    labels: c ? { ...c.label } : null,
    usage_count: Object.values(MOCK_INSPIRATION_TAGS).filter(ids => ids.includes(t.id)).length,
  }
}

// What search matches a tag by: a lens tag's labels in both languages, otherwise its name; a
// people's tag that stands for a concept (one name, one tag) by both
function mockTagNames(t) {
  const c = t.concept_id ? mockConcept(t.concept_id) : null
  if (!c) return [t.name]
  return mockIsPeoples(t) ? [c.label.en, c.label.uz, t.name] : [c.label.en, c.label.uz]
}

function mockLensStatus() {
  const total = _inspirations.length
  const scored = _lensScan ? Math.min(total, Math.floor(total * (Date.now() - _lensScan.t0) / LENS_SCAN_MS)) : total
  // per_lens: items with a key the lens shows on the item's media (§0c, like tagging.rs): its
  // own scored entry covers that media, or it borrows the tag and the base lens's entry does
  const covers = (c, m) => !!c && c.suggest !== false && (c.media == null || c.media === 'any' || c.media === m)
  const base = _mockLenses.find(l => l.role === 'base')
  const shows = new Map()   // lens id → { picture: Set, video: Set } of the keys it shows
  for (const l of _mockLenses) {
    const by = {}
    for (const m of ['picture', 'video']) {
      by[m] = new Set(l.concepts.filter(c => covers(c, m)).map(c => c.id))
      if (l.role !== 'base') for (const k of l.borrows ?? []) if (covers(base?.concepts.find(c => c.id === k), m)) by[m].add(k)
    }
    shows.set(l.id, by)
  }
  const per_lens = Object.fromEntries(_mockLenses.map(l => [l.id, 0]))
  for (const item of _inspirations) {
    const keys = Object.keys(mockConf(item))
    const media = item.type === 'video' ? 'video' : 'picture'
    for (const id of Object.keys(per_lens)) if (keys.some(k => shows.get(id)[media].has(k))) per_lens[id]++
  }
  return {
    enabled: MOCK_SETTINGS.tag_recommendations_enabled === 'true',
    total, scored, waiting_videos: 0,
    last_check: Number(MOCK_SETTINGS.lens_last_check) || null,
    per_lens,
  }
}

function mockLensScan() {
  if (MOCK_SETTINGS.tag_recommendations_enabled !== 'true') return   // scoring only runs while suggestions are on
  clearInterval(_lensScan?.timer)
  const scan = { t0: Date.now(), timer: null }
  _lensScan = scan
  if (_lensWatched) mockLensEmit('LENS_STATUS', mockLensStatus())
  scan.timer = setInterval(() => {
    const done = Date.now() - scan.t0 >= LENS_SCAN_MS
    if (done) {
      clearInterval(scan.timer)
      if (_lensScan === scan) _lensScan = null
    }
    if (_lensWatched) mockLensEmit('LENS_STATUS', mockLensStatus())
    if (done) {
      // Like score_locked: one autotag:scored per chunk of 500 items, back to back
      const ids = _inspirations.filter(i => Object.keys(mockConf(i)).length).map(i => i.id)
      for (let at = 0; at < ids.length; at += MOCK_SCORE_CHUNK) {
        const chunk = ids.slice(at, at + MOCK_SCORE_CHUNK)
        setTimeout(() => mockLensEmit('AUTO_TAG_BATCH_DONE', { ids: chunk, processed: chunk.length }), (at / MOCK_SCORE_CHUNK) * 100)
      }
    }
  }, 500)
}

// get_suggestion_maps: the stored suggestions of up to 1000 items; unknown ids are left out
function mockSuggestionMaps(ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return Promise.reject('invalid')
  if (ids.length > MOCK_MAPS_MAX) return Promise.reject('too_many')
  const want = new Set(ids)
  const out = {}
  for (const item of _inspirations) {
    if (want.has(item.id)) out[item.id] = { conf: item.auto_tag_confidence ?? null, model: item.auto_tag_model ?? null }
  }
  return Promise.resolve(out)
}

// The same-name rule (spec §0b.2): a concept is never stored for an item that already has a
// people's tag (user/import) with its English or Uzbek name: trimmed, any case, ‘ ’ ʻ ʼ ` as '
const foldTagName = s => String(s ?? '').trim().toLowerCase().replace(/[‘’ʻʼ`]/g, "'")
function mockSameNameTag(itemId, conceptId) {
  const c = mockConcept(conceptId)
  if (!c) return false
  const names = new Set([c.label.en, c.label.uz].filter(Boolean).map(foldTagName))
  return (MOCK_INSPIRATION_TAGS[itemId] ?? []).some(tagId => {
    const t = MOCK_TAGS.find(x => x.id === tagId)
    return !!t && (t.source === 'user' || t.source === 'import') && names.has(foldTagName(t.name))
  })
}

function mockSetLensEnabled(id, enabled) {
  const lens = _mockLenses.find(l => l.id === id)
  if (!lens) return Promise.reject('invalid')
  lens.enabled = !!enabled
  mockLensEmit('LENS_CHANGED', {})
  return Promise.resolve()
}

function mockApplyRole(role) {
  if (!_mockLenses.some(l => l.id === role)) return Promise.reject('invalid')
  for (const l of _mockLenses) l.enabled = l.id === role
  MOCK_SETTINGS.user_role = role
  MOCK_SETTINGS.tag_recommendations_enabled = 'true'
  mockLensEmit('LENS_CHANGED', {})
  mockLensScan()
  return Promise.resolve()
}

// The same-name rule when a tag is linked (spec §0b.2), like tagging.rs: a people's tag
// (user/import) is compared by its name, a lens tag by both labels of its concept
function mockTagNamed(t) {
  if (!t) return null
  if (t.concept_id) return { people: false, names: mockConceptNames(t.concept_id) }
  const k = (t.source === 'user' || t.source === 'import') ? foldTagName(t.name) : ''
  return k ? { people: true, names: new Set([k]) } : null
}
function mockConceptNames(id) {
  const c = mockConcept(id)
  return new Set(c ? [c.label.en, c.label.uz].map(foldTagName).filter(Boolean) : [])
}
const namesMeet = (a, b) => [...a].some(n => b.has(n))

// has_the_name_already: Add on `key` would give the item a name it already has — a lens
// question named like one of its people's tags, or a hint named like one of its other tags
function mockHasNameAlready(itemId, key) {
  const hinted = key.startsWith('col:') ? key.slice(4) : null
  const asks = hinted ? mockTagNamed(MOCK_TAGS.find(t => t.id === hinted)) : { people: false, names: mockConceptNames(key) }
  if (!asks?.names.size || (hinted && !asks.people)) return false
  return (MOCK_INSPIRATION_TAGS[itemId] ?? []).some(tagId => {
    if (tagId === hinted) return false
    const has = mockTagNamed(MOCK_TAGS.find(t => t.id === tagId))
    return !!has && (has.people || !!hinted) && namesMeet(has.names, asks.names)   // a lens tag never stops another concept
  })
}

// drop_questions_named_like: `tagId` was just linked to `item`; its questions that ask that
// name go (a people's tag: lens questions and other people's hints; a lens tag: hints)
function mockDropNamedLike(item, tagId) {
  const linked = mockTagNamed(MOCK_TAGS.find(t => t.id === tagId))
  if (!linked?.names.size) return
  const conf = mockConf(item)
  let changed = false
  for (const key of Object.keys(conf)) {
    let asks = null
    if (key.startsWith('col:')) {
      const hinted = key.slice(4) === tagId ? null : mockTagNamed(MOCK_TAGS.find(t => t.id === key.slice(4)))
      if (hinted?.people) asks = hinted.names
    } else if (linked.people) {
      asks = mockConceptNames(key)
    }
    if (asks && namesMeet(asks, linked.names)) { delete conf[key]; changed = true }
  }
  if (changed) item.auto_tag_confidence = JSON.stringify(conf)
}

// The name the backend stores a lens tag under (tagging.rs lens_tag_names): the concept's
// English label (underscores as spaces), then "<label> (Tag lens)", "<label> (Tag lens 2)", …: the
// first no other tag has (any case, any apostrophe). Never shown here; older versions show it.
function mockLensTagName(conceptId, exceptId = null, reserved = null) {
  const base = mockLensTagBase(conceptId)
  const taken = new Set(MOCK_TAGS.filter(t => t.id !== exceptId).map(t => foldTagName(t.name)))
  if (reserved != null) taken.add(foldTagName(reserved))
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : n === 2 ? `${base} (Tag lens)` : `${base} (Tag lens ${n - 1})`
    if (!taken.has(foldTagName(name))) return name
  }
}

// lens_tag_base: the concept's English label (underscores as spaces), the name a lens tag goes by
function mockLensTagBase(conceptId) {
  const label = String(mockConcept(conceptId)?.label?.en ?? '').trim()
  const words = (label || conceptId).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
  return label && !label.includes('_') ? label : words.charAt(0).toUpperCase() + words.slice(1)
}

// make_room_for_name: a people's tag is about to get `name`; a lens tag stored under it moves on
// (people's tags never do, also one that stands for a concept)
function mockMakeRoomFor(name, exceptId = null) {
  const key = foldTagName(name)
  for (const t of MOCK_TAGS.filter(t => t.concept_id && !mockIsPeoples(t) && t.id !== exceptId && foldTagName(t.name) === key)) {
    t.name = mockLensTagName(t.concept_id, t.id, name)
  }
}

// ── One name, one tag (tagging.rs): a lens tag and a people's tag (user/import) with one name
// (the lens tag's English label, any case, any apostrophe) are one tag: the people's tag, which
// keeps its id, name and source and stands for the concept (it still shows its own name). Not
// when two people's tags have the name, or the one with it stands for another concept.
const mockIsPeoples = t => !!t && (t.source === 'user' || t.source === 'import')

// The one people's tag named like `conceptId`'s tag that may be its tag, or null
function mockPeoplesTagFor(conceptId) {
  const key = foldTagName(mockLensTagBase(conceptId))
  const named = MOCK_TAGS.filter(t => mockIsPeoples(t) && foldTagName(t.name) === key)
  return named.length === 1 && (!named[0].concept_id || named[0].concept_id === conceptId) ? named[0] : null
}

// lens_tag_for_peoples_name: the lens tag a new people's tag named `name` is, or null
function mockLensTagForPeoplesName(name) {
  const key = foldTagName(name)
  if (!key || MOCK_TAGS.some(t => mockIsPeoples(t) && foldTagName(t.name) === key)) return null
  return mockTagsInNamingOrder().find(t => t.concept_id && !mockIsPeoples(t) && foldTagName(mockLensTagBase(t.concept_id)) === key) ?? null
}

// Tags of live concepts first, then the oldest (name_lens_tags' order)
function mockTagsInNamingOrder() {
  const active = new Set(mockConceptRows().filter(c => c.active).map(c => c.id))
  const live = t => (t.concept_id && active.has(t.concept_id) ? 1 : 0)
  return [...MOCK_TAGS].sort((a, b) => live(b) - live(a) || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// settle_concept_tag: `tag` stands for its concept now; the concept's question leaves the items
// that have it, and its collection hints leave every item (the lenses ask about it now)
function mockSettleConceptTag(tag) {
  for (const item of _inspirations) {
    const conf = mockConf(item)
    const has = (MOCK_INSPIRATION_TAGS[item.id] ?? []).includes(tag.id)
    if (!(has && tag.concept_id in conf) && !(`col:${tag.id}` in conf)) continue
    if (has) delete conf[tag.concept_id]
    delete conf[`col:${tag.id}`]
    item.auto_tag_confidence = JSON.stringify(conf)
  }
}

// join_same_name_tags (every start): each lens tag joins the one people's tag with its name; its
// items (never twice) and hint answers go with it, its hints leave the cards, and it goes
function mockJoinSameNameTags() {
  for (const lens of mockTagsInNamingOrder().filter(t => t.concept_id && !mockIsPeoples(t))) {
    const people = mockPeoplesTagFor(lens.concept_id)
    if (!people) continue
    people.concept_id = lens.concept_id
    for (const [item, ids] of Object.entries(MOCK_INSPIRATION_TAGS)) {
      if (ids.includes(lens.id)) MOCK_INSPIRATION_TAGS[item] = [...new Set(ids.map(id => id === lens.id ? people.id : id))]
    }
    for (const [k, answer] of [..._lensAnswers]) {
      const at = k.indexOf('|')
      if (k.slice(at + 1) !== `col:${lens.id}`) continue
      _lensAnswers.delete(k)
      const moved = `${k.slice(0, at)}|col:${people.id}`
      if (!_lensAnswers.has(moved)) _lensAnswers.set(moved, answer)
    }
    for (const item of _inspirations) {
      const conf = mockConf(item)
      if (`col:${lens.id}` in conf) { delete conf[`col:${lens.id}`]; item.auto_tag_confidence = JSON.stringify(conf) }
    }
    MOCK_TAGS.splice(MOCK_TAGS.indexOf(lens), 1)
    mockSettleConceptTag(people)
  }
}
mockJoinSameNameTags()   // the start of the preview

// answer_suggestion: remember the answer, drop the key (status, model and sig stay as they
// are); 'added' links the concept's tag (made on first use) or the hinted tag, and drops the
// item's other questions that ask the name it now has → Tag | null
function mockAnswerSuggestion(inspirationId, key, answer) {
  const item = _inspirations.find(i => i.id === inspirationId)
  if (!item || typeof key !== 'string' || (answer !== 'added' && answer !== 'dismissed')) return Promise.reject('invalid')
  const isHint = key.startsWith('col:')
  if (!isHint && !mockConcept(key)) return Promise.reject('invalid')
  const conf = mockConf(item)
  delete conf[key]
  item.auto_tag_confidence = JSON.stringify(conf)
  let tag = null
  if (answer === 'added') {
    tag = isHint ? MOCK_TAGS.find(t => t.id === key.slice(4)) : MOCK_TAGS.find(t => t.concept_id === key)
    // The hinted tag was deleted meanwhile, or the item already has the name this question
    // asks (a card read before that tag was linked): the key goes, no answer is kept → null
    if (!tag && isHint) return Promise.resolve(null)
    if (mockHasNameAlready(inspirationId, key)) return Promise.resolve(null)
  }
  _lensAnswers.set(`${inspirationId}|${key}`, answer)
  if (answer === 'dismissed') return Promise.resolve(null)

  if (!tag) {
    // One name, one tag: the people's tag with the concept's name becomes its tag
    tag = mockPeoplesTagFor(key)
    if (tag) {
      tag.concept_id = key
      mockSettleConceptTag(tag)
    } else {
      tag = { id: `tag-lens-${key}`, name: mockLensTagName(key), source: 'lens', concept_id: key, created_at: Date.now(), usage_count: 0 }
      MOCK_TAGS.push(tag)
    }
  }
  if (!MOCK_INSPIRATION_TAGS[inspirationId]) MOCK_INSPIRATION_TAGS[inspirationId] = []
  if (!MOCK_INSPIRATION_TAGS[inspirationId].includes(tag.id)) MOCK_INSPIRATION_TAGS[inspirationId].push(tag.id)
  mockDropNamedLike(item, tag.id)
  return Promise.resolve(mockTagRow(tag))
}

// retag_all: scored again from the stored vectors, so the same suggestions come back,
// minus the answered ones and what an item already has
function mockRetagAll() {
  for (const item of _inspirations) {
    const base = MOCK_SUGGESTIONS[item.id]
    if (!base) continue
    const tagIds = MOCK_INSPIRATION_TAGS[item.id] ?? []
    const owned = new Set(tagIds.map(id => MOCK_TAGS.find(t => t.id === id)?.concept_id).filter(Boolean))
    const conf = {}
    for (const [key, score] of Object.entries(base)) {
      if (_lensAnswers.has(`${item.id}|${key}`) || owned.has(key)) continue
      if (key.startsWith('col:') && tagIds.includes(key.slice(4))) continue
      if (!key.startsWith('col:') && mockSameNameTag(item.id, key)) continue
      conf[key] = score
    }
    item.auto_tag_confidence = JSON.stringify(conf)
  }
  mockLensScan()
  return Promise.resolve(_inspirations.length)
}

// install_lenses: all or nothing, never a downgrade → { installed, unchanged } | 'invalid' |
// 'checksum'. Like the app (§0b.5): at most 3 files and 768 KB, only motion / design /
// thumbnail (design the base), each file the lens and version its index entry names. The
// size is checked, the sha256 isn't (the preview's index carries a made-up one).
function mockInstallLenses(files) {
  const list = Array.isArray(files) ? files : []
  if (list.length > 3) return Promise.reject('invalid')
  const parsed = []
  let total = 0
  for (const f of list) {
    const bytes = new TextEncoder().encode(String(f?.text ?? '')).length
    total += bytes
    if (bytes !== f?.size) return Promise.reject('checksum')
    let lens = null
    try { lens = JSON.parse(f.text) } catch { /* invalid below */ }
    if (lens?.format !== 2 || !MOCK_CATALOGUE_IDS.includes(lens.id) || !Number.isInteger(lens.version)
        || lens.version < 1 || lens.version > 100000 || lens.id !== f.id || lens.version !== f.version
        || lens.role !== (lens.id === 'design' ? 'base' : 'specialist') || !Array.isArray(lens.concepts)) return Promise.reject('invalid')
    parsed.push(lens)
  }
  if (total > 768 * 1024) return Promise.reject('invalid')
  const installed = [], unchanged = [], before = []
  for (const lens of parsed) {
    const cur = _mockLenses.find(l => l.id === lens.id)
    if (cur && lens.version <= cur.version) { unchanged.push(lens.id); continue }
    const next = {
      id: lens.id, role: lens.role, version: lens.version, name: lens.name, summary: lens.summary,
      borrows: lens.borrows ?? [],
      concepts: lens.concepts.map(c => c.suggest === false
        ? handConcept(c.id, c.label?.en, c.label?.uz, c.group ?? null)
        : lensConcept(c.id, c.label?.en, c.label?.uz, c.media ?? 'any', c.aspect ?? null, c.group ?? null)),
      enabled: cur?.enabled ?? false, origin: 'catalogue', updated_at: Date.now(),
    }
    for (const c of cur?.concepts ?? []) before.push({ ...c, lens_id: lens.id })
    if (cur) Object.assign(cur, next)
    else _mockLenses.push(next)
    installed.push(lens.id)
  }
  // A tag is retired only when no lens has it after the install (another lens may share it)
  const live = new Set(_mockLenses.flatMap(l => l.concepts.map(c => c.id)))
  const gone = new Set()
  for (const c of before) {
    if (live.has(c.id) || gone.has(c.id)) continue
    gone.add(c.id)
    const at = _retiredConcepts.findIndex(r => r.id === c.id)
    if (at === -1) _retiredConcepts.push(c)
    else _retiredConcepts[at] = c
  }
  // Like tags_after_install: a label the update changed may be a people's tag's name now (one
  // name, one tag), so the page never shows two tags with one name until the next start
  if (installed.length) { mockJoinSameNameTags(); mockLensEmit('LENS_CHANGED', {}); mockLensScan() }
  return Promise.resolve({ installed, unchanged })
}

// The lens catalogue on api.bloot.app, as lenses.js's check sees it (see ?lenscheck above):
// the bundled design lens's next version, with one more tag (once installed, nothing newer)
const MOCK_DESIGN_NEXT      = MOCK_LENS_DEFS.find(l => l.id === 'design').version + 1
const MOCK_DESIGN_NEXT_FILE = `qooti-lens-design-${MOCK_DESIGN_NEXT}-0a1b2c3d4e5f.json`
function mockDesignNextText() {
  const d = MOCK_LENS_DEFS.find(l => l.id === 'design')
  const concepts = [...d.concepts, lensConcept('flat_lay', 'Flat lay', 'Tepadan kadr', 'picture')]
  // Each entry as a built file writes it: id, label, group?, then "suggest": false for an
  // add-by-hand one, or media, aspect?, prompts and vec for a scored one
  return JSON.stringify({
    format: 2, id: 'design', version: MOCK_DESIGN_NEXT, role: 'base', name: d.name, summary: d.summary,
    bar: { picture: 0.3, video: 0.2 }, borrows: [], min_app: '1.0.0', updated_at: '2026-11-18',
    model: 'clip-b32-q8', template: 'This is a photo of {p}', text_model: 'mock',
    concepts: concepts.map(c => ({
      id: c.id, label: c.label, ...(c.group ? { group: c.group } : {}),
      ...(c.suggest === false ? { suggest: false } : { media: c.media, ...(c.aspect ? { aspect: c.aspect } : {}), prompts: [], vec: '' }),
    })),
  }) + '\n'
}

// Real Response objects, so lenses.js reads them the way it reads the network (a stream, with
// its size limit)
function mockLensFetch(url) {
  const mode = _lensQs.get('lenscheck')
  return new Promise((resolve, reject) => setTimeout(() => {
    if (mode === 'offline') { reject(new TypeError('Failed to fetch')); return }
    const reply = (status, text = '') => resolve(new Response(text, { status }))
    if (mode === 'big' && url.endsWith('/qooti-lenses.json')) {
      reply(200, JSON.stringify({ format: 2, serial: 3, updated_at: '2026-11-18', lenses: [], note: 'x'.repeat(70 * 1024) }))
      return
    }
    if (mode !== 'updated') { reply(404); return }   // like today: no catalogue published yet
    const file = mockDesignNextText()
    if (url.endsWith('/qooti-lenses.json')) {
      reply(200, JSON.stringify({ format: 2, serial: 2, updated_at: '2026-11-18', lenses: [
        { id: 'design', version: MOCK_DESIGN_NEXT, file: MOCK_DESIGN_NEXT_FILE, size: new TextEncoder().encode(file).length, sha256: 'ab'.repeat(32), min_app: '1.0.0' },
      ] }))
    } else if (url.endsWith(`/${MOCK_DESIGN_NEXT_FILE}`)) {
      reply(200, file)
    } else {
      reply(404)
    }
  }, 700))
}

// ─── A big library (performance preview: ?mockitems=N) ───────────
// N more pictures (up to 5000) after the sample ones, all older than them, each with one to
// four stored suggestions: the scored picture/any entries of the three lenses (the thumbnail
// lens's 16:9 ones only on wide pictures) and now and then a collection hint. Same N, same
// items. Their pictures are flat gradient tiles drawn here: no network, a few dozen distinct images.
const MOCK_ITEMS_MAX = 5000
const MANY_ASPECTS   = [0.56, 0.67, 0.75, 0.8, 1, 1.33, 1.5, 1.78]
const _manyTiles     = new Map()

function manyTile(pair, ar) {
  const key = `${pair}|${ar}`
  if (!_manyTiles.has(key)) {
    const [a, b] = BQ_TILES[pair]
    const w = 160, h = Math.round(160 / ar)
    _manyTiles.set(key, 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><rect width='${w}' height='${h}' fill='url(#g)'/></svg>`))
  }
  return _manyTiles.get(key)
}

function mockManyItems(n) {
  const pool = []   // what a picture can get: every scored entry that isn't video-only
  for (const l of _mockLenses) for (const c of l.concepts) if (c.suggest !== false && c.media !== 'video') pool.push(c)
  let seed = 0x2545F491   // mulberry32: the same items every time
  const rand = () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = []
  for (let i = 0; i < n; i++) {
    const id  = `mock-g${String(i + 1).padStart(4, '0')}`
    const ar  = MANY_ASPECTS[Math.floor(rand() * MANY_ASPECTS.length)]
    const fit = pool.filter(c => !c.aspect || (ar >= c.aspect[0] && ar <= c.aspect[1]))
    const conf = {}
    for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) {
      conf[fit[Math.floor(rand() * fit.length)].id] = Math.round((0.3 + rand() * 0.5) * 100) / 100
    }
    if (rand() < 0.08) conf[rand() < 0.5 ? 'col:tag-1' : 'col:tag-2'] = 0.5
    MOCK_SUGGESTIONS[id] = conf   // Re-tag all scores them again from here
    const at = days(16) - i * 7 * 60 * 1000
    out.push({
      id, type: 'image', title: i % 3 ? null : `Study ${i + 1}`,
      stored_path: manyTile(i % BQ_TILES.length, ar), thumbnail_path: null, aspect_ratio: ar,
      mime_type: 'image/png', ocr_text: '', ocr_status: 'done', source_platform: null,
      file_hash: null, phash: null, phash_source: null, vault_id: null,
      source_url: null, palette: null, ocr_language: null,
      auto_tag_status: 'done', auto_tag_confidence: JSON.stringify(conf),
      auto_tag_model: 'lens-1', auto_tag_sig: 'mock0lens0sig001',
      created_at: at, updated_at: at,
    })
  }
  return out
}

{
  const n = Math.min(MOCK_ITEMS_MAX, Math.max(0, Math.floor(Number(_lensQs.get('mockitems')) || 0)))
  if (n) _inspirations.push(...mockManyItems(n))
}

// The stored suggestions follow the same-name rule from the start, as the app writes them
for (const item of _inspirations) {
  const conf = mockConf(item)
  const keep = Object.entries(conf).filter(([key]) => key.startsWith('col:') || !mockSameNameTag(item.id, key))
  if (keep.length !== Object.keys(conf).length) item.auto_tag_confidence = JSON.stringify(Object.fromEntries(keep))
}

// ─── Crop in the image player (design preview) ───────────────────
// Like crop.rs (spec §C4–C5), on a canvas: the picture is fetched (picsum answers CORS
// reads), cut, and kept as a blob: URL. Every crop is cut from the first original, which
// the item keeps privately (_original, _crop) until Restore original.
//  • ?crop=fail: every crop fails as 'unreadable' (the error toast, crop mode stays open).
//  • The same area saved as a copy twice: 'already_saved:<id>' (the same bytes, the same hash).
const MOCK_CROP_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const _mockCropCopies = new Map()   // `${source}|${pixel rect}` → the copy it made
const mockWait = ms => new Promise(r => setTimeout(r, ms))

/** An item as the page gets it: a copy, without the mock's private fields. */
function mockPublic(item) {
  if (!item) return null
  const { _original, _crop, ...rest } = item
  return { ...rest, has_original: !!_original }
}

// Suggestions after a crop or a restore: the lens scores came from the old framing, so
// only the collection hints stay (like Rust: only_col_hints)
function mockOnlyColHints(json) {
  const keep = Object.entries(mockConf({ auto_tag_confidence: json })).filter(([k]) => k.startsWith('col:'))
  return keep.length ? JSON.stringify(Object.fromEntries(keep)) : null
}

async function mockLoadBitmap(src) {
  try {
    const res = await fetch(src)
    if (!res.ok) throw new Error(String(res.status))
    return await createImageBitmap(await res.blob())
  } catch {
    throw 'unreadable'
  }
}

// The colours that cover most of the picture, most first (like palette_from_image)
function mockPalette(source) {
  try {
    const c = document.createElement('canvas')
    c.width = 24; c.height = 24
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(source, 0, 0, 24, 24)
    const d = g.getImageData(0, 0, 24, 24).data
    const bins = new Map()
    for (let i = 0; i < d.length; i += 4) {
      const key = ((d[i] >> 5) << 6) | ((d[i + 1] >> 5) << 3) | (d[i + 2] >> 5)
      const b = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
      b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]
      bins.set(key, b)
    }
    const hex = v => Math.round(v).toString(16).padStart(2, '0')
    return JSON.stringify([...bins.values()].sort((a, b) => b.n - a.n).slice(0, 5)
      .map(b => `#${hex(b.r / b.n)}${hex(b.g / b.n)}${hex(b.b / b.n)}`))
  } catch {
    return null
  }
}

async function mockCropImage({ id, x, y, w, h, mode } = {}) {
  await mockWait(350)   // a real save takes a moment
  const item = _inspirations.find(i => i.id === id)
  if (!item) throw 'not_found'
  const nums = [x, y, w, h]
  if (nums.some(n => typeof n !== 'number' || !Number.isFinite(n)) || x < 0 || y < 0 || x >= 1 || y >= 1
      || w <= 0 || h <= 0 || w > 1 || h > 1 || x + w > 1 + 1e-6 || y + h > 1 + 1e-6) throw 'bad_rect'
  if (mode !== 'replace' && mode !== 'copy') throw 'bad_mode'
  if (item.type !== 'image' || !MOCK_CROP_TYPES.has(item.mime_type)) throw 'unsupported'
  if (new URLSearchParams(location.search).get('crop') === 'fail') throw 'unreadable'

  // A re-crop of a cropped picture is cut from the first original: compose(prev, r)
  const prev = item._crop
  const r = prev
    ? { x: prev.x + x * prev.w, y: prev.y + y * prev.h, w: w * prev.w, h: h * prev.h }
    : { x, y, w, h }
  const src = item._original?.stored_path ?? item.stored_path
  const bitmap = await mockLoadBitmap(src)
  const W = bitmap.width, H = bitmap.height
  // Edges rounded, not sizes, so neighbouring crops meet exactly
  const px0 = Math.max(0, Math.round(r.x * W)), py0 = Math.max(0, Math.round(r.y * H))
  const px1 = Math.min(W, Math.round((r.x + r.w) * W)), py1 = Math.min(H, Math.round((r.y + r.h) * H))
  const pw = px1 - px0, ph = py1 - py0
  if (pw < 16 || ph < 16) { bitmap.close?.(); throw 'too_small' }
  if (pw === W && ph === H) { bitmap.close?.(); throw 'no_change' }

  const key = `${src}|${px0},${py0},${px1},${py1}`
  if (mode === 'copy') {
    const before = _mockCropCopies.get(key)
    if (before && _inspirations.some(i => i.id === before)) { bitmap.close?.(); throw `already_saved:${before}` }
  }

  const canvas = document.createElement('canvas')
  canvas.width = pw; canvas.height = ph
  canvas.getContext('2d').drawImage(bitmap, px0, py0, pw, ph, 0, 0, pw, ph)
  bitmap.close?.()
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92))
  if (!blob) throw 'disk'
  // The old blob: URLs are never revoked: the player still shows the old picture while
  // the new one grows into place
  const url = URL.createObjectURL(blob)
  const palette = mockPalette(canvas)
  const now = Date.now()

  if (mode === 'copy') {
    const copy = {
      ...mockPublic(item),
      id: `crop-${now}`,
      stored_path: url, thumbnail_path: null, aspect_ratio: pw / ph, palette,
      has_original: false, enhanced_path: null, file_hash: null, phash: null, phash_source: null,
      ocr_text: '', ocr_status: null, ocr_language: null,
      auto_tag_confidence: null, auto_tag_status: null, auto_tag_sig: null,
      created_at: now, updated_at: now,
    }
    _inspirations.unshift(copy)
    MOCK_INSPIRATION_TAGS[copy.id] = [...(MOCK_INSPIRATION_TAGS[item.id] ?? [])]
    _mockCropCopies.set(key, copy.id)
    return mockPublic(copy)
  }

  item._original ??= { stored_path: item.stored_path, palette: item.palette, file_hash: item.file_hash }
  item._crop = r
  Object.assign(item, {
    stored_path: url, aspect_ratio: pw / ph, palette, file_hash: null,
    enhanced_path: null, phash: null, phash_source: null,
    ocr_text: '', ocr_status: null, ocr_language: null,
    auto_tag_confidence: mockOnlyColHints(item.auto_tag_confidence),
    auto_tag_status: null, auto_tag_model: null, auto_tag_sig: null,
    updated_at: now,
  })
  return mockPublic(item)
}

async function mockRestoreOriginal(id) {
  await mockWait(250)
  const item = _inspirations.find(i => i.id === id)
  if (!item) throw 'not_found'
  if (!item._original) throw 'no_original'
  const orig = item._original
  // The original's real shape (Rust reads it from the file, EXIF applied)
  let ratio = null
  try {
    const bmp = await mockLoadBitmap(orig.stored_path)
    ratio = bmp.width / bmp.height
    bmp.close?.()
  } catch {
    throw 'original_missing'
  }
  delete item._original
  delete item._crop
  Object.assign(item, {
    stored_path: orig.stored_path, aspect_ratio: ratio, palette: orig.palette, file_hash: orig.file_hash,
    enhanced_path: null, phash: null, phash_source: null,
    ocr_text: '', ocr_status: null, ocr_language: null,
    auto_tag_confidence: mockOnlyColHints(item.auto_tag_confidence),
    auto_tag_status: null, auto_tag_model: null, auto_tag_sig: null,
    updated_at: Date.now(),
  })
  return mockPublic(item)
}
