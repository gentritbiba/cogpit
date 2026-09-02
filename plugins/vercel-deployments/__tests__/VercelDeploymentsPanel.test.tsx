import { render, screen } from "@testing-library/react"
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

import { VercelDeploymentsIndicator, VercelDeploymentsPanel } from "../VercelDeploymentsPanel"

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

describe("VercelDeploymentsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useVercelDeployments.mockReturnValue(state())
    storeMocks.fetchVercelBuildLogs.mockResolvedValue(logsResponse)
  })

  it("shows normalized project deployments and environments", () => {
    renderPanel()

    expect(screen.getByRole("heading", { name: "Vercel Deployments" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /web/ })).toHaveAttribute("href", "https://vercel.com/acme/web")
    expect(screen.getByRole("article", { name: "Ship production" })).toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Add search" })).toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Break the build" })).toBeInTheDocument()
    expect(screen.getAllByText("preview")).toHaveLength(2)
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
