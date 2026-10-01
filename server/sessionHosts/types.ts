import type { AgentKind } from "../../shared/session/agent-descriptors"
import type { PendingInput, PendingInputResponse } from "../agents/pendingInput"
import type { SessionResult } from "../lib/sessionResult"
import type { SessionState, WaitOptions, WaitResult } from "../lib/sessionWait"

/**
 * A machine sessions run on: this server, or a device registered with the hub.
 * The session CLI and the orchestration endpoints talk to every session through
 * this interface, so none of them knows whether a session is local.
 */
export interface SessionHost {
  /** `local`, or the device's registry id. */
  readonly id: string
  readonly name: string
  readonly remote: boolean
  create(input: HostCreateInput): Promise<{ sessionId: string; dirName: string }>
  /** Deliver a follow-up without waiting for the turn it starts. */
  send(sessionId: string, message: string, options?: { interrupt?: boolean }): Promise<{ delivery: string }>
  state(sessionId: string): Promise<SessionState>
  wait(sessionIds: readonly string[], options: WaitOptions): Promise<WaitResult>
  result(sessionId: string, turn?: number): Promise<SessionResult | null>
  respond(sessionId: string, requestId: string, response: PendingInputResponse): Promise<PendingInput>
  interrupt(sessionId: string): Promise<boolean>
  stop(sessionId: string): Promise<boolean>
  has(sessionId: string): Promise<boolean>
  /** Where the UI finds the session's transcript; null until it is on disk. */
  address(sessionId: string): Promise<SessionAddress | null>
  projects(): Promise<HostProject[]>
}

export interface HostCreateInput {
  /** An absolute path on the host. */
  cwd: string
  agent?: AgentKind
  message: string
  mode: string
  model?: string
  effort?: string
  worktreeName?: string
  name?: string
  /** Makes retries of one create return the same session. */
  requestId: string
  scope: string
}

/** The start request both hosts send, less how each makes retries safe. */
export function startFields(input: HostCreateInput) {
  return {
    cwd: input.cwd,
    agent: input.agent,
    message: input.message,
    permissions: { mode: input.mode },
    model: input.model,
    effort: input.effort,
    worktreeName: input.worktreeName,
    name: input.name,
  }
}

export interface SessionAddress {
  dirName: string
  fileName: string
}

export interface HostProject {
  dirName: string
  path: string
  shortName: string
  lastModified?: string | null
}
