import { useState, useCallback, startTransition, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"
import type { SessionTeamContext } from "./useSessionTeam"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "./useLiveSession"
import type { TeamMember } from "@/lib/team-types"
import type { MobileTab } from "@/components/MobileNav"
import { authFetch } from "@/lib/auth"
import { cacheTurnCount } from "@/lib/turnCountCache"
import { loadSessionTailCached } from "@/lib/sessionLoader"

interface UseSessionActionsOpts {
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  mobileTab?: MobileTab
  teamContext: SessionTeamContext | null
  scrollToBottomInstant: () => void
  resetTurnCount: (count: number) => void
  workerParse: (text: string) => Promise<ParsedSession>
  /** Called before fetching a new session to free connections held by the
   *  current session (e.g. long-lived send-message POST, session creation). */
  onBeforeSwitch?: () => void
}

export function useSessionActions({
  dispatch,
  isMobile,
  mobileTab = "sessions",
  teamContext,
  scrollToBottomInstant,
  resetTurnCount,
  workerParse,
  onBeforeSwitch,
}: UseSessionActionsOpts) {
  const [loadError, setLoadError] = useState<string | null>(null)

  const handleLoadSession = useCallback(
    (parsed: ParsedSession, source: SessionSource) => {
      setLoadError(null)
      // Wrap the heavy re-render (new session timeline, virtualizer re-measure,
      // undo graph rebuild) in a transition so React can keep interaction input
      // responsive — the user's click has just landed, and the view flipping a
      // frame later feels instantaneous compared to a synchronous commit that
      // blocks for 100+ ms on large sessions.
      startTransition(() => {
        dispatch({ type: "LOAD_SESSION", session: parsed, source, isMobile })
      })
      resetTurnCount(parsed.turns.length)
      cacheTurnCount(parsed.sessionId, parsed.turns.length)
      scrollToBottomInstant()
    },
    [dispatch, isMobile, resetTurnCount, scrollToBottomInstant]
  )

  const handleDashboardSelect = useCallback(
    async (dirName: string, fileName: string) => {
      onBeforeSwitch?.()
      setLoadError(null)
      try {
        const { parsed, source } = await loadSessionTailCached(
          dirName,
          fileName,
          workerParse,
          "session",
        )
        handleLoadSession(parsed, source)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load session")
      }
    },
    [handleLoadSession, workerParse, onBeforeSwitch]
  )

  const handleTeamMemberSwitch = useCallback(
    async (member: TeamMember) => {
      if (!teamContext) return
      onBeforeSwitch?.()
      setLoadError(null)
      dispatch({ type: "SET_LOADING_MEMBER", name: member.name })
      try {
        const lookupRes = await authFetch(
          `/api/team-member-session/${encodeURIComponent(teamContext.teamName)}/${encodeURIComponent(member.name)}`
        )
        if (!lookupRes.ok) throw new Error(`Failed to find session for ${member.name}`)
        const { dirName, fileName } = await lookupRes.json()

        const { parsed, source } = await loadSessionTailCached(
          dirName,
          fileName,
          workerParse,
          `session for ${member.name}`,
        )

        startTransition(() => {
          dispatch({
            type: "SWITCH_TEAM_MEMBER",
            session: parsed,
            source,
            memberName: member.name,
          })
        })
        resetTurnCount(parsed.turns.length)
        scrollToBottomInstant()
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to switch team member")
      } finally {
        dispatch({ type: "SET_LOADING_MEMBER", name: null })
      }
    },
    [dispatch, teamContext, resetTurnCount, scrollToBottomInstant, workerParse, onBeforeSwitch]
  )

  const clearLoadError = useCallback(() => setLoadError(null), [])

  const handleGoHome = useCallback(() => {
    startTransition(() => {
      dispatch({ type: "GO_HOME", isMobile })
    })
  }, [dispatch, isMobile])

  const handleJumpToTurn = useCallback(
    (index: number, toolCallId?: string) => {
      dispatch({ type: "JUMP_TO_TURN", index, toolCallId })
    },
    [dispatch]
  )

  const handleMobileTabChange = useCallback(
    (tab: MobileTab) => {
      if (tab === mobileTab) return
      startTransition(() => {
        dispatch({ type: "SET_MOBILE_TAB", tab })
      })
    },
    [dispatch, mobileTab]
  )

  return {
    loadError,
    clearLoadError,
    handleLoadSession,
    handleDashboardSelect,
    handleTeamMemberSwitch,
    handleGoHome,
    handleJumpToTurn,
    handleMobileTabChange,
  }
}
