// "Preview as a new user" — secret search command `blt_starter` (developer.js).
//
// Replays the first-run flow (sign in → waiting → on-device note → empty library → tour →
// extension card) without touching anything real: the library, collections, tags, boards
// and milestones only *look* empty (their read calls return nothing), and the "seen"
// flags that first-run normally saves are not written. Lives in sessionStorage, so it
// ends when you press Exit on the pill or close the app.

import { t } from './i18n.js'

const KEY = 'qooti-starter-preview'

export function isStarterPreview() {
  try { return sessionStorage.getItem(KEY) === '1' } catch { return false }
}

export function startStarterPreview() {
  try { sessionStorage.setItem(KEY, '1') } catch {}
  window.location.reload()
}

export function exitStarterPreview() {
  try { sessionStorage.removeItem(KEY) } catch {}
  window.location.reload()
}

/** Make the library look brand new — reads only, nothing is deleted or written. */
export function applyStarterPreview(api) {
  const none = () => Promise.resolve([])
  Object.assign(api, {
    listInspirations: none,
    listCollections:  none,
    listTags:         none,
    listBoards:       none,
    listMilestones:   none,
    findDuplicates:   none,
    getFreePlanInfo:  () => Promise.resolve({ item_total: 0, item_limit: 200, collections_used: 0, collections_limit: 3 }),
  })
}

/** The pill that says you're in the preview, with the way out. */
export function showStarterPill() {
  if (document.getElementById('starter-pill')) return
  const pill = document.createElement('div')
  pill.id = 'starter-pill'
  pill.className = 'starter-pill'
  pill.innerHTML = `
    <span class="starter-pill-dot" aria-hidden="true"></span>
    <span>${t('starter.label')}</span>
    <button type="button">${t('starter.exit')}</button>`
  pill.querySelector('button').addEventListener('click', exitStarterPreview)
  document.body.appendChild(pill)
}
