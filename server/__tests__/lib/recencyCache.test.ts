// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { recencyCache } from "../../lib/recencyCache"

const IN_USE_MS = 1_000

function cacheOf(keys: string[], limits = { capacity: 2, inUseMs: IN_USE_MS, ceiling: 4 }) {
  const cache = recencyCache<string>(limits)
  for (const key of keys) cache.set(key, key.toUpperCase())
  return cache
}

function held(cache: ReturnType<typeof cacheOf>, keys: string[]): string[] {
  return keys.filter((key) => cache.get(key) !== undefined)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("recencyCache", () => {
  it("hands back what was stored", () => {
    const cache = cacheOf(["a"])
    expect(cache.get("a")).toBe("A")
    expect(cache.get("b")).toBeUndefined()
  })

  it("keeps entries still in use past its capacity", () => {
    expect(held(cacheOf(["a", "b", "c"]), ["a", "b", "c"])).toEqual(["a", "b", "c"])
  })

  it("drops the least recently used entries past its capacity once they are out of use", () => {
    const cache = cacheOf(["a", "b", "c"])
    vi.setSystemTime(Date.now() + IN_USE_MS)
    cache.get("a")
    cache.set("d", "D")
    expect(held(cache, ["a", "b", "c", "d"])).toEqual(["a", "d"])
  })

  it("never holds more than its ceiling, however recently used", () => {
    expect(held(cacheOf(["a", "b", "c", "d", "e"]), ["a", "b", "c", "d", "e"])).toEqual(["b", "c", "d", "e"])
  })

  it("replaces an entry stored again under the same key", () => {
    const cache = cacheOf(["a"])
    cache.set("a", "again")
    expect(cache.get("a")).toBe("again")
  })

  it("forgets a deleted entry, and everything once cleared", () => {
    const cache = cacheOf(["a", "b"])
    cache.delete("a")
    expect(held(cache, ["a", "b"])).toEqual(["b"])
    cache.clear()
    expect(held(cache, ["a", "b"])).toEqual([])
  })
})
