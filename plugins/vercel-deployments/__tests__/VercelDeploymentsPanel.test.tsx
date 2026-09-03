import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  VercelBuildLogsResponse,
  VercelDeploymentsResponse,
} from "../../../shared/contracts/vercelDeployments"
import type { WorkspacePanelContext } from "@/plugin-api"

const storeMocks = vi.hoisted(() => ({
  useVercelDeployments: vi.fn(),
  fetchVercelBuildLogs: vi.fn(),
}))

vi.mock("../vercelDeploymentsStore", () => storeMocks)

import { VercelDeploymentsIndicator, VercelDeploymentsPanel, productionSummary } from "../VercelDeploymentsPanel"

const deploymentsResponse: VercelDeploymentsResponse = {
  projectId: "prj_project123",
  projectName: "web",
  teamId: "team_team123",
  projectUrl: "https://vercel.com/acme/web",
  deployments: [
    {
      id: "dpl_building123",
      name: "web",
      url: "https://web-main-acme.vercel.app",
      inspectorUrl: "https://vercel.com/acme/web/building123",
      state: "BUILDING",
      target: "production",
      createdAt: Date.now() - 60_000,
      buildingAt: Date.now() - 50_000,
      readyAt: null,
      branch: "main",
      commitSha: "3333333aaaaaaa",
      commitMessage: "Ship production",
      creator: "octocat",
      errorCode: null,
      errorMessage: null,
    },
    {
      id: "dpl_ready123",
      name: "web",
      url: "https://web-preview-acme.vercel.app",
      inspectorUrl: "https://vercel.com/acme/web/ready123",
      state: "READY",
      target: null,
      createdAt: Date.now() - 120_000,
      buildingAt: Date.now() - 115_000,
      readyAt: Date.now() - 90_000,
      branch: "feature/search",
      commitSha: "2222222bbbbbbb",
      commitMessage: "Add search",
      creator: "monalisa",
      errorCode: null,
      errorMessage: null,
    },
    {
      id: "dpl_error123",
      name: "web",
      url: null,
      inspectorUrl: "https://vercel.com/acme/web/error123",
      state: "ERROR",
      target: null,
      createdAt: Date.now() - 180_000,
      buildingAt: Date.now() - 175_000,
      readyAt: null,
      branch: "feature/broken",
      commitSha: "1111111ccccccc",
      commitMessage: "Break the build",
      creator: "hubot",
      errorCode: "BUILD_FAILED",
      errorMessage: "Command exited with 1",
    },
  ],
}

const logsResponse: VercelBuildLogsResponse = {
  deploymentId: "dpl_building123",
  events: [
    { id: "1", createdAt: Date.now() - 20_000, type: "stdout", text: "Running build" },
    { id: "2", createdAt: Date.now() - 10_000, type: "stdout", text: "Deploying outputs" },
  ],
}

const context: WorkspacePanelContext = {
  session: null,
  sessionChangeKey: 0,
  projectPath: "/repo",
  hasFileChanges: false,
  canAccessHostFiles: true,
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    data: deploymentsResponse,
    error: null,
    loading: false,
    refreshing: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function renderPanel() {
  return render(
    <VercelDeploymentsPanel
      context={context}
      active
      closePanel={vi.fn()}
      openPanel={vi.fn()}
    />,
  )
}

describe("productionSummary", () => {
  it("separates the ready production deployment from a newer one that has not landed", () => {
    const { live, pending } = productionSummary([
      { ...deploymentsResponse.deployments[0], state: "BUILDING" },
      { ...deploymentsResponse.deployments[1], id: "dpl_live", target: "production" },
    ])
    expect(live?.id).toBe("dpl_live")
    expect(pending?.id).toBe("dpl_building123")
  })

  it("reports no pending deploy when the newest production deployment is the live one", () => {
    const { live, pending } = productionSummary([deploymentsResponse.deployments[1]].map((d) => ({ ...d, target: "production" })))
    expect(live?.id).toBe("dpl_ready123")
    expect(pending).toBeNull()
  })
})

describe("VercelDeploymentsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useVercelDeployments.mockReturnValue(state())
    storeMocks.fetchVercelBuildLogs.mockResolvedValue(logsResponse)
  })

  it("shows normalized project deployments and marks only production rows", () => {
    renderPanel()

    expect(screen.getByRole("heading", { name: "Vercel Deployments" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://vercel.com/acme/web")
    expect(within(screen.getByRole("article", { name: "Ship production" })).getByText("prod")).toBeInTheDocument()
    expect(within(screen.getByRole("article", { name: "Add search" })).queryByText("prod")).not.toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Break the build" })).toBeInTheDocument()
  })

  it("puts the failure reason on the row so nobody has to expand it", () => {
    renderPanel()
    const broken = screen.getByRole("article", { name: "Break the build" })
    expect(within(broken).getByText("BUILD_FAILED: Command exited with 1")).toBeInTheDocument()
  })

  it("leads with what is live on production and flags a newer deploy still building", () => {
    renderPanel()
    const production = screen.getByRole("region", { name: "Production" })
    expect(within(production).getByText("Production is down")).toBeInTheDocument()
    expect(within(production).getByRole("heading", { name: "Ship production" })).toBeInTheDocument()
  })

  it("titles CLI deploys by their host when Vercel has no commit for them", () => {
    storeMocks.useVercelDeployments.mockReturnValue(state({
      data: {
        ...deploymentsResponse,
        deployments: [{
          ...deploymentsResponse.deployments[1],
          state: "READY",
          target: "production",
          branch: "",
          commitSha: "",
          commitMessage: "",
        }],
      },
    }))
    renderPanel()

    expect(screen.getByRole("article", { name: "web-preview-acme.vercel.app" })).toBeInTheDocument()
    expect(within(screen.getByRole("region", { name: "Production" })).getByText("Live on production")).toBeInTheDocument()
  })

  it("loads build output only after a deployment is expanded", async () => {
    const user = userEvent.setup()
    renderPanel()

    expect(storeMocks.fetchVercelBuildLogs).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Ship production: Building" }))

    expect(storeMocks.fetchVercelBuildLogs).toHaveBeenCalledWith("/repo", "dpl_building123")
    expect(await screen.findByText("Running build")).toBeVisible()
    expect(screen.getByText("Deploying outputs")).toBeVisible()
  })

  it("filters production, preview, and failed deployments", async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: /Production 1/ }))
    expect(screen.getByRole("article", { name: "Ship production" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Add search" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Preview 2/ }))
    expect(screen.queryByRole("article", { name: "Ship production" })).not.toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Add search" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Failed 1/ }))
    expect(screen.getByRole("article", { name: "Break the build" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Add search" })).not.toBeInTheDocument()
  })

  it("explains how to update an older Vercel CLI", () => {
    storeMocks.useVercelDeployments.mockReturnValue(state({
      data: null,
      error: {
        error: "Update Vercel CLI to version 50.5.1 or newer to view deployments safely",
        code: "vercel_cli_too_old",
      },
    }))
    renderPanel()

    expect(screen.getByText("Update Vercel CLI to 50.5.1 or newer, then refresh.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  })

  it("renders the active deployment count on the workspace rail", () => {
    render(<VercelDeploymentsIndicator context={context} active={false} />)
    expect(screen.getByLabelText("1 active Vercel deployment")).toHaveTextContent("1")
  })
})
