import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { authFetch } from "@/lib/auth"
import type { WorkflowAgent } from "@/lib/workflow-types"
import { WorkflowAgentCard } from "../WorkflowAgentCard"
import { WorkflowResponse } from "../WorkflowResponse"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  authUrl: (url: string) => url,
}))

const mockedAuthFetch = vi.mocked(authFetch)

describe("WorkflowResponse", () => {
  it("turns structured results into labeled sections instead of raw JSON", () => {
    render(
      <WorkflowResponse value={{
        headline: "The useful answer",
        findings: [
          {
            title: "First finding",
            whyItHurts: "The current screen hides the response.",
            proposal: "Put the response first.",
          },
        ],
        quickWins: ["Render Markdown", "Keep JSON labels readable"],
      }} />,
    )

    expect(screen.getByText("The useful answer")).toBeInTheDocument()
    expect(screen.getByText("Findings")).toBeInTheDocument()
    expect(screen.getByText("First finding")).toBeInTheDocument()
    expect(screen.getByText("Why it hurts")).toBeInTheDocument()
    expect(screen.getByText("Quick wins")).toBeInTheDocument()
    expect(screen.queryByText(/"headline"/)).not.toBeInTheDocument()
  })

  it("renders Markdown responses with their document structure", () => {
    render(<WorkflowResponse value={"## Recommendation\n\n**Keep** the response readable.\n\n- First\n- Second"} />)

    expect(screen.getByRole("heading", { name: "Recommendation" })).toBeInTheDocument()
    expect(screen.getByText("Keep").tagName).toBe("STRONG")
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
  })

  it("extracts a useful sentence from a shortened JSON preview", () => {
    render(
      <WorkflowResponse value={'{"lens":"UI density","headline":"Show the answer before the telemetry","findings":[{"title":"Cut off…'} />,
    )

    expect(screen.getByText("Show the answer before the telemetry")).toBeInTheDocument()
    expect(screen.getByText("Only a shortened preview was saved for this response.")).toBeInTheDocument()
  })
})

describe("WorkflowAgentCard", () => {
  const agent: WorkflowAgent = {
    type: "workflow_agent",
    index: 1,
    label: "recon:chrome-inventory",
    phaseIndex: 1,
    phaseTitle: "Recon",
    agentId: "agent-1",
    state: "done",
    model: "claude-opus-5[1m]",
    tokens: 149_864,
    toolCalls: 39,
    durationMs: 285_332,
    resultPreview: '{"headline":"The saved preview","findings":[',
  }

  beforeEach(() => {
    mockedAuthFetch.mockReset()
  })

  it("shows a readable summary while collapsed and loads the full response on demand", async () => {
    const user = userEvent.setup()
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          headline: "The complete response",
          findings: [{ title: "Remove the redundant controls" }],
        },
      }),
    } as Response)

    render(
      <WorkflowAgentCard
        agent={agent}
        dirName="project"
        sessionId="session"
        runId="wf_run-1"
      />,
    )

    expect(screen.getByText("The saved preview")).toBeInTheDocument()
    expect(screen.queryByText("Remove the redundant controls")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /chrome inventory/i }))

    expect(await screen.findByText("The complete response")).toBeInTheDocument()
    expect(screen.getByText("Remove the redundant controls")).toBeInTheDocument()
    expect(mockedAuthFetch).toHaveBeenCalledWith(
      "/api/workflow-agent-result/project/session/wf_run-1/agent-1",
    )
  })
})
