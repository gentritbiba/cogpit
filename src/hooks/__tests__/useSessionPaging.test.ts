import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ParsedSession, Turn } from "@/lib/types"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("@/lib/sessionCache", () => ({
  sessionCache: { get: vi.fn(), update: vi.fn() },
}))

import { useSessionPaging } from "../useSessionPaging"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"

const mockAuthFetch = vi.mocked(authFetch)
const mockGet = vi.mocked(sessionCache.get)
const mockUpdate = vi.mocked(sessionCache.update)

function beforeResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      headerLines: ['{"h":1}'],
      lines: ['{"l":1}', '{"l":2}'],
      byteOffset: 100,
      hasMore: true,
      ...overrides,
    }),
    { status: 200 },
  )
}

const olderTurns = [{ id: "old-1" }] as unknown as Turn[]
const parsed = { turns: olderTurns } as unknown as ParsedSession

function cachedEntry(overrides: Record<string, unknown> = {}) {
  return { hasMore: true, nextByteOffset: 500, ...overrides } as ReturnType<typeof sessionCache.get>
}

function setup(props: Partial<Parameters<typeof useSessionPaging>[0]> = {}) {
  const onPrependTurns = vi.fn()
  const workerParse = vi.fn(async () => parsed)
  const initial = {
    dirName: "-dir" as string | null,
    fileName: "sess.jsonl" as string | null,
    sessionChangeKey: 1,
    workerParse,
    onPrependTurns,
    ...props,
  }
  const hook = renderHook((p) => useSessionPaging(p), { initialProps: initial })
  return { ...hook, onPrependTurns, workerParse, initial }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockReturnValue(cachedEntry())
})

describe("useSessionPaging", () => {
  it("syncs hasMore from the cache on mount", () => {
    const { result } = setup()
    expect(result.current.hasMore).toBe(true)
    expect(result.current.isLoadingOlder).toBe(false)
  })

  it("reports no more content without a session", () => {
    const { result } = setup({ dirName: null, fileName: null })
    expect(result.current.hasMore).toBe(false)
  })

  it("loads an older page and prepends parsed turns", async () => {
    mockAuthFetch.mockResolvedValue(beforeResponse())
    const { result, onPrependTurns, workerParse } = setup()

    let added = 0
    await act(async () => {
      added = await result.current.loadMore()
    })

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/sessions/-dir/sess.jsonl?before=500&count=30")
    expect(workerParse).toHaveBeenCalledWith('{"h":1}\n{"l":1}\n{"l":2}')
    expect(onPrependTurns).toHaveBeenCalledWith(olderTurns)
    expect(added).toBe(1)
    expect(mockUpdate).toHaveBeenCalledWith("-dir", "sess.jsonl", {
      hasMore: true,
      nextByteOffset: 100,
    })
    expect(result.current.hasMore).toBe(true)
    expect(result.current.isLoadingOlder).toBe(false)
  })

  it("does not parse page records that overlap the header", async () => {
    mockAuthFetch.mockResolvedValue(beforeResponse({
      lines: ['{"h":1}', '{"l":1}', '{"l":2}'],
    }))
    const { result, workerParse } = setup()

    await act(async () => {
      await result.current.loadMore()
    })

    expect(workerParse).toHaveBeenCalledWith('{"h":1}\n{"l":1}\n{"l":2}')
  })

  it("flips hasMore off when the server reports the end", async () => {
    mockAuthFetch.mockResolvedValue(beforeResponse({ hasMore: false }))
    const { result } = setup()

    await act(async () => {
      await result.current.loadMore()
    })

    expect(result.current.hasMore).toBe(false)
  })

  it("treats an empty page as exhausted and does not prepend", async () => {
    mockAuthFetch.mockResolvedValue(beforeResponse({ lines: [], hasMore: true }))
    const { result, onPrependTurns } = setup()

    await act(async () => {
      expect(await result.current.loadMore()).toBe(0)
    })

    expect(onPrependTurns).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledWith("-dir", "sess.jsonl", {
      hasMore: false,
      nextByteOffset: 100,
    })
    expect(result.current.hasMore).toBe(false)
  })

  it("is a no-op when the cache has no more content", async () => {
    mockGet.mockReturnValue(cachedEntry({ hasMore: false }))
    const { result } = setup()

    await act(async () => {
      expect(await result.current.loadMore()).toBe(0)
    })
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("ignores failed responses", async () => {
    mockAuthFetch.mockResolvedValue(new Response("nope", { status: 500 }))
    const { result, onPrependTurns } = setup()

    await act(async () => {
      expect(await result.current.loadMore()).toBe(0)
    })
    expect(onPrependTurns).not.toHaveBeenCalled()
    expect(result.current.isLoadingOlder).toBe(false)
  })

  it("only runs one load at a time", async () => {
    let release: (r: Response) => void = () => {}
    mockAuthFetch.mockImplementation(
      () => new Promise<Response>((resolve) => { release = resolve }),
    )
    const { result } = setup()

    let first: Promise<number>
    let second = 0
    await act(async () => {
      first = result.current.loadMore()
      second = await result.current.loadMore()
    })
    expect(second).toBe(0)
    expect(mockAuthFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      release(beforeResponse())
      await first
    })
    expect(result.current.isLoadingOlder).toBe(false)
  })

  it("drops a page that resolves after the session switched", async () => {
    let release: (r: Response) => void = () => {}
    mockAuthFetch.mockImplementation(
      () => new Promise<Response>((resolve) => { release = resolve }),
    )
    const { result, rerender, onPrependTurns, initial } = setup()

    let pending: Promise<number>
    act(() => {
      pending = result.current.loadMore()
    })

    // Switch sessions while the fetch is in flight.
    rerender({ ...initial, dirName: "-other", fileName: "other.jsonl", sessionChangeKey: 2 })

    await act(async () => {
      release(beforeResponse())
      expect(await pending).toBe(0)
    })

    expect(onPrependTurns).not.toHaveBeenCalled()
    // The stale page still updates the old session's cache entry (correct data).
    expect(mockUpdate).toHaveBeenCalledWith("-dir", "sess.jsonl", {
      hasMore: true,
      nextByteOffset: 100,
    })
  })

  it("drops a page that resolves after the session reloads in place", async () => {
    let release: (r: Response) => void = () => {}
    mockAuthFetch.mockImplementation(
      () => new Promise<Response>((resolve) => { release = resolve }),
    )
    const { result, rerender, onPrependTurns, initial } = setup()

    let pending: Promise<number>
    act(() => {
      pending = result.current.loadMore()
    })

    rerender({ ...initial, sessionChangeKey: 2 })

    await act(async () => {
      release(beforeResponse())
      expect(await pending).toBe(0)
    })

    expect(onPrependTurns).not.toHaveBeenCalled()
  })

  it("resyncs hasMore from the cache when the session reloads in place", () => {
    const { result, rerender, initial } = setup()
    expect(result.current.hasMore).toBe(true)

    mockGet.mockReturnValue(cachedEntry({ hasMore: false }))
    rerender({ ...initial, sessionChangeKey: 2 })
    expect(result.current.hasMore).toBe(false)
  })
})
