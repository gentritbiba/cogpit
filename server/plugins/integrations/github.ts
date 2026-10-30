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
  GitHubMergeMethod,
  GitHubMergePullResponse,
  GitHubPullCheckProgress,
  GitHubPullChecks,
  GitHubPullFile,
  GitHubPullFileStatus,
  GitHubPullFilesResponse,
  GitHubPullMergeState,
  GitHubPullRequest,
  GitHubPullReview,
  GitHubPullReviewResponse,
  GitHubPullSessionsResponse,
  GitHubReviewFile,
  GitHubReviewGuideResponse,
  GitHubSubmitReviewResponse,
  GitHubPullState,
  GitHubPullsResponse,
  GitHubWorkflowConclusion,
  GitHubWorkflowStatus,
} from "../../../shared/contracts/github"
import { resolveGitProject, runGit } from "../../lib/gitProject"
import { clampLimit, nullableString, record, stringValue } from "../../routes/apiValues"
import { reviewGuides } from "../../prReview/guides"

const execFile = promisify(execFileCallback)
const MAX_RUNS = 30
const DEFAULT_RUNS = 20
const MAX_PULLS = 50
const DEFAULT_PULLS = 30
const MAX_PULL_FILES = 100
/** Review pages stay small enough that their patches fit one plugin response. */
const REVIEW_PAGE_FILES = 30
const REVIEW_PATCH_BYTES = 48 * 1024
const GITHUB_LISTED_FILES = 3000
const REVIEW_MARKER = (submissionId: string) => `<!-- cogpit-review-submission:${submissionId} -->`
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
  /** A write to the REST API; `fields` become string form fields of the request body. */
  githubMutate: (repository: GitHubRepository, method: "PUT", endpoint: string, fields: Record<string, string>, signal?: AbortSignal) => Promise<unknown>
  /** A JSON POST; any failure other than GitHub refusing it is `unknown_outcome`, since it may have landed. */
  githubPost: (repository: GitHubRepository, endpoint: string, body: unknown, signal?: AbortSignal) => Promise<unknown>
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
 * endpoint leaves out: check rollup with its individual runs, review decision,
 * requested reviewers, merge state, and comment count.
 */
export const PULLS_QUERY = `
query($owner: String!, $name: String!, $first: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    viewerDefaultMergeMethod
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
        headRefOid
        baseRefName
        additions
        deletions
        createdAt
        updatedAt
        closedAt
        mergedAt
        reviewDecision
        mergeable
        mergeStateStatus
        viewerCanUpdate
        comments { totalCount }
        reviewRequests(first: 30) {
          nodes { requestedReviewer { ... on User { login } } }
        }
        commits(last: 1) {
          nodes { commit { statusCheckRollup {
            state
            contexts(first: 20) {
              totalCount
              checkRunCountsByState { state count }
              statusContextCount
              nodes {
                __typename
                ... on CheckRun { detailsUrl }
                ... on StatusContext { state targetUrl }
              }
            }
          } } }
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

const ACTIONS_RUN_URL = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/\d+/

/**
 * Check runs are counted by GitHub; commit statuses only carry a state per
 * node, so a pending one past the loaded page counts as done and the ring
 * fills a touch early for repositories with many external statuses.
 */
function checkProgress(rollup: Record<string, unknown> | null): GitHubPullCheckProgress | null {
  const contexts = record(rollup?.contexts)
  const total = numberValue(contexts?.totalCount) ?? 0
  if (total === 0) return null
  const runStates = Array.isArray(contexts?.checkRunCountsByState) ? contexts.checkRunCountsByState : []
  const completedRuns = runStates.reduce<number>((sum, entry) => {
    const item = record(entry)
    return item?.state === "COMPLETED" ? sum + (numberValue(item.count) ?? 0) : sum
  }, 0)
  let pendingStatuses = 0
  let actions = false
  for (const node of nodes(contexts)) {
    const context = record(node)
    if (!context) continue
    if (context.__typename === "CheckRun") {
      if (ACTIONS_RUN_URL.test(stringValue(context.detailsUrl))) actions = true
    } else {
      if (context.state === "PENDING" || context.state === "EXPECTED") pendingStatuses += 1
      if (ACTIONS_RUN_URL.test(stringValue(context.targetUrl))) actions = true
    }
  }
  const statuses = numberValue(contexts?.statusContextCount) ?? 0
  const completed = Math.min(total, completedRuns + Math.max(0, statuses - pendingStatuses))
  return { total, completed, actions }
}

function pullMergeState(source: Record<string, unknown>, state: GitHubPullState): GitHubPullMergeState | null {
  if (state !== "open") return null
  if (source.viewerCanUpdate === false) return "blocked"
  switch (source.mergeStateStatus) {
    case "CLEAN": case "HAS_HOOKS": return "clean"
    case "UNSTABLE": return "unstable"
    case "BEHIND": return "behind"
    case "BLOCKED": return "blocked"
    case "DIRTY": return "conflicts"
    default: return source.mergeable === "CONFLICTING" ? "conflicts" : "unknown"
  }
}

const MERGE_METHODS: Record<string, GitHubMergeMethod> = { MERGE: "merge", SQUASH: "squash", REBASE: "rebase" }

function mergeMethods(repository: Record<string, unknown> | null): GitHubMergeMethod[] {
  const allowed: GitHubMergeMethod[] = []
  if (repository?.mergeCommitAllowed === true) allowed.push("merge")
  if (repository?.squashMergeAllowed === true) allowed.push("squash")
  if (repository?.rebaseMergeAllowed === true) allowed.push("rebase")
  const preferred = MERGE_METHODS[stringValue(repository?.viewerDefaultMergeMethod)]
  if (!preferred || !allowed.includes(preferred)) return allowed
  return [preferred, ...allowed.filter((method) => method !== preferred)]
}

function parsePull(value: unknown, viewer: string): GitHubPullRequest | null {
  const source = record(value)
  if (!source) return null
  const number = numberValue(source.number)
  const url = stringValue(source.url)
  if (number === null || !url.startsWith("https://")) return null
  const mergedAt = nullableString(source.mergedAt)
  const state = pullStateOf(source)
  const rollup = record(record(record(nodes(source.commits)[0])?.commit)?.statusCheckRollup)
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
    checks: pullChecks(rollup?.state),
    checkProgress: checkProgress(rollup),
    review: pullReview(source.reviewDecision),
    reviewRequested: viewer !== "" && reviewers.includes(viewer),
    conflicts: source.mergeable === "CONFLICTING",
    comments: numberValue(record(source.comments)?.totalCount) ?? 0,
    mergeState: pullMergeState(source, state),
    headSha: stringValue(source.headRefOid),
    additions: numberValue(source.additions) ?? 0,
    deletions: numberValue(source.deletions) ?? 0,
  }
}

export function parseMergeResponse(value: unknown, number: number): Omit<GitHubMergePullResponse, "repository"> {
  const source = record(value)
  if (!source || typeof source.merged !== "boolean") {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid merge response")
  }
  return { number, merged: source.merged, sha: nullableString(source.sha), message: stringValue(source.message) }
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

export function parsePullsResponse(value: unknown): { viewer: string | null; mergeMethods: GitHubMergeMethod[]; pulls: GitHubPullRequest[] } {
  const data = record(record(value)?.data)
  const repository = record(data?.repository)
  const list = record(repository?.pullRequests)?.nodes
  if (!data || !Array.isArray(list)) {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid pull request response")
  }
  const viewer = stringValue(record(data.viewer)?.login)
  return {
    viewer: viewer || null,
    mergeMethods: mergeMethods(repository),
    pulls: list.map((node) => parsePull(node, viewer)).filter((pull): pull is GitHubPullRequest => pull !== null),
  }
}

export function parsePullFilesResponse(value: unknown): GitHubPullFile[] {
  if (!Array.isArray(value)) {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid pull request files response")
  }
  return value.map(parsePullFile).filter((file): file is GitHubPullFile => file !== null)
}

export function parseReviewFile(value: unknown): GitHubReviewFile | null {
  const file = parsePullFile(value)
  const source = record(value)
  if (!file || !source) return null
  const patch = typeof source.patch === "string" ? source.patch : null
  const changes = numberValue(source.changes) ?? file.additions + file.deletions
  const blobSha = nullableString(source.sha)
  if (patch !== null) {
    return Buffer.byteLength(patch) > REVIEW_PATCH_BYTES
      ? { ...file, blobSha, patch: null, patchState: "too-large" }
      : { ...file, blobSha, patch, patchState: "text" }
  }
  if (changes === 0) return { ...file, blobSha, patch: file.status === "renamed" || file.status === "removed" || file.status === "added" ? "" : null, patchState: file.status === "renamed" ? "text" : "binary" }
  return { ...file, blobSha, patch: null, patchState: "too-large" }
}

/** Base, head and identity of a pull request as GitHub reports them now. */
export function parsePullPins(value: unknown, number: number) {
  const source = record(value)
  const head = record(source?.head), base = record(source?.base)
  const headSha = stringValue(head?.sha), baseSha = stringValue(base?.sha)
  if (!source || !/^[0-9a-f]{40}$/.test(headSha) || !/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid pull request")
  }
  const state: GitHubPullRequest["state"] = source.merged_at ? "merged" : source.state === "closed" ? "closed" : source.draft === true ? "draft" : "open"
  return {
    number, headSha, baseSha, state,
    title: stringValue(source.title, `Pull request #${number}`),
    url: stringValue(source.html_url),
    headBranch: stringValue(head?.ref),
    baseBranch: stringValue(base?.ref),
    changedFiles: numberValue(source.changed_files) ?? 0,
  }
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

export function runGitHubMutation(
  repository: GitHubRepository,
  method: "PUT",
  endpoint: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const args = ["api", "-X", method, endpoint, "--hostname", repository.host, "-H", "Accept: application/vnd.github+json"]
  for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`)
  return runGh(args, signal, { refusal: "GitHub declined the change" })
}

export function runGitHubPost(repository: GitHubRepository, endpoint: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return runGh(["api", "-X", "POST", endpoint, "--hostname", repository.host, "-H", "Accept: application/vnd.github+json", "--input", "-"], signal, { refusal: "GitHub declined the review", input: JSON.stringify(body), unknownOnFailure: true })
}

/** `gh api` reports a refused request as `gh: <reason> (HTTP <status>)` on stderr. */
const GH_HTTP_FAILURE = /^gh: (.+?) \(HTTP (\d{3})\)/m

/** With `refusal`, a request GitHub turned down surfaces its reason under that prefix instead of the generic failure. */
async function runGh(args: string[], signal?: AbortSignal, options: { refusal?: string; input?: string; unknownOnFailure?: boolean } = {}): Promise<unknown> {
  try {
    const running = execFile("gh", args, {
      signal,
      encoding: "utf-8",
      env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
    })
    if (options.input !== undefined) running.child.stdin?.end(options.input)
    const result = await running
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
    const refused = options.refusal ? GH_HTTP_FAILURE.exec(failure.stderr ?? "") : null
    if (refused && Number(refused[2]) < 500) {
      throw new GitHubRouteError(Number(refused[2]), "github_api_failed", `${options.refusal}: ${refused[1].slice(0, 200)}`)
    }
    if (options.unknownOnFailure) throw new GitHubRouteError(502, "unknown_outcome", "GitHub did not confirm the review; check before submitting again")
    if (refused) throw new GitHubRouteError(Number(refused[2]), "github_api_failed", `${options.refusal}: ${refused[1].slice(0, 200)}`)
    throw new GitHubRouteError(502, "github_api_failed", options.refusal ?? "GitHub data is unavailable")
  }
}

export const defaultDependencies: GitHubDependencies = {
  resolveProject: resolveGitProject,
  git: runGit,
  githubApi: runGitHubApi,
  githubMutate: runGitHubMutation,
  githubPost: runGitHubPost,
  githubGraphql: runGitHubGraphql,
  pullRequestSessions: listProjectPullRequestSessions,
}

export async function resolveRepository(
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

export function repositoryName(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.name}`
}

function repositoryUrl(repository: GitHubRepository): string {
  return `https://${repository.host}/${repository.owner}/${repository.name}`
}

export type GitHubIntegrationResponse = GitHubActionsRunsResponse | GitHubActionsJobsResponse | GitHubPullsResponse | GitHubIssuesResponse | GitHubPullSessionsResponse
  | GitHubPullFilesResponse | GitHubMergePullResponse | GitHubPullReviewResponse | GitHubSubmitReviewResponse | GitHubReviewGuideResponse | { cancelled: boolean }

/** Earlier reviews, newest pages last; a submission id found here was already posted. */
async function findSubmittedReview(deps: GitHubDependencies, repository: GitHubRepository, number: number, submissionId: string): Promise<{ id: number | null; url: string | null } | null> {
  const marker = REVIEW_MARKER(submissionId)
  for (let page = 1; page <= 10; page++) {
    const reviews = await deps.githubApi(repository, `repos/${repositoryName(repository)}/pulls/${number}/reviews?per_page=100&page=${page}`)
    if (!Array.isArray(reviews)) throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid review list")
    const found = reviews.map(record).find((review) => stringValue(review?.body).includes(marker))
    if (found) return { id: numberValue(found.id), url: nullableString(found.html_url) }
    if (reviews.length < 100) return null
  }
  return null
}

export async function executeGitHubIntegration(
  input: GitHubIntegrationRequest,
  context: { workspacePath: string; signal: AbortSignal; authorize: () => Promise<void>; principal?: string },
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
    githubMutate: (repository, method, endpoint, fields) => guarded(() => dependencies.githubMutate(repository, method, endpoint, fields, context.signal)),
    githubPost: (repository, endpoint, body) => guarded(() => dependencies.githubPost(repository, endpoint, body, context.signal)),
    githubGraphql: (repository, query, variables) => guarded(() => dependencies.githubGraphql(repository, query, variables, context.signal)),
    pullRequestSessions: (projectPath, repository) => guarded(() => dependencies.pullRequestSessions(projectPath, repository)),
  }
  if (input.operation === "actionJobs" && (!Number.isSafeInteger(input.runId) || input.runId < 1)) throw new GitHubRouteError(400, "github_api_failed", "runId must be a positive integer")
  if ("number" in input && (!Number.isSafeInteger(input.number) || input.number < 1)) throw new GitHubRouteError(400, "github_api_failed", "number must be a positive integer")
  if (input.operation === "mergePull" && !/^[0-9a-f]{40}$/.test(input.headSha)) throw new GitHubRouteError(400, "github_api_failed", "headSha must be a full commit SHA")
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
      return { repository: name, repositoryUrl: url, branch, viewer: result.viewer, mergeMethods: result.mergeMethods, pulls: result.pulls.slice(0, limit) }
    }
    case "mergePull": {
      const result = await deps.githubMutate(repository, "PUT", `repos/${name}/pulls/${input.number}/merge`, { merge_method: input.method, sha: input.headSha })
      return { repository: name, ...parseMergeResponse(result, input.number) }
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
    case "pullReview": {
      const page = input.page ?? 1
      const pins = parsePullPins(await deps.githubApi(repository, `repos/${name}/pulls/${input.number}`), input.number)
      const listed = Math.min(pins.changedFiles, GITHUB_LISTED_FILES)
      const raw = (page - 1) * REVIEW_PAGE_FILES < listed ? await deps.githubApi(repository, `repos/${name}/pulls/${input.number}/files?per_page=${REVIEW_PAGE_FILES}&page=${page}`) : []
      if (!Array.isArray(raw)) throw new GitHubRouteError(502, "invalid_response", "GitHub returned an invalid pull request files response")
      const after = parsePullPins(await deps.githubApi(repository, `repos/${name}/pulls/${input.number}`), input.number)
      if (after.headSha !== pins.headSha || after.baseSha !== pins.baseSha) throw new GitHubRouteError(409, "stale_head", "The pull request changed while its files were read; reload it")
      return {
        repository: name, host: repository.host, number: input.number, title: pins.title, url: pins.url, state: pins.state,
        baseSha: pins.baseSha, headSha: pins.headSha, baseBranch: pins.baseBranch, headBranch: pins.headBranch,
        totalFiles: pins.changedFiles, filesCapped: pins.changedFiles > GITHUB_LISTED_FILES, page,
        nextPage: page * REVIEW_PAGE_FILES < listed ? page + 1 : null,
        files: raw.slice(0, REVIEW_PAGE_FILES).map(parseReviewFile).filter((file): file is GitHubReviewFile => file !== null),
      }
    }
    case "submitReview": {
      const pins = parsePullPins(await deps.githubApi(repository, `repos/${name}/pulls/${input.number}`), input.number)
      const earlier = await findSubmittedReview(deps, repository, input.number, input.submissionId)
      if (earlier) return { repository: name, number: input.number, outcome: "already-submitted", headSha: input.headSha, baseSha: input.baseSha, reviewId: earlier.id, url: earlier.url }
      if (pins.headSha !== input.headSha || pins.baseSha !== input.baseSha) return { repository: name, number: input.number, outcome: "stale-head", headSha: pins.headSha, baseSha: pins.baseSha, reviewId: null, url: null }
      const body = `${input.body.trim()}\n\n${REVIEW_MARKER(input.submissionId)}`.trimStart()
      const posted = record(await deps.githubPost(repository, `repos/${name}/pulls/${input.number}/reviews`, {
        commit_id: input.headSha, event: "COMMENT", body,
        comments: input.comments.map((comment) => ({ path: comment.path, side: comment.side, line: comment.line, body: comment.body })),
      }))
      return { repository: name, number: input.number, outcome: "submitted", headSha: input.headSha, baseSha: input.baseSha, reviewId: numberValue(posted?.id), url: nullableString(posted?.html_url) }
    }
    case "reviewGuide":
      return { repository: name, number: input.number, guide: await reviewGuides.get({ principal: context.principal ?? "owner", ...repository, number: input.number }) }
    case "cancelReviewGuide":
      return { cancelled: reviewGuides.cancel({ principal: context.principal ?? "owner", ...repository, number: input.number }) }
    case "pullFiles": {
      const files = parsePullFilesResponse(await deps.githubApi(repository, `repos/${name}/pulls/${input.number}/files?per_page=${MAX_PULL_FILES}`)).slice(0, MAX_PULL_FILES)
      return { repository: name, number: input.number, files, truncated: files.length >= MAX_PULL_FILES }
    }
  }
}
