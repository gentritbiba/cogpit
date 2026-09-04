// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../http"
import {
  ISSUES_QUERY,
  parseGitHubRemote,
  parseIssuesResponse,
  parseJobsResponse,
  parsePullFilesResponse,
  parsePullsResponse,
  parseRunsResponse,
  PULLS_QUERY,
  registerGitHubRoutes,
  runGitHubApi,
} from "../../routes/github"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"

const workflowRun = {
  id: 42,
  name: "Deploy",
  display_title: "Ship production",
  status: "in_progress",
  conclusion: null,
  html_url: "https://github.com/acme/app/actions/runs/42",
  run_number: 7,
  event: "push",
  head_branch: "main",
  head_sha: "abcdef123456",
  created_at: "2026-09-02T10:00:00Z",
  updated_at: "2026-09-02T10:01:00Z",
  actor: { login: "octocat" },
}

const workflowJob = {
  id: 100,
  name: "deploy",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/acme/app/actions/runs/42/job/100",
  started_at: "2026-09-02T10:00:00Z",
  completed_at: "2026-09-02T10:02:00Z",
  steps: [{
    number: 1,
    name: "Publish",
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-02T10:00:10Z",
    completed_at: "2026-09-02T10:01:50Z",
  }],
}

const pullRequest = {
  number: 128,
  title: "Fix checkout flow",
  body: "Guards the empty cart case.",
  state: "OPEN",
  isDraft: false,
  url: "https://github.com/acme/app/pull/128",
  author: { login: "octocat" },
  headRefName: "fix-checkout",
  baseRefName: "main",
  createdAt: "2026-09-02T09:00:00Z",
  updatedAt: "2026-09-02T10:00:00Z",
  closedAt: null,
  mergedAt: null,
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  comments: { totalCount: 3 },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "hubot" } }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
}

const issue = {
  number: 12,
  title: "Checkout crashes on empty cart",
  body: "Steps to reproduce…",
  state: "OPEN",
  stateReason: null,
  url: "https://github.com/acme/app/issues/12",
  author: { login: "octocat" },
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-02T09:00:00Z",
  closedAt: null,
  comments: { totalCount: 2 },
  labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "", color: "000000" }] },
  assignees: { nodes: [{ login: "hubot" }] },
  timelineItems: {
    nodes: [
      { source: { number: 128, state: "OPEN", isDraft: false } },
      { source: {} },
      { source: { number: 128, state: "OPEN", isDraft: false } },
      { source: { number: 121, state: "MERGED" } },
    ],
  },
}

function issuesResponse(open: unknown[], closed: unknown[] = [], viewer = "hubot") {
  return { data: { viewer: { login: viewer }, repository: { open: { nodes: open }, closed: { nodes: closed } } } }
}

function graphqlResponse(pulls: unknown[], viewer = "hubot") {
  return { data: { viewer: { login: viewer }, repository: { pullRequests: { nodes: pulls } } } }
}

const pullFile = {
  filename: "src/checkout.ts",
  status: "modified",
  additions: 12,
  deletions: 3,
}

function harness(apiResponse: unknown) {
  const githubApi = vi.fn().mockResolvedValue(apiResponse)
  const githubGraphql = vi.fn().mockResolvedValue(apiResponse)
  const pullRequestSessions = vi.fn().mockResolvedValue({
    sessions: [{ dirName: "-repo", fileName: "abc.jsonl", sessionId: "abc", title: "Fix checkout", numbers: [128] }],
    pending: 0,
  })
  const dependencies = {
    resolveProject: vi.fn().mockResolvedValue({ ok: true, projectPath: "/repo", root: "/repo" }),
    git: vi.fn().mockImplementation((_cwd: string, args: string[]) => {
      if (args[0] === "remote") return Promise.resolve({ stdout: "git@github.com:acme/app.git\n", stderr: "" })
      return Promise.resolve({ stdout: "main\n", stderr: "" })
    }),
    githubApi,
    githubGraphql,
    pullRequestSessions,
  }
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => { handlers.set(path, handler) }
  registerGitHubRoutes(use, dependencies)
  return { handlers, githubApi, githubGraphql, pullRequestSessions }
}

async function request(handler: Middleware, url: string) {
  let body = ""
  const response = asServerResponse({
    statusCode: 200,
    setHeader: vi.fn(),
    end: (value?: string) => { body = value ?? "" },
  })
  const next = vi.fn()
  await handler(asIncomingMessage({ method: "GET", url }), response, next)
  return { status: response.statusCode, data: body ? JSON.parse(body) : null, next }
}

describe("GitHub routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("parses HTTPS, SSH, and enterprise remotes", () => {
    expect(parseGitHubRemote("https://github.com/acme/app.git")).toEqual({
      host: "github.com",
      owner: "acme",
      name: "app",
    })
    expect(parseGitHubRemote("git@github.com:acme/app.git")).toEqual({
      host: "github.com",
      owner: "acme",
      name: "app",
    })
    expect(parseGitHubRemote("ssh://git@github.example.com/acme/app.git")).toEqual({
      host: "github.example.com",
      owner: "acme",
      name: "app",
    })
    expect(parseGitHubRemote("https://gitlab.com/acme/group/app.git")).toBeNull()
  })

  it("maps workflow runs and job steps to the public contract", () => {
    expect(parseRunsResponse({ workflow_runs: [workflowRun] })[0]).toMatchObject({
      id: 42,
      name: "Deploy",
      displayTitle: "Ship production",
      status: "in_progress",
      branch: "main",
      actor: "octocat",
    })
    expect(parseJobsResponse({ jobs: [workflowJob] })[0]).toMatchObject({
      id: 100,
      name: "deploy",
      conclusion: "success",
      steps: [{ number: 1, name: "Publish", conclusion: "success" }],
    })
  })

  it("maps pull requests and their files to the public contract", () => {
    const parsed = parsePullsResponse(graphqlResponse([pullRequest]))
    expect(parsed.viewer).toBe("hubot")
    expect(parsed.pulls[0]).toMatchObject({
      number: 128,
      title: "Fix checkout flow",
      state: "open",
      author: "octocat",
      headBranch: "fix-checkout",
      baseBranch: "main",
      closedAt: null,
      checks: "failure",
      review: "review_required",
      reviewRequested: true,
      conflicts: false,
      comments: 3,
    })
    expect(parsePullsResponse(graphqlResponse([pullRequest], "octocat")).pulls[0].reviewRequested).toBe(false)
    expect(parsePullsResponse(graphqlResponse([{ ...pullRequest, isDraft: true }])).pulls[0].state).toBe("draft")
    expect(parsePullsResponse(graphqlResponse([{
      ...pullRequest,
      state: "MERGED",
      closedAt: "2026-09-02T11:00:00Z",
      mergedAt: "2026-09-02T11:00:00Z",
      mergeable: "UNKNOWN",
      commits: { nodes: [] },
    }])).pulls[0]).toMatchObject({ state: "merged", closedAt: "2026-09-02T11:00:00Z", checks: null })
    expect(parsePullsResponse(graphqlResponse([{
      ...pullRequest,
      state: "CLOSED",
      closedAt: "2026-09-02T11:00:00Z",
      mergeable: "CONFLICTING",
    }])).pulls[0]).toMatchObject({ state: "closed", conflicts: true })
    expect(() => parsePullsResponse({ data: { viewer: null } })).toThrow(/invalid pull request/)
    expect(parsePullFilesResponse([pullFile, { filename: "" }])).toEqual([{
      path: "src/checkout.ts",
      previousPath: null,
      status: "modified",
      additions: 12,
      deletions: 3,
    }])
  })

  it("loads recent runs for the repository resolved from cwd", async () => {
    const { handlers, githubApi } = harness({ workflow_runs: [workflowRun] })
    const response = await request(
      getRouteHandler(handlers, "/api/github/actions"),
      "/?cwd=%2Frepo&limit=5",
    )

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ repository: "acme/app", branch: "main" })
    expect(response.data.runs).toHaveLength(1)
    expect(githubApi).toHaveBeenCalledWith(
      { host: "github.com", owner: "acme", name: "app" },
      "repos/acme/app/actions/runs?per_page=5",
    )
  })

  it("loads jobs for a selected workflow run", async () => {
    const { handlers, githubApi } = harness({ jobs: [workflowJob] })
    const response = await request(
      getRouteHandler(handlers, "/api/github/actions/jobs"),
      "/?cwd=%2Frepo&runId=42",
    )

    expect(response.status).toBe(200)
    expect(response.data.jobs[0].steps).toHaveLength(1)
    expect(githubApi).toHaveBeenCalledWith(
      expect.anything(),
      "repos/acme/app/actions/runs/42/jobs?filter=latest&per_page=100",
    )
  })

  it("rejects malformed run IDs before calling GitHub", async () => {
    const { handlers, githubApi } = harness({ jobs: [] })
    const response = await request(
      getRouteHandler(handlers, "/api/github/actions/jobs"),
      "/?cwd=%2Frepo&runId=42%2Flogs",
    )

    expect(response.status).toBe(400)
    expect(githubApi).not.toHaveBeenCalled()
  })

  it("maps issues with labels, assignees and linked pull requests", () => {
    const parsed = parseIssuesResponse(issuesResponse(
      [issue],
      [{ ...issue, number: 11, state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: "2026-09-02T10:00:00Z" }],
    ))
    expect(parsed.viewer).toBe("hubot")
    expect(parsed.issues).toHaveLength(2)
    expect(parsed.issues[0]).toMatchObject({
      number: 12,
      state: "open",
      author: "octocat",
      assignees: ["hubot"],
      labels: [{ name: "bug", color: "d73a4a" }],
      linkedPulls: [{ number: 121, state: "merged" }, { number: 128, state: "open" }],
      comments: 2,
    })
    expect(parsed.issues[1]).toMatchObject({ number: 11, state: "not_planned", closedAt: "2026-09-02T10:00:00Z" })
    expect(parseIssuesResponse(issuesResponse([{ ...issue, state: "CLOSED" }])).issues[0].state).toBe("completed")
    expect(() => parseIssuesResponse({ data: { repository: { open: { nodes: [] } } } })).toThrow(/invalid issue/)
  })

  it("loads issues in one GraphQL request", async () => {
    const { handlers, githubGraphql } = harness(issuesResponse([issue]))
    const response = await request(
      getRouteHandler(handlers, "/api/github/issues"),
      "/?cwd=%2Frepo&limit=10",
    )

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ repository: "acme/app", viewer: "hubot" })
    expect(response.data.issues).toHaveLength(1)
    expect(githubGraphql).toHaveBeenCalledWith(
      { host: "github.com", owner: "acme", name: "app" },
      ISSUES_QUERY,
      { owner: "acme", name: "app", open: 10, closed: 15 },
    )
  })

  it("loads open and closed pull requests in one GraphQL request", async () => {
    const { handlers, githubGraphql } = harness(graphqlResponse([pullRequest]))
    const response = await request(
      getRouteHandler(handlers, "/api/github/pulls"),
      "/?cwd=%2Frepo&limit=10",
    )

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ repository: "acme/app", branch: "main", viewer: "hubot" })
    expect(response.data.pulls).toHaveLength(1)
    expect(githubGraphql).toHaveBeenCalledWith(
      { host: "github.com", owner: "acme", name: "app" },
      PULLS_QUERY,
      { owner: "acme", name: "app", first: 10 },
    )
  })

  it("lists the Cogpit sessions that worked on the repository's pull requests", async () => {
    const { handlers, pullRequestSessions } = harness(null)
    const response = await request(
      getRouteHandler(handlers, "/api/github/pulls/sessions"),
      "/?cwd=%2Frepo",
    )

    expect(response.status).toBe(200)
    expect(response.data).toEqual({
      repository: "acme/app",
      pending: 0,
      sessions: [{ dirName: "-repo", fileName: "abc.jsonl", sessionId: "abc", title: "Fix checkout", numbers: [128] }],
    })
    expect(pullRequestSessions).toHaveBeenCalledWith("/repo", "acme/app")
  })

  it("loads the files changed by a pull request and flags the GitHub page cap", async () => {
    const { handlers, githubApi } = harness([pullFile])
    const response = await request(
      getRouteHandler(handlers, "/api/github/pulls/files"),
      "/?cwd=%2Frepo&number=128",
    )

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ number: 128, truncated: false })
    expect(response.data.files[0].path).toBe("src/checkout.ts")
    expect(githubApi).toHaveBeenCalledWith(
      expect.anything(),
      "repos/acme/app/pulls/128/files?per_page=100",
    )

    const { handlers: fullHandlers } = harness(Array.from({ length: 100 }, () => pullFile))
    const full = await request(getRouteHandler(fullHandlers, "/api/github/pulls/files"), "/?cwd=%2Frepo&number=128")
    expect(full.data.truncated).toBe(true)
  })

  it("rejects malformed pull request numbers before calling GitHub", async () => {
    const { handlers, githubApi } = harness([])
    const response = await request(
      getRouteHandler(handlers, "/api/github/pulls/files"),
      "/?cwd=%2Frepo&number=128%2Ffiles",
    )

    expect(response.status).toBe(400)
    expect(githubApi).not.toHaveBeenCalled()
  })

  it("returns a useful error when the repository has no GitHub origin", async () => {
    const failingDependencies = {
      resolveProject: vi.fn().mockResolvedValue({ ok: true, projectPath: "/repo", root: null }),
      git: vi.fn(),
      githubApi: vi.fn(),
      githubGraphql: vi.fn(),
      pullRequestSessions: vi.fn(),
    }
    const failingHandlers = new Map<string, Middleware>()
    registerGitHubRoutes((path, route) => { failingHandlers.set(path, route) }, failingDependencies)
    const failure = await request(
      getRouteHandler(failingHandlers, "/api/github/actions"),
      "/?cwd=%2Frepo",
    )
    expect(failure.status).toBe(400)
    expect(failure.data).toEqual({
      error: "This project is not a Git repository",
      code: "no_git_repository",
    })
  })

  it("returns setup guidance when GitHub CLI is not installed", async () => {
    vi.stubEnv("PATH", "/directory-without-gh")

    await expect(runGitHubApi(
      { host: "github.com", owner: "acme", name: "app" },
      "repos/acme/app/actions/runs",
    )).rejects.toMatchObject({
      status: 503,
      code: "gh_missing",
      message: "Install the GitHub CLI to view this repository on GitHub",
    })
  })
})
