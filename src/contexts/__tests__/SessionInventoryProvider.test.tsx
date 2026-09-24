import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import {
  SessionInventoryProvider,
  useSessionInventory,
  type SessionInventory,
} from "@/contexts/SessionInventoryContext"
import { __resetEditionUiForTest } from "@/edition/registry"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import {
  __resetSessionAccessForTest,
  knownSessionAccess,
  publishListsStale,
} from "@/lib/sessionAccess"
import { activeSessionsCacheKey, clearSessionListCache, writeCachedList } from "@/lib/sessionListCache"
import { installStubListFilter } from "@/__tests__/listFilter"
import type { ListedAccess } from "../../../shared/contracts/sessionAccess"
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "../../../shared/contracts/identity"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

const ALICE = { id: "u_alice", username: "alice", displayName: "Alice" }
const MINE: ListedAccess = { level: "own", mine: true }

function row(sessionId: string, agentStatus?: ActiveSessionInfo["agentStatus"], access?: ListedAccess): ActiveSessionInfo {
  return {
    dirName: "project-a",
    projectShortName: "project-a",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    lastModified: "2026-09-20T10:00:00Z",
    size: 1,
    agentStatus,
    access,
  }
}

function proc(sessionId: string): RunningProcess {
  return { pid: sessionId.length, sessionId, memMB: 10 } as RunningProcess
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

/** Serves each filter's list from `lists` (`all` unfiltered), and a running process for every session any of them lists. */
function serve(lists: Record<string, ActiveSessionInfo[]>): void {
  mocks.authFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/active-sessions")) {
      return json(lists[new URL(url, "http://x").searchParams.get("filter") ?? "all"] ?? [])
    }
    const sessionIds = new Set(Object.values(lists).flat().map((session) => session.sessionId))
    return json([...sessionIds].map(proc))
  })
}

function renderInventory(): { current: () => SessionInventory } {
  let latest: SessionInventory | null = null
  function Probe() {
    latest = useSessionInventory()
    return null
  }
  render(<SessionInventoryProvider><Probe /></SessionInventoryProvider>)
  return { current: () => latest! }
}

function signInMember(): void {
  setMe({
    authenticated: true,
    edition: "team",
    user: { ...ALICE },
    capabilities: NO_CAPABILITIES,
  })
}

function signInAdmin(gate?: string): void {
  setMe({
    authenticated: true,
    edition: "team",
    user: { ...ALICE },
    capabilities: ALL_CAPABILITIES,
    ...(gate && { gate }),
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

describe("SessionInventoryProvider", () => {
  beforeEach(() => {
    localStorage.clear()
    clearSessionListCache()
    mocks.authFetch.mockReset()
    signInMember()
  })

  afterEach(() => {
    cleanup()
    __resetCapabilitiesForTest()
    __resetSessionAccessForTest()
    __resetEditionUiForTest()
    clearSessionListCache()
  })

  it("learns each session's access from a fresh list, never from the cached one", async () => {
    writeCachedList(activeSessionsCacheKey(null), [row("s1", undefined, MINE)])
    let answer!: (res: Response) => void
    mocks.authFetch.mockImplementation((url: string) => (url.startsWith("/api/active-sessions")
      ? new Promise<Response>((resolve) => { answer = resolve })
      : Promise.resolve(json([]))))
    renderInventory()
    await settle()

    expect(knownSessionAccess("s1")).toBeUndefined()

    await act(async () => answer(json([row("s1", undefined, { level: "view", mine: false })])))
    await settle()

    expect(knownSessionAccess("s1")).toBe("view")
  })

  it("does not report sessions a filter switch brings in as just finished", async () => {
    const filter = installStubListFilter()
    serve({ all: [row("a", "completed", MINE)], narrow: [row("b", "completed", MINE)] })
    const inventory = renderInventory()
    await settle()

    act(() => filter.setKey("narrow"))
    await settle()

    expect(inventory.current().sessions.map((session) => session.sessionId)).toEqual(["b"])
    expect([...inventory.current().newlyCompleted]).toEqual([])

    serve({ narrow: [row("b", "completed", MINE), row("c", "thinking", MINE)] })
    await act(async () => inventory.current().refresh())
    await settle()
    serve({ narrow: [row("b", "completed", MINE), row("c", "completed", MINE)] })
    await act(async () => inventory.current().refresh())
    await settle()

    expect([...inventory.current().newlyCompleted]).toEqual(["c"])
  })

  it("flags only a session it saw unfinished, never one that joins the list already finished", async () => {
    serve({ all: [row("a", "thinking", MINE)] })
    const inventory = renderInventory()
    await settle()

    serve({ all: [row("a", "completed", MINE), row("joined", "completed", MINE)] })
    await act(async () => inventory.current().refresh())
    await settle()

    expect([...inventory.current().newlyCompleted]).toEqual(["a"])
  })

  it("lists again when the lists go stale, without flagging the ones it brings in", async () => {
    serve({ all: [row("a", "completed", MINE)] })
    const inventory = renderInventory()
    await settle()
    const requests = mocks.authFetch.mock.calls.length

    serve({ all: [row("a", "completed", MINE), row("assigned", "completed", MINE)] })
    act(() => publishListsStale())
    await settle()

    expect(mocks.authFetch.mock.calls.length).toBeGreaterThan(requests)
    expect(inventory.current().sessions.map((session) => session.sessionId)).toEqual(["a", "assigned"])
    expect([...inventory.current().newlyCompleted]).toEqual([])
  })

  it("knows every running process the caller may see, whatever the list's filter", async () => {
    // The open session need not be in the list: whether another process drives
    // it is read from here, so the processes are never filtered.
    const filter = installStubListFilter()
    mocks.authFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/active-sessions")) {
        const key = new URL(url, "http://x").searchParams.get("filter")
        return json(key === "narrow" ? [row("b")] : [row("a"), row("b")])
      }
      return json([proc("a"), proc("b")])
    })
    const inventory = renderInventory()
    await settle()

    act(() => filter.setKey("narrow"))
    await settle()

    const processUrls = mocks.authFetch.mock.calls
      .map(([url]) => url as string)
      .filter((url) => url.startsWith("/api/running-processes"))
    expect(new Set(processUrls)).toEqual(new Set(["/api/running-processes"]))
    expect(inventory.current().sessions.map((session) => session.sessionId)).toEqual(["b"])
    expect(inventory.current().procBySession.get("a")).toEqual(proc("a"))
  })

  it("asks nothing while the server's gate shows, and lists again once it lifts", async () => {
    signInAdmin()
    serve({ all: [row("a", undefined, MINE)] })
    const inventory = renderInventory()
    await settle()
    const requests = mocks.authFetch.mock.calls.length

    act(() => signInAdmin("paused"))
    act(() => { window.dispatchEvent(new Event("focus")) })
    act(() => publishListsStale())
    await settle()
    expect(mocks.authFetch.mock.calls.length).toBe(requests)

    serve({ all: [row("a", undefined, MINE), row("b", undefined, MINE)] })
    act(() => signInAdmin())
    await settle()
    expect(inventory.current().sessions.map((session) => session.sessionId)).toEqual(["a", "b"])
  })
})
