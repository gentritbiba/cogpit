import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authFetch } from "@/lib/auth"
import {
  activeSessionsCacheKey,
  clearSessionListCache,
  readCachedSessionPage,
  sessionListCacheKeys,
  writeCachedList,
  writeCachedSessionPage,
} from "@/lib/sessionListCache"
import { __resetEditionUiForTest } from "@/edition/registry"
import {
  __resetSessionAccessForTest,
  knownSessionAccess,
  publishListsStale,
} from "@/lib/sessionAccess"
import { installStubListFilter } from "@/__tests__/listFilter"
import type { ListedAccess } from "../../../../shared/contracts/sessionAccess"
import { Dashboard } from "../index"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

vi.mock("../ProjectsView", () => ({
  ProjectsView: ({
    projects,
    activeSessions,
  }: {
    projects: Array<{ shortName: string }>
    activeSessions: Array<{ firstUserMessage?: string }>
  }) => (
    <div>
      <span>{projects[0]?.shortName}</span>
      <span>{activeSessions[0]?.firstUserMessage}</span>
    </div>
  ),
}))

vi.mock("../SessionsView", () => ({
  SessionsView: ({
    selectedProject,
    sessions,
    onSelectSession,
    onDeleteSession,
  }: {
    selectedProject: { dirName: string }
    sessions: Array<{ fileName: string }>
    onSelectSession: (dirName: string, fileName: string) => void
    onDeleteSession?: (dirName: string, fileName: string) => void
  }) => (
    <div>
      <span data-testid="session-view">
        {selectedProject.dirName}:{sessions.map((session) => session.fileName).join(",")}
      </span>
      {sessions[0] && (
        <button onClick={() => onSelectSession(selectedProject.dirName, sessions[0].fileName)}>
          Open first
        </button>
      )}
      {sessions[0] && onDeleteSession && (
        <button onClick={() => onDeleteSession(selectedProject.dirName, sessions[0].fileName)}>
          Delete first
        </button>
      )}
    </div>
  ),
}))

const mockedAuthFetch = vi.mocked(authFetch)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("Dashboard list cache", () => {
  beforeEach(() => {
    localStorage.clear()
    clearSessionListCache()
    mockedAuthFetch.mockReset()
  })

  afterEach(() => {
    __resetEditionUiForTest()
    __resetSessionAccessForTest()
  })

  it("renders cached session titles while home data revalidates", async () => {
    writeCachedList(sessionListCacheKeys.projects, [{
      dirName: "project-a",
      path: "/workspace/project-a",
      shortName: "Cached project",
      sessionCount: 1,
      lastModified: "2026-07-20T10:00:00Z",
    }])
    writeCachedList(sessionListCacheKeys.activeSessions, [{
      dirName: "project-a",
      projectShortName: "project-a",
      fileName: "cached.jsonl",
      sessionId: "cached-session",
      firstUserMessage: "Cached session title",
      lastModified: "2026-07-20T10:00:00Z",
      size: 100,
    }])

    const projectsRequest = deferred<Response>()
    const sessionsRequest = deferred<Response>()
    mockedAuthFetch
      .mockReturnValueOnce(projectsRequest.promise)
      .mockReturnValueOnce(sessionsRequest.promise)

    render(<Dashboard onSelectSession={vi.fn()} />)

    expect(screen.getByText("Cached project")).toBeInTheDocument()
    expect(screen.getByText("Cached session title")).toBeInTheDocument()

    await act(async () => {
      projectsRequest.resolve({
        ok: true,
        json: async () => [{
          dirName: "project-a",
          path: "/workspace/project-a",
          shortName: "Fresh project",
          sessionCount: 1,
          lastModified: "2026-07-20T10:01:00Z",
        }],
      } as Response)
      sessionsRequest.resolve({
        ok: true,
        json: async () => [{
          dirName: "project-a",
          projectShortName: "project-a",
          fileName: "fresh.jsonl",
          sessionId: "fresh-session",
          firstUserMessage: "Fresh session title",
          lastModified: "2026-07-20T10:01:00Z",
          size: 120,
        }],
      } as Response)
      await Promise.all([projectsRequest.promise, sessionsRequest.promise])
    })

    expect(screen.getByText("Fresh project")).toBeInTheDocument()
    expect(screen.getByText("Fresh session title")).toBeInTheDocument()
  })

  it("lists and caches home sessions by the session list filter", async () => {
    installStubListFilter("narrow")
    writeCachedList(activeSessionsCacheKey("narrow"), [{
      dirName: "project-a",
      projectShortName: "project-a",
      fileName: "filtered.jsonl",
      sessionId: "filtered-session",
      firstUserMessage: "Filtered cached title",
      lastModified: "2026-07-20T10:00:00Z",
      size: 100,
    }])
    mockedAuthFetch.mockReturnValue(new Promise(() => {}))

    render(<Dashboard onSelectSession={vi.fn()} />)

    expect(screen.getByText("Filtered cached title")).toBeInTheDocument()
    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/active-sessions?filter=narrow", expect.anything())
  })

  it("ignores a stale project response after switching projects", async () => {
    const projectARequest = deferred<Response>()
    const projectBRequest = deferred<Response>()
    mockedAuthFetch.mockImplementation((input) => {
      const url = String(input)
      if (url === "/api/projects") {
        return Promise.resolve({ ok: true, json: async () => [] } as Response)
      }
      if (url === "/api/active-sessions") {
        return Promise.resolve({ ok: true, json: async () => [] } as Response)
      }
      if (url.includes("/api/sessions/project-a")) return projectARequest.promise
      if (url.includes("/api/sessions/project-b")) return projectBRequest.promise
      throw new Error(`Unexpected request: ${url}`)
    })
    const onSelectSession = vi.fn()

    const { rerender } = render(
      <Dashboard selectedProjectDirName="project-a" onSelectSession={onSelectSession} />,
    )
    rerender(
      <Dashboard selectedProjectDirName="project-b" onSelectSession={onSelectSession} />,
    )

    await act(async () => {
      projectBRequest.resolve({
        ok: true,
        json: async () => ({
          sessions: [{ fileName: "project-b.jsonl", sessionId: "session-b" }],
          total: 1,
        }),
      } as Response)
      await projectBRequest.promise
    })
    expect(screen.getByTestId("session-view")).toHaveTextContent(
      "project-b:project-b.jsonl",
    )

    await act(async () => {
      projectARequest.resolve({
        ok: true,
        json: async () => ({
          sessions: [{ fileName: "project-a.jsonl", sessionId: "session-a" }],
          total: 1,
        }),
      } as Response)
      await projectARequest.promise
    })

    expect(screen.getByTestId("session-view")).toHaveTextContent(
      "project-b:project-b.jsonl",
    )
    fireEvent.click(screen.getByRole("button", { name: "Open first" }))
    expect(onSelectSession).toHaveBeenCalledWith("project-b", "project-b.jsonl")
  })

  it("keeps a project's session until the server has deleted it", async () => {
    mockedAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [{ fileName: "kept.jsonl", sessionId: "kept" }], total: 1 }),
    } as Response)
    const onDeleteSession = vi.fn<(dirName: string, fileName: string) => Promise<boolean>>().mockResolvedValue(false)
    render(<Dashboard selectedProjectDirName="project-a" onSelectSession={vi.fn()} onDeleteSession={onDeleteSession} />)
    await act(async () => {})

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete first" })))
    expect(onDeleteSession).toHaveBeenCalledWith("project-a", "kept.jsonl")
    expect(screen.getByTestId("session-view")).toHaveTextContent("project-a:kept.jsonl")

    onDeleteSession.mockResolvedValue(true)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete first" })))
    expect(screen.getByTestId("session-view")).toHaveTextContent(/^project-a:$/)
  })

  describe("with lists that carry access", () => {
    const shared: ListedAccess = { level: "view", mine: false }

    function activeRow(sessionId: string, title = sessionId) {
      return {
        dirName: "project-a",
        projectShortName: "project-a",
        fileName: `${sessionId}.jsonl`,
        sessionId,
        firstUserMessage: title,
        lastModified: "2026-07-20T10:00:00Z",
        size: 1,
      }
    }

    function ok(body: unknown): Response {
      return { ok: true, json: async () => body } as Response
    }

    it("learns the access of the sessions on home and on a project page", async () => {
      mockedAuthFetch.mockImplementation(async (input) => {
        const url = String(input)
        if (url === "/api/projects") return ok([])
        if (url.startsWith("/api/active-sessions")) return ok([{ ...activeRow("active"), access: shared }])
        return ok({ sessions: [{ fileName: "paged.jsonl", sessionId: "paged", access: shared }], total: 1 })
      })

      await act(async () => {
        render(<Dashboard selectedProjectDirName="project-a" onSelectSession={vi.fn()} />)
      })

      expect(knownSessionAccess("active")).toBe("view")
      expect(knownSessionAccess("paged")).toBe("view")
    })

    it("shows the new filter's cached list at once and keeps only its answer when requests race", async () => {
      const filter = installStubListFilter()
      writeCachedList(activeSessionsCacheKey("narrow"), [activeRow("cached-narrow", "Cached narrow")])
      const requests = new Map<string, ReturnType<typeof deferred<Response>>>()
      mockedAuthFetch.mockImplementation((input) => {
        const url = String(input)
        if (url === "/api/projects") return Promise.resolve(ok([]))
        const request = deferred<Response>()
        requests.set(url, request)
        return request.promise
      })
      render(<Dashboard onSelectSession={vi.fn()} />)

      act(() => filter.setKey("narrow"))
      expect(screen.getByText("Cached narrow")).toBeInTheDocument()

      await act(async () => {
        requests.get("/api/active-sessions?filter=narrow")!.resolve(ok([activeRow("fresh-narrow", "Fresh narrow")]))
        requests.get("/api/active-sessions")!.resolve(ok([activeRow("stale-all", "Stale all")]))
      })

      expect(screen.getByText("Fresh narrow")).toBeInTheDocument()
      expect(screen.queryByText("Stale all")).not.toBeInTheDocument()
      expect(mockedAuthFetch.mock.calls.filter(([url]) => url === "/api/projects")).toHaveLength(1)
    })

    it("lists and caches a project's sessions by the session list filter", async () => {
      const filter = installStubListFilter()
      writeCachedSessionPage("project-a", "narrow", { sessions: [{ fileName: "cached-narrow.jsonl", sessionId: "cached-narrow" }], total: 1 })
      const pages = new Map<string, ReturnType<typeof deferred<Response>>>()
      mockedAuthFetch.mockImplementation((input) => {
        const url = String(input)
        if (url === "/api/projects") return Promise.resolve(ok([]))
        if (url.startsWith("/api/active-sessions")) return Promise.resolve(ok([]))
        const page = deferred<Response>()
        pages.set(url, page)
        return page.promise
      })
      render(<Dashboard selectedProjectDirName="project-a" onSelectSession={vi.fn()} />)
      expect(pages.has("/api/sessions/project-a?page=1&limit=20")).toBe(true)

      act(() => filter.setKey("narrow"))
      expect(screen.getByTestId("session-view")).toHaveTextContent("project-a:cached-narrow.jsonl")

      await act(async () => {
        pages.get("/api/sessions/project-a?page=1&limit=20&filter=narrow")!
          .resolve(ok({ sessions: [{ fileName: "fresh-narrow.jsonl", sessionId: "fresh-narrow" }], total: 1 }))
      })
      expect(screen.getByTestId("session-view")).toHaveTextContent("project-a:fresh-narrow.jsonl")
      expect(readCachedSessionPage("project-a", "narrow")?.sessions).toEqual([{ fileName: "fresh-narrow.jsonl", sessionId: "fresh-narrow" }])
      expect(readCachedSessionPage("project-a", null)).toBeUndefined()
    })

    it("lists again when the lists go stale", async () => {
      mockedAuthFetch.mockImplementation(async (input) => {
        const url = String(input)
        if (url === "/api/projects") return ok([])
        if (url.startsWith("/api/active-sessions")) return ok([])
        return ok({ sessions: [], total: 0 })
      })
      await act(async () => {
        render(<Dashboard selectedProjectDirName="project-a" onSelectSession={vi.fn()} />)
      })
      const before = mockedAuthFetch.mock.calls.map(([url]) => String(url))

      await act(async () => publishListsStale())

      const after = mockedAuthFetch.mock.calls.map(([url]) => String(url)).slice(before.length)
      expect(after.some((url) => url.startsWith("/api/active-sessions"))).toBe(true)
      expect(after.some((url) => url.startsWith("/api/sessions/project-a"))).toBe(true)
      expect(after).not.toContain("/api/projects")
    })
  })
})
