import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { listProjectPullRequestSessions } from "../lib/projectPullRequestSessions"
import type {
  GitHubActionsJob,
  GitHubActionsJobsResponse,
  GitHubActionsRun,
  GitHubActionsRunsResponse,
  GitHubActionsStep,
  GitHubErrorCode,
  GitHubIssue,
  GitHubIssueLabel,
  GitHubIssueLinkedPull,
  GitHubIssuesResponse,
  GitHubPullChecks,
  GitHubPullFile,
  GitHubPullFileStatus,
  GitHubPullFilesResponse,
  GitHubPullRequest,
  GitHubPullReview,
  GitHubPullSessionsResponse,
  GitHubPullState,
  GitHubPullsResponse,
  GitHubWorkflowConclusion,
  GitHubWorkflowStatus,
} from "../../shared/contracts/github"
import { sendJson, type UseFn } from "../http"
import { resolveGitProject, runGit } from "../lib/gitProject"

const execFile = promisify(execFileCallback)
const MAX_RUNS = 30
const DEFAULT_RUNS = 20
const MAX_PULLS = 50
const DEFAULT_PULLS = 30
const MAX_PULL_FILES = 100
const MAX_ISSUES = 50
const DEFAULT_ISSUES = 30
/** Closed issues are history; a short tail keeps the fold useful without doubling the request. */
const CLOSED_ISSUES = 15
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

const PULL_FILE_STATUSES = new Set<GitHubPullFileStatus>([
  "added",
  "changed",
  "copied",
  "modified",
  "removed",
  "renamed",
  "unchanged",
])

interface GitHubDependencies {
  resolveProject: typeof resolveGitProject
  git: typeof runGit
  githubApi: (repository: GitHubRepository, endpoint: string) => Promise<unknown>
  githubGraphql: (
    repository: GitHubRepository,
    query: string,
    variables: Record<string, string | number>,
  ) => Promise<unknown>
  pullRequestSessions: typeof listProjectPullRequestSessions
}

/**
 * One request for the whole pull request list, including the signals the list
 * endpoint leaves out: check rollup, review decision, requested reviewers,
 * merge conflicts, and comment count.
 */
export const PULLS_QUERY = `
query($owner: String!, $name: String!, $first: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        body
        state
        isDraft
        url
        author { login }
        headRefName
        baseRefName
        createdAt
        updatedAt
        closedAt
        mergedAt
        reviewDecision
        mergeable
        comments { totalCount }
        reviewRequests(first: 30) {
          nodes { requestedReviewer { ... on User { login } } }
        }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}`

class GitHubRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: GitHubErrorCode,
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

function nullableString(value: unknown): string | null {
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
    startedAt: nullableString(source.started_at),
    completedAt: nullableString(source.completed_at),
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
    startedAt: nullableString(source.started_at),
    completedAt: nullableString(source.completed_at),
    steps: Array.isArray(source.steps)
      ? source.steps.map(parseStep).filter((step): step is GitHubActionsStep => step !== null)
      : [],
  }
}

export const ISSUES_QUERY = `
query($owner: String!, $name: String!, $open: Int!, $closed: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    open: issues(first: $open, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ...IssueFields }
    }
    closed: issues(first: $closed, states: [CLOSED], orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ...IssueFields }
    }
  }
}
fragment IssueFields on Issue {
  number
  title
  body
  state
  stateReason
  url
  author { login }
  createdAt
  updatedAt
  closedAt
  comments { totalCount }
  labels(first: 10) { nodes { name color } }
  assignees(first: 10) { nodes { login } }
  timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 10) {
    nodes {
      ... on CrossReferencedEvent {
        source { ... on PullRequest { number state isDraft } }
      }
    }
  }
}`

function pullChecks(value: unknown): GitHubPullChecks | null {
  if (value === "SUCCESS") return "success"
  if (value === "FAILURE" || value === "ERROR") return "failure"
  if (value === "PENDING" || value === "EXPECTED") return "pending"
  return null
}

function pullReview(value: unknown): GitHubPullReview | null {
  if (value === "APPROVED") return "approved"
  if (value === "CHANGES_REQUESTED") return "changes_requested"
  if (value === "REVIEW_REQUIRED") return "review_required"
  return null
}

function nodes(value: unknown): unknown[] {
  const list = record(value)?.nodes
  return Array.isArray(list) ? list : []
}

function parsePull(value: unknown, viewer: string): GitHubPullRequest | null {
  const source = record(value)
  if (!source) return null
  const number = numberValue(source.number)
  const url = stringValue(source.url)
  if (number === null || !url.startsWith("https://")) return null
  const mergedAt = nullableString(source.mergedAt)
  const state = pullStateOf(source)
  const headCommit = record(nodes(source.commits)[0])?.commit
  const reviewers = nodes(source.reviewRequests)
    .map((request) => stringValue(record(record(request)?.requestedReviewer)?.login))

  return {
    number,
    title: stringValue(source.title, `Pull request #${number}`),
    body: stringValue(source.body),
    state,
    url,
    author: stringValue(record(source.author)?.login),
    headBranch: stringValue(source.headRefName),
    baseBranch: stringValue(source.baseRefName),
    createdAt: stringValue(source.createdAt),
    updatedAt: stringValue(source.updatedAt),
    closedAt: mergedAt ?? nullableString(source.closedAt),
    checks: pullChecks(record(record(headCommit)?.statusCheckRollup)?.state),
    review: pullReview(source.reviewDecision),
    reviewRequested: viewer !== "" && reviewers.includes(viewer),
    conflicts: source.mergeable === "CONFLICTING",
    comments: numberValue(record(source.comments)?.totalCount) ?? 0,
  }
}

function parsePullFile(value: unknown): GitHubPullFile | null {
  const source = record(value)
  if (!source) return null
  const path = stringValue(source.filename)
  if (!path) return null
  return {
    path,
    previousPath: nullableString(source.previous_filename),
    status: typeof source.status === "string" && PULL_FILE_STATUSES.has(source.status as GitHubPullFileStatus)
      ? source.status as GitHubPullFileStatus
      : "modified",
    additions: numberValue(source.additions) ?? 0,
    deletions: numberValue(source.deletions) ?? 0,
  }
}

export function parseRunsResponse(value: unknown): GitHubActionsRun[] {
  const source = record(value)
  if (!source || !Array.isArray(source.workflow_runs)) {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid workflow response")
  }
  return source.workflow_runs
    .map(parseRun)
    .filter((run): run is GitHubActionsRun => run !== null)
}

export function parseJobsResponse(value: unknown): GitHubActionsJob[] {
  const source = record(value)
  if (!source || !Array.isArray(source.jobs)) {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid jobs response")
  }
  return source.jobs
    .map(parseJob)
    .filter((job): job is GitHubActionsJob => job !== null)
}

function pullStateOf(source: Record<string, unknown>): GitHubPullState {
  if (source.state === "OPEN") return source.isDraft === true ? "draft" : "open"
  return source.state === "MERGED" ? "merged" : "closed"
}

function parseIssue(value: unknown): GitHubIssue | null {
  const source = record(value)
  if (!source) return null
  const number = numberValue(source.number)
  const url = stringValue(source.url)
  if (number === null || !url.startsWith("https://")) return null

  const linkedPulls: GitHubIssueLinkedPull[] = []
  for (const item of nodes(source.timelineItems).reverse()) {
    const pull = record(record(item)?.source)
    const pullNumber = pull ? numberValue(pull.number) : null
    if (!pull || pullNumber === null || typeof pull.state !== "string") continue
    if (linkedPulls.some((linked) => linked.number === pullNumber)) continue
    linkedPulls.push({ number: pullNumber, state: pullStateOf(pull) })
  }

  return {
    number,
    title: stringValue(source.title, `Issue #${number}`),
    body: stringValue(source.body),
    state: source.state === "OPEN" ? "open" : (source.stateReason === "NOT_PLANNED" ? "not_planned" : "completed"),
    url,
    author: stringValue(record(source.author)?.login),
    assignees: nodes(source.assignees).map((node) => stringValue(record(node)?.login)).filter(Boolean),
    labels: nodes(source.labels).flatMap((node): GitHubIssueLabel[] => {
      const label = record(node)
      const name = stringValue(label?.name)
      return name ? [{ name, color: stringValue(label?.color, "888888") }] : []
    }),
    linkedPulls,
    comments: numberValue(record(source.comments)?.totalCount) ?? 0,
    createdAt: stringValue(source.createdAt),
    updatedAt: stringValue(source.updatedAt),
    closedAt: nullableString(source.closedAt),
  }
}

export function parseIssuesResponse(value: unknown): { viewer: string | null; issues: GitHubIssue[] } {
  const data = record(record(value)?.data)
  const repository = record(data?.repository)
  const open = record(repository?.open)?.nodes
  const closed = record(repository?.closed)?.nodes
  if (!data || !Array.isArray(open) || !Array.isArray(closed)) {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid issue response")
  }
  const viewer = stringValue(record(data.viewer)?.login)
  return {
    viewer: viewer || null,
    issues: [...open, ...closed].map(parseIssue).filter((issue): issue is GitHubIssue => issue !== null),
  }
}

export function parsePullsResponse(value: unknown): { viewer: string | null; pulls: GitHubPullRequest[] } {
  const data = record(record(value)?.data)
  const list = record(record(data?.repository)?.pullRequests)?.nodes
  if (!data || !Array.isArray(list)) {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid pull request response")
  }
  const viewer = stringValue(record(data.viewer)?.login)
  return {
    viewer: viewer || null,
    pulls: list.map((node) => parsePull(node, viewer)).filter((pull): pull is GitHubPullRequest => pull !== null),
  }
}

export function parsePullFilesResponse(value: unknown): GitHubPullFile[] {
  if (!Array.isArray(value)) {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid pull request files response")
  }
  return value.map(parsePullFile).filter((file): file is GitHubPullFile => file !== null)
}

export function runGitHubApi(repository: GitHubRepository, endpoint: string): Promise<unknown> {
  return runGh([
    "api",
    endpoint,
    "--hostname",
    repository.host,
    "-H",
    "Accept: application/vnd.github+json",
  ])
}

export function runGitHubGraphql(
  repository: GitHubRepository,
  query: string,
  variables: Record<string, string | number>,
): Promise<unknown> {
  const args = ["api", "graphql", "--hostname", repository.host, "-f", `query=${query}`]
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`)
  }
  return runGh(args)
}

async function runGh(args: string[]): Promise<unknown> {
  try {
    const result = await execFile("gh", args, {
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
      throw new GitHubRouteError(503, "gh_missing", "Install the GitHub CLI to view this repository on GitHub")
    }
    const detail = `${failure.message ?? ""}\n${failure.stderr ?? ""}`
    if (/auth login|not logged|authentication|oauth token/i.test(detail)) {
      throw new GitHubRouteError(503, "gh_auth_required", "Sign in with `gh auth login` to view this repository on GitHub")
    }
    throw new GitHubRouteError(502, "github_api_failed", "GitHub data is unavailable")
  }
}

const defaultDependencies: GitHubDependencies = {
  resolveProject: resolveGitProject,
  git: runGit,
  githubApi: runGitHubApi,
  githubGraphql: runGitHubGraphql,
  pullRequestSessions: listProjectPullRequestSessions,
}

async function resolveRepository(
  cwd: string,
  dependencies: GitHubDependencies,
): Promise<{ repository: GitHubRepository; branch: string | null; projectPath: string }> {
  const project = await dependencies.resolveProject(cwd)
  if (!project.ok) throw new GitHubRouteError(project.status, "no_git_repository", project.error)
  if (!project.root) {
    throw new GitHubRouteError(400, "no_git_repository", "This project is not a Git repository")
  }

  let remoteUrl = ""
  try {
    remoteUrl = (await dependencies.git(project.root, ["remote", "get-url", "origin"])).stdout
  } catch {
    throw new GitHubRouteError(400, "no_github_remote", "This repository has no origin remote")
  }
  const repository = parseGitHubRemote(remoteUrl)
  if (!repository) {
    throw new GitHubRouteError(400, "no_github_remote", "The origin remote is not a supported GitHub repository")
  }

  const branchResult = await dependencies.git(project.root, ["branch", "--show-current"])
  return {
    repository,
    branch: branchResult.stdout.trim() || null,
    projectPath: project.projectPath,
  }
}

function repositoryName(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.name}`
}

function repositoryUrl(repository: GitHubRepository): string {
  return `https://${repository.host}/${repository.owner}/${repository.name}`
}

function sendRouteError(res: Parameters<typeof sendJson>[0], error: unknown): void {
  if (error instanceof GitHubRouteError) {
    sendJson(res, error.status, { error: error.message, code: error.code })
    return
  }
  sendJson(res, 500, { error: "Unable to load GitHub data", code: "github_api_failed" })
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  const requested = Number(raw ?? fallback)
  return Number.isInteger(requested) ? Math.min(max, Math.max(1, requested)) : fallback
}

type RouteHandler = (
  url: URL,
  dependencies: GitHubDependencies,
) => Promise<{ status: number; body: unknown }>

function repositoryRoute(use: UseFn, path: string, dependencies: GitHubDependencies, handler: RouteHandler): void {
  use(path, async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "") return next()
    try {
      const result = await handler(url, dependencies)
      sendJson(res, result.status, result.body)
    } catch (error) {
      sendRouteError(res, error)
    }
  })
}

export function registerGitHubRoutes(
  use: UseFn,
  dependencies: GitHubDependencies = defaultDependencies,
): void {
  repositoryRoute(use, "/api/github/actions", dependencies, async (url, deps) => {
    const cwd = url.searchParams.get("cwd") ?? ""
    const limit = clampLimit(url.searchParams.get("limit"), DEFAULT_RUNS, MAX_RUNS)
    const { repository, branch } = await resolveRepository(cwd, deps)
    const endpoint = `repos/${repository.owner}/${repository.name}/actions/runs?per_page=${limit}`
    const runs = parseRunsResponse(await deps.githubApi(repository, endpoint))
    const body: GitHubActionsRunsResponse = {
      repository: repositoryName(repository),
      repositoryUrl: repositoryUrl(repository),
      branch,
      runs,
    }
    return { status: 200, body }
  })

  repositoryRoute(use, "/api/github/actions/jobs", dependencies, async (url, deps) => {
    const cwd = url.searchParams.get("cwd") ?? ""
    const runIdText = url.searchParams.get("runId") ?? ""
    if (!/^\d+$/.test(runIdText)) {
      return { status: 400, body: { error: "runId must be a positive integer", code: "github_api_failed" } }
    }
    const { repository } = await resolveRepository(cwd, deps)
    const runId = Number(runIdText)
    const endpoint = `repos/${repository.owner}/${repository.name}/actions/runs/${runId}/jobs?filter=latest&per_page=100`
    const jobs = parseJobsResponse(await deps.githubApi(repository, endpoint))
    const body: GitHubActionsJobsResponse = { repository: repositoryName(repository), runId, jobs }
    return { status: 200, body }
  })

  repositoryRoute(use, "/api/github/pulls", dependencies, async (url, deps) => {
    const cwd = url.searchParams.get("cwd") ?? ""
    const limit = clampLimit(url.searchParams.get("limit"), DEFAULT_PULLS, MAX_PULLS)
    const { repository, branch } = await resolveRepository(cwd, deps)
    const { viewer, pulls } = parsePullsResponse(await deps.githubGraphql(repository, PULLS_QUERY, {
      owner: repository.owner,
      name: repository.name,
      first: limit,
    }))
    const body: GitHubPullsResponse = {
      repository: repositoryName(repository),
      repositoryUrl: repositoryUrl(repository),
      branch,
      viewer,
      pulls,
    }
    return { status: 200, body }
  })

  repositoryRoute(use, "/api/github/issues", dependencies, async (url, deps) => {
    const cwd = url.searchParams.get("cwd") ?? ""
    const limit = clampLimit(url.searchParams.get("limit"), DEFAULT_ISSUES, MAX_ISSUES)
    const { repository } = await resolveRepository(cwd, deps)
    const { viewer, issues } = parseIssuesResponse(await deps.githubGraphql(repository, ISSUES_QUERY, {
      owner: repository.owner,
      name: repository.name,
      open: limit,
      closed: CLOSED_ISSUES,
    }))
    const body: GitHubIssuesResponse = {
      repository: repositoryName(repository),
      repositoryUrl: repositoryUrl(repository),
      viewer,
      issues,
    }
    return { status: 200, body }
  })

  repositoryRoute(use, "/api/github/pulls/sessions", dependencies, async (url, deps) => {
    const cwd = url.searchParams.get("cwd") ?? ""
    const { repository, projectPath } = await resolveRepository(cwd, deps)
    const name = repositoryName(repository)
    const { sessions, pending } = await deps.pullRequestSessions(projectPath, name)
    const body: GitHubPullSessionsResponse = { repository: name, sessions, pending }
    return { status: 200, body }
  })

  repositoryRoute(use, "/api/github/pulls/files", dependencies, async (url, deps) => {
    const cwd = url.searchParams.get("cwd") ?? ""
    const numberText = url.searchParams.get("number") ?? ""
    if (!/^\d+$/.test(numberText)) {
      return { status: 400, body: { error: "number must be a positive integer", code: "github_api_failed" } }
    }
    const { repository } = await resolveRepository(cwd, deps)
    const number = Number(numberText)
    const endpoint = `repos/${repository.owner}/${repository.name}/pulls/${number}/files?per_page=${MAX_PULL_FILES}`
    const files = parsePullFilesResponse(await deps.githubApi(repository, endpoint))
    const body: GitHubPullFilesResponse = {
      repository: repositoryName(repository),
      number,
      files,
      truncated: files.length >= MAX_PULL_FILES,
    }
    return { status: 200, body }
  })
}
