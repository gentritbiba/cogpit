import {
  dirs,
  encodeCodexDirName,
  getSessionMeta,
  getSessionStatus,
  join,
  listCodexSessionFiles,
  projectDirToReadableName,
  readdir,
  shortNameFromPath,
  stat,
} from "../helpers"
import { readClaudeProjectEntries } from "../routes/projects/claudeProjectEntries"
import { getOrLoadSessionMeta } from "./sessionMetaCache"
import { codexAppServer } from "../codex-app-server"
import { SessionAlertTracker, type TrackedSessionSnapshot } from "./sessionAlertTracker"
import { deliverNotification } from "./notificationDelivery"

/**
 * Server-owned notification source: watches every session transcript (Cogpit-
 * spawned and terminal-started alike) and raises a notification when a session
 * stops working (turn complete) or blocks on a permission prompt.
 *
 * This replaces the old agent-hook flow (Claude Stop/Notification hooks and
 * Codex `notify` POSTing to /api/notify): Cogpit now detects the same edges
 * itself by sweeping recently-modified transcripts and deriving their status
 * from the tail, exactly like /api/active-sessions does.
 *
 * Cost model: a sweep is stat-only for unchanged files — transcripts are read
 * (via the mtime-keyed session meta cache, shared with the routes) only when
 * their mtime moved since the last sweep. Codex rollouts go through the same
 * gate: the stat-level listing is cheap, identity/status reads happen per
 * change, never per sweep.
 *
 * Deliberate limits:
 * - A turn shorter than one sweep interval may never be observed "working" and
 *   then won't announce. The alternative — treating any write that lands on a
 *   completed tail as a completion — would buzz on non-turn writes (title
 *   generation, meta updates), so short turns are the cheaper miss.
 * - Not started by the Vite dev shell (api-plugin): a dev server beside the
 *   packaged app would announce every edge twice.
 */

const SWEEP_INTERVAL_MS = 4_000
/** Only files touched this recently are tracked. Any edge worth announcing
 * (completion line, permission-defer line) is itself a write, so a quiet file
 * cannot be hiding a fresh edge. */
const RECENT_WINDOW_MS = 30 * 60_000

interface SessionSnapshot extends TrackedSessionSnapshot {
  dirName: string
  cwd: string | null
  /** Codex thread id — the key codexAppServer tracks active turns by. */
  threadId: string | null
}

interface Candidate {
  /** Known upfront for Claude files; resolved from meta for Codex rollouts. */
  dirName: string | null
  fileName: string
  filePath: string
  mtimeMs: number
}

/**
 * Last known result per file, so unchanged files need no re-read. `null`
 * remembers "not notifiable" (subagent, unreadable) without re-parsing.
 */
const known = new Map<string, { mtimeMs: number; snapshot: SessionSnapshot | null }>()
const tracker = new SessionAlertTracker()
let started = false
let sweeping = false

export function startSessionActivityMonitor(): void {
  if (started) return
  started = true
  const run = () => {
    if (sweeping) return
    sweeping = true
    sweep()
      .catch((err: unknown) => console.error("[sessionMonitor] sweep failed:", err))
      .finally(() => {
        sweeping = false
      })
  }
  setInterval(run, SWEEP_INTERVAL_MS).unref()
  run()
}

async function sweep(): Promise<void> {
  const candidates = await collectRecentCandidates(Date.now() - RECENT_WINDOW_MS)

  const snapshots = (await Promise.all(candidates.map((candidate) => snapshotCandidate(candidate))))
    .filter((snapshot): snapshot is SessionSnapshot => snapshot !== null)

  // Forget files that left the window so state cannot grow without bound.
  const present = new Set(candidates.map((c) => c.filePath))
  for (const filePath of known.keys()) {
    if (!present.has(filePath)) known.delete(filePath)
  }

  for (const alert of tracker.alerts(snapshots)) {
    deliverNotification(
      {
        title: titleFor(alert.session),
        body: alert.reason === "permission" ? "Needs your attention" : "Waiting for your input",
        nav: { sessionId: alert.session.sessionId, dirName: alert.session.dirName },
      },
      alert.reason,
    )
  }
}

async function collectRecentCandidates(minMtimeMs: number): Promise<Candidate[]> {
  const candidates: Candidate[] = []

  const entries = await readClaudeProjectEntries()
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "memory") continue
    const projectDir = join(dirs.PROJECTS_DIR, entry.name)
    let files: string[]
    try {
      files = await readdir(projectDir)
    } catch {
      continue
    }
    for (const fileName of files) {
      if (!fileName.endsWith(".jsonl")) continue
      const filePath = join(projectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.mtimeMs < minMtimeMs) continue
        candidates.push({ dirName: entry.name, fileName, filePath, mtimeMs: s.mtimeMs })
      } catch { /* deleted mid-scan */ }
    }
  }

  try {
    // Stat-level listing only — never getCodexSessionInventory(), whose
    // identity reads would re-open every rollout file each sweep.
    for (const file of await listCodexSessionFiles()) {
      if (file.mtimeMs < minMtimeMs) continue
      candidates.push({ dirName: null, fileName: file.fileName, filePath: file.filePath, mtimeMs: file.mtimeMs })
    }
  } catch (err) {
    console.error("[sessionMonitor] codex listing failed:", err)
  }

  return candidates
}

async function snapshotCandidate(candidate: Candidate): Promise<SessionSnapshot | null> {
  const previous = known.get(candidate.filePath)
  if (previous && previous.mtimeMs === candidate.mtimeMs) {
    // No write since last sweep → status unchanged; only liveness can differ.
    return previous.snapshot && { ...previous.snapshot, isActiveTurn: isActiveTurn(previous.snapshot) }
  }

  const snapshot = await loadSnapshot(candidate)
  known.set(candidate.filePath, { mtimeMs: candidate.mtimeMs, snapshot })
  return snapshot
}

async function loadSnapshot(candidate: Candidate): Promise<SessionSnapshot | null> {
  try {
    const { meta, status } = await getOrLoadSessionMeta(candidate.filePath, candidate.mtimeMs, async () => {
      const [meta, status] = await Promise.all([
        getSessionMeta(candidate.filePath),
        getSessionStatus(candidate.filePath),
      ])
      return { meta, status }
    })

    // Codex rollouts: dirName comes from the transcript's cwd; subagents are
    // reported through their parent. (Claude subagents live under nested
    // /subagents/ dirs the flat readdir never lists.)
    let dirName = candidate.dirName
    if (dirName === null) {
      if (meta.isSubagent || !meta.cwd) return null
      dirName = encodeCodexDirName(meta.cwd)
    }

    const snapshot: SessionSnapshot = {
      // The URL scheme addresses a session by its fileName stem (useUrlSync
      // appends ".jsonl"), so nav must use that — not meta.sessionId, which
      // for Codex is the bare thread id.
      sessionId: candidate.fileName.replace(/\.jsonl$/, ""),
      dirName,
      cwd: meta.cwd ?? null,
      threadId: meta.sessionId || null,
      status: status.status,
      isTeammate: Boolean(meta.teamName && meta.agentName),
    }
    snapshot.isActiveTurn = isActiveTurn(snapshot)
    return snapshot
  } catch {
    return null
  }
}

function isActiveTurn(snapshot: SessionSnapshot): boolean {
  if (!snapshot.dirName.startsWith("codex__") || !snapshot.threadId) return false
  return codexAppServer.getActiveTurnId(snapshot.threadId) !== undefined
}

function titleFor(session: SessionSnapshot): string {
  if (session.dirName.startsWith("codex__")) {
    return `Codex — ${session.cwd ? shortNameFromPath(session.cwd) : "Codex"}`
  }
  return `Claude Code — ${projectDirToReadableName(session.dirName).shortName}`
}
