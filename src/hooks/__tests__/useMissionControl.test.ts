import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMissionControl } from "@/hooks/useMissionControl"
import { __resetEditionUiForTest } from "@/edition/registry"
import { installStubListFilter } from "@/__tests__/listFilter"
import type { MissionControlSummary } from "../../../shared/contracts/missionControl"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

function grid(...sessionIds: string[]): Response {
  const summaries = sessionIds.map((sessionId) => ({ sessionId }) as MissionControlSummary)
  return new Response(JSON.stringify({ summaries, generatedAt: "2026-09-23T10:00:00Z" }), { status: 200 })
}

describe("useMissionControl", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetEditionUiForTest()
  })

  it("shows the grid while the server answers slower than the poll interval", async () => {
    vi.useFakeTimers()
    mocks.authFetch.mockImplementation(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(grid("slow-session")), 5_000)
    }))
    const { result } = renderHook(() => useMissionControl())

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect([...result.current.summaries.keys()]).toEqual(["slow-session"])
    expect(result.current.loading).toBe(false)
  })

  it("applies each overlapping poll for the list on screen", async () => {
    const answers: Array<(res: Response) => void> = []
    mocks.authFetch.mockImplementation(() => new Promise<Response>((resolve) => { answers.push(resolve) }))
    const { result } = renderHook(() => useMissionControl())
    act(() => result.current.refresh())
    expect(answers).toHaveLength(2)

    await act(async () => answers[0](grid("first")))
    expect([...result.current.summaries.keys()]).toEqual(["first"])

    await act(async () => answers[1](grid("second")))
    expect([...result.current.summaries.keys()]).toEqual(["second"])
  })

  it("asks with the session list filter and never shows a grid for a filter it left", async () => {
    const filter = installStubListFilter("narrow")
    let answerNarrow!: (res: Response) => void
    mocks.authFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { answerNarrow = resolve }))
    mocks.authFetch.mockImplementation(async () => grid("other-session"))
    const { result } = renderHook(() => useMissionControl())
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/mission-control?filter=narrow")

    act(() => filter.setKey("other"))
    await waitFor(() => expect([...result.current.summaries.keys()]).toEqual(["other-session"]))
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/mission-control?filter=other")

    await act(async () => answerNarrow(grid("narrow-session")))
    expect([...result.current.summaries.keys()]).toEqual(["other-session"])
  })

  it("asks for every session without a filter", async () => {
    mocks.authFetch.mockImplementation(async () => grid("any-session"))
    renderHook(() => useMissionControl())

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/mission-control")
  })
})
