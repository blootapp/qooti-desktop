import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { t } from './i18n.js'

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

// Names and descriptions are i18n 'ms.<id>.title' / 'ms.<id>.desc', in the current language.
const milestone = (id, icon, color, threshold) => ({
  id, icon, color, threshold,
  get title() { return t(`ms.${id}.title`) },
  get desc()  { return t(`ms.${id}.desc`) },
})
const MILESTONES = [
  milestone('first_save', 'ms-star',      '#F59E0B', 1),
  milestone('starter',    'ms-rocket',    '#8B5CF6', 10),
  milestone('builder',    'ms-lightning', '#3B82F6', 50),
  milestone('collector',  'ms-medal',     '#10B981', 100),
  milestone('archivist',  'ms-archive',   '#14B8A6', 500),
  milestone('master',     'ms-trophy',    '#EF4444', 1000),
]

let container = null

export async function init(el) {
  container = el
  store.on(events.NAV_CHANGE,     ({ view }) => { if (view === 'milestones') reload() })
  store.on(events.GRID_ITEM_ADDED, ()        => reload())
  reload()   // so a milestone reached on this launch can be celebrated even before the page is opened
}

async function reload() {
  try {
    // A plain COUNT — this also runs at startup, so never load the whole library here
    const count  = (await api.getFreePlanInfo().catch(() => null))?.item_total
      ?? (await api.listInspirations({ limit: 9999 })).length
    const server = await api.listMilestones().catch(() => [])
    const smap   = new Map(server.map(m => [m.id, m]))

    const list = MILESTONES.map(m => ({
      ...m,
      achieved:    smap.get(m.id)?.achieved    ?? count >= m.threshold,
      achieved_at: smap.get(m.id)?.achieved_at ?? null,
      progress:    Math.min(1, count / m.threshold),
      current:     count,
    }))

    render(list)
  } catch (err) {
    console.error('[milestones] reload failed:', err)
  }
}

// Guide E2: one column (max 920 px), header with progress line, 3-up cards with a
// cover (big number + illustration) and the title / description / status below.
function render(list) {
  if (!container) return
  const done = list.filter(m => m.achieved).length
  const next = list.find(m => !m.achieved)
  const sub  = next
    ? t('ms.sub_next', { done, total: list.length, n: (next.threshold - next.current).toLocaleString(), name: next.title })
    : t('ms.sub_all', { total: list.length })

  container.innerHTML = `
    <div class="view-page ms-page">
      <div class="view-head">
        <h1>${t('nav.milestones')}</h1>
        <p>${sub}</p>
      </div>
      <div class="ms-grid" id="ms-grid"></div>
    </div>
  `
  const grid = container.querySelector('#ms-grid')
  list.forEach(m => grid.appendChild(makeCard(m, m === next)))
  celebrateNew(list)
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function makeCard(m, isNext) {
  const el = document.createElement('div')
  el.className = `ms-card${m.achieved ? ' achieved' : ''}${isNext ? ' is-next' : ''}${!m.achieved && !isNext ? ' is-locked' : ''}`
  const status = m.achieved
    ? I('check-circle', 14)
    : isNext ? `<span class="ms-next-badge">${t('ms.next')}</span>` : I('lock', 13)
  const foot = m.achieved
    ? `<div class="ms-foot">${m.achieved_at ? t('ms.reached', { date: fmtDate(m.achieved_at) }) : t('ms.reached_plain')}</div>`
    : isNext
      ? `<div class="ms-bar-track"><div class="ms-bar-fill" style="width:${Math.round(m.progress * 100)}%"></div></div>
         <div class="ms-foot">${t('ms.to_go_of', { n: (m.threshold - m.current).toLocaleString(), cur: m.current.toLocaleString(), total: m.threshold.toLocaleString() })}</div>`
      : `<div class="ms-foot">${t('ms.to_go', { n: (m.threshold - m.current).toLocaleString() })}</div>`

  el.innerHTML = `
    <div class="ms-cover">
      <span class="ms-num">${m.threshold.toLocaleString()}</span>
      <img class="ms-art" src="/assets/milestones/${m.id}.svg" alt="" draggable="false" />
    </div>
    <div class="ms-body">
      <div class="ms-card-title">${m.title}<span class="ms-status">${status}</span></div>
      <div class="ms-card-desc">${m.desc}</div>
      ${foot}
    </div>
  `
  return el
}

// ─── Celebration (guide E2b) ─────────────────────────────────────
// Shown once when a milestone is reached while qooti is open.
const SEEN_KEY = 'qooti.ms.celebrated'
function celebrateNew(list) {
  let seen
  try { seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')) } catch { seen = new Set() }
  const first = seen.size === 0
  const fresh = list.filter(m => m.achieved && !seen.has(m.id))
  for (const m of list) if (m.achieved) seen.add(m.id)
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])) } catch {}
  // First run of this feature: remember what's already reached without a burst of dialogs.
  if (first || !fresh.length) return
  showCelebration(fresh[fresh.length - 1])
}

function showCelebration(m) {
  document.getElementById('ms-celebrate')?.remove()
  const el = document.createElement('div')
  el.id = 'ms-celebrate'
  el.className = 'upgrade-modal-backdrop'
  el.innerHTML = `
    <div class="ms-celebrate" role="dialog" aria-modal="true">
      <img class="ms-celebrate-art" src="/assets/milestones/${m.id}.svg" alt="" />
      <h2>${m.title}</h2>
      <p>${t('ms.celebrate_body', { n: m.threshold.toLocaleString() })}</p>
      <button class="dlg-btn dlg-btn--primary" id="ms-celebrate-done">${t('action.done')}</button>
    </div>`
  document.body.appendChild(el)
  store.emit(events.MILESTONE_ACHIEVED, { milestone: m })
  const close = () => el.remove()
  el.querySelector('#ms-celebrate-done').addEventListener('click', close)
  el.addEventListener('click', e => { if (e.target === el) close() })
}
