import { useState, useEffect, useEffectEvent } from "react"
import { authFetch } from "@/lib/auth"
import { loadSessionTailCached } from "@/lib/sessionLoader"
import type { SessionSource } from "@/hooks/useLiveSession"
import type { ParsedSession } from "@/lib/types"
import type { View, ProjectInfo, SessionInfo, CodexSubagentInfo } from "./types"
import {
  readCachedList,
  readCachedSessionPage,
  sessionListCacheKeys,
  writeCachedList,
  writeCachedSessionPage,
} from "@/lib/sessionListCache"

// ── Return type ────────────────────────────────────────────────────────────

interface UseSessionBrowserReturn {
  view: View
  projects: ProjectInfo[]
  sessions: SessionInfo[]
  sessionsTotal: number
  selectedProject: ProjectInfo | null
  isLoading: boolean
  searchFilter: string
  fetchError: string | null
  setSearchFilter: (value: string) => void
  setFetchError: (error: string | null) => void
  loadProjects: () => Promise<void>
  loadSessions: (project: ProjectInfo, page?: number, append?: boolean) => Promise<void>
  loadLiveSession: (dirName: string, fileName: string) => Promise<void>
  showSubagents: () => void
  handleBack: () => void
  handleSelectSession: (s: SessionInfo) => void
  handleSelectSubagent: (agent: CodexSubagentInfo) => void
  handleDeleteSession: (s: SessionInfo) => void
  handleDuplicateSession: (s: SessionInfo) => void
  handleLoadMoreSessions: () => void
}

interface ViewSelection {
  view: View
  sessionId: string | null
}

type LoadSessionHandler = (session: ParsedSession, source: SessionSource) => void

type RequestOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

async function settleRequest<T>(
  request: Promise<T>,
  fallbackError: string,
): Promise<RequestOutcome<T>> {
  try {
    return { ok: true, value: await request }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : fallbackError,
    }
  }
}

async function fetchSuccessfulResponse(url: string, failureMessage: string): Promise<Response> {
  const response = await authFetch(url)
  if (!response.ok) throw new Error(`${failureMessage} (${response.status})`)
  return response
}

async function fetchProjectsList(): Promise<ProjectInfo[]> {
  const response = await fetchSuccessfulResponse("/api/projects", "Failed to load projects")
  const data: unknown = await response.json()
  const projects = Array.isArray(data) ? data as ProjectInfo[] : []
  writeCachedList(sessionListCacheKeys.projects, projects)
  return projects
}

async function fetchSessionsPage(
  project: ProjectInfo,
  page: number,
  cacheResult: boolean,
): Promise<{ sessions: SessionInfo[]; total: number }> {
  const response = await fetchSuccessfulResponse(
    `/api/sessions/${encodeURIComponent(project.dirName)}?page=${page}&limit=20`,
    "Failed to load sessions",
  )
  const data = await response.json() as { sessions?: unknown; total?: unknown }
  const sessions = Array.isArray(data.sessions) ? data.sessions as SessionInfo[] : []
  const total = typeof data.total === "number" ? data.total : sessions.length
  if (cacheResult) writeCachedSessionPage(project.dirName, { sessions, total })
  return { sessions, total }
}

/**
 * Open a session bottom-first: last ~30 turns via the tail endpoint, parsed in
 * the worker and cached in `sessionCache`. Older turns load on scroll-up via
 * `useSessionPaging`, which reads the same cache entry.
 */
async function loadParsedSession(
  dirName: string,
  fileName: string,
  errorLabel: string,
  workerParse: (text: string) => Promise<ParsedSession>,
  onLoadSession: LoadSessionHandler,
): Promise<void> {
  const { parsed, source } = await loadSessionTailCached(dirName, fileName, workerParse, errorLabel)
  onLoadSession(parsed, source)
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useSessionBrowser({
  sessionId,
  workerParse,
  onLoadSession,
  onDeleteSession,
  onDuplicateSession,
  onBeforeLoad,
}: {
  sessionId: string | null
  /** Off-main-thread session parser from App's `useParserWorker`. */
  workerParse: (text: string) => Promise<ParsedSession>
  onLoadSession: LoadSessionHandler
  onDeleteSession?: (dirName: string, fileName: string) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  /** Called before fetching a new session to free connections held by the current session. */
  onBeforeLoad?: () => void
}): UseSessionBrowserReturn {
  const [viewSelection, setViewSelection] = useState<ViewSelection>(() => ({
    view: sessionId ? "detail" : "projects",
    sessionId,
  }))
  const view = sessionId && sessionId !== viewSelection.sessionId
    ? "detail"
    : viewSelection.view
  function setView(nextView: View): void {
    setViewSelection({ view: nextView, sessionId })
  }
  const [projects, setProjects] = useState<ProjectInfo[]>(
    () => readCachedList<ProjectInfo>(sessionListCacheKeys.projects) ?? [],
  )
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sessionsPage, setSessionsPage] = useState(1)
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null)
  const [pendingRequestCount, setPendingRequestCount] = useState(0)
  const isLoading = pendingRequestCount > 0
  const [searchFilter, setSearchFilter] = useState("")
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [detailOrigin, setDetailOrigin] = useState<Exclude<View, "detail">>("projects")

  async function runRequest<T>(
    request: Promise<T>,
    fallbackError: string,
  ): Promise<RequestOutcome<T>> {
    setPendingRequestCount((count) => count + 1)
    setFetchError(null)

    const outcome = await settleRequest(request, fallbackError)
    if (!outcome.ok) setFetchError(outcome.error)
    setPendingRequestCount((count) => Math.max(0, count - 1))
    return outcome
  }

  // Load projects on mount
  async function loadProjects(): Promise<void> {
    const outcome = await runRequest(fetchProjectsList(), "Failed to load projects")
    if (outcome.ok) setProjects(outcome.value)
  }

  const loadProjectsOnMount = useEffectEvent(() => {
    void loadProjects()
  })

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) loadProjectsOnMount()
    })
    return () => {
      active = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- Effect Events must be omitted from dependency arrays.

  async function loadSessions(project: ProjectInfo, page = 1, append = false): Promise<void> {
    if (!append) {
      setSelectedProject(project)
      const cached = readCachedSessionPage<SessionInfo>(project.dirName)
      if (cached) {
        setSessions(cached.sessions)
        setSessionsTotal(cached.total)
        setSessionsPage(1)
        setView("sessions")
      }
    }

    const outcome = await runRequest(
      fetchSessionsPage(project, page, !append),
      "Failed to load sessions",
    )
    if (!outcome.ok) return

    if (append) {
      setSessions((previous) => [...previous, ...outcome.value.sessions])
    } else {
      setSessions(outcome.value.sessions)
    }
    setSessionsTotal(outcome.value.total)
    setSessionsPage(page)
    if (!append) setView("sessions")
  }

  async function openSession(
    dirName: string,
    fileName: string,
    origin: Exclude<View, "detail">,
    errorLabel: "session" | "subagent",
  ): Promise<void> {
    onBeforeLoad?.()
    const outcome = await runRequest(
      loadParsedSession(dirName, fileName, errorLabel, workerParse, onLoadSession),
      `Failed to load ${errorLabel}`,
    )
    if (!outcome.ok) return

    setDetailOrigin(origin)
    setView("detail")
  }

  function loadSessionFile(project: ProjectInfo, session: SessionInfo): Promise<void> {
    return openSession(
      project.dirName,
      session.fileName,
      "sessions",
      "session",
    )
  }

  function loadLiveSession(dirName: string, fileName: string): Promise<void> {
    return openSession(
      dirName,
      fileName,
      "projects",
      "session",
    )
  }

  function showSubagents(): void {
    setSelectedProject(null)
    setSearchFilter("")
    setFetchError(null)
    setView("subagents")
  }

  function handleBack(): void {
    if (view === "detail") {
      setView(detailOrigin === "sessions" && !selectedProject ? "projects" : detailOrigin)
    } else if (view === "sessions" || view === "subagents") {
      setView("projects")
      setSelectedProject(null)
      setSessions([])
      setSessionsTotal(0)
      setSessionsPage(1)
    }
    setSearchFilter("")
  }

  function handleSelectSession(session: SessionInfo): void {
    if (selectedProject) void loadSessionFile(selectedProject, session)
  }

  function handleSelectSubagent(agent: CodexSubagentInfo): void {
    void openSession(
      agent.dirName,
      agent.fileName,
      "subagents",
      "subagent",
    )
  }

  function handleDeleteSession(session: SessionInfo): void {
    if (!selectedProject || !onDeleteSession) return
    onDeleteSession(selectedProject.dirName, session.fileName)
    setSessions((previous) => previous.filter((item) => item.fileName !== session.fileName))
    setSessionsTotal((total) => total - 1)
  }

  function handleDuplicateSession(session: SessionInfo): void {
    if (!selectedProject || !onDuplicateSession) return
    onDuplicateSession(selectedProject.dirName, session.fileName)
  }

  function handleLoadMoreSessions(): void {
    if (selectedProject) void loadSessions(selectedProject, sessionsPage + 1, true)
  }

  return {
    view,
    projects,
    sessions,
    sessionsTotal,
    selectedProject,
    isLoading,
    searchFilter,
    fetchError,
    setSearchFilter,
    setFetchError,
    loadProjects,
    loadSessions,
    loadLiveSession,
    showSubagents,
    handleBack,
    handleSelectSession,
    handleSelectSubagent,
    handleDeleteSession,
    handleDuplicateSession,
    handleLoadMoreSessions,
  }
}
