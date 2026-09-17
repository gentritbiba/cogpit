export type VercelDeploymentState =
  | "BLOCKED"
  | "BUILDING"
  | "CANCELED"
  | "ERROR"
  | "INITIALIZING"
  | "QUEUED"
  | "READY"

export interface VercelDeployment {
  id: string
  name: string
  url: string | null
  inspectorUrl: string | null
  state: VercelDeploymentState
  target: string | null
  createdAt: number
  buildingAt: number | null
  readyAt: number | null
  branch: string
  commitSha: string
  commitMessage: string
  creator: string
  errorCode: string | null
  errorMessage: string | null
}

export interface VercelDeploymentsResponse {
  projectId: string
  projectName: string
  teamId: string
  projectUrl: string | null
  deployments: VercelDeployment[]
}

export interface VercelBuildLog {
  id: string
  createdAt: number
  type: string
  text: string
}

export interface VercelBuildLogsResponse {
  deploymentId: string
  events: VercelBuildLog[]
}

export type VercelDeploymentsErrorCode =
  | "invalid_response"
  | "vercel_access_denied"
  | "vercel_api_failed"
  | "vercel_auth_required"
  | "vercel_cli_too_old"
  | "vercel_missing"
  | "vercel_project_unlinked"

export interface VercelDeploymentsErrorResponse {
  error: string
  code: VercelDeploymentsErrorCode
}
