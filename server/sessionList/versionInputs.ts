import { sessionAgentsRunning } from "../agents/agentsRunning"
import { allRuntimes } from "../agents/runtimes"
import { subscribeArchiveChanges } from "../lib/sessionArchive"
import { sessionParents } from "../lib/sessionOrigins"
import { markCatalogChanged, subscribeCatalog } from "../sessionCatalog"

/**
 * List row inputs that change without a transcript write bump the list
 * version from here, while anyone follows it: runtime turn state, agents a
 * waiting session started, archiving and its idle crossing, and crew origins.
 */

const RUNTIME_CHECK_MS = 2_000
const AGENTS_CHECK_MS = 5_000
/** setTimeout's ceiling; a later crossing is re-armed by the build that lists it. */
const MAX_TIMER_MS = 2 ** 31 - 1

let following = false
let stops: Array<() => void> = []
let bumping = false

function bump(): void {
  bumping = true
  try {
    markCatalogChanged("visible")
  } finally {
    bumping = false
  }
}

// ── Runtime turn state ──────────────────────────────────────────────

let runtimeSignature = ""
let runtimeTimer: ReturnType<typeof setTimeout> | null = null

function readRuntimeSignature(): string {
  return allRuntimes()
    .map((runtime) => {
      const ids = runtime.listActive().map(({ sessionId }) => sessionId).sort()
      return ids.length > 0 ? `${runtime.kind}:${runtime.instanceId ?? "default"}:${ids.join(",")}` : ""
    })
    .filter(Boolean)
    .join("\n")
}

/** Runs every 2 s while a runtime has a turn in flight; a transcript write re-arms it. */
function checkRuntimes(): void {
  runtimeTimer = null
  if (!following) return
  const signature = readRuntimeSignature()
  if (signature !== runtimeSignature) {
    runtimeSignature = signature
    bump()
  }
  void checkCrewOrigins()
  if (signature) armRuntimeCheck()
}

function armRuntimeCheck(): void {
  if (runtimeTimer || !following) return
  runtimeTimer = setTimeout(checkRuntimes, RUNTIME_CHECK_MS)
  runtimeTimer.unref?.()
}

// ── Agents of sessions awaiting them ────────────────────────────────

interface AwaitingRow {
  dirName: string
  running: boolean
}

/** Listed rows awaiting their agents, with whether the list showed those agents running. */
const awaiting = new Map<string, AwaitingRow>()
let agentsTimer: ReturnType<typeof setInterval> | null = null
let checkingAgents = false

/** What a list build read for one row; only rows awaiting agents are watched. */
export function noteListedAgents(sessionId: string, row: AwaitingRow | null): void {
  if (row) awaiting.set(sessionId, row)
  else awaiting.delete(sessionId)
  syncAgentsTimer()
}

async function checkAgents(): Promise<void> {
  if (checkingAgents) return
  checkingAgents = true
  try {
    let changed = false
    for (const [sessionId, row] of [...awaiting]) {
      if (await sessionAgentsRunning(row.dirName, sessionId) === row.running) continue
      // The next build reads the row again and reports what it shows.
      awaiting.delete(sessionId)
      changed = true
    }
    if (changed) bump()
  } finally {
    checkingAgents = false
    syncAgentsTimer()
  }
}

function syncAgentsTimer(): void {
  const wanted = following && awaiting.size > 0
  if (wanted && !agentsTimer) {
    agentsTimer = setInterval(() => void checkAgents(), AGENTS_CHECK_MS)
    agentsTimer.unref?.()
  } else if (!wanted && agentsTimer) {
    clearInterval(agentsTimer)
    agentsTimer = null
  }
}

// ── Idle archiving ──────────────────────────────────────────────────

let crossingAt = Infinity
let crossingTimer: ReturnType<typeof setTimeout> | null = null

/** When the next listed session crosses into idle archiving, as a list build saw it. */
export function noteNextArchiveCrossing(at: number): void {
  if (!(at < Infinity) || at === crossingAt) return
  if (crossingTimer && at > crossingAt) return
  crossingAt = at
  armCrossing()
}

function armCrossing(): void {
  if (crossingTimer) clearTimeout(crossingTimer)
  crossingTimer = null
  if (!following || !(crossingAt < Infinity)) return
  crossingTimer = setTimeout(() => {
    crossingTimer = null
    crossingAt = Infinity
    bump()
  }, Math.min(MAX_TIMER_MS, Math.max(0, crossingAt - Date.now())))
  crossingTimer.unref?.()
}

// ── Crew origins ────────────────────────────────────────────────────

let originsSignature: string | null = null

/**
 * Changes whenever a session's crew link does. Derived from the in-memory
 * origins until sessionOrigins.ts keeps a revision counter of its own.
 */
async function crewOriginsRevision(): Promise<string> {
  const parents = await sessionParents()
  let signature = String(parents.size)
  for (const [sessionId, link] of parents) {
    signature += `\n${sessionId}>${link.parentSessionId}@${link.createdAt}:${link.name ?? ""}`
  }
  return signature
}

async function checkCrewOrigins(): Promise<void> {
  const signature = await crewOriginsRevision().catch(() => originsSignature)
  if (!following || signature === null || signature === originsSignature) return
  const first = originsSignature === null
  originsSignature = signature
  if (!first) bump()
}

// ── Lifecycle ───────────────────────────────────────────────────────

/** Start bumping the version for eventless inputs; the list stream calls it while it has clients. */
export function followVersionInputs(): void {
  if (following) return
  following = true
  runtimeSignature = readRuntimeSignature()
  originsSignature = null
  void checkCrewOrigins()
  stops = [
    subscribeCatalog(() => {
      if (!bumping) armRuntimeCheck()
    }),
    subscribeArchiveChanges(bump),
  ]
  if (runtimeSignature) armRuntimeCheck()
  syncAgentsTimer()
  armCrossing()
}

export function stopFollowingVersionInputs(): void {
  if (!following) return
  following = false
  for (const stop of stops) stop()
  stops = []
  if (runtimeTimer) clearTimeout(runtimeTimer)
  runtimeTimer = null
  if (crossingTimer) clearTimeout(crossingTimer)
  crossingTimer = null
  syncAgentsTimer()
}

export function __resetVersionInputsForTest(): void {
  stopFollowingVersionInputs()
  awaiting.clear()
  crossingAt = Infinity
  runtimeSignature = ""
  originsSignature = null
}
