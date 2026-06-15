// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

// We use dynamic imports after vi.useFakeTimers so Date.now is mocked
// per test. Module is re-loaded each time via vi.resetModules.

describe("sessionMetaCache", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function loadModule() {
    const mod = await import("../../lib/sessionMetaCache")
    return mod
  }

  function makeCachedMeta(overrides?: Partial<Parameters<Awaited<ReturnType<typeof loadModule>>["setCachedSessionMeta"]>[1]>) {
    return {
      meta: {
        sessionId: "abc",
        version: "",
        gitBranch: "",
        model: "",
        slug: "",
        name: "",
        cwd: "/test",
        firstUserMessage: "hello",
        lastUserMessage: "world",
        timestamp: "",
        lastTimestamp: "",
        turnCount: 1,
        lineCount: 10,
        branchedFrom: undefined,
        isSubagent: false,
        parentSessionId: null,
      },
      status: { status: "idle" as const },
      mtimeMs: 1000,
      cachedAt: Date.now(),
      ...overrides,
    }
  }

  it("returns null on cache miss", async () => {
    const { getCachedSessionMeta } = await loadModule()
    const result = getCachedSessionMeta("/some/file.jsonl", 1000)
    expect(result).toBeNull()
  })

  it("returns cached value on hit when mtime matches", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta } = await loadModule()
    const value = makeCachedMeta()
    setCachedSessionMeta("/test/file.jsonl", value)
    const result = getCachedSessionMeta("/test/file.jsonl", 1000)
    expect(result).not.toBeNull()
    expect(result?.meta.sessionId).toBe("abc")
    expect(result?.status.status).toBe("idle")
  })

  it("returns null when mtime does not match (auto-invalidation)", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta } = await loadModule()
    const value = makeCachedMeta({ mtimeMs: 1000 })
    setCachedSessionMeta("/test/file.jsonl", value)
    // Ask with a different mtime — the file was modified
    const result = getCachedSessionMeta("/test/file.jsonl", 2000)
    expect(result).toBeNull()
  })

  it("returns null after TTL expiry", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta, SESSION_META_TTL_MS } = await loadModule()
    const value = makeCachedMeta({ cachedAt: Date.now() })
    setCachedSessionMeta("/test/file.jsonl", value)

    // Advance time past TTL
    vi.advanceTimersByTime(SESSION_META_TTL_MS + 1000)

    const result = getCachedSessionMeta("/test/file.jsonl", 1000)
    expect(result).toBeNull()
  })

  it("returns cached value within TTL window", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta, SESSION_META_TTL_MS } = await loadModule()
    const value = makeCachedMeta({ cachedAt: Date.now() })
    setCachedSessionMeta("/test/file.jsonl", value)

    // Advance time but stay within TTL
    vi.advanceTimersByTime(SESSION_META_TTL_MS - 1000)

    const result = getCachedSessionMeta("/test/file.jsonl", 1000)
    expect(result).not.toBeNull()
  })

  it("survives a 10s dashboard-poll interval (regression: TTL used to be 8s)", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta } = await loadModule()
    setCachedSessionMeta("/test/file.jsonl", makeCachedMeta({ cachedAt: Date.now() }))

    vi.advanceTimersByTime(10_000)

    expect(getCachedSessionMeta("/test/file.jsonl", 1000)).not.toBeNull()
  })

  it("evicts the oldest entry once the cache exceeds 1000 entries", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta } = await loadModule()
    setCachedSessionMeta("/test/oldest.jsonl", makeCachedMeta({ cachedAt: Date.now() }))
    vi.advanceTimersByTime(10)
    for (let i = 0; i < 1000; i++) {
      setCachedSessionMeta(`/test/file-${i}.jsonl`, makeCachedMeta({ cachedAt: Date.now() }))
    }

    expect(getCachedSessionMeta("/test/oldest.jsonl", 1000)).toBeNull()
    expect(getCachedSessionMeta("/test/file-999.jsonl", 1000)).not.toBeNull()
  })

  it("explicit invalidation removes entry", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta, invalidateSessionMeta } = await loadModule()
    const value = makeCachedMeta()
    setCachedSessionMeta("/test/file.jsonl", value)

    invalidateSessionMeta("/test/file.jsonl")

    const result = getCachedSessionMeta("/test/file.jsonl", 1000)
    expect(result).toBeNull()
  })

  it("invalidateAll removes all entries", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta, invalidateAll } = await loadModule()
    setCachedSessionMeta("/test/a.jsonl", makeCachedMeta({ mtimeMs: 1 }))
    setCachedSessionMeta("/test/b.jsonl", makeCachedMeta({ mtimeMs: 2 }))

    invalidateAll()

    expect(getCachedSessionMeta("/test/a.jsonl", 1)).toBeNull()
    expect(getCachedSessionMeta("/test/b.jsonl", 2)).toBeNull()
  })

  it("invalidateSessionMeta is a no-op for unknown path", async () => {
    const { invalidateSessionMeta } = await loadModule()
    // Should not throw
    expect(() => invalidateSessionMeta("/nonexistent.jsonl")).not.toThrow()
  })

  it("setCachedSessionMeta overwrites an existing entry", async () => {
    const { getCachedSessionMeta, setCachedSessionMeta } = await loadModule()
    setCachedSessionMeta("/test/file.jsonl", makeCachedMeta({ mtimeMs: 1000 }))
    const updated = makeCachedMeta({ mtimeMs: 2000, cachedAt: Date.now() })
    updated.meta.sessionId = "xyz"
    setCachedSessionMeta("/test/file.jsonl", updated)
    const result = getCachedSessionMeta("/test/file.jsonl", 2000)
    expect(result?.meta.sessionId).toBe("xyz")
  })
})
