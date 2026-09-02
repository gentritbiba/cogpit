import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import type {
  GitHubActionsErrorCode,
  GitHubActionsJob,
  GitHubActionsJobsResponse,
  GitHubActionsRun,
  GitHubActionsRunsResponse,
  GitHubActionsStep,
  GitHubWorkflowConclusion,
  GitHubWorkflowStatus,
} from "../../shared/contracts/githubActions"
import { sendJson, type UseFn } from "../http"
import { resolveGitProject, runGit } from "../lib/gitProject"

const execFile = promisify(execFileCallback)
const MAX_RUNS = 30
const DEFAULT_RUNS = 20
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/
const GITHUB_HOST = /^[A-Za-z0-9.-]+$/
const RUN_STATUSES = new Set<GitHubWorkflowStatus>([
  "completed",
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
])
const RUN_CONCLUSIONS = new Set<Exclude<GitHubWorkflowConclusion, null>>([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
])

interface GitHubRepository {
  host: string
  owner: string
  name: string
}

interface GitHubActionsDependencies {
  resolveProject: typeof resolveGitProject
  git: typeof runGit
  githubApi: (repository: GitHubRepository, endpoint: string) => Promise<unknown>
}

class GitHubActionsRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: GitHubActionsErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

function nullableDate(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function workflowStatus(value: unknown): GitHubWorkflowStatus {
  return typeof value === "string" && RUN_STATUSES.has(value as GitHubWorkflowStatus)
    ? value as GitHubWorkflowStatus
    : "pending"
}

function workflowConclusion(value: unknown): GitHubWorkflowConclusion {
  return typeof value === "string" && RUN_CONCLUSIONS.has(value as Exclude<GitHubWorkflowConclusion, null>)
    ? value as Exclude<GitHubWorkflowConclusion, null>
    : null
}

export function parseGitHubRemote(remoteUrl: string): GitHubRepository | null {
  const trimmed = remoteUrl.trim()
  let host = ""
  let pathname = ""

  try {
    const parsed = new URL(trimmed)
    host = parsed.hostname
    pathname = parsed.pathname
  } catch {
    const scp = trimmed.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/)
    if (!scp) return null
    host = scp[1]
    pathname = scp[2]
  }

  const parts = pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/")
  if (
    parts.length !== 2
    || !GITHUB_HOST.test(host)
    || (host.toLowerCase() !== "github.com" && !host.toLowerCase().startsWith("github."))
    || !GITHUB_NAME.test(parts[0])
    || !GITHUB_NAME.test(parts[1])
  ) {
    return null
  }

  return { host: host.toLowerCase(), owner: parts[0], name: parts[1] }
}

function parseRun(value: unknown): GitHubActionsRun | null {
  const source = record(value)
  if (!source) return null
  const id = numberValue(source.id)
  const url = stringValue(source.html_url)
  if (id === null || !url.startsWith("https://")) return null
  const actor = record(source.actor)

  return {
    id,
    name: stringValue(source.name, "Workflow"),
    displayTitle: stringValue(source.display_title, stringValue(source.name, "Workflow run")),
    status: workflowStatus(source.status),
    conclusion: workflowConclusion(source.conclusion),
    url,
    runNumber: numberValue(source.run_number) ?? 0,
    event: stringValue(source.event, "workflow"),
    branch: stringValue(source.head_branch),
    commitSha: stringValue(source.head_sha),
    createdAt: stringValue(source.created_at),
    updatedAt: stringValue(source.updated_at),
    actor: stringValue(actor?.login),
  }
}

function parseStep(value: unknown): GitHubActionsStep | null {
  const source = record(value)
  if (!source) return null
  const number = numberValue(source.number)
  if (number === null) return null
  return {
    number,
    name: stringValue(source.name, `Step ${number}`),
    status: workflowStatus(source.status),
    conclusion: workflowConclusion(source.conclusion),
    startedAt: nullableDate(source.started_at),
    completedAt: nullableDate(source.completed_at),
  }
}

function parseJob(value: unknown): GitHubActionsJob | null {
  const source = record(value)
  if (!source) return null
  const id = numberValue(source.id)
  const url = stringValue(source.html_url)
  if (id === null || !url.startsWith("https://")) return null
  return {
    id,
    name: stringValue(source.name, "Job"),
    status: workflowStatus(source.status),
    conclusion: workflowConclusion(source.conclusion),
    url,
    startedAt: nullableDate(source.started_at),
    completedAt: nullableDate(source.completed_at),
    steps: Array.isArray(source.steps)
      ? source.steps.map(parseStep).filter((step): step is GitHubActionsStep => step !== null)
      : [],
  }
}

export function parseRunsResponse(value: unknown): GitHubActionsRun[] {
  const source = record(value)
  if (!source || !Array.isArray(source.workflow_runs)) {
    throw new GitHubActionsRouteError(502, "invalid_response", "GitHub returned an invalid workflow response")
  }
  return source.workflow_runs
    .map(parseRun)
    .filter((run): run is GitHubActionsRun => run !== null)
}

export function parseJobsResponse(value: unknown): GitHubActionsJob[] {
  const source = record(value)
  if (!source || !Array.isArray(source.jobs)) {
    throw new GitHubActionsRouteError(502, "invalid_response", "GitHub returned an invalid jobs response")
  }
  return source.jobs
    .map(parseJob)
    .filter((job): job is GitHubActionsJob => job !== null)
}

export async function runGitHubApi(repository: GitHubRepository, endpoint: string): Promise<unknown> {
  try {
    const result = await execFile("gh", [
      "api",
      endpoint,
      "--hostname",
      repository.host,
      "-H",
      "Accept: application/vnd.github+json",
    ], {
      encoding: "utf-8",
      env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
    })
    return JSON.parse(result.stdout) as unknown
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === "ENOENT") {
      throw new GitHubActionsRouteError(503, "gh_missing", "Install the GitHub CLI to view workflow runs")
    }
    const detail = `${failure.message ?? ""}\n${failure.stderr ?? ""}`
    if (/auth login|not logged|authentication|oauth token/i.test(detail)) {
      throw new GitHubActionsRouteError(503, "gh_auth_required", "Sign in with `gh auth login` to view workflow runs")
    }
    throw new GitHubActionsRouteError(502, "github_api_failed", "GitHub workflow data is unavailable")
  }
}

const defaultDependencies: GitHubActionsDependencies = {
  resolveProject: resolveGitProject,
  git: runGit,
  githubApi: runGitHubApi,
}

async function resolveRepository(
  cwd: string,
  dependencies: GitHubActionsDependencies,
): Promise<{ repository: GitHubRepository; branch: string | null }> {
  const project = await dependencies.resolveProject(cwd)
  if (!project.ok) throw new GitHubActionsRouteError(project.status, "no_git_repository", project.error)
  if (!project.root) {
    throw new GitHubActionsRouteError(400, "no_git_repository", "This project is not a Git repository")
  }

  let remoteUrl = ""
  try {
    remoteUrl = (await dependencies.git(project.root, ["remote", "get-url", "origin"])).stdout
  } catch {
    throw new GitHubActionsRouteError(400, "no_github_remote", "This repository has no origin remote")
  }
  const repository = parseGitHubRemote(remoteUrl)
  if (!repository) {
    throw new GitHubActionsRouteError(400, "no_github_remote", "The origin remote is not a supported GitHub repository")
  }

  const branchResult = await dependencies.git(project.root, ["branch", "--show-current"])
  return {
    repository,
    branch: branchResult.stdout.trim() || null,
  }
}

function repositoryName(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.name}`
}

function repositoryUrl(repository: GitHubRepository): string {
  return `https://${repository.host}/${repository.owner}/${repository.name}`
}

function sendRouteError(res: Parameters<typeof sendJson>[0], error: unknown): void {
  if (error instanceof GitHubActionsRouteError) {
    sendJson(res, error.status, { error: error.message, code: error.code })
    return
  }
  sendJson(res, 500, { error: "Unable to load GitHub Actions", code: "github_api_failed" })
}

export function registerGitHubActionsRoutes(
  use: UseFn,
  dependencies: GitHubActionsDependencies = defaultDependencies,
): void {
  use("/api/github-actions", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "") return next()
    const cwd = url.searchParams.get("cwd") ?? ""
    const requestedLimit = Number(url.searchParams.get("limit") ?? DEFAULT_RUNS)
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(MAX_RUNS, Math.max(1, requestedLimit))
      : DEFAULT_RUNS

    try {
      const { repository, branch } = await resolveRepository(cwd, dependencies)
      const endpoint = `repos/${repository.owner}/${repository.name}/actions/runs?per_page=${limit}`
      const runs = parseRunsResponse(await dependencies.githubApi(repository, endpoint))
      const response: GitHubActionsRunsResponse = {
        repository: repositoryName(repository),
        repositoryUrl: repositoryUrl(repository),
        branch,
        runs,
      }
      sendJson(res, 200, response)
    } catch (error) {
      sendRouteError(res, error)
    }
  })

  use("/api/github-actions/jobs", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "") return next()
    const cwd = url.searchParams.get("cwd") ?? ""
    const runIdText = url.searchParams.get("runId") ?? ""
    if (!/^\d+$/.test(runIdText)) {
      return sendJson(res, 400, { error: "runId must be a positive integer", code: "github_api_failed" })
    }

    try {
      const { repository } = await resolveRepository(cwd, dependencies)
      const runId = Number(runIdText)
      const endpoint = `repos/${repository.owner}/${repository.name}/actions/runs/${runId}/jobs?filter=latest&per_page=100`
      const jobs = parseJobsResponse(await dependencies.githubApi(repository, endpoint))
      const response: GitHubActionsJobsResponse = {
        repository: repositoryName(repository),
        runId,
        jobs,
      }
      sendJson(res, 200, response)
    } catch (error) {
      sendRouteError(res, error)
    }
  })
}
