import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  GitHubPullFilesResponse,
  GitHubPullSessionsResponse,
  GitHubPullsResponse,
} from "@cogpit/plugin-integrations"
import type { GitHubPanelContext } from "../GitHubPanel"

const storeMocks = vi.hoisted(() => ({
  useGitHubActions: vi.fn(),
  useGitHubPulls: vi.fn(),
  useGitHubPullSessions: vi.fn(),
  useGitHubIssues: vi.fn(),
  fetchGitHubActionsJobs: vi.fn(),
  fetchGitHubPullFiles: vi.fn(),
  mergeGitHubPull: vi.fn(),
  toErrorResponse: vi.fn((error: unknown, fallback: string) => {
    const detail = error as { error?: unknown } | null
    return { error: typeof detail?.error === "string" ? detail.error : fallback, code: "github_api_failed" }
  }),
}))

vi.mock("../githubStore", () => ({ ...storeMocks, useGitHubDetails: () => ({ actionsJobs: storeMocks.fetchGitHubActionsJobs, pullFiles: storeMocks.fetchGitHubPullFiles, mergePull: storeMocks.mergeGitHubPull }) }))

import { GitHubPanel } from "../GitHubPanel"

const quiet = { checks: null, checkProgress: null, review: null, reviewRequested: false, conflicts: false, comments: 0, mergeState: null }
const headSha = "b".repeat(40)

const pullsResponse: GitHubPullsResponse = {
  repository: "acme/app",
  repositoryUrl: "https://github.com/acme/app",
  branch: "fix-checkout",
  viewer: "octocat",
  mergeMethods: ["squash", "merge"],
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
      checkProgress: null,
      review: "changes_requested",
      reviewRequested: false,
      conflicts: true,
      comments: 4,
      mergeState: "blocked",
      headSha,
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
      headSha,
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
      headSha,
    },
  ],
}

const sessionsResponse: GitHubPullSessionsResponse = {
  repository: "acme/app",
  pending: 0,
  sessions: [
    { handle: "abc", title: "Guard the empty cart", numbers: [128] },
    { handle: "def", title: "", numbers: [128, 121] },
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
const openExternal = vi.fn()

const context: GitHubPanelContext = {
  projectKey: "/repo",
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

function withPulls(pulls: GitHubPullsResponse["pulls"], rest: Partial<GitHubPullsResponse> = {}) {
  return state({ data: { ...pullsResponse, ...rest, pulls } })
}

async function renderPullsTab() {
  const user = userEvent.setup()
  render(<GitHubPanel context={context} active openExternal={openExternal} />)
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
    storeMocks.mergeGitHubPull.mockResolvedValue({ repository: "acme/app", number: 128, merged: true, sha: "c".repeat(40), message: "Merged" })
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

  it("counts check progress and sends checks that are not on Actions to GitHub", async () => {
    const [checkout, draft, shipped] = pullsResponse.pulls
    storeMocks.useGitHubPulls.mockReturnValue(withPulls([
      { ...checkout, checkProgress: { total: 3, completed: 2, actions: true } },
      { ...draft, checkProgress: { total: 4, completed: 1, actions: false } },
      { ...shipped, checkProgress: { total: 1, completed: 1, actions: true } },
    ]))
    const user = await renderPullsTab()

    expect(screen.getByRole("button", { name: "Checks failed, show runs" })).toBeInTheDocument()
    const running = screen.getByRole("button", { name: "1 of 4 checks done, open on GitHub" })
    await user.click(running)
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/app/pull/130/checks")
    expect(screen.getByRole("tab", { name: /Pull requests/ })).toHaveAttribute("aria-selected", "true")

    await user.click(screen.getByRole("button", { name: /^Closed/ }))
    expect(screen.getByRole("button", { name: "1 check passed, show runs" })).toBeInTheDocument()
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
    expect(openSession).toHaveBeenCalledWith("abc")
  })

  it("folds long descriptions until asked", async () => {
    const longBody = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n")
    storeMocks.useGitHubPulls.mockReturnValue(withPulls([{ ...pullsResponse.pulls[0], body: longBody }]))
    const user = await renderPullsTab()

    await user.click(screen.getByRole("button", { name: "Fix checkout flow #128: Open" }))
    const toggle = screen.getByRole("button", { name: "Show full description" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await user.click(toggle)
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true")
  })

  it("shows an empty state when the repository has no pull requests", async () => {
    storeMocks.useGitHubPulls.mockReturnValue(withPulls([]))
    await renderPullsTab()

    expect(screen.getByText("No pull requests yet")).toBeInTheDocument()
  })
})

describe("GitHubPanel merge control", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useGitHubActions.mockReturnValue(state({ data: null, loading: true }))
    storeMocks.useGitHubPullSessions.mockReturnValue(state({ data: sessionsResponse }))
    storeMocks.useGitHubIssues.mockReturnValue(state({ data: null }))
    storeMocks.fetchGitHubPullFiles.mockResolvedValue(filesResponse)
    storeMocks.mergeGitHubPull.mockResolvedValue({ repository: "acme/app", number: 128, merged: true, sha: "c".repeat(40), message: "Merged" })
  })

  it("offers a merge only on pull requests GitHub would accept", async () => {
    const [checkout, draft] = pullsResponse.pulls
    storeMocks.useGitHubPulls.mockReturnValue(withPulls([
      { ...checkout, mergeState: "clean", conflicts: false },
      { ...draft, state: "open", mergeState: "blocked" },
    ]))
    await renderPullsTab()

    expect(screen.getByRole("button", { name: "Merge #128" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Merge #130" })).not.toBeInTheDocument()
  })

  it("merges with the chosen method after confirmation and refreshes the list", async () => {
    const pulls = withPulls([{ ...pullsResponse.pulls[0], mergeState: "clean", conflicts: false }])
    const runs = state({ data: { repository: "acme/app", repositoryUrl: "https://github.com/acme/app", branch: "main", runs: [] } })
    storeMocks.useGitHubPulls.mockReturnValue(pulls)
    storeMocks.useGitHubActions.mockReturnValue(runs)
    const user = await renderPullsTab()

    await user.click(screen.getByRole("button", { name: "Merge #128" }))
    const strip = screen.getByRole("group", { name: "Merge #128" })
    expect(within(strip).getByRole("radio", { name: "Squash" })).toHaveAttribute("aria-checked", "true")
    expect(storeMocks.mergeGitHubPull).not.toHaveBeenCalled()

    await user.click(within(strip).getByRole("radio", { name: "Merge commit" }))
    await user.click(within(strip).getByRole("button", { name: "Merge" }))

    expect(storeMocks.mergeGitHubPull).toHaveBeenCalledWith("/repo", 128, "merge", headSha)
    await waitFor(() => expect(pulls.refresh).toHaveBeenCalled())
    expect(runs.refresh).toHaveBeenCalled()
    expect(screen.queryByRole("group", { name: "Merge #128" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Merge #128" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Fix checkout flow #128: Merged" })).toBeInTheDocument()
  })

  it("keeps the confirmation open with GitHub's reason when a merge is refused", async () => {
    storeMocks.useGitHubPulls.mockReturnValue(withPulls([{ ...pullsResponse.pulls[0], mergeState: "unstable", conflicts: false }]))
    storeMocks.mergeGitHubPull.mockRejectedValue({ code: "github_api_failed", error: "GitHub declined the change: Head branch was modified" })
    const user = await renderPullsTab()

    await user.click(screen.getByRole("button", { name: "Merge #128" }))
    const strip = screen.getByRole("group", { name: "Merge #128" })
    expect(within(strip).getByText("Some checks did not pass.")).toBeInTheDocument()
    await user.click(within(strip).getByRole("button", { name: "Squash and merge" }))

    expect(await within(strip).findByRole("alert")).toHaveTextContent("Head branch was modified")
    expect(screen.getByRole("button", { name: "Fix checkout flow #128: Open" })).toBeInTheDocument()

    await user.click(within(strip).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("group", { name: "Merge #128" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Merge #128" })).toBeInTheDocument()
  })

  it("hides the merge control when the repository allows no merge method", async () => {
    storeMocks.useGitHubPulls.mockReturnValue(withPulls([{ ...pullsResponse.pulls[0], mergeState: "clean", conflicts: false }], { mergeMethods: [] }))
    await renderPullsTab()

    expect(screen.queryByRole("button", { name: "Merge #128" })).not.toBeInTheDocument()
  })
})

describe("GitHubPanel session tab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeMocks.useGitHubActions.mockReturnValue(state({ data: { repository: "acme/app", repositoryUrl: "https://github.com/acme/app", branch: "main", runs: [] } }))
    storeMocks.useGitHubPulls.mockReturnValue(state())
    storeMocks.useGitHubPullSessions.mockReturnValue(state({ data: sessionsResponse }))
    storeMocks.useGitHubIssues.mockReturnValue(state({ data: null }))
    storeMocks.fetchGitHubPullFiles.mockResolvedValue(filesResponse)
  })

  it("opens on the session's pull requests, expanded and without a chip for itself", async () => {
    render(<GitHubPanel context={{ ...context, sessionHandle: "abc" }} active openExternal={openExternal} />)

    const tab = screen.getByRole("tab", { name: /This session/ })
    expect(tab).toHaveAttribute("aria-selected", "true")
    expect(tab).toHaveTextContent("1")
    expect(screen.getAllByRole("tab")[0]).toBe(tab)
    expect(screen.getByRole("link", { name: /acme\/app/ })).toHaveAttribute("href", "https://github.com/acme/app/pulls")

    const view = screen.getByLabelText("Pull requests from this session")
    const checkout = within(view).getByRole("article", { name: "Fix checkout flow" })
    expect(within(view).queryByRole("article", { name: "Add pull request tab" })).not.toBeInTheDocument()
    expect(within(checkout).getByRole("button", { name: "Fix checkout flow #128: Open" })).toHaveAttribute("aria-expanded", "true")
    expect(storeMocks.fetchGitHubPullFiles).toHaveBeenCalledWith("/repo", 128)
    expect(await within(checkout).findByTitle("src/checkout.ts")).toBeInTheDocument()
    expect(within(checkout).queryByRole("button", { name: "Open session: Guard the empty cart" })).not.toBeInTheDocument()
    expect(within(checkout).getByRole("button", { name: "Open session: def" })).toBeInTheDocument()
  })

  it("lists every pull request the session touched, open before merged, when there are several", async () => {
    render(<GitHubPanel context={{ ...context, sessionHandle: "def" }} active openExternal={openExternal} />)

    const view = screen.getByLabelText("Pull requests from this session")
    const titles = within(view).getAllByRole("article").map((article) => article.getAttribute("aria-label"))
    expect(titles).toEqual(["Fix checkout flow", "Ship production"])
    expect(within(view).getByRole("button", { name: "Fix checkout flow #128: Open" })).toHaveAttribute("aria-expanded", "false")
    expect(storeMocks.fetchGitHubPullFiles).not.toHaveBeenCalled()
  })

  it("has no session tab when the open session touched none of the listed pull requests", async () => {
    render(<GitHubPanel context={{ ...context, sessionHandle: "zzz" }} active openExternal={openExternal} />)

    expect(screen.queryByRole("tab", { name: /This session/ })).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Actions/ })).toHaveAttribute("aria-selected", "true")
  })

  it("brings a newly opened session's pull requests forward but respects a tab chosen for that session", async () => {
    const user = userEvent.setup()
    const view = render(<GitHubPanel context={{ ...context, sessionHandle: "abc" }} active openExternal={openExternal} />)
    expect(screen.getByRole("tab", { name: /This session/ })).toHaveAttribute("aria-selected", "true")

    await user.click(screen.getByRole("tab", { name: /Issues/ }))
    view.rerender(<GitHubPanel context={{ ...context, sessionHandle: "abc" }} active openExternal={openExternal} />)
    expect(screen.getByRole("tab", { name: /Issues/ })).toHaveAttribute("aria-selected", "true")

    view.rerender(<GitHubPanel context={{ ...context, sessionHandle: "def" }} active openExternal={openExternal} />)
    expect(screen.getByRole("tab", { name: /This session/ })).toHaveAttribute("aria-selected", "true")

    view.rerender(<GitHubPanel context={{ ...context, sessionHandle: "zzz" }} active openExternal={openExternal} />)
    expect(screen.queryByRole("tab", { name: /This session/ })).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Actions/ })).toHaveAttribute("aria-selected", "true")
  })

  it("keeps a tab picked before the session handle resolved, then follows the next session", async () => {
    const user = userEvent.setup()
    const view = render(<GitHubPanel context={context} active openExternal={openExternal} />)
    await user.click(screen.getByRole("tab", { name: /Issues/ }))

    view.rerender(<GitHubPanel context={{ ...context, sessionHandle: "abc" }} active openExternal={openExternal} />)
    expect(screen.getByRole("tab", { name: /This session/ })).toHaveAttribute("aria-selected", "false")
    expect(screen.getByRole("tab", { name: /Issues/ })).toHaveAttribute("aria-selected", "true")

    view.rerender(<GitHubPanel context={{ ...context, sessionHandle: "def" }} active openExternal={openExternal} />)
    expect(screen.getByRole("tab", { name: /This session/ })).toHaveAttribute("aria-selected", "true")
  })

  it("falls back to Actions when the session view disappears from under it", async () => {
    const view = render(<GitHubPanel context={{ ...context, sessionHandle: "abc" }} active openExternal={openExternal} />)
    expect(screen.getByRole("tab", { name: /This session/ })).toHaveAttribute("aria-selected", "true")

    view.rerender(<GitHubPanel context={{ ...context, sessionHandle: null }} active openExternal={openExternal} />)
    expect(screen.queryByRole("tab", { name: /This session/ })).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Actions/ })).toHaveAttribute("aria-selected", "true")
  })

  it("refreshes both the pull requests and their session links from the session view", async () => {
    const pulls = state()
    const sessions = state({ data: sessionsResponse })
    storeMocks.useGitHubPulls.mockReturnValue(pulls)
    storeMocks.useGitHubPullSessions.mockReturnValue(sessions)
    const user = userEvent.setup()
    render(<GitHubPanel context={{ ...context, sessionHandle: "abc" }} active openExternal={openExternal} />)

    await user.click(screen.getByRole("button", { name: "Refresh this session's pull requests" }))
    expect(pulls.refresh).toHaveBeenCalled()
    expect(sessions.refresh).toHaveBeenCalled()
  })
})
