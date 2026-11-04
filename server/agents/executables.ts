import type { AgentKind } from "../../shared/session/types"
import type { ActiveExecutable, ExecutableReport } from "../../shared/contracts/agentExecutable"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { findExecutableOnPath } from "../lib/binaryResolver"
import {
  claudeCliPath,
  describeClaudeExecutable,
  forgetClaudeExecutable,
  resolveClaudeExecutable,
} from "./claudeExecutable"

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

/** The binary Cogpit would start for `kind`, and where it came from. */
export function launchableExecutableFor(
  kind: AgentKind,
): { path: string; source: ActiveExecutable["source"] } | undefined {
  if (kind === "claude") return resolveClaudeExecutable()
  const path = findExecutableOnPath(descriptorFor(kind).binName)
  return path ? { path, source: "path" } : undefined
}

/** Forget remembered binaries, so one installed while Cogpit runs is found. */
export function rediscoverExecutables(): void {
  forgetClaudeExecutable()
}
