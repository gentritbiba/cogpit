export type PermissionDecision = "allow" | "allow_always" | "deny"

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  defaultToNo?: boolean
  suggestions?: Array<Record<string, unknown>>
  timestamp: number
  availableDecisions?: PermissionDecision[]
}
