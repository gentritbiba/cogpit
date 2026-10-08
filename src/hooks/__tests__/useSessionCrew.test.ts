import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ authFetch: vi.fn(), jsonFetch: vi.fn(), refresh: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: api.authFetch, jsonFetch: api.jsonFetch }))
vi.mock("@/hooks/useVisiblePolling", () => ({ useVisiblePolling: () => {} }))
vi.mock("@/contexts/SessionInventoryContext", () => ({ useSessionInventoryOptional: () => ({ refresh: api.refresh }) }))
import { useSessionCrew } from "../useSessionCrew"

beforeEach(() => {
  api.authFetch.mockReset()
  api.jsonFetch.mockReset()
  api.refresh.mockReset()
})

describe("useSessionCrew actions", () => {
  it("keeps a failed action visible instead of clearing it with a successful poll", async () => {
    api.jsonFetch.mockResolvedValue(new Response(null, { status: 500 }))
    const { result } = renderHook(() => useSessionCrew("lead"))
    await act(() => result.current.respond("lane", "p", { decision: "allow" }))
    expect(result.current.error).toBe("Couldn't send the answer.")
    expect(api.authFetch).not.toHaveBeenCalled()
  })

  it("does not load the previous crew after an action finishes across navigation", async () => {
    let finish!: (response: Response) => void
    api.jsonFetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve }))
    const { result, rerender } = renderHook(({ sessionId }) => useSessionCrew(sessionId), { initialProps: { sessionId: "first" } })
    let action!: Promise<void>
    act(() => { action = result.current.respond("lane", "p", { decision: "allow" }) })
    rerender({ sessionId: "second" })
    await act(async () => { finish(new Response()); await action })
    expect(api.authFetch).not.toHaveBeenCalled()
    expect(result.current.crew).toBeNull()
    expect(result.current.busy.size).toBe(0)
  })

  it("guards duplicate answers before the busy state renders", async () => {
    let finish!: (response: Response) => void
    api.jsonFetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve }))
    api.authFetch.mockResolvedValue(new Response(JSON.stringify({ rootId: "lead", members: [] })))
    const { result } = renderHook(() => useSessionCrew("lead"))
    let actions!: Promise<void>[]
    act(() => { actions = [result.current.respond("lane", "p", { decision: "allow" }), result.current.respond("lane", "p", { decision: "allow" })] })
    expect(api.jsonFetch).toHaveBeenCalledOnce()
    await act(async () => { finish(new Response()); await Promise.all(actions) })
    expect(result.current.busy.size).toBe(0)
  })
})
