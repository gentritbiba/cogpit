import { useState, useCallback, useRef, startTransition, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"
import type { SessionTeamContext } from "./useSessionTeam"
import type { TeamMember } from "@/lib/team-types"
import type { MobileTab } from "@/hooks/useSessionState"
import { authFetch } from "@/lib/auth"
import { cacheTurnCount } from "@/lib/turnCountCache"
import type { LoadedSession, SessionController } from "@/lib/sessionLoader"

interface UseSessionActionsOpts {
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  mobileTab?: MobileTab
  teamContext: SessionTeamContext | null
  scrollToBottomInstant: () => void
  resetTurnCount: (count: number) => void
  sessions: SessionController
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
  sessions,
  onBeforeSwitch,
}: UseSessionActionsOpts) {
  const [loadError, setLoadError] = useState<string | null>(null)
  // The team switch whose loading indicator is up; an older one that lost
  // to it must not take that indicator down.
  const memberSwitchRef = useRef(0)

  const showSession = useCallback(
    ({ parsed, source }: LoadedSession) => {
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
        await sessions.openSession({ dirName, fileName }, { reason: "click", commit: showSession })
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load session")
      }
    },
    [sessions, showSession, onBeforeSwitch]
  )

  const handleTeamMemberSwitch = useCallback(
    async (member: TeamMember) => {
      if (!teamContext) return
      onBeforeSwitch?.()
      setLoadError(null)
      const switchId = ++memberSwitchRef.current
      dispatch({ type: "SET_LOADING_MEMBER", name: member.name })
      try {
        await sessions.openSession(
          async (signal) => {
            const lookupRes = await authFetch(
              `/api/team-member-session/${encodeURIComponent(teamContext.teamName)}/${encodeURIComponent(member.name)}`,
              { signal },
            )
            if (!lookupRes.ok) throw new Error(`Failed to find session for ${member.name}`)
            const { dirName, fileName } = await lookupRes.json()
            return { dirName, fileName }
          },
          {
            reason: "team",
            commit: ({ parsed, source }) => {
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
            },
          },
        )
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to switch team member")
      } finally {
        if (memberSwitchRef.current === switchId) dispatch({ type: "SET_LOADING_MEMBER", name: null })
      }
    },
    [dispatch, teamContext, resetTurnCount, scrollToBottomInstant, sessions, onBeforeSwitch]
  )

  const clearLoadError = useCallback(() => setLoadError(null), [])

  const handleGoHome = useCallback(() => {
    startTransition(() => {
      dispatch({ type: "GO_HOME", isMobile })
    })
  }, [dispatch, isMobile])

  const handleCloseSession = useCallback(() => {
    startTransition(() => {
      dispatch({ type: "CLOSE_SESSION", isMobile })
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
      dispatch({ type: "SET_MOBILE_TAB", tab })
    },
    [dispatch, mobileTab]
  )

  return {
    loadError,
    clearLoadError,
    handleDashboardSelect,
    handleTeamMemberSwitch,
    handleGoHome,
    handleCloseSession,
    handleJumpToTurn,
    handleMobileTabChange,
  }
}
