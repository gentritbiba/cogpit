import type { ButtonHTMLAttributes, MouseEvent, MutableRefObject, ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActiveSessionInfo } from "../types"
import {
  clearSessionListCache,
  readCachedList,
  sessionListCacheKeys,
  writeCachedList,
} from "@/lib/sessionListCache"
import { LiveSessions } from "../index"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  onDeleteSession: vi.fn(),
  ptySend: vi.fn(),
  renameProject: vi.fn(),
  renameSession: vi.fn(),
  setCollapsedGroups: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/contexts/PtyContext", () => ({ usePty: () => ({ send: mocks.ptySend }) }))
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }))
vi.mock("@/hooks/useLocalStorage", () => ({
  useLocalStorage: () => [{}, mocks.setCollapsedGroups],
}))
vi.mock("@/hooks/useProjectNames", () => ({
  useProjectNames: () => ({ names: {}, rename: mocks.renameProject }),
}))
vi.mock("@/hooks/useSessionNames", () => ({
  useSessionNames: () => ({ names: {}, rename: mocks.renameSession }),
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ProjectContextMenu", () => ({
  ProjectContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("../AttentionStrip", () => ({ AttentionStrip: () => null }))
vi.mock("../SessionRow", () => ({
  SessionRow: ({
    session,
    onDeleteSession,
    onKill,
    onResumeSession,
  }: {
    session: ActiveSessionInfo
    onDeleteSession?: (session: ActiveSessionInfo) => void
    onKill?: (pid: number, event: MouseEvent<HTMLButtonElement>) => void
    onResumeSession?: (sessionId: string, cwd?: string) => void
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onDeleteSession?.(session)}
      >
        Delete {session.sessionId}
      </button>
      <button
        type="button"
        onClick={(event) => onKill?.(4242, event)}
      >
        Kill {session.sessionId}
      </button>
      <button
        type="button"
        onClick={() => onResumeSession?.(session.sessionId, session.cwd)}
      >
        Resume {session.sessionId}
      </button>
    </div>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

function clearCacheAt(pathname: string): void {
  window.history.replaceState(null, "", pathname)
  clearSessionListCache()
}

function session(sessionId: string): ActiveSessionInfo {
  return {
    dirName: "project-a",
    projectShortName: "project-a",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    lastModified: "2026-07-20T10:00:00Z",
    size: 100,
  }
}

beforeEach(() => {
  localStorage.clear()
  clearSessionListCache()
  vi.clearAllMocks()
  mocks.authFetch.mockReturnValue(new Promise<Response>(() => {}))
})

afterEach(() => {
  cleanup()
  clearSessionListCache()
})

describe("LiveSessions committed-state synchronization", () => {
  it("keeps consecutive delete events and the cached inventory in lockstep", () => {
    writeCachedList(sessionListCacheKeys.activeSessions, [session("one"), session("two")])

    render(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
        onDeleteSession={mocks.onDeleteSession}
      />,
    )

    const firstDelete = screen.getByRole("button", { name: "Delete one" })
    const secondDelete = screen.getByRole("button", { name: "Delete two" })

    act(() => {
      fireEvent.click(firstDelete)
      fireEvent.click(secondDelete)
    })

    expect(mocks.onDeleteSession).toHaveBeenCalledTimes(2)
    expect(readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions)).toEqual([])
    expect(screen.queryByRole("button", { name: /Delete (one|two)/ })).not.toBeInTheDocument()
  })

  it("installs the imperative refresh after commit and releases only its own callback", () => {
    const firstRefreshRef: MutableRefObject<(() => void) | null> = { current: null }
    const secondRefreshRef: MutableRefObject<(() => void) | null> = { current: null }

    const view = render(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
        refreshRef={firstRefreshRef}
      />,
    )

    expect(firstRefreshRef.current).toBeTypeOf("function")
    expect(mocks.authFetch).toHaveBeenCalledTimes(2)

    act(() => {
      void firstRefreshRef.current?.()
    })
    expect(mocks.authFetch).toHaveBeenCalledTimes(4)

    view.rerender(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
        refreshRef={secondRefreshRef}
      />,
    )

    expect(firstRefreshRef.current).toBeNull()
    expect(secondRefreshRef.current).toBeTypeOf("function")

    view.unmount()
    expect(secondRefreshRef.current).toBeNull()
  })
})

describe("LiveSessions device and unmount lifecycle", () => {
  it("aborts the old device request and never writes its deferred result into the new device cache", async () => {
    clearCacheAt("/d/device-a/")
    clearCacheAt("/d/device-b/")
    window.history.replaceState(null, "", "/d/device-a/")

    const deviceASessions = deferred<Response>()
    const deviceAProcesses = deferred<Response>()
    mocks.authFetch
      .mockReset()
      .mockReturnValueOnce(deviceASessions.promise)
      .mockReturnValueOnce(deviceAProcesses.promise)
      .mockResolvedValueOnce(jsonResponse([session("device-b")]))
      .mockResolvedValueOnce(jsonResponse([]))

    const deviceAView = render(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
      />,
    )

    const deviceASignals = mocks.authFetch.mock.calls.slice(0, 2).map(([, init]) =>
      (init as RequestInit | undefined)?.signal,
    )

    window.history.replaceState(null, "", "/d/device-b/")
    deviceAView.unmount()

    expect(deviceASignals).toHaveLength(2)
    expect(deviceASignals.every((signal) => signal?.aborted)).toBe(true)

    const deviceBView = render(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
      />,
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole("button", { name: "Delete device-b" })).toBeInTheDocument()
    expect(readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions)).toEqual([
      session("device-b"),
    ])

    await act(async () => {
      deviceASessions.resolve(jsonResponse([session("device-a")]))
      deviceAProcesses.resolve(jsonResponse([]))
      await Promise.all([deviceASessions.promise, deviceAProcesses.promise])
      await Promise.resolve()
    })

    expect(readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions)).toEqual([
      session("device-b"),
    ])

    window.history.replaceState(null, "", "/d/device-a/")
    expect(readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions)).toBeUndefined()

    deviceBView.unmount()
  })

  it("clears delayed kill and resume work when the component unmounts", async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, "", "/")
    writeCachedList(sessionListCacheKeys.activeSessions, [session("timer-session")])
    mocks.authFetch.mockImplementation((input) => {
      if (input === "/api/kill-process") return Promise.resolve(jsonResponse({}))
      return new Promise<Response>(() => {})
    })

    const view = render(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Kill timer-session" }))
    fireEvent.click(screen.getByRole("button", { name: "Resume timer-session" }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.ptySend).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3)
    const callsBeforeUnmount = mocks.authFetch.mock.calls.length

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })

    expect(mocks.authFetch).toHaveBeenCalledTimes(callsBeforeUnmount)
    vi.useRealTimers()
  })
})
