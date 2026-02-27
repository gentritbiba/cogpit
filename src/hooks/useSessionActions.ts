import { useState, useCallback, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"
import type { SessionTeamContext } from "./useSessionTeam"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "./useLiveSession"
import type { TeamMember } from "@/lib/team-types"
import type { MobileTab } from "@/components/MobileNav"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"

interface UseSessionActionsOpts {
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  teamContext: SessionTeamContext | null
  scrollToBottomInstant: () => void
  resetTurnCount: (count: number) => void
}

/** Fetch a session file and parse it. The `errorLabel` is used in the error message on failure. */
async function fetchAndParse(
  dirName: string,
  fileName: string,
  errorLabel: string,
): Promise<{ parsed: ParsedSession; source: SessionSource }> {
  const res = await authFetch(
    `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
  )
  if (!res.ok) throw new Error(`Failed to load ${errorLabel} (${res.status})`)
  const text = await res.text()
  return { parsed: parseSession(text), source: { dirName, fileName, rawText: text } }
}

export function useSessionActions({
  dispatch,
  isMobile,
  teamContext,
  scrollToBottomInstant,
  resetTurnCount,
}: UseSessionActionsOpts) {
  const [loadError, setLoadError] = useState<string | null>(null)

  const handleLoadSession = useCallback(
    (parsed: ParsedSession, source: SessionSource) => {
      setLoadError(null)
      dispatch({ type: "LOAD_SESSION", session: parsed, source, isMobile })
      resetTurnCount(parsed.turns.length)
      scrollToBottomInstant()
    },
    [dispatch, isMobile, resetTurnCount, scrollToBottomInstant]
  )

  const handleDashboardSelect = useCallback(
    async (dirName: string, fileName: string) => {
      setLoadError(null)
      try {
        const { parsed, source } = await fetchAndParse(dirName, fileName, "session")
        handleLoadSession(parsed, source)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load session")
      }
    },
    [handleLoadSession]
  )

  const handleOpenSessionFromTeam = useCallback(
    async (dirName: string, fileName: string, memberName?: string) => {
      setLoadError(null)
      try {
        const { parsed, source } = await fetchAndParse(dirName, fileName, "team session")
        dispatch({
          type: "LOAD_SESSION_FROM_TEAM",
          session: parsed,
          source,
          memberName,
          isMobile,
        })
        resetTurnCount(parsed.turns.length)
        scrollToBottomInstant()
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load team session")
      }
    },
    [dispatch, isMobile, resetTurnCount, scrollToBottomInstant]
  )

  const handleTeamMemberSwitch = useCallback(
    async (member: TeamMember) => {
      if (!teamContext) return
      setLoadError(null)
      dispatch({ type: "SET_LOADING_MEMBER", name: member.name })
      try {
        const lookupRes = await authFetch(
          `/api/team-member-session/${encodeURIComponent(teamContext.teamName)}/${encodeURIComponent(member.name)}`
        )
        if (!lookupRes.ok) throw new Error(`Failed to find session for ${member.name}`)
        const { dirName, fileName } = await lookupRes.json()

        const contentRes = await authFetch(
          `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
        )
        if (!contentRes.ok) throw new Error(`Failed to load session for ${member.name}`)
        const text = await contentRes.text()
        const parsed = parseSession(text)

        dispatch({ type: "SWITCH_TEAM_MEMBER", session: parsed, source: { dirName, fileName, rawText: text }, memberName: member.name })
        resetTurnCount(parsed.turns.length)
        scrollToBottomInstant()
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to switch team member")
      } finally {
        dispatch({ type: "SET_LOADING_MEMBER", name: null })
      }
    },
    [dispatch, teamContext, resetTurnCount, scrollToBottomInstant]
  )

  const clearLoadError = useCallback(() => setLoadError(null), [])

  const handleSelectTeam = useCallback(
    (teamName: string) => {
      dispatch({ type: "SELECT_TEAM", teamName, isMobile })
    },
    [dispatch, isMobile]
  )

  const handleBackFromTeam = useCallback(() => {
    dispatch({ type: "BACK_FROM_TEAM", isMobile })
  }, [dispatch, isMobile])

  const handleOpenTeamFromBar = useCallback(() => {
    if (!teamContext) return
    dispatch({ type: "SELECT_TEAM", teamName: teamContext.teamName, isMobile })
  }, [dispatch, teamContext, isMobile])

  const handleGoHome = useCallback(() => {
    dispatch({ type: "GO_HOME", isMobile })
  }, [dispatch, isMobile])

  const handleJumpToTurn = useCallback(
    (index: number, toolCallId?: string) => {
      dispatch({ type: "JUMP_TO_TURN", index, toolCallId })
    },
    [dispatch]
  )

  const handleMobileTabChange = useCallback(
    (tab: MobileTab) => {
      dispatch({ type: "SET_MOBILE_TAB", tab })
    },
    [dispatch]
  )

  return {
    loadError,
    clearLoadError,
    handleLoadSession,
    handleDashboardSelect,
    handleOpenSessionFromTeam,
    handleTeamMemberSwitch,
    handleSelectTeam,
    handleBackFromTeam,
    handleOpenTeamFromBar,
    handleGoHome,
    handleJumpToTurn,
    handleMobileTabChange,
  }
}
