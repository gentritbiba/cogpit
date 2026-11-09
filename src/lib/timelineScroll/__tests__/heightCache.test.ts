import { describe, it, expect } from "vitest"
import { HeightCache, widthBucket } from "../heightCache"

describe("HeightCache", () => {
  it("keys heights by row, width bucket and expand-all", () => {
    const heights = new HeightCache().forSession("s1")
    heights.set("t1", 40, false, 120)
    expect(heights.get("t1", 40, false)).toBe(120)
    expect(heights.get("t1", 41, false)).toBeUndefined()
    expect(heights.get("t1", 40, true)).toBeUndefined()
  })

  it("averages what it has measured for the layout", () => {
    const heights = new HeightCache().forSession("s1")
    expect(heights.average(40, false)).toBeUndefined()
    heights.set("a", 40, false, 100)
    heights.set("b", 40, false, 300)
    heights.set("b", 40, false, 200)
    expect(heights.average(40, false)).toBe(150)
  })

  it("survives a remount of the same session", () => {
    const cache = new HeightCache()
    cache.forSession("s1").set("t1", 40, false, 90)
    expect(cache.forSession("s1").get("t1", 40, false)).toBe(90)
  })

  it("evicts the least recently opened session", () => {
    const cache = new HeightCache(2)
    cache.forSession("a").set("t", 1, false, 1)
    cache.forSession("b").set("t", 1, false, 2)
    cache.forSession("a")
    cache.forSession("c")
    expect(cache.forSession("a").get("t", 1, false)).toBe(1)
    expect(cache.forSession("b").get("t", 1, false)).toBeUndefined()
  })

  it("bounds the rows kept per session", () => {
    const heights = new HeightCache(2, 2).forSession("s")
    heights.set("a", 1, false, 1)
    heights.set("b", 1, false, 2)
    heights.set("c", 1, false, 3)
    expect(heights.get("a", 1, false)).toBeUndefined()
    expect(heights.get("c", 1, false)).toBe(3)
  })
})

describe("widthBucket", () => {
  it("groups widths into 16px buckets", () => {
    expect(widthBucket(800)).toBe(widthBucket(806))
    expect(widthBucket(800)).not.toBe(widthBucket(830))
  })
})
