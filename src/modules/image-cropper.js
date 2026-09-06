// Canvas-based circular image cropper.
// Usage: openImageCropper({ onSave(dataUrl), onCancel })

const CANVAS_W = 380
const CANVAS_H = 320
const CROP_R   = 128   // radius → 256 px diameter output

export function openImageCropper({ onSave, onCancel } = {}) {
  const input = document.createElement('input')
  input.type   = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => showCropper(img, { onSave, onCancel })
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

function showCropper(img, { onSave, onCancel }) {
  const CX = CANVAS_W / 2
  const CY = CANVAS_H / 2

  // Initial scale: fill the crop circle
  const minScale = Math.max((CROP_R * 2) / img.width, (CROP_R * 2) / img.height) * 1.05
  let scale = minScale
  let ox = CX - (img.width  * scale) / 2
  let oy = CY - (img.height * scale) / 2

  // ── Build DOM ──
  const overlay = document.createElement('div')
  overlay.className = 'cropper-overlay'
  overlay.innerHTML = `
    <div class="cropper-modal">
      <div class="cropper-header">
        <span class="icon icon-16" style="mask-image:url('/icons/crop.svg');-webkit-mask-image:url('/icons/crop.svg')" aria-hidden="true"></span>
        Crop photo
      </div>
      <canvas class="cropper-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
      <div class="cropper-hint">Drag to reposition · scroll to zoom</div>
      <div class="cropper-actions">
        <button class="btn btn-ghost cropper-cancel">Cancel</button>
        <button class="btn btn-primary cropper-save">Save photo</button>
      </div>
    </div>
  `
  document.getElementById('overlays').appendChild(overlay)

  const canvas = overlay.querySelector('.cropper-canvas')
  const ctx    = canvas.getContext('2d')
  canvas.style.cursor = 'grab'

  // ── Draw ──
  function draw() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)

    // Dimmed image (outside crop)
    ctx.save()
    ctx.globalAlpha = 0.32
    ctx.drawImage(img, ox, oy, img.width * scale, img.height * scale)
    ctx.restore()

    // Full-brightness image clipped to circle
    ctx.save()
    ctx.beginPath()
    ctx.arc(CX, CY, CROP_R, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(img, ox, oy, img.width * scale, img.height * scale)
    ctx.restore()

    // Ring
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.65)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(CX, CY, CROP_R, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // ── Drag ──
  let dragging = false, lx = 0, ly = 0
  canvas.addEventListener('mousedown', e => {
    dragging = true; lx = e.clientX; ly = e.clientY
    canvas.style.cursor = 'grabbing'
  })
  const onMove = e => {
    if (!dragging) return
    ox += e.clientX - lx; oy += e.clientY - ly
    lx = e.clientX; ly = e.clientY
    draw()
  }
  const onUp = () => { dragging = false; canvas.style.cursor = 'grab' }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup',   onUp)

  // ── Scroll to zoom ──
  canvas.addEventListener('wheel', e => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.08 : 0.92
    const next = Math.max(minScale, scale * factor)
    ox = CX - (CX - ox) * (next / scale)
    oy = CY - (CY - oy) * (next / scale)
    scale = next
    draw()
  }, { passive: false })

  // ── Cleanup ──
  function cleanup() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup',   onUp)
    overlay.remove()
  }

  overlay.querySelector('.cropper-cancel').addEventListener('click', () => { cleanup(); onCancel?.() })

  overlay.querySelector('.cropper-save').addEventListener('click', () => {
    const d = CROP_R * 2
    const out  = document.createElement('canvas')
    out.width  = d; out.height = d
    const octx = out.getContext('2d')
    octx.beginPath()
    octx.arc(CROP_R, CROP_R, CROP_R, 0, Math.PI * 2)
    octx.clip()
    octx.drawImage(img,
      ox - (CX - CROP_R),
      oy - (CY - CROP_R),
      img.width * scale,
      img.height * scale)
    cleanup()
    onSave?.(out.toDataURL('image/webp', 0.85))
  })

  draw()
}
