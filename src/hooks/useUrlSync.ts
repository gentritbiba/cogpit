import { useEffect, useRef, useCallback, useState, type Dispatch } from "react"
import type { SessionState, SessionAction } from "./useSessionState"
import type { ParsedSession } from "@/lib/types"
import { loadSessionTailCached } from "@/lib/sessionLoader"
import { getActiveDeviceId, LOCAL_DEVICE_ID, saveLastPath } from "@/lib/device"
import { authFetch } from "@/lib/auth"
import { previewSessionIdFromPath } from "@/lib/previewMode"
import { isCopilotDirName, sessionUrlIdFromFileName } from "@/lib/sessionSource"

interface UseUrlSyncOpts {
  state: SessionState
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  resetTurnCount: (count: number) => void
  scrollToBottomInstant: () => void
  /** Off-main-thread session parser from App's `useParserWorker`. */
  workerParse: (text: string) => Promise<ParsedSession>
}

// ── URL scheme ──────────────────────────────────────────────────────────────
//   /                          → home (projects list)
//   /{dirName}                 → project sessions list
//   /{dirName}/{sessionId}     → viewing a specific session
//   /preview/{sessionId}       → local session-only preview
//
// A remote device carries a leading "/d/:deviceId" segment in front of any of
// the above (e.g. "/d/dev_x/-Users-foo/sess"). Device identity itself is owned
// by DeviceRoot; this hook simply strips the prefix before parsing and prepends
// it when emitting. Unprefixed paths always mean the local device. "d" can never
// collide with a real dirName (claude dirNames start with "-", codex with
// "codex__").

interface ParsedUrl {
  type: "home" | "session" | "project" | "preview"
  dirName?: string
  /** sessionId (UUID) — we append .jsonl to get the fileName for the API */
  sessionId?: string
  normalizeHome?: boolean
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

function fileNameFromSessionId(dirName: string, sessionId: string): string {
  if (isCopilotDirName(dirName)) return `${sessionId}/events.jsonl`
  return sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`
}

function stateToPath(state: SessionState): string {
  const prefix = devicePathPrefix()
  if (state.sessionSource) {
    const { dirName, fileName } = state.sessionSource
    const sessionId = sessionUrlIdFromFileName(dirName, fileName)
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

  const previewSessionId = previewSessionIdFromPath(pathname)
  if (previewSessionId) {
    return { type: "preview", sessionId: previewSessionId }
  }

  if (pathname.startsWith("/team/")) {
    return { type: "home", normalizeHome: true }
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
  workerParse,
}: UseUrlSyncOpts) {
  const [previewLoadError, setPreviewLoadError] = useState<string | null>(null)
  // Depth counter, not a boolean: two overlapping loads (e.g. a notification
  // click landing mid-load) must keep suppressing state→URL pushes until the
  // *last* one settles, or a stale path from the outgoing session gets pushed.
  const skipPushDepthRef = useRef(0)
  const lastPushedRef = useRef(window.location.pathname)
  const initialLoadDone = useRef(false)

  const loadFromUrl = useCallback(
    async (parsed: ParsedUrl) => {
      skipPushDepthRef.current++
      try {
        if (parsed.type === "preview" && parsed.sessionId) {
          setPreviewLoadError(null)
          try {
            const lookup = await authFetch(
              `/api/find-session/${encodeURIComponent(parsed.sessionId)}`,
            )
            if (!lookup.ok) {
              throw new Error(
                lookup.status === 404
                  ? `Session ${parsed.sessionId} was not found.`
                  : `Failed to resolve session (${lookup.status}).`,
              )
            }
            const location = await lookup.json() as { dirName?: string; fileName?: string }
            if (!location.dirName || !location.fileName) {
              throw new Error("Cogpit returned an invalid session location.")
            }
            const loaded = await loadSessionTailCached(
              location.dirName,
              location.fileName,
              workerParse,
              "session preview",
            )
            dispatch({
              type: "LOAD_SESSION",
              session: loaded.parsed,
              source: loaded.source,
              isMobile,
            })
            resetTurnCount(loaded.parsed.turns.length)
            scrollToBottomInstant()
          } catch (error) {
            dispatch({ type: "GO_HOME", isMobile })
            setPreviewLoadError(
              error instanceof Error ? error.message : "Failed to load session preview.",
            )
          }
        } else if (parsed.type === "session" && parsed.dirName && parsed.sessionId) {
          setPreviewLoadError(null)
          const fileName = fileNameFromSessionId(parsed.dirName, parsed.sessionId)
          let loaded: Awaited<ReturnType<typeof loadSessionTailCached>>
          try {
            // Bottom-first tail load (worker parse + cache) — same pipeline as
            // every other open path, so deep-links open instantly too.
            loaded = await loadSessionTailCached(parsed.dirName, fileName, workerParse, "session")
          } catch {
            dispatch({ type: "GO_HOME", isMobile })
            const home = deviceHomePath()
            window.history.replaceState(null, "", home)
            lastPushedRef.current = home
            saveLastPath(getActiveDeviceId(), home)
            return
          }
          dispatch({
            type: "LOAD_SESSION",
            session: loaded.parsed,
            source: loaded.source,
            isMobile,
          })
          resetTurnCount(loaded.parsed.turns.length)
          scrollToBottomInstant()
        } else if (parsed.type === "project" && parsed.dirName) {
          setPreviewLoadError(null)
          dispatch({ type: "SET_DASHBOARD_PROJECT", dirName: parsed.dirName })
        } else {
          setPreviewLoadError(null)
          dispatch({ type: "GO_HOME", isMobile })
          if (parsed.normalizeHome) {
            const home = deviceHomePath()
            window.history.replaceState(null, "", home)
            lastPushedRef.current = home
            saveLastPath(getActiveDeviceId(), home)
          }
        }
      } finally {
        skipPushDepthRef.current--
      }
    },
    [dispatch, isMobile, resetTurnCount, scrollToBottomInstant, workerParse]
  )

  // On mount: if URL has a path, load the corresponding session or project.
  useEffect(() => {
    if (initialLoadDone.current) return
    initialLoadDone.current = true

    // Remember the entry path so switching away and back restores it (incl.
    // deep links, whose URL never changes and so would otherwise never save).
    saveLastPath(getActiveDeviceId(), window.location.pathname)

    const parsed = parsePath(window.location.pathname)
    if (parsed.type !== "home" || parsed.normalizeHome) {
      loadFromUrl(parsed)
    }
  }, [loadFromUrl])

  // Sync state changes → URL (pushState)
  useEffect(() => {
    if (skipPushDepthRef.current > 0) return
    // Preview owns a stable session-ID URL. Loading its resolved dirName/fileName
    // must not rewrite the address into the full Cogpit navigation scheme.
    if (previewSessionIdFromPath(stripDevicePrefix(window.location.pathname))) return

    const newPath = stateToPath(state)
    if (newPath !== lastPushedRef.current) {
      window.history.pushState(null, "", newPath)
      lastPushedRef.current = newPath
      saveLastPath(getActiveDeviceId(), newPath)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync URL-relevant state fields
  }, [state.sessionSource, state.pendingDirName, state.mainView, state.dashboardProject])

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

  return { previewLoadError }
}
