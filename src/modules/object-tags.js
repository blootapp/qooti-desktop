// Object / content detection for keyword search.
//
// Runs CLIP (transformers.js, via the same worker as auto-tag) over each image ONCE — on
// import, and on a manual "Reindex" — and stores the detected object labels on the item.
// Those labels flow into the FTS index (see db.rs), so searching "box" matches any image
// that contains a box, with ZERO analysis at search time.
//
// Mirrors the OCR pipeline: claim a batch → infer → finalize. The CLIP worker is spun up
// on demand and terminated after each drain to keep idle memory low.

import store from './store.js'
import * as events from './events.js'
import { api } from './tauri-api.js'
import { makeLogger } from './logger.js'

const log = makeLogger('ObjectTags')

const BATCH_SIZE = 3
const THRESHOLD  = 0.3    // min score to keep a detected label
const TOP_K      = 10     // max object labels stored per image

// Broad common-object vocabulary. Bare labels — the zero-shot pipeline templates them.
const OBJECTS = [
  'person','man','woman','child','baby','crowd','face','hand',
  'dog','cat','bird','horse','cow','sheep','fish','insect','butterfly','flower','plant','tree','leaf','grass','forest','mushroom',
  'mountain','hill','rock','cliff','beach','ocean','wave','river','lake','waterfall','desert','snow','ice','sky','cloud','sunset','rainbow','fire','smoke',
  'car','truck','bus','van','motorcycle','bicycle','scooter','train','airplane','helicopter','boat','ship','rocket',
  'road','street','highway','bridge','tunnel','building','skyscraper','house','apartment','castle','church','tower','stadium','factory','ruins',
  'city','skyline','window','door','stairs','roof','fence','wall','sign','billboard','streetlight','traffic light',
  'box','cardboard box','package','bag','backpack','suitcase','basket','bottle','can','jar','cup','mug','glass','plate','bowl','spoon','fork','knife','pot','pan',
  'food','fruit','apple','banana','orange','grapes','strawberry','lemon','vegetable','tomato','bread','sandwich','burger','pizza','pasta','rice','noodles','soup','salad','cake','cookie','donut','ice cream','chocolate','egg','meat','cheese',
  'coffee','tea','juice','wine','beer','cocktail',
  'chair','table','desk','sofa','bed','shelf','cabinet','mirror','lamp','clock','vase','curtain','carpet','pillow','blanket',
  'phone','smartphone','laptop','computer','monitor','keyboard','mouse','tablet','camera','headphones','speaker','microphone','television','remote','game controller','printer','router','cable','charger',
  'book','magazine','newspaper','notebook','pen','pencil','paper','envelope','stamp','map','calendar','scissors','ruler','paint','brush',
  'watch','ring','necklace','glasses','sunglasses','hat','cap','helmet','scarf','tie','gloves','shoe','sneaker','boot','sandal','shirt','t-shirt','jacket','coat','dress','skirt','jeans','suit','sweater',
  'ball','football','basketball','tennis','skateboard','surfboard','ski','dumbbell','trophy','medal',
  'guitar','piano','violin','drum','trumpet','saxophone',
  'candle','balloon','gift','flag','umbrella','fountain','statue','sculpture','painting','drawing','graffiti','mural','poster','logo','icon','chart','graph','diagram','infographic','screenshot','user interface','website','app','dashboard','wireframe','mockup','business card','packaging','label',
  'robot','drone','satellite','telescope','microscope','gear','engine','tool','hammer','wrench','screwdriver','ladder','wheel','tire','key','lock',
  'money','coin','credit card','wallet','shopping cart','price tag',
  'toy','teddy bear','doll','lego','puzzle','dice','chess',
  'text','typography','handwriting','number','pattern','texture','gradient','abstract','portrait','landscape','black and white','neon','minimal',
]

// ─── Web Worker bridge (reuses the CLIP zero-shot worker) ─────────────────────
let _worker = null, _reqCounter = 0
const _pending = new Map()

function getWorker() {
  if (_worker) return _worker
  _worker = new Worker(new URL('../workers/auto-tag-worker.js', import.meta.url), { type: 'module' })
  _worker.onmessage = ({ data }) => {
    if (data.type === 'result') { const r = _pending.get(data.reqId); if (r) { _pending.delete(data.reqId); r.resolve(data.results) } }
    else if (data.type === 'error') { const r = _pending.get(data.reqId); if (r) { _pending.delete(data.reqId); r.reject(new Error(data.message)) } }
  }
  _worker.onerror = () => { for (const [, r] of _pending) r.reject(new Error('Worker crashed')); _pending.clear(); _worker = null }
  return _worker
}
function terminateWorker() { if (_worker) { _worker.terminate(); _worker = null } _pending.clear() }
function infer(dataUrl, labels) {
  return new Promise((resolve, reject) => {
    const reqId = ++_reqCounter
    _pending.set(reqId, { resolve, reject })
    getWorker().postMessage({ type: 'infer', reqId, dataUrl, prompts: labels, clearCache: false })
  })
}

// ─── Per-item detection ───────────────────────────────────────────────────────
async function processOne(item) {
  let tags = '', status = 'done'
  try {
    const b64 = await api.readImageAsBase64(item.stored_path)
    const dataUrl = `data:${item.mime_type ?? 'image/jpeg'};base64,${b64}`
    const results = await infer(dataUrl, OBJECTS)
    const kept = results
      .filter(r => r.score >= THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .map(r => r.label)
    tags = [...new Set(kept)].join(' ')
    log.info('detected', { id: item.id, objects: kept.length })
  } catch (err) {
    log.error('inference_error', { id: item.id, error: String(err) })
    status = 'failed'
  }
  await api.finalizeObjectResult(item.id, tags, status)
    .catch(e => log.error('finalize_error', { id: item.id, error: String(e) }))
}

// ─── Drain loop ───────────────────────────────────────────────────────────────
// Processes all currently-pending items (new imports / reindexed), then stops. There is
// NO idle polling — it only runs when triggered, matching the "on import only" choice.
let _running = false
async function drain() {
  if (_running) return
  _running = true
  try {
    while (true) {
      const batch = await api.claimObjectCandidates(BATCH_SIZE)
      if (!batch.length) break
      for (const item of batch) await processOne(item)
    }
  } catch (err) {
    log.error('drain_crashed', { error: String(err) })
  } finally {
    _running = false
    terminateWorker()   // release the model between bursts
  }
}

export function initObjectTags() {
  if (!('__TAURI_INTERNALS__' in window)) return
  // GRID_RELOAD fires on import and on the Settings "Reindex" — both are the triggers we
  // want. Existing items are marked 'skipped' by the migration, so this only picks up new
  // imports (and everything after a reindex). Cheap no-op when nothing is pending.
  store.on(events.GRID_RELOAD, () => drain())
  drain()   // finish anything left pending from a previous session
}
