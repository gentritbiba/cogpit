import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import { headerImageSize, knownImageSize, rememberImageSize } from "../imageSize"
import { ReservedImage } from "../ReservedImage"

function bytes(...parts: Array<string | number[]>): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : part))
}
const u32be = (value: number) => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
const u16le = (value: number) => [value & 255, value >>> 8]
const u16be = (value: number) => [value >>> 8, value & 255]

const png = (width: number, height: number) => bytes([0x89], "PNG\r\n\x1a\n", u32be(13), "IHDR", u32be(width), u32be(height))
const dataUrl = (type: string, data: Uint8Array) => `data:${type};base64,${btoa(String.fromCharCode(...data))}`

describe("image sizes from file headers", () => {
  it("reads PNG, GIF, WebP and JPEG headers", () => {
    expect(headerImageSize(png(1280, 800))).toEqual({ width: 1280, height: 800 })
    expect(headerImageSize(bytes("GIF89a", u16le(64), u16le(32)))).toEqual({ width: 64, height: 32 })
    expect(headerImageSize(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8X", [0, 0, 0, 0, 0, 0, 0, 0], [0xff, 0x01, 0], [0x0f, 0x01, 0]))).toEqual({ width: 512, height: 272 })
    const app0 = [0xff, 0xe0, ...u16be(16), ...new Array(14).fill(0)]
    const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(600), ...u16be(900), 3, ...new Array(9).fill(0)]
    expect(headerImageSize(Uint8Array.from([0xff, 0xd8, ...app0, ...sof0]))).toEqual({ width: 900, height: 600 })
  })

  it("knows nothing about a file it cannot read", () => {
    expect(headerImageSize(bytes("not an image at all"))).toBeNull()
    expect(knownImageSize("/tmp/never-loaded.png")).toBeNull()
  })

  it("reads a data URL's size before it loads, and remembers one learned on load", () => {
    expect(knownImageSize(dataUrl("image/png", png(300, 150)))).toEqual({ width: 300, height: 150 })
    rememberImageSize("/tmp/shot.png", 1600, 900)
    expect(knownImageSize("/tmp/shot.png")).toEqual({ width: 1600, height: 900 })
  })
})

describe("ReservedImage", () => {
  it("holds the exact box of a known size from its first frame", () => {
    const { container } = render(<ReservedImage src={dataUrl("image/png", png(1200, 600))} alt="shot" maxHeightRem={10} />)
    const box = container.querySelector<HTMLElement>("[data-image-box]")!

    // jsdom drops the min() width, so the ratio and the absent placeholder height stand for the box.
    expect(box.style.aspectRatio).toBe("1200 / 600")
    expect(box.style.height).toBe("")
  })

  it("holds a placeholder box until an image of unknown size loads", () => {
    const { container } = render(<ReservedImage src="/api/local-file?path=/tmp/unknown.png" alt="shot" maxHeightRem={24} />)
    const box = container.querySelector<HTMLElement>("[data-image-box]")!

    expect(box.style.height).toBe("24rem")
    expect(box.style.width).toBe("32rem")
  })
})
