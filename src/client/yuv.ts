/**
 * I420 (YUV 4:2:0 planar) to RGBA conversion for the software decode path.
 *
 * TinyH264 hands back the same buffer h264bsd produces: full-size Y followed by
 * half-size U and V planes. WebCodecs never uses this function; the soft path
 * runs on the main thread (see docs/client.md for the trade-off).
 */

/**
 * Convert one I420 frame into RGBA bytes.
 * @param i420 - Y, U and V planes back to back.
 * @param width - coded picture width.
 * @param height - coded picture height.
 * @param rgba - optional destination (reused between frames to avoid GC churn).
 * @returns RGBA bytes, or `undefined` when the buffer is too small.
 */
export function i420ToRgba(
  i420: Uint8Array,
  width: number,
  height: number,
  rgba?: Uint8Array,
): Uint8Array | undefined {
  if (width <= 0 || height <= 0) return undefined
  const chromaWidth = Math.ceil(width / 2)
  const chromaHeight = Math.ceil(height / 2)
  const lumaSize = width * height
  const chromaSize = chromaWidth * chromaHeight
  if (i420.length < lumaSize + chromaSize * 2) return undefined
  const out = rgba !== undefined && rgba.length === lumaSize * 4 ? rgba : new Uint8Array(lumaSize * 4)

  for (let row = 0; row < height; row += 1) {
    const chromaRow = (row >> 1) * chromaWidth
    let yIndex = row * width
    let uIndex = lumaSize + chromaRow
    let vIndex = lumaSize + chromaSize + chromaRow
    let outIndex = yIndex * 4
    for (let column = 0; column < width; column += 1) {
      const y = i420[yIndex]! - 16
      const u = i420[uIndex]! - 128
      const v = i420[vIndex]! - 128
      // BT.601 limited-range integer approximation; matches scrcpy's preview.
      const c = y * 298
      out[outIndex] = clamp((c + 409 * v + 128) >> 8)
      out[outIndex + 1] = clamp((c - 100 * u - 208 * v + 128) >> 8)
      out[outIndex + 2] = clamp((c + 516 * u + 128) >> 8)
      out[outIndex + 3] = 255
      yIndex += 1
      if ((column & 1) === 1) {
        uIndex += 1
        vIndex += 1
      }
      outIndex += 4
    }
  }
  return out
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}
