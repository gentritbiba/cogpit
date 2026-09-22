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
/**
 * GitHub's verdict on merging right now. `clean` and `unstable` (non-required
 * checks failing) merge; `behind` merges unless protection requires an
 * up-to-date branch; `blocked` waits on reviews or required checks; `unknown`
 * means GitHub is still computing and the answer arrives on the next poll.
 */
export type GitHubPullMergeState = "clean" | "unstable" | "behind" | "blocked" | "conflicts" | "unknown"
export type GitHubMergeMethod = "merge" | "squash" | "rebase"

/** How far the head commit's checks have come, counted across every check run and commit status. */
export interface GitHubPullCheckProgress {
  total: number
  completed: number
  /** At least one check reports from GitHub Actions in this repository. */
  actions: boolean
}

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
  /** Per-check progress behind `checks`; null when the commit has none. */
  checkProgress: GitHubPullCheckProgress | null
  /** GitHub's review decision; null when the repository requires no review. */
  review: GitHubPullReview | null
  /** The signed-in GitHub user is a requested reviewer. */
  reviewRequested: boolean
  conflicts: boolean
  comments: number
  /** Null once the pull request is merged, closed or still a draft. */
  mergeState: GitHubPullMergeState | null
  /** Full SHA of the head commit, pinned on merge so a changed branch is never merged unseen. */
  headSha: string
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
  /** Merge methods the repository allows, with the viewer's usual one first. */
  mergeMethods: GitHubMergeMethod[]
  pulls: GitHubPullRequest[]
}

export interface GitHubMergePullResponse {
  repository: string
  number: number
  merged: boolean
  /** SHA of the merge commit, when GitHub reports one. */
  sha: string | null
  message: string
}

/** An opaque host-authorized reference to a session associated with these pull requests. */
export interface GitHubPullSession {
  handle: string
  title: string
  numbers: number[]
}
export interface GitHubPullSessionsResponse {
  repository: string
  sessions: GitHubPullSession[]
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
