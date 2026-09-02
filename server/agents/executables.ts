import type { AgentKind } from "../../shared/session/types"
import type { ExecutableReport } from "../../shared/contracts/agentExecutable"
import { claudeCliPath, describeClaudeExecutable } from "./claudeExecutable"

/**
 * Where each agent CLI is actually spawned from, for callers outside the agent
 * layer that report on the binary (the update banner, the executable picker).
 * Only one agent has a choice to make; the rest run whatever PATH offers, so
 * they answer undefined / null and callers fall back to the PATH lookup.
 */
export function activeExecutableFor(kind: AgentKind): string | undefined {
  return kind === "claude" ? claudeCliPath() : undefined
}

export function describeExecutableFor(kind: AgentKind): Promise<ExecutableReport> | null {
  return kind === "claude" ? describeClaudeExecutable() : null
}
