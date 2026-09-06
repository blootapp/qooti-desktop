import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { forceSyncTagVocab, getLocalVocabVersion } from './tag-sync.js'
import { showConfirm } from './dialog.js'
import { startWalkthrough } from './walkthrough.js'

const IS_TAURI = '__TAURI_INTERNALS__' in window

// ─── Icon helper (same pattern as the rest of the app) ──────────────────────
const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

// ─── MD instruction file content ────────────────────────────────────────────
const MD_CONTENT = `# qooti Tag Prompt Builder

You help users build the auto-tag dictionary for **qooti** — a design inspiration app for video editors and motion designers.

## How CLIP works (critical to understand)

qooti uses **CLIP** (OpenAI's vision-language model) for zero-shot image classification. CLIP scores each image against every text prompt in the dictionary simultaneously. The tag with the **highest score wins** — which means if two categories share similar prompts, they will fight each other and produce wrong tag suggestions.

**The #1 cause of wrong tags:** prompts that describe things common to many categories, instead of what makes THIS category visually unique.

## What makes a good CLIP prompt

A good prompt describes **only what visually distinguishes this category from every other category** — not what it shares with others.

### Example: "minimal" category

❌ **Bad** — too generic, matches many categories:
- \`"a clean, simple design"\` — posters, UI, logos all look "clean"
- \`"white background with text"\` — too common across categories

✅ **Good** — describes the visual signature of minimal only:
- \`"extreme negative space: a single isolated element centered on a vast empty white or off-white background with nothing else visible"\`
- \`"razor-thin sans-serif text on a solid-color field, no images, no textures, no decorations, maximum breathing room"\`

### Rules for every prompt you write

1. **Describe only what you literally see** — colors, shapes, layout density, texture, lighting, typography, composition
2. **Make it exclusive** — before finalizing, ask yourself: *"Would this prompt also score high on images from a completely different category?"* If yes, it is too generic — make it more specific
3. **No abstract words** — CLIP cannot reliably read "modern", "aesthetic", "vibrant", "professional", "cinematic feel". Describe physical reality only
4. **Length**: 15–30 words per prompt. One or two concrete sentences
5. **English only** — CLIP was trained on English text
6. **Write 3–4 prompts per category** — each must cover a visually DIFFERENT variation. If your prompts describe the same look, they are redundant

## Output format

After analyzing the reference images, output in **exactly** this format so the user can paste it directly into qooti:

\`\`\`
Category ID: [lowercase_with_underscores]
English label: [Short display name, max 3 words]
Uzbek label: [Loanword or recognizable Uzbek label]
Prompt 1: [hyper-specific visual description of one variation]
Prompt 2: [different visual variation of the same category]
Prompt 3: [another distinct variation — required]
Prompt 4: [optional — only if it adds a meaningfully different look]
\`\`\`

## Your task — follow these steps exactly

**Step 1:** Ask the user: *"What visual category do you want to add to qooti? Give it a short name and briefly describe what it looks like."*

**Step 2:** Ask the user: *"Now share 2–10 reference images that clearly show this visual style. I need at least 2 images. More variety = better prompts that cover the full range of this category."*

**Step 3:** Study all shared images. For each image, identify:
- Dominant colors and color palette character
- Composition structure (centered, grid, asymmetric, full-bleed, etc.)
- Density — is it sparse and minimal, or dense and layered?
- Lighting type (flat, backlit, glowing, high-contrast, dark, high-key)
- Typography presence and character (size, weight, placement, style)
- Texture and surface qualities (glossy, grainy, rough, smooth, etc.)
- **Most importantly:** What would make someone instantly pick THIS category over the closest neighboring category?

**Step 4:** Write 3–4 CLIP prompts. For each prompt, run this mental check: *"If I showed CLIP an image from a completely different category, would this prompt still score high on it?"* If yes — it is too vague. Make it more specific until the answer is no.

**Step 5:** Output in the exact format shown above.

**Step 6:** Ask: *"Do these prompts feel right? Would any of them accidentally match a different category?"* Refine until they are distinctive.

---

Begin with Step 1.
`

// ─── State ──────────────────────────────────────────────────────────────────
let overlay   = null
let tagList   = null
let formEl    = null
let editingId = null
let loadedEntries = []

// ─── Open / Close ───────────────────────────────────────────────────────────
function openDevPage() {
  overlay.removeAttribute('hidden')
  swapSwatchIcon(true)
  loadTags()
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
    iconEl.dataset.savedMask       = iconEl.style.maskImage
    iconEl.dataset.savedWebkitMask = iconEl.style.webkitMaskImage
    btn.dataset.savedColor         = btn.style.color
    iconEl.style.maskImage       = "url('/icons/terminal.svg')"
    iconEl.style.webkitMaskImage = "url('/icons/terminal.svg')"
    btn.style.color = '#4ADE80'
  } else {
    iconEl.style.maskImage       = iconEl.dataset.savedMask       || "url('/icons/painting.svg')"
    iconEl.style.webkitMaskImage = iconEl.dataset.savedWebkitMask || "url('/icons/painting.svg')"
    btn.style.color = btn.dataset.savedColor || ''
    delete iconEl.dataset.savedMask
    delete iconEl.dataset.savedWebkitMask
    delete btn.dataset.savedColor
  }
}

// ─── Tag list ────────────────────────────────────────────────────────────────
async function loadTags() {
  try {
    const entries = await api.listTagVocab()
    loadedEntries = entries
    renderTagList(entries)
    overlay.querySelector('#dev-tag-count').textContent = `${entries.length} tag${entries.length !== 1 ? 's' : ''}`
  } catch (err) {
    console.error('[developer] loadTags failed:', err)
  }
}

function renderTagList(entries) {
  tagList.innerHTML = ''
  if (!entries.length) {
    tagList.innerHTML = `
      <div class="dev-empty">
        <div class="dev-empty-icon"></div>
        <div class="dev-empty-title">No tags yet</div>
        <div class="dev-empty-desc">Add your first tag using the form on the right, or download the MD file and send it to Claude or ChatGPT to generate prompts.</div>
      </div>`
    return
  }
  const header = document.createElement('div')
  header.className = 'dev-tag-cols-header'
  header.innerHTML = '<span>ID</span><span>English</span><span>Uzbek</span><span>Prompts</span><span></span>'
  tagList.appendChild(header)
  for (const entry of entries) tagList.appendChild(makeTagRow(entry))
}

function makeTagRow(entry) {
  const labels  = safeJson(entry.labels_json,  {})
  const prompts = safeJson(entry.prompts_json, [])
  const row = document.createElement('div')
  row.className = 'dev-tag-row'
  row.innerHTML = `
    <span class="dev-tag-id">${entry.id}</span>
    <span class="dev-tag-label">${labels.en ?? ''}</span>
    <span class="dev-tag-uz">${labels.uz ?? ''}</span>
    <span class="dev-tag-prompts" title="${prompts.join('\n')}">${prompts.length} prompt${prompts.length !== 1 ? 's' : ''}</span>
    <div class="dev-tag-actions">
      <button class="dev-tag-btn dev-edit" title="Edit">${I('pencil-simple', 14)}</button>
      <button class="dev-tag-btn dev-delete" title="Delete">${I('trash', 14)}</button>
    </div>
  `
  row.querySelector('.dev-edit').addEventListener('click',   () => startEdit(entry))
  row.querySelector('.dev-delete').addEventListener('click', () => deleteTag(entry.id))
  return row
}

// ─── Form ────────────────────────────────────────────────────────────────────
function startEdit(entry = null) {
  editingId = entry?.id ?? null
  const labels  = entry ? safeJson(entry.labels_json,  {}) : {}
  const prompts = entry ? safeJson(entry.prompts_json, []) : []

  formEl.querySelector('#dev-f-id').value = entry?.id ?? ''
  formEl.querySelector('#dev-f-en').value = labels.en ?? ''
  formEl.querySelector('#dev-f-uz').value = labels.uz ?? ''
  formEl.querySelector('#dev-f-p1').value = prompts[0] ?? ''
  formEl.querySelector('#dev-f-p2').value = prompts[1] ?? ''
  formEl.querySelector('#dev-f-p3').value = prompts[2] ?? ''

  formEl.querySelector('.dev-form-title').textContent = entry ? `Editing: ${entry.id}` : 'Add new tag'
  formEl.querySelector('#dev-f-id').disabled = !!entry
  formEl.querySelector('#dev-f-id').focus()
  overlay.querySelector('.dev-form-pane').scrollTop = 0
}

function resetForm() {
  editingId = null
  ;['#dev-f-id','#dev-f-en','#dev-f-uz','#dev-f-p1','#dev-f-p2','#dev-f-p3'].forEach(sel => {
    formEl.querySelector(sel).value = ''
  })
  formEl.querySelector('.dev-form-title').textContent = 'Add new tag'
  formEl.querySelector('#dev-f-id').disabled = false
}

async function saveTag() {
  const id = formEl.querySelector('#dev-f-id').value.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')
  const en = formEl.querySelector('#dev-f-en').value.trim()
  const uz = formEl.querySelector('#dev-f-uz').value.trim()
  const p1 = formEl.querySelector('#dev-f-p1').value.trim()
  const p2 = formEl.querySelector('#dev-f-p2').value.trim()
  const p3 = formEl.querySelector('#dev-f-p3').value.trim()

  if (!id || !en || !p1) {
    showFormError('ID, English label, and at least one prompt are required.')
    return
  }

  if (!editingId && loadedEntries.some(e => e.id === id)) {
    const ok = await showConfirm({
      title: `Overwrite "${id}"?`,
      message: 'A tag with this ID already exists. This will replace its values.',
      confirmLabel: 'Overwrite',
      icon: 'warning',
    })
    if (!ok) return
  }

  const prompts = [p1, p2, p3].filter(Boolean)
  const saveBtn = formEl.querySelector('#dev-save-btn')
  saveBtn.disabled = true
  try {
    await api.upsertTagVocab(id, JSON.stringify({ en, uz: uz || en }), JSON.stringify(prompts), false, 0)
    store.emit(events.TAG_VOCAB_CHANGED)
    resetForm()
    await loadTags()
  } catch (err) {
    console.error('[developer] saveTag failed:', err)
    showFormError('Save failed — check the console for details.')
  } finally {
    saveBtn.disabled = false
  }
}

async function deleteTag(id) {
  const ok = await showConfirm({
    title: `Delete "${id}"?`,
    message: 'This tag will be permanently removed and cannot be undone.',
    danger: true,
    confirmLabel: 'Delete',
    icon: 'trash',
  })
  if (!ok) return
  try {
    await api.deleteTagVocab(id)
    store.emit(events.TAG_VOCAB_CHANGED)
    await loadTags()
    if (editingId === id) resetForm()
  } catch (err) {
    console.error('[developer] deleteTag failed:', err)
  }
}

function showFormError(msg) {
  let el = formEl.querySelector('.dev-form-error')
  if (!el) {
    el = document.createElement('p')
    el.className = 'dev-form-error'
    formEl.querySelector('.dev-form-actions').before(el)
  }
  el.textContent = msg
  setTimeout(() => el.remove(), 4000)
}

// ─── Vocab sync ──────────────────────────────────────────────────────────────
async function syncNow() {
  const btn = overlay.querySelector('#dev-sync-btn')
  btn.disabled = true
  const prev = btn.innerHTML
  btn.innerHTML = `${I('arrow-clockwise', 14)} Syncing…`
  try {
    const result = await forceSyncTagVocab()
    if (result.status === 'no_url') {
      btn.innerHTML = `${I('warning', 14)} No URL set`
    } else if (result.status === 'up_to_date') {
      btn.innerHTML = `${I('check', 14)} Up to date`
    } else {
      btn.innerHTML = `${I('check', 14)} ${result.count} tags synced`
      await loadTags()
    }
  } catch (err) {
    console.error('[developer] sync failed:', err)
    btn.innerHTML = `${I('warning', 14)} Sync failed`
  }
  setTimeout(() => { btn.innerHTML = prev; btn.disabled = false }, 2500)
}

// ─── Re-tag all ──────────────────────────────────────────────────────────────
async function retagAll() {
  const btn = overlay.querySelector('#dev-retag-btn')
  const ok = await showConfirm({
    title: 'Re-tag entire library?',
    message: 'This will clear all stored tag scores and re-run auto-tagging on every image.',
    confirmLabel: 'Continue',
  })
  if (!ok) return
  btn.disabled = true
  try {
    const count = await api.resetAllAutoTags()
    store.emit(events.GRID_RELOAD)   // wakes the auto-tag loop if it went idle
    const prev = btn.innerHTML
    btn.innerHTML = `${I('check', 14)} ${count} queued`
    setTimeout(() => { btn.innerHTML = prev; btn.disabled = false }, 2500)
  } catch (err) {
    console.error('[developer] retagAll failed:', err)
    btn.disabled = false
  }
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
function safeJson(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}

// ─── Init ────────────────────────────────────────────────────────────────────
export function initDeveloper() {
  overlay = document.getElementById('dev-overlay')

  overlay.innerHTML = `
    <div class="dev-header">
      <div class="dev-header-brand">
        <span class="dev-header-icon"></span>
        <span class="dev-header-title">Tag Dictionary</span>
        <span class="dev-header-badge">developer</span>
      </div>
      <div class="dev-header-sep"></div>
      <button class="dev-btn" id="dev-dl-md">${I('download-simple', 14)} Download MD</button>
      <button class="dev-btn" id="dev-copy-md">${I('copy', 14)} Copy MD</button>
      <span class="dev-toolbar-hint">Send to Claude or ChatGPT to generate prompts</span>
      <div class="dev-header-spacer"></div>
      <span class="dev-tag-count" id="dev-tag-count"></span>
      <button class="dev-btn" id="dev-sync-btn" title="Force download the latest shared vocabulary from GitHub">${I('arrow-clockwise', 14)} Sync</button>
      <button class="dev-btn dev-btn-warn" id="dev-retag-btn" title="Clear all stored tag scores and re-run auto-tagging on every image">${I('arrow-counter-clockwise', 14)} Re-tag all</button>
      <button class="dev-btn dev-btn-primary" id="dev-add-btn">${I('plus', 14)} Add tag</button>
      <div class="dev-header-sep"></div>
      <button class="dev-close-btn" id="dev-close-btn" aria-label="Close">${I('x', 16)}</button>
    </div>

    <div class="dev-body">
      <div class="dev-list-pane">
        <div class="dev-tag-list" id="dev-tag-list"></div>
      </div>

      <div class="dev-form-pane">
        <div class="dev-form" id="dev-form">
          <div class="dev-form-title">Add new tag</div>

          <div class="dev-form-section">
            <div class="dev-form-section-label">Identifiers</div>
            <div class="dev-form-row-3">
              <div class="dev-form-group">
                <label class="dev-form-label" for="dev-f-id">ID <span class="dev-required">*</span></label>
                <input class="dev-form-input dev-mono" id="dev-f-id" placeholder="e.g. color_grading" autocomplete="off" spellcheck="false" />
              </div>
              <div class="dev-form-group">
                <label class="dev-form-label" for="dev-f-en">English <span class="dev-required">*</span></label>
                <input class="dev-form-input" id="dev-f-en" placeholder="Color grading" autocomplete="off" />
              </div>
              <div class="dev-form-group">
                <label class="dev-form-label" for="dev-f-uz">Uzbek</label>
                <input class="dev-form-input" id="dev-f-uz" placeholder="Color grading" autocomplete="off" />
              </div>
            </div>
          </div>

          <div class="dev-form-section">
            <div class="dev-form-section-label">CLIP Prompts</div>
            <p class="dev-form-section-hint">Describe exactly what you see — colors, shapes, layout, lighting. Each prompt must be specific enough that no other category matches it.</p>
            <div class="dev-form-prompts">
              <div class="dev-form-group">
                <label class="dev-form-label" for="dev-f-p1">Prompt 1 <span class="dev-required">*</span></label>
                <textarea class="dev-form-input dev-prompt-input" id="dev-f-p1" rows="3" placeholder="Describe what the image looks like visually…" autocomplete="off" spellcheck="false"></textarea>
              </div>
              <div class="dev-form-group">
                <label class="dev-form-label" for="dev-f-p2">Prompt 2</label>
                <textarea class="dev-form-input dev-prompt-input" id="dev-f-p2" rows="3" placeholder="Alternative visual description…" autocomplete="off" spellcheck="false"></textarea>
              </div>
              <div class="dev-form-group">
                <label class="dev-form-label" for="dev-f-p3">Prompt 3</label>
                <textarea class="dev-form-input dev-prompt-input" id="dev-f-p3" rows="3" placeholder="Optional third description…" autocomplete="off" spellcheck="false"></textarea>
              </div>
            </div>
          </div>

          <div class="dev-form-actions">
            <button class="dev-btn dev-btn-primary" id="dev-save-btn">${I('floppy-disk', 14)} Save tag</button>
            <button class="dev-btn" id="dev-cancel-btn">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `

  tagList = overlay.querySelector('#dev-tag-list')
  formEl  = overlay.querySelector('#dev-form')

  overlay.querySelector('#dev-close-btn').addEventListener('click', closeDevPage)
  overlay.querySelector('#dev-dl-md').addEventListener('click',     downloadMd)
  overlay.querySelector('#dev-copy-md').addEventListener('click',   copyMd)
  overlay.querySelector('#dev-sync-btn').addEventListener('click',  syncNow)
  overlay.querySelector('#dev-retag-btn').addEventListener('click', retagAll)
  overlay.querySelector('#dev-add-btn').addEventListener('click',   () => startEdit(null))
  overlay.querySelector('#dev-save-btn').addEventListener('click',  saveTag)
  overlay.querySelector('#dev-cancel-btn').addEventListener('click', resetForm)

  // Escape closes
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) closeDevPage()
  })

  // Ctrl+Enter inside any prompt textarea → save
  ;['#dev-f-p1','#dev-f-p2','#dev-f-p3'].forEach(sel => {
    formEl.querySelector(sel).addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveTag() }
    })
  })

  // Secret triggers: type command in the search bar and press Enter
  const searchInput = document.getElementById('top-bar-search')
  searchInput.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return
    const cmd = searchInput.value.trim()

    if (cmd === 'blt_developer') {
      e.preventDefault()
      searchInput.value = ''
      openDevPage()
      return
    }

    if (cmd === 'blt_logout') {
      e.preventDefault()
      searchInput.value = ''
      try {
        await api.setSetting('onboarding_state', 'pending_login')
        await api.clearLicenseCache()
      } catch (err) {
        console.error('[blt_logout] failed:', err)
      }
      window.location.reload()
    }

    if (cmd === 'blt_reset') {
      e.preventDefault()
      searchInput.value = ''
      const ok1 = await showConfirm({
        title: 'Reset entire library?',
        message: 'This will permanently delete ALL items, collections, tags, and media files. This cannot be undone.',
        danger: true,
        confirmLabel: 'Continue',
        icon: 'warning',
      })
      if (!ok1) return
      const ok2 = await showConfirm({
        title: 'Are you absolutely sure?',
        message: 'Every file and database record will be erased. The app will restart clean.',
        danger: true,
        confirmLabel: 'Delete everything',
        icon: 'trash',
      })
      if (!ok2) return
      try {
        searchInput.placeholder = 'Resetting…'
        await api.resetApp()
        window.location.reload()
      } catch (err) {
        console.error('[blt_reset] failed:', err)
        searchInput.placeholder = 'Reset failed'
        setTimeout(() => { searchInput.placeholder = 'Search...' }, 3000)
      }
      return
    }

    if (cmd === 'blt_exportall') {
      e.preventDefault()
      searchInput.value = ''
      try {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const today = new Date().toISOString().slice(0, 10)
        const savePath = await save({
          title: 'Export entire library',
          defaultPath: `qooti-library-${today}.qooti`,
          filters: [{ name: 'qooti pack', extensions: ['qooti'] }],
        })
        if (!savePath) return
        searchInput.placeholder = 'Exporting library…'
        const count = await api.exportAllItems(savePath)
        searchInput.placeholder = `Exported ${count} item${count !== 1 ? 's' : ''} ✓`
        setTimeout(() => { searchInput.placeholder = 'Search...' }, 4000)
      } catch (err) {
        console.error('[blt_exportall] failed:', err)
        searchInput.placeholder = 'Export failed'
        setTimeout(() => { searchInput.placeholder = 'Search...' }, 3000)
      }
    }

    if (cmd === 'blt_tour') {
      e.preventDefault()
      searchInput.value = ''
      startWalkthrough()
    }
  })
}
