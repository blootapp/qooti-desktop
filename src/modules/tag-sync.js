// Online tag-vocabulary sync.
//
// Fetches qooti-tag-lens.json directly from the repo. The file carries its own
// "version" number; the app skips the download when the local version already
// matches (unless force=true).
//
// Vocab file format (at VOCAB_URL):
// {
//   "version": 1,
//   "updated_at": "2026-05-19",
//   "tags": [
//     { "id": "minimal", "en": "Minimal", "uz": "Minimal", "prompts": ["..."] }
//   ]
// }

import { api } from './tauri-api.js'
import store from './store.js'
import * as events from './events.js'

const VOCAB_URL = 'https://raw.githubusercontent.com/blootapp/qooti-tag-lens/main/qooti-tag-lens.json'

const VERSION_KEY = '__qooti_vocab_version'  // applied local version
const LATEST_KEY  = '__qooti_vocab_latest'   // latest known remote version

// ─── Internal: fetch, compare, apply ─────────────────────────────────────────
async function applyRemoteVocab(force = false) {
  const res = await fetch(VOCAB_URL, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()

  const remoteVersion = Number(data.version ?? 0)
  const localVersion  = Number(localStorage.getItem(VERSION_KEY) ?? 0)

  localStorage.setItem(LATEST_KEY, String(remoteVersion))

  if (!force && remoteVersion <= localVersion) {
    return { status: 'up_to_date', version: localVersion, latest: remoteVersion }
  }

  const tags = data.tags ?? []
  for (const tag of tags) {
    await api.upsertTagVocab(
      tag.id,
      JSON.stringify({ en: tag.en ?? tag.id, uz: tag.uz || tag.en || tag.id }),
      JSON.stringify(tag.prompts ?? []),
      true,
      0,
    )
  }

  localStorage.setItem(VERSION_KEY, String(remoteVersion))
  store.emit(events.TAG_VOCAB_CHANGED)
  console.log(`[tag-sync] vocab updated to v${remoteVersion} (${tags.length} tags)`)
  return { status: 'updated', version: remoteVersion, count: tags.length }
}

// ─── Public: silent startup sync ─────────────────────────────────────────────
export async function syncTagVocab() {
  if (!('__TAURI_INTERNALS__' in window)) return
  try {
    await applyRemoteVocab(false)
  } catch (err) {
    console.warn('[tag-sync] sync failed (offline?):', err.message)
  }
}

// ─── Public: force sync — always downloads latest even if version matches ────
export async function forceSyncTagVocab() {
  return applyRemoteVocab(true)
}

// ─── Public: check remote version without downloading ────────────────────────
export async function checkForVocabUpdate() {
  const res = await fetch(VOCAB_URL, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data   = await res.json()
  const latest = Number(data.version ?? 0)
  localStorage.setItem(LATEST_KEY, String(latest))
  const local  = getLocalVocabVersion()
  return { local, latest, hasUpdate: latest > local }
}

// ─── Public: version accessors ───────────────────────────────────────────────
export function getLocalVocabVersion()  { return Number(localStorage.getItem(VERSION_KEY) ?? 0) }
export function getLatestVocabVersion() { return Number(localStorage.getItem(LATEST_KEY)  ?? 0) }
