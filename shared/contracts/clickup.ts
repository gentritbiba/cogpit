/** ClickUp's own grouping of a status: open and custom are active, closed and done are finished. */
export type ClickUpStatusType = "open" | "custom" | "closed" | "done"

export type ClickUpPriority = "urgent" | "high" | "normal" | "low"

export interface ClickUpStatus {
  name: string
  type: ClickUpStatusType
  /** CSS colour as ClickUp stores it, such as `#d3d3d3`. */
  color: string
  /** Position in the list's workflow; lower comes first. */
  order: number
}

export interface ClickUpUser {
  id: number
  username: string
  initials: string
  color: string | null
}

export interface ClickUpTag {
  name: string
  background: string | null
}

export interface ClickUpTask {
  id: string
  /** Team-configured id such as `HSEO-123`; null when the workspace does not use them. */
  customId: string | null
  name: string
  /** Markdown description; empty when the task has none. */
  description: string
  status: ClickUpStatus
  priority: ClickUpPriority | null
  url: string
  assignees: ClickUpUser[]
  tags: ClickUpTag[]
  /** Parent task id when this is a subtask. */
  parentId: string | null
  listId: string
  listName: string
  folderName: string | null
  spaceId: string
  /** Epoch milliseconds. */
  createdAt: number
  updatedAt: number
  dueAt: number | null
  startAt: number | null
  closedAt: number | null
}

export interface ClickUpWorkspace {
  id: string
  name: string
}

export interface ClickUpStatusResponse {
  configured: boolean
  /** The token comes from the server environment; the panel cannot change or forget it. */
  tokenFromEnv: boolean
  viewer: ClickUpUser | null
  workspace: ClickUpWorkspace | null
}

export interface ClickUpMyTasksResponse {
  workspace: ClickUpWorkspace
  viewer: ClickUpUser
  tasks: ClickUpTask[]
  /** ClickUp had more pages than the route fetched. */
  truncated: boolean
}

export interface ClickUpListSummary {
  id: string
  name: string
  folderName: string | null
  spaceId: string
  /** Every status the list's workflow knows, in workflow order. */
  statuses: ClickUpStatus[]
  url: string
}

export interface ClickUpListTasksResponse {
  workspace: ClickUpWorkspace
  viewer: ClickUpUser
  list: ClickUpListSummary
  tasks: ClickUpTask[]
  truncated: boolean
}

export interface ClickUpSpace {
  id: string
  name: string
}

export interface ClickUpSpacesResponse {
  workspace: ClickUpWorkspace
  spaces: ClickUpSpace[]
}

export interface ClickUpListOption {
  id: string
  name: string
  folderName: string | null
}

export interface ClickUpListsResponse {
  spaceId: string
  lists: ClickUpListOption[]
}

export interface ClickUpProjectLinkRequest {
  cwd: string
  /** Null unlinks the project. */
  listId: string | null
}

export interface ClickUpProjectLinkResponse {
  cwd: string
  listId: string | null
}

export interface ClickUpTokenRequest {
  token: string
}

export type ClickUpErrorCode =
  | "clickup_not_configured"
  | "clickup_auth_failed"
  | "clickup_rate_limited"
  | "clickup_api_failed"
  | "invalid_response"
  | "project_unlinked"

export interface ClickUpErrorResponse {
  error: string
  code: ClickUpErrorCode
}

/** Digits after `/li/` in a ClickUp list URL, or a bare numeric id. */
export function parseClickUpListId(input: string): string | null {
  const text = input.trim()
  if (/^\d+$/.test(text)) return text
  const match = text.match(/\/li\/(\d+)/) ?? text.match(/\/list\/(\d+)/)
  return match ? match[1] : null
}
