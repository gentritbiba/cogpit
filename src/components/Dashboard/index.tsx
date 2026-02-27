import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { authFetch } from "@/lib/auth"
import { projectName, dirNameToPath } from "@/lib/format"
import { SessionsView } from "./SessionsView"
import { ProjectsView } from "./ProjectsView"

// Re-export sub-components for external consumers
export { Shortcut, LiveDot, SearchInput, ErrorBanner, SkeletonCards } from "./DashboardWidgets"
export { SessionsView } from "./SessionsView"
export { ProjectsView } from "./ProjectsView"

interface ProjectInfo {
  dirName: string
  path: string
  shortName: string
  sessionCount: number
  lastModified: string | null
}

interface SessionInfo {
  fileName: string
  sessionId: string
  size: number
  lastModified: string | null
  version?: string
  gitBranch?: string
  model?: string
  slug?: string
  cwd?: string
  firstUserMessage?: string
  timestamp?: string
  turnCount?: number
  lineCount?: number
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
}

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
  onDeleteSession?: (dirName: string, fileName: string) => void
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
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sessionsPage, setSessionsPage] = useState(1)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [searchFilter, setSearchFilter] = useState("")
  const [fetchError, setFetchError] = useState<string | null>(null)

  const loadedForDirName = useRef<string | null>(null)

  const fetchDashboard = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const [projectsRes, sessionsRes] = await Promise.all([
        authFetch("/api/projects"),
        authFetch("/api/active-sessions"),
      ])
      if (!projectsRes.ok || !sessionsRes.ok) {
        throw new Error("Failed to fetch dashboard data")
      }
      const projectsData = await projectsRes.json()
      const sessionsData = await sessionsRes.json()
      setProjects(Array.isArray(projectsData) ? projectsData : [])
      setActiveSessions(Array.isArray(sessionsData) ? sessionsData : [])
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchDashboard()
    const interval = setInterval(() => fetchDashboard(), 10000)
    return () => clearInterval(interval)
  }, [fetchDashboard])

  const fetchSessions = useCallback(async (dirName: string, page = 1, append = false) => {
    setSessionsLoading(true)
    setFetchError(null)
    if (!append) setSessions([])
    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(dirName)}?page=${page}&limit=20`)
      if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`)
      const data = await res.json()
      setSessions((prev) => append ? [...prev, ...data.sessions] : data.sessions)
      setSessionsTotal(data.total)
      setSessionsPage(page)
      loadedForDirName.current = dirName
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load sessions")
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  // Load sessions when selectedProjectDirName changes
  useEffect(() => {
    if (!selectedProjectDirName) {
      if (loadedForDirName.current) {
        setSessions([])
        setSessionsTotal(0)
        setSessionsPage(1)
        setSearchFilter("")
        loadedForDirName.current = null
      }
      return
    }
    if (loadedForDirName.current === selectedProjectDirName) return
    setSearchFilter("")
    fetchSessions(selectedProjectDirName)
  }, [selectedProjectDirName, fetchSessions])

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

  const filteredSessions = useMemo(() => {
    if (!searchFilter) return sessions
    const q = searchFilter.toLowerCase()
    return sessions.filter(
      (s) =>
        s.firstUserMessage?.toLowerCase().includes(q) ||
        s.slug?.toLowerCase().includes(q) ||
        s.model?.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
    )
  }, [sessions, searchFilter])

  function handleDeleteSession(dirName: string, fileName: string) {
    onDeleteSession?.(dirName, fileName)
    setSessions((prev) => prev.filter((x) => x.fileName !== fileName))
    setSessionsTotal((prev) => prev - 1)
  }

  // ── Sessions view (drilled into a project) ──
  if (selectedProject) {
    return (
      <SessionsView
        selectedProject={selectedProject}
        sessions={sessions}
        sessionsTotal={sessionsTotal}
        sessionsLoading={sessionsLoading}
        searchFilter={searchFilter}
        setSearchFilter={setSearchFilter}
        filteredSessions={filteredSessions}
        fetchError={fetchError}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        creatingSession={creatingSession}
        onDuplicateSession={onDuplicateSession}
        onDeleteSession={handleDeleteSession}
        onBack={handleBack}
        onRetryFetch={() => {
          setFetchError(null)
          loadedForDirName.current = null
          if (selectedProjectDirName) {
            fetchSessions(selectedProjectDirName)
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
      fetchError={fetchError}
      selectedProjectDirName={selectedProjectDirName ?? null}
      onSelectProject={onSelectProject}
      onRefresh={() => fetchDashboard(true)}
    />
  )
})
