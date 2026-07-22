// @vitest-environment node
import { describe, it, expect } from "vitest"
import {
  DEFAULT_TAIL_BYTE_BUDGET,
  parseTailByteBudget,
  trimTailToByteBudget,
} from "../../routes/projects/tailBudget"

function lineOfBytes(byteLength: number, fill = "a"): string {
  // JSON-ish line of exactly `byteLength` bytes (ASCII fill)
  return fill.repeat(byteLength)
}

describe("trimTailToByteBudget", () => {
  it("returns lines untouched when they fit the budget", () => {
    const lines = [lineOfBytes(100), lineOfBytes(100)]
    const result = trimTailToByteBudget(lines, 500, 1024)
    expect(result.lines).toEqual(lines)
    expect(result.byteOffset).toBe(500)
  })

  it("drops oldest lines first and advances byteOffset by exact dropped bytes", () => {
    const lines = [lineOfBytes(300), lineOfBytes(200), lineOfBytes(100)]
    // budget fits the newest two (200+1 + 100+1 = 302), not the oldest
    const result = trimTailToByteBudget(lines, 1000, 400)
    expect(result.lines).toEqual([lines[1], lines[2]])
    // dropped the 300-byte line + its newline
    expect(result.byteOffset).toBe(1000 + 301)
  })

  it("accounts for multibyte UTF-8 content when computing offsets", () => {
    // "é" is 2 bytes in UTF-8, so 100 chars = 200 bytes (+1 newline = 201)
    const multibyte = "é".repeat(100)
    const lines = [multibyte, lineOfBytes(50), lineOfBytes(50)]
    const result = trimTailToByteBudget(lines, 0, 110)
    expect(result.lines).toEqual([lines[1], lines[2]])
    expect(result.byteOffset).toBe(201)
  })

  it("always keeps the newest line even when it alone exceeds the budget", () => {
    const giant = lineOfBytes(900_000)
    const lines = [lineOfBytes(100), giant]
    const result = trimTailToByteBudget(lines, 0, 1024)
    expect(result.lines).toEqual([giant])
    expect(result.byteOffset).toBe(101)
  })

  it("handles an empty line list", () => {
    const result = trimTailToByteBudget([], 42, 1024)
    expect(result.lines).toEqual([])
    expect(result.byteOffset).toBe(42)
  })
})

describe("parseTailByteBudget", () => {
  it("falls back to the default without a param", () => {
    expect(parseTailByteBudget(null)).toBe(DEFAULT_TAIL_BYTE_BUDGET)
  })

  it("falls back to the default on garbage input", () => {
    expect(parseTailByteBudget("abc")).toBe(DEFAULT_TAIL_BYTE_BUDGET)
  })

  it("clamps tiny values up to the minimum", () => {
    expect(parseTailByteBudget("1")).toBe(16 * 1024)
  })

  it("clamps huge values down to the maximum", () => {
    expect(parseTailByteBudget("999999999")).toBe(16 * 1024 * 1024)
  })

  it("passes through sane values", () => {
    expect(parseTailByteBudget(String(512 * 1024))).toBe(512 * 1024)
  })
})
