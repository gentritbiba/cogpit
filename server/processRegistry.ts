import { spawn, type ChildProcess } from "node:child_process"
import type { AgentKind } from "../shared/providers/types"
import type { SubagentWatcher } from "./subagentWatcher"

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  description?: string
  permissionSuggestions?: Array<{ type: string; [key: string]: unknown }>
  title?: string
  displayName?: string
  blockedPath?: string
  decisionReason?: string
  agentId?: string
  timestamp: number
}

export interface PersistentSession {
  agentKind: AgentKind
  proc: ChildProcess
  /** Resolves when the current turn's `result` message arrives. */
  onResult: ((msg: { type: string; subtype?: string; is_error?: boolean; result?: string }) => void) | null
  /** Set to true once the process has exited. */
  dead: boolean
  cwd: string
  permArgs: string[]
  modelArgs: string[]
  effortArgs: string[]
  /** Path to the session's JSONL file. */
  jsonlPath: string | null
  /** Active Task tool_use IDs -> prompt text (for matching subagent files). */
  pendingTaskCalls: Map<string, string>
  /** Subagent directory watcher (cleaned up on process close). */
  subagentWatcher: SubagentWatcher | null
  /** Worktree name if session was created with --worktree. */
  worktreeName: string | null
  /** Temporary files created for a request, such as Codex image attachments. */
  tempFiles?: string[]
  /** Pending permission requests awaiting user approval. */
  pendingPermissions: Map<string, PermissionRequest>
}

/** Child processes that are active but do not own a persistent session. */
export const activeProcesses = new Map<string, ReturnType<typeof spawn>>()

/** Long-lived session processes keyed by their stable session ID. */
export const persistentSessions = new Map<string, PersistentSession>()

const TERMINATION_GRACE_MS = 3_000
const FORCE_KILL_GRACE_MS = 1_000

interface ExitObserver {
  readonly exited: Promise<void>
  hasExited(): boolean
  dispose(): void
}

function observeExit(proc: ChildProcess): ExitObserver {
  let didExit = (
    (proc.exitCode !== null && proc.exitCode !== undefined)
    || (proc.signalCode !== null && proc.signalCode !== undefined)
  )
  let resolveExit: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  if (didExit) resolveExit()

  const markExited = () => {
    if (didExit) return
    didExit = true
    resolveExit()
  }
  const supportsEvents = typeof proc.once === "function" && typeof proc.off === "function"
  if (supportsEvents && !didExit) {
    proc.once("exit", markExited)
    proc.once("close", markExited)
  }

  return {
    exited,
    hasExited: () => didExit,
    dispose: () => {
      if (!supportsEvents) return
      proc.off("exit", markExited)
      proc.off("close", markExited)
    },
  }
}

async function waitForExit(
  observers: ExitObserver[],
  timeoutMs: number,
  onTimeout: () => void = () => undefined,
): Promise<void> {
  const pending = observers.filter((observer) => !observer.hasExited())
  if (pending.length === 0) return

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout()
      resolve()
    }, timeoutMs)
    void Promise.all(pending.map((observer) => observer.exited)).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export async function cleanupProcesses(): Promise<void> {
  // Snapshot process references before clearing either registry so the
  // SIGKILL fallback remains independent of subsequent registry mutations.
  const sigkillProcs = new Set<ChildProcess>()
  for (const proc of activeProcesses.values()) sigkillProcs.add(proc)
  for (const session of persistentSessions.values()) sigkillProcs.add(session.proc)
  const terminatedProcs = new Set<ChildProcess>()
  const observers = new Map(
    [...sigkillProcs].map((proc) => [proc, observeExit(proc)] as const),
  )

  for (const [sessionId, proc] of [...activeProcesses.entries()]) {
    if (!terminatedProcs.has(proc)) {
      try {
        proc.kill("SIGTERM")
      } catch (error) {
        console.error(`[cleanupProcesses] SIGTERM failed for activeProcess ${sessionId}`, error)
      }
      terminatedProcs.add(proc)
    }
    activeProcesses.delete(sessionId)
  }

  for (const [sessionId, session] of [...persistentSessions.entries()]) {
    session.subagentWatcher?.close()
    if (!terminatedProcs.has(session.proc)) {
      try {
        session.proc.kill("SIGTERM")
      } catch (error) {
        console.error(`[cleanupProcesses] SIGTERM failed for persistentSession ${sessionId}`, error)
      }
      terminatedProcs.add(session.proc)
    }
    persistentSessions.delete(sessionId)
  }

  if (sigkillProcs.size === 0) return

  try {
    let survivors: ChildProcess[] = []
    await waitForExit([...observers.values()], TERMINATION_GRACE_MS, () => {
      survivors = [...sigkillProcs].filter(
        (proc) => !observers.get(proc)?.hasExited(),
      )
      for (const proc of survivors) {
        try {
          proc.kill("SIGKILL")
        } catch (error) {
          console.error(`[cleanupProcesses] SIGKILL failed for pid ${proc.pid ?? "unknown"}`, error)
        }
      }
    })
    if (survivors.length > 0) {
      await waitForExit(
        survivors.map((proc) => observers.get(proc)!),
        FORCE_KILL_GRACE_MS,
      )
    }
  } finally {
    for (const observer of observers.values()) observer.dispose()
  }
}
