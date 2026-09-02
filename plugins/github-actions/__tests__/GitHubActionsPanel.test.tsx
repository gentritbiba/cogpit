import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  GitHubActionsJobsResponse,
  GitHubActionsRunsResponse,
} from "../../../shared/contracts/githubActions"
import type { WorkspacePanelContext } from "@/plugin-api"

const storeMocks = vi.hoisted(() => ({
  useGitHubActions: vi.fn(),
  fetchGitHubActionsJobs: vi.fn(),
}))

vi.mock("../githubActionsStore", () => storeMocks)

import { GitHubActionsIndicator, GitHubActionsPanel } from "../GitHubActionsPanel"

const runsResponse: GitHubActionsRunsResponse = {
  repository: "acme/app",
  repositoryUrl: "https://github.com/acme/app",
  branch: "main",
  runs: [
    {
      id: 3,
      name: "Deploy",
      displayTitle: "Ship production",
      status: "in_progress",
      conclusion: null,
      url: "https://github.com/acme/app/actions/runs/3",
      runNumber: 18,
      event: "push",
      branch: "main",
      commitSha: "3333333",
      createdAt: "2026-09-02T10:03:00Z",
      updatedAt: "2026-09-02T10:04:00Z",
      actor: "octocat",
    },
    {
      id: 2,
      name: "Quality",
      displayTitle: "Fix checkout",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/acme/app/actions/runs/2",
      runNumber: 17,
      event: "pull_request",
      branch: "fix-checkout",
      commitSha: "2222222",
      createdAt: "2026-09-02T10:01:00Z",
      updatedAt: "2026-09-02T10:02:00Z",
      actor: "octocat",
    },
    {
      id: 1,
      name: "Quality",
      displayTitle: "Add search",
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/app/actions/runs/1",
      runNumber: 16,
      event: "push",
      branch: "main",
      commitSha: "1111111",
      createdAt: "2026-09-02T09:00:00Z",
      updatedAt: "2026-09-02T09:02:00Z",
      actor: "octocat",
    },
  ],
}

const jobsResponse: GitHubActionsJobsResponse = {
  repository: "acme/app",
  runId: 3,
  jobs: [{
    id: 30,
    name: "deploy-production",
    status: "in_progress",
    conclusion: null,
    url: "https://github.com/acme/app/actions/runs/3/job/30",
    startedAt: "2026-09-02T10:03:00Z",
    completedAt: null,
    steps: [
      {
        number: 1,
        name: "Build application",
        status: "completed",
        conclusion: "success",
        startedAt: "2026-09-02T10:03:00Z",
        completedAt: "2026-09-02T10:03:30Z",
      },
      {
        number: 2,
        name: "Publish production",
        status: "in_progress",
        conclusion: null,
        startedAt: "2026-09-02T10:03:30Z",
        completedAt: null,
      },
    ],
  }],
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
    data: runsResponse,
    error: null,
    loading: false,
    refreshing: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("GitHubActionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useGitHubActions.mockReturnValue(state())
    storeMocks.fetchGitHubActionsJobs.mockResolvedValue(jobsResponse)
  })

  it("shows active and recent workflow runs with their real GitHub statuses", () => {
    render(
      <GitHubActionsPanel
        context={context}
        active
        closePanel={vi.fn()}
        openPanel={vi.fn()}
      />,
    )

    expect(screen.getByRole("heading", { name: "GitHub Actions" })).toBeInTheDocument()
    expect(screen.getByText("acme/app")).toBeInTheDocument()
    expect(screen.getByText("Ship production")).toBeInTheDocument()
    expect(screen.getByText("Fix checkout")).toBeInTheDocument()
    expect(screen.getByText("Add search")).toBeInTheDocument()
    expect(screen.getByText("Running")).toBeInTheDocument()
    expect(screen.getAllByText("Failed")).toHaveLength(2)
    expect(screen.getAllByText("Passed")).toHaveLength(2)
  })

  it("loads jobs and steps only after a run is expanded", async () => {
    const user = userEvent.setup()
    render(
      <GitHubActionsPanel
        context={context}
        active
        closePanel={vi.fn()}
        openPanel={vi.fn()}
      />,
    )

    expect(storeMocks.fetchGitHubActionsJobs).not.toHaveBeenCalled()
    await user.click(screen.getAllByRole("button", { name: "View jobs" })[0])

    expect(storeMocks.fetchGitHubActionsJobs).toHaveBeenCalledWith("/repo", 3)
    expect(await screen.findByText("deploy-production")).toBeVisible()
    expect(screen.getByText("Build application")).toBeVisible()
    expect(screen.getByText("Publish production")).toBeVisible()
    expect(screen.getByLabelText("deploy-production progress")).toBeInTheDocument()
  })

  it("shows setup guidance when GitHub CLI authentication is unavailable", () => {
    storeMocks.useGitHubActions.mockReturnValue(state({
      data: null,
      error: { error: "Sign in with `gh auth login` to view workflow runs", code: "gh_auth_required" },
    }))

    render(
      <GitHubActionsPanel
        context={context}
        active
        closePanel={vi.fn()}
        openPanel={vi.fn()}
      />,
    )

    expect(screen.getByText("Run `gh auth login` on the Cogpit host, then refresh.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  })

  it("shows setup guidance when GitHub CLI is not installed", () => {
    storeMocks.useGitHubActions.mockReturnValue(state({
      data: null,
      error: { error: "Install the GitHub CLI to view workflow runs", code: "gh_missing" },
    }))

    render(
      <GitHubActionsPanel
        context={context}
        active
        closePanel={vi.fn()}
        openPanel={vi.fn()}
      />,
    )

    expect(screen.getByText("Install GitHub CLI, then refresh this panel.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  })

  it("renders the active workflow count on the workspace rail", () => {
    render(<GitHubActionsIndicator context={context} active={false} />)
    expect(screen.getByLabelText("1 active GitHub Actions run")).toHaveTextContent("1")
  })
})
