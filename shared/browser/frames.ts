// Browser-safe: runs in the server and the viewer. No Buffer, no node imports.

/** Sent ahead of every JPEG so the viewer can map pointer input back to page pixels. */
export interface FrameHeader {
  deviceWidth: number
  deviceHeight: number
  targetId: string
  ts: number
}

export interface DecodedFrame {
  header: FrameHeader
  jpeg: Uint8Array
}

const HEADER_LENGTH_BYTES = 4
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Wire layout: u32 big-endian header length, UTF-8 JSON header, JPEG bytes. */
export function encodeFrame(header: FrameHeader, jpeg: Uint8Array): Uint8Array {
  const headerBytes = encoder.encode(JSON.stringify(header))
  const frame = new Uint8Array(HEADER_LENGTH_BYTES + headerBytes.length + jpeg.length)
  new DataView(frame.buffer).setUint32(0, headerBytes.length)
  frame.set(headerBytes, HEADER_LENGTH_BYTES)
  frame.set(jpeg, HEADER_LENGTH_BYTES + headerBytes.length)
  return frame
}

/** Throws on a truncated buffer or a malformed header. `jpeg` is a view over `buffer`, not a copy. */
export function decodeFrame(buffer: Uint8Array): DecodedFrame {
  if (buffer.byteLength < HEADER_LENGTH_BYTES) throw new Error("Frame truncated before header length")
  const headerLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0)
  const jpegStart = HEADER_LENGTH_BYTES + headerLength
  if (buffer.byteLength < jpegStart) throw new Error("Frame truncated inside header")
  const header = parseHeader(decoder.decode(buffer.subarray(HEADER_LENGTH_BYTES, jpegStart)))
  return { header, jpeg: buffer.subarray(jpegStart) }
}

function parseHeader(json: string): FrameHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error("Frame header is not valid JSON")
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Frame header is not an object")
  const { deviceWidth, deviceHeight, targetId, ts } = parsed as Partial<FrameHeader>
  if (
    typeof deviceWidth !== "number" || typeof deviceHeight !== "number"
    || typeof targetId !== "string" || typeof ts !== "number"
  ) {
    throw new Error("Frame header is missing fields")
  }
  return { deviceWidth, deviceHeight, targetId, ts }
}
