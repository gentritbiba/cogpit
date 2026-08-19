/**
 * How much of a working group stays on screen while the agent is mid-turn.
 *
 * A live group opens itself so the user can watch, but a long turn then renders
 * every call it has made and the transcript becomes a wall that grows under the
 * reader. Only the newest entry is actually live; the rest is history that has
 * not been asked for yet.
 */
export const MAX_LIVE_WORK_ENTRIES = 1

export interface WorkLogTail<T> {
  /** Entries to render, oldest first. */
  visible: T[]
  /** How many older entries are folded away. */
  hidden: number
}

/**
 * Trim a working group to its newest entries.
 *
 * `tailOnly` is false whenever the group is open because the user asked for it,
 * so an explicit expand always shows the whole group.
 */
export function planWorkLogTail<T>(entries: readonly T[], tailOnly: boolean): WorkLogTail<T> {
  if (!tailOnly || entries.length <= MAX_LIVE_WORK_ENTRIES) {
    return { visible: [...entries], hidden: 0 }
  }
  return {
    visible: entries.slice(-MAX_LIVE_WORK_ENTRIES),
    hidden: entries.length - MAX_LIVE_WORK_ENTRIES,
  }
}

/** Label for the control that reveals the folded head of a working group. */
export function workLogTailLabel(hidden: number): string {
  return `${hidden} earlier step${hidden === 1 ? "" : "s"}`
}
