import type { AgentKind } from "../session/types"

export interface BrowserSessionInfo {
  name: string
  isDefault: boolean
  running: boolean
  note: string | null
  createdAt: string | null
  lastUsedAt: string | null
  lastUrl: string | null
  /** Cogpit session that last drove it, from the shim's .driver file. */
  driverSessionId: string | null
}

export interface BrowserStatus {
  installed: boolean
  binaryPath: string | null
  sessions: BrowserSessionInfo[]
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
