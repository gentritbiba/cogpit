import { spawn, type ChildProcess } from "node:child_process"
import type { AgentKind } from "../shared/session/types"

export interface PersistentSession {
  agentKind: AgentKind
  proc: ChildProcess
  /** Resolves when the current turn's `result` message arrives. */
  onResult: ((msg: { type: string; subtype?: string; is_error?: boolean; result?: string }) => void) | null
  /** Set to true once the process has exited. */
  dead: boolean
  /** Path to the session's JSONL file. */
  jsonlPath: string | null
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

const SIGKILL_GRACE_MS = 3_000

/** SIGTERM now, SIGKILL after a grace window if the process is still there. */
function terminate(proc: ChildProcess, stillTracked: () => boolean = () => true): void {
  try {
    proc.kill("SIGTERM")
  } catch {
    return
  }
  const forceKill = setTimeout(() => {
    if (!stillTracked()) return
    try { proc.kill("SIGKILL") } catch { /* already dead */ }
  }, SIGKILL_GRACE_MS)
  forceKill.unref()
}

/**
 * Stop whatever child process a session owns, in either registry.
 *
 * Only the agents that spawn a CLI per session are ever in here — the ones
 * driven over a shared RPC connection own no process to signal.
 */
export function terminateTrackedSession(sessionId: string): boolean {
  let stopped = false

  const session = persistentSessions.get(sessionId)
  if (session) {
    stopped = true
    if (!session.dead) {
      session.dead = true
      persistentSessions.delete(sessionId)
      terminate(session.proc)
    } else {
      persistentSessions.delete(sessionId)
    }
  }

  const child = activeProcesses.get(sessionId)
  if (child) {
    stopped = true
    activeProcesses.delete(sessionId)
    terminate(child)
  }
  return stopped
}

/**
 * Stop every tracked child process and empty both registries, returning how
 * many were signalled. Unlike `cleanupProcesses`, this does not wait for exits:
 * `/api/kill-all` answers immediately and lets the grace timer do the rest.
 */
export function killTrackedProcesses(): number {
  let killed = 0
  const survivors: ChildProcess[] = []

  for (const [sessionId, session] of [...persistentSessions.entries()]) {
    persistentSessions.delete(sessionId)
    if (session.dead) continue
    session.dead = true
    survivors.push(session.proc)
    try { session.proc.kill("SIGTERM") } catch { /* already dead */ }
    killed++
  }

  for (const [sessionId, proc] of [...activeProcesses.entries()]) {
    activeProcesses.delete(sessionId)
    survivors.push(proc)
    try { proc.kill("SIGTERM") } catch { /* already dead */ }
    killed++
  }

  if (survivors.length > 0) {
    const forceKill = setTimeout(() => {
      for (const proc of survivors) {
        try { proc.kill("SIGKILL") } catch { /* already dead */ }
      }
    }, SIGKILL_GRACE_MS)
    forceKill.unref()
  }
  return killed
}
