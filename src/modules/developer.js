import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { refreshLensStatus, toDate, tagConceptId } from './lenses.js'
import { t, currentLang } from './i18n.js'
import { showConfirm } from './dialog.js'
import { startWalkthrough } from './walkthrough.js'
import { startStarterPreview } from './starter.js'

const IS_TAURI = '__TAURI_INTERNALS__' in window

// ─── Icon helper (same pattern as the rest of the app) ──────────────────────
const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

// ─── MD instruction file content ────────────────────────────────────────────
// A brief for Claude or ChatGPT to draft Tag lens concepts in the lens file format
// (spec §2.1, §10). Lens files live in lenses/src and are built by scripts/lenses.
const MD_CONTENT = `# qooti Tag lens: concept builder

You help write concepts (tags) for a **qooti Tag lens**. qooti is a design inspiration library for video editors, motion designers, graphic designers and YouTube thumbnail designers. A Tag lens is one list of concepts for one kind of work: \`motion\`, \`design\` (the base lens) or \`thumbnail\`. qooti suggests a concept on an item when CLIP finds the picture (or at least 45 % of the frames of a video up to 60 seconds long, one frame per second) closest to it.

## How CLIP scores (read this first)

- qooti puts each prompt into the sentence "This is a photo of …", embeds it once when the lens is built, and averages a concept's prompts into one vector.
- A picture is compared with every concept of the lens at once and the closest concept wins. Two concepts that look alike take votes from each other, and both end up weak.
- CLIP sees one centre square at 224 px. It can't read words: concepts defined by their text (sale, giveaway, quote) never fire. Small details such as arrows vanish.
- Formats (a 9:16 story, a 16:9 thumbnail) don't show in the square: give those an \`aspect\` range.
- Motion (transitions, speed ramps, kinetic type, a talking head) isn't in a still frame: use \`"media": "video"\` at most, or make it an add-by-hand entry (\`"suggest": false\`).

## Good prompts

- 2–6 words of plain English, describing only what you literally see: "a green screen backdrop", "neon signs at night".
- 2–4 prompts per concept, all in the same style, each a different look of the same idea.
- No abstract words ("modern", "aesthetic", "professional", "cinematic feel").
- Every prompt is unique across all three lenses, also between the entries of one shared tag.

## Concept rules

- \`id\`: lowercase letters, digits and \`_\`, starting with a letter, at most 40 characters, at most once per lens. The same \`id\` in another lens is the same tag (see Shared tags).
- \`label\`: what people see on cards, in English (\`en\`) and Uzbek (\`uz\`). At most 14 characters where possible (24 at most). Uzbek uses ‘ (U+2018) in o‘ and g‘ and ’ (U+2019) for the tutuq, never ' or \`. No \`_\` in labels or groups: an underscore reads as an id, so use a space (the checker and the app refuse the file).
- \`media\`: "any", "picture" or "video". \`design\` reads pictures only: its entries are "picture".
- \`aspect\` (only for formats): [min, max] of width ÷ height, e.g. [0.5, 0.62] for 9:16.
- \`group\` (optional): the heading the tag sits under, \`{ "en": …, "uz": … }\`, at most 24 characters, no \`_\`, e.g. Techniques / Usullar.
- \`"suggest": false\` makes an add-by-hand entry: only \`id\`, \`label\` and an optional \`group\`, no prompts, media or aspect. People find it in the tag picker and in search; it is never suggested.
- At most 80 scored entries and 120 entries in all per lens.

## Shared tags

- One tag may have an entry in several lenses: the same \`id\`, byte-identical labels in both languages, and other media. \`design\` and \`thumbnail\` describe pictures, \`motion\` describes videos, each with its own prompts.
- Across the lenses, at most one scored entry of a tag covers pictures and at most one covers videos.
- \`motion\` and \`thumbnail\` can also show a \`design\` tag by listing it in \`borrows\`: on the media design's entry covers.

## Output format

Answer with concept objects the user can paste into the \`concepts\` list of \`lenses/src/<lens>.json\`:

\`\`\`json
{ "id": "green_screen",
  "label":   { "en": "Green screen", "uz": "Yashil ekran" },
  "prompts": ["a green screen backdrop", "a person in front of a green screen"],
  "media":   "any" }
\`\`\`

An add-by-hand tag:

\`\`\`json
{ "id": "transitions",
  "label":   { "en": "Transitions", "uz": "O‘tishlar" },
  "group":   { "en": "Techniques", "uz": "Usullar" },
  "suggest": false }
\`\`\`

## Your task

1. Ask which lens the concept is for (motion, design or thumbnail) and what it should catch.
2. Ask for 2–10 reference images that show it, the more varied the better.
3. Work out what the images share, and what sets them apart from the closest other concept.
4. Write 2–4 prompts of 2–6 words, check them against the rules above, and output the JSON.
5. Ask whether any prompt could also match another concept, and refine it.

Begin with step 1.
`

// ─── State ──────────────────────────────────────────────────────────────────
let overlay  = null
let listEl   = null   // left pane: every concept, lens by lens
let sideEl   = null   // right pane: the lenses, then the tagging status
let _viewSeq = 0      // a newer load wins over a slower older one

// ─── Open / Close ───────────────────────────────────────────────────────────
function openDevPage() {
  buildShell()   // on every open, so it's in the app's current language
  overlay.removeAttribute('hidden')
  swapSwatchIcon(true)
  loadLensView()
}

function closeDevPage() {
  overlay.setAttribute('hidden', '')
  swapSwatchIcon(false)
}

// ─── Color swatch icon swap ──────────────────────────────────────────────────
function swapSwatchIcon(devMode) {
  const btn    = document.querySelector('#color-swatch-btn')
  const iconEl = btn?.querySelector('.icon-cp')
  if (!iconEl) return

  if (devMode) {
    // Hide the colour wheel; show a green terminal (mask) as the dev indicator.
    iconEl.style.backgroundImage = 'none'
    iconEl.style.backgroundColor = '#4ADE80'
    iconEl.style.maskImage       = "url('/icons/terminal.svg')"
    iconEl.style.webkitMaskImage = "url('/icons/terminal.svg')"
  } else {
    // Restore the CSS-driven colour wheel.
    iconEl.style.backgroundImage = ''
    iconEl.style.backgroundColor = ''
    iconEl.style.maskImage       = ''
    iconEl.style.webkitMaskImage = ''
  }
}

// ─── Tag lens view (read-only, spec §7) ──────────────────────────────────────
// What's installed, straight from the backend: each lens (version, origin, on or off),
// every concept with its English and Uzbek labels, and the counts. Nothing is edited
// here: lens files live in lenses/src and are built with scripts/lenses/build.mjs.
// "Re-tag all" scores the whole library again from the stored vectors (retag_all).
async function loadLensView() {
  const seq = ++_viewSeq
  try {
    const [lenses, concepts, tags, status] = await Promise.all([
      api.listLenses(),
      api.listConcepts(),
      api.listTags().catch(() => []),
      api.lensStatus().catch(() => null),
    ])
    if (seq !== _viewSeq || !listEl) return
    renderLensView(asList(lenses), asList(concepts), asList(tags), status && typeof status === 'object' ? status : null)
  } catch (err) {
    if (seq !== _viewSeq || !listEl) return
    console.error('[developer] lens view failed:', err)
    overlay.querySelector('#dev-tag-count').textContent = ''
    listEl.innerHTML = emptyHtml(t('lens.dev.load_failed'))
    sideEl.innerHTML = ''
  }
}

function renderLensView(lenses, concepts, tags, status) {
  // How many items carry each concept's tag
  const tagged = new Map()
  for (const tag of tags) {
    const id = tagConceptId(tag)
    if (id) tagged.set(id, (tagged.get(id) ?? 0) + (Number(tag.usage_count) || 0))
  }
  const isActive = c => c.active !== false && c.active !== 0
  const live     = concepts.filter(c => isActive(c) && asList(c.entries).length)
  const liveById = new Map(live.map(c => [c.id, c]))
  overlay.querySelector('#dev-tag-count').textContent = t('lens.dev.count', { lenses: lenses.length, concepts: live.length })

  // Left: the concepts, lens by lens in the fixed order (a tag several lenses share shows
  // under each, with that lens's entry), then the retired ones (no lens has them any more;
  // they stay so their tags keep a name)
  if (!lenses.length && !concepts.length) {
    listEl.innerHTML = emptyHtml(t('lens.dev.none'))
  } else {
    const groups = lenses.map(l => ({
      title: `${l.id} · v${l.version} · ${isOn(l) ? t('lens.dev.on') : t('lens.dev.off')}`,
      rows:  asList(l.concepts).map(id => liveById.get(id)).filter(Boolean)
        .map(c => ({ c, entry: asList(c.entries).find(e => e?.lens_id === l.id) }))
        .filter(r => r.entry),
    }))
    const retired = concepts.filter(c => !liveById.has(c.id)).map(c => ({ c, entry: null }))
    if (retired.length) groups.push({ title: t('lens.dev.retired'), rows: retired, dim: true })
    listEl.innerHTML = `
      <div class="dev-tag-cols-header">
        <span>${esc(t('lens.dev.col_id'))}</span><span>${esc(t('lens.dev.col_en'))}</span><span>${esc(t('lens.dev.col_uz'))}</span>
        <span>${esc(t('lens.dev.col_media'))}</span><span style="text-align:right">${esc(t('lens.dev.col_tagged'))}</span>
      </div>
      ${groups.map(g => `
        <div class="dev-form-section-label" style="margin:14px 10px 4px">${esc(g.title)} · ${esc(String(g.rows.length))}</div>
        ${g.rows.map(({ c, entry }) => conceptRow(c, entry, tagged.get(c.id) ?? 0, g.dim)).join('')}`).join('')}`
  }

  // Right: each lens, then the tagging status
  const perLens = status?.per_lens && typeof status.per_lens === 'object' ? status.per_lens : {}
  sideEl.innerHTML = `
    ${lenses.map(l => {
      const name    = asObj(l.name)
      const borrows = asList(l.borrows)
      return `
      <div class="dev-form-section">
        <div class="dev-form-section-label">${esc(l.id)}</div>
        <table class="debug-table">
          <tr><td>${esc(t('lens.dev.f_name'))}</td><td>${esc(name.en ?? '')}<br>${esc(name.uz ?? '')}</td></tr>
          <tr><td>${esc(t('lens.dev.f_state'))}</td><td>${badge(isOn(l))}</td></tr>
          <tr><td>${esc(t('lens.dev.f_version'))}</td><td>v${esc(String(l.version ?? '—'))} · ${esc(l.role ?? '—')} · ${esc(l.origin ?? '—')}</td></tr>
          <tr><td>${esc(t('lens.dev.f_updated'))}</td><td>${esc(fmtDate(l.updated_at))}</td></tr>
          <tr><td>${esc(t('lens.dev.f_concepts'))}</td><td>${asList(l.concepts).length}</td></tr>
          ${borrows.length ? `<tr><td>${esc(t('lens.dev.f_borrows'))}</td><td>${esc(borrows.join(', '))}</td></tr>` : ''}
          <tr><td>${esc(t('lens.dev.f_open'))}</td><td>${Number(perLens[l.id]) || 0}</td></tr>
        </table>
      </div>`
    }).join('')}
    <div class="dev-form-section">
      <div class="dev-form-section-label">${esc(t('lens.dev.status'))}</div>
      ${status ? `
      <table class="debug-table">
        <tr><td>${esc(t('lens.dev.f_switch'))}</td><td>${badge(status.enabled === true || status.enabled === 'true')}</td></tr>
        <tr><td>${esc(t('lens.dev.f_items'))}</td><td>${Number(status.total) || 0}</td></tr>
        <tr><td>${esc(t('lens.dev.f_scored'))}</td><td>${Number(status.scored) || 0}</td></tr>
        <tr><td>${esc(t('lens.dev.f_waiting'))}</td><td>${Number(status.waiting_videos) || 0}</td></tr>
        <tr><td>${esc(t('lens.dev.f_check'))}</td><td>${esc(status.last_check ? fmtDate(status.last_check) : t('lens.dev.never'))}</td></tr>
      </table>` : '<span class="debug-dim">—</span>'}
    </div>`
}

// One lens's entry of a tag (`entry`: its list_concepts entry; null for a retired tag)
function conceptRow(c, entry, taggedCount, dim) {
  const labels  = asObj(c.labels)
  // The other lenses that have this tag (§0c: an entry each) or show it (`borrows`)
  const also = [...new Set([...asList(c.entries).map(e => e?.lens_id), ...asList(c.borrowed_by)])]
    .filter(id => id && id !== entry?.lens_id)
  const tip  = also.length ? ` title="${esc(t('lens.dev.shown_by', { lenses: also.join(', ') }))}"` : ''
  const media = !entry ? '—' : entry.suggest === false ? t('lens.dev.hand') : (entry.media ?? 'any')
  return `
    <div class="dev-tag-row"${dim ? ' style="opacity:0.55"' : ''}${tip}>
      <span class="dev-tag-id">${esc(c.id)}</span>
      <span class="dev-tag-label">${esc(labels.en ?? '')}</span>
      <span class="dev-tag-uz">${esc(labels.uz ?? '')}</span>
      <span class="dev-tag-prompts" style="text-align:left">${esc(media)}</span>
      <span class="dev-tag-prompts">${Number(taggedCount) || 0}</span>
    </div>`
}

function badge(on) {
  return `<span class="debug-badge debug-badge--${on ? 'done' : 'pending'}">${esc(on ? t('lens.dev.on') : t('lens.dev.off'))}</span>`
}

function emptyHtml(title) {
  return `
    <div class="dev-empty">
      <div class="dev-empty-icon"></div>
      <div class="dev-empty-title">${esc(title)}</div>
    </div>`
}

// ─── Re-tag all ──────────────────────────────────────────────────────────────
// Clears every item's score signature; Rust scores everything again from the stored
// vectors (instant for pictures) and the cards update as each batch lands.
async function retagAll() {
  const btn = overlay.querySelector('#dev-retag-btn')
  if (!btn) return
  const ok = await showConfirm({
    title:        t('lens.dev.retag_q'),
    message:      t('lens.dev.retag_body'),
    confirmLabel: t('lens.dev.retag_go'),
    cancelLabel:  t('action.cancel'),
  })
  if (!ok) return
  btn.disabled = true
  const prev = btn.innerHTML
  try {
    const n = await api.retagAll()
    btn.innerHTML = `${I('check', 14)} ${esc(typeof n === 'number' ? t('lens.dev.retag_n', { n }) : t('lens.dev.retag_started'))}`
    refreshLensStatus()
    setTimeout(loadLensView, 1500)   // the counts after the first batches
  } catch (err) {
    console.error('[developer] retagAll failed:', err)
    btn.innerHTML = `${I('warning', 14)} ${esc(t('lens.dev.retag_failed'))}`
  }
  setTimeout(() => { if (btn.isConnected) { btn.innerHTML = prev; btn.disabled = false } }, 2500)
}

// ─── MD file ─────────────────────────────────────────────────────────────────
async function downloadMd() {
  const btn = overlay.querySelector('#dev-dl-md')
  if (IS_TAURI) {
    try {
      const { save }          = await import('@tauri-apps/plugin-dialog')
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      const path = await save({
        defaultPath: 'qooti-tag-builder.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        title: 'Save Tag Builder Instructions',
      })
      if (!path) return
      await writeTextFile(path, MD_CONTENT)
      const prev = btn.innerHTML
      btn.innerHTML = `${I('check', 14)} Saved!`
      setTimeout(() => { btn.innerHTML = prev }, 1800)
    } catch (err) {
      console.error('[developer] save failed:', err)
    }
  } else {
    const blob = new Blob([MD_CONTENT], { type: 'text/markdown;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'qooti-tag-builder.md' })
    a.click()
    URL.revokeObjectURL(url)
  }
}

async function copyMd() {
  try {
    await navigator.clipboard.writeText(MD_CONTENT)
  } catch {
    // Fallback: textarea + execCommand (works in Tauri WebView)
    const ta = document.createElement('textarea')
    ta.value = MD_CONTENT
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch {}
    ta.remove()
  }
  const btn = overlay.querySelector('#dev-copy-md')
  const prev = btn.innerHTML
  btn.innerHTML = `${I('check', 14)} Copied!`
  setTimeout(() => { btn.innerHTML = prev }, 1800)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Everything shown here comes from the backend or lens files: escaped, always
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function asList(v) { return Array.isArray(v) ? v : [] }

// {en, uz} texts may arrive as an object or as JSON text
function asObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {} } catch { return {} }
  }
  return {}
}

function isOn(lens) { return lens?.enabled === true || lens?.enabled === 1 }

// Unix seconds or milliseconds (lenses.js toDate) → "18 Nov 2026, 18:48" /
// "2026-yil 18-noyabr, 18:48". By hand: the WebView prints Uzbek months as "M11".
const UZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr']
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDate(v) {
  const d = toDate(v)
  if (!d) return '—'
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return currentLang() === 'uz'
    ? `${d.getFullYear()}-yil ${d.getDate()}-${UZ_MONTHS[d.getMonth()]}, ${time}`
    : `${d.getDate()} ${EN_MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time}`
}

// The page's frame: header (tools, counts, Re-tag all) and the two panes
function buildShell() {
  overlay.innerHTML = `
    <div class="dev-header">
      <div class="dev-header-brand">
        <span class="dev-header-icon"></span>
        <span class="dev-header-title">${esc(t('lens.dev.title'))}</span>
        <span class="dev-header-badge">developer</span>
      </div>
      <div class="dev-header-sep"></div>
      <button class="dev-btn" id="dev-dl-md">${I('download-simple', 14)} Download MD</button>
      <button class="dev-btn" id="dev-copy-md">${I('copy', 14)} Copy MD</button>
      <span class="dev-toolbar-hint">Send to Claude or ChatGPT to generate prompts</span>
      <div class="dev-header-spacer"></div>
      <span class="dev-tag-count" id="dev-tag-count"></span>
      <button class="dev-btn" id="dev-refresh-btn">${I('arrow-clockwise', 14)} ${esc(t('lens.dev.refresh'))}</button>
      <button class="dev-btn dev-btn-warn" id="dev-retag-btn" title="${esc(t('lens.dev.retag_tip'))}">${I('arrow-counter-clockwise', 14)} ${esc(t('lens.dev.retag'))}</button>
      <div class="dev-header-sep"></div>
      <button class="dev-close-btn" id="dev-close-btn" aria-label="${esc(t('action.close'))}">${I('x', 16)}</button>
    </div>

    <div class="dev-body">
      <div class="dev-list-pane">
        <div class="dev-tag-list" id="dev-tag-list"></div>
      </div>

      <div class="dev-form-pane">
        <div class="dev-form" id="dev-side"></div>
      </div>
    </div>
  `

  listEl = overlay.querySelector('#dev-tag-list')
  sideEl = overlay.querySelector('#dev-side')

  overlay.querySelector('#dev-close-btn').addEventListener('click',   closeDevPage)
  overlay.querySelector('#dev-dl-md').addEventListener('click',       downloadMd)
  overlay.querySelector('#dev-copy-md').addEventListener('click',     copyMd)
  overlay.querySelector('#dev-refresh-btn').addEventListener('click', loadLensView)
  overlay.querySelector('#dev-retag-btn').addEventListener('click',   retagAll)
}

// ─── Init ────────────────────────────────────────────────────────────────────
export function initDeveloper() {
  overlay = document.getElementById('dev-overlay')

  // Escape closes
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) closeDevPage()
  })

  // Secret blt_ commands are dispatched by main.js's top-bar-search handler,
  // which calls runDevCommand() below — that way the command runs on both Enter
  // and the search-button click, and never triggers a normal search.
}

/**
 * Handle a secret `blt_` command typed into the search bar.
 * Returns true if `cmd` was a recognized command (so the caller skips search).
 */
export async function runDevCommand(cmd) {
  const searchInput = document.getElementById('top-bar-search')
  const clear = () => { if (searchInput) searchInput.value = '' }

  if (cmd === 'blt_developer') {
    clear()
    openDevPage()
    return true
  }

  // Preview the app as a brand-new user (first-run flow over an empty-looking library)
  // without deleting or changing anything — see starter.js. Exit from the pill.
  if (cmd === 'blt_starter') {
    clear()
    startStarterPreview()
    return true
  }

  // Boards (storyboarding) — hidden from the nav drawer; reachable only via this command.
  if (cmd === 'blt_boards') {
    clear()
    store.emit(events.NAVIGATE, { view: 'boards' })
    return true
  }

  // Dev preview: fake an available update so the update bar (grid.js →
  // renderUpdateBar) renders under the tag pills, without a real release.
  if (cmd === 'blt_update') {
    clear()
    store.emit(events.NAVIGATE, { view: 'grid' })   // bar lives in the home grid
    store.emit(events.UPDATE_AVAILABLE, {
      version: '1.2.2',
      notes:   'Preview — mock update to test the update bar.',
    })
    return true
  }

  if (cmd === 'blt_logout') {
    clear()
    try {
      await api.setSetting('onboarding_state', 'pending_login')
      await api.clearLicenseCache()
    } catch (err) {
      console.error('[blt_logout] failed:', err)
    }
    window.location.reload()
    return true
  }

  if (cmd === 'blt_reset') {
    clear()
    const ok1 = await showConfirm({
      title: 'Reset entire library?',
      message: 'This will permanently delete ALL items, collections, tags, and media files. This cannot be undone.',
      danger: true,
      confirmLabel: 'Continue',
      icon: 'warning',
    })
    if (!ok1) return true
    const ok2 = await showConfirm({
      title: 'Are you absolutely sure?',
      message: 'Every file and database record will be erased. The app will restart clean.',
      danger: true,
      confirmLabel: 'Delete everything',
      icon: 'trash',
    })
    if (!ok2) return true
    try {
      searchInput.placeholder = 'Resetting…'
      await api.resetApp()
      window.location.reload()
    } catch (err) {
      console.error('[blt_reset] failed:', err)
      searchInput.placeholder = 'Reset failed'
      setTimeout(() => { searchInput.placeholder = 'Search your library' }, 3000)
    }
    return true
  }

  if (cmd === 'blt_exportall') {
    clear()
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const today = new Date().toISOString().slice(0, 10)
      const savePath = await save({
        title: 'Export entire library',
        defaultPath: `qooti-library-${today}.qooti`,
        filters: [{ name: 'qooti pack', extensions: ['qooti'] }],
      })
      if (!savePath) return true
      searchInput.placeholder = 'Exporting library…'
      const count = await api.exportAllItems(savePath)
      searchInput.placeholder = `Exported ${count} item${count !== 1 ? 's' : ''} ✓`
      setTimeout(() => { searchInput.placeholder = 'Search your library' }, 4000)
    } catch (err) {
      console.error('[blt_exportall] failed:', err)
      searchInput.placeholder = 'Export failed'
      setTimeout(() => { searchInput.placeholder = 'Search your library' }, 3000)
    }
    return true
  }

  if (cmd === 'blt_tour') {
    clear()
    startWalkthrough()
    return true
  }

  return false
}
