import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { WorkflowDetail } from "@/lib/workflow-types"
import { WorkflowDetailView } from "../WorkflowDetailView"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn(), authUrl: (url: string) => url }))

const RUNNING: WorkflowDetail = {
  runId: "run-1",
  workflowName: "Audit",
  summary: "",
  status: "running",
  startTime: 1,
  agentCount: 1,
  totalTokens: 0,
  totalToolCalls: 0,
  phaseCount: 0,
  phaseTitles: [],
  agentCounts: { total: 1, queued: 0, running: 1, done: 0, error: 0 },
  phases: [],
  agents: [],
  controllable: true,
}

function renderView(onForceStop?: () => void) {
  render(
    <WorkflowDetailView
      detail={RUNNING}
      dirName="-work-app"
      sessionId="session-1"
      stopping={false}
      confirming={false}
      onForceStop={onForceStop}
    />,
  )
}

describe("WorkflowDetailView", () => {
  it("offers to stop a running workflow", () => {
    renderView(vi.fn())

    expect(screen.getByRole("button", { name: /Stop workflow/ })).toBeInTheDocument()
  })

  it("leaves a viewer without the stop control", () => {
    renderView()

    expect(screen.queryByRole("button", { name: /Stop workflow/ })).not.toBeInTheDocument()
  })
})
