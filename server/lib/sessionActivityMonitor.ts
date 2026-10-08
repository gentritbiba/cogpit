import { getSessionMeta, getSessionStatus } from "../helpers"
import { findJsonlPath } from "../sessionPaths"
import { crewRootOf } from "./crew"
import { editionModule } from "../edition"
import { sessionParents } from "./sessionOrigins"
import { projectDirToReadableName, shortNameFromPath } from "./projectNames"
import {
  descriptorFor,
  projectDirNameFor,
  type AgentKind,
} from "../../shared/session/agent-descriptors"
import { allStores } from "../agents"
import { runtimeFor } from "../agents/runtimes"
import { getOrLoadSessionMeta } from "./sessionMetaCache"
import { SessionAlertTracker, type TrackedSessionSnapshot } from "./sessionAlertTracker"
import { deliverNotification } from "./notificationDelivery"
import { instanceDirName, instanceSessionId, splitInstanceSessionId } from "../../shared/session/instances"

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
 * their mtime moved since the last sweep. Every agent's storage goes through
 * the same gate: the stat-level listing is cheap, identity/status reads happen
 * per change, never per sweep.
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
  agentKind: AgentKind
  instanceId?: string
  urlId: string
  dirName: string
  cwd: string | null
  /** Short project name for the notification title. */
  projectName: string
  /** The id the runtime tracks turns by. */
  threadId: string | null
  /** For a session another session started: what it is called, and its crew's root. */
  crew?: { name: string; rootId: string }
}

interface Candidate {
  /** Known upfront where the path names the project; resolved from meta otherwise. */
  dirName: string | null
  fileName: string
  filePath: string
  mtimeMs: number
  agentKind: AgentKind
  instanceId?: string
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
        title: await titleFor(alert.session),
        body: alert.reason === "permission" ? "Needs your attention" : "Waiting for your input",
        nav: { sessionId: alert.session.urlId, dirName: alert.session.dirName },
      },
      alert.reason,
    )
  }
}

async function collectRecentCandidates(minMtimeMs: number): Promise<Candidate[]> {
  const candidates: Candidate[] = []

  // Stat-level listing only — never the session inventory, whose identity reads
  // would re-open every transcript on every sweep.
  for (const store of allStores()) {
    try {
      for (const file of await store.listSessionFiles()) {
        if (file.mtimeMs < minMtimeMs) continue
        candidates.push({
          dirName: file.dirName,
          fileName: file.fileName,
          filePath: file.filePath,
          mtimeMs: file.mtimeMs,
          agentKind: store.kind,
          instanceId: store.instanceId,
        })
      }
    } catch (err) {
      console.error(`[sessionMonitor] ${store.kind} listing failed:`, err)
    }
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

export async function loadSnapshot(candidate: Candidate): Promise<SessionSnapshot | null> {
  try {
    const { meta, status } = await getOrLoadSessionMeta(candidate.filePath, candidate.mtimeMs, async () => {
      const [meta, status] = await Promise.all([
        getSessionMeta(candidate.filePath),
        getSessionStatus(candidate.filePath),
      ])
      return { meta, status }
    })

    // A transcript whose path does not name the project derives its project
    // key — and its label — from the recorded cwd.
    let dirName = candidate.dirName
    let projectName: string
    if (dirName === null) {
      if (meta.isSubagent || !meta.cwd) return null
      dirName = instanceDirName(candidate.instanceId ?? "default", projectDirNameFor(candidate.agentKind, meta.cwd))
      projectName = shortNameFromPath(meta.cwd)
    } else {
      projectName = projectDirToReadableName(dirName).shortName
    }

    const urlId = descriptorFor(candidate.agentKind).sessionFile.urlId(candidate.fileName)
    const sessionId = instanceSessionId(candidate.instanceId ?? "default", urlId)
    const threadId = meta.sessionId ? instanceSessionId(candidate.instanceId ?? "default", splitInstanceSessionId(meta.sessionId).nativeId) : null
    const parents = await sessionParents()
    const crewId = [threadId, sessionId].find((id) => id && parents.has(id))
    const link = crewId ? parents.get(crewId) : undefined
    const snapshot: SessionSnapshot = {
      sessionId,
      urlId,
      dirName,
      agentKind: candidate.agentKind,
      instanceId: candidate.instanceId,
      cwd: meta.cwd ?? null,
      projectName,
      threadId,
      status: status.status,
      isTeammate: Boolean(meta.teamName && meta.agentName),
      ...(crewId && link && {
        reportsToLead: true,
        crew: {
          name: link.name || meta.customTitle || (meta.cwd ? shortNameFromPath(meta.cwd) : projectName),
          rootId: crewRootOf(crewId, parents),
        },
      }),
    }
    snapshot.isActiveTurn = isActiveTurn(snapshot)
    return snapshot
  } catch {
    return null
  }
}

/** The runtime's own turn state, for an agent whose transcript lags behind it. */
function isActiveTurn(snapshot: SessionSnapshot): boolean {
  if (!snapshot.threadId) return false
  if (descriptorFor(snapshot.agentKind).capabilities.turnLiveness !== "runtime") return false
  return runtimeFor(snapshot.agentKind, snapshot.instanceId).activity(snapshot.threadId).running
}

const rootTitles = new Map<string, string>()

/** What a crew's root is called, read once per root; null when its transcript cannot be read. */
async function rootTitle(rootId: string): Promise<string | null> {
  const known = rootTitles.get(rootId)
  if (known) return known
  try {
    const filePath = await findJsonlPath(rootId)
    if (!filePath) return null
    const meta = await getSessionMeta(filePath)
    const title = (meta.customTitle || meta.aiTitle || meta.firstUserMessage || "").split("\n")[0]?.trim().slice(0, 60)
    if (!title) return null
    rootTitles.set(rootId, title)
    return title
  } catch {
    return null
  }
}

/**
 * "<agent> — project", or for a crew member "w3-rooftop · Wave 3 coordinator".
 * A notification reaches whoever may see the member, and with accounts that
 * can include someone who may not see its root, so only an install without
 * accounts names the root.
 */
export async function titleFor(session: Pick<SessionSnapshot, "crew" | "agentKind" | "projectName">): Promise<string> {
  if (session.crew) {
    const root = editionModule().auth ? null : await rootTitle(session.crew.rootId)
    return root ? `${session.crew.name} · ${root}` : session.crew.name
  }
  return `${descriptorFor(session.agentKind).displayName} — ${session.projectName}`
}
