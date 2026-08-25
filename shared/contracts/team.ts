// Browser-safe team-edition contracts (dependency rule 1: no runtime imports).
export type CogpitEdition = "personal" | "team"
export type TeamRole = "admin" | "member"

export interface TeamUserPublic {
  id: string
  username: string
  displayName: string
  role: TeamRole
  createdAt: number
  disabled?: boolean
}

export interface Capabilities {
  terminal: boolean
  configWrite: boolean
  /** Access to caller-selected host paths (project files, diffs, undo, scripts). */
  hostFiles: boolean
  manageUsers: boolean
  manageWorkspaces: boolean
  manageDevices: boolean
  killAny: boolean
  viewAllSessions: boolean
  /** Inspect provider account identity, quota, credit, and usage metadata. */
  viewUsage: boolean
  /**
   * Hand a session to a guest over a share link. Admin-only: a guest can
   * approve tool permission requests, so sharing grants a stranger host code
   * execution — strictly more reach than the member sharing it has alone.
   */
  share: boolean
  runFlows: boolean
}

export const ALL_CAPABILITIES: Capabilities = {
  terminal: true,
  configWrite: true,
  hostFiles: true,
  manageUsers: true,
  manageWorkspaces: true,
  manageDevices: true,
  killAny: true,
  viewAllSessions: true,
  viewUsage: true,
  share: true,
  runFlows: true,
}

export const MEMBER_CAPABILITIES: Capabilities = {
  terminal: false,
  configWrite: false,
  hostFiles: false,
  manageUsers: false,
  manageWorkspaces: false,
  manageDevices: false,
  killAny: false,
  viewAllSessions: false,
  viewUsage: false,
  share: false,
  runFlows: true,
}

/** Fail-closed renderer state while a team identity is unresolved. */
export const NO_CAPABILITIES: Capabilities = {
  terminal: false,
  configWrite: false,
  hostFiles: false,
  manageUsers: false,
  manageWorkspaces: false,
  manageDevices: false,
  killAny: false,
  viewAllSessions: false,
  viewUsage: false,
  share: false,
  runFlows: false,
}

export interface MeResponse {
  authenticated: boolean
  edition: CogpitEdition
  user: TeamUserPublic | null
  capabilities: Capabilities
}
