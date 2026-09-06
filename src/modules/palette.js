// Canvas-based dominant color extraction using median-cut quantization.
// Operates synchronously on an already-loaded HTMLImageElement — no network I/O.
// Returns an array of hex strings sorted by cluster size (dominant first).

export function extractPaletteFromElement(imgEl, numColors = 5) {
  try {
    const canvas = document.createElement('canvas')
    canvas.width  = 80
    canvas.height = 80
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(imgEl, 0, 0, 80, 80)
    const { data } = ctx.getImageData(0, 0, 80, 80)
    const pixels = gatherPixels(data)
    if (!pixels.length) return []
    const depth = Math.ceil(Math.log2(numColors))
    return medianCut(pixels, depth)
      .sort((a, b) => b.length - a.length)
      .slice(0, numColors)
      .map(bucket => toHex(averageColor(bucket)))
  } catch {
    return []  // tainted canvas or zero-size image
  }
}

function gatherPixels(data) {
  const px = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue  // skip transparent
    px.push([data[i], data[i + 1], data[i + 2]])
  }
  return px
}

function medianCut(pixels, depth) {
  if (depth === 0 || pixels.length === 0) return [pixels]

  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0
  for (const [r, g, b] of pixels) {
    if (r < rMin) rMin = r; if (r > rMax) rMax = r
    if (g < gMin) gMin = g; if (g > gMax) gMax = g
    if (b < bMin) bMin = b; if (b > bMax) bMax = b
  }

  const rRange = rMax - rMin
  const gRange = gMax - gMin
  const bRange = bMax - bMin
  const ch = (rRange >= gRange && rRange >= bRange) ? 0 : (gRange >= bRange) ? 1 : 2

  pixels.sort((a, b) => a[ch] - b[ch])
  const mid = pixels.length >> 1
  return [
    ...medianCut(pixels.slice(0, mid), depth - 1),
    ...medianCut(pixels.slice(mid),    depth - 1),
  ]
}

function averageColor(pixels) {
  if (!pixels.length) return [0, 0, 0]
  let sr = 0, sg = 0, sb = 0
  for (const [r, g, b] of pixels) { sr += r; sg += g; sb += b }
  const n = pixels.length
  return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)]
}

function toHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}
