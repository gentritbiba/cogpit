import { useState, useEffect, useCallback, useRef } from "react"
import { useTeamLive } from "./useTeamLive"
import { authFetch } from "@/lib/auth"
import { jsonEqual } from "@/lib/jsonEqual"
import type { TeamConfig } from "@/lib/team-types"

export interface SessionTeamContext {
  teamName: string
  config: TeamConfig
  currentMemberName: string | null
}

/**
 * Detects if the current session belongs to a team.
 * Extracts leadSessionId from the fileName (handles both lead and subagent paths)
 * and queries the server for team membership. The server also detects the
 * reverse case where the session is itself a teammate's own top-level session
 * (new agent-team format) — dirName lets it read that file directly.
 * Subscribes to live updates so the members bar refreshes automatically.
 */
export function useSessionTeam(
  sessionFileName: string | null,
  sessionDirName?: string | null
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
    if (sessionDirName) params.set("dirName", sessionDirName)
    return params.toString()
  })()

  paramsRef.current = queryParams

  const fetchTeam = useCallback(async () => {
    const params = paramsRef.current
    if (!params) return

    let next: SessionTeamContext | null = null
    try {
      const res = await authFetch(`/api/session-team?${params}`)
      const data = res.ok ? await res.json() : null
      if (data) {
        next = {
          teamName: data.teamName,
          config: data.config,
          currentMemberName: data.currentMemberName || null,
        }
      }
    } catch {
      next = null
    }
    // The session changed while this answer was in flight
    if (paramsRef.current !== params) return
    // Team updates arrive on every inbox and task write; an unchanged answer keeps its identity
    setCtx((prev) => (prev && next && jsonEqual(prev, next) ? prev : next))
  }, [])

  // Initial fetch when sessionFileName changes
  useEffect(() => {
    if (!sessionFileName) {
      setCtx(null)
      return
    }
    fetchTeam()
  }, [sessionFileName, fetchTeam])

  const closeTeam = useCallback(() => setCtx(null), [])

  // Subscribe to live team updates so the bar refreshes automatically, and
  // close it once the team is out of the caller's reach.
  useTeamLive(ctx?.teamName ?? null, fetchTeam, closeTeam)

  return ctx
}
