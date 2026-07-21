import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { authFetch } from "@/lib/auth"
import { clearSessionListCache, sessionListCacheKeys, writeCachedList } from "@/lib/sessionListCache"
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
  }: {
    selectedProject: { dirName: string }
    sessions: Array<{ fileName: string }>
    onSelectSession: (dirName: string, fileName: string) => void
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
})
