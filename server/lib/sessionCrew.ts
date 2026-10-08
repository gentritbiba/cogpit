import type { CrewMember, SessionCrew } from "../../shared/contracts/crew"
import type { DelegatedTask } from "../../shared/contracts/orchestration"
import type { SessionPullRequest } from "../../shared/session/prLinks"
import { crewRootOf } from "./crew"
import type { CrewLink } from "./sessionOrigins"
import type { SessionState } from "./sessionWait"

/**
 * A crew as one view sees it: from any of its sessions, the root and every
 * member at any depth, each with where it runs, what it is doing and what it
 * is waiting on. Served by `/api/session-crew/:id` for the Crew panel.
 */

/** More members than this is a runaway, not a crew a panel can show. */
const MAX_MEMBERS = 200

/** A session as the machine it runs on describes it. */
export interface DescribedSession {
  host: { remote: boolean; id: string; name: string }
  state: SessionState
  address: { dirName: string; fileName: string } | null
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
  describe: (sessionId: string) => Promise<DescribedSession>
  listed: (sessionId: string) => Promise<ListedFacts | null>
  tasks: () => readonly DelegatedTask[]
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
async function crewIds(rootId: string, sources: CrewSources): Promise<string[]> {
  const children = childrenIndex(sources.parents)
  const ids = [rootId]
  const seen = new Set(ids)
  for (let index = 0; index < ids.length && ids.length < MAX_MEMBERS; index++) {
    for (const child of children.get(ids[index]!) ?? []) {
      if (seen.has(child) || ids.length >= MAX_MEMBERS) continue
      seen.add(child)
      if (await sources.canView(child)) ids.push(child)
    }
  }
  const startedAt = (id: string) => sources.parents.get(id)?.createdAt ?? 0
  return [rootId, ...ids.slice(1).sort((a, b) => startedAt(a) - startedAt(b))]
}

/** The newest task that carries each session's result to its parent. */
function resultTasks(tasks: readonly DelegatedTask[]): Map<string, DelegatedTask> {
  const byChild = new Map<string, DelegatedTask>()
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
  task: DelegatedTask | undefined,
): Promise<CrewMember> {
  const link = sessionId === rootId ? undefined : sources.parents.get(sessionId)
  const place = {
    sessionId,
    parentId: link?.parentSessionId ?? null,
    startedAt: link?.createdAt ?? null,
    ...(link?.name && { name: link.name }),
    ...(task && { result: { taskId: task.id, state: task.state, acknowledged: Boolean(task.acknowledgedAt) } }),
  }
  let described: DescribedSession
  try {
    described = await sources.describe(sessionId)
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
  const { host, state, address } = described
  const listed = host.remote ? null : await sources.listed(sessionId)
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
  const ids = await crewIds(rootId, sources)
  const tasks = resultTasks(sources.tasks())
  const members = await Promise.all(ids.map((id) => describeMember(id, rootId, sources, tasks.get(id))))
  return { sessionId, rootId, members }
}
