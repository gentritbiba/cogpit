import type { ReapedEvent } from "../../shared/contracts/performance"
import { showNotification } from "./desktopNotify"
import { recordActivity } from "./activityMonitor"
import {
  collectOrphanedClaudeSubtrees,
  listSystemProcesses,
  parsePsOutput,
  type OrphanedClaudeSubtree,
} from "./systemProcesses"

/**
 * Auto-reaps the one class of leak that is unambiguously safe to kill:
 * orphaned claude sessions (parent already dead, reparented to launchd) and
 * the subtree of shells/scripts they keep alive. Requires the same orphan to
 * be seen in two consecutive sweeps before killing, so a transient state or a
 * recycled pid never gets shot. Everything else (hot headless browsers,
 * orphaned scripts) is only surfaced for manual kill in the UI.
 */

const SWEEP_INTERVAL_MS = 10 * 60_000
const FIRST_SWEEP_DELAY_MS = 60_000
const MIN_ORPHAN_AGE_SECONDS = 30 * 60
const SIGKILL_GRACE_MS = 5_000
const MAX_REAP_LOG = 20

export interface PendingOrphan {
  firstSeenAt: number
  command: string
}

export interface ReapPlan {
  toKill: OrphanedClaudeSubtree[]
  nextPending: Map<number, PendingOrphan>
}

export function planReaping(
  subtrees: OrphanedClaudeSubtree[],
  pending: Map<number, PendingOrphan>,
  opts: { minAgeSeconds: number; now: number },
): ReapPlan {
  const toKill: OrphanedClaudeSubtree[] = []
  const nextPending = new Map<number, PendingOrphan>()

  for (const tree of subtrees) {
    const prior = pending.get(tree.rootPid)
    const samePriorProcess = prior !== undefined && prior.command === tree.command
    if (samePriorProcess && tree.ageSeconds >= opts.minAgeSeconds) {
      toKill.push(tree)
      continue
    }
    nextPending.set(
      tree.rootPid,
      samePriorProcess ? prior : { firstSeenAt: opts.now, command: tree.command },
    )
  }

  return { toKill, nextPending }
}

/** SIGTERM each pid now, SIGKILL survivors after a grace period. */
export function killPids(pids: number[]): number[] {
  const killed: number[] = []
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
      killed.push(pid)
    } catch {
      // already gone or not ours to kill
    }
  }
  if (killed.length > 0) {
    setTimeout(() => {
      for (const pid of killed) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // exited during the grace period
        }
      }
    }, SIGKILL_GRACE_MS).unref()
  }
  return killed
}

const reapedLog: ReapedEvent[] = []
let pendingOrphans = new Map<number, PendingOrphan>()
let started = false

export function getRecentlyReaped(): ReapedEvent[] {
  return [...reapedLog]
}

async function sweep(): Promise<void> {
  recordActivity("Leak reaper sweeps")
  const rows = parsePsOutput(await listSystemProcesses())
  const { toKill, nextPending } = planReaping(
    collectOrphanedClaudeSubtrees(rows),
    pendingOrphans,
    { minAgeSeconds: MIN_ORPHAN_AGE_SECONDS, now: Date.now() },
  )
  pendingOrphans = nextPending

  for (const tree of toKill) {
    const killedPids = killPids(tree.pids)
    if (killedPids.length === 0) continue
    reapedLog.push({
      at: Date.now(),
      rootPid: tree.rootPid,
      command: tree.command.slice(0, 200),
      killedPids,
    })
    if (reapedLog.length > MAX_REAP_LOG) reapedLog.splice(0, reapedLog.length - MAX_REAP_LOG)
  }

  if (toKill.length > 0) {
    const processCount = toKill.reduce((sum, tree) => sum + tree.pids.length, 0)
    showNotification(
      "Cogpit",
      `Cleaned up ${processCount} leaked agent ${processCount === 1 ? "process" : "processes"} (orphaned Claude ${toKill.length === 1 ? "session" : "sessions"})`,
      { sessionId: null, dirName: null },
    )
  }
}

export function startLeakReaper(): void {
  if (started || process.platform === "win32") return
  started = true

  const runSweep = () => {
    sweep().catch((err) => console.error("[leakReaper] sweep failed", err))
  }
  setTimeout(runSweep, FIRST_SWEEP_DELAY_MS).unref()
  setInterval(runSweep, SWEEP_INTERVAL_MS).unref()
}
