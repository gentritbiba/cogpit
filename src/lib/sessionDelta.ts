import type { SessionView } from "../../shared/session/sessionDigest"
import type { Turn } from "../../shared/session/types"
import type { SessionDelta } from "@/workers/session-parser.worker"

/**
 * `next`, with every part equal to the same part of `previous` replaced by
 * that part of `previous`. A worker reply is a fresh copy, so this is what
 * keeps an unchanged block or tool call the object the timeline memoised.
 * An object `next` holds in two places comes out as one object.
 */
export function shareUnchanged<T>(previous: T, next: T): T {
  const done = new Map<object, unknown>()
  const share = (before: unknown, after: unknown): unknown => {
    if (before === after || typeof after !== "object" || after === null) return after
    const settled = done.get(after)
    if (settled !== undefined) return settled
    if (typeof before !== "object" || before === null || Array.isArray(before) !== Array.isArray(after)) {
      done.set(after, after)
      return after
    }
    let result: unknown
    if (Array.isArray(after)) {
      const old = before as unknown[]
      const items = after.map((item, index) => share(old[index], item))
      result = items.length === old.length && items.every((item, index) => item === old[index]) ? old : items
    } else {
      const old = before as Record<string, unknown>
      const fresh = after as Record<string, unknown>
      const keys = Object.keys(fresh)
      const copy: Record<string, unknown> = {}
      let same = keys.length === Object.keys(old).length
      for (const key of keys) {
        copy[key] = share(old[key], fresh[key])
        if (copy[key] !== old[key] || !(key in old)) same = false
      }
      result = same ? old : copy
    }
    done.set(after, result)
    return result
  }
  return share(previous, next) as T
}

/**
 * The view an append produced: `base` with its turns from `delta.fromTurn` on
 * replaced. A turn whose id and version did not change stays the same object;
 * a changed turn keeps every part that is still equal. `versions` records
 * each turn object's version.
 */
export function applySessionDelta(base: SessionView, delta: SessionDelta, versions: WeakMap<Turn, number>): SessionView {
  const turns = base.turns.slice(0, delta.fromTurn)
  delta.turns.forEach((turn, offset) => {
    const previous = base.turns[delta.fromTurn + offset]
    const version = delta.turnVersions[offset]!
    if (previous && previous.id === turn.id && versions.get(previous) === version) {
      turns.push(previous)
      return
    }
    const next = previous && previous.id === turn.id ? shareUnchanged(previous, turn) : turn
    versions.set(next, version)
    turns.push(next)
  })
  return { ...delta.meta, turns, stats: delta.stats, digest: delta.digest }
}
