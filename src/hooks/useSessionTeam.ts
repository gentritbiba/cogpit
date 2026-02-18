import { useState, useEffect, useCallback, useRef } from "react"
import { useTeamLive } from "./useTeamLive"
import { authFetch } from "@/lib/auth"
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
 * Subscribes to live updates so the members bar refreshes automatically.
 */
export function useSessionTeam(
  sessionFileName: string | null
): SessionTeamContext | null {
  const [ctx, setCtx] = useState<SessionTeamContext | null>(null)
  const paramsRef = useRef<string | null>(null)

  // Build stable query params from sessionFileName
  const queryParams = (() => {
    if (!sessionFileName) return null
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
    return params.toString()
  })()

  paramsRef.current = queryParams

  const fetchTeam = useCallback(async () => {
    const params = paramsRef.current
    if (!params) return

    try {
      const res = await authFetch(`/api/session-team?${params}`)
      if (!res.ok) {
        setCtx(null)
        return
      }
      const data = await res.json()
      if (data) {
        setCtx({
          teamName: data.teamName,
          config: data.config,
          currentMemberName: data.currentMemberName || null,
        })
      } else {
        setCtx(null)
      }
    } catch {
      setCtx(null)
    }
  }, [])

  // Initial fetch when sessionFileName changes
  useEffect(() => {
    if (!sessionFileName) {
      setCtx(null)
      return
    }
    fetchTeam()
  }, [sessionFileName, fetchTeam])

  // Subscribe to live team updates so the bar refreshes automatically
  useTeamLive(ctx?.teamName ?? null, fetchTeam)

  return ctx
}
