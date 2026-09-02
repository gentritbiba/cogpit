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

export type GitHubActionsErrorCode =
  | "gh_missing"
  | "gh_auth_required"
  | "github_api_failed"
  | "invalid_response"
  | "no_git_repository"
  | "no_github_remote"

export interface GitHubActionsErrorResponse {
  error: string
  code: GitHubActionsErrorCode
}
