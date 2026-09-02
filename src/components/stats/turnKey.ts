import type { Turn } from "../../../shared/session/types"

export function getTurnKey(turn: Turn, index: number): string {
  return `${turn.id}-${index}`
}
