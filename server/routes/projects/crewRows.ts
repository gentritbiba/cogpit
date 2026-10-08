import type { ListedCrew, ListedCrewSummary } from "../../../shared/contracts/crew"
import { getSessionRecencyMs } from "../../../shared/session-ordering"
import { listedSession, listedSessionId } from "../../agents/listedSession"
import type { TopLevelSessionInfo } from "../../agents/types"
import type { VisibilityCheck } from "../../edition"
import { crewRootOf, foldCrews } from "../../lib/crew"
import { sessionParents, type CrewLink } from "../../lib/sessionOrigins"
import { readSessionTitle } from "./activeSessionRow"

/**
 * How /api/active-sessions places crews. A member rides with the highest
 * listed ancestor that may carry it, so a crew takes one place under the
 * list's caps; a search places every session on its own.
 */
export interface CrewPlan {
  /** What the list places on its own, by the crew's latest activity. */
  units: TopLevelSessionInfo[]
  /** The members riding with each unit that carries a crew. */
  membersOf: ReadonlyMap<string, TopLevelSessionInfo[]>
  /** A session's place in its crew, with the names a member listed on its own needs for its lineage. */
  membership: (sessionId: string, listedOnItsOwn: boolean) => Promise<ListedCrew | undefined>
}

interface PlanOptions {
  /** Fold members under their crew; off for searches, which list every match on its own. */
  grouped: boolean
  /** Whether a listed session may carry its crew: not when it is archived. */
  canHost: (sessionId: string) => boolean
  /** Whether a member is listed at all: archived members only when archived sessions are asked for. */
  listsMember: (sessionId: string) => boolean
  check: VisibilityCheck
}

/**
 * Which of the sessions in a crew, as a member or as one that would carry
 * members, the caller may see; null when the caller sees everything.
 */
async function visibleInCrews(
  candidates: readonly TopLevelSessionInfo[],
  parents: ReadonlyMap<string, CrewLink>,
  check: VisibilityCheck,
): Promise<ReadonlySet<string> | null> {
  if (check.everything) return null
  const involved = new Set<string>()
  for (const candidate of candidates) {
    const id = listedSessionId(candidate)
    if (!parents.has(id)) continue
    involved.add(id)
    let current = parents.get(id)?.parentSessionId
    for (let depth = 0; current && depth < 32 && !involved.has(current); depth++) {
      involved.add(current)
      current = parents.get(current)?.parentSessionId
    }
  }
  const visible = new Set<string>()
  await Promise.all(candidates.map(async (candidate) => {
    const { sessionId, hint } = listedSession(candidate)
    if (involved.has(sessionId) && await check(sessionId, hint) !== "hidden") visible.add(sessionId)
  }))
  return visible
}

export async function planCrews(
  candidates: readonly TopLevelSessionInfo[],
  { grouped, canHost, listsMember, check }: PlanOptions,
): Promise<CrewPlan> {
  const parents = await sessionParents()
  const byId = new Map(candidates.map((candidate) => [listedSessionId(candidate), candidate]))
  const titleOf = async (sessionId: string): Promise<string | undefined> => {
    const named = parents.get(sessionId)?.name
    if (named) return named
    const candidate = byId.get(sessionId)
    return candidate ? readSessionTitle(candidate) : undefined
  }
  const membership = async (sessionId: string, listedOnItsOwn: boolean): Promise<ListedCrew | undefined> => {
    const link = parents.get(sessionId)
    if (!link) return undefined
    const rootId = crewRootOf(sessionId, parents)
    const [rootTitle, parentTitle] = listedOnItsOwn
      ? await Promise.all([titleOf(rootId), titleOf(link.parentSessionId)])
      : [undefined, undefined]
    return {
      rootId,
      parentId: link.parentSessionId,
      startedAt: link.createdAt,
      ...(link.name && { name: link.name }),
      ...(rootTitle && { rootTitle }),
      ...(parentTitle && { parentTitle }),
    }
  }

  if (!grouped || parents.size === 0) {
    return { units: [...candidates], membersOf: new Map(), membership }
  }
  const visible = await visibleInCrews(candidates, parents, check)
  const seen = (sessionId: string) => visible === null || visible.has(sessionId)
  const { units, membersOf } = foldCrews(candidates, parents, {
    idOf: listedSessionId,
    mtimeOf: (candidate) => candidate.mtimeMs,
    canHost: (sessionId) => canHost(sessionId) && seen(sessionId),
    // A member that will not be listed must not move its crew up the list.
    counts: (sessionId) => listsMember(sessionId) && seen(sessionId),
  })
  return { units, membersOf, membership }
}

interface CrewRow {
  sessionId: string
  lastActivityAt?: string
  lastModified?: string
}

/** The summary a unit carries for the members listed with it; undefined when none are. */
export function crewSummary(unit: CrewRow, members: readonly CrewRow[]): ListedCrewSummary | undefined {
  if (members.length === 0) return undefined
  const latest = [unit, ...members].reduce((best, row) => (
    getSessionRecencyMs(row) > getSessionRecencyMs(best) ? row : best
  ))
  return {
    size: members.length,
    activityAt: latest.lastActivityAt || latest.lastModified || new Date(0).toISOString(),
  }
}
