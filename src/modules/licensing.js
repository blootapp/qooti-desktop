import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { getSetting, setSetting } from './settings.js'

let cache = null
let _lastValidated = 0

export async function init() {
  cache = await api.getLicenseCache()

  // Always schedule — backgroundValidate() guards itself with bloot_id check.
  // initLicensing() runs before initSettings(), so getSetting() is empty here;
  // by the time 10 s elapse, settings is fully populated.
  setTimeout(backgroundValidate, 10_000)

  // Deep link (qooti://plan-sync) fires this event after a successful upgrade.
  // Debounced to 60 s so rapid re-triggers (e.g. user clicks the link twice) don't pile up.
  store.on(events.LICENSE_PUSH_RECEIVED, () => {
    const now = Date.now()
    if (now - _lastValidated < 60_000) return
    backgroundValidate()
  })

  // Manual refresh button in Settings — rate limit enforced by settings.js before emitting.
  store.on(events.LICENSE_MANUAL_REFRESH, () => {
    backgroundValidate()
  })
}

export function isActive() {
  if (!cache) return false
  return isValid(cache) && cache.plan_type !== null && !cache.revoked_at
}

function isValid(c) {
  if (!c.last_validated_at) return false
  const gracePeriod = 7 * 24 * 60 * 60 * 1000 // 7 days
  return (Date.now() - c.last_validated_at) < gracePeriod
}

async function backgroundValidate() {
  _lastValidated = Date.now()
  try {
    const blootId = getSetting('bloot_id')
    if (!blootId) return

    const res = await fetch(`https://api.bloot.app/public/user/${encodeURIComponent(blootId)}`)

    if (res.status === 404) {
      // User was deleted on the server — clear local identity and force re-login.
      await setSetting('bloot_id', '')
      await api.clearLicenseCache()
      cache = null
      store.emit(events.SESSION_EXPIRED)
      return
    }

    if (!res.ok) return  // other server errors — keep existing cache, grace window covers it

    const data = await res.json()

    if (data.plan) {
      await api.updateLicensePlan(data.plan)
      await setSetting('plan', data.plan)   // keeps settings UI in sync
    }

    const updated = await api.getLicenseCache()
    if (updated) {
      cache = updated
      store.emit(events.LICENSE_STATUS_CHANGED, cache)
    }
  } catch {
    // Offline — keep existing cache, grace window applies
  }
}

export function getPlan()      { return cache?.plan_type ?? null }
export function getExpiresAt() { return cache?.expires_at ?? null }
