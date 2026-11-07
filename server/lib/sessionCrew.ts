import type { CrewMember, SessionCrew } from "../../shared/contracts/crew"
import type { DelegatedTaskState } from "../../shared/contracts/orchestration"
import type { SessionPullRequest } from "../../shared/session/prLinks"
import { crewRootOf } from "./crew"
import type { CrewLink } from "./sessionOrigins"
import type { SessionState } from "./sessionWait"

/**
 * A crew as one view sees it: from any of its sessions, the root and every
 * member at any depth, each with where it runs, what it is doing and what it
 * is waiting on. Served by `/api/session-crew/:id` for the Crew panel.
 */

/** A session as the machine it runs on describes it. */
export interface DescribedSession {
  host: { remote: boolean; id: string; name: string }
  state: SessionState
  address: { dirName: string; fileName: string } | null
  /** What the session list knows about it; only for a session on this machine. */
  listed?: ListedFacts | null
}

/** What the session list knows about a session on this machine. */
export interface ListedFacts {
  customTitle?: string
  aiTitle?: string
  firstUserMessage?: string
  cwd?: string
  model?: string
  turnCount?: number
  lastActivityAt?: string
  pullRequests?: SessionPullRequest[]
}

export interface CrewSources {
  parents: ReadonlyMap<string, CrewLink>
  canView: (sessionId: string) => Promise<boolean>
  /** Null for a session neither on disk nor held by anything, which the session list leaves out too. */
  describe: (sessionId: string, task: DelegatedTaskState | undefined) => Promise<DescribedSession | null>
  /** The tasks carrying the given sessions' results. */
  tasks: (sessionIds: readonly string[]) => readonly DelegatedTaskState[]
}

function childrenIndex(parents: ReadonlyMap<string, CrewLink>): Map<string, string[]> {
  const children = new Map<string, string[]>()
  for (const [child, link] of parents) {
    const siblings = children.get(link.parentSessionId)
    if (siblings) siblings.push(child)
    else children.set(link.parentSessionId, [child])
  }
  return children
}

/** The root and the members the caller may see; a hidden member hides what it started too. */
export async function crewSessionIds(rootId: string, sources: Pick<CrewSources, "parents" | "canView">): Promise<string[]> {
  const children = childrenIndex(sources.parents)
  const ids = [rootId]
  const seen = new Set(ids)
  for (let index = 0; index < ids.length; index++) {
    for (const child of children.get(ids[index]!) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      if (await sources.canView(child)) ids.push(child)
    }
  }
  const startedAt = (id: string) => sources.parents.get(id)?.createdAt ?? 0
  return [rootId, ...ids.slice(1).sort((a, b) => startedAt(a) - startedAt(b))]
}

/** The newest task that carries each session's result to its parent. */
function resultTasks(tasks: readonly DelegatedTaskState[]): Map<string, DelegatedTaskState> {
  const byChild = new Map<string, DelegatedTaskState>()
  for (const task of tasks) {
    const known = byChild.get(task.childSessionId)
    if (!known || task.createdAt > known.createdAt) byChild.set(task.childSessionId, task)
  }
  return byChild
}

async function describeMember(
  sessionId: string,
  rootId: string,
  sources: CrewSources,
  task: DelegatedTaskState | undefined,
  required: boolean,
): Promise<CrewMember | null> {
  const link = sessionId === rootId ? undefined : sources.parents.get(sessionId)
  const place = {
    sessionId,
    parentId: link?.parentSessionId ?? null,
    startedAt: link?.createdAt ?? null,
    ...(link?.name && { name: link.name }),
    ...(task && { result: { taskId: task.id, state: task.state, acknowledged: Boolean(task.acknowledgedAt) } }),
  }
  let described: DescribedSession | null
  try {
    described = await sources.describe(sessionId, task)
  } catch (error) {
    return {
      ...place,
      device: null,
      address: null,
      outcome: "unreachable",
      waiting: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!described) {
    // The root and the session asked about stay, so the crew keeps both ends.
    return required ? { ...place, device: null, address: null, outcome: "not_found", waiting: [] } : null
  }
  const { host, state, address, listed } = described
  return {
    ...place,
    device: host.remote ? { id: host.id, name: host.name } : null,
    address,
    outcome: state.outcome,
    status: state.status ?? null,
    toolName: state.toolName ?? null,
    waiting: state.waiting,
    ...(state.error && { error: state.error }),
    ...listed,
  }
}

export async function readSessionCrew(sessionId: string, sources: CrewSources): Promise<SessionCrew | null> {
  if (!await sources.canView(sessionId)) return null
  const root = crewRootOf(sessionId, sources.parents)
  // A root the caller may not see leaves the crew to start where they can.
  const rootId = root === sessionId || await sources.canView(root) ? root : sessionId
  const ids = await crewSessionIds(rootId, sources)
  const tasks = resultTasks(sources.tasks(ids))
  const members = await Promise.all(ids.map((id) => (
    describeMember(id, rootId, sources, tasks.get(id), id === rootId || id === sessionId)
  )))
  return { sessionId, rootId, members: members.flatMap((member) => (member ? [member] : [])) }
}
