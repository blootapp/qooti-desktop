import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { sfx } from './sfx.js'

const I = (name, size = 16) =>
  `<span class="icon icon-${size}" style="mask-image:url('/icons/${name}.svg');-webkit-mask-image:url('/icons/${name}.svg')" aria-hidden="true"></span>`

let container = null

export async function init(el) {
  container = el
  store.on(events.NAV_CHANGE, ({ view }) => { if (view === 'notifications') reload() })
  store.on(events.NOTIFICATION_NEW, () => { reload(); updateBadge() })
  await updateBadge()
}

async function reload() {
  try {
    const notifs = await api.getNotifications()
    render(notifs)
  } catch (err) {
    console.error('[notifications] reload failed:', err)
  }
}

async function updateBadge() {
  try {
    const notifs = await api.getNotifications()
    const count = notifs.filter(n => !n.read).length
    const badge = document.getElementById('notif-badge')
    if (!badge) return
    badge.textContent = count > 9 ? '9+' : String(count)
    badge.classList.toggle('hidden', count === 0)
  } catch {}
}

function render(notifs) {
  if (!container) return
  const unread = notifs.filter(n => !n.read)

  container.innerHTML = `
    <div class="notif-page">
      <div class="notif-header">
        <h1 class="notif-title">Notifications</h1>
        ${unread.length
          ? `<button class="btn btn-ghost notif-mark-all">Mark all as read</button>`
          : ''}
      </div>
      ${notifs.length
        ? `<div class="notif-list" id="notif-list"></div>`
        : `<div class="empty-state" style="height:calc(100% - 64px)">
             ${I('bell', 32)}
             <span class="empty-state-title">All caught up</span>
             <p class="empty-state-body">No notifications yet.</p>
           </div>`}
    </div>
  `

  if (notifs.length) {
    const list = container.querySelector('#notif-list')
    notifs.forEach(n => list.appendChild(makeItem(n)))
  }

  container.querySelector('.notif-mark-all')?.addEventListener('click', async () => {
    await Promise.all(unread.map(n => api.markNotificationRead(n.id).catch(() => {})))
    sfx.success()
    await reload()
    await updateBadge()
  })
}

const TYPE_ICON = { info: 'info', success: 'check-circle', warning: 'warning', error: 'x-circle' }

function makeItem(n) {
  const icon = TYPE_ICON[n.type] ?? 'bell'
  const el = document.createElement('div')
  el.className = `notif-item${n.read ? '' : ' unread'}`
  el.innerHTML = `
    <div class="notif-icon-wrap notif-type-${n.type ?? 'info'}">
      ${I(icon, 16)}
    </div>
    <div class="notif-body">
      <div class="notif-item-title">${n.title}</div>
      ${n.body ? `<div class="notif-item-body">${n.body}</div>` : ''}
      <div class="notif-time">${relTime(n.created_at)}</div>
    </div>
    ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
  `
  if (!n.read) {
    el.addEventListener('click', async () => {
      await api.markNotificationRead(n.id).catch(() => {})
      el.classList.remove('unread')
      el.querySelector('.notif-unread-dot')?.remove()
      await updateBadge()
    }, { once: true })
  }
  return el
}

function relTime(ts) {
  const d = Date.now() - ts, m = Math.floor(d / 60000)
  if (m < 1)  return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}
