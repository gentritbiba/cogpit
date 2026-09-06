import { describe, expect, it } from "vitest"
import { decodeFrame, encodeFrame, type FrameHeader } from "../../../shared/browser/frames"
import { parseClientMessage, type BrowserClientMessage } from "../../../shared/browser/protocol"

const header: FrameHeader = {
  deviceWidth: 1280,
  deviceHeight: 720,
  pageScaleFactor: 2,
  offsetTop: 48,
  scrollOffsetX: 0,
  scrollOffsetY: 320,
  targetId: "tab-1",
  ts: 1_700_000_000_000,
}

function headerLengthOf(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0)
}

function frameWithHeaderBytes(headerBytes: Uint8Array, jpeg: Uint8Array = new Uint8Array()): Uint8Array {
  const frame = new Uint8Array(4 + headerBytes.length + jpeg.length)
  new DataView(frame.buffer).setUint32(0, headerBytes.length)
  frame.set(headerBytes, 4)
  frame.set(jpeg, 4 + headerBytes.length)
  return frame
}

describe("frame codec", () => {
  it("round trips a header with multi-byte UTF-8 and a JPEG payload", () => {
    const wide: FrameHeader = { ...header, targetId: "标签-ページ-🧭" }
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])
    const encoded = encodeFrame(wide, jpeg)

    expect(headerLengthOf(encoded)).toBeGreaterThan(JSON.stringify(wide).length)
    expect(encoded.length).toBe(4 + headerLengthOf(encoded) + jpeg.length)

    const decoded = decodeFrame(encoded)
    expect(decoded.header).toEqual(wide)
    expect(Array.from(decoded.jpeg)).toEqual(Array.from(jpeg))
  })

  it("round trips an empty JPEG payload", () => {
    const decoded = decodeFrame(encodeFrame(header, new Uint8Array()))
    expect(decoded.header).toEqual(header)
    expect(decoded.jpeg.length).toBe(0)
  })

  it("decodes a buffer that ends exactly at the header and rejects one byte less", () => {
    const exact = encodeFrame(header, new Uint8Array())
    expect(exact.length).toBe(4 + headerLengthOf(exact))
    expect(decodeFrame(exact).header).toEqual(header)

    expect(() => decodeFrame(exact.subarray(0, exact.length - 1))).toThrow(Error)
    expect(() => decodeFrame(new Uint8Array([0, 0])).header).toThrow(Error)
  })

  it.each(Object.keys(header))("rejects a JSON header missing %s — no field has a decoder default", (omitted) => {
    const partial = { ...header, [omitted]: undefined }
    const frame = frameWithHeaderBytes(new TextEncoder().encode(JSON.stringify(partial)))
    expect(() => decodeFrame(frame)).toThrow(Error)
  })

  it("rejects a header whose fields have the wrong types", () => {
    const frame = frameWithHeaderBytes(new TextEncoder().encode(JSON.stringify({ ...header, deviceWidth: "1280" })))
    expect(() => decodeFrame(frame)).toThrow(Error)
    expect(() => decodeFrame(frameWithHeaderBytes(new TextEncoder().encode("[1,2,3]")))).toThrow(Error)
  })

  it("rejects garbage header bytes", () => {
    const frame = frameWithHeaderBytes(new Uint8Array([0xff, 0xfe, 0x00, 0x7b, 0x01]), new Uint8Array([1, 2, 3]))
    expect(() => decodeFrame(frame)).toThrow(Error)
  })

  it("returns the JPEG as a view over the input buffer", () => {
    const jpeg = new Uint8Array([9, 8, 7, 6])
    const encoded = encodeFrame(header, jpeg)
    const decoded = decodeFrame(encoded)

    expect(decoded.jpeg.buffer).toBe(encoded.buffer)
    expect(decoded.jpeg.byteOffset).toBe(4 + headerLengthOf(encoded))
    expect(decoded.jpeg.byteLength).toBe(jpeg.length)
  })

  it("honors the byte offset of a view into a larger buffer", () => {
    const jpeg = new Uint8Array([9, 8, 7, 6])
    const encoded = encodeFrame(header, jpeg)
    const padding = 8
    const padded = new Uint8Array(padding + encoded.length + 3)
    padded.set(encoded, padding)

    const decoded = decodeFrame(padded.subarray(padding, padding + encoded.length))
    expect(decoded.header).toEqual(header)
    expect(decoded.jpeg.buffer).toBe(padded.buffer)
    expect(decoded.jpeg.byteOffset).toBe(padding + 4 + headerLengthOf(encoded))
    expect(Array.from(decoded.jpeg)).toEqual(Array.from(jpeg))
  })
})

describe("parseClientMessage", () => {
  const valid: BrowserClientMessage[] = [
    { type: "viewport", width: 1280, height: 720, dpr: 2 },
    { type: "mouse", event: "down", x: 10.5, y: 20, button: "left", clickCount: 1, modifiers: 0 },
    { type: "mouse", event: "move", x: -1, y: 0, button: "none", clickCount: 0, modifiers: 8 },
    { type: "wheel", x: 1, y: 2, deltaX: -120, deltaY: 0.5, modifiers: 0 },
    { type: "key", event: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 },
    { type: "key", event: "up", key: "Shift", code: "ShiftLeft", modifiers: 8 },
    { type: "navigate", url: "https://example.com" },
    { type: "back" },
    { type: "forward" },
    { type: "reload" },
    { type: "follow", targetId: "tab-1" },
    { type: "close-tab", targetId: "tab-1" },
    { type: "launch", url: "about:blank" },
  ]

  it.each(valid.map((message) => [message.type, message] as const))("accepts a valid %s message", (_type, message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message)
  })

  it("drops fields that are not part of the message", () => {
    expect(parseClientMessage(JSON.stringify({ type: "back", extra: 1, __proto__: { polluted: true } })))
      .toEqual({ type: "back" })
    expect(parseClientMessage(JSON.stringify({ type: "follow", targetId: "t", url: "x" })))
      .toEqual({ type: "follow", targetId: "t" })
  })

  it.each([
    ["not JSON", "{"],
    ["a JSON string", "\"viewport\""],
    ["null", "null"],
    ["an array", "[]"],
    ["no type", JSON.stringify({ width: 1 })],
    ["an unknown type", JSON.stringify({ type: "eval", code: "1" })],
    ["a prototype key as type", JSON.stringify({ type: "constructor" })],
    ["a numeric type", JSON.stringify({ type: 1 })],
  ])("returns null for %s", (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull()
  })

  it.each([
    ["missing height", { type: "viewport", width: 1, dpr: 1 }],
    ["zero width", { type: "viewport", width: 0, height: 1, dpr: 1 }],
    ["negative height", { type: "viewport", width: 1, height: -1, dpr: 1 }],
    ["width over 8192", { type: "viewport", width: 8193, height: 1, dpr: 1 }],
    ["dpr over 4", { type: "viewport", width: 1, height: 1, dpr: 4.5 }],
    ["dpr zero", { type: "viewport", width: 1, height: 1, dpr: 0 }],
    ["string width", { type: "viewport", width: "1280", height: 1, dpr: 1 }],
    ["bad mouse event", { type: "mouse", event: "click", x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 }],
    ["bad mouse button", { type: "mouse", event: "down", x: 1, y: 1, button: "back", clickCount: 1, modifiers: 0 }],
    ["missing mouse y", { type: "mouse", event: "down", x: 1, button: "left", clickCount: 1, modifiers: 0 }],
    ["NaN mouse x", { type: "mouse", event: "down", x: NaN, y: 1, button: "left", clickCount: 1, modifiers: 0 }],
    ["fractional clickCount", { type: "mouse", event: "down", x: 1, y: 1, button: "left", clickCount: 1.5, modifiers: 0 }],
    ["negative modifiers", { type: "mouse", event: "down", x: 1, y: 1, button: "left", clickCount: 1, modifiers: -1 }],
    ["missing wheel delta", { type: "wheel", x: 1, y: 1, deltaX: 1, modifiers: 0 }],
    ["string wheel delta", { type: "wheel", x: 1, y: 1, deltaX: "1", deltaY: 1, modifiers: 0 }],
    ["bad key event", { type: "key", event: "press", key: "a", code: "KeyA", modifiers: 0 }],
    ["missing key code", { type: "key", event: "down", key: "a", modifiers: 0 }],
    ["non-string key text", { type: "key", event: "down", key: "a", code: "KeyA", text: 1, modifiers: 0 }],
    ["empty navigate url", { type: "navigate", url: "" }],
    ["missing navigate url", { type: "navigate" }],
    ["numeric navigate url", { type: "navigate", url: 1 }],
    ["overlong launch url", { type: "launch", url: `https://x/${"a".repeat(2048)}` }],
    ["missing follow targetId", { type: "follow" }],
    ["numeric follow targetId", { type: "follow", targetId: 1 }],
    ["missing close targetId", { type: "close-tab" }],
    ["numeric close targetId", { type: "close-tab", targetId: 1 }],
    ["empty close targetId", { type: "close-tab", targetId: "" }],
    ["blank close targetId", { type: "close-tab", targetId: "  " }],
  ])("returns null for %s", (_label, message) => {
    expect(parseClientMessage(JSON.stringify(message))).toBeNull()
  })

  it("accepts a URL of exactly 2048 characters", () => {
    const url = `https://x/${"a".repeat(2048 - "https://x/".length)}`
    expect(url).toHaveLength(2048)
    expect(parseClientMessage(JSON.stringify({ type: "navigate", url }))).toEqual({ type: "navigate", url })
  })

  it("accepts viewport values at the limits", () => {
    const message = { type: "viewport", width: 8192, height: 8192, dpr: 4 }
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message)
  })
})
