import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { SessionHandleLostError, WORKER_REQUEST_TIMEOUT_MS, useParserWorker } from "../useParserWorker"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../../shared/session/sessionDigest"
import type { Turn } from "../../../shared/session/types"
import type { SessionDelta } from "@/workers/session-parser.worker"
import { sessionCache } from "@/lib/sessionCache"

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: ((e: MessageEvent) => void) | null = null
  posted: Array<{ id: number; [key: string]: unknown }> = []
  terminated = false
  throwOnPost: Error | null = null

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(msg: { id: number; [key: string]: unknown }) {
    if (this.throwOnPost) throw this.throwOnPost
    this.posted.push(msg)
  }

  terminate() {
    this.terminated = true
  }

  reply(data: Record<string, unknown>) {
    const id = this.posted[this.posted.length - 1].id
    this.onmessage?.({ data: { ...data, id } } as MessageEvent)
  }

  answer(view: Partial<SessionView>, kept: { handle: number; version: number } | null = null) {
    this.reply({ type: "parsed", view, turnVersions: (view.turns ?? []).map((_, index) => index + 1), kept })
  }
}

const latest = () => FakeWorker.instances[FakeWorker.instances.length - 1]

describe("useParserWorker", () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal("Worker", FakeWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("resolves a request with the worker's answer", async () => {
    const { result } = renderHook(() => useParserWorker())
    const parsed = result.current.parse("{}")
    latest().answer({ sessionId: "s1", turns: [] })
    await expect(parsed).resolves.toEqual({ sessionId: "s1", turns: [] })
  })

  it("rejects pending requests and starts a fresh worker when the worker crashes", async () => {
    const { result } = renderHook(() => useParserWorker())
    const crashed = latest()
    const parsed = result.current.parse("{}")

    crashed.onerror?.({ message: "out of memory" } as ErrorEvent)

    await expect(parsed).rejects.toThrow("Worker error: out of memory")
    expect(crashed.terminated).toBe(true)
    expect(FakeWorker.instances).toHaveLength(2)

    const retried = result.current.parse("{}")
    expect(crashed.posted).toHaveLength(1)
    latest().answer({ sessionId: "s2", turns: [] })
    await expect(retried).resolves.toEqual({ sessionId: "s2", turns: [] })
  })

  it("replaces a worker that never answers", async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useParserWorker())
    const silent = latest()
    const parsed = result.current.parse("{}")

    vi.advanceTimersByTime(WORKER_REQUEST_TIMEOUT_MS)

    await expect(parsed).rejects.toThrow("Worker did not answer")
    expect(silent.terminated).toBe(true)
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it("rejects a request whose message cannot be sent", async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useParserWorker())
    latest().throwOnPost = new Error("Data cannot be cloned, out of memory.")

    await expect(result.current.parse("{}")).rejects.toThrow("out of memory")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("terminates the worker on unmount", async () => {
    const { result, unmount } = renderHook(() => useParserWorker())
    const worker = latest()
    const parsed = result.current.parse("{}")
    unmount()
    await expect(parsed).rejects.toThrow("Worker terminated")
    expect(worker.terminated).toBe(true)
    expect(FakeWorker.instances).toHaveLength(1)
  })
})

const turn = (id: string, text: string): Turn => ({
  id, userMessage: null, contentBlocks: [{ kind: "text", text: [text] }], thinking: [], assistantText: [text],
  toolCalls: [], subAgentActivity: [], timestamp: "", durationMs: null, tokenUsage: null, model: null,
})
const view = (turns: Turn[]): SessionView => ({
  sessionId: "s", version: "", gitBranch: "", cwd: "", slug: "", name: "", model: "", turns,
  stats: { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0, toolCallCounts: {}, errorCount: 0, totalDurationMs: 0, turnCount: turns.length },
  digest: EMPTY_SESSION_DIGEST,
})

describe("useParserWorker appends", () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal("Worker", FakeWorker)
  })
  afterEach(() => vi.unstubAllGlobals())

  const delta = (fromTurn: number, turns: Turn[], turnVersions: number[]): SessionDelta => {
    const { turns: _turns, stats, digest, ...meta } = view(turns)
    return { fromTurn, turns, turnVersions, stats, digest, meta }
  }

  async function loaded() {
    const hook = renderHook(() => useParserWorker())
    const parsed = hook.result.current.parse("lines")
    expect(latest().posted[0]).toMatchObject({ type: "parse", text: "lines", keep: true })
    latest().answer(view([turn("t1", "one"), turn("t2", "two")]), { handle: 4, version: 1 })
    return { hook, session: await parsed }
  }

  it("parses older pages without asking the worker to keep them", async () => {
    const { result } = renderHook(() => useParserWorker())
    result.current.parsePage("page").catch(() => {})
    expect(latest().posted[0]).toMatchObject({ type: "parse", text: "page", keep: false })
  })

  it("sends only the new text, and keeps every turn the delta did not change", async () => {
    const { hook, session } = await loaded()
    // A scoped copy shares its turns, so it still names the kept version.
    const scoped = { ...session, sessionId: "instance:s" }
    const appended = hook.result.current.append(scoped, "more\n")
    expect(latest().posted[1]).toEqual({ type: "append", id: 1, base: { handle: 4, version: 1 }, newText: "more\n" })
    latest().reply({ type: "delta", delta: delta(1, [turn("t2", "two"), turn("t3", "three")], [2, 7]), kept: { handle: 4, version: 2 } })
    const next = await appended
    expect(next.turns[0]).toBe(session.turns[0])
    expect(next.turns[1]).toBe(session.turns[1])
    expect(next.turns[2]!.id).toBe("t3")

    const again = hook.result.current.append(next, "x\n")
    expect(latest().posted[2]).toMatchObject({ base: { handle: 4, version: 2 } })
    const changed = { ...turn("t3", "three"), assistantText: ["three", "four"] }
    latest().reply({ type: "delta", delta: delta(2, [changed], [8]), kept: { handle: 4, version: 3 } })
    const last = (await again).turns[2]!
    expect(last).not.toBe(next.turns[2])
    expect(last.assistantText).toEqual(["three", "four"])
    // The block that did not change inside the changed turn is the same object.
    expect(last.contentBlocks[0]).toBe(next.turns[2]!.contentBlocks[0])
  })

  it("says the session is lost when the worker no longer holds it", async () => {
    const { hook, session } = await loaded()
    const appended = hook.result.current.append(session, "a\n")
    latest().reply({ type: "missing" })
    await expect(appended).rejects.toBeInstanceOf(SessionHandleLostError)
  })

  it("never ships a session the worker does not keep", async () => {
    const { result } = renderHook(() => useParserWorker())
    await expect(result.current.append(view([turn("t1", "one")]), "a\n")).rejects.toBeInstanceOf(SessionHandleLostError)
    expect(latest().posted).toHaveLength(0)
  })

  it("parses the first lines of a session created empty", async () => {
    const { result } = renderHook(() => useParserWorker())
    result.current.append(view([]), "first\n").catch(() => {})
    expect(latest().posted[0]).toMatchObject({ type: "parse", text: "first\n", keep: true })
  })
})

describe("useParserWorker releases", () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal("Worker", FakeWorker)
    sessionCache.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  const source = (fileName: string) => ({ dirName: "-d", fileName, watchOffset: 0, loadId: 1 })
  const releases = () => latest().posted.filter((message) => message.type === "release").map(({ handle }) => handle)

  async function parsed(hook: ReturnType<typeof renderHook<ReturnType<typeof useParserWorker>, unknown>>, handle: number) {
    const pending = hook.result.current.parse(`session ${handle}`)
    latest().answer(view([turn(`t${handle}`, "one")]), { handle, version: 1 })
    return pending
  }

  async function cached(hook: Parameters<typeof parsed>[0], handle: number) {
    const session = await parsed(hook, handle)
    sessionCache.set(session, source(`${handle}.jsonl`), 0, false)
    return session
  }

  it("never lets go of the session on screen while hovers push it out of the cache", async () => {
    const hook = renderHook(() => useParserWorker())
    const screen = {}
    const open = await cached(hook, 1)
    sessionCache.show(screen, open)

    for (const handle of [2, 3, 4, 5, 6]) await cached(hook, handle)

    expect(sessionCache.get("-d", "1.jsonl")).toBeUndefined()
    expect(releases()).toEqual([])

    sessionCache.show(screen, null)
    expect(releases()).toEqual([1])
  })

  it("releases a session once neither the cache nor a screen holds it", async () => {
    const hook = renderHook(() => useParserWorker())
    await cached(hook, 1)
    sessionCache.discard(await parsed(hook, 2))
    sessionCache.evict("-d", "1.jsonl")
    expect(releases()).toEqual([2, 1])
  })

  it("keeps a session through a live update of its cache entry", async () => {
    const hook = renderHook(() => useParserWorker())
    const session = await cached(hook, 1)
    const appended = hook.result.current.append(session, "more\n")
    latest().reply({ type: "delta", delta: { fromTurn: 1, turns: [], turnVersions: [], stats: session.stats, digest: session.digest, meta: {} }, kept: { handle: 1, version: 2 } })
    sessionCache.update("-d", "1.jsonl", { parsed: await appended })
    expect(releases()).toEqual([])
  })

  it("keeps the session the live stream appends to until it appends to another", async () => {
    const hook = renderHook(() => useParserWorker())
    const first = await cached(hook, 1)
    hook.result.current.append(first, "a\n").catch(() => {})
    sessionCache.evict("-d", "1.jsonl")
    expect(releases()).toEqual([])

    const second = await cached(hook, 2)
    hook.result.current.append(second, "b\n").catch(() => {})
    expect(releases()).toEqual([1])
  })

  it("forgets every session when the worker is replaced, so none can name the new worker's", async () => {
    const hook = renderHook(() => useParserWorker())
    const session = await cached(hook, 1)
    latest().onerror?.({ message: "crashed" } as ErrorEvent)

    await expect(hook.result.current.append(session, "a\n")).rejects.toBeInstanceOf(SessionHandleLostError)
    sessionCache.evict("-d", "1.jsonl")
    expect(latest().posted).toEqual([])
  })

  it("stops releasing once unmounted", async () => {
    const hook = renderHook(() => useParserWorker())
    await cached(hook, 1)
    const worker = latest()
    hook.unmount()
    sessionCache.evict("-d", "1.jsonl")
    expect(worker.posted.filter((message) => message.type === "release")).toEqual([])
  })
})
