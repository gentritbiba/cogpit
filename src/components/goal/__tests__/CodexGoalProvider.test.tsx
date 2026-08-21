import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CodexGoalProvider } from "@/components/goal/CodexGoalProvider"
import { GoalControlsBlock } from "@/components/goal"
import { authFetch } from "@/lib/auth"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))

const mockedFetch = vi.mocked(authFetch)

function renderGoalUi(threadId = "thread-1") {
  return render(
    <CodexGoalProvider threadId={threadId}>
      <GoalControlsBlock />
    </CodexGoalProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("CodexGoalProvider", () => {
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

    renderGoalUi()
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

  it("costs no vertical space until a goal exists", async () => {
    mockedFetch.mockResolvedValue(new Response(JSON.stringify({ goal: null }), { status: 200 }))
    renderGoalUi()

    // Only the compact trigger renders — no goal row.
    await screen.findByRole("button", { name: /Set goal/i })
    expect(screen.queryByRole("region", { name: /Codex goal/i })).not.toBeInTheDocument()
  })

  it("hides itself when the installed runtime does not support goals", async () => {
    mockedFetch.mockResolvedValue(new Response("", { status: 501 }))
    const { container } = renderGoalUi()

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
