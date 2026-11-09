import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { Turn } from "../../../shared/session/types"
import type { SessionView } from "../../../shared/session/sessionDigest"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("@/lib/device", () => ({
  getActiveDeviceScope: vi.fn(() => "local"),
  getActiveIdentity: vi.fn(() => null),
}))

import { createSessionController, type LoadedSession, type SessionAddress } from "@/lib/sessionLoader"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import { getActiveDeviceScope, getActiveIdentity } from "@/lib/device"

const mockAuthFetch = vi.mocked(authFetch)
const mockDeviceScope = vi.mocked(getActiveDeviceScope)
const mockIdentity = vi.mocked(getActiveIdentity)

interface PendingFetch {
  url: string
  signal: AbortSignal | undefined
  background: boolean | undefined
  resolve: (body: Record<string, unknown>, status?: number) => void
  reject: (error: unknown) => void
}

let fetches: PendingFetch[] = []

/** Every tail request waits until the test answers it, and rejects when aborted, as fetch does. */
function deferFetches() {
  mockAuthFetch.mockImplementation((input, init) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
    fetches.push({
      url: String(input),
      signal,
      background: init?.background,
      resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
      reject,
    })
  }))
}

function tail(text: string, overrides: Record<string, unknown> = {}) {
  return {
    headerLines: ['{"h":1}'],
    tailLines: [text],
    byteOffset: 100,
    totalSize: 200,
    end: 190,
    hasMore: true,
    unit: "turns",
    ...overrides,
  }
}

function fetchFor(fileName: string): PendingFetch {
  const found = fetches.find((f) => f.url.includes(`/${fileName}?`))
  if (!found) throw new Error(`no request for ${fileName}`)
  return found
}

/** A parse whose result names the text it parsed. */
const parse = vi.fn(async (text: string) => ({ sessionId: text, turns: [] }) as unknown as SessionView)

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup() {
  const dispatch = vi.fn()
  const sessions = createSessionController({ parse, dispatch })
  const shown: LoadedSession[] = []
  const commit = (loaded: LoadedSession) => { shown.push(loaded) }
  const click = (fileName: string) => {
    const opening = sessions.openSession({ dirName: "-d", fileName }, { reason: "click", commit })
    // Tests that fire and forget an open must not fail on the cleanup that ends it.
    opening.catch(() => {})
    return opening
  }
  return { sessions, dispatch, shown, commit, click }
}

function cacheEntry(fileName: string, overrides: Partial<SessionView> = {}) {
  const parsed = { sessionId: `cached ${fileName}`, turns: [], ...overrides } as unknown as SessionView
  sessionCache.set(parsed, { dirName: "-d", fileName, watchOffset: 50, loadId: 1 }, 10, true)
  return parsed
}

/** Views the cache or a screen let go of, so the worker can drop their sessions. */
let released: SessionView[] = []
sessionCache.onRelease((view) => { released.push(view) })

beforeEach(() => {
  vi.clearAllMocks()
  fetches = []
  sessionCache.clear()
  released = []
  mockDeviceScope.mockReturnValue("local")
  mockIdentity.mockReturnValue(null)
  deferFetches()
})

// Loads are shared module-wide, so a request a test leaves open would be joined by the next test.
afterEach(async () => {
  for (const f of fetches) f.reject(new Error("test over"))
  await flush()
})

describe("openSession", () => {
  it("asks for a turn-aligned tail and resumes the stream from the page's end", async () => {
    const { click, shown } = setup()
    const opening = click("a.jsonl")
    await flush()
    expect(fetches[0].url).toBe("/api/sessions/-d/a.jsonl?tail=10&unit=turns&projection=results-v1")
    expect(fetches[0].background).toBe(false)
    fetches[0].resolve(tail('{"t":"a"}'))

    await expect(opening).resolves.toBe("opened")
    expect(parse).toHaveBeenCalledWith('{"h":1}\n{"t":"a"}')
    expect(shown[0].source).toMatchObject({ dirName: "-d", fileName: "a.jsonl", watchOffset: 190 })
    const entry = sessionCache.get("-d", "a.jsonl")!
    expect(entry.parsed).toBe(shown[0].parsed)
    expect(entry.nextByteOffset).toBe(100)
    expect(entry.hasMore).toBe(true)
  })

  it("resumes from the file size when an older server sends a line page without an end", async () => {
    const { click, shown } = setup()
    const opening = click("a.jsonl")
    await flush()
    fetches[0].resolve(tail('{"t":"a"}', { unit: undefined, end: undefined }))
    await opening
    expect(shown[0].source.watchOffset).toBe(200)
  })

  it("parses a turn page as its header lines then its page lines, exactly as sent", async () => {
    const { click } = setup()
    const opening = click("a.jsonl")
    await flush()
    // The header holds only what precedes the file's first turn; the page holds whole turns.
    const headerLines = ['{"type":"summary","summary":"s"}']
    const tailLines = ['{"type":"user","uuid":"u1"}', '{"type":"assistant","uuid":"a1"}', '{"type":"user","uuid":"u2"}']
    fetches[0].resolve(tail("", { headerLines, tailLines }))
    await opening
    expect(parse).toHaveBeenCalledWith([...headerLines, ...tailLines].join("\n"))
  })

  it("never drops a page line that happens to equal a header line", async () => {
    const { click } = setup()
    const opening = click("a.jsonl")
    await flush()
    fetches[0].resolve(tail('{"h":1}'))
    await opening
    expect(parse).toHaveBeenCalledWith('{"h":1}\n{"h":1}')
  })

  it("records that nothing is left above the oldest turn page", async () => {
    const { click } = setup()
    const opening = click("a.jsonl")
    await flush()
    fetches[0].resolve(tail("t", { hasMore: false, byteOffset: 40 }))
    await opening
    const entry = sessionCache.get("-d", "a.jsonl")!
    expect(entry.hasMore).toBe(false)
    expect(entry.nextByteOffset).toBe(40)
  })

  it("drops header lines a small file repeats in an older server's line page", async () => {
    const { click } = setup()
    const opening = click("a.jsonl")
    await flush()
    fetches[0].resolve(tail('{"h":1}', { unit: undefined }))
    await opening
    expect(parse).toHaveBeenCalledWith('{"h":1}')
  })

  it("commits a cached session synchronously, without a request", () => {
    const { click, shown } = setup()
    const parsed = cacheEntry("a.jsonl")
    void click("a.jsonl")
    expect(shown).toHaveLength(1)
    expect(shown[0].parsed).toBe(parsed)
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("throws a failure of the current open", async () => {
    const { click, shown } = setup()
    const opening = click("a.jsonl")
    await flush()
    fetches[0].resolve({}, 404)
    await expect(opening).rejects.toThrow("Failed to load session (404)")
    expect(shown).toHaveLength(0)
  })

  it("shows what recover returns when the load fails", async () => {
    const { sessions, shown, commit } = setup()
    const fallback = { parsed: { sessionId: "empty", turns: [] } as unknown as SessionView, source: { dirName: "-d", fileName: "a.jsonl", watchOffset: 0, loadId: 9 } }
    const opening = sessions.openSession({ dirName: "-d", fileName: "a.jsonl" }, { reason: "finalize", commit, recover: () => fallback })
    await flush()
    fetches[0].resolve({}, 404)
    await expect(opening).resolves.toBe("opened")
    expect(shown).toEqual([fallback])
  })

  it("resolves an address through a lookup before loading it", async () => {
    const { sessions, shown, commit } = setup()
    const opening = sessions.openSession(async () => ({ dirName: "-d", fileName: "member.jsonl" }), { reason: "team", commit })
    await flush()
    fetchFor("member.jsonl").resolve(tail("m"))
    await expect(opening).resolves.toBe("opened")
    expect(shown[0].source.fileName).toBe("member.jsonl")
  })
})

describe("stale results (R1)", () => {
  it("never commits a slow open after a later one", async () => {
    const { click, shown } = setup()
    const a = click("a.jsonl")
    const b = click("b.jsonl")
    await flush()
    // A is the only waiter on its request, so the later click stops it.
    expect(fetchFor("a.jsonl").signal?.aborted).toBe(true)
    fetchFor("b.jsonl").resolve(tail("b"))
    await expect(b).resolves.toBe("opened")
    await expect(a).resolves.toBe("superseded")
    expect(shown.map((s) => s.source.fileName)).toEqual(["b.jsonl"])
  })

  it("does not let a cold open land over a later cache hit", async () => {
    const { click, shown } = setup()
    cacheEntry("b.jsonl")
    const a = click("a.jsonl")
    void click("b.jsonl")
    await expect(a).resolves.toBe("superseded")
    expect(shown.map((s) => s.source.fileName)).toEqual(["b.jsonl"])
  })

  it("keeps a superseded load that already has its response, and caches it", async () => {
    const { click, shown } = setup()
    let finishParse!: (session: SessionView) => void
    parse.mockImplementationOnce(() => new Promise((r) => { finishParse = r }))
    const a = click("a.jsonl")
    await flush()
    fetchFor("a.jsonl").resolve(tail("a"))
    await flush()
    void click("b.jsonl")
    expect(fetchFor("a.jsonl").signal?.aborted).toBe(false)
    finishParse({ sessionId: "a", turns: [] } as unknown as SessionView)
    await expect(a).resolves.toBe("superseded")
    expect(shown).toHaveLength(0)
    expect(sessionCache.get("-d", "a.jsonl")?.parsed.sessionId).toBe("a")
  })

  it("lets a prefetch finish a load a click gave up on", async () => {
    const { sessions, click, shown } = setup()
    sessions.prefetchSession({ dirName: "-d", fileName: "a.jsonl" })
    const a = click("a.jsonl")
    void click("b.jsonl")
    await flush()
    expect(fetchFor("a.jsonl").signal?.aborted).toBe(false)
    fetchFor("a.jsonl").resolve(tail("a"))
    await expect(a).resolves.toBe("superseded")
    await flush()
    expect(shown).toHaveLength(0)
    expect(sessionCache.get("-d", "a.jsonl")).toBeDefined()
  })

  it("aborts a superseded lookup and never loads what it resolves", async () => {
    const { sessions, click, shown, commit } = setup()
    let lookupSignal!: AbortSignal
    let finishLookup!: (address: SessionAddress) => void
    const member = sessions.openSession((signal) => {
      lookupSignal = signal
      return new Promise((r) => { finishLookup = r })
    }, { reason: "team", commit })
    const b = click("b.jsonl")
    expect(lookupSignal.aborted).toBe(true)
    finishLookup({ dirName: "-d", fileName: "member.jsonl" })
    await expect(member).resolves.toBe("superseded")
    await flush()
    expect(fetches.map((f) => f.url).some((u) => u.includes("member"))).toBe(false)
    fetchFor("b.jsonl").resolve(tail("b"))
    await b
    expect(shown.map((s) => s.source.fileName)).toEqual(["b.jsonl"])
  })

  it("swallows the failure of a superseded open", async () => {
    const { click } = setup()
    const a = click("a.jsonl")
    await flush()
    const failing = fetchFor("a.jsonl")
    void click("b.jsonl")
    failing.resolve({}, 500)
    await expect(a).resolves.toBe("superseded")
  })

  it("drops a result when the device changed while it loaded, and caches nothing", async () => {
    const { click, shown } = setup()
    const a = click("a.jsonl")
    await flush()
    mockDeviceScope.mockReturnValue("device-b")
    fetchFor("a.jsonl").resolve(tail("a"))
    await expect(a).resolves.toBe("superseded")
    expect(shown).toHaveLength(0)
    mockDeviceScope.mockReturnValue("local")
    expect(sessionCache.get("-d", "a.jsonl")).toBeUndefined()
    expect(released.map(({ sessionId }) => sessionId)).toEqual(['{"h":1}\na'])
  })

  it("drops a result when the signed-in identity changed while it loaded", async () => {
    const { click, shown } = setup()
    const a = click("a.jsonl")
    await flush()
    mockIdentity.mockReturnValue("u_2")
    fetchFor("a.jsonl").resolve(tail("a"))
    await expect(a).resolves.toBe("superseded")
    expect(shown).toHaveLength(0)
    mockIdentity.mockReturnValue(null)
    expect(sessionCache.get("-d", "a.jsonl")).toBeUndefined()
  })

  it("ends ten rapid clicks on the last one, with every earlier request stopped", async () => {
    const { click, shown } = setup()
    const names = Array.from({ length: 10 }, (_, i) => `s${i}.jsonl`)
    const opens = names.map((name) => click(name))
    await flush()
    expect(fetches).toHaveLength(10)
    // Answer in reverse, so every stale answer arrives after the winner's.
    for (const f of [...fetches].reverse()) if (!f.signal?.aborted) f.resolve(tail(f.url))
    const outcomes = await Promise.all(opens)
    expect(outcomes.filter((o) => o === "opened")).toHaveLength(1)
    expect(outcomes[9]).toBe("opened")
    expect(shown.map((s) => s.source.fileName)).toEqual(["s9.jsonl"])
    expect(fetches.filter((f) => f.signal?.aborted)).toHaveLength(9)
  })
})

describe("shared loads (R2)", () => {
  it("serves a prefetch and a click from one request and one parse", async () => {
    const { sessions, click, shown } = setup()
    sessions.prefetchSession({ dirName: "-d", fileName: "a.jsonl" })
    const a = click("a.jsonl")
    await flush()
    expect(fetches).toHaveLength(1)
    expect(fetches[0].background).toBe(true)
    fetches[0].resolve(tail("a"))
    await expect(a).resolves.toBe("opened")
    expect(parse).toHaveBeenCalledOnce()
    expect(shown).toHaveLength(1)
  })

  it("does not prefetch a cached session or one already loading", async () => {
    const { sessions } = setup()
    cacheEntry("a.jsonl")
    sessions.prefetchSession({ dirName: "-d", fileName: "a.jsonl" })
    sessions.prefetchSession({ dirName: "-d", fileName: "b.jsonl" })
    sessions.prefetchSession({ dirName: "-d", fileName: "b.jsonl" })
    await flush()
    expect(fetches.map((f) => f.url)).toEqual([expect.stringContaining("/b.jsonl?")])
    fetches[0].resolve(tail("b"))
  })

  it("starts a fresh request after an aborted one instead of joining it", async () => {
    const { click } = setup()
    void click("a.jsonl")
    void click("b.jsonl")
    const again = click("a.jsonl")
    await flush()
    const aRequests = fetches.filter((f) => f.url.includes("/a.jsonl?"))
    expect(aRequests).toHaveLength(2)
    expect(aRequests[1].signal?.aborted).toBe(false)
    aRequests[1].resolve(tail("a"))
    await expect(again).resolves.toBe("opened")
  })

  it("keeps an entry a live stream advanced while an older load was in flight", async () => {
    const { sessions, click, shown } = setup()
    sessions.prefetchSession({ dirName: "-d", fileName: "a.jsonl" })
    await flush()
    const live = cacheEntry("a.jsonl")
    const a = click("a.jsonl")
    fetches[0].resolve(tail("a"))
    await a
    expect(shown[0].parsed).toBe(live)
    await flush()
    expect(sessionCache.get("-d", "a.jsonl")?.parsed).toBe(live)
    expect(released.map(({ sessionId }) => sessionId)).toEqual(['{"h":1}\na'])
  })
})

describe("the view on screen (review #2)", () => {
  it("stays held while hover prefetches push it out of the cache, until the user leaves", async () => {
    const { sessions, click, shown } = setup()
    const a = click("a.jsonl")
    await flush()
    fetchFor("a.jsonl").resolve(tail("a"))
    await a
    const onScreen = shown[0].parsed

    for (const name of ["p1", "p2", "p3", "p4", "p5"]) {
      sessions.prefetchSession({ dirName: "-d", fileName: `${name}.jsonl` })
      await flush()
      fetchFor(`${name}.jsonl`).resolve(tail(name))
      await flush()
    }

    expect(sessionCache.get("-d", "a.jsonl")).toBeUndefined()
    expect(released).toContain(onScreen)
    expect([...sessionCache.heldViews()]).toContain(onScreen)

    released = []
    sessions.leave()
    expect(released).toEqual([onScreen])
    expect([...sessionCache.heldViews()]).not.toContain(onScreen)
  })

  it("lets the previous view go when another open lands", () => {
    const { click } = setup()
    const a = cacheEntry("a.jsonl")
    cacheEntry("b.jsonl")
    void click("a.jsonl")
    void click("b.jsonl")
    sessionCache.evict("-d", "a.jsonl")
    expect([...sessionCache.heldViews()]).not.toContain(a)
  })
})

describe("reloadCurrent", () => {
  async function openA() {
    const ctx = setup()
    const a = ctx.click("a.jsonl")
    await flush()
    fetchFor("a.jsonl").resolve(tail("a"))
    await a
    fetches = []
    return ctx
  }

  it("re-reads the session on screen from disk and lands it as a reload", async () => {
    const { sessions, dispatch } = await openA()
    const reloading = sessions.reloadCurrent()
    await flush()
    expect(sessionCache.get("-d", "a.jsonl")).toBeUndefined()
    fetchFor("a.jsonl").resolve(tail("a2"))
    await reloading
    expect(dispatch).toHaveBeenCalledWith({
      type: "RELOAD_SESSION_CONTENT",
      session: expect.objectContaining({ sessionId: '{"h":1}\na2' }),
      source: expect.objectContaining({ fileName: "a.jsonl", watchOffset: 190 }),
    })
  })

  it("replaces a cache hit and its paged history cleanly when the stream resets", async () => {
    const { sessions, dispatch, click, shown } = setup()
    cacheEntry("a.jsonl")
    sessionCache.update("-d", "a.jsonl", { olderTurns: [{ id: "old" } as unknown as Turn] })
    void click("a.jsonl")
    expect(shown).toHaveLength(1)

    const reloading = sessions.reloadCurrent()
    await flush()
    fetchFor("a.jsonl").resolve(tail("fresh"))
    await reloading
    expect(dispatch).toHaveBeenCalledOnce()
    const entry = sessionCache.get("-d", "a.jsonl")!
    expect(entry.parsed.sessionId).toBe('{"h":1}\nfresh')
    expect(entry.olderTurns).toEqual([])
  })

  it("does nothing with no session on screen", async () => {
    const { sessions } = setup()
    await sessions.reloadCurrent()
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("never re-opens a session the user has left", async () => {
    const { sessions, dispatch } = await openA()
    const reloading = sessions.reloadCurrent()
    await flush()
    const request = fetchFor("a.jsonl")
    sessions.leave()
    expect(request.signal?.aborted).toBe(true)
    await reloading
    expect(dispatch).not.toHaveBeenCalled()
    await sessions.reloadCurrent()
    expect(fetches).toHaveLength(1)
  })

  it("drops a reload once the user opens another session", async () => {
    const { sessions, dispatch, click, shown } = await openA()
    const reloading = sessions.reloadCurrent()
    await flush()
    const b = click("b.jsonl")
    await flush()
    fetchFor("b.jsonl").resolve(tail("b"))
    await b
    await reloading
    expect(dispatch).not.toHaveBeenCalled()
    expect(shown.map((s) => s.source.fileName)).toEqual(["a.jsonl", "b.jsonl"])
  })

  it("does not start while another open is still landing", async () => {
    const { sessions, click } = await openA()
    void click("b.jsonl")
    await sessions.reloadCurrent()
    await flush()
    expect(fetches.map((f) => f.url)).toEqual([expect.stringContaining("/b.jsonl?")])
  })

  it("keeps the session on screen when the reload fails, and can reload it later", async () => {
    const { sessions, dispatch } = await openA()
    const failing = sessions.reloadCurrent()
    await flush()
    fetches[0].resolve({}, 500)
    await failing
    expect(dispatch).not.toHaveBeenCalled()

    const retry = sessions.reloadCurrent()
    await flush()
    fetches[1].resolve(tail("a3"))
    await retry
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it("does not join a load that started before the transcript changed, and later opens join the reload", async () => {
    const { sessions, dispatch, click } = await openA()
    sessionCache.evict("-d", "a.jsonl")
    sessions.prefetchSession({ dirName: "-d", fileName: "a.jsonl" })
    const reloading = sessions.reloadCurrent()
    await flush()
    expect(fetches).toHaveLength(2)
    const [older, reload] = fetches
    reload.resolve(tail("after"))
    await reloading
    older.resolve(tail("before"))
    await flush()
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ sessionId: '{"h":1}\nafter' }) }))
    expect(sessionCache.get("-d", "a.jsonl")?.parsed.sessionId).toBe('{"h":1}\nafter')
    void click
  })

  it("collapses a second reload into the one in flight", async () => {
    const { sessions } = await openA()
    const first = sessions.reloadCurrent()
    const second = sessions.reloadCurrent()
    await flush()
    expect(fetches).toHaveLength(1)
    fetches[0].resolve(tail("a2"))
    await Promise.all([first, second])
  })
})

describe("leave", () => {
  it("cancels an open still on its way", async () => {
    const { sessions, click, shown } = setup()
    const a = click("a.jsonl")
    await flush()
    sessions.leave()
    expect(fetchFor("a.jsonl").signal?.aborted).toBe(true)
    await expect(a).resolves.toBe("superseded")
    expect(shown).toHaveLength(0)
  })
})
