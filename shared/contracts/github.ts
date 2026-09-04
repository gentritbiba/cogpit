export type GitHubWorkflowStatus =
  | "completed"
  | "in_progress"
  | "pending"
  | "queued"
  | "requested"
  | "waiting"

export type GitHubWorkflowConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "success"
  | "timed_out"
  | null

export interface GitHubActionsRun {
  id: number
  name: string
  displayTitle: string
  status: GitHubWorkflowStatus
  conclusion: GitHubWorkflowConclusion
  url: string
  runNumber: number
  event: string
  branch: string
  commitSha: string
  createdAt: string
  updatedAt: string
  actor: string
}

export interface GitHubActionsStep {
  number: number
  name: string
  status: GitHubWorkflowStatus
  conclusion: GitHubWorkflowConclusion
  startedAt: string | null
  completedAt: string | null
}

export interface GitHubActionsJob {
  id: number
  name: string
  status: GitHubWorkflowStatus
  conclusion: GitHubWorkflowConclusion
  url: string
  startedAt: string | null
  completedAt: string | null
  steps: GitHubActionsStep[]
}

export interface GitHubActionsRunsResponse {
  repository: string
  repositoryUrl: string
  branch: string | null
  runs: GitHubActionsRun[]
}

export interface GitHubActionsJobsResponse {
  repository: string
  runId: number
  jobs: GitHubActionsJob[]
}

export type GitHubPullState = "open" | "draft" | "merged" | "closed"
export type GitHubPullChecks = "success" | "failure" | "pending"
export type GitHubPullReview = "approved" | "changes_requested" | "review_required"

export interface GitHubPullRequest {
  number: number
  title: string
  body: string
  state: GitHubPullState
  url: string
  author: string
  headBranch: string
  baseBranch: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  /** Rolled-up result of the checks on the head commit; null when the commit has none. */
  checks: GitHubPullChecks | null
  /** GitHub's review decision; null when the repository requires no review. */
  review: GitHubPullReview | null
  /** The signed-in GitHub user is a requested reviewer. */
  reviewRequested: boolean
  conflicts: boolean
  comments: number
}

export type GitHubPullFileStatus =
  | "added"
  | "changed"
  | "copied"
  | "modified"
  | "removed"
  | "renamed"
  | "unchanged"

export interface GitHubPullFile {
  path: string
  previousPath: string | null
  status: GitHubPullFileStatus
  additions: number
  deletions: number
}

export interface GitHubPullsResponse {
  repository: string
  repositoryUrl: string
  branch: string | null
  /** GitHub login of the signed-in user, for "mine" filters. */
  viewer: string | null
  pulls: GitHubPullRequest[]
}

/** A Cogpit session that opened or worked on pull requests of the repository. */
export interface GitHubPullSession {
  dirName: string
  fileName: string
  sessionId: string
  title: string
  numbers: number[]
}

export interface GitHubPullSessionsResponse {
  repository: string
  sessions: GitHubPullSession[]
  /** Session transcripts still being scanned; poll again while above zero. */
  pending: number
}

export interface GitHubPullFilesResponse {
  repository: string
  number: number
  files: GitHubPullFile[]
  /** GitHub caps the file listing; true when the pull request has more files than returned. */
  truncated: boolean
}

export type GitHubIssueState = "open" | "completed" | "not_planned"

export interface GitHubIssueLabel {
  name: string
  /** Six hex digits, as GitHub stores it. */
  color: string
}

export interface GitHubIssueLinkedPull {
  number: number
  state: GitHubPullState
}

export interface GitHubIssue {
  number: number
  title: string
  body: string
  state: GitHubIssueState
  url: string
  author: string
  assignees: string[]
  labels: GitHubIssueLabel[]
  /** Pull requests that reference this issue, newest first. */
  linkedPulls: GitHubIssueLinkedPull[]
  comments: number
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface GitHubIssuesResponse {
  repository: string
  repositoryUrl: string
  viewer: string | null
  issues: GitHubIssue[]
}

export type GitHubErrorCode =
  | "gh_missing"
  | "gh_auth_required"
  | "github_api_failed"
  | "invalid_response"
  | "no_git_repository"
  | "no_github_remote"

export interface GitHubErrorResponse {
  error: string
  code: GitHubErrorCode
}
