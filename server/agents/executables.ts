import { existsSync } from "node:fs"
import { descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import type { ActiveExecutable, ExecutableReport } from "../../shared/contracts/agentExecutable"
import { findExecutableOnPath, isExecutableFile } from "../lib/binaryResolver"
import { describeClaudeExecutable, refreshClaudeExecutable, resolveClaudeExecutable } from "./claudeExecutable"

export interface SpawnedExecutable {
  path: string
  /** The copy Cogpit's own SDK ships, which updates with Cogpit rather than by itself. */
  bundled: boolean
}

/**
 * The binary Cogpit spawns for an agent, for callers outside the agent layer
 * that report on it (the update banner, the provider picker). Claude Code has a
 * choice to make; an ACP agent runs only the executable it was configured
 * with; the rest run whatever PATH offers.
 */
export function spawnedExecutableFor(kind: AgentKind): SpawnedExecutable | null {
  if (kind === "claude") {
    // A configured path that no longer exists is nothing to run.
    const resolved = resolveClaudeExecutable()
    return resolved && existsSync(resolved.path) ? { path: resolved.path, bundled: resolved.source === "bundled" } : null
  }
  const name = kind === "acp" ? process.env.COGPIT_PROVIDER_EXECUTABLE : descriptorFor(kind).binName
  const path = name ? findExecutableOnPath(name) : undefined
  return path ? { path, bundled: false } : null
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
