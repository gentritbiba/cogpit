// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../http"
import {
  parseGitHubRemote,
  parseJobsResponse,
  parseRunsResponse,
  registerGitHubActionsRoutes,
  runGitHubApi,
} from "../../routes/github-actions"
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

function harness(apiResponse: unknown) {
  const githubApi = vi.fn().mockResolvedValue(apiResponse)
  const dependencies = {
    resolveProject: vi.fn().mockResolvedValue({ ok: true, projectPath: "/repo", root: "/repo" }),
    git: vi.fn().mockImplementation((_cwd: string, args: string[]) => {
      if (args[0] === "remote") return Promise.resolve({ stdout: "git@github.com:acme/app.git\n", stderr: "" })
      return Promise.resolve({ stdout: "main\n", stderr: "" })
    }),
    githubApi,
  }
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => { handlers.set(path, handler) }
  registerGitHubActionsRoutes(use, dependencies)
  return { handlers, githubApi }
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

describe("GitHub Actions routes", () => {
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

  it("loads recent runs for the repository resolved from cwd", async () => {
    const { handlers, githubApi } = harness({ workflow_runs: [workflowRun] })
    const response = await request(
      getRouteHandler(handlers, "/api/github-actions"),
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
      getRouteHandler(handlers, "/api/github-actions/jobs"),
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
      getRouteHandler(handlers, "/api/github-actions/jobs"),
      "/?cwd=%2Frepo&runId=42%2Flogs",
    )

    expect(response.status).toBe(400)
    expect(githubApi).not.toHaveBeenCalled()
  })

  it("returns a useful error when the repository has no GitHub origin", async () => {
    const failingDependencies = {
      resolveProject: vi.fn().mockResolvedValue({ ok: true, projectPath: "/repo", root: null }),
      git: vi.fn(),
      githubApi: vi.fn(),
    }
    const failingHandlers = new Map<string, Middleware>()
    registerGitHubActionsRoutes((path, route) => { failingHandlers.set(path, route) }, failingDependencies)
    const failure = await request(
      getRouteHandler(failingHandlers, "/api/github-actions"),
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
      message: "Install the GitHub CLI to view workflow runs",
    })
  })
})
