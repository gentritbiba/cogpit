import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GitHubIssuesResponse } from "../../../shared/contracts/github"
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

import { GitHubPanel } from "../GitHubPanel"
import { issuePrompt } from "../IssuesTab"

const issuesResponse: GitHubIssuesResponse = {
  repository: "acme/app",
  repositoryUrl: "https://github.com/acme/app",
  viewer: "octocat",
  issues: [
    {
      number: 12,
      title: "Checkout crashes on empty cart",
      body: "Steps:\n1. Empty the cart\n2. Checkout",
      state: "open",
      url: "https://github.com/acme/app/issues/12",
      author: "hubot",
      assignees: ["octocat"],
      labels: [{ name: "bug", color: "d73a4a" }, { name: "checkout", color: "0075ca" }],
      linkedPulls: [{ number: 128, state: "open" }],
      comments: 2,
      createdAt: "2026-09-01T09:00:00Z",
      updatedAt: "2026-09-02T09:00:00Z",
      closedAt: null,
    },
    {
      number: 13,
      title: "Add dark mode",
      body: "",
      state: "open",
      url: "https://github.com/acme/app/issues/13",
      author: "octocat",
      assignees: [],
      labels: [{ name: "enhancement", color: "a2eeef" }],
      linkedPulls: [],
      comments: 0,
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
      closedAt: null,
    },
    {
      number: 11,
      title: "Old crash",
      body: "",
      state: "completed",
      url: "https://github.com/acme/app/issues/11",
      author: "hubot",
      assignees: ["hubot"],
      labels: [{ name: "bug", color: "d73a4a" }],
      linkedPulls: [{ number: 121, state: "merged" }],
      comments: 0,
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-02T10:00:00Z",
      closedAt: "2026-08-02T10:00:00Z",
    },
  ],
}

const composePrompt = vi.fn()

const context: WorkspacePanelContext = {
  session: null,
  sessionChangeKey: 0,
  projectPath: "/repo",
  hasFileChanges: false,
  canAccessHostFiles: true,
  composePrompt,
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    data: issuesResponse,
    error: null,
    loading: false,
    refreshing: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

async function renderIssuesTab() {
  const user = userEvent.setup()
  render(<GitHubPanel context={context} active closePanel={vi.fn()} />)
  await user.click(screen.getByRole("tab", { name: /Issues/ }))
  return user
}

describe("issuePrompt", () => {
  it("hands the agent the title, link and description", () => {
    expect(issuePrompt(issuesResponse.issues[0])).toBe(
      "Work on GitHub issue #12: Checkout crashes on empty cart\nhttps://github.com/acme/app/issues/12\n\nSteps:\n1. Empty the cart\n2. Checkout",
    )
    expect(issuePrompt(issuesResponse.issues[1])).toBe("Work on GitHub issue #13: Add dark mode\nhttps://github.com/acme/app/issues/13")
  })
})

describe("GitHubPanel issues tab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useGitHubActions.mockReturnValue(state({ data: null, loading: true }))
    storeMocks.useGitHubPulls.mockReturnValue(state({ data: null, loading: true }))
    storeMocks.useGitHubPullSessions.mockReturnValue(state({ data: null }))
    storeMocks.useGitHubIssues.mockReturnValue(state())
  })

  it("lists open issues with their signals and folds closed ones away", async () => {
    await renderIssuesTab()

    expect(screen.getByRole("tab", { name: /Issues/ })).toHaveTextContent("2")
    expect(screen.getByRole("link", { name: /acme\/app/ })).toHaveAttribute("href", "https://github.com/acme/app/issues")

    const crash = screen.getByRole("article", { name: "Checkout crashes on empty cart" })
    expect(within(crash).getByRole("button", { name: "Checkout crashes on empty cart #12: Open" })).toBeInTheDocument()
    expect(within(crash).getByLabelText("Assigned to you")).toBeInTheDocument()
    expect(within(crash).getByRole("button", { name: "Pull request #128 (open), show pull requests" })).toBeInTheDocument()
    expect(within(crash).getByLabelText("2 comments")).toBeInTheDocument()
    expect(within(crash).getByText("bug")).toBeInTheDocument()

    expect(screen.queryByRole("article", { name: "Old crash" })).not.toBeInTheDocument()
  })

  it("filters by who the issue belongs to", async () => {
    const user = await renderIssuesTab()

    await user.click(screen.getByRole("button", { name: "Only issues assigned to you" }))
    expect(screen.getByRole("article", { name: "Checkout crashes on empty cart" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Add dark mode" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Only issues you opened" }))
    expect(screen.getByRole("article", { name: "Add dark mode" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Checkout crashes on empty cart" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Only unassigned issues" }))
    expect(screen.getByRole("article", { name: "Add dark mode" })).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Checkout crashes on empty cart" })).not.toBeInTheDocument()
  })

  it("filters by a label picked from an issue and clears it again", async () => {
    const user = await renderIssuesTab()

    await user.click(screen.getByRole("button", { name: "Checkout crashes on empty cart #12: Open" }))
    await user.click(screen.getByRole("button", { name: "Only issues labeled checkout" }))

    expect(screen.getByRole("button", { name: "Clear label filter checkout" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByRole("article", { name: "Add dark mode" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Clear label filter checkout" }))
    expect(screen.getByRole("article", { name: "Add dark mode" })).toBeInTheDocument()
  })

  it("drops the issue into the composer", async () => {
    const user = await renderIssuesTab()

    await user.click(screen.getByRole("button", { name: "Checkout crashes on empty cart #12: Open" }))
    await user.click(screen.getByRole("button", { name: "Add to prompt" }))

    expect(composePrompt).toHaveBeenCalledWith(issuePrompt(issuesResponse.issues[0]))
    expect(screen.getByRole("link", { name: "Open issue on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/issues/12",
    )
  })

  it("jumps to the pull requests tab from a linked pull request", async () => {
    const user = await renderIssuesTab()

    await user.click(screen.getByRole("button", { name: "Pull request #128 (open), show pull requests" }))
    expect(screen.getByRole("tab", { name: /Pull requests/ })).toHaveAttribute("aria-selected", "true")
  })

  it("shows closed issues on demand", async () => {
    const user = await renderIssuesTab()

    await user.click(screen.getByRole("button", { name: /^Closed/ }))
    expect(screen.getByRole("button", { name: "Old crash #11: Completed" })).toBeInTheDocument()
  })
})
