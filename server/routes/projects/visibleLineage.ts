import type { VisibilityCheck } from "../../edition"

/** A listed row, with the fields that name another session. */
interface LineageReferences {
  sessionId: string
  branchedFrom?: { sessionId: string }
  parentSessionId?: string | null
  teamLeadSessionId?: string
}

export type LineageFilter = <T extends LineageReferences>(row: T) => Promise<T>

/**
 * Drops each row's references to sessions `check` hides, so a list never names
 * a session its caller could not open. Each referenced session is checked once
 * per filter.
 */
export function visibleLineage(check: VisibilityCheck): LineageFilter {
  if (check.everything) return async (row) => row
  const verdicts = new Map<string, Promise<boolean>>()
  const hidden = (sessionId: string | null | undefined): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false)
    let verdict = verdicts.get(sessionId)
    if (!verdict) {
      verdict = check(sessionId).then((session) => session === "hidden")
      verdicts.set(sessionId, verdict)
    }
    return verdict
  }
  return async (row) => {
    const [branch, parent, lead] = await Promise.all([
      hidden(row.branchedFrom?.sessionId),
      hidden(row.parentSessionId),
      hidden(row.teamLeadSessionId),
    ])
    return {
      ...row,
      ...(branch && { branchedFrom: undefined }),
      ...(parent && { parentSessionId: null }),
      ...(lead && { teamLeadSessionId: undefined }),
    }
  }
}
