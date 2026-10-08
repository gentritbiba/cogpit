import type { CrewLink } from "./sessionOrigins"

/**
 * A crew is the sessions one session started through Cogpit, and theirs. Its
 * root is the first session in that chain nothing started. Lists show a crew
 * as its root: members ride with it instead of taking places of their own.
 */

/** Deeper chains than this are a recording error, not a crew. */
const MAX_DEPTH = 32

/** A session's ancestors, nearest first; empty when the chain loops back to it. */
function ancestorsOf(sessionId: string, parents: ReadonlyMap<string, CrewLink>): string[] {
  const chain: string[] = []
  const seen = new Set([sessionId])
  let current = parents.get(sessionId)?.parentSessionId
  while (current && chain.length < MAX_DEPTH) {
    if (current === sessionId) return []
    if (seen.has(current)) break
    seen.add(current)
    chain.push(current)
    current = parents.get(current)?.parentSessionId
  }
  return chain
}

/** The root of a session's crew; the session itself when nothing started it. */
export function crewRootOf(sessionId: string, parents: ReadonlyMap<string, CrewLink>): string {
  return ancestorsOf(sessionId, parents).at(-1) ?? sessionId
}

export interface CrewFoldOptions<T> {
  idOf: (item: T) => string
  mtimeOf: (item: T) => number
  /** Whether a listed session may carry its crew; a member under one that may not is placed higher, or on its own. */
  canHost: (sessionId: string) => boolean
  /** Whether a member will be listed with its crew, and so moves the crew's latest activity; every member when absent. */
  counts?: (sessionId: string) => boolean
}

export interface CrewFold<T> {
  /** What a list places on its own, by the crew's latest activity: plain sessions, roots, members with no listed ancestor. */
  units: T[]
  /** Every member riding with a listed session, at any depth, in the order they were started. */
  membersOf: ReadonlyMap<string, T[]>
  /** The latest activity of a session carrying a crew, its own or any member's. */
  crewMtime: ReadonlyMap<string, number>
}

/**
 * Place each candidate under the highest listed ancestor that may carry it, so
 * a crew takes one place in a list however many sessions it holds.
 */
export function foldCrews<T>(
  candidates: readonly T[],
  parents: ReadonlyMap<string, CrewLink>,
  { idOf, mtimeOf, canHost, counts = () => true }: CrewFoldOptions<T>,
): CrewFold<T> {
  const listed = new Set(candidates.map(idOf))
  const membersOf = new Map<string, T[]>()
  const crewMtime = new Map<string, number>()
  const units: T[] = []

  for (const candidate of candidates) {
    const chain = ancestorsOf(idOf(candidate), parents)
    let host: string | undefined
    for (let index = chain.length - 1; index >= 0 && host === undefined; index--) {
      const ancestor = chain[index]!
      if (listed.has(ancestor) && canHost(ancestor)) host = ancestor
    }
    if (host === undefined) {
      units.push(candidate)
      continue
    }
    const members = membersOf.get(host)
    if (members) members.push(candidate)
    else membersOf.set(host, [candidate])
  }

  const byId = new Map(candidates.map((candidate) => [idOf(candidate), candidate]))
  for (const [host, members] of membersOf) {
    const startedAt = (item: T) => parents.get(idOf(item))?.createdAt ?? 0
    members.sort((a, b) => startedAt(a) - startedAt(b) || mtimeOf(a) - mtimeOf(b))
    const hostItem = byId.get(host)
    const counted = members.filter((member) => counts(idOf(member)))
    crewMtime.set(host, Math.max(hostItem ? mtimeOf(hostItem) : 0, ...counted.map(mtimeOf)))
  }

  const recency = (item: T) => crewMtime.get(idOf(item)) ?? mtimeOf(item)
  const order = new Map(units.map((unit, index) => [unit, index]))
  units.sort((a, b) => recency(b) - recency(a) || order.get(a)! - order.get(b)!)
  return { units, membersOf, crewMtime }
}
