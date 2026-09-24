import type { AgentKind } from "../session/types"

/**
 * What the caller may do with a browser: watch its page, drive it (input,
 * navigation, opening and stopping it), or own it, which adds its note,
 * archiving and deleting it.
 */
export type BrowserControl = "watch" | "drive" | "own"

export interface BrowserSessionInfo {
  name: string
  /** The host's own `default` browser. */
  isDefault: boolean
  running: boolean
  /** Absent on older hosts. Archiving preserves the browser's profile. */
  archived?: boolean
  note: string | null
  createdAt: string | null
  lastUsedAt: string | null
  lastUrl: string | null
  /** Cogpit session that last drove it, from the shim's .driver file; null when the caller cannot see that session. */
  driverSessionId: string | null
  /** Absent on older hosts, which let every caller own every browser. */
  control?: BrowserControl
  /** The caller's own browser, which their sessions' agents open when they name none. */
  mine?: boolean
  /** The account whose own browser this is, by display name. */
  account?: string
}

export interface BrowserStatus {
  installed: boolean
  binaryPath: string | null
  sessions: BrowserSessionInfo[]
}

export interface BrowserRequest {
  url: string
  method?: "GET" | "HEAD"
  targetId?: string
}

export interface BrowserRequestResult {
  browser: string
  targetId: string
  state: "complete" | "challenge-required" | "navigation-required"
  url: string
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}

/** One agent CLI the browser skill can be installed for, and whether it is. */
export interface BrowserSkillTarget {
  kind: AgentKind
  /** The CLI's product name, as the descriptor table spells it. */
  label: string
  /** Its global config directory, under the user's home. */
  configRoot: string
  installed: boolean
  /**
   * Cogpit already hands the skill to the sessions it starts for this CLI,
   * through the local plugin it writes inside its own tree. Installing is then
   * only for runs Cogpit does not own.
   */
  automatic: boolean
}

export interface BrowserSkillStatus {
  targets: BrowserSkillTarget[]
}
