import type { GitHubIntegrationRequest } from "@cogpit/plugin-contracts"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { listProjectPullRequestSessions } from "../../lib/projectPullRequestSessions"
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
} from "../../../shared/contracts/github"
import { resolveGitProject, runGit } from "../../lib/gitProject"
import { clampLimit, nullableString, record, stringValue } from "../../routes/apiValues"

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

export interface GitHubRepository {
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

export interface GitHubDependencies {
  resolveProject: typeof resolveGitProject
  git: (cwd: string, args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>
  githubApi: (repository: GitHubRepository, endpoint: string, signal?: AbortSignal) => Promise<unknown>
  githubGraphql: (
    repository: GitHubRepository,
    query: string,
    variables: Record<string, string | number>,
    signal?: AbortSignal,
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

export class GitHubRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: GitHubErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
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

export function runGitHubApi(repository: GitHubRepository, endpoint: string, signal?: AbortSignal): Promise<unknown> {
  return runGh([
    "api",
    endpoint,
    "--hostname",
    repository.host,
    "-H",
    "Accept: application/vnd.github+json",
  ], signal)
}

export function runGitHubGraphql(
  repository: GitHubRepository,
  query: string,
  variables: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<unknown> {
  const args = ["api", "graphql", "--hostname", repository.host, "-f", `query=${query}`]
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`)
  }
  return runGh(args, signal)
}

async function runGh(args: string[], signal?: AbortSignal): Promise<unknown> {
  try {
    const result = await execFile("gh", args, {
      signal,
      encoding: "utf-8",
      env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
    })
    return JSON.parse(result.stdout) as unknown
  } catch (error) {
    signal?.throwIfAborted()
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
  authorize: () => Promise<void>,
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
    await authorize()
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

export type GitHubIntegrationResponse = GitHubActionsRunsResponse | GitHubActionsJobsResponse | GitHubPullsResponse | GitHubIssuesResponse | GitHubPullSessionsResponse | GitHubPullFilesResponse

export async function executeGitHubIntegration(
  input: GitHubIntegrationRequest,
  context: { workspacePath: string; signal: AbortSignal; authorize: () => Promise<void> },
  dependencies: GitHubDependencies = defaultDependencies,
): Promise<GitHubIntegrationResponse> {
  const check = async () => { context.signal.throwIfAborted(); await context.authorize(); context.signal.throwIfAborted() }
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    await check()
    try { return await operation() } finally { await check() }
  }
  const deps: GitHubDependencies = {
    resolveProject: cwd => guarded(() => dependencies.resolveProject(cwd, context.signal)),
    git: (cwd, args) => guarded(() => dependencies.git(cwd, args, context.signal)),
    githubApi: (repository, endpoint) => guarded(() => dependencies.githubApi(repository, endpoint, context.signal)),
    githubGraphql: (repository, query, variables) => guarded(() => dependencies.githubGraphql(repository, query, variables, context.signal)),
    pullRequestSessions: (projectPath, repository) => guarded(() => dependencies.pullRequestSessions(projectPath, repository)),
  }
  if (input.operation === "actionJobs" && (!Number.isSafeInteger(input.runId) || input.runId < 1)) throw new GitHubRouteError(400, "github_api_failed", "runId must be a positive integer")
  if (input.operation === "pullFiles" && (!Number.isSafeInteger(input.number) || input.number < 1)) throw new GitHubRouteError(400, "github_api_failed", "number must be a positive integer")
  const { repository, branch, projectPath } = await resolveRepository(context.workspacePath, deps, check)
  const name = repositoryName(repository), url = repositoryUrl(repository)
  switch (input.operation) {
    case "actions": {
      const limit = clampLimit(input.limit?.toString() ?? null, DEFAULT_RUNS, MAX_RUNS)
      const runs = parseRunsResponse(await deps.githubApi(repository, `repos/${name}/actions/runs?per_page=${limit}`)).slice(0, limit)
      return { repository: name, repositoryUrl: url, branch, runs }
    }
    case "actionJobs": {
      const jobs = parseJobsResponse(await deps.githubApi(repository, `repos/${name}/actions/runs/${input.runId}/jobs?filter=latest&per_page=100`)).slice(0, 100)
      return { repository: name, runId: input.runId, jobs }
    }
    case "pulls": {
      const limit = clampLimit(input.limit?.toString() ?? null, DEFAULT_PULLS, MAX_PULLS)
      const result = parsePullsResponse(await deps.githubGraphql(repository, PULLS_QUERY, { owner: repository.owner, name: repository.name, first: limit }))
      return { repository: name, repositoryUrl: url, branch, viewer: result.viewer, pulls: result.pulls.slice(0, limit) }
    }
    case "issues": {
      const limit = clampLimit(input.limit?.toString() ?? null, DEFAULT_ISSUES, MAX_ISSUES)
      const result = parseIssuesResponse(await deps.githubGraphql(repository, ISSUES_QUERY, { owner: repository.owner, name: repository.name, open: limit, closed: CLOSED_ISSUES }))
      return { repository: name, repositoryUrl: url, viewer: result.viewer, issues: result.issues.slice(0, limit + CLOSED_ISSUES) }
    }
    case "pullSessions": {
      const { sessions, pending } = await deps.pullRequestSessions(projectPath, name)
      return { repository: name, sessions, pending }
    }
    case "pullFiles": {
      const files = parsePullFilesResponse(await deps.githubApi(repository, `repos/${name}/pulls/${input.number}/files?per_page=${MAX_PULL_FILES}`)).slice(0, MAX_PULL_FILES)
      return { repository: name, number: input.number, files, truncated: files.length >= MAX_PULL_FILES }
    }
  }
}
