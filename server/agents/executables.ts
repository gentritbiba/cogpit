import type { AgentKind } from "../../shared/session/types"
import type { ActiveExecutable, ExecutableReport } from "../../shared/contracts/agentExecutable"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { findExecutableOnPath, isExecutableFile } from "../lib/binaryResolver"
import { claudeCliPath, describeClaudeExecutable, refreshClaudeExecutable } from "./claudeExecutable"

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

export type LaunchableExecutable =
  | { status: "found"; path: string; source: ActiveExecutable["source"] }
  | { status: "absent" }
  /** The binary chosen in Settings cannot be started; `path` is null when the choice names none. */
  | { status: "unlaunchable-choice"; path: string | null }

/**
 * The binary Cogpit would start for `kind`, looked up afresh and only if the OS
 * can run it, without blocking the event loop.
 */
export async function findLaunchableExecutable(kind: AgentKind): Promise<LaunchableExecutable> {
  if (kind !== "claude") {
    const path = findExecutableOnPath(descriptorFor(kind).binName)
    return path ? { status: "found", path, source: "path" } : { status: "absent" }
  }
  const { choice, resolved } = await refreshClaudeExecutable()
  if (resolved && isExecutableFile(resolved.path)) return { status: "found", ...resolved }
  return choice.source === "auto"
    ? { status: "absent" }
    : { status: "unlaunchable-choice", path: resolved?.path ?? choice.path ?? null }
}
