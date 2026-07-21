import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { authFetch } from "@/lib/auth"
import { clearSessionListCache, sessionListCacheKeys, writeCachedList, writeCachedSessionPage } from "@/lib/sessionListCache"
import { useSessionBrowser } from "../useSessionBrowser"
import type { ProjectInfo, SessionInfo } from "../types"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

const mockedAuthFetch = vi.mocked(authFetch)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const project: ProjectInfo = {
  dirName: "project-a",
  path: "/workspace/project-a",
  shortName: "project-a",
  sessionCount: 1,
  lastModified: "2026-07-20T10:00:00Z",
}

const cachedSession: SessionInfo = {
  fileName: "cached.jsonl",
  sessionId: "cached-session",
  size: 100,
  lastModified: "2026-07-20T10:00:00Z",
  firstUserMessage: "Cached session name",
}

const freshSession: SessionInfo = {
  ...cachedSession,
  fileName: "fresh.jsonl",
  sessionId: "fresh-session",
  firstUserMessage: "Fresh session name",
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

async function flushMountRequest(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe("useSessionBrowser list cache", () => {
  beforeEach(() => {
    localStorage.clear()
    clearSessionListCache()
    mockedAuthFetch.mockReset()
  })

  it("shows cached projects while refreshing them asynchronously", async () => {
    writeCachedList(sessionListCacheKeys.projects, [project])
    const request = deferred<Response>()
    mockedAuthFetch.mockReturnValueOnce(request.promise)

    const { result } = renderHook(() => useSessionBrowser({
      sessionId: null,
      workerParse: vi.fn(),
      onLoadSession: vi.fn(),
    }))

    await flushMountRequest()
    expect(result.current.projects).toEqual([project])
    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/projects")

    await act(async () => {
      request.resolve({
        ok: true,
        json: async () => [{ ...project, shortName: "fresh-project-a" }],
      } as Response)
      await request.promise
    })

    expect(result.current.projects[0].shortName).toBe("fresh-project-a")
  })

  it("opens a cached session list immediately and replaces it after revalidation", async () => {
    writeCachedSessionPage(project.dirName, { sessions: [cachedSession], total: 1 })
    const projectsRequest = deferred<Response>()
    const sessionsRequest = deferred<Response>()
    mockedAuthFetch
      .mockReturnValueOnce(projectsRequest.promise)
      .mockReturnValueOnce(sessionsRequest.promise)

    const { result } = renderHook(() => useSessionBrowser({
      sessionId: null,
      workerParse: vi.fn(),
      onLoadSession: vi.fn(),
    }))

    await flushMountRequest()
    act(() => {
      void result.current.loadSessions(project)
    })

    expect(result.current.view).toBe("sessions")
    expect(result.current.sessions).toEqual([cachedSession])

    await act(async () => {
      sessionsRequest.resolve({
        ok: true,
        json: async () => ({ sessions: [freshSession], total: 1 }),
      } as Response)
      await sessionsRequest.promise
    })

    expect(result.current.sessions).toEqual([freshSession])

    await act(async () => {
      projectsRequest.resolve({ ok: true, json: async () => [project] } as Response)
      await projectsRequest.promise
    })
  })

  it("keeps loading while overlapping project and session requests are pending", async () => {
    const projectsRequest = deferred<Response>()
    const sessionsRequest = deferred<Response>()
    mockedAuthFetch
      .mockReturnValueOnce(projectsRequest.promise)
      .mockReturnValueOnce(sessionsRequest.promise)

    const { result } = renderHook(() => useSessionBrowser({
      sessionId: null,
      workerParse: vi.fn(),
      onLoadSession: vi.fn(),
    }))

    await flushMountRequest()
    expect(result.current.isLoading).toBe(true)

    act(() => {
      void result.current.loadSessions(project)
    })

    await act(async () => {
      projectsRequest.resolve(response([project]))
      await projectsRequest.promise
    })

    expect(result.current.isLoading).toBe(true)

    await act(async () => {
      sessionsRequest.resolve(response({ sessions: [freshSession], total: 1 }))
      await sessionsRequest.promise
    })

    expect(result.current.isLoading).toBe(false)
  })

  it("clears loading and exposes the request error after a failed refresh", async () => {
    const projectsRequest = deferred<Response>()
    mockedAuthFetch.mockReturnValueOnce(projectsRequest.promise)

    const { result } = renderHook(() => useSessionBrowser({
      sessionId: null,
      workerParse: vi.fn(),
      onLoadSession: vi.fn(),
    }))

    await flushMountRequest()
    expect(result.current.isLoading).toBe(true)
    expect(result.current.fetchError).toBeNull()

    await act(async () => {
      projectsRequest.resolve(response(null, 503))
      await projectsRequest.promise
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.fetchError).toBe("Failed to load projects (503)")
  })

  it("derives external session detail without losing the underlying browser view", async () => {
    mockedAuthFetch.mockResolvedValueOnce(response([project]))

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => useSessionBrowser({
        sessionId,
        workerParse: vi.fn(),
        onLoadSession: vi.fn(),
      }),
      { initialProps: { sessionId: null as string | null } },
    )

    await flushMountRequest()
    expect(result.current.view).toBe("projects")

    rerender({ sessionId: "external-session-a" })
    expect(result.current.view).toBe("detail")

    act(() => {
      result.current.handleBack()
    })
    expect(result.current.view).toBe("projects")

    rerender({ sessionId: "external-session-b" })
    expect(result.current.view).toBe("detail")

    rerender({ sessionId: null })
    expect(result.current.view).toBe("projects")
  })
})
