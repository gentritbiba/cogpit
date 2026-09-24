import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { authFetch } from "@/lib/auth"
import { projectName, dirNameToPath } from "@/lib/format"
import { SessionsView } from "./SessionsView"
import { ProjectsView } from "./ProjectsView"
import { matchesSessionFilter } from "./sessionPresentation"
import { usePullRequestSessionSearch } from "@/hooks/usePullRequestSessionSearch"
import { useEditionUi } from "@/edition/hooks"
import { activeSessionsUrl, listUrl, useSessionListFilter } from "@/lib/sessionListFilter"
import { learnListedAccess, onListsStale, sessionAccessTicket } from "@/lib/sessionAccess"
import type { ProjectInfo, SessionInfo } from "./types"
import type { DeleteSession } from "@/components/session-browser/types"
import {
  activeSessionsCacheKey,
  readCachedList,
  readCachedSessionPage,
  sessionListCacheKeys,
  writeCachedList,
  writeCachedSessionPage,
} from "@/lib/sessionListCache"

interface ActiveSessionInfo {
  dirName: string
  projectShortName: string
  fileName: string
  sessionId: string
  slug?: string
  model?: string
  firstUserMessage?: string
  gitBranch?: string
  cwd?: string
  lastModified: string
  turnCount?: number
  size: number
  isActive?: boolean
}

interface DashboardProps {
  onSelectSession: (dirName: string, fileName: string) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  selectedProjectDirName?: string | null
  onSelectProject?: (dirName: string | null) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: DeleteSession
}

export const Dashboard = memo(function Dashboard({
  onSelectSession,
  onNewSession,
  creatingSession,
  selectedProjectDirName,
  onSelectProject,
  onDuplicateSession,
  onDeleteSession,
}: DashboardProps) {
  const filter = useSessionListFilter()
  const FilterEmpty = useEditionUi().sessionListFilter?.Empty
  const [initialCachedData] = useState(() => ({
    projects: readCachedList<ProjectInfo>(sessionListCacheKeys.projects),
    activeSessions: readCachedList<ActiveSessionInfo>(activeSessionsCacheKey(filter.key)),
  }))
  const [projects, setProjects] = useState<ProjectInfo[]>(initialCachedData.projects ?? [])
  const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[]>(initialCachedData.activeSessions ?? [])
  const [loading, setLoading] = useState(initialCachedData.projects === undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [activeError, setActiveError] = useState<string | null>(null)

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sessionsPage, setSessionsPage] = useState(1)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [searchFilter, setSearchFilter] = useState("")
  const [fetchError, setFetchError] = useState<string | null>(null)

  const sessionRequestGeneration = useRef(0)
  const sessionAbortController = useRef<AbortController | null>(null)
  const activeAbortController = useRef<AbortController | null>(null)
  const shownFilter = useRef(filter.key)

  const fetchProjects = useCallback(async () => {
    try {
      const res = await authFetch("/api/projects")
      if (!res.ok) throw new Error("Failed to fetch dashboard data")
      const data = await res.json()
      const nextProjects = Array.isArray(data) ? data as ProjectInfo[] : []
      setProjects(nextProjects)
      writeCachedList(sessionListCacheKeys.projects, nextProjects)
      setProjectsError(null)
    } catch (err) {
      setProjectsError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setLoading(false)
    }
  }, [])

  // Filter switches can race; each request aborts the one before it.
  const fetchActiveSessions = useCallback(async () => {
    activeAbortController.current?.abort()
    const controller = new AbortController()
    activeAbortController.current = controller
    const accessTicket = sessionAccessTicket()
    try {
      const res = await authFetch(activeSessionsUrl({}, filter), { signal: controller.signal })
      if (!res.ok) throw new Error("Failed to fetch dashboard data")
      const data = await res.json()
      if (controller.signal.aborted) return
      const nextActiveSessions = Array.isArray(data) ? data as ActiveSessionInfo[] : []
      learnListedAccess(nextActiveSessions, accessTicket)
      setActiveSessions(nextActiveSessions)
      writeCachedList(activeSessionsCacheKey(filter.key), nextActiveSessions)
      setActiveError(null)
    } catch (err) {
      if (controller.signal.aborted) return
      setActiveError(err instanceof Error ? err.message : "Failed to load data")
    }
  }, [filter])

  useEffect(() => {
    void fetchProjects()
  }, [fetchProjects])

  // A new filter shows its own cached list while its request runs.
  useEffect(() => {
    if (shownFilter.current !== filter.key) {
      shownFilter.current = filter.key
      setActiveSessions(readCachedList<ActiveSessionInfo>(activeSessionsCacheKey(filter.key)) ?? [])
    }
    void fetchActiveSessions()
  }, [filter, fetchActiveSessions])

  async function refreshDashboard() {
    setRefreshing(true)
    await Promise.all([fetchProjects(), fetchActiveSessions()])
    setRefreshing(false)
  }

  const fetchSessions = useCallback(async (dirName: string, page = 1, append = false) => {
    const requestGeneration = ++sessionRequestGeneration.current
    sessionAbortController.current?.abort()
    const controller = new AbortController()
    sessionAbortController.current = controller
    const isCurrentRequest = () => requestGeneration === sessionRequestGeneration.current

    setSessionsLoading(true)
    setFetchError(null)
    const accessTicket = sessionAccessTicket()
    if (!append) {
      const cached = readCachedSessionPage<SessionInfo>(dirName, filter.key)
      if (cached) {
        setSessions(cached.sessions)
        setSessionsTotal(cached.total)
        setSessionsPage(1)
      } else {
        setSessions([])
      }
    }
    try {
      const res = await authFetch(
        listUrl(`/api/sessions/${encodeURIComponent(dirName)}`, filter, { page: String(page), limit: "20" }),
        { signal: controller.signal },
      )
      if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`)
      const data = await res.json()
      if (!isCurrentRequest()) return
      const nextSessions = Array.isArray(data.sessions) ? data.sessions as SessionInfo[] : []
      const total = typeof data.total === "number" ? data.total : nextSessions.length
      learnListedAccess(nextSessions, accessTicket)
      setSessions((prev) => append ? [...prev, ...nextSessions] : nextSessions)
      setSessionsTotal(total)
      setSessionsPage(page)
      if (!append) {
        writeCachedSessionPage(dirName, filter.key, { sessions: nextSessions, total })
      }
    } catch (err) {
      if (!isCurrentRequest() || controller.signal.aborted) return
      setFetchError(err instanceof Error ? err.message : "Failed to load sessions")
    } finally {
      if (isCurrentRequest()) {
        sessionAbortController.current = null
        setSessionsLoading(false)
      }
    }
  }, [filter])

  // A project, or the filter, changed: list the project's sessions again.
  useEffect(() => {
    if (!selectedProjectDirName) {
      sessionRequestGeneration.current += 1
      sessionAbortController.current?.abort()
      sessionAbortController.current = null
      setSessions([])
      setSessionsTotal(0)
      setSessionsPage(1)
      setSessionsLoading(false)
      return
    }
    void fetchSessions(selectedProjectDirName)
  }, [selectedProjectDirName, fetchSessions])

  // Another project, or none, starts unfiltered; a filter change keeps the search.
  useEffect(() => {
    setSearchFilter("")
  }, [selectedProjectDirName])

  useEffect(() => () => {
    sessionRequestGeneration.current += 1
    sessionAbortController.current?.abort()
    activeAbortController.current?.abort()
  }, [])

  // Owners moved, so which sessions each list holds and whose they are may have too.
  useEffect(() => onListsStale(() => {
    void fetchActiveSessions()
    if (selectedProjectDirName) void fetchSessions(selectedProjectDirName)
  }), [fetchActiveSessions, fetchSessions, selectedProjectDirName])

  const selectedProject = useMemo(() => {
    if (!selectedProjectDirName) return null
    const found = projects.find((p) => p.dirName === selectedProjectDirName)
    if (found) return found
    const fallbackPath = dirNameToPath(selectedProjectDirName)
    return {
      dirName: selectedProjectDirName,
      path: fallbackPath,
      shortName: projectName(fallbackPath),
      sessionCount: sessionsTotal,
      lastModified: null,
    }
  }, [selectedProjectDirName, projects, sessionsTotal])

  const handleBack = useCallback(() => {
    onSelectProject?.(null)
  }, [onSelectProject])

  const loadMoreSessions = useCallback(() => {
    if (!selectedProjectDirName) return
    fetchSessions(selectedProjectDirName, sessionsPage + 1, true)
  }, [selectedProjectDirName, sessionsPage, fetchSessions])

  const pullRequestResults = usePullRequestSessionSearch<SessionInfo>(
    selectedProjectDirName ? searchFilter : "",
    filter,
    selectedProjectDirName ?? undefined,
  )

  const filteredSessions = useMemo(() => {
    if (!searchFilter) return sessions
    return sessions.filter((s) => matchesSessionFilter(s, searchFilter))
  }, [sessions, searchFilter])
  const visibleSessions = pullRequestResults.results ?? filteredSessions

  async function handleDeleteSession(dirName: string, fileName: string) {
    if (!await onDeleteSession?.(dirName, fileName)) return
    setSessions((prev) => prev.filter((x) => x.fileName !== fileName))
    setSessionsTotal((prev) => prev - 1)
  }

  // ── Sessions view (drilled into a project) ──
  if (selectedProject) {
    return (
      <SessionsView
        selectedProject={selectedProject}
        filterEmpty={filter.key !== null && FilterEmpty ? <FilterEmpty className="min-h-72 border" /> : null}
        sessions={sessions}
        sessionsTotal={sessionsTotal}
        sessionsLoading={sessionsLoading}
        searchLoading={pullRequestResults.loading}
        searchFilter={searchFilter}
        setSearchFilter={setSearchFilter}
        filteredSessions={visibleSessions}
        fetchError={pullRequestResults.error ?? fetchError}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        creatingSession={creatingSession}
        onDuplicateSession={onDuplicateSession}
        onDeleteSession={handleDeleteSession}
        onBack={handleBack}
        onRetryFetch={() => {
          if (pullRequestResults.error) {
            pullRequestResults.refresh()
            return
          }
          setFetchError(null)
          if (selectedProjectDirName) {
            void fetchSessions(selectedProjectDirName)
          }
        }}
        loadMoreSessions={loadMoreSessions}
      />
    )
  }

  // ── Projects view (default) ──
  return (
    <ProjectsView
      projects={projects}
      activeSessions={activeSessions}
      loading={loading}
      refreshing={refreshing}
      searchFilter={searchFilter}
      setSearchFilter={setSearchFilter}
      fetchError={projectsError ?? activeError}
      selectedProjectDirName={selectedProjectDirName ?? null}
      onSelectProject={onSelectProject}
      onRefresh={() => void refreshDashboard()}
    />
  )
})
