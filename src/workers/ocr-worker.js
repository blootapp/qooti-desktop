// OCR Web Worker — PP-OCRv4 (text detection + recognition) via onnxruntime-web.
// Cross-platform, no native sidecar. Models + ort wasm are bundled under /public
// (see public/models/ocr and public/ort), so this works fully offline.
//
// Messages in:  { reqId, base64, mimeType? }
// Messages out: { type:'result', reqId, text, language }
//               { type:'error',  reqId, message }
//               { type:'status', text }   (model-load progress)

import Ocr from '@gutenye/ocr-browser'
import * as ort from 'onnxruntime-web'

// @gutenye/ocr-browser is written for the main thread — its ImageRaw decodes
// images with `new Image()` + `document.createElement('canvas')`, which don't
// exist in a Web Worker ("Image is not defined"). Shim just those with the
// worker-native OffscreenCanvas / createImageBitmap so OCR can run off the UI
// thread (no per-image jank). Only installed inside a worker.
if (typeof document === 'undefined' && typeof OffscreenCanvas !== 'undefined') {
  self.document = {
    createElement: tag => (tag === 'canvas' ? new OffscreenCanvas(1, 1) : {}),
    body: { append() {} },   // ImageRaw.write() only — unused by detect()
  }
  // drawImage needs a real CanvasImageSource; our Image shim carries the decoded
  // ImageBitmap on `__bitmap`, so unwrap it here.
  const ctxProto = OffscreenCanvasRenderingContext2D.prototype
  const origDrawImage = ctxProto.drawImage
  ctxProto.drawImage = function (img, ...rest) {
    return origDrawImage.call(this, (img && img.__bitmap) || img, ...rest)
  }
  self.Image = class {
    async decode() {
      const blob = await (await fetch(this.src)).blob()
      this.__bitmap = await createImageBitmap(blob)
      this.naturalWidth  = this.__bitmap.width
      this.naturalHeight = this.__bitmap.height
    }
  }
}

// The Tauri webview / custom protocol is not cross-origin-isolated, so
// SharedArrayBuffer is unavailable → force single-threaded wasm.
// Do NOT set wasmPaths: onnxruntime-web resolves its wasm through the bundler
// (Vite emits it as a hashed asset and inlines the .mjs loader). Pointing
// wasmPaths at /public makes ort import() a public file, which Vite forbids.
ort.env.wasm.numThreads = 1

let _ocr = null
async function ensureOcr() {
  if (_ocr) return _ocr
  self.postMessage({ type: 'status', text: 'Loading OCR models…' })
  _ocr = await Ocr.create({
    models: {
      detectionPath:   '/models/ocr/det.onnx',
      recognitionPath: '/models/ocr/rec.onnx',
      dictionaryPath:  '/models/ocr/dict.txt',
    },
  })
  self.postMessage({ type: 'status', text: 'OCR ready' })
  return _ocr
}

self.onmessage = async ({ data }) => {
  const { reqId, base64, mimeType = 'image/jpeg' } = data
  try {
    const ocr     = await ensureOcr()
    const dataUrl = `data:${mimeType};base64,${base64}`
    const lines   = await ocr.detect(dataUrl)          // [{ text, score, frame }]
    const text    = lines.map(l => l.text).join('\n').trim()
    self.postMessage({ type: 'result', reqId, text, language: detectLanguage(text) })
  } catch (err) {
    self.postMessage({ type: 'error', reqId, message: err?.message ?? String(err) })
  }
}

function detectLanguage(text) {
  if (!text) return 'eng'
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length
  const alpha    = (text.match(/[a-zA-ZЀ-ӿ]/g) ?? []).length
  return alpha > 0 && cyrillic / alpha > 0.3 ? 'uzb' : 'eng'
}
