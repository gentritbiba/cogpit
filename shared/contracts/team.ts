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
  manageUsers: boolean
  manageWorkspaces: boolean
  manageDevices: boolean
  killAny: boolean
  viewAllSessions: boolean
  share: boolean
  runFlows: boolean
}

export const ALL_CAPABILITIES: Capabilities = {
  terminal: true,
  configWrite: true,
  manageUsers: true,
  manageWorkspaces: true,
  manageDevices: true,
  killAny: true,
  viewAllSessions: true,
  share: true,
  runFlows: true,
}

export const MEMBER_CAPABILITIES: Capabilities = {
  terminal: false,
  configWrite: false,
  manageUsers: false,
  manageWorkspaces: false,
  manageDevices: false,
  killAny: false,
  viewAllSessions: false,
  share: true,
  runFlows: true,
}

export interface MeResponse {
  authenticated: boolean
  edition: CogpitEdition
  user: TeamUserPublic | null
  capabilities: Capabilities
}
