import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { getSetting, setSetting } from './settings.js'

// qooti's account comes from bloot apps (MD/bloot-apps-licensing.md §9): bloot apps
// signs in and keeps a signed licence ticket in the shared Bloot Apps folder; the
// Rust side (bloot_hub.rs) verifies it offline. qooti never asks for a bloot ID.
//
// The verified account is mirrored into the existing preferences (bloot_id,
// display_name, plan = 'pro' | 'free'), so the avatar, the free-plan limits and
// Settings keep reading what they always read.

let account = null          // { state, name, bloot_id, tier, pro_until, hub_installed }
let polling = null
const POLL_MS = 15_000      // the ticket file is tiny; re-checked often so sign-out / Pro land quickly

export async function init() {
  try { await api.hubPrepare() } catch {}   // share the device id, start bloot apps in the background
  await check()
  clearInterval(polling)
  polling = setInterval(check, POLL_MS)
  window.addEventListener('focus', () => check())

  // qooti://plan-sync (old payment flow) and the refresh button: ask bloot apps to
  // refresh the licence now, then re-read it.
  store.on(events.LICENSE_PUSH_RECEIVED, refreshNow)
  store.on(events.LICENSE_MANUAL_REFRESH, refreshNow)
}

export const getAccount = () => account
export const isSignedIn = () => account?.state === 'signed_in'
export function isActive()     { return isSignedIn() }
export function getPlan()      { return isSignedIn() && account.tier === 'pro' ? 'pro' : 'free' }
export function getExpiresAt() { return isSignedIn() ? account.pro_until ?? null : null }

/** Open bloot apps on its sign-in screen (it brings qooti back when done) or account page. */
export async function openHub(screen) {
  try { await api.hubOpen(screen); return true } catch { return false }
}

async function refreshNow() {
  try { await apply(await api.hubRefresh()) } catch {}
}

/** Re-read the ticket; returns the account. Cheap enough to call any time. */
export async function check() {
  try { await apply(await api.hubAccount()) } catch {}
  return account
}

const same = (a, b) => !!a && !!b && ['state', 'name', 'bloot_id', 'tier', 'pro_until', 'hub_installed'].every(k => a[k] === b[k])

async function apply(next) {
  if (!next || same(account, next)) return
  const wasIn = isSignedIn()
  account = next
  const nowIn = isSignedIn()

  if (nowIn) {
    // Mirror into preferences — only what changed (each write emits SETTINGS_CHANGED).
    const want = { bloot_id: account.bloot_id, display_name: account.name || account.bloot_id, plan: getPlan() }
    for (const [k, v] of Object.entries(want)) if (getSetting(k) !== v) await setSetting(k, v)
  } else if (getSetting('plan') !== 'free') {
    await setSetting('plan', 'free')
  }

  store.emit(events.LICENSE_STATUS_CHANGED, { plan: getPlan(), expiresAt: getExpiresAt(), account })
  if (wasIn && !nowIn) store.emit(events.SESSION_EXPIRED)   // signed out in bloot apps → sign-in screen
  if (!wasIn && nowIn) store.emit(events.HUB_SIGNED_IN)
}
