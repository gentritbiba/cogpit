import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  GitHubPullFilesResponse,
  GitHubPullSessionsResponse,
  GitHubPullsResponse,
} from "../../../shared/contracts/github"
import type { WorkspacePanelContext } from "@/plugin-api"

const storeMocks = vi.hoisted(() => ({
  useGitHubActions: vi.fn(),
  useGitHubPulls: vi.fn(),
  useGitHubPullSessions: vi.fn(),
  useGitHubIssues: vi.fn(),
  fetchGitHubActionsJobs: vi.fn(),
  fetchGitHubPullFiles: vi.fn(),
  toErrorResponse: vi.fn((_error: unknown, fallback: string) => ({ error: fallback, code: "github_api_failed" })),
}))

vi.mock("../githubStore", () => storeMocks)

import { GitHubIndicator, GitHubPanel } from "../GitHubPanel"

const quiet = { checks: null, review: null, reviewRequested: false, conflicts: false, comments: 0 }

const pullsResponse: GitHubPullsResponse = {
  repository: "acme/app",
  repositoryUrl: "https://github.com/acme/app",
  branch: "fix-checkout",
  viewer: "octocat",
  pulls: [
    {
      number: 128,
      title: "Fix checkout flow",
      body: "Guards the empty cart case.\n\nCloses #120.",
      state: "open",
      url: "https://github.com/acme/app/pull/128",
      author: "octocat",
      headBranch: "fix-checkout",
      baseBranch: "main",
      createdAt: "2026-09-02T09:00:00Z",
      updatedAt: "2026-09-02T10:00:00Z",
      closedAt: null,
      checks: "failure",
      review: "changes_requested",
      reviewRequested: false,
      conflicts: true,
      comments: 4,
    },
    {
      number: 130,
      title: "Add pull request tab",
      body: "",
      state: "draft",
      url: "https://github.com/acme/app/pull/130",
      author: "hubot",
      headBranch: "pr-tab",
      baseBranch: "main",
      createdAt: "2026-09-02T09:30:00Z",
      updatedAt: "2026-09-02T09:45:00Z",
      closedAt: null,
      ...quiet,
      checks: "pending",
      reviewRequested: true,
    },
    {
      number: 121,
      title: "Ship production",
      body: "Release notes.",
      state: "merged",
      url: "https://github.com/acme/app/pull/121",
      author: "octocat",
      headBranch: "release",
      baseBranch: "main",
      createdAt: "2026-09-01T09:00:00Z",
      updatedAt: "2026-09-01T12:00:00Z",
      closedAt: "2026-09-01T12:00:00Z",
      ...quiet,
      checks: "success",
      review: "approved",
    },
  ],
}

const sessionsResponse: GitHubPullSessionsResponse = {
  repository: "acme/app",
  pending: 0,
  sessions: [
    { dirName: "-repo", fileName: "abc.jsonl", sessionId: "abc", title: "Guard the empty cart", numbers: [128] },
    { dirName: "-repo", fileName: "def.jsonl", sessionId: "def", title: "", numbers: [128, 121] },
  ],
}

const filesResponse: GitHubPullFilesResponse = {
  repository: "acme/app",
  number: 128,
  truncated: false,
  files: [
    { path: "src/checkout.ts", previousPath: null, status: "modified", additions: 12, deletions: 3 },
    { path: "src/cart/empty.ts", previousPath: null, status: "added", additions: 20, deletions: 0 },
  ],
}

const openSession = vi.fn()

const context: WorkspacePanelContext = {
  session: null,
  sessionChangeKey: 0,
  projectPath: "/repo",
  hasFileChanges: false,
  canAccessHostFiles: true,
  openSession,
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    data: pullsResponse,
    error: null,
    loading: false,
    refreshing: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function renderPullsTab() {
  const user = userEvent.setup()
  render(<GitHubPanel context={context} active closePanel={vi.fn()} openPanel={vi.fn()} />)
  await user.click(screen.getByRole("tab", { name: /Pull requests/ }))
  return user
}

describe("GitHubPanel pull requests tab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useGitHubActions.mockReturnValue(state({ data: null, loading: true }))
    storeMocks.useGitHubPulls.mockReturnValue(state())
    storeMocks.useGitHubPullSessions.mockReturnValue(state({ data: sessionsResponse }))
    storeMocks.useGitHubIssues.mockReturnValue(state({ data: null }))
    storeMocks.fetchGitHubPullFiles.mockResolvedValue(filesResponse)
  })

  it("lists open pull requests and keeps closed ones folded away", async () => {
    await renderPullsTab()

    expect(screen.getByRole("tab", { name: /Pull requests/ })).toHaveTextContent("2")
    expect(screen.getByRole("link", { name: /acme\/app/ })).toHaveAttribute("href", "https://github.com/acme/app/pulls")
    expect(screen.getByRole("button", { name: "Fix checkout flow #128: Open" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add pull request tab #130: Draft" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Ship production" })).not.toBeInTheDocument()

    const checkout = screen.getByRole("article", { name: "Fix checkout flow" })
    expect(within(checkout).getByLabelText("Current branch")).toBeInTheDocument()
  })

  it("reveals merged and closed pull requests on demand", async () => {
    const user = await renderPullsTab()

    await user.click(screen.getByRole("button", { name: /^Closed/ }))
    expect(screen.getByRole("button", { name: "Ship production #121: Merged" })).toBeInTheDocument()
  })

  it("loads the description and changed files only after a pull request is expanded", async () => {
    const user = await renderPullsTab()

    expect(storeMocks.fetchGitHubPullFiles).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Fix checkout flow #128: Open" }))

    expect(storeMocks.fetchGitHubPullFiles).toHaveBeenCalledWith("/repo", 128)
    expect(screen.getByText(/Guards the empty cart case/)).toBeVisible()
    const files = await screen.findByRole("region", { name: "Files changed" })
    expect(within(files).getByTitle("src/checkout.ts")).toHaveTextContent("+12 −3")
    expect(within(files).getByTitle("src/cart/empty.ts")).toHaveTextContent("+20")
    expect(screen.getByRole("link", { name: "Open pull request on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/128",
    )
  })

  it("surfaces checks, review, conflicts and comments as signals on each row", async () => {
    await renderPullsTab()

    const checkout = screen.getByRole("article", { name: "Fix checkout flow" })
    expect(within(checkout).getByRole("button", { name: "Checks failed, show runs" })).toBeInTheDocument()
    expect(within(checkout).getByLabelText("Changes requested")).toBeInTheDocument()
    expect(within(checkout).getByLabelText("Has merge conflicts")).toBeInTheDocument()
    expect(within(checkout).getByLabelText("4 comments")).toBeInTheDocument()

    const draft = screen.getByRole("article", { name: "Add pull request tab" })
    expect(within(draft).getByRole("button", { name: "Checks running, show runs" })).toBeInTheDocument()
    expect(within(draft).getByLabelText("Your review is requested")).toBeInTheDocument()
  })

  it("jumps to the Actions tab focused on the branch when checks are clicked", async () => {
    storeMocks.useGitHubActions.mockReturnValue(state({
      data: {
        repository: "acme/app",
        repositoryUrl: "https://github.com/acme/app",
        branch: "main",
        runs: [{
          id: 1,
          name: "Quality",
          displayTitle: "CI for checkout",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/acme/app/actions/runs/1",
          runNumber: 9,
          event: "pull_request",
          branch: "fix-checkout",
          commitSha: "1111111",
          createdAt: "2026-09-02T10:00:00Z",
          updatedAt: "2026-09-02T10:01:00Z",
          actor: "octocat",
        }, {
          id: 2,
          name: "Quality",
          displayTitle: "Release",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/acme/app/actions/runs/2",
          runNumber: 10,
          event: "push",
          branch: "main",
          commitSha: "2222222",
          createdAt: "2026-09-02T11:00:00Z",
          updatedAt: "2026-09-02T11:01:00Z",
          actor: "octocat",
        }],
      },
    }))
    const user = await renderPullsTab()

    await user.click(screen.getByRole("button", { name: "Checks failed, show runs" }))

    expect(screen.getByRole("tab", { name: /Actions/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("button", { name: "Only runs on fix-checkout" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("article", { name: "CI for checkout" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Release" })).not.toBeInTheDocument()
  })

  it("filters to my pull requests and to the current branch", async () => {
    const user = await renderPullsTab()

    await user.click(screen.getByRole("button", { name: "Only pull requests by octocat" }))
    expect(screen.getByRole("article", { name: "Fix checkout flow" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Add pull request tab" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Only pull requests from fix-checkout" }))
    expect(screen.getByRole("article", { name: "Fix checkout flow" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Add pull request tab" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /^All/ }))
    expect(screen.getByRole("article", { name: "Add pull request tab" })).toBeInTheDocument()
  })

  it("links pull requests to the Cogpit sessions that worked on them", async () => {
    const user = await renderPullsTab()

    const checkout = screen.getByRole("article", { name: "Fix checkout flow" })
    expect(within(checkout).getByRole("button", { name: "Open session: Guard the empty cart" })).toBeInTheDocument()
    expect(within(checkout).getByRole("button", { name: "Open session: def" })).toBeInTheDocument()
    expect(within(screen.getByRole("article", { name: "Add pull request tab" }))
      .queryByLabelText("Sessions on this pull request")).not.toBeInTheDocument()

    await user.click(within(checkout).getByRole("button", { name: "Open session: Guard the empty cart" }))
    expect(openSession).toHaveBeenCalledWith("-repo", "abc.jsonl")
  })

  it("folds long descriptions until asked", async () => {
    const longBody = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n")
    storeMocks.useGitHubPulls.mockReturnValue(state({
      data: { ...pullsResponse, pulls: [{ ...pullsResponse.pulls[0], body: longBody }] },
    }))
    const user = await renderPullsTab()

    await user.click(screen.getByRole("button", { name: "Fix checkout flow #128: Open" }))
    const toggle = screen.getByRole("button", { name: "Show full description" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await user.click(toggle)
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true")
  })

  it("counts pull requests waiting for review on the workspace rail", () => {
    render(<GitHubIndicator context={context} active={false} />)
    expect(screen.getByLabelText("1 pull request waiting for your review")).toHaveTextContent("1")
  })

  it("shows an empty state when the repository has no pull requests", async () => {
    storeMocks.useGitHubPulls.mockReturnValue(state({ data: { ...pullsResponse, pulls: [] } }))
    await renderPullsTab()

    expect(screen.getByText("No pull requests yet")).toBeInTheDocument()
  })
})
