import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
import { authFetch } from "@/lib/auth"
import { publishListsStale } from "@/lib/sessionAccess"
import { useSessionContentSearch } from "../useSessionContentSearch"

const filter = { key: null, query: {} }
const body = { query: "search", results: [], semantic: { state: "off" }, indexing: { pendingFiles: 0, pendingEmbeddings: 0 } }
const response = (data = body, status = 200) => new Response(JSON.stringify(data), { status })
const fetch = vi.mocked(authFetch)
const advance = async (ms = 250) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); fetch.mockResolvedValue(response()) })
afterEach(() => vi.useRealTimers())

describe("useSessionContentSearch", () => {
  it("waits for two trimmed characters and debounces typing", async () => {
    const { result, rerender } = renderHook(({ query }) => useSessionContentSearch(query, filter), { initialProps: { query: " a " } })
    await advance(300)
    expect(fetch).not.toHaveBeenCalled()
    expect(result.current.response).toBeNull()
    rerender({ query: "first" })
    await advance(200)
    rerender({ query: "second" })
    await advance(249)
    expect(fetch).not.toHaveBeenCalled()
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).toContain("q=second")
  })

  it("aborts old requests and ignores responses that arrive after cancellation", async () => {
    let resolve!: (response: Response) => void
    fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const { result, rerender, unmount } = renderHook(({ query }) => useSessionContentSearch(query, filter), { initialProps: { query: "first" } })
    await advance()
    const signal = fetch.mock.calls[0][1]?.signal
    rerender({ query: "second" })
    expect(signal?.aborted).toBe(true)
    await act(async () => resolve(response({ ...body, query: "first" })))
    expect(result.current.response).toBeNull()
    await advance()
    const secondSignal = fetch.mock.calls[1][1]?.signal
    unmount()
    expect(secondSignal?.aborted).toBe(true)
  })

  it("uses the authenticated route with list scope and cwd and refreshes stale lists", async () => {
    const scoped = { key: "mine", query: { filter: "mine", scope: "local" } }
    const { result } = renderHook(() => useSessionContentSearch(" search ", scoped, "/work/app"))
    await advance()
    const url = new URL(String(fetch.mock.calls[0][0]), "http://localhost")
    expect(url.pathname).toBe("/api/session-search")
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "search", limit: "12", filter: "mine", scope: "local", cwd: "/work/app" })
    expect(result.current.response).toEqual(body)
    act(() => publishListsStale())
    expect(result.current.response).toBeNull()
    await advance()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([404, 500])("quietly hides HTTP %s and clears previous results", async (status) => {
    fetch.mockResolvedValue(response(body, status))
    const { result } = renderHook(() => useSessionContentSearch("search", filter))
    await advance()
    expect(result.current.response).toBeNull()
  })

  it("quietly hides network failures", async () => {
    fetch.mockRejectedValue(new Error("offline"))
    const { result } = renderHook(() => useSessionContentSearch("search", filter))
    await advance()
    expect(result.current.response).toBeNull()
  })

  it("polls pending files and cancels the poll when the query clears", async () => {
    fetch.mockResolvedValue(response({ ...body, indexing: { pendingFiles: 2, pendingEmbeddings: 0 } }))
    const { result, rerender } = renderHook(({ query }) => useSessionContentSearch(query, filter), { initialProps: { query: "search" } })
    await advance()
    expect(result.current.response?.indexing.pendingFiles).toBe(2)
    await advance(1000)
    expect(fetch).toHaveBeenCalledTimes(2)
    rerender({ query: "" })
    await advance(2000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.current.response).toBeNull()
  })
})


it("refreshes meaning matches while embeddings are catching up, but does not poll a disabled endpoint", async () => {
  fetch.mockResolvedValue(response({ ...body, semantic: { state: "ready" }, indexing: { pendingFiles: 0, pendingEmbeddings: 200 } }))
  const { rerender } = renderHook(({ query }) => useSessionContentSearch(query, filter), { initialProps: { query: "release" } })
  await advance()
  await advance(1000)
  expect(fetch).toHaveBeenCalledTimes(2)
  fetch.mockResolvedValue(response({ ...body, indexing: { pendingFiles: 0, pendingEmbeddings: 200 } }))
  rerender({ query: "new query" })
  await advance()
  await advance(2000)
  expect(fetch).toHaveBeenCalledTimes(3)
})
