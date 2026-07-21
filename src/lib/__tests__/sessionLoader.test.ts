import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ParsedSession } from "@/lib/types"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("@/lib/sessionCache", () => ({
  sessionCache: { get: vi.fn(() => undefined), set: vi.fn(), evict: vi.fn() },
}))
vi.mock("@/lib/device", () => ({ getActiveDeviceId: vi.fn(() => "local") }))

import {
  fetchTailAndParse,
  loadSessionTailCached,
  loadSessionTailFresh,
} from "@/lib/sessionLoader"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import { getActiveDeviceId } from "@/lib/device"

const mockAuthFetch = vi.mocked(authFetch)
const mockGet = vi.mocked(sessionCache.get)
const mockSet = vi.mocked(sessionCache.set)
const mockEvict = vi.mocked(sessionCache.evict)
const mockDeviceId = vi.mocked(getActiveDeviceId)

function tailResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      headerLines: ['{"h":1}'],
      tailLines: ['{"t":1}'],
      byteOffset: 100,
      totalSize: 200,
      hasMore: true,
      ...overrides,
    }),
    { status: 200 },
  )
}

const parsed = { turns: [] } as unknown as ParsedSession

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockReturnValue(undefined)
  mockDeviceId.mockReturnValue("local")
})

describe("fetchTailAndParse", () => {
  it("requests the tail endpoint and returns source with watchOffset=totalSize", async () => {
    mockAuthFetch.mockResolvedValue(tailResponse())
    const workerParse = vi.fn(async () => parsed)

    const result = await fetchTailAndParse("-dir", "sess.jsonl", workerParse, "session")

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/sessions/-dir/sess.jsonl?tail=30")
    expect(workerParse).toHaveBeenCalledWith('{"h":1}\n{"t":1}')
    // Critical for live updates: the SSE watcher must resume at the end of the
    // file, not at the byte length of the (much smaller) tail text.
    expect(result.source.watchOffset).toBe(200)
    expect(result.byteOffset).toBe(100)
    expect(result.hasMore).toBe(true)
  })

  it("dedupes header lines that also appear in the tail (small files)", async () => {
    mockAuthFetch.mockResolvedValue(
      tailResponse({ headerLines: ['{"h":1}'], tailLines: ['{"h":1}', '{"t":1}'] }),
    )
    const workerParse = vi.fn(async () => parsed)

    await fetchTailAndParse("-dir", "sess.jsonl", workerParse, "session")

    expect(workerParse).toHaveBeenCalledWith('{"h":1}\n{"t":1}')
  })

  it("throws with the error label on a failed response", async () => {
    mockAuthFetch.mockResolvedValue(new Response("nope", { status: 404 }))

    await expect(
      fetchTailAndParse("-dir", "sess.jsonl", vi.fn(), "session"),
    ).rejects.toThrow("Failed to load session (404)")
  })
})

describe("loadSessionTailCached", () => {
  it("returns the cached entry without fetching", async () => {
    const cachedEntry = {
      parsed,
      source: { dirName: "-dir", fileName: "sess.jsonl", rawText: "x", watchOffset: 50 },
      nextByteOffset: 10,
      hasMore: false,
      lastAccessed: 0,
    }
    mockGet.mockReturnValue(cachedEntry)

    const result = await loadSessionTailCached("-dir", "sess.jsonl", vi.fn(), "session")

    expect(result.parsed).toBe(parsed)
    expect(result.source).toBe(cachedEntry.source)
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("does not clobber a cache entry that appeared mid-flight", async () => {
    mockAuthFetch.mockResolvedValue(tailResponse())
    const workerParse = vi.fn(async () => parsed)

    // While our fetch was in flight, another load (e.g. the click racing a
    // hover-prefetch) populated the cache — and a live SSE watcher may have
    // advanced its watchOffset past our snapshot. The existing entry must win.
    const racedEntry = {
      parsed: { turns: [{}] } as unknown as ParsedSession,
      source: { dirName: "-dir", fileName: "sess.jsonl", rawText: "live", watchOffset: 999 },
      nextByteOffset: 50,
      hasMore: true,
      lastAccessed: 0,
    }
    mockGet
      .mockReturnValueOnce(undefined) // pre-fetch check → miss
      .mockReturnValueOnce(racedEntry) // post-fetch re-check → hit

    const result = await loadSessionTailCached("-dir", "sess.jsonl", workerParse, "session")

    expect(result.parsed).toBe(racedEntry.parsed)
    expect(result.source).toBe(racedEntry.source)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it("fetches, caches, and returns on a cache miss", async () => {
    mockAuthFetch.mockResolvedValue(tailResponse())
    const workerParse = vi.fn(async () => parsed)

    const result = await loadSessionTailCached("-dir", "sess.jsonl", workerParse, "session")

    expect(result.parsed).toBe(parsed)
    expect(mockSet).toHaveBeenCalledOnce()
    const setArgs = mockSet.mock.calls[0]
    expect(setArgs[0]).toBe("-dir")
    expect(setArgs[1]).toBe("sess.jsonl")
    expect(setArgs[4]).toBe(100) // nextByteOffset
    expect(setArgs[5]).toBe(true) // hasMore
    expect(setArgs[7]).toBe(200) // watchOffset
  })
})

describe("loadSessionTailFresh", () => {
  it("evicts the cache entry before fetching so stale turns never survive reload", async () => {
    mockAuthFetch.mockResolvedValue(tailResponse())
    const workerParse = vi.fn(async () => parsed)

    await loadSessionTailFresh("-dir", "sess.jsonl", workerParse, "session")

    expect(mockEvict).toHaveBeenCalledWith("-dir", "sess.jsonl")
    expect(mockEvict.mock.invocationCallOrder[0]).toBeLessThan(
      mockAuthFetch.mock.invocationCallOrder[0],
    )
    expect(mockSet).toHaveBeenCalledOnce()
  })

  it("does not write the cache when the device changes mid-flight", async () => {
    mockAuthFetch.mockResolvedValue(tailResponse())
    const workerParse = vi.fn(async () => parsed)

    // getActiveDeviceId call order: (1) snapshot before fetch, (2) guard after
    // parse. Simulate a device switch between the two.
    mockDeviceId
      .mockReturnValueOnce("device-a") // snapshot
      .mockReturnValueOnce("device-b") // guard (switched!)

    const result = await loadSessionTailFresh("-dir", "sess.jsonl", workerParse, "session")

    // Still returns the fetched data for the caller to render…
    expect(result.parsed).toBe(parsed)
    // …but must NOT poison the other device's cache.
    expect(mockSet).not.toHaveBeenCalled()
  })
})
