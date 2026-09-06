import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'

let activeTags = new Set()

export function init() {
  // Tags module manages tag state and CRUD.
  // No standalone view — filter bar lives inside the grid toolbar.
}

export async function loadTags() {
  return api.listTags()
}

export function getActiveTagIds() {
  return [...activeTags]
}

export function toggleTag(id) {
  if (activeTags.has(id)) activeTags.delete(id)
  else activeTags.add(id)
  store.emit(events.TAG_FILTER_CHANGED, { tagIds: [...activeTags] })
}

export function clearTags() {
  activeTags.clear()
  store.emit(events.TAG_FILTER_CHANGED, { tagIds: [] })
}
