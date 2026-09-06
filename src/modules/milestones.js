import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

const MILESTONES = [
  { id: 'first_save',  title: 'First Save',      desc: 'Add your first item',                   icon: 'ms-star',      color: '#F59E0B', threshold: 1    },
  { id: 'starter',     title: 'Getting Started',  desc: 'Build a collection of 10 items',        icon: 'ms-rocket',    color: '#8B5CF6', threshold: 10   },
  { id: 'builder',     title: 'Builder',          desc: 'Save 50 items to your library',         icon: 'ms-lightning', color: '#3B82F6', threshold: 50   },
  { id: 'collector',   title: 'Collector',        desc: 'Reach 100 saved items',                 icon: 'ms-medal',     color: '#10B981', threshold: 100  },
  { id: 'archivist',   title: 'Archivist',        desc: 'Amass a library of 500 items',          icon: 'ms-archive',   color: '#14B8A6', threshold: 500  },
  { id: 'master',      title: 'Master Curator',   desc: 'Reach 1,000 items — the ultimate haul', icon: 'ms-trophy',    color: '#EF4444', threshold: 1000 },
]

let container = null

export async function init(el) {
  container = el
  store.on(events.NAV_CHANGE,     ({ view }) => { if (view === 'milestones') reload() })
  store.on(events.GRID_ITEM_ADDED, ()        => reload())
}

async function reload() {
  try {
    const items  = await api.listInspirations({ limit: 9999 })
    const count  = items.length
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

function render(list) {
  if (!container) return
  const done = list.filter(m => m.achieved).length

  container.innerHTML = `
    <div class="ms-page">
      <div class="ms-header">
        <h1 class="ms-title">Milestones</h1>
        <span class="ms-tally">${done} / ${list.length} achieved</span>
      </div>
      <div class="ms-grid" id="ms-grid"></div>
    </div>
  `
  const grid = container.querySelector('#ms-grid')
  list.forEach(m => grid.appendChild(makeCard(m)))
}

function makeCard(m) {
  const pct = Math.round(m.progress * 100)
  const el  = document.createElement('div')
  el.className = `ms-card${m.achieved ? ' achieved' : ''}`

  const iconColor = m.achieved ? m.color : 'var(--text-muted)'
  const iconBg    = m.achieved
    ? `color-mix(in srgb, ${m.color} 15%, transparent)`
    : 'var(--bg-raised)'

  el.innerHTML = `
    <div class="ms-card-icon" style="background:${iconBg}; color:${iconColor}">
      ${I(m.icon, 24)}
    </div>
    <div class="ms-card-content">
      <div class="ms-card-title">${m.title}</div>
      <div class="ms-card-desc">${m.desc}</div>
      ${m.achieved
        ? `<div class="ms-achieved-label" style="color:${m.color}">${I('check', 12)} Achieved</div>`
        : `<div class="ms-bar-track"><div class="ms-bar-fill" style="width:${pct}%"></div></div>
           <div class="ms-count">${m.current.toLocaleString()} / ${m.threshold.toLocaleString()}</div>`}
    </div>
  `
  return el
}
