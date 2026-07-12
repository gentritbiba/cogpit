import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CodexGoalBar } from "@/components/CodexGoalBar"
import { authFetch } from "@/lib/auth"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

const mockedFetch = vi.mocked(authFetch)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("CodexGoalBar", () => {
  it("creates a long-running goal with an optional token budget", async () => {
    mockedFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ goal: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        goal: {
          threadId: "thread-1",
          objective: "Ship the native control plane",
          status: "active",
          tokenBudget: 40000,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        },
      }), { status: 200 }))

    render(<CodexGoalBar threadId="thread-1" />)
    await screen.findByRole("button", { name: /Set goal/i })
    fireEvent.click(screen.getByRole("button", { name: /Set goal/i }))
    fireEvent.change(screen.getByLabelText("Goal objective"), {
      target: { value: "Ship the native control plane" },
    })
    fireEvent.change(screen.getByLabelText("Token budget"), { target: { value: "40000" } })
    fireEvent.click(screen.getByRole("button", { name: /Save goal/i }))

    await screen.findByText("Ship the native control plane")
    expect(mockedFetch).toHaveBeenLastCalledWith(
      "/api/codex/goals/thread-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          objective: "Ship the native control plane",
          status: "active",
          tokenBudget: 40000,
        }),
      }),
    )
  })

  it("hides itself when the installed runtime does not support goals", async () => {
    mockedFetch.mockResolvedValue(new Response("", { status: 501 }))
    const { container } = render(<CodexGoalBar threadId="thread-1" />)

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
