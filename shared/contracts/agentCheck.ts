/**
 * Contract for the agent check: is each agent CLI on this machine, and does it
 * have an account? Everything is read from local state, so running the check
 * never calls a model or spends anything.
 */
import type { AgentKind } from "../session/types"
import type { ActiveExecutable } from "./agentExecutable"

/** `"unknown"` whenever the local evidence does not say plainly. */
export type SignInState = boolean | "unknown"

/** A command for a person to run in a terminal, and the argv behind it. */
export interface TerminalCommand {
  executable: string
  args: string[]
  /** Copy-pasteable form for the platform the server runs on. */
  command: string
}

export interface AgentCheck {
  kind: AgentKind
  displayName: string
  /** The binary Cogpit would start; null when there is none. */
  binary: { path: string; source: ActiveExecutable["source"] } | null
  version: string | null
  signedIn: SignInState
  install: { page: string; command: string }
  /** Null while the CLI is not installed. */
  signIn: TerminalCommand | null
}

export interface AgentCheckResponse {
  agents: AgentCheck[]
  checkedAt: string
}

export type AgentReadiness = "ready" | "not-installed" | "signed-out" | "unknown"

export function agentReadiness(check: AgentCheck): AgentReadiness {
  if (!check.binary) return "not-installed"
  if (check.signedIn === "unknown") return "unknown"
  return check.signedIn ? "ready" : "signed-out"
}

/**
 * Setup lets a person continue once any agent can be started, signed in or not:
 * a missing sign-in is fixed inside Cogpit, a missing CLI is not.
 */
export function canContinueSetup(agents: readonly AgentCheck[]): boolean {
  return agents.some((check) => check.binary !== null)
}
