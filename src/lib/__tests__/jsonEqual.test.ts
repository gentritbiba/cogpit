import { describe, expect, it } from "vitest"
import { jsonEqual } from "../jsonEqual"

describe("jsonEqual", () => {
  it("compares parsed JSON by value", () => {
    expect(jsonEqual({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true)
    expect(jsonEqual([1, 2], [1, 2])).toBe(true)
    expect(jsonEqual("x", "x")).toBe(true)
  })

  it("tells apart values that differ anywhere", () => {
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false)
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(jsonEqual([], {})).toBe(false)
    expect(jsonEqual(null, {})).toBe(false)
    expect(jsonEqual({ a: [{ b: 1 }] }, { a: [{ b: 2 }] })).toBe(false)
  })
})
