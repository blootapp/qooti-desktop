// Tag lens: client state and helpers (spec §3, §5.6, §7).
//
// Lens files, scoring and the stored suggestions all live in Rust (lenses.rs, tagging.rs).
// This module keeps what the views need to show them:
//  • the installed lenses and their tags (list_lenses / list_concepts): one row per tag, with
//    an entry for every lens that has it (§0c: shared tags, add-by-hand entries);
//  • a cache of the library's tags, so every tag shows the right name: a lens tag
//    follows the app's language (decision 6), any other tag shows exactly as typed;
//  • the card display rule (§5.6, §0c): which stored suggestion keys show on a picture or
//    a video, in which order; and the tag picker's list of lens tags;
//  • the catalogue check (§3, §0b.5): at most once every 7 days while suggestions are on (a failed
//    check counts too), and on "Check now" in Settings; downloads have size limits.
//
// It reloads on LENS_CHANGED (bridged from Rust by auto-tag.js), on a language change and
// when the suggestions switch flips, then emits LENS_LOADED. Views re-render from
// LENS_LOADED, never from LENS_CHANGED: that one arrives before the fresh data.

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { currentLang } from './i18n.js'
import { getSetting, setSetting, mirrorSetting } from './settings.js'
import { makeLogger } from './logger.js'

const log = makeLogger('Lens')

/** The lenses (and the onboarding roles) in the fixed order every list shows them (§0.2). */
export const LENS_ORDER = ['motion', 'design', 'thumbnail']

// Cards put specialist suggestions first: motion, thumbnail, then design, then the
// collection hints (§0.10, §5.6). A lens this build doesn't know sorts by its role.
// A key ranks with the first lens that shows it (§0c).
const CARD_RANK = { motion: 0, thumbnail: 1, design: 3 }
const RANK_OTHER_SPECIALIST = 2
const RANK_OTHER_BASE       = 3
const RANK_COLLECTION_HINT  = 4
const RANK_UNKNOWN          = 9
const MEDIA = ['picture', 'video']   // an item's media (§0c): a video, or a picture (anything else)

const INDEX_URL        = 'https://api.bloot.app/download/qooti-lenses.json'
const FILE_BASE        = 'https://api.bloot.app/download/'
const CHECK_EVERY_S    = 7 * 24 * 60 * 60   // the automatic check runs at most once every 7 days (owner, 2026-11-20)
const FETCH_TIMEOUT_MS = 20_000
const MAX_INDEX_BYTES  = 64 * 1024      // §0b.5: the index is read up to 64 KB…
const MAX_FILE_BYTES   = 256 * 1024     // …a lens file up to its listed size, at most 256 KB (§2.3)
const MAX_LENS_VERSION = 100_000        // §0b.5: a higher version is never taken
const FIRST_LOAD_RETRY_MS = 5_000

// ─── State ───────────────────────────────────────────────────────
let _lenses      = []          // list_lenses rows, in LENS_ORDER
let _concepts    = []          // list_concepts rows
let _lensById    = new Map()
let _conceptById = new Map()
let _baseId      = null        // the base lens (role 'base'): specialists borrow its tags
let _showers     = new Map()   // concept id → { picture: [{ lens, via }], video: [...] }: who may show it (§0c)
let _tagById     = new Map()   // tag id → Tag (list_tags): col: hints and tagLabelById
let _peoplesByConcept = null    // concept id → the people's tag that stands for it (peoplesTagFor; built on use)
let _loaded      = false       // lens data arrived at least once (§5.6: nothing shows before)
let _status      = null        // the last lens_status / lens:status payload
let _inited      = false

// The tagger's progress is kept from the moment this module loads, not from initLenses: the
// store runs listeners in the order they were added, and Settings subscribes in its own init,
// before initLenses. So whoever paints on LENS_STATUS finds getLensStatus() already current.
store.on(events.LENS_STATUS, s => { _status = s ?? null })

// ─── Init + loading ──────────────────────────────────────────────

/**
 * Subscribes once and starts the first load. Call after initSettings (the suggestions
 * switch and the last check come from the settings cache). The promise resolves when the
 * first load is done, or after `wait` ms at the latest (the load carries on and emits
 * LENS_LOADED when it lands), so a slow backend never holds up start-up.
 */
export function initLenses({ wait = 800 } = {}) {
  if (!_inited) {
    _inited = true
    store.on(events.LENS_CHANGED, () => { loadLenses() })
    // The switch decides whether anything shows at all (isVisibleKey)
    store.on(events.SETTINGS_CHANGED, p => { if (p?.key === 'tag_recommendations_enabled') emitLoaded() })
    store.on(events.TAG_CREATED, p => {
      if (p?.tag?.id) { _tagById.set(p.tag.id, normalizeTag(p.tag)); _peoplesByConcept = null }
      refreshTags()
    })
    store.on(events.TAG_DELETED, p => {
      if (p?.id != null && _tagById.delete(p.id)) { _peoplesByConcept = null; emitLoaded() }   // its col: hints go too
      refreshTags()
    })
    // Imports, downloads and saves end in a reload; a pack import can bring new tags
    store.on(events.GRID_RELOAD, () => refreshTags(1000))
    // Deleting an item can take tags with it (the last lens tag of a concept, or older
    // backends' sweep of unused tags): their col: hints must stop showing at once
    store.on(events.GRID_ITEM_DELETED, () => refreshTags(300))
    document.addEventListener('i18n:changed', () => { loadLenses() })
  }
  const first = loadLenses().then(() => {
    if (!_loaded) setTimeout(() => { loadLenses() }, FIRST_LOAD_RETRY_MS)
  })
  refreshLensStatus()
  return Promise.race([first, new Promise(resolve => setTimeout(resolve, wait))])
}

let _loading = null
let _loadAgain = false

/**
 * Reads lenses, concepts and tags from the backend, then emits LENS_LOADED. Calls made
 * while a load is running share it (and it runs once more, so nothing is missed).
 * Never rejects; on failure the previous data stays.
 */
export function loadLenses() {
  if (_loading) { _loadAgain = true; return _loading }
  _loading = (async () => {
    do {
      _loadAgain = false
      try {
        const [lenses, concepts, tags] = await Promise.all([
          api.listLenses(),
          api.listConcepts(),
          api.listTags().catch(() => null),
        ])
        setData(lenses, concepts)
        if (Array.isArray(tags)) setTags(tags)
        _loaded = true
      } catch (err) {
        log.warn('load_failed', { error: err })
      }
    } while (_loadAgain)
    _loading = null
    emitLoaded()
  })()
  return _loading
}

function setData(lenses, concepts) {
  const rank = id => { const i = LENS_ORDER.indexOf(id); return i === -1 ? LENS_ORDER.length : i }
  _lenses = (Array.isArray(lenses) ? lenses : [])
    .map(l => ({ ...l, name: parseMaybe(l.name), summary: parseMaybe(l.summary) }))
    .sort((a, b) => rank(a.id) - rank(b.id))
  _concepts = (Array.isArray(concepts) ? concepts : [])
    .map(c => ({
      ...c, labels: parseMaybe(c.labels), group: parseMaybe(c.group),
      entries: asList(c.entries), borrowed_by: asList(c.borrowed_by),
    }))
  _lensById    = new Map(_lenses.map(l => [l.id, l]))
  _conceptById = new Map(_concepts.map(c => [c.id, c]))
  _baseId      = _lenses.find(l => l.role === 'base')?.id ?? null
  // Who may show a live tag, per media (§0c): every lens whose own scored entry covers that
  // media, then each specialist that borrows it (`borrows`, the lens rows) while the base
  // lens's entry covers that media and its own entry doesn't. Add-by-hand entries cover nothing.
  _showers = new Map()
  for (const c of _concepts) {
    if (!isActive(c)) continue
    const base = c.entries.find(e => e?.lens_id === _baseId)
    const by = {}
    for (const m of MEDIA) {
      const list = c.entries.filter(e => covers(e, m)).map(e => ({ lens: e.lens_id, via: 'own' }))
      if (covers(base, m)) {
        for (const l of _lenses) {
          if (l.role === 'base' || !asList(l.borrows).includes(c.id) || list.some(s => s.lens === l.id)) continue
          list.push({ lens: l.id, via: 'borrow' })
        }
      }
      by[m] = list
    }
    _showers.set(c.id, by)
  }
}

function emitLoaded() {
  if (!_loaded) return
  store.emit(events.LENS_LOADED, { lenses: getLenses(), concepts: getConcepts() })
}

// ─── Tag cache ───────────────────────────────────────────────────

function normalizeTag(tag) {
  return { ...tag, labels: parseMaybe(tag.labels) }
}

function setTags(tags) {
  _tagById = new Map(tags.filter(t => t?.id != null).map(t => [t.id, normalizeTag(t)]))
  _peoplesByConcept = null
}

function tagSignature() {
  let s = ''
  for (const [id, t] of _tagById) s += `${id}\u0001${t.name}\u0001${t.concept_id ?? ''}\u0002`
  return s
}

let _tagTimer = null
function refreshTags(delay = 150) {
  clearTimeout(_tagTimer)
  _tagTimer = setTimeout(async () => {
    try {
      const tags = await api.listTags()
      if (!Array.isArray(tags)) return
      const before = tagSignature()
      setTags(tags)
      if (tagSignature() !== before) emitLoaded()
    } catch (err) {
      log.debug('tags_refresh_failed', { error: err })
    }
  }, delay)
}

// ─── Reading the data ────────────────────────────────────────────

/** Lens data has arrived at least once. Before that no suggestion shows (§5.6). */
export function isLoaded() { return _loaded }

/** list_lenses rows in the fixed order (§0.2): { id, role, version, enabled, origin, name:{en,uz},
 *  summary:{en,uz}, updated_at, concepts:[id], borrows:[id] }. Treat as read-only. */
export function getLenses() { return _lenses.slice() }

/** list_concepts rows, one per tag: { id, lens_id (the first lens that has it), labels:{en,uz},
 *  group:{en,uz}|null, active, entries:[{ lens_id, media:'any'|'picture'|'video'|null, suggest }],
 *  borrowed_by:[lens ids] }. A tag no lens has any more is inactive with entries []. Read-only. */
export function getConcepts() { return _concepts.slice() }

export function getLens(id)    { return _lensById.get(id) ?? null }
export function getConcept(id) { return _conceptById.get(id) ?? null }

/** The tag suggestions switch (Settings › Tag lens › Tag suggestions). */
export function suggestionsOn() {
  const v = getSetting('tag_recommendations_enabled', 'false')
  return v === true || v === 'true'
}

/** The last lens_status / lens:status payload, or null before the first one. */
export function getLensStatus() { return _status }

/** Asks the backend for the tagging status now; emits LENS_STATUS with it. */
export async function refreshLensStatus() {
  try {
    const s = await api.lensStatus()
    _status = s ?? null
    if (s) store.emit(events.LENS_STATUS, s)
  } catch (err) {
    log.debug('status_failed', { error: err })
  }
  return _status
}

// ─── Labels ──────────────────────────────────────────────────────

/** A concept's label in `lang` (default: the app's language); '' when the concept is unknown. */
export function conceptLabel(id, lang) {
  return pickText(_conceptById.get(id)?.labels, lang)
}

/** A lens's name / summary in `lang` (default: the app's language). Takes a lens row or an id. */
export function lensName(lensOrId, lang) {
  return pickText((typeof lensOrId === 'string' ? _lensById.get(lensOrId) : lensOrId)?.name, lang)
}
export function lensSummary(lensOrId, lang) {
  return pickText((typeof lensOrId === 'string' ? _lensById.get(lensOrId) : lensOrId)?.summary, lang)
}

/**
 * The name to show for a tag, everywhere a tag name appears: a lens tag shows its concept's
 * label in the app's language (it changes with the language), never its stored name (the
 * English label, or "<label> (Tag lens)": what older versions show; an earlier build stored
 * `lens:<id>`); a people's tag shows its name exactly as typed or imported, in both languages.
 * A people's tag with a lens tag's name is that lens tag (one name, one tag: tagging.rs): it
 * stands for the concept and still shows its own name (the owner: "your tag keeps its name").
 * Any other tag was made by an older qooti from a suggestion key: Rust gives it its lens tag or
 * a readable name at start, and until then a name with an underscore (an id) shows as
 * readableName.
 */
export function tagLabel(tag, lang) {
  if (!tag) return ''
  const name = tag.name ?? ''
  if (isPeoplesSource(tag)) return name
  const conceptId = tagConceptId(tag)
  if (conceptId) {
    return conceptLabel(conceptId, lang) || pickText(parseMaybe(tag.labels), lang) || readableName(conceptId)
  }
  return name.includes('_') ? readableName(name) : name
}

/** A name for an id or a stored name that has no label, never shown as it is: "web_design" →
 *  "Web design", "lens:ui_design" → "Ui design" (tagging.rs readable_name). */
export function readableName(s) {
  const words = String(s ?? '').replace(/^lens:/, '').split(/[_\s]+/).filter(Boolean).join(' ')
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

/** `text` written earlier (the activity trail, log lines) with every lens tag's stored name
 *  `lens:<concept id>` as that tag's label in `lang` (default: the app's language); an id no
 *  lens knows reads as readableName when it has an underscore. Event names (lens:status) stay. */
export function labelLensNames(text, lang) {
  return String(text ?? '').replace(/(^|[^A-Za-z0-9_])lens:([a-z][a-z0-9_]{1,39})(?![a-z0-9_])/g, (all, before, id) => {
    const name = conceptLabel(id, lang) || (id.includes('_') ? readableName(id) : '')
    return name ? before + name : all
  })
}

/** tagLabel for a tag id, from the tag cache; '' when the tag isn't known (or was deleted). */
export function tagLabelById(tagId, lang) {
  const tag = _tagById.get(tagId)
  return tag ? tagLabel(tag, lang) : ''
}

/** The cached Tag for an id, or null. */
export function getTag(tagId) { return _tagById.get(tagId) ?? null }

/** The label of a stored suggestion key: a concept id, or `col:<tag id>` (a collection hint).
 *  A question about a concept whose tag is a people's tag (one name, one tag) shows that tag's
 *  own name, the name the item shows once it is added. */
export function keyLabel(key, lang) {
  if (typeof key !== 'string') return ''
  if (key.startsWith('col:')) return tagLabelById(key.slice(4), lang)
  const own = peoplesTagFor(key)
  return own ? tagLabel(own, lang) : conceptLabel(key, lang)
}

/** The people's tag that stands for `conceptId` (one name, one tag), from the tag cache, or null. */
function peoplesTagFor(conceptId) {
  if (!_peoplesByConcept) {
    _peoplesByConcept = new Map()
    for (const t of _tagById.values()) {
      const c = tagConceptId(t)
      if (c && isPeoplesSource(t) && !_peoplesByConcept.has(c)) _peoplesByConcept.set(c, t)
    }
  }
  return _peoplesByConcept.get(conceptId) ?? null
}

/**
 * Every name a tag or a concept row can be found by, in both languages: for matching what
 * someone types (the detail panel's tag picker, Settings). Lens tags and concepts give their
 * EN and UZ labels; other tags their name; a people's tag that stands for a concept (one name,
 * one tag) both: it shows its own name, and is found by the labels too.
 */
export function searchLabels(tagOrConcept) {
  if (!tagOrConcept || typeof tagOrConcept !== 'object') return []
  const isRow = 'lens_id' in tagOrConcept
  const conceptId = isRow ? tagOrConcept.id : tagConceptId(tagOrConcept)
  if (!conceptId) return tagOrConcept.name ? [tagOrConcept.name] : []
  const labels = _conceptById.get(conceptId)?.labels ?? parseMaybe(tagOrConcept.labels) ?? {}
  const own = !isRow && isPeoplesSource(tagOrConcept) ? [tagOrConcept.name] : []
  return [...new Set([labels.en, labels.uz, ...own].filter(Boolean))]
}

// ─── Display rule (§5.6, §0c) ────────────────────────────────────

/** An item's media for the display rule: 'video' for a video, 'picture' for anything else. */
export function mediaOf(item) { return item?.type === 'video' ? 'video' : 'picture' }

// A lens's rank on cards: motion 0, thumbnail 1, another specialist 2, design or another base 3
function cardRank(l) {
  if (Object.prototype.hasOwnProperty.call(CARD_RANK, l.id)) return CARD_RANK[l.id]
  return l.role === 'base' ? RANK_OTHER_BASE : RANK_OTHER_SPECIALIST
}

// The first lens that is on and shows tag `key` on `media`, by card rank (then by id):
// → { lens, via: 'own' | 'borrow', rank }, or null. Lens ids that aren't installed are ignored.
function shownBy(key, media) {
  let best = null
  for (const s of _showers.get(key)?.[media] ?? []) {
    const l = _lensById.get(s.lens)
    if (!isEnabled(l)) continue
    const rank = cardRank(l)
    if (!best || rank < best.rank || (rank === best.rank && s.lens < best.lens)) best = { lens: s.lens, via: s.via, rank }
  }
  return best
}

/**
 * Whether a stored suggestion key may show on a card of `media` ('picture' | 'video'): lens
 * data has loaded, suggestions are on, and the key is a `col:` hint whose tag still exists,
 * or a tag that a lens that's on shows on that media (its own entry, or a borrowed base one).
 * Unknown keys and add-by-hand tags never show.
 */
export function isVisibleKey(key, media = 'picture') {
  if (!_loaded || typeof key !== 'string' || !suggestionsOn()) return false
  if (key.startsWith('col:')) return _tagById.has(key.slice(4))
  return shownBy(key, mediaKind(media)) !== null
}

/** Sort rank of a suggestion key on cards of `media`: the first lens that shows it (motion 0,
 *  thumbnail 1, another specialist 2, design 3), col: hints 4, a key no lens that's on shows 9. */
export function lensOrderIndex(key, media = 'picture') {
  if (typeof key !== 'string') return RANK_UNKNOWN
  if (key.startsWith('col:')) return RANK_COLLECTION_HINT
  return shownBy(key, mediaKind(media))?.rank ?? RANK_UNKNOWN
}

/** What the detail panel's tag picker offers from the lenses (§0c): one row per live tag that
 *  a lens that's on has (suggested or added by hand) or borrows, a shared tag once. Lenses in
 *  the fixed order (§0.2), each lens's tags in its file order, then its borrows. The item's
 *  media and the suggestions switch don't matter. */
export function visibleConcepts() {
  const rank = id => { const i = LENS_ORDER.indexOf(id); return i === -1 ? LENS_ORDER.length : i }
  const on = _lenses.filter(isEnabled)
    .sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out = []
  const seen = new Set()
  for (const l of on) {
    for (const id of [...asList(l.concepts), ...(l.role === 'base' ? [] : asList(l.borrows))]) {
      if (seen.has(id)) continue
      const c = _conceptById.get(id)
      if (!c || !isActive(c)) continue
      seen.add(id)
      out.push(c)
    }
  }
  return out
}

/** An item's suggestions (JSON text or object) as a plain { key: score } object. The item field
 *  is still called auto_tag_confidence; Rust fills it from the lens_suggestions column, never
 *  from the old column of that name (older versions show its keys as tag names). */
export function parseConfidence(json) {
  if (!json) return {}
  if (typeof json === 'object') return Array.isArray(json) ? {} : json
  try {
    const o = JSON.parse(json)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

/**
 * The suggestions an item's card shows (§5.6, §0c): the keys a lens that's on shows on the
 * item's media (a picture or a video), each ranked with the first lens that shows it
 * (motion, thumbnail, then design), then collection hints; by score within each, then by
 * key; numeric scores only; at most 3 for a picture and 2 for a video.
 * → [{ key, score, label, lens (null for a hint), via: 'own' | 'borrow' | 'col', rank }].
 * Cards ask one at a time.
 */
export function visibleSuggestions(item) {
  if (!_loaded || !suggestionsOn()) return []
  const media = mediaOf(item)
  const rows = []
  for (const [key, score] of Object.entries(parseConfidence(item?.auto_tag_confidence))) {
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    if (key.startsWith('col:')) {
      if (_tagById.has(key.slice(4))) rows.push({ key, score, lens: null, via: 'col', rank: RANK_COLLECTION_HINT })
      continue
    }
    const s = shownBy(key, media)
    if (s) rows.push({ key, score, lens: s.lens, via: s.via, rank: s.rank })
  }
  return rows
    .sort((a, b) => a.rank - b.rank || b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(r => ({ ...r, label: keyLabel(r.key) }))
    .filter(r => r.label)
    .slice(0, media === 'video' ? 2 : 3)
}

// ─── Same-name rule (§0b.2) ──────────────────────────────────────

/**
 * A tag name or a concept label as the same-name rule compares it, exactly like Rust
 * (tagging::name_key) and the lens tools (lens-score.mjs nameKey): trimmed of Unicode white
 * space, in lower case, with ‘ ’ ʻ ʼ ` as '.
 */
export function sameNameKey(s) {
  return String(s ?? '').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '').toLowerCase().replace(/[‘’ʻʼ`]/g, "'")
}

/** A people's tag: typed or imported (source user or import), also one that stands for a concept
 *  (one name, one tag). It shows its own name (tagLabel), Settings asks before deleting it
 *  (tagDeleteAsksFirst), and Rust never sweeps or renames it. */
export function isPeoplesSource(t) { return !!t && (t.source === 'user' || t.source === 'import') }
// A people's tag that stands for a concept is that lens tag for the same-name rule, as in Rust
// (tagging::tag_named)
const isPeoplesTag = t => isPeoplesSource(t) && !tagConceptId(t)

// A concept's English and Uzbek labels as name keys (from the lens data, else from `labels`)
function conceptNameKeys(id, labels) {
  const l = _conceptById.get(id)?.labels ?? parseMaybe(labels) ?? {}
  return [l.en, l.uz].map(sameNameKey).filter(Boolean)
}

/**
 * The stored questions (keys of `conf`, an item's suggestion map) that ask the name `tag` has
 * just given the item. Rust drops them when it links the tag (tagging::drop_questions_named_like);
 * the grid drops them from its copy too, so the next question on the card isn't one of them.
 * A people's tag takes the lens questions whose English or Uzbek label is its name, and the
 * hints of other people's tags with that name; a lens tag takes the hints of people's tags
 * named like either of its labels. → [key]
 */
export function questionsNamedLike(tag, conf) {
  if (!tag || !conf || typeof conf !== 'object') return []
  const conceptId = tagConceptId(tag)
  const people = isPeoplesTag(tag)
  const names = new Set(people ? [sameNameKey(tag.name)].filter(Boolean) : conceptId ? conceptNameKeys(conceptId, tag.labels) : [])
  if (!names.size) return []
  return Object.keys(conf).filter(key => {
    if (key.startsWith('col:')) {
      const hinted = _tagById.get(key.slice(4))
      return hinted?.id !== tag.id && isPeoplesTag(hinted) && names.has(sameNameKey(hinted.name))
    }
    return people && conceptNameKeys(key).some(n => names.has(n))
  })
}

// ─── Changing lenses (call these rather than api.*: they also refresh the state here) ──

/** Turns one lens on or off (a display filter: nothing is re-scored). Resolves after the reload. */
export async function setLensEnabled(id, enabled) {
  await api.setLensEnabled(id, !!enabled)
  await loadLenses()
}

/**
 * The onboarding answer (§0.3): turns on only that role's lens and turns suggestions on.
 * The backend saves user_role and the switch; the settings cache is told here.
 */
export async function applyRole(role) {
  await api.applyRole(role)
  mirrorSetting('user_role', role)
  mirrorSetting('tag_recommendations_enabled', 'true')
  applyCollectionHints()   // suggestions are on now: the collection hints can be written too
  await loadLenses()
}

/**
 * Writes the collection hints (col:<tag id>) for the whole library now. They are only written
 * while suggestions are on, so call this when they turn on (the role step, the Settings
 * switch). The backend sends autotag:scored for the items that got one, so their cards update.
 * Resolves with that number of items (0 on failure); never rejects.
 */
export function applyCollectionHints() {
  return Promise.resolve()
    .then(() => api.applyCollectionTagSuggestions())
    .then(n => { if (n) log.info('collection_hints', { items: n }); return Number(n) || 0 })
    .catch(err => { log.debug('collection_hints_failed', { error: err }); return 0 })
}

// ─── Catalogue check (§3, §0b.5) ─────────────────────────────────

let _checking = null   // { force, promise }

/**
 * Looks for newer lens files and installs them.
 *  • Without `force` (the automatic check) it runs only while suggestions are on and a day
 *    has passed since the last check, failed or not; otherwise it resolves 'skipped' at once.
 *  • With `force` ("Check now") it always runs.
 * Resolves (never rejects) 'updated' | 'up_to_date' | 'offline' (| 'skipped' without force).
 * A missing catalogue (404) counts as up to date; the automatic check never shows anything.
 */
export function checkForLensUpdates({ force = false } = {}) {
  if (_checking && (_checking.force || !force)) return _checking.promise
  const prev = _checking?.promise ?? Promise.resolve()
  const entry = { force }
  entry.promise = prev.catch(() => {}).then(() => runCheck(force)).catch(err => {
    log.warn('check_failed', { error: err })
    return 'offline'
  })
  _checking = entry
  entry.promise.finally(() => { if (_checking === entry) _checking = null })
  return entry.promise
}

/** When the catalogue was last checked (unix seconds), or 0. */
export function lastCheck() {
  return Number(getSetting('lens_last_check', 0)) || 0
}

function isDue() {
  if (!suggestionsOn()) return false
  const last = lastCheck()
  const now = nowS()
  return now - last >= CHECK_EVERY_S || last > now + 3600   // a clock set back counts as due
}

async function runCheck(force) {
  if (!force && !isDue()) return 'skipped'
  let result
  try {
    result = await checkCatalogue()
  } catch (err) {
    log.warn('check_failed', { error: err })
    result = 'offline'
  }
  // A failed check counts as a check too (§3: any failure is "nothing new"; §0b.5): the
  // automatic one tries again after a day, not every hour. Only "Check now" ignores the wait,
  // and when it fails it leaves the day as it was.
  if (result === 'offline' && !force) await noteChecked()
  return result
}

// One look at the catalogue → 'updated' | 'up_to_date' | 'offline'. Every outcome except
// 'offline' records the check here (with the index serial when the index was taken).
async function checkCatalogue() {
  let index
  try {
    const res = await fetchText(INDEX_URL, MAX_INDEX_BYTES)
    if (res.status === 404) { await noteChecked(); return 'up_to_date' }   // nothing published yet
    if (!res.ok) return 'offline'
    index = JSON.parse(res.text)   // a sign-in page from a hotel Wi-Fi fails here too
  } catch (err) {
    log.info('check_offline', { error: err })
    return 'offline'
  }

  const serial = Number(index?.serial)
  if (index?.format !== 2 || !Array.isArray(index.lenses) || !Number.isFinite(serial)) {
    await noteChecked()   // a newer format, or not an index at all: nothing to take
    return 'up_to_date'
  }
  if (serial > serialCeiling()) {
    // Serials are dates (build.mjs). Taking one this far ahead would make every later index
    // look older, so the whole index is left alone.
    log.warn('index_refused', { serial })
    await noteChecked()
    return 'up_to_date'
  }
  if (serial < knownSerial()) { await noteChecked(); return 'up_to_date' }   // an older copy of the index

  const installed  = await installedVersions()
  const appVersion = await getAppVersion()
  const wanted = wantedEntries(index.lenses, installed, appVersion)
  if (!wanted.length) { await noteChecked(serial); return 'up_to_date' }

  const files = []
  try {
    for (const e of wanted) {
      const res = await fetchText(FILE_BASE + e.file, e.size)   // never more than the index lists
      if (!res.ok) return 'offline'
      // id and version too: the backend checks the file is the lens its entry names
      files.push({ text: res.text, sha256: e.sha256.toLowerCase(), size: e.size, id: e.id, version: e.version })
    }
  } catch (err) {
    log.info('download_failed', { error: err })
    return 'offline'
  }

  try {
    const result = await api.installLenses(files)   // all or nothing; re-scores on its own
    await noteChecked(serial)
    const ids = Array.isArray(result?.installed) ? result.installed : []
    if (!ids.length) return 'up_to_date'
    log.info('installed', { lenses: ids.join(',') })
    await loadLenses()
    return 'updated'
  } catch (err) {
    // The backend answers 'invalid' | 'checksum' | 'too_new' | 'failed', maybe followed by ': detail'
    const code = String(err?.message ?? err).split(':')[0].trim()
    log.warn('install_refused', { code })
    // A cut-off download ('checksum'), a busy database ('failed')…: a failed check, tried again later
    if (code !== 'invalid' && code !== 'too_new') return 'offline'
    await noteChecked(serial)   // a broken or too-new file: wait for the next catalogue
    return 'up_to_date'
  }
}

// What to download (§3, §0b.5): only the three lenses this app knows, newer than the installed
// copy and meant for this app version; the newest entry per lens. So at most 3 files of at
// most 256 KB each (768 KB in all), which is also what install_lenses accepts.
function wantedEntries(entries, installed, appVersion) {
  const newest = new Map()
  for (const e of entries) {
    if (!isWanted(e, installed, appVersion)) continue
    if (!newest.has(e.id) || e.version > newest.get(e.id).version) newest.set(e.id, e)
  }
  return LENS_ORDER.filter(id => newest.has(id)).map(id => newest.get(id))
}

function isWanted(e, installed, appVersion) {
  return !!e && LENS_ORDER.includes(e.id)
    && Number.isInteger(e.version) && e.version >= 1 && e.version <= MAX_LENS_VERSION
    && e.version > (installed.get(e.id) ?? 0)
    && (e.min_app == null || compareVersions(e.min_app, appVersion) <= 0)
    && typeof e.file === 'string' && /^qooti-lens-[a-z0-9][a-z0-9_.-]{0,100}\.json$/.test(e.file)
    && Number.isInteger(e.size) && e.size > 0 && e.size <= MAX_FILE_BYTES
    && typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(e.sha256)
}

// Index serials are dates: YYYYMMDD × 100 + a count (build.mjs). The highest one taken is a
// year from today (…99 that day); a higher one can only come from a broken or hostile index.
function serialCeiling(now = Date.now()) {
  const d = new Date(now)
  const y = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()))
  return (y.getUTCFullYear() * 10000 + (y.getUTCMonth() + 1) * 100 + y.getUTCDate()) * 100 + 99
}

// The serial of the newest index taken. A stored one above the ceiling (saved before there was
// one) counts as 0, so the next normal index is taken and replaces it.
function knownSerial() {
  const n = Number(getSetting('lens_catalogue_serial', 0))
  return Number.isFinite(n) && n > 0 && n <= serialCeiling() ? n : 0
}

async function installedVersions() {
  const rows = await api.listLenses().catch(() => _lenses)
  return new Map((Array.isArray(rows) ? rows : []).map(l => [l.id, Number(l.version) || 0]))
}

let _appVersion = null
async function getAppVersion() {
  if (_appVersion == null) {
    _appVersion = await api.getAppInfo().then(i => String(i?.version ?? ''), () => '')
  }
  return _appVersion
}

async function noteChecked(serial) {
  try {
    await setSetting('lens_last_check', String(nowS()))
    if (Number.isFinite(serial) && serial > knownSerial() && serial <= serialCeiling()) {
      await setSetting('lens_catalogue_serial', String(serial))
    }
  } catch (err) {
    log.warn('save_check_failed', { error: err })
  }
}

// GET as text, never from the HTTP cache, with a time limit and a size limit (§0b.5): a
// response that says it is longer than `maxBytes` (Content-Length) is refused unread, and the
// body is read as a stream that stops as soon as it passes the limit, so a broken or hostile
// server can't fill the window's memory. Too long throws (the check counts it as failed).
// The browser preview (mock.js) answers through api.mockFetch instead of the network.
async function fetchText(url, maxBytes) {
  const ctrl  = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null
  try {
    const opts = { cache: 'no-store', signal: ctrl?.signal }
    const res = typeof api.mockFetch === 'function' ? await api.mockFetch(url, opts) : await fetch(url, opts)
    if (!res.ok) {
      dropBody(res)
      return { ok: false, status: res.status, text: '' }
    }
    const declared = Number(res.headers?.get?.('content-length') ?? NaN)
    if (declared > maxBytes) {
      dropBody(res)
      throw new Error(`too_big: ${declared} bytes, the limit is ${maxBytes}`)
    }
    return { ok: true, status: res.status, text: await readTextUpTo(res, maxBytes) }
  } finally {
    clearTimeout(timer)
  }
}

// The body as UTF-8 text, read until it ends or passes `maxBytes` (then it throws)
async function readTextUpTo(res, maxBytes) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    // No stream to read from: the whole text, under the same limit
    const text = await res.text()
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error(`too_big: over ${maxBytes} bytes`)
    return text
  }
  const parts = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      reader.cancel().catch(() => {})
      throw new Error(`too_big: over ${maxBytes} bytes`)
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const p of parts) { bytes.set(p, at); at += p.byteLength }
  return new TextDecoder('utf-8').decode(bytes)   // like res.text(): UTF-8, a leading BOM dropped
}

function dropBody(res) {
  try { res.body?.cancel?.()?.catch?.(() => {}) } catch { /* nothing to drop */ }
}

// ─── Helpers ─────────────────────────────────────────────────────

/** A timestamp from the backend as a Date: unix seconds, milliseconds or a date string. */
export function toDate(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value)
    if (!n) return null
    return new Date(n < 1e12 ? n * 1000 : n)
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The concept a tag stands for (a lens tag, or a people's tag with a lens tag's name: one name,
 *  one tag), or null for any other people's tag (typed or imported). */
export function tagConceptId(tag) {
  if (!tag) return null
  if (tag.concept_id) return tag.concept_id
  // Older backends may not join concept_id; an earlier build named lens tags 'lens:<concept id>'
  // (Rust stores them under their label now and renames those at start)
  return tag.source === 'lens' && typeof tag.name === 'string' && tag.name.startsWith('lens:') ? tag.name.slice(5) : null
}

/** Settings › Library › Tags asks before deleting `tag` (spec §0b.4): every people's tag, also one
 *  that stands for a concept (it holds the person's own items, and its name can't be typed again),
 *  and a tag it can't tell. Only a lens tag goes with one click: the item panel's list adds it back. */
export function tagDeleteAsksFirst(tag) {
  return !tag || !tagConceptId(tag) || isPeoplesSource(tag)
}

function pickText(texts, lang) {
  if (!texts || typeof texts !== 'object') return ''
  const l = lang ?? currentLang()
  return texts[l] || texts.en || texts.uz || ''
}

function parseMaybe(v) {
  if (typeof v !== 'string') return v ?? null
  try { return JSON.parse(v) } catch { return null }
}

function isActive(c)  { return c.active !== false && c.active !== 0 }
function isEnabled(l) { return !!l && (l.enabled === true || l.enabled === 1) }

// A list_concepts entry suggests its tag on media `m` when it's scored and its media is 'any'
// (or missing) or `m`; an add-by-hand entry ("suggest": false) covers nothing (§0c)
function covers(e, m) {
  return !!e && e.suggest !== false && (e.media == null || e.media === 'any' || e.media === m)
}
function mediaKind(m) { return m === 'video' ? 'video' : 'picture' }
function asList(v)    { return Array.isArray(v) ? v : [] }

function nowS() { return Math.floor(Date.now() / 1000) }

function versionParts(v) {
  return (String(v ?? '').match(/\d+/g) ?? []).slice(0, 3).map(Number)
}

function compareVersions(a, b) {
  const pa = versionParts(a), pb = versionParts(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}
