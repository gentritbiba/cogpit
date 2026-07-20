import { useEffect, useRef, useCallback, type Dispatch } from "react"
import type { SessionState, SessionAction } from "./useSessionState"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"
import { getActiveDeviceId, LOCAL_DEVICE_ID, saveLastPath } from "@/lib/device"

interface UseUrlSyncOpts {
  state: SessionState
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  resetTurnCount: (count: number) => void
  scrollToBottomInstant: () => void
}

// ── URL scheme ──────────────────────────────────────────────────────────────
//   /                          → home (projects list)
//   /{dirName}                 → project sessions list
//   /{dirName}/{sessionId}     → viewing a specific session
//   /team/{teamName}           → team view
//
// A remote device carries a leading "/d/:deviceId" segment in front of any of
// the above (e.g. "/d/dev_x/-Users-foo/sess"). Device identity itself is owned
// by DeviceRoot; this hook simply strips the prefix before parsing and prepends
// it when emitting. Unprefixed paths always mean the local device. "d" can never
// collide with a real dirName (claude dirNames start with "-", codex with
// "codex__").

interface ParsedUrl {
  type: "home" | "session" | "project" | "team"
  dirName?: string
  /** sessionId (UUID) — we append .jsonl to get the fileName for the API */
  sessionId?: string
  teamName?: string
}

/** "" for the local device, "/d/<id>" for a remote device. */
function devicePathPrefix(): string {
  const id = getActiveDeviceId()
  return id === LOCAL_DEVICE_ID ? "" : `/d/${id}`
}

/** The home path for the active device: "/" local, "/d/<id>/" remote. */
function deviceHomePath(): string {
  const prefix = devicePathPrefix()
  return prefix ? `${prefix}/` : "/"
}

/**
 * Strip a leading "/d/<id>" device segment, returning the remainder for the
 * existing scheme to parse. Non-prefixed paths pass through unchanged.
 */
function stripDevicePrefix(pathname: string): string {
  const match = /^\/d\/[^/]+(\/.*)?$/.exec(pathname)
  return match ? match[1] || "/" : pathname
}

function sessionIdFromFileName(fileName: string): string {
  // "abc123.jsonl" → "abc123"
  // "abc123/subagents/xyz.jsonl" → keep as-is for nested paths
  return fileName.replace(/\.jsonl$/, "")
}

function fileNameFromSessionId(sessionId: string): string {
  return sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`
}

function stateToPath(state: SessionState): string {
  const prefix = devicePathPrefix()
  if (state.mainView === "teams" && state.selectedTeam) {
    return `${prefix}/team/${encodeURIComponent(state.selectedTeam)}`
  }
  if (state.sessionSource) {
    const { dirName, fileName } = state.sessionSource
    const sessionId = sessionIdFromFileName(fileName)
    return `${prefix}/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}`
  }
  if (state.pendingDirName) {
    return `${prefix}/${encodeURIComponent(state.pendingDirName)}`
  }
  if (state.dashboardProject) {
    return `${prefix}/${encodeURIComponent(state.dashboardProject)}`
  }
  return deviceHomePath()
}

function parsePath(rawPathname: string): ParsedUrl {
  // Device identity is owned by DeviceRoot — parse the remainder of the path.
  const pathname = stripDevicePrefix(rawPathname)

  // Team routes are prefixed to avoid ambiguity
  const teamMatch = pathname.match(/^\/team\/([^/]+)$/)
  if (teamMatch) {
    return {
      type: "team",
      teamName: decodeURIComponent(teamMatch[1]),
    }
  }

  // Split remaining path segments (skip empty leading segment)
  const segments = pathname.split("/").filter(Boolean)

  if (segments.length >= 2) {
    // /{dirName}/{sessionId}
    return {
      type: "session",
      dirName: decodeURIComponent(segments[0]),
      sessionId: decodeURIComponent(segments[1]),
    }
  }

  if (segments.length === 1) {
    // /{dirName}
    return {
      type: "project",
      dirName: decodeURIComponent(segments[0]),
    }
  }

  return { type: "home" }
}

export function useUrlSync({
  state,
  dispatch,
  isMobile,
  resetTurnCount,
  scrollToBottomInstant,
}: UseUrlSyncOpts) {
  const skipNextPushRef = useRef(false)
  const lastPushedRef = useRef(window.location.pathname)
  const initialLoadDone = useRef(false)

  const loadFromUrl = useCallback(
    async (parsed: ParsedUrl) => {
      skipNextPushRef.current = true
      try {
        if (parsed.type === "session" && parsed.dirName && parsed.sessionId) {
          const fileName = fileNameFromSessionId(parsed.sessionId)
          const res = await authFetch(
            `/api/sessions/${encodeURIComponent(parsed.dirName)}/${encodeURIComponent(fileName)}`
          )
          if (!res.ok) {
            dispatch({ type: "GO_HOME", isMobile })
            const home = deviceHomePath()
            window.history.replaceState(null, "", home)
            lastPushedRef.current = home
            saveLastPath(getActiveDeviceId(), home)
            return
          }
          const text = await res.text()
          const session = parseSession(text)
          dispatch({
            type: "LOAD_SESSION",
            session,
            source: { dirName: parsed.dirName, fileName, rawText: text },
            isMobile,
          })
          resetTurnCount(session.turns.length)
          scrollToBottomInstant()
        } else if (parsed.type === "project" && parsed.dirName) {
          dispatch({ type: "SET_DASHBOARD_PROJECT", dirName: parsed.dirName })
        } else if (parsed.type === "team" && parsed.teamName) {
          dispatch({ type: "SELECT_TEAM", teamName: parsed.teamName, isMobile })
        } else {
          dispatch({ type: "GO_HOME", isMobile })
        }
      } finally {
        skipNextPushRef.current = false
      }
    },
    [dispatch, isMobile, resetTurnCount, scrollToBottomInstant]
  )

  // On mount: if URL has a path, load the corresponding session/team
  useEffect(() => {
    if (initialLoadDone.current) return
    initialLoadDone.current = true

    // Remember the entry path so switching away and back restores it (incl.
    // deep links, whose URL never changes and so would otherwise never save).
    saveLastPath(getActiveDeviceId(), window.location.pathname)

    const parsed = parsePath(window.location.pathname)
    if (parsed.type !== "home") {
      loadFromUrl(parsed)
    }
  }, [loadFromUrl])

  // Sync state changes → URL (pushState)
  useEffect(() => {
    if (skipNextPushRef.current) return

    const newPath = stateToPath(state)
    if (newPath !== lastPushedRef.current) {
      window.history.pushState(null, "", newPath)
      lastPushedRef.current = newPath
      saveLastPath(getActiveDeviceId(), newPath)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync URL-relevant state fields
  }, [state.sessionSource, state.pendingDirName, state.mainView, state.selectedTeam, state.dashboardProject])

  // Handle browser back/forward
  useEffect(() => {
    const handlePopstate = () => {
      const parsed = parsePath(window.location.pathname)
      lastPushedRef.current = window.location.pathname
      saveLastPath(getActiveDeviceId(), window.location.pathname)
      loadFromUrl(parsed)
    }

    window.addEventListener("popstate", handlePopstate)
    return () => window.removeEventListener("popstate", handlePopstate)
  }, [loadFromUrl])
}
