import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { AppProvider, type AppContextValue } from "@/contexts/AppContext"
import { OpenSessionProvider, type SessionControls } from "@/contexts/SessionContext"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useLiveSession } from "@/hooks/useLiveSession"
import { useParserWorker } from "@/hooks/useParserWorker"
import { useSessionPaging } from "@/hooks/useSessionPaging"
import { useSessionSelector, useSessionState } from "@/hooks/useSessionState"
import { useSessionController } from "@/hooks/useSessionController"
import { useShareChat } from "@/hooks/useShareChat"
import { useSharePermissions } from "@/hooks/useSharePermissions"
import { useTheme } from "@/hooks/useTheme"
import { useUndoRedo } from "@/hooks/useUndoRedo"
import { setMe } from "@/lib/capabilities"
import { detectPendingInteraction } from "../../shared/session/parser"
import { agentKindForDirName } from "@/lib/agents"
import { stopShare, type SharedSessionInfo } from "@/lib/shareApi"
import { permissionsForAccess } from "@/lib/sessionAccessPermissions"
import { samePendingInteraction } from "@/lib/sessionFacts"
import type { Turn } from "../../shared/session/types"
import type { SessionView } from "../../shared/session/sessionDigest"
import { NO_CAPABILITIES, type MeResponse } from "../../shared/contracts/identity"

/**
 * The three contexts the transcript and the composer read, backed by only what
 * a guest is allowed to fetch.
 *
 * Everything under `ChatArea` and `ChatInput` reads `AppContext`,
 * `SessionContext` and `SessionChatContext` and nothing else — no session
 * inventory, no pending-human-input poll, both of which hit endpoints a guest
 * is denied. So the adapter is these three values and no widening anywhere.
 *
 * Within them the guest subtree reads `state`, `dispatch` and `isMobile` from
 * the app context; the rest of that shape exists to satisfy the type and is
 * filled with what is actually true of a guest: no config, no host paths, no
 * undo history.
 */

/** A guest is authenticated, and authorized for nothing outside this session. */
const GUEST_ME: MeResponse = {
  authenticated: true,
  edition: "personal",
  user: null,
  capabilities: NO_CAPABILITIES,
}

export type ShareLoadState = "loading" | "ready" | "failed"

/** What the guest shell needs from the adapter that is not in a context. */
export interface ShareViewState {
  loadState: ShareLoadState
  hasMore: boolean
  isLoadingOlder: boolean
  loadMore: () => void
}

interface ShareScopedProvidersProps {
  info: SharedSessionInfo
  children: (view: ShareViewState) => ReactNode
}

export function ShareScopedProviders({ info, children }: ShareScopedProvidersProps) {
  const isMobile = useIsMobile()
  const theme = useTheme()
  const [state, dispatchState, sessionStore] = useSessionState()
  const { parse: workerParse, parsePage, append: workerAppend } = useParserWorker()
  const { sessions, dispatch } = useSessionController(dispatchState, workerParse)
  const [loadState, setLoadState] = useState<ShareLoadState>("loading")

  // Host affordances read this module cell directly (useCapability), not the
  // context — so a guest that never announces itself would render an @-mention
  // file picker and a terminal button pointed at endpoints it cannot reach.
  useEffect(() => {
    setMe(GUEST_ME)
  }, [])

  const chat = useShareChat()
  const permissions = useSharePermissions()

  const loadSession = useCallback(async () => {
    try {
      await sessions.openSession({ dirName: info.dirName, fileName: info.fileName }, {
        reason: "share",
        commit: ({ parsed, source }) => {
          dispatch({ type: "LOAD_SESSION", session: parsed, source, isMobile })
          setLoadState("ready")
        },
      })
    } catch {
      setLoadState("failed")
    }
  }, [dispatch, info.dirName, info.fileName, isMobile, sessions])

  // Once, for the life of the shell. A guest has exactly one session, so the
  // only thing that could re-trigger this is an incidental dependency change
  // (a viewport crossing the mobile breakpoint), which must not refetch.
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    void loadSession()
  }, [loadSession])

  const handleLiveUpdate = useCallback((session: SessionView, loadId: number) => {
    dispatch({ type: "UPDATE_SESSION", session, loadId })
  }, [dispatch])

  const getSession = useCallback(() => sessionStore.getState().session, [sessionStore])
  const { isLive, sseState, isCompacting, sessionShown, turnError } = useLiveSession(
    state.sessionSource,
    handleLiveUpdate,
    workerParse,
    workerAppend,
    sessions.reloadCurrent,
    getSession,
  )

  const handleOlderTurns = useCallback((turns: Turn[]) => {
    dispatch({ type: "SET_OLDER_TURNS", turns })
  }, [dispatch])

  const paging = useSessionPaging({
    dirName: state.sessionSource?.dirName ?? null,
    fileName: state.sessionSource?.fileName ?? null,
    sessionChangeKey: state.sessionChangeKey,
    workerParse: parsePage,
    onOlderTurns: handleOlderTurns,
  })

  // Disabled, not stubbed: rewinding a transcript writes to the host filesystem
  // and is not on the guest's allowlist. Passing `false` keeps the real hook's
  // shape without it ever reaching `/api/undo-state`.
  const undoRedo = useUndoRedo(sessionStore, state.sessionSource, loadSession, false)

  const pendingInteraction = useSessionSelector(
    sessionStore,
    (open) => open ? detectPendingInteraction(open) : null,
    samePendingInteraction,
  )

  const handleToggleExpandAll = useCallback(() => {
    dispatch({ type: "TOGGLE_EXPAND_ALL" })
  }, [dispatch])

  const handleStopSession = useCallback(async () => {
    await stopShare().catch(() => {})
  }, [])

  const noop = useCallback(() => {}, [])

  const appValue = useMemo<AppContextValue>(() => ({
    state,
    dispatch,
    config: {
      configLoading: false,
      configError: null,
      claudeDir: null,
      defaultAgentKind: agentKindForDirName(info.dirName),
      freshInstall: false,
      showConfigDialog: false,
      openConfigDialog: noop,
      handleCloseConfigDialog: noop,
      handleConfigSaved: noop,
      retryConfig: noop,
      networkUrl: null,
      networkAccessDisabled: false,
    },
    theme,
    isMobile,
  }), [state, dispatch, theme, isMobile, info.dirName, noop])

  const sessionControls = useMemo<SessionControls>(() => ({
    sessionSource: state.sessionSource,
    isLive,
    sseState,
    isCompacting,
    turnError,
    undoRedo,
    pendingInteraction,
    permissionRequests: permissions.requests,
    permissionResponding: permissions.responding,
    respondPermission: permissions.respond,
    respondAllPermissions: permissions.respondAll,
    isSubAgentView: false,
    // A guest drives the session but owns nothing, so it cannot archive or delete it.
    permissions: permissionsForAccess("interact"),
    // A guest has no project on disk, so there are no commands or skills to
    // suggest — `/api/slash-suggestions` reads the host's config directories.
    slashSuggestions: [],
    slashSuggestionsLoading: false,
    // Suggestions are offered next to the composer, and a guest has none.
    promptSuggestion: null,
    // A share is read-only and the allowance belongs to the host's account, so
    // there is nothing here a guest could act on.
    rateLimit: null,
    actions: {
      handleStopSession,
      handleOpenBranches: noop,
      handleBranchFromHere: noop,
      handleToggleExpandAll,
      handleLoadSession: noop,
    },
  }), [
    state.sessionSource, isLive, sseState, isCompacting, turnError,
    undoRedo, pendingInteraction, permissions.requests, permissions.responding,
    permissions.respond, permissions.respondAll, handleStopSession,
    handleToggleExpandAll, noop,
  ])

  const view = useMemo<ShareViewState>(() => ({
    loadState,
    hasMore: paging.hasMore,
    isLoadingOlder: paging.isLoadingOlder,
    loadMore: () => { void paging.loadMore() },
  }), [loadState, paging])

  return (
    <AppProvider value={appValue}>
      <OpenSessionProvider
        store={sessionStore}
        controls={sessionControls}
        chat={chat}
        isLive={isLive}
        onSessionShown={sessionShown}
      >
        {children(view)}
      </OpenSessionProvider>
    </AppProvider>
  )
}
