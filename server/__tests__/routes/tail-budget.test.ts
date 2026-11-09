// @vitest-environment node
import { describe, it, expect } from "vitest"
import {
  DEFAULT_PAGE_BYTE_BUDGET,
  DEFAULT_TAIL_BYTE_BUDGET,
  oldestKeptLine,
  parseByteBudget,
} from "../../routes/projects/tailBudget"

function lineOfBytes(byteLength: number, fill = "a"): string {
  // JSON-ish line of exactly `byteLength` bytes (ASCII fill)
  return fill.repeat(byteLength)
}

describe("oldestKeptLine", () => {
  it("keeps every line when they fit the budget", () => {
    const lines = [lineOfBytes(100), lineOfBytes(100)]
    expect(oldestKeptLine(lines, 1024)).toBe(0)
  })

  it("drops oldest lines first", () => {
    const lines = [lineOfBytes(300), lineOfBytes(200), lineOfBytes(100)]
    // budget fits the newest two (200+1 + 100+1 = 302), not the oldest
    expect(oldestKeptLine(lines, 400)).toBe(1)
  })

  it("counts multibyte UTF-8 content in bytes", () => {
    // "é" is 2 bytes in UTF-8, so 100 chars = 200 bytes (+1 newline = 201)
    const lines = ["é".repeat(100), lineOfBytes(50), lineOfBytes(50)]
    expect(oldestKeptLine(lines, 110)).toBe(1)
    expect(oldestKeptLine(lines, 303)).toBe(0)
  })

  it("always keeps the newest line even when it alone exceeds the budget", () => {
    const lines = [lineOfBytes(100), lineOfBytes(900_000)]
    expect(oldestKeptLine(lines, 1024)).toBe(1)
  })

  it("keeps nothing of an empty line list", () => {
    expect(oldestKeptLine([], 1024)).toBe(0)
  })

  it("keeps at least minLines lines even when over the byte budget", () => {
    const lines = Array.from({ length: 50 }, () => lineOfBytes(1024))
    expect(oldestKeptLine(lines, 2048, 30)).toBe(20)
  })

  it("lets the budget keep more lines than the floor", () => {
    const lines = Array.from({ length: 50 }, () => lineOfBytes(1024))
    // 40KB fits 39 lines of 1025 bytes — more than the 30-line floor
    expect(oldestKeptLine(lines, 40 * 1024, 30)).toBe(11)
  })

  it("skips noise lines without letting them spend the budget or the floor", () => {
    const isNoise = (line: string) => line.startsWith("n")
    const lines = [lineOfBytes(100), lineOfBytes(500, "n"), lineOfBytes(100), lineOfBytes(500, "n"), lineOfBytes(100)]
    expect(oldestKeptLine(lines, 250, 2, isNoise)).toBe(2)
  })

  it("keeps nothing of a page that is all noise", () => {
    const lines = [lineOfBytes(10, "n"), lineOfBytes(20, "n")]
    expect(oldestKeptLine(lines, 1024, 30, (line) => line.startsWith("n"))).toBe(2)
  })

  it("keeps everything when the floor exceeds the line count", () => {
    const lines = [lineOfBytes(100), lineOfBytes(900_000)]
    expect(oldestKeptLine(lines, 1024, 30)).toBe(0)
  })

  it("measures lines as sizeOf counts them, such as projected", () => {
    const lines = [lineOfBytes(900_000), lineOfBytes(900_000), lineOfBytes(900_000)]
    expect(oldestKeptLine(lines, 1024, 1, undefined, () => 300)).toBe(0)
    expect(oldestKeptLine(lines, 1024, 1, undefined, (_, index) => (index === 0 ? 900 : 300))).toBe(1)
  })
})

describe("parseByteBudget", () => {
  it("falls back to the given default without a param", () => {
    expect(parseByteBudget(null, DEFAULT_TAIL_BYTE_BUDGET)).toBe(DEFAULT_TAIL_BYTE_BUDGET)
    expect(parseByteBudget(null, DEFAULT_PAGE_BYTE_BUDGET)).toBe(DEFAULT_PAGE_BYTE_BUDGET)
  })

  it("falls back to the default on garbage input", () => {
    expect(parseByteBudget("abc", DEFAULT_TAIL_BYTE_BUDGET)).toBe(DEFAULT_TAIL_BYTE_BUDGET)
  })

  it("clamps tiny values up to the minimum", () => {
    expect(parseByteBudget("1", DEFAULT_TAIL_BYTE_BUDGET)).toBe(16 * 1024)
  })

  it("clamps huge values down to the maximum", () => {
    expect(parseByteBudget("999999999", DEFAULT_TAIL_BYTE_BUDGET)).toBe(16 * 1024 * 1024)
  })

  it("passes through sane values", () => {
    expect(parseByteBudget(String(512 * 1024), DEFAULT_TAIL_BYTE_BUDGET)).toBe(512 * 1024)
  })
})
