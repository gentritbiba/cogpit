import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectInfo } from "@/components/Dashboard/types"
import { __resetProjectsStoreForTest, loadProjects, useProjects } from "@/lib/projectsStore"
import { clearSessionListCache, sessionListCacheKeys, writeCachedList } from "@/lib/sessionListCache"
import { __resetSessionListEventsForTest } from "@/lib/sessionListEvents"

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
  close(): void { this.readyState = FakeEventSource.CLOSED }
}

function project(dirName: string): ProjectInfo {
  return { dirName, path: `/work/${dirName}`, shortName: dirName, sessionCount: 1, lastModified: null }
}

let served: { projects: ProjectInfo[]; etag: string }

function projectCalls(): Array<string | null> {
  return mocks.authFetch.mock.calls
    .filter(([url]) => url === "/api/projects")
    .map(([, init]) => new Headers((init as RequestInit | undefined)?.headers).get("If-None-Match"))
}

function Consumer({ onProjects }: { onProjects: (projects: ProjectInfo[]) => void }) {
  onProjects(useProjects().projects)
  return null
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  })
}

describe("projects store", () => {
  beforeEach(() => {
    localStorage.clear()
    clearSessionListCache()
    __resetProjectsStoreForTest()
    served = { projects: [project("a")], etag: "p1" }
    mocks.authFetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url !== "/api/projects") return new Response("{}", { status: 404 })
      if (new Headers(init?.headers).get("If-None-Match") === served.etag) return new Response(null, { status: 304 })
      return Response.json(served.projects, { headers: { ETag: served.etag } })
    })
    FakeEventSource.last = null
    vi.stubGlobal("EventSource", FakeEventSource)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    __resetSessionListEventsForTest()
  })

  it("shows the cached projects at once and asks the server once for every surface", async () => {
    writeCachedList(sessionListCacheKeys.projects, [project("cached")])
    const first = vi.fn()
    const second = vi.fn()
    render(<><Consumer onProjects={first} /><Consumer onProjects={second} /></>)

    expect(first.mock.calls[0][0]).toEqual([project("cached")])
    await settle()
    expect(projectCalls()).toEqual([null])
    expect(first.mock.calls.at(-1)![0]).toEqual([project("a")])
    expect(second.mock.calls.at(-1)![0]).toBe(first.mock.calls.at(-1)![0])
  })

  it("revalidates on a list event and keeps the same list on 304", async () => {
    const seen = vi.fn()
    render(<Consumer onProjects={seen} />)
    await settle()
    const before = seen.mock.calls.at(-1)![0]

    await act(async () => {
      FakeEventSource.last!.dispatchEvent(new MessageEvent("version", { data: JSON.stringify({ version: 2 }) }))
    })
    await settle()

    expect(projectCalls()).toEqual([null, "p1"])
    expect(seen.mock.calls.at(-1)![0]).toBe(before)
  })

  it("reads again for a one-off lookup while nobody follows the projects", async () => {
    await loadProjects()
    served = { projects: [project("a"), project("b")], etag: "p2" }
    expect(await loadProjects()).toEqual([project("a"), project("b")])
    expect(projectCalls()).toEqual([null, "p1"])
  })

  it("answers a one-off lookup from the followed list while it is current", async () => {
    render(<Consumer onProjects={vi.fn()} />)
    await settle()
    expect(await loadProjects()).toEqual([project("a")])
    expect(projectCalls()).toEqual([null])
  })
})
