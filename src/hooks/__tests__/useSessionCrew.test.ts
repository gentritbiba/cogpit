import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CrewMember, SessionCrew } from "../../../shared/contracts/crew"

const api = vi.hoisted(() => ({ authFetch: vi.fn(), jsonFetch: vi.fn(), refresh: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: api.authFetch, jsonFetch: api.jsonFetch }))
vi.mock("@/contexts/SessionInventoryContext", () => ({ useSessionInventoryOptional: () => ({ refresh: api.refresh }) }))
import { ACTIVE_POLL_MS, SETTLED_POLL_MS, shareCrew, useSessionCrew } from "../useSessionCrew"

const member = (sessionId: string, patch: Partial<CrewMember> = {}): CrewMember => ({
  sessionId, parentId: sessionId === "lead" ? null : "lead", startedAt: sessionId === "lead" ? null : 1, device: null, address: null, outcome: "completed", waiting: [], ...patch,
})
const crewOf = (...members: CrewMember[]): SessionCrew => ({ sessionId: "lead", rootId: "lead", members })
const answer = (crew: SessionCrew, etag = '"v1"') => Response.json(crew, { headers: { ETag: etag } })
const urls = () => api.authFetch.mock.calls.map(([url]) => url as string)

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  api.authFetch.mockReset().mockImplementation(async () => answer(crewOf(member("lead"))))
  api.jsonFetch.mockReset()
  api.refresh.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe("useSessionCrew polling", () => {
  it("asks for the brief crew and keeps the same crew on 304", async () => {
    api.authFetch.mockResolvedValueOnce(answer(crewOf(member("lead"), member("lane"))))
    api.authFetch.mockResolvedValue(new Response(null, { status: 304 }))
    const { result } = renderHook(() => useSessionCrew("lead"))
    await waitFor(() => expect(result.current.crew?.members).toHaveLength(2))
    const first = result.current.crew
    expect(urls()[0]).toBe("/api/session-crew/lead?brief=1")
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLED_POLL_MS) })
    expect(api.authFetch).toHaveBeenCalledTimes(2)
    expect(new Headers(api.authFetch.mock.calls[1]![1].headers).get("If-None-Match")).toBe('"v1"')
    expect(result.current.crew).toBe(first)
    expect(result.current.error).toBeNull()
  })

  it("reads often while a member works and slowly once every member settled", async () => {
    api.authFetch.mockResolvedValue(answer(crewOf(member("lead"), member("lane", { outcome: "running" }))))
    const { result } = renderHook(() => useSessionCrew("lead"))
    await waitFor(() => expect(result.current.crew).not.toBeNull())
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS) })
    expect(api.authFetch).toHaveBeenCalledTimes(2)

    api.authFetch.mockResolvedValue(answer(crewOf(member("lead"), member("lane")), '"v2"'))
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS) })
    expect(api.authFetch).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVE_POLL_MS) })
    expect(api.authFetch).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(SETTLED_POLL_MS - ACTIVE_POLL_MS) })
    expect(api.authFetch).toHaveBeenCalledTimes(4)
  })

  it("says when the session is gone", async () => {
    api.authFetch.mockResolvedValue(new Response(null, { status: 404 }))
    const { result } = renderHook(() => useSessionCrew("lead"))
    await waitFor(() => expect(result.current.error).toBe("This session is no longer available."))
  })
})

describe("shareCrew", () => {
  it("keeps every unchanged member, and the crew itself when nothing changed", () => {
    const current = crewOf(member("lead"), member("a"), member("b"))
    const same = crewOf(member("lead"), member("a"), member("b"))
    expect(shareCrew(current, same)).toBe(current)

    const next = shareCrew(current, crewOf(member("lead"), member("a", { outcome: "running" }), member("b")))
    expect(next).not.toBe(current)
    expect(next.members[0]).toBe(current.members[0])
    expect(next.members[1]).not.toBe(current.members[1])
    expect(next.members[2]).toBe(current.members[2])
  })

  it("is a new crew when members are added or reordered", () => {
    const current = crewOf(member("lead"), member("a"))
    const grown = shareCrew(current, crewOf(member("lead"), member("a"), member("b")))
    expect(grown).not.toBe(current)
    expect(grown.members[1]).toBe(current.members[1])
    expect(shareCrew(current, crewOf(member("a"), member("lead")))).not.toBe(current)
  })
})

describe("useSessionCrew actions", () => {
  it("keeps a failed action visible instead of clearing it with a successful poll", async () => {
    api.jsonFetch.mockResolvedValue(new Response(null, { status: 500 }))
    const { result } = renderHook(() => useSessionCrew("lead"))
    await waitFor(() => expect(result.current.crew).not.toBeNull())
    await act(() => result.current.respond("lane", "p", { decision: "allow" }))
    expect(result.current.error).toBe("Couldn't send the answer.")
    expect(api.authFetch).toHaveBeenCalledOnce()
  })

  it("reads the crew again right after an action", async () => {
    api.jsonFetch.mockResolvedValue(new Response())
    const { result } = renderHook(() => useSessionCrew("lead"))
    await waitFor(() => expect(result.current.crew).not.toBeNull())
    await act(() => result.current.markRead("lead", "task-1"))
    expect(api.authFetch).toHaveBeenCalledTimes(2)
    expect(api.refresh).toHaveBeenCalledOnce()
  })

  it("does not load the previous crew after an action finishes across navigation", async () => {
    let finish!: (response: Response) => void
    api.jsonFetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve }))
    api.authFetch.mockImplementation(async (url: string) => (url.includes("first") ? answer(crewOf(member("lead"))) : new Response(null, { status: 500 })))
    const { result, rerender } = renderHook(({ sessionId }) => useSessionCrew(sessionId), { initialProps: { sessionId: "first" } })
    await waitFor(() => expect(result.current.crew).not.toBeNull())
    let action!: Promise<void>
    act(() => { action = result.current.respond("lane", "p", { decision: "allow" }) })
    rerender({ sessionId: "second" })
    await act(async () => { finish(new Response()); await action })
    expect(urls().filter((url) => url.includes("first"))).toHaveLength(1)
    expect(result.current.crew).toBeNull()
    expect(result.current.busy.size).toBe(0)
  })

  it("guards duplicate answers before the busy state renders", async () => {
    let finish!: (response: Response) => void
    api.jsonFetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve }))
    const { result } = renderHook(() => useSessionCrew("lead"))
    let actions!: Promise<void>[]
    act(() => { actions = [result.current.respond("lane", "p", { decision: "allow" }), result.current.respond("lane", "p", { decision: "allow" })] })
    expect(api.jsonFetch).toHaveBeenCalledOnce()
    await act(async () => { finish(new Response()); await Promise.all(actions) })
    expect(result.current.busy.size).toBe(0)
  })
})
