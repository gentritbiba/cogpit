import type { IncomingMessage } from "node:http"
import type { SessionCrew } from "../../shared/contracts/crew"
import type { DelegatedTaskState } from "../../shared/contracts/orchestration"
import { accessAtLeast } from "../../shared/contracts/sessionAccess"
import { RECENT_ACTIVITY_MS, WORKING_STATUSES } from "../../shared/sessionActivity"
import { allTopLevelSessions } from "../agents"
import { listedSessionId } from "../agents/listedSession"
import { runtimeForSession } from "../agents/runtimes"
import type { TopLevelSessionInfo } from "../agents/types"
import { accessLevelOf } from "../edition"
import { getSessionStatus } from "../helpers"
import { orchestrationStore } from "../orchestration/storage"
import { hostForOrigin, localHost } from "../sessionHosts"
import { crewRootOf } from "./crew"
import { commandScope } from "./durableSend"
import { recencyCache } from "./recencyCache"
import { archiveReason, readArchive } from "./sessionArchive"
import { readSessionCrew, type CrewSources, type DescribedSession } from "./sessionCrew"
import { lastActivityOf, listedMeta } from "./listedSessionMeta"
import { sessionOrigin, sessionParents } from "./sessionOrigins"
import { getScannedSessionPullRequests, getSessionPullRequests } from "./sessionPrIndex"
import { readSessionSignals, readSessionState, sessionStateFrom, type SessionSignals } from "./sessionWait"

/**
 * `/api/session-crew/:id` for crews of hundreds of members, polled every few
 * seconds. A member that has settled is described again only once something
 * it can change by moves: its transcript, the runtime holding it, what it
 * waits on, its queue or its task. A member the clock can still change (a
 * recent mid-turn tail, agents still writing) or with a turn error is read
 * fresh every time.
 */

/** How long a member on a hub device answers from its last description. */
const REMOTE_MEMO_MS = 3_000
/** The `brief=1` preview of a member's first prompt, enough for three lines of a card. */
const PREVIEW_CHARS = 400

interface SettledMember { key: string; described: DescribedSession }
const settled = recencyCache<SettledMember>({ capacity: 2_000, inUseMs: 60_000, ceiling: 10_000 })
const remote = new Map<string, { at: number; described: Promise<DescribedSession> }>()

export function resetCrewSnapshotForTest(): void {
  settled.clear()
  remote.clear()
}

function changeKey(candidate: TopLevelSessionInfo, signals: SessionSignals, task: DelegatedTaskState | undefined): string {
  return JSON.stringify([
    candidate.mtimeMs,
    candidate.size,
    signals.activity,
    signals.waiting.map((request) => request.requestId),
    signals.startsNext,
    task?.updatedAt ?? null,
  ])
}

/**
 * Whether time alone can still change what a tail means. A mid-turn tail
 * reads as working while the transcript was written recently, and one
 * waiting on agents while they write; past that only a write changes it.
 */
function clockCanChange(status: string | undefined, lastActivityMs: number): boolean {
  if (!status || !WORKING_STATUSES.has(status)) return false
  return status === "awaiting_agents" || Date.now() - lastActivityMs < RECENT_ACTIVITY_MS
}

/** A member this machine lists, from the session list's cached tail and metadata. */
async function describeListed(id: string, candidate: TopLevelSessionInfo, signals: SessionSignals | null): Promise<{ described: DescribedSession; settled: boolean }> {
  const host = { remote: false, id: localHost.id, name: localHost.name }
  const address = { dirName: candidate.dirName, fileName: candidate.fileName }
  const cached = await listedMeta(candidate).catch(() => null)
  const statusInfo = cached?.status ?? await getSessionStatus(candidate.filePath)
  const lastActivityAt = cached ? lastActivityOf(cached.meta, candidate.mtimeMs) : undefined
  const lastActivityMs = Date.parse(lastActivityAt ?? "") || candidate.mtimeMs
  const state = signals
    ? await sessionStateFrom(id, signals, { filePath: candidate.filePath, statusInfo, lastActivityMs })
    : { sessionId: id, outcome: "not_found" as const, live: false, running: false, waiting: [] }
  if (!cached) return { described: { host, state, address, listed: null }, settled: false }
  const { meta } = cached
  const pullRequests = await getSessionPullRequests(candidate.filePath, candidate.size)
  return {
    described: {
      host,
      state,
      address,
      listed: {
        ...(meta.customTitle && { customTitle: meta.customTitle }),
        aiTitle: meta.aiTitle,
        firstUserMessage: meta.firstUserMessage,
        cwd: meta.cwd,
        model: meta.model,
        turnCount: meta.turnCount,
        lastActivityAt,
        ...(pullRequests.length > 0 && { pullRequests }),
      },
    },
    settled: Boolean(signals) && state.outcome !== "running" && !signals?.turnError
      && !clockCanChange(statusInfo.status, lastActivityMs)
      // A long transcript's pull requests are found over several reads.
      && getScannedSessionPullRequests(candidate.filePath, candidate.size) !== null,
  }
}

function describeRemote(id: string, device: NonNullable<ReturnType<typeof hostForOrigin>>): Promise<DescribedSession> {
  const now = Date.now()
  const known = remote.get(id)
  if (known && now - known.at < REMOTE_MEMO_MS) return known.described
  for (const [key, entry] of remote) if (now - entry.at >= REMOTE_MEMO_MS) remote.delete(key)
  const described = Promise.all([device.state(id), device.address(id)]).then(([state, address]) => ({
    host: { remote: true, id: device.id, name: device.name },
    state,
    address,
  }))
  remote.set(id, { at: now, described })
  described.catch(() => { if (remote.get(id)?.described === described) remote.delete(id) })
  return described
}

/**
 * Where a crew is read from. Its members are the ones the session list
 * carries with the crew, read from one listing: sessions this machine lists
 * and has not archived, and those a runtime here holds before their
 * transcript is written. A member recorded on a hub device is asked there;
 * one recorded without a device runs here, so no other device is searched.
 */
async function crewSources(req: IncomingMessage, sessionId: string, localOnly: boolean): Promise<CrewSources> {
  const [parents, listing, archive] = await Promise.all([sessionParents(), allTopLevelSessions(), readArchive()])
  const listedById = new Map(listing.map((session) => [listedSessionId(session), session]))
  const rootId = crewRootOf(sessionId, parents)
  const scope = commandScope(req)
  const now = Date.now()
  let startingNext: ReadonlySet<string> | undefined
  try { startingNext = orchestrationStore().conversationsStartingNext() } catch { /* Each member asks its own queue. */ }
  const canView = async (id: string) => {
    const level = await accessLevelOf(req, id)
    return Boolean(level && accessAtLeast(level, "view"))
  }
  return {
    parents,
    canView: (id) => (id === sessionId ? Promise.resolve(true) : canView(id)),
    describe: async (id, task) => {
      const device = localOnly ? null : hostForOrigin(await sessionOrigin(id))
      if (device) return describeRemote(id, device)
      const candidate = listedById.get(id)
      const required = id === sessionId || id === rootId
      if (!required && (candidate ? archiveReason(archive, id, candidate.mtimeMs, now) : !runtimeForSession(id))) return null
      if (!candidate) {
        const [state, address] = await Promise.all([readSessionState(id), localHost.address(id)])
        return { host: { remote: false, id: localHost.id, name: localHost.name }, state, address }
      }
      const signals = await readSessionSignals(id, candidate.filePath, startingNext)
      const memoKey = `${scope}\0${id}`
      const key = signals && changeKey(candidate, signals, task)
      const known = key && !signals?.turnError ? settled.get(memoKey) : undefined
      if (known && known.key === key) return known.described
      const fresh = await describeListed(id, candidate, signals)
      if (key && fresh.settled) settled.set(memoKey, { key, described: fresh.described })
      else settled.delete(memoKey)
      return fresh.described
    },
    tasks: (ids) => {
      try {
        return orchestrationStore().taskStates(scope, { childSessionIds: ids })
      } catch {
        return []
      }
    },
  }
}

const preview = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line
}

/** The crew `sessionId` belongs to; `brief` clips each first prompt to a preview. */
export async function readCrewSnapshot(req: IncomingMessage, sessionId: string, options: { localOnly: boolean; brief: boolean }): Promise<SessionCrew | null> {
  const crew = await readSessionCrew(sessionId, await crewSources(req, sessionId, options.localOnly))
  if (!crew || !options.brief) return crew
  return {
    ...crew,
    members: crew.members.map((member) => (member.firstUserMessage ? { ...member, firstUserMessage: preview(member.firstUserMessage) } : member)),
  }
}
