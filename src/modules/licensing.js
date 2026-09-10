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

/**
 * Register (or heartbeat) this install against the bloot ID and read back the
 * plan + admin-reset epoch in one call. The device_id is a random per-install
 * UUID from the Rust side (no hardware data). Returns the parsed payload, the
 * string 'not_found' when the account no longer exists (404), or null on any
 * network / native error (caller keeps the cached license under the grace window).
 */
export async function registerDevice(blootId) {
  if (!blootId) return null
  try {
    const deviceId = await api.getDeviceId()
    const label    = await api.deviceLabel()
    const res = await fetch('https://api.bloot.app/public/device', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ public_id: blootId, device_id: deviceId, label }),
    })
    if (res.status === 404) return 'not_found'
    if (!res.ok) return null
    return await res.json()   // { plan, device_count, over_limit, devices_reset_at }
  } catch {
    return null
  }
}

async function backgroundValidate() {
  _lastValidated = Date.now()
  try {
    const blootId = getSetting('bloot_id')
    if (!blootId) return

    const result = await registerDevice(blootId)

    if (result === 'not_found') {
      // Account deleted on the server (or ID no longer valid) — force re-login.
      await setSetting('bloot_id', '')
      await api.clearLicenseCache()
      cache = null
      store.emit(events.SESSION_EXPIRED)
      return
    }

    if (!result) return  // offline / native error — keep existing cache, grace window covers it

    // Grandfather logins that predate device-binding: seed logged_in_at now so
    // only an admin reset that happens AFTER this moment logs the user out.
    let loggedInAt = Number(getSetting('logged_in_at') || 0)
    if (!loggedInAt) {
      loggedInAt = Date.now()
      await setSetting('logged_in_at', String(loggedInAt))
    }

    if (result.devices_reset_at && result.devices_reset_at > loggedInAt) {
      // An admin reset this account's devices after we logged in → force re-login.
      await setSetting('bloot_id', '')
      await setSetting('logged_in_at', '0')
      await api.clearLicenseCache()
      cache = null
      store.emit(events.SESSION_EXPIRED)
      return
    }

    if (result.plan) {
      await api.updateLicensePlan(result.plan)
      await setSetting('plan', result.plan)   // keeps settings UI in sync
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
