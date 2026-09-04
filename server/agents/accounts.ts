import type { AgentKind } from "../../shared/session/types"
import type { AccountSwitchResult, AgentAccountsReport } from "../../shared/contracts/agentAccounts"
import { describeClaudeAccounts, switchClaudeAccount } from "./claudeSwap"

export interface AccountSwitcher {
  describe(): Promise<AgentAccountsReport>
  switchTo(slot: number): Promise<AccountSwitchResult>
}

const claudeAccounts: AccountSwitcher = {
  describe: describeClaudeAccounts,
  switchTo: switchClaudeAccount,
}

/**
 * The account switcher for one agent, for callers outside the agent layer.
 * Null for agents whose logins Cogpit cannot swap.
 */
export function accountSwitcherFor(kind: AgentKind): AccountSwitcher | null {
  return kind === "claude" ? claudeAccounts : null
}
