import type { Turn } from "../../../shared/session/types"

/**
 * The key of every turn: its id, stable across prepends, with a suffix for an
 * id that repeats. Computed over all loaded turns, never a filtered subset, so
 * a turn's key does not depend on what is shown around it.
 */
export function turnKeysOf(turns: readonly Turn[]): string[] {
  const seen = new Map<string, number>()
  return turns.map((turn) => {
    const count = seen.get(turn.id) ?? 0
    seen.set(turn.id, count + 1)
    return count === 0 ? turn.id : `${turn.id}#${count}`
  })
}
