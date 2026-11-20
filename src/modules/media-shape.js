// Previews never cut a picture (spec A3). A grid card, or a "Not in a collection" tile,
// is sized from the item's saved aspect ratio before its picture arrives. Once the
// picture, thumbnail or video has loaded, its real shape is compared with the saved one:
//  • off by more than 0.1 %: the box takes the real shape at once (with object-fit:
//    contain a smaller mismatch shows no bar, so it isn't worth a change);
//  • off by more than 1 %: a real mistake, saved (set_item_aspect), so the next render is
//    right from the start. Each item is sent once a session.
// No motion: this runs in the load handler, in the frame the picture starts its fade-in.

import { api } from './tauri-api.js'
import { makeLogger } from './logger.js'

const log = makeLogger('Shape')

const SHOW_OFF = 0.001
const SAVE_OFF = 0.01
const _shapeSaved = new Set()   // ids sent this session

/** Size `box` (when given) to the media's real shape `w` × `h`, and save a wrong ratio. */
export function matchRealShape(item, box, w, h) {
  if (!item?.id || !(w > 0) || !(h > 0)) return
  const real   = w / h
  const stored = item.aspect_ratio > 0 ? item.aspect_ratio : 1
  // The box is compared on its own shape: the same item can be on several cards (the
  // Free teaser repeats some), and the first one to load corrects `item` for all
  if (box) {
    const shown = boxRatio(box) ?? stored
    if (Math.abs(real - shown) / real > SHOW_OFF) box.style.aspectRatio = String(real)
  }
  if (Math.abs(real - stored) / real <= SAVE_OFF) return
  // The same object sits in the grid's lists (rendered, relayout cache, teaser), so the
  // next relayout balances its columns with the right height too
  item.aspect_ratio = real
  if (_shapeSaved.has(item.id)) return
  _shapeSaved.add(item.id)
  api.setItemAspect(item.id, real)
    .catch(err => log.debug('shape_not_saved', { id: item.id, error: err }))
}

// The ratio a box was given: Chromium reads "0.8" back as "0.8 / 1"; null when unset
function boxRatio(box) {
  const [w, h = 1] = String(box.style.aspectRatio || '').split('/').map(Number)
  return w > 0 && h > 0 ? w / h : null
}
