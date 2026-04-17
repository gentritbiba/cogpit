import { useState, useCallback, startTransition, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"
import type { SessionTeamContext } from "./useSessionTeam"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "./useLiveSession"
import type { TeamMember } from "@/lib/team-types"
import type { MobileTab } from "@/components/MobileNav"
import { authFetch } from "@/lib/auth"
import { cacheTurnCount } from "@/lib/turnCountCache"
import { agentKindFromDirName } from "@/lib/sessionSource"
import { sessionCache } from "@/lib/sessionCache"

interface TailResponse {
  headerLines: string[]
  tailLines: string[]
  byteOffset: number
  totalSize: number
  hasMore: boolean
}

interface UseSessionActionsOpts {
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  teamContext: SessionTeamContext | null
  scrollToBottomInstant: () => void
  resetTurnCount: (count: number) => void
  workerParse: (text: string) => Promise<ParsedSession>
  /** Called before fetching a new session to free connections held by the
   *  current session (e.g. long-lived send-message POST, session creation). */
  onBeforeSwitch?: () => void
}

/** Fetch the tail of a session file and parse it via worker. Uses the ?tail=30 endpoint. */
async function fetchTailAndParse(
  dirName: string,
  fileName: string,
  workerParse: (text: string) => Promise<ParsedSession>,
  errorLabel: string,
): Promise<{
  parsed: ParsedSession
  source: SessionSource
  byteOffset: number
  hasMore: boolean
}> {
  const res = await authFetch(
    `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?tail=30`
  )
  if (!res.ok) throw new Error(`Failed to load ${errorLabel} (${res.status})`)
  const data: TailResponse = await res.json()

  // Combine header + tail lines, deduplicating overlap for small files
  const headerSet = new Set(data.headerLines)
  const uniqueTail = data.tailLines.filter((l) => !headerSet.has(l))
  const text = [...data.headerLines, ...uniqueTail].join("\n")

  const parsed = await workerParse(text)

  return {
    parsed,
    source: { dirName, fileName, rawText: text, agentKind: agentKindFromDirName(dirName) },
    byteOffset: data.byteOffset,
    hasMore: data.hasMore,
  }
}

/**
 * Resolve a session via the cache or the tail endpoint and populate the cache.
 * Use this for every load path (dashboard, team, team-member) so switches are
 * always bottom-first and cached — the biggest win for session-switch latency.
 */
async function loadSessionTailCached(
  dirName: string,
  fileName: string,
  workerParse: (text: string) => Promise<ParsedSession>,
  errorLabel: string,
): Promise<{ parsed: ParsedSession; source: SessionSource }> {
  const cached = sessionCache.get(dirName, fileName)
  if (cached) {
    return { parsed: cached.parsed, source: cached.source }
  }
  const { parsed, source, byteOffset, hasMore } = await fetchTailAndParse(
    dirName,
    fileName,
    workerParse,
    errorLabel,
  )
  sessionCache.set(
    dirName,
    fileName,
    parsed,
    source.rawText,
    byteOffset,
    hasMore,
    agentKindFromDirName(dirName),
  )
  return { parsed, source }
}

export function useSessionActions({
  dispatch,
  isMobile,
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

  const handleOpenSessionFromTeam = useCallback(
    async (dirName: string, fileName: string, memberName?: string) => {
      onBeforeSwitch?.()
      setLoadError(null)
      try {
        const { parsed, source } = await loadSessionTailCached(
          dirName,
          fileName,
          workerParse,
          "team session",
        )
        startTransition(() => {
          dispatch({
            type: "LOAD_SESSION_FROM_TEAM",
            session: parsed,
            source,
            memberName,
            isMobile,
          })
        })
        resetTurnCount(parsed.turns.length)
        scrollToBottomInstant()
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load team session")
      }
    },
    [dispatch, isMobile, resetTurnCount, scrollToBottomInstant, workerParse, onBeforeSwitch]
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
