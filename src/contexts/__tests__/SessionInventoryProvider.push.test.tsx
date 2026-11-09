import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import {
  SessionInventoryProvider,
  useSessionInventory,
  type SessionInventory,
} from "@/contexts/SessionInventoryContext"
import { __resetEditionUiForTest } from "@/edition/registry"
import { __resetSessionAccessForTest } from "@/lib/sessionAccess"
import { activeSessionsCacheKey, clearSessionListCache, readCachedList } from "@/lib/sessionListCache"
import { REFUSED_RETRY_MS, __resetSessionListEventsForTest } from "@/lib/sessionListEvents"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2
  static last: FakeEventSource | null = null
  readyState = 1

  constructor(readonly url: string) {
    super()
    FakeEventSource.last = this
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }

  version(version: number, epoch?: string): void {
    this.dispatchEvent(new MessageEvent("version", { data: JSON.stringify({ version, epoch }) }))
  }

  open(): void {
    this.dispatchEvent(new Event("open"))
  }

  giveUp(): void {
    this.readyState = FakeEventSource.CLOSED
    this.dispatchEvent(new Event("error"))
  }
}

function row(sessionId: string, extra: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "project-a",
    projectShortName: "project-a",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    lastModified: "2026-09-20T10:00:00Z",
    size: 1,
    ...extra,
  }
}

function proc(sessionId: string): RunningProcess {
  return { pid: sessionId.length, sessionId, memMB: 10 } as RunningProcess
}

interface Served {
  rows: ActiveSessionInfo[]
  archivedRows: ActiveSessionInfo[]
  processes: RunningProcess[]
  etag: string | null
  archivedCount: number
  /** The list version and server run the answers name, when the server sends them. */
  version?: number
  epoch?: string
  /** What the stream's probe answers. */
  streamStatus?: number
}

let served: Served

/** A server with ETags: answers `If-None-Match` with 304 while the list is unchanged. */
function serve(): void {
  mocks.authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/session-list/events") return new Response("{}", { status: served.streamStatus ?? 404 })
    if (url === "/api/running-processes") return Response.json(served.processes)
    const archived = url.includes("archived=include")
    const etag = served.etag && `${served.etag}${archived ? "-a" : ""}`
    const asked = new Headers(init?.headers).get("If-None-Match")
    const headers: Record<string, string> = { "X-Cogpit-Archived-Count": String(served.archivedCount) }
    if (served.version !== undefined) headers["X-Cogpit-List-Version"] = String(served.version)
    if (served.epoch) headers["X-Cogpit-List-Epoch"] = served.epoch
    if (etag) headers.ETag = etag
    if (etag && asked === etag) return new Response(null, { status: 304, headers })
    return Response.json(archived ? [...served.rows, ...served.archivedRows] : served.rows, { headers })
  })
}

function listCalls(): Array<{ url: string; ifNoneMatch: string | null }> {
  return mocks.authFetch.mock.calls
    .filter(([url]) => String(url).startsWith("/api/active-sessions"))
    .map(([url, init]) => ({ url: String(url), ifNoneMatch: new Headers((init as RequestInit | undefined)?.headers).get("If-None-Match") }))
}

function urlsCalled(): string[] {
  return mocks.authFetch.mock.calls.map(([url]) => String(url))
}

function renderInventory(): { current: () => SessionInventory; renders: () => number } {
  let latest: SessionInventory | null = null
  let renders = 0
  function Probe() {
    latest = useSessionInventory()
    renders += 1
    return null
  }
  render(<SessionInventoryProvider><Probe /></SessionInventoryProvider>)
  return { current: () => latest!, renders: () => renders }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  })
}

let visibility: DocumentVisibilityState = "visible"

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next
  document.dispatchEvent(new Event("visibilitychange"))
}

describe("SessionInventoryProvider push and revalidation", () => {
  beforeEach(() => {
    localStorage.clear()
    clearSessionListCache()
    mocks.authFetch.mockReset()
    served = { rows: [row("a"), row("b")], archivedRows: [row("old", { archived: true })], processes: [proc("a")], etag: "v1", archivedCount: 1 }
    serve()
    FakeEventSource.last = null
    vi.stubGlobal("EventSource", FakeEventSource)
    visibility = "visible"
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __resetSessionListEventsForTest()
    __resetSessionAccessForTest()
    __resetEditionUiForTest()
    clearSessionListCache()
  })

  it("keeps the same inventory when a refresh brings an unchanged list", async () => {
    served.etag = null
    const inventory = renderInventory()
    await settle()
    const before = inventory.current()
    const renders = inventory.renders()

    await act(async () => before.refresh())
    await settle()

    expect(inventory.current()).toBe(before)
    expect(inventory.renders()).toBe(renders)
  })

  it("keeps unchanged rows by identity when one row changes", async () => {
    served.etag = null
    const inventory = renderInventory()
    await settle()
    const [a] = inventory.current().sessions

    served.rows = [row("a"), row("b", { agentStatus: "thinking" })]
    await act(async () => inventory.current().refresh())
    await settle()

    expect(inventory.current().sessions[0]).toBe(a)
    expect(inventory.current().sessions[1].agentStatus).toBe("thinking")
  })

  it("revalidates on a version event with If-None-Match and keeps rows and the archived count on 304", async () => {
    const inventory = renderInventory()
    await settle()
    const before = inventory.current()
    expect(before.archivedCount).toBe(1)

    await act(async () => FakeEventSource.last!.version(2))
    await settle()

    expect(listCalls().at(-1)).toEqual({ url: "/api/active-sessions", ifNoneMatch: "v1" })
    expect(inventory.current()).toBe(before)
    expect(inventory.current().archivedCount).toBe(1)
  })

  it("reads the running processes on an event only when the list changed", async () => {
    renderInventory()
    await settle()
    const processReads = () => urlsCalled().filter((url) => url === "/api/running-processes").length
    const initial = processReads()

    await act(async () => FakeEventSource.last!.version(2))
    await settle()
    expect(processReads()).toBe(initial)

    served.rows = [row("a"), row("b"), row("c")]
    served.etag = "v3"
    await act(async () => FakeEventSource.last!.version(3))
    await settle()
    expect(processReads()).toBe(initial + 1)
  })

  it("reads once more when a change is announced during a request, but never loops on failures", async () => {
    let answer!: (response: Response) => void
    mocks.authFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/active-sessions")) return new Promise<Response>((resolve) => { answer = resolve })
      return Promise.resolve(Response.json([]))
    })
    const inventory = renderInventory()
    await settle()
    await act(async () => FakeEventSource.last!.version(4))
    expect(listCalls()).toHaveLength(1)

    await act(async () => answer(new Response("", { status: 500 })))
    await settle()
    expect(listCalls()).toHaveLength(1)
    expect(inventory.current().error).toBe("Failed to fetch live data")
    expect(inventory.current().loading).toBe(false)

    await act(async () => inventory.current().refresh())
    await act(async () => FakeEventSource.last!.version(5))
    expect(listCalls()).toHaveLength(2)
    await act(async () => answer(Response.json([row("a")])))
    await settle()
    expect(listCalls()).toHaveLength(3)
    await act(async () => answer(Response.json([row("a")])))
    await settle()
    expect(listCalls()).toHaveLength(3)
    expect(inventory.current().loading).toBe(false)
  })

  it("only remembers an event while hidden and reads the list once it shows again", async () => {
    renderInventory()
    await settle()
    const reads = listCalls().length

    act(() => setVisibility("hidden"))
    await act(async () => {
      FakeEventSource.last!.version(2)
      FakeEventSource.last!.version(3)
    })
    await settle()
    expect(listCalls()).toHaveLength(reads)

    act(() => setVisibility("visible"))
    await settle()
    expect(listCalls()).toHaveLength(reads + 1)
  })

  it("reads the list again after the server restarted and its versions started over", async () => {
    served.version = 10
    served.epoch = "run-1"
    renderInventory()
    await settle()
    const reads = listCalls().length
    await act(async () => FakeEventSource.last!.version(10, "run-1"))
    await settle()
    expect(listCalls()).toHaveLength(reads)

    served.version = 1
    served.epoch = "run-2"
    await act(async () => FakeEventSource.last!.version(1, "run-2"))
    await settle()
    expect(listCalls()).toHaveLength(reads + 1)
    await act(async () => FakeEventSource.last!.version(1, "run-2"))
    await settle()
    expect(listCalls()).toHaveLength(reads + 1)
    served.version = 2
    await act(async () => FakeEventSource.last!.version(2, "run-2"))
    await settle()
    expect(listCalls()).toHaveLength(reads + 2)
  })

  it("takes a version going down from a server that names no run as a restart", async () => {
    served.version = 10
    renderInventory()
    await settle()
    await act(async () => FakeEventSource.last!.version(10))
    await settle()
    const reads = listCalls().length

    served.version = 2
    await act(async () => FakeEventSource.last!.version(2))
    await settle()
    expect(listCalls()).toHaveLength(reads + 1)
  })

  it("remembers a change announced during a request that ends while hidden", async () => {
    let answer!: (response: Response) => void
    mocks.authFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/active-sessions")) return new Promise<Response>((resolve) => { answer = resolve })
      return Promise.resolve(Response.json([]))
    })
    renderInventory()
    await settle()
    await act(async () => FakeEventSource.last!.version(4))
    act(() => setVisibility("hidden"))
    await act(async () => answer(Response.json([row("a")])))
    await settle()
    expect(listCalls()).toHaveLength(1)

    act(() => setVisibility("visible"))
    await settle()
    expect(listCalls()).toHaveLength(2)
  })

  it("stops polling once a stream the server refused comes back", async () => {
    vi.useFakeTimers()
    served.processes = []
    served.streamStatus = 403
    renderInventory()
    await act(async () => FakeEventSource.last!.giveUp())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const reads = listCalls().length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(listCalls()).toHaveLength(reads + 1)

    await act(async () => { await vi.advanceTimersByTimeAsync(REFUSED_RETRY_MS - 60_000) })
    const polled = listCalls().length
    await act(async () => FakeEventSource.last!.open())
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
    expect(listCalls()).toHaveLength(polled)
  })

  it("polls every 60 s while visible when the server has no stream and nothing is live", async () => {
    vi.useFakeTimers()
    served.processes = []
    renderInventory()
    await act(async () => FakeEventSource.last!.giveUp())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const reads = listCalls().length

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(listCalls()).toHaveLength(reads + 1)

    act(() => setVisibility("hidden"))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(listCalls()).toHaveLength(reads + 1)
  })

  it("re-reads the list and processes every 20 s while something is live and the server has no stream", async () => {
    vi.useFakeTimers()
    served.rows = [row("a", { agentStatus: "thinking" })]
    renderInventory()
    await act(async () => FakeEventSource.last!.giveUp())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const lists = listCalls().length
    const processReads = urlsCalled().filter((url) => url === "/api/running-processes").length

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(listCalls()).toHaveLength(lists + 1)
    expect(urlsCalled().filter((url) => url === "/api/running-processes")).toHaveLength(processReads + 1)

    act(() => setVisibility("hidden"))
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(listCalls()).toHaveLength(lists + 1)
  })

  it("refreshes only the running processes on the live timer", async () => {
    vi.useFakeTimers()
    served.rows = [row("a", { agentStatus: "thinking" })]
    renderInventory()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const lists = listCalls().length
    const processReads = urlsCalled().filter((url) => url === "/api/running-processes").length

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

    expect(listCalls()).toHaveLength(lists)
    expect(urlsCalled().filter((url) => url === "/api/running-processes")).toHaveLength(processReads + 1)
  })

  it("throttles the focus refresh", async () => {
    renderInventory()
    await settle()
    const reads = listCalls().length

    act(() => { window.dispatchEvent(new Event("focus")) })
    await settle()
    expect(listCalls()).toHaveLength(reads)
  })

  it("leaves loading alone on background refreshes", async () => {
    const inventory = renderInventory()
    expect(inventory.current().loading).toBe(true)
    await settle()
    expect(inventory.current().loading).toBe(false)

    const seen: boolean[] = []
    await act(async () => inventory.current().refresh())
    seen.push(inventory.current().loading)
    await settle()
    expect(seen).toEqual([false])
  })

  it("writes the cache once per change, never for an unchanged list", async () => {
    const setItem = vi.spyOn(localStorage, "setItem")
    const inventory = renderInventory()
    await settle()
    const writes = setItem.mock.calls.filter(([key]) => key.includes("session-list-cache")).length
    expect(writes).toBe(1)

    served.etag = null
    await act(async () => inventory.current().refresh())
    await settle()
    expect(setItem.mock.calls.filter(([key]) => key.includes("session-list-cache"))).toHaveLength(writes)
    setItem.mockRestore()
  })

  // Regression: the archived-included list used to be cached under the default
  // key, so the next cold start listed archived sessions; and every search
  // start and clear refetched the list.
  it("caches a search's archived rows apart and does not refetch while searching or after", async () => {
    const inventory = renderInventory()
    await settle()
    const reads = listCalls().length

    act(() => inventory.current().setSearchActive(true))
    await settle()
    expect(listCalls().slice(reads).map((call) => call.url)).toEqual(["/api/active-sessions?archived=include"])
    expect(inventory.current().sessions.map((session) => session.sessionId)).toEqual(["a", "b", "old"])

    act(() => inventory.current().setSearchActive(false))
    await settle()
    act(() => inventory.current().setSearchActive(true))
    await settle()
    expect(listCalls()).toHaveLength(reads + 1)

    expect(readCachedList<ActiveSessionInfo>(activeSessionsCacheKey(null))?.map((session) => session.sessionId)).toEqual(["a", "b"])
    expect(readCachedList<ActiveSessionInfo>(activeSessionsCacheKey(null, true))).toBeUndefined()
    expect(urlsCalled().filter((url) => url === "/api/running-processes")).toHaveLength(1)
  })

  it("caches the archived list under its own key while the archive toggle is on", async () => {
    const inventory = renderInventory()
    await settle()

    act(() => inventory.current().setShowArchived(true))
    await settle()

    expect(readCachedList<ActiveSessionInfo>(activeSessionsCacheKey(null))?.map((session) => session.sessionId)).toEqual(["a", "b"])
    expect(readCachedList<ActiveSessionInfo>(activeSessionsCacheKey(null, true))?.map((session) => session.sessionId)).toEqual(["a", "b", "old"])
  })
})
