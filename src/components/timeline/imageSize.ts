export interface ImageSize {
  width: number
  height: number
}

const REMEMBERED_SIZES = 512
const sizes = new Map<string, ImageSize | null>()

/** Enough of a data URL to reach a JPEG's frame header past typical EXIF blocks. */
const HEADER_BASE64_CHARS = 87_384

function remember(src: string, size: ImageSize | null): void {
  if (sizes.size >= REMEMBERED_SIZES) sizes.delete(sizes.keys().next().value!)
  sizes.set(src, size)
}

/** Records the size an image turned out to have, so the next mount reserves it exactly. */
export function rememberImageSize(src: string, width: number, height: number): void {
  if (width > 0 && height > 0) remember(src, { width, height })
}

/**
 * The image's pixel size when it is already known: read from the header of a
 * base64 data URL, or remembered from an earlier load of the same source.
 */
export function knownImageSize(src: string | undefined): ImageSize | null {
  if (!src) return null
  const cached = sizes.get(src)
  if (cached !== undefined) return cached
  if (!src.startsWith("data:")) return null
  const size = dataUrlImageSize(src)
  remember(src, size)
  return size
}

function dataUrlImageSize(src: string): ImageSize | null {
  const comma = src.indexOf(",")
  if (comma < 0 || !src.slice(0, comma).endsWith(";base64")) return null
  let bytes: Uint8Array
  try {
    const head = src.slice(comma + 1, comma + 1 + HEADER_BASE64_CHARS)
    const binary = atob(head.slice(0, head.length - (head.length % 4)))
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
  return headerImageSize(bytes)
}

/** Pixel size from the first bytes of a PNG, GIF, WebP or JPEG file. */
export function headerImageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  const valid = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null)

  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
    return valid(view.getUint32(16), view.getUint32(20))
  }
  if (bytes.length >= 10 && ascii(0, 4) === "GIF8") {
    return valid(view.getUint16(6, true), view.getUint16(8, true))
  }
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4)
    if (chunk === "VP8 ") return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true)
      return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    if (chunk === "VP8X") {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return valid(width, height)
    }
    return null
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]
      if (marker === 0xff) {
        offset++
        continue
      }
      const length = view.getUint16(offset + 2)
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return valid(view.getUint16(offset + 7), view.getUint16(offset + 5))
      offset += 2 + length
    }
  }
  return null
}
