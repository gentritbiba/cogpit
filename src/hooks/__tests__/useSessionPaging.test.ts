import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { Turn } from "../../../shared/session/types"
import { emptyTurn } from "@/__tests__/fixtures"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("@/lib/sessionCache", () => ({
  sessionCache: { get: vi.fn(), update: vi.fn() },
}))

import { useSessionPaging } from "../useSessionPaging"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import { type SessionView } from "../../../shared/session/sessionDigest"

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

const olderTurns = [{ id: "old-1", userMessage: "old", contentBlocks: [], toolCalls: [] }] as unknown as Turn[]
const parsed = { turns: olderTurns } as unknown as SessionView

function cachedEntry(overrides: Record<string, unknown> = {}) {
  return {
    parsed,
    hasMore: true,
    nextByteOffset: 500,
    olderTurns: [],
    source: { dirName: "-dir", fileName: "sess.jsonl", watchOffset: 0, loadId: 1 },
    lastAccessed: 0,
    ...overrides,
  } as ReturnType<typeof sessionCache.get>
}

function setup(props: Partial<Parameters<typeof useSessionPaging>[0]> = {}) {
  const onOlderTurns = vi.fn()
  const workerParse = vi.fn(async () => parsed)
  const initial = {
    dirName: "-dir" as string | null,
    fileName: "sess.jsonl" as string | null,
    sessionChangeKey: 1,
    workerParse,
    onOlderTurns,
    ...props,
  }
  const hook = renderHook((p) => useSessionPaging(p), { initialProps: initial })
  return { ...hook, onOlderTurns, workerParse, initial }
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
    const { result, onOlderTurns, workerParse } = setup()

    let added = 0
    await act(async () => {
      added = await result.current.loadMore()
    })

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/sessions/-dir/sess.jsonl?before=500&count=30&unit=turns&projection=results-v1")
    expect(workerParse).toHaveBeenCalledWith('{"h":1}\n{"l":1}\n{"l":2}')
    expect(onOlderTurns).toHaveBeenCalledWith(olderTurns)
    expect(added).toBe(1)
    expect(mockUpdate).toHaveBeenCalledWith("-dir", "sess.jsonl", 1, {
      hasMore: true,
      nextByteOffset: 100,
      olderTurns,
    })
    expect(result.current.hasMore).toBe(true)
    expect(result.current.isLoadingOlder).toBe(false)
  })

  it("parses a turn page as sent, header records and all", async () => {
    mockAuthFetch.mockResolvedValue(beforeResponse({ unit: "turns", lines: ['{"h":1}', '{"l":1}'] }))
    const { result, workerParse } = setup()

    await act(async () => {
      await result.current.loadMore()
    })

    expect(workerParse).toHaveBeenCalledWith('{"h":1}\n{"h":1}\n{"l":1}')
  })

  describe("stitching across the page boundary", () => {
    // A compaction opens a turn without a prompt; between whole turns it is
    // a turn of its own, but at a cut it is the tail half of the turn before.
    const compactionTurn = emptyTurn({ id: "compaction", userMessage: null, compactionSummary: "summary" })
    const olderWhole = emptyTurn({ id: "older", userMessage: "older prompt" })

    async function pageTwice(firstPage: Record<string, unknown>, secondPage: Record<string, unknown>) {
      const { result, onOlderTurns, workerParse } = setup()
      workerParse.mockResolvedValue({ turns: [olderWhole] } as unknown as SessionView)
      mockAuthFetch.mockResolvedValueOnce(beforeResponse(firstPage))
      mockGet.mockReturnValue(cachedEntry({ olderTurns: [] }))
      await act(async () => { await result.current.loadMore() })

      mockAuthFetch.mockResolvedValueOnce(beforeResponse(secondPage))
      mockGet.mockReturnValue(cachedEntry({ olderTurns: [compactionTurn] }))
      await act(async () => { await result.current.loadMore() })
      return onOlderTurns.mock.calls.at(-1)![0] as Turn[]
    }

    it("keeps a promptless head as its own turn after a whole-turn page", async () => {
      const history = await pageTwice({ unit: "turns" }, { unit: "turns" })
      expect(history.map((turn) => turn.id)).toEqual(["older", "compaction"])
    })

    it("stitches onto the head a cut-turn page left behind", async () => {
      const history = await pageTwice({ unit: "turns", cutTurn: true }, { unit: "turns" })
      expect(history.map((turn) => turn.id)).toEqual(["compaction"])
      expect(history[0].userMessage).toBe("older prompt")
    })

    it("stitches after a line page from an older server", async () => {
      const history = await pageTwice({}, {})
      expect(history.map((turn) => turn.id)).toEqual(["compaction"])
    })

    it("stitches the first page onto a tail that may have cut a turn", async () => {
      const { result, onOlderTurns, workerParse } = setup()
      workerParse.mockResolvedValue({ turns: [olderWhole] } as unknown as SessionView)
      mockAuthFetch.mockResolvedValueOnce(beforeResponse({ unit: "turns" }))
      mockGet.mockReturnValue(cachedEntry({ olderTurns: [compactionTurn] }))
      await act(async () => { await result.current.loadMore() })
      expect((onOlderTurns.mock.calls.at(-1)![0] as Turn[]).map((turn) => turn.id)).toEqual(["compaction"])
    })
  })

  describe("line pages from an older server", () => {
    const prompt = JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "first prompt" } })

    it("puts only the lines before the first turn in front of a page below a gap", async () => {
      mockAuthFetch.mockResolvedValue(beforeResponse({ headerLines: ['{"h":1}', prompt], hasMore: true }))
      const { result, workerParse } = setup()

      await act(async () => {
        await result.current.loadMore()
      })

      expect(workerParse).toHaveBeenCalledWith('{"h":1}\n{"l":1}\n{"l":2}')
    })

    it("joins the whole header to a page that reaches the head, without the lines it repeats", async () => {
      mockAuthFetch.mockResolvedValue(beforeResponse({
        headerLines: ['{"h":1}', prompt],
        lines: ['{"h":1}', prompt, '{"l":1}'],
        hasMore: false,
      }))
      const { result, workerParse } = setup()

      await act(async () => {
        await result.current.loadMore()
      })

      expect(workerParse).toHaveBeenCalledWith(['{"h":1}', prompt, '{"l":1}'].join("\n"))
    })
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
    const { result, onOlderTurns } = setup()

    await act(async () => {
      expect(await result.current.loadMore()).toBe(0)
    })

    expect(onOlderTurns).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledWith("-dir", "sess.jsonl", 1, {
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

  it("shows history a page banked while another session was open", async () => {
    // A → B → A: the page in flight for A lands after the switch, reaches the
    // head of the transcript and is banked but never shown.
    let resolvePage!: (res: Response) => void
    mockAuthFetch.mockReturnValue(new Promise<Response>((resolve) => { resolvePage = resolve }))
    const { result, rerender, initial, onOlderTurns } = setup()
    let inFlight!: Promise<number>
    act(() => { inFlight = result.current.loadMore() })

    rerender({ ...initial, fileName: "other.jsonl", sessionChangeKey: 2 })
    rerender({ ...initial, sessionChangeKey: 3 })
    await act(async () => {
      resolvePage(beforeResponse({ hasMore: false }))
      await inFlight
    })
    expect(onOlderTurns).not.toHaveBeenCalledWith(olderTurns)

    mockGet.mockReturnValue(cachedEntry({ hasMore: false, olderTurns }))
    await act(async () => { await result.current.loadMore() })
    expect(onOlderTurns).toHaveBeenLastCalledWith(olderTurns)
    expect(result.current.hasMore).toBe(false)
  })

  it("ignores failed responses", async () => {
    mockAuthFetch.mockResolvedValue(new Response("nope", { status: 500 }))
    const { result, onOlderTurns } = setup()

    await act(async () => {
      expect(await result.current.loadMore()).toBe(0)
    })
    expect(onOlderTurns).not.toHaveBeenCalled()
    expect(result.current.isLoadingOlder).toBe(false)
  })

  // Review finding 5: a failing page was asked for again on every commit, in a tight loop.
  it("waits before asking again for a page that failed, longer after each failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      mockAuthFetch.mockImplementation(async () => new Response("nope", { status: 503 }))
      const { result } = setup()
      const load = () => act(async () => { await result.current.loadMore() })

      await load()
      await load()
      expect(mockAuthFetch).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1_000)
      await load()
      expect(mockAuthFetch).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1_000)
      await load()
      expect(mockAuthFetch).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1_000)
      mockAuthFetch.mockResolvedValue(beforeResponse())
      await load()
      expect(mockAuthFetch).toHaveBeenCalledTimes(3)
      // A page that arrives ends the wait.
      await load()
      expect(mockAuthFetch).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it("resolves with nothing, never rejects, when the request itself fails", async () => {
    mockAuthFetch.mockRejectedValue(new TypeError("Failed to fetch"))
    const { result, onOlderTurns } = setup()
    await act(async () => {
      await expect(result.current.loadMore()).resolves.toBe(0)
    })
    expect(onOlderTurns).not.toHaveBeenCalled()
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
    const { result, rerender, onOlderTurns, initial } = setup()

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

    expect(onOlderTurns).not.toHaveBeenCalled()
    // The stale page is still banked on the old session's entry, cursor and
    // turns together, so reopening it picks up where this left off.
    expect(mockUpdate).toHaveBeenCalledWith("-dir", "sess.jsonl", 1, {
      hasMore: true,
      nextByteOffset: 100,
      olderTurns,
    })
  })

  it("drops a page that resolves after the session reloads in place", async () => {
    let release: (r: Response) => void = () => {}
    mockAuthFetch.mockImplementation(
      () => new Promise<Response>((resolve) => { release = resolve }),
    )
    const { result, rerender, onOlderTurns, initial } = setup()

    let pending: Promise<number>
    act(() => {
      pending = result.current.loadMore()
    })

    rerender({ ...initial, sessionChangeKey: 2 })

    await act(async () => {
      release(beforeResponse())
      expect(await pending).toBe(0)
    })

    expect(onOlderTurns).not.toHaveBeenCalled()
  })

  it("resyncs hasMore from the cache when the session reloads in place", () => {
    const { result, rerender, initial } = setup()
    expect(result.current.hasMore).toBe(true)

    mockGet.mockReturnValue(cachedEntry({ hasMore: false }))
    rerender({ ...initial, sessionChangeKey: 2 })
    expect(result.current.hasMore).toBe(false)
  })

  it("restores history the cache already paged in", () => {
    mockGet.mockReturnValue(cachedEntry({ olderTurns, nextByteOffset: 100 }))
    const { onOlderTurns } = setup()
    expect(onOlderTurns).toHaveBeenCalledWith(olderTurns)
  })

  it("accumulates each page onto the history already banked", async () => {
    const previous = [{ id: "old-0", userMessage: "older", contentBlocks: [], toolCalls: [] }] as unknown as Turn[]
    mockGet.mockReturnValue(cachedEntry({ olderTurns: previous }))
    mockAuthFetch.mockResolvedValue(beforeResponse())
    const { result, onOlderTurns } = setup()

    await act(async () => {
      await result.current.loadMore()
    })

    // The new (older) page lands in front of what was already loaded.
    expect(onOlderTurns).toHaveBeenLastCalledWith([...olderTurns, ...previous])
    expect(mockUpdate).toHaveBeenCalledWith("-dir", "sess.jsonl", 1, {
      hasMore: true,
      nextByteOffset: 100,
      olderTurns: [...olderTurns, ...previous],
    })
  })
})


it("keeps older history available when parsing the final page fails", async () => {
  mockAuthFetch.mockResolvedValue(beforeResponse({ hasMore: false }))
  const { result, workerParse } = setup()
  workerParse.mockRejectedValueOnce(new Error("worker unavailable"))
  await act(async () => { await result.current.loadMore() })
  expect(result.current.hasMore).toBe(true)
})
