// Mock data returned when running in the browser (outside Tauri).
// Swap stored_path for picsum URLs so cards render with real-looking images.
// This file is never imported in production — only tauri-api.js uses it.

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
].map((item, i) => ({
  thumbnail_path: null, aspect_ratio: 0.8,
  file_hash: null, phash: null, phash_source: null, vault_id: null,
  source_url: null, palette: null, ocr_language: null,
  auto_tag_status: i % 3 === 0 ? 'done' : null,
  auto_tag_confidence: i % 3 === 0 ? JSON.stringify({ minimal: 0.87, typography: 0.72, 'dark-mode': 0.61 }) : null,
  auto_tag_model: i % 3 === 0 ? 'mobileclip-s0-v1' : null,
  ...item,
}))

export const MOCK_COLLECTIONS = [
  { id: 'col-1', name: 'Branding',    visible_on_home: true,  created_at: days(30), updated_at: days(1) },
  { id: 'col-2', name: 'Typography',  visible_on_home: true,  created_at: days(25), updated_at: days(3) },
  { id: 'col-3', name: 'UI Patterns', visible_on_home: false, created_at: days(20), updated_at: days(5) },
]

export const MOCK_TAGS = [
  { id: 'tag-1', name: 'minimal',    source: 'user',  created_at: days(10), usage_count: 7 },
  { id: 'tag-2', name: 'typography', source: 'user',  created_at: days(9),  usage_count: 5 },
  { id: 'tag-3', name: 'motion',     source: 'model', created_at: days(8),  usage_count: 3 },
  { id: 'tag-4', name: 'dark-mode',  source: 'user',  created_at: days(7),  usage_count: 2 },
]

// Mock tag assignments per inspiration
const MOCK_INSPIRATION_TAGS = {
  'mock-01': ['tag-1'],
  'mock-02': ['tag-1', 'tag-2'],
  'mock-07': ['tag-2'],
  'mock-10': ['tag-3'],
}

export const MOCK_IMPORT_RESULT = { imported: [], skipped: [], existing: [] }

// ─── Mock API ────────────────────────────────────────────────────
// Each function mirrors the signature of the real api.* method.

let _inspirations = [...MOCK_INSPIRATIONS]
const _notifications = [
  { id: 'notif-1', title: 'Welcome to qooti', body: 'Start saving images, videos and links to build your personal inspiration library.', type: 'info',    read: false, created_at: Date.now() - 3 * 60 * 1000 },
  { id: 'notif-2', title: 'Chrome extension available', body: 'Save anything from the web directly with the qooti browser extension.', type: 'info', read: false, created_at: Date.now() - 2 * 86400 * 1000 },
  { id: 'notif-3', title: 'Library synced', body: 'All 16 items are available locally.', type: 'success', read: true,  created_at: Date.now() - 5 * 86400 * 1000 },
]

export const mockApi = {
  getAppInfo:    () => Promise.resolve({ platform: 'web-mock', version: '1.0.0-dev' }),
  getSettings:   () => Promise.resolve({ ...MOCK_SETTINGS }),
  setSetting:    () => Promise.resolve(),

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
        const tagIds = MOCK_INSPIRATION_TAGS[i.id] ?? []
        return MOCK_TAGS.some(t => tagIds.includes(t.id) && t.name.toLowerCase().includes(q))
      })
    }
    if (opts.uncollected) {
      const inCols = ['mock-01','mock-02','mock-03','mock-04','mock-05','mock-06','mock-07','mock-08']
      items = items.filter(i => !inCols.includes(i.id))
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
    return Promise.resolve(items.slice(page * limit, page * limit + limit))
  },

  getInspiration: id => Promise.resolve(_inspirations.find(i => i.id === id) ?? null),

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
    const tags = MOCK_TAGS.map(t => ({
      ...t,
      usage_count: Object.values(MOCK_INSPIRATION_TAGS).filter(ids => ids.includes(t.id)).length,
    })).sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name))
    return Promise.resolve(tags)
  },
  getTagsForInspiration: id => {
    const ids = MOCK_INSPIRATION_TAGS[id] ?? []
    return Promise.resolve(MOCK_TAGS.filter(t => ids.includes(t.id)))
  },
  createTag: (name, source) => {
    const tag = { id: `tag-${Date.now()}`, name, source: source ?? 'user', created_at: Date.now(), usage_count: 0 }
    MOCK_TAGS.push(tag)
    return Promise.resolve(tag)
  },
  deleteTag: () => Promise.resolve(),
  tagInspiration: (insId, tagId) => {
    if (!MOCK_INSPIRATION_TAGS[insId]) MOCK_INSPIRATION_TAGS[insId] = []
    if (!MOCK_INSPIRATION_TAGS[insId].includes(tagId)) MOCK_INSPIRATION_TAGS[insId].push(tagId)
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

  getNotifications:     () => Promise.resolve([..._notifications]),
  markNotificationRead: id => { const n = _notifications.find(n => n.id === id); if (n) n.read = true; return Promise.resolve() },

  getMobileConnectionQr: () => Promise.resolve('MOCK-QR-KEY'),
  resetMobileConnectionKey: () => Promise.resolve('MOCK-QR-KEY'),
  answerExtensionPair:  () => Promise.resolve(),
  listExtensionClients: () => Promise.resolve([{ origin: 'chrome-extension://mock', browser: 'Edge', approved_at: Date.now() - 86400000 }]),
  removeExtensionClient: () => Promise.resolve(),

  claimAutoTagCandidates: () => Promise.resolve([]),
  finalizeAutoTagResult:  () => Promise.resolve(),

  listTagVocab:     () => Promise.resolve([]),
  upsertTagVocab:   () => Promise.resolve(),
  deleteTagVocab:   () => Promise.resolve(),
  resetAllAutoTags:     () => Promise.resolve(0),
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
    formats: video ? ['video', 'thumbnail', 'link'] : ['image', 'link'],
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
