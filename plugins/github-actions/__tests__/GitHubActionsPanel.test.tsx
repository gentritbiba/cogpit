import { render, screen, within } from "@testing-library/react"
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

import { GitHubActionsIndicator, GitHubActionsPanel, groupRunsByCommit } from "../GitHubActionsPanel"

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
      commitSha: "3333333aaaaaaa",
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
      commitSha: "2222222bbbbbbb",
      createdAt: "2026-09-02T10:01:00Z",
      updatedAt: "2026-09-02T10:02:00Z",
      actor: "octocat",
    },
    {
      id: 1,
      name: "Quality",
      displayTitle: "Ship production",
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/app/actions/runs/1",
      runNumber: 16,
      event: "push",
      branch: "main",
      commitSha: "3333333aaaaaaa",
      createdAt: "2026-09-02T10:02:30Z",
      updatedAt: "2026-09-02T10:02:50Z",
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

function renderPanel() {
  return render(
    <GitHubActionsPanel
      context={context}
      active
      closePanel={vi.fn()}
      openPanel={vi.fn()}
    />,
  )
}

describe("groupRunsByCommit", () => {
  it("folds every workflow run of a commit into one group and floats running commits first", () => {
    const groups = groupRunsByCommit([...runsResponse.runs].reverse())
    expect(groups.map((group) => group.title)).toEqual(["Ship production", "Fix checkout"])
    expect(groups[0].runs.map((run) => run.name)).toEqual(["Quality", "Deploy"])
    expect(groups[0].tone).toBe("live")
    expect(groups[1].tone).toBe("fail")
  })
})

describe("GitHubActionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useGitHubActions.mockReturnValue(state())
    storeMocks.fetchGitHubActionsJobs.mockResolvedValue(jobsResponse)
  })

  it("groups workflow runs under their commit with real GitHub statuses", () => {
    renderPanel()

    expect(screen.getByRole("heading", { name: "GitHub Actions" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /acme\/app/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/actions",
    )

    const shipped = screen.getByRole("article", { name: "Ship production" })
    expect(within(shipped).getByText("3333333")).toBeInTheDocument()
    expect(within(shipped).getByRole("button", { name: "Deploy #18: Running" })).toBeInTheDocument()
    expect(within(shipped).getByRole("button", { name: "Quality #16: Passed" })).toBeInTheDocument()

    const checkout = screen.getByRole("article", { name: "Fix checkout" })
    expect(within(checkout).getByRole("button", { name: "Quality #17: Failed" })).toBeInTheDocument()
  })

  it("loads jobs and steps only after a run is expanded", async () => {
    const user = userEvent.setup()
    renderPanel()

    expect(storeMocks.fetchGitHubActionsJobs).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Deploy #18: Running" }))

    expect(storeMocks.fetchGitHubActionsJobs).toHaveBeenCalledWith("/repo", 3)
    expect(await screen.findByRole("button", { name: "deploy-production: Running" })).toBeVisible()
    expect(screen.getByText("Build application")).toBeVisible()
    expect(screen.getByText("Publish production")).toBeVisible()
  })

  it("filters to failed runs and back to the current branch", async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole("button", { name: /^Failed/ }))
    expect(screen.queryByRole("article", { name: "Ship production" })).not.toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Fix checkout" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Only runs on main" }))
    expect(screen.getByRole("article", { name: "Ship production" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Fix checkout" })).not.toBeInTheDocument()
  })

  it("shows setup guidance when GitHub CLI authentication is unavailable", () => {
    storeMocks.useGitHubActions.mockReturnValue(state({
      data: null,
      error: { error: "Sign in with `gh auth login` to view workflow runs", code: "gh_auth_required" },
    }))
    renderPanel()

    expect(screen.getByText("Run `gh auth login` on the Cogpit host, then refresh.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  })

  it("shows setup guidance when GitHub CLI is not installed", () => {
    storeMocks.useGitHubActions.mockReturnValue(state({
      data: null,
      error: { error: "Install the GitHub CLI to view workflow runs", code: "gh_missing" },
    }))
    renderPanel()

    expect(screen.getByText("Install GitHub CLI, then refresh this panel.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  })

  it("renders the active workflow count on the workspace rail", () => {
    render(<GitHubActionsIndicator context={context} active={false} />)
    expect(screen.getByLabelText("1 active GitHub Actions run")).toHaveTextContent("1")
  })
})
