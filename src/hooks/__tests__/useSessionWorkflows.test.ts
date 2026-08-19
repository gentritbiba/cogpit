import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockedUseWorkflowLive } = vi.hoisted(() => ({
  mockedUseWorkflowLive: vi.fn(() => ({ isLive: false })),
}))

vi.mock("../useWorkflowLive", () => ({ useWorkflowLive: mockedUseWorkflowLive }))
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

import { authFetch } from "@/lib/auth"
import { useSessionWorkflows } from "../useSessionWorkflows"

const mockedAuthFetch = vi.mocked(authFetch)

describe("useSessionWorkflows", () => {
  beforeEach(() => {
    mockedAuthFetch.mockReset()
    mockedUseWorkflowLive.mockClear()
  })

  it("does nothing until the project and session are known", () => {
    renderHook(() => useSessionWorkflows(null, null, false))

    expect(mockedAuthFetch).not.toHaveBeenCalled()
    expect(mockedUseWorkflowLive).toHaveBeenLastCalledWith(null, null, null, expect.any(Function))
  })

  it("discovers saved workflows even when the transcript call is outside the loaded window", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ runId: "wf_old", workflowName: "Older workflow" }],
    } as Response)

    const { result } = renderHook(() => useSessionWorkflows("project", "session", false))

    await waitFor(() => expect(result.current.workflows).toHaveLength(1))
    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/workflows/project/session")
    expect(mockedUseWorkflowLive).toHaveBeenLastCalledWith(
      "project",
      "session",
      null,
      expect.any(Function),
    )
  })

  it("does not keep a filesystem watcher open when discovery is empty", async () => {
    mockedAuthFetch.mockResolvedValueOnce({ ok: true, json: async () => [] } as Response)

    const { result } = renderHook(() => useSessionWorkflows("project", "session", false))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockedUseWorkflowLive).toHaveBeenLastCalledWith(null, null, null, expect.any(Function))
  })

  it("ignores a slower response from the previously opened session", async () => {
    let resolveFirst: ((value: Response) => void) | undefined
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve })
    mockedAuthFetch
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ runId: "wf_new", workflowName: "New session workflow" }],
      } as Response)

    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionWorkflows("project", sessionId, false),
      { initialProps: { sessionId: "old-session" } },
    )

    rerender({ sessionId: "new-session" })
    await waitFor(() => expect(result.current.workflows[0]?.runId).toBe("wf_new"))

    resolveFirst?.({
      ok: true,
      json: async () => [{ runId: "wf_old", workflowName: "Old session workflow" }],
    } as Response)

    await waitFor(() => expect(result.current.workflows[0]?.runId).toBe("wf_new"))
  })
})
