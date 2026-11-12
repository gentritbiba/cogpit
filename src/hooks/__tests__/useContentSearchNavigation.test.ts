import { emptyTurn } from "@/__tests__/fixtures"
import { useCallback, useState } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("@/lib/sessionCache", () => ({ sessionCache: { get: vi.fn(), update: vi.fn() } }))
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import { useSessionPaging } from "../useSessionPaging"
import { useQuoteNavigation } from "../useQuoteNavigation"
import type { SessionView } from "../../../shared/session/sessionDigest"
import type { Turn } from "../../../shared/session/types"

const turn = (id: string) => emptyTurn({ id, userMessage: id, assistantText: [id] })
const head = [turn("head-0"), turn("head-1")]
const tail = [turn("tail-100"), turn("tail-101")]
const session = (turns: Turn[]) => ({ turns }) as SessionView
const source = (fileName: string) => ({ dirName: "-repo", fileName, watchOffset: 500, loadId: 1 })
const noSubscribe = () => () => {}

function harness(cachedOlder: Turn[] = []) {
  let nextCache = { parsed: session(tail), source: source("new.jsonl"), hasMore: cachedOlder.length === 0, nextByteOffset: 100, olderTurns: cachedOlder, lastAccessed: 0 }
  vi.mocked(sessionCache.get).mockImplementation((_dir, file) => file === "new.jsonl" ? nextCache : { ...nextCache, hasMore: false, olderTurns: [] })
  vi.mocked(sessionCache.update).mockImplementation((_dir, _file, _id, updates) => { nextCache = { ...nextCache, ...updates, source: nextCache.source } })
  const jumpToTurn = vi.fn(async () => true)
  const loadSession = vi.fn()
  const workerParse = vi.fn(async () => session(head))
  const view = renderHook(({ fileName, turns }) => {
    const [older, setOlder] = useState<Turn[]>([])
    const onOlderTurns = useCallback((next: Turn[]) => setOlder(next), [])
    const paging = useSessionPaging({ dirName: "-repo", fileName, sessionChangeKey: fileName === "old.jsonl" ? 1 : 2, workerParse, onOlderTurns })
    const navigate = useQuoteNavigation({ getSession: () => session([...older, ...turns]), sessionSource: source(fileName), loadSession, jumpToTurn, subscribeTimeline: noSubscribe, hasMore: paging.hasMore, historyReady: paging.ready, loadMore: paging.loadMore })
    return { navigate, paging }
  }, { initialProps: { fileName: "old.jsonl", turns: [turn("old-0")] } })
  return { view, jumpToTurn }
}

beforeEach(() => vi.clearAllMocks())

describe("content search with session paging", () => {
  it("waits for the new session's paging state before interpreting an ordinal", async () => {
    let resolve!: (response: Response) => void
    vi.mocked(authFetch).mockImplementation(() => new Promise((done) => { resolve = done }))
    const { view, jumpToTurn } = harness()
    act(() => { void view.result.current.navigate({ ...source("new.jsonl"), sessionId: "new", turnId: "stale-id" }, "", 1) })
    view.rerender({ fileName: "new.jsonl", turns: tail })
    expect(jumpToTurn).not.toHaveBeenCalled()
    await waitFor(() => expect(authFetch).toHaveBeenCalledOnce())
    await act(async () => { resolve(new Response(JSON.stringify({ headerLines: [], lines: ["head"], byteOffset: 0, hasMore: false, unit: "turns" }))) })
    await waitFor(() => expect(jumpToTurn).toHaveBeenCalledWith("head-1"))
  })

  it("reattaches cached older turns before applying an ordinal in a fully cached session", async () => {
    const { view, jumpToTurn } = harness(head)
    act(() => { void view.result.current.navigate({ ...source("new.jsonl"), sessionId: "new", turnId: "stale-id" }, "", 1) })
    view.rerender({ fileName: "new.jsonl", turns: tail })
    await waitFor(() => expect(jumpToTurn).toHaveBeenCalledWith("head-1"))
    expect(jumpToTurn).not.toHaveBeenCalledWith("tail-101")
    expect(authFetch).not.toHaveBeenCalled()
  })
})
