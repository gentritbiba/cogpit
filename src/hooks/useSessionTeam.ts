import { useState, useEffect } from "react"
import type { TeamConfig } from "@/lib/team-types"

export interface SessionTeamContext {
  teamName: string
  config: TeamConfig
  currentMemberName: string | null
}

/**
 * Detects if the current session belongs to a team.
 * Extracts leadSessionId from the fileName (handles both lead and subagent paths)
 * and queries the server for team membership.
 */
export function useSessionTeam(
  sessionFileName: string | null
): SessionTeamContext | null {
  const [ctx, setCtx] = useState<SessionTeamContext | null>(null)

  useEffect(() => {
    if (!sessionFileName) {
      setCtx(null)
      return
    }

    // Extract leadSessionId and optional subagent file from path
    // Patterns:
    //   "uuid.jsonl"                        → lead session
    //   "uuid/subagents/agent-xxx.jsonl"    → subagent session
    let leadSessionId: string
    let subagentFile: string | null = null

    const subMatch = sessionFileName.match(/^([^/]+)\/subagents\/(.+)$/)
    if (subMatch) {
      leadSessionId = subMatch[1]
      subagentFile = subMatch[2]
    } else {
      leadSessionId = sessionFileName.replace(".jsonl", "")
    }

    const params = new URLSearchParams({ leadSessionId })
    if (subagentFile) params.set("subagentFile", subagentFile)

    fetch(`/api/session-team?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setCtx({
            teamName: data.teamName,
            config: data.config,
            currentMemberName: data.currentMemberName || null,
          })
        } else {
          setCtx(null)
        }
      })
      .catch(() => setCtx(null))
  }, [sessionFileName])

  return ctx
}
