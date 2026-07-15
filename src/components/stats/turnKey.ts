import type { Turn } from "@/lib/types"

export function getTurnKey(turn: Turn, index: number): string {
  return `${turn.id}-${index}`
}
