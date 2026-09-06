import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { useBrowserSessions, type UseBrowserSessions } from "../useBrowserSessions"
import type { BrowserSkillTarget, BrowserStatus } from "../../../shared/browser/types"
import { AGENT_KINDS } from "../../../shared/session/agent-descriptors"

const mockedAuthFetch = vi.mocked(authFetch)
/** Any CLI the skill can be installed into; the hook only forwards the kind. */
const SKILL_TARGET = AGENT_KINDS[0]

const SKILL_TARGETS: BrowserSkillTarget[] = AGENT_KINDS.map((kind) => ({
  kind,
  label: kind,
  configRoot: `/home/me/${kind}`,
  installed: false,
  automatic: false,
}))

const STATUS: BrowserStatus = {
  installed: true,
  binaryPath: "/usr/local/bin/agent-browser",
  sessions: [{
    name: "default",
    isDefault: true,
    running: false,
    note: null,
    createdAt: null,
    lastUsedAt: null,
    lastUrl: null,
    driverSessionId: null,
  }],
}

function response(body: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  const ok = options.ok ?? true
  return {
    ok,
    status: options.status ?? (ok ? 200 : 400),
    json: async () => body,
  } as unknown as Response
}

/** Drain pending promises (and any timers up to `ms`) inside React's act(). */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function lastCall(): [string, RequestInit | undefined] {
  const call = mockedAuthFetch.mock.calls.at(-1)
  return [call?.[0] as string, call?.[1]]
}

describe("useBrowserSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockedAuthFetch.mockResolvedValue(response(STATUS))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("loads the status on mount when enabled", async () => {
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/browser")
    expect(result.current.status).toEqual(STATUS)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("stays idle while disabled", async () => {
    const { result } = renderHook(() => useBrowserSessions(false))
    await settle(20_000)

    expect(mockedAuthFetch).not.toHaveBeenCalled()
    expect(result.current.status).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it("polls every 5 seconds while enabled and stops when disabled", async () => {
    const { rerender } = renderHook(({ enabled }) => useBrowserSessions(enabled), {
      initialProps: { enabled: true },
    })
    await settle()
    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)

    await settle(5_000)
    expect(mockedAuthFetch).toHaveBeenCalledTimes(2)

    await settle(5_000)
    expect(mockedAuthFetch).toHaveBeenCalledTimes(3)

    rerender({ enabled: false })
    await settle(20_000)
    expect(mockedAuthFetch).toHaveBeenCalledTimes(3)
  })

  it("does not stack requests while one is in flight", async () => {
    mockedAuthFetch.mockReturnValue(new Promise(() => {}) as Promise<Response>)
    renderHook(() => useBrowserSessions(true))
    await settle(20_000)

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
  })

  it("reports a failed status request without throwing", async () => {
    mockedAuthFetch.mockRejectedValue(new Error("Network error"))
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()

    expect(result.current.error).toBe("Network error")
    expect(result.current.loading).toBe(false)
  })

  it("creates a browser and refreshes the list", async () => {
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.create("github", "work login")
    })

    expect(outcome).toEqual({ ok: true })
    expect(mockedAuthFetch).toHaveBeenNthCalledWith(2, "/api/browser/sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "github", note: "work login" }),
    }))
    expect(mockedAuthFetch).toHaveBeenNthCalledWith(3, "/api/browser")
  })

  it("returns a name conflict as a result instead of throwing", async () => {
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()
    mockedAuthFetch.mockResolvedValueOnce(
      response({ error: 'Browser "github" already exists' }, { ok: false, status: 409 }),
    )

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.create("github")
    })

    expect(outcome).toEqual({ ok: false, error: 'Browser "github" already exists' })
    // A conflict belongs next to the name field, not in the panel-wide banner.
    expect(result.current.error).toBeNull()
  })

  it.each([
    ["remove", (hook: UseBrowserSessions) => hook.remove("../x"), "DELETE", "/api/browser/sessions/..%2Fx", undefined],
    ["launch", (hook: UseBrowserSessions) => hook.launch("github", "https://x"), "POST", "/api/browser/sessions/github/launch", JSON.stringify({ url: "https://x" })],
    ["launch without a url", (hook: UseBrowserSessions) => hook.launch("github"), "POST", "/api/browser/sessions/github/launch", "{}"],
    ["stop", (hook: UseBrowserSessions) => hook.stop("github"), "POST", "/api/browser/sessions/github/stop", undefined],
    ["setNote", (hook: UseBrowserSessions) => hook.setNote("github", "work"), "PATCH", "/api/browser/sessions/github", JSON.stringify({ note: "work" })],
    ["installSkill", (hook: UseBrowserSessions) => hook.installSkill(SKILL_TARGET), "POST", "/api/browser/skill/install", JSON.stringify({ target: SKILL_TARGET })],
  ])("sends %s to the right endpoint", async (_name, call, method, path, body) => {
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()

    await act(async () => {
      await call(result.current)
    })

    const [url, init] = mockedAuthFetch.mock.calls[1] as [string, RequestInit]
    expect(url).toBe(path)
    expect(init.method).toBe(method)
    expect(init.body).toBe(body)
  })

  it("returns the paths the install wrote", async () => {
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()
    mockedAuthFetch.mockResolvedValueOnce(response({ paths: ["/home/me/skills/cogpit-browser"] }))

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.installSkill("all")
    })

    expect(outcome).toEqual({ ok: true, paths: ["/home/me/skills/cogpit-browser"] })
    const [url, init] = mockedAuthFetch.mock.calls[1] as [string, RequestInit]
    expect(url).toBe("/api/browser/skill/install")
    expect(init.body).toBe(JSON.stringify({ target: "all" }))
  })

  it("reads where the skill can be installed without disturbing the status poll", async () => {
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()
    mockedAuthFetch.mockResolvedValueOnce(response({ targets: SKILL_TARGETS }))

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.readSkillTargets()
    })

    expect(outcome).toEqual({ ok: true, targets: SKILL_TARGETS })
    // A read is not a mutation: it must not trigger the refresh a mutation does.
    expect(lastCall()[0]).toBe("/api/browser/skill")
  })

  it("reports a failed skill read as a result", async () => {
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()
    mockedAuthFetch.mockResolvedValueOnce(response({ error: "no" }, { ok: false, status: 500 }))

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.readSkillTargets()
    })

    expect(outcome).toEqual({ ok: false, error: "no" })
    expect(result.current.error).toBeNull()
  })

  it("refreshes after a mutation succeeds", async () => {
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()

    await act(async () => {
      await result.current.stop("github")
    })

    expect(lastCall()).toEqual(["/api/browser", undefined])
  })

  it("refreshes after a mutation even while a status request is still out", async () => {
    mockedAuthFetch.mockImplementation((url) => url === "/api/browser"
      ? new Promise<Response>(() => {})
      : Promise.resolve(response({ ok: true })))
    const { result } = renderHook(() => useBrowserSessions(true))
    await settle()

    await act(async () => {
      await result.current.stop("github")
    })

    expect(mockedAuthFetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser",
      "/api/browser/sessions/github/stop",
      "/api/browser",
    ])
  })

  it("cancels the poll on unmount without updating state afterwards", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { unmount } = renderHook(() => useBrowserSessions(true))
    await settle()

    unmount()
    await settle(20_000)

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    warn.mockRestore()
    error.mockRestore()
  })
})
