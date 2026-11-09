import { hasEditToolCalls } from "../../shared/session/edit-calls"
import type { Turn } from "../../shared/session/types"

/**
 * Facts the app shell reads from every turn on every live update, cached per
 * turn object. A streamed update keeps every turn it did not change, so only
 * the changed ones are looked at again.
 */
const editsByTurn = new WeakMap<Turn, { cwd: string; edits: boolean }>()
const workflowsByTurn = new WeakMap<Turn, number>()

function turnEdits(turn: Turn, cwd: string): boolean {
  const cached = editsByTurn.get(turn)
  if (cached?.cwd === cwd) return cached.edits
  const edits = hasEditToolCalls(turn.toolCalls, cwd)
    || turn.subAgentActivity.some((message) => hasEditToolCalls(message.toolCalls, cwd))
  editsByTurn.set(turn, { cwd, edits })
  return edits
}

/** Whether any turn changes files: Edit/Write, MultiEdit, or the Bash writes bypass-permissions sessions make. */
export function turnsChangeFiles(turns: readonly Turn[], cwd: string): boolean {
  return turns.some((turn) => turnEdits(turn, cwd))
}

/** How many Workflow tool calls the turns made. */
export function workflowCallCount(turns: readonly Turn[]): number {
  let count = 0
  for (const turn of turns) {
    let calls = workflowsByTurn.get(turn)
    if (calls === undefined) {
      calls = turn.toolCalls.reduce((total, call) => total + (call.name === "Workflow" ? 1 : 0), 0)
      workflowsByTurn.set(turn, calls)
    }
    count += calls
  }
  return count
}
