import type { ButtonHTMLAttributes, MouseEvent, MutableRefObject, ReactElement, ReactNode } from "react"
import { cloneElement, isValidElement } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActiveSessionInfo } from "../types"
import {
  clearSessionListCache,
  readCachedList,
  sessionListCacheKeys,
  writeCachedList,
} from "@/lib/sessionListCache"
import { SessionInventoryProvider } from "@/contexts/SessionInventoryContext"
import { LiveSessions } from "../index"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { MEMBER_CAPABILITIES } from "../../../../shared/contracts/team"
import {
  __resetDeviceRevisionsForTest,
  recordDeviceConnectionRevision,
} from "@/lib/device"

/**
 * The inventory (fetching, aborting, caching) moved to SessionInventoryProvider
 * so Mission Control can share it. These tests still exercise the same
 * guarantees end to end, now through the provider seam.
 *
 * The permission poll is stubbed out: these assertions count inventory requests,
 * and a second poller sharing the authFetch mock would make them meaningless.
 */
function renderLive(ui: ReactNode) {
  return render(<>{ui}</>, { wrapper: SessionInventoryProvider })
}

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  onDeleteSession: vi.fn(),
  ptySend: vi.fn(),
  renameProject: vi.fn(),
  renameSession: vi.fn(),
  setCollapsedGroups: vi.fn(),
  projectScope: null as string | null,
  setProjectScope: vi.fn(),
  showArchived: false,
  setShowArchived: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}))

vi.mock("@/lib/auth", () => ({
  authFetch: mocks.authFetch,
  authUrl: (path: string) => path,
  jsonFetch: (input: string, body: unknown, init: RequestInit = {}) => mocks.authFetch(input, {
    method: "POST",
    ...init,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
}))
vi.mock("@/contexts/PendingHumanInputContext", () => ({
  usePendingHumanInput: () => ({
    permissionsBySession: new Map(),
    questionsBySession: new Map(),
    elicitationsBySession: new Map(),
    dialogsBySession: new Map(),
    awaitingPermission: new Set(),
    awaitingQuestion: new Set(),
    awaitingElicitation: new Set(),
    awaitingDialog: new Set(),
    awaitingPlan: new Set(),
    responding: new Set(),
    respond: vi.fn(),
    answerQuestion: vi.fn(),
    answerElicitation: vi.fn(),
    answerDialog: vi.fn(),
    refresh: vi.fn(),
  }),
}))
vi.mock("@/contexts/PtyContext", () => ({ usePty: () => ({ send: mocks.ptySend }) }))
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }))
vi.mock("@/hooks/useLocalStorage", () => ({
  useLocalStorage: (key: string) => {
    if (key.includes("show-archived")) return [mocks.showArchived, mocks.setShowArchived]
    if (key.includes("project-scope")) return [mocks.projectScope, mocks.setProjectScope]
    return [{}, mocks.setCollapsedGroups]
  },
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
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: renderProp, children }: { render?: ReactElement; children?: ReactNode }) => (
    isValidElement(renderProp)
      ? cloneElement(renderProp as ReactElement<{ children?: ReactNode }>, {}, children)
      : <>{children}</>
  ),
  TooltipContent: () => null,
}))
vi.mock("../AttentionStrip", () => ({ AttentionStrip: () => null }))
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("../SessionRow", () => ({
  SessionRow: ({
    session,
    onDeleteSession,
    onArchiveSession,
    onUnarchiveSession,
    onKill,
    onResumeSession,
  }: {
    session: ActiveSessionInfo
    onDeleteSession?: (session: ActiveSessionInfo) => void
    onArchiveSession?: (session: ActiveSessionInfo) => void
    onUnarchiveSession?: (session: ActiveSessionInfo) => void
    onKill?: (pid: number, event: MouseEvent<HTMLButtonElement>) => void
    onResumeSession?: (sessionId: string, cwd: string | undefined, dirName: string) => void
  }) => (
    <div data-archived={session.archived || undefined}>
      <button
        type="button"
        onClick={() => onDeleteSession?.(session)}
      >
        Delete {session.sessionId}
      </button>
      {session.archived ? (
        <button type="button" onClick={() => onUnarchiveSession?.(session)}>
          Restore {session.sessionId}
        </button>
      ) : (
        <button type="button" onClick={() => onArchiveSession?.(session)}>
          Archive {session.sessionId}
        </button>
      )}
      {onKill && (
        <button
          type="button"
          onClick={(event) => onKill(4242, event)}
        >
          Kill {session.sessionId}
        </button>
      )}
      {onResumeSession && (
        <button
          type="button"
          onClick={() => onResumeSession(session.sessionId, session.cwd, session.dirName)}
        >
          Resume {session.sessionId}
        </button>
      )}
    </div>
  ),
}))
// The list renders cards for top-level sessions and rows for teammates;
// both use the row stand-in so these tests can act on either.
vi.mock("../SessionCard", async () => {
  const { SessionRow } = await import("../SessionRow")
  return {
    SessionCard: (props: Parameters<typeof SessionRow>[0]) => (
      <div data-testid={`card-${props.session.sessionId}`}>
        <SessionRow {...props} />
      </div>
    ),
  }
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, ok = true): Response {
  return {
    ok,
    headers: new Headers(headers),
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

Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
  __resetCapabilitiesForTest()
  __resetDeviceRevisionsForTest()
  mocks.showArchived = false
  mocks.projectScope = null
  localStorage.clear()
  clearSessionListCache()
  vi.clearAllMocks()
  mocks.authFetch.mockReturnValue(new Promise<Response>(() => {}))
})

afterEach(() => {
  __resetCapabilitiesForTest()
  __resetDeviceRevisionsForTest()
  cleanup()
  clearSessionListCache()
})

describe("LiveSessions committed-state synchronization", () => {
  it("does not expose or send a PTY resume action for a member", () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: { id: "u_member", username: "member", displayName: "Member", role: "member", createdAt: 1 },
      capabilities: MEMBER_CAPABILITIES,
    })
    writeCachedList(sessionListCacheKeys.activeSessions, [session("member-session")])

    renderLive(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.queryByRole("button", { name: "Resume member-session" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Kill member-session" })).not.toBeInTheDocument()
    expect(mocks.ptySend).not.toHaveBeenCalled()
    expect(mocks.authFetch.mock.calls.some(([url]) => url === "/api/kill-process")).toBe(false)
  })

  // Every deferred resume used to spawn `claude -p --resume <id>` unless the
  // project was Copilot's, so a Codex session was resumed with the wrong binary.
  it.each([
    ["-tmp-project", "claude", ["--resume", "deferred-session"]],
    ["codex__L3RtcC9wcm9qZWN0", "codex", ["resume", "deferred-session"]],
    ["copilot__L3RtcC9wcm9qZWN0", "copilot", ["--resume=deferred-session"]],
  ])("resumes a deferred session in %s with its own CLI", (dirName, command, args) => {
    window.history.replaceState(null, "", "/")
    writeCachedList(sessionListCacheKeys.activeSessions, [{
      ...session("deferred-session"),
      dirName,
      cwd: "/tmp/project",
      agentStatus: "deferred",
    }])

    renderLive(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Resume deferred-session" }))

    expect(mocks.ptySend).toHaveBeenCalledWith(expect.objectContaining({
      command,
      args,
      cwd: "/tmp/project",
    }))
  })

  it("keeps consecutive delete events and the cached inventory in lockstep", () => {
    writeCachedList(sessionListCacheKeys.activeSessions, [session("one"), session("two")])

    renderLive(
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

    const view = renderLive(
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
  it("rejects an old inventory completion after a same-id connection revision remount", async () => {
    window.history.replaceState(null, "", "/d/device-a/")
    recordDeviceConnectionRevision("device-a", 1)
    clearSessionListCache()
    const oldSessions = deferred<Response>()
    const oldProcesses = deferred<Response>()
    mocks.authFetch
      .mockReset()
      .mockReturnValueOnce(oldSessions.promise)
      .mockReturnValueOnce(oldProcesses.promise)
      .mockResolvedValueOnce(jsonResponse([session("new-target")]))
      .mockResolvedValueOnce(jsonResponse([]))

    const oldView = renderLive(
      <LiveSessions activeSessionKey={null} onSelectSession={vi.fn()} />,
    )
    recordDeviceConnectionRevision("device-a", 2)
    oldView.unmount()
    const newView = renderLive(
      <LiveSessions activeSessionKey={null} onSelectSession={vi.fn()} />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions)).toEqual([
      session("new-target"),
    ])

    await act(async () => {
      oldSessions.resolve(jsonResponse([session("old-target")]))
      oldProcesses.resolve(jsonResponse([]))
      await Promise.all([oldSessions.promise, oldProcesses.promise])
      await Promise.resolve()
    })
    expect(readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions)).toEqual([
      session("new-target"),
    ])
    newView.unmount()
  })

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

    const deviceAView = renderLive(
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

    const deviceBView = renderLive(
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

    const view = renderLive(
      <LiveSessions
        activeSessionKey={null}
        onSelectSession={vi.fn()}
      />,
    )
    const unrelatedTimerCount = vi.getTimerCount()

    fireEvent.click(screen.getByRole("button", { name: "Kill timer-session" }))
    fireEvent.click(screen.getByRole("button", { name: "Resume timer-session" }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.ptySend).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(unrelatedTimerCount + 3)
    const callsBeforeUnmount = mocks.authFetch.mock.calls.length

    view.unmount()
    expect(vi.getTimerCount()).toBe(unrelatedTimerCount)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })

    expect(mocks.authFetch).toHaveBeenCalledTimes(callsBeforeUnmount)
    vi.useRealTimers()
  })
})

describe("LiveSessions archiving", () => {
  function archiveCalls() {
    return mocks.authFetch.mock.calls.filter(([input]) => input === "/api/archive-sessions")
  }

  function renderWithSessions(...ids: string[]) {
    window.history.replaceState(null, "", "/")
    writeCachedList(sessionListCacheKeys.activeSessions, ids.map(session))
    return renderLive(
      <LiveSessions activeSessionKey={null} onSelectSession={vi.fn()} />,
    )
  }

  it("hides an archived session at once, persists it, and can undo from the toast", async () => {
    mocks.authFetch.mockImplementation((input) => {
      if (input === "/api/archive-sessions") return Promise.resolve(jsonResponse({}))
      return new Promise<Response>(() => {})
    })
    renderWithSessions("keep", "done")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive done" }))
    })

    expect(screen.queryByRole("button", { name: /done$/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Archive keep" })).toBeInTheDocument()
    expect(archiveCalls()).toHaveLength(1)
    expect(JSON.parse(String(archiveCalls()[0][1]?.body))).toEqual({ sessionIds: ["done"], archived: true })
    expect(readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions)).toEqual([
      session("keep"),
      expect.objectContaining({ sessionId: "done", archived: true }),
    ])
    expect(mocks.toast).toHaveBeenCalledWith("Archived “done”", expect.objectContaining({
      action: expect.objectContaining({ label: "Undo" }),
    }))

    const { action } = mocks.toast.mock.calls[0][1] as { action: { onClick: () => void } }
    await act(async () => {
      action.onClick()
    })

    expect(screen.getByRole("button", { name: "Archive done" })).toBeInTheDocument()
    expect(JSON.parse(String(archiveCalls()[1][1]?.body))).toEqual({ sessionIds: ["done"], archived: false })
  })

  it("puts the session back and reports when the server refuses", async () => {
    mocks.authFetch.mockImplementation((input) => {
      if (input === "/api/archive-sessions") return Promise.resolve(jsonResponse({}, {}, false))
      return new Promise<Response>(() => {})
    })
    renderWithSessions("done")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive done" }))
    })

    expect(screen.getByRole("button", { name: "Archive done" })).toBeInTheDocument()
    expect(mocks.toast.error).toHaveBeenCalledWith("Could not archive session")
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it("asks the server for archived sessions while searching and shows them", async () => {
    const archivedRow = { ...session("old-work"), firstUserMessage: "old work", archived: true }
    mocks.authFetch.mockImplementation((input) => {
      if (input === "/api/active-sessions") {
        return Promise.resolve(jsonResponse([session("keep")], { "X-Cogpit-Archived-Count": "1" }))
      }
      if (input === "/api/active-sessions?archived=include") {
        return Promise.resolve(jsonResponse([session("keep"), archivedRow], { "X-Cogpit-Archived-Count": "1" }))
      }
      if (input === "/api/running-processes") return Promise.resolve(jsonResponse([]))
      return new Promise<Response>(() => {})
    })
    window.history.replaceState(null, "", "/")
    renderLive(<LiveSessions activeSessionKey={null} onSelectSession={vi.fn()} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole("button", { name: "Restore old-work" })).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old work" } })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/active-sessions?archived=include", expect.anything())
    expect(screen.getByRole("button", { name: "Restore old-work" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Archive keep" })).not.toBeInTheDocument()
  })

  it("persists the toolbar toggle and lists archived sessions while it is on", async () => {
    const archivedRow = { ...session("old-work"), archived: true }
    mocks.authFetch.mockImplementation((input) => {
      if (input === "/api/active-sessions?archived=include") {
        return Promise.resolve(jsonResponse([session("keep"), archivedRow], { "X-Cogpit-Archived-Count": "1" }))
      }
      if (input === "/api/running-processes") return Promise.resolve(jsonResponse([]))
      return new Promise<Response>(() => {})
    })
    mocks.showArchived = true
    window.history.replaceState(null, "", "/")
    renderLive(<LiveSessions activeSessionKey={null} onSelectSession={vi.fn()} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/active-sessions?archived=include", expect.anything())
    expect(mocks.authFetch).not.toHaveBeenCalledWith("/api/active-sessions", expect.anything())
    expect(screen.getByRole("button", { name: "Restore old-work" })).toBeInTheDocument()

    const toggle = screen.getByRole("button", { name: "Hide archived sessions" })
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(toggle)
    expect(mocks.setShowArchived).toHaveBeenCalledWith(false)
  })
})

describe("LiveSessions focused on a project", () => {
  function inventory(...rows: ActiveSessionInfo[]) {
    mocks.authFetch.mockImplementation((input: string) => {
      if (input.startsWith("/api/active-sessions")) return Promise.resolve(jsonResponse(rows))
      if (input === "/api/running-processes") return Promise.resolve(jsonResponse([]))
      return new Promise<Response>(() => {})
    })
  }

  it("lists only the focused project's sessions as cards and names it in the picker", async () => {
    window.history.replaceState(null, "", "/")
    mocks.projectScope = "me/lib"
    inventory(
      { ...session("app-1"), cwd: "/home/me/app" },
      { ...session("lib-1"), dirName: "-home-me-lib", cwd: "/home/me/lib" },
    )

    await act(async () => {
      renderLive(<LiveSessions activeSessionKey={null} onSelectSession={vi.fn()} onNewSession={vi.fn()} />)
    })

    expect(screen.getByTestId("card-lib-1")).toBeInTheDocument()
    expect(screen.queryByTestId("card-app-1")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete app-1" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Focused on me/lib. Change project" })).toHaveTextContent("1 session")
    expect(screen.getByRole("button", { name: "New session in me/lib" })).toBeInTheDocument()
  })

  it("loads the project's older sessions on request and merges them in", async () => {
    window.history.replaceState(null, "", "/")
    mocks.projectScope = "me/app"
    mocks.authFetch.mockImplementation((input: string) => {
      if (input.startsWith("/api/active-sessions?project=")) {
        return Promise.resolve(jsonResponse([
          { ...session("app-1"), cwd: "/home/me/app" },
          { ...session("app-old"), cwd: "/home/me/app", lastModified: "2026-01-01T10:00:00Z" },
        ]))
      }
      if (input.startsWith("/api/active-sessions")) {
        return Promise.resolve(jsonResponse([{ ...session("app-1"), cwd: "/home/me/app" }]))
      }
      if (input === "/api/running-processes") return Promise.resolve(jsonResponse([]))
      return new Promise<Response>(() => {})
    })

    await act(async () => {
      renderLive(<LiveSessions activeSessionKey={null} onSelectSession={vi.fn()} />)
    })
    expect(screen.queryByTestId("card-app-old")).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older sessions" }))
    })

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/active-sessions?project=project-a&limit=200")
    expect(screen.getAllByTestId(/^card-/).map((card) => card.getAttribute("data-testid"))).toEqual(["card-app-1", "card-app-old"])
    expect(screen.queryByRole("button", { name: "Load older sessions" })).not.toBeInTheDocument()
  })
})

describe("LiveSessions across every project", () => {
  it("lists every session as one flat run of cards and loads older ones in a single request", async () => {
    window.history.replaceState(null, "", "/")
    mocks.authFetch.mockImplementation((input: string) => {
      if (input.startsWith("/api/active-sessions?")) {
        return Promise.resolve(jsonResponse([
          { ...session("app-1"), cwd: "/home/me/app", lastModified: "2026-09-11T10:00:00Z" },
          { ...session("lib-old"), dirName: "-home-me-lib", cwd: "/home/me/lib", lastModified: "2026-01-01T10:00:00Z" },
        ]))
      }
      if (input === "/api/active-sessions") {
        return Promise.resolve(jsonResponse([{ ...session("app-1"), cwd: "/home/me/app", lastModified: "2026-09-11T10:00:00Z" }]))
      }
      if (input === "/api/running-processes") return Promise.resolve(jsonResponse([]))
      return new Promise<Response>(() => {})
    })

    await act(async () => {
      renderLive(<LiveSessions activeSessionKey={null} onSelectSession={vi.fn()} />)
    })
    expect(screen.getByTestId("card-app-1")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^me\/app/ })).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older sessions" }))
    })

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/active-sessions?limit=200&perProject=100")
    expect(screen.getAllByTestId(/^card-/).map((card) => card.getAttribute("data-testid"))).toEqual(["card-app-1", "card-lib-old"])
  })
})
