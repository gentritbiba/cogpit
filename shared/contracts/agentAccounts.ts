/**
 * Managed login accounts for an agent CLI, as reported by that agent's account
 * switcher tool. Only identity and quota fields cross this boundary — the
 * switcher owns the credentials, and Cogpit never reads or forwards them.
 */

export interface AccountUsageWindow {
  /** Percent of the window consumed, 0–100. */
  pct: number
  /** Human-readable time until the window resets, when known. */
  resetsIn: string | null
  /** ISO instant of the reset, when known. */
  resetsAt: string | null
}

export interface AccountUsage {
  fiveHour: AccountUsageWindow | null
  sevenDay: AccountUsageWindow | null
}

export interface AgentAccount {
  /** The switcher's slot number; what a switch is addressed by. */
  slot: number
  alias: string | null
  email: string
  organization: string | null
  active: boolean
  /** Held out of the switcher's automatic rotation. */
  disabled: boolean
  /** The switcher's own status word, e.g. `ok` or `token_expired`. */
  usageStatus: string
  usage: AccountUsage | null
}

export type AgentAccountsReport =
  /** The switcher is not installed; there is nothing to show. */
  | { status: "missing" }
  /** The switcher is installed but could not report its accounts. */
  | { status: "error"; error: string }
  | {
      status: "ok"
      /** The switcher tool's name, for the UI to credit. */
      tool: string
      /** Its version, when it reports one. */
      version: string | null
      activeSlot: number | null
      accounts: AgentAccount[]
    }

export interface AccountSwitchResult {
  switched: boolean
  message: string
  warnings: string[]
  /**
   * Where the live credential now lives. A keychain-backed login is cached by
   * the CLI for a short while, so running sessions pick it up with a delay.
   */
  credentialStore: "keychain" | "file"
}
