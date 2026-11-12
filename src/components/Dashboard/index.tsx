import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { authFetch } from "@/lib/auth"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { useProjects } from "@/lib/projectsStore"
import { projectName, dirNameToPath } from "@/lib/format"
import { SessionsView } from "./SessionsView"
import { ProjectsView } from "./ProjectsView"
import { matchesSessionFilter } from "./sessionPresentation"
import { useSessionContentSearch } from "@/hooks/useSessionContentSearch"
import type { OpenSearchQuote } from "@/components/session-search/types"
import { usePullRequestSessionSearch } from "@/hooks/usePullRequestSessionSearch"
import { useEditionUi } from "@/edition/hooks"
import { listUrl, useSessionListFilter } from "@/lib/sessionListFilter"
import { learnListedAccess, onListsStale, sessionAccessTicket } from "@/lib/sessionAccess"
import type { SessionInfo } from "./types"
import type { DeleteSession } from "@/components/session-browser/types"
import { readCachedSessionPage, writeCachedSessionPage } from "@/lib/sessionListCache"

interface DashboardProps {
  onSelectSession: (dirName: string, fileName: string) => void
  onOpenQuoteSource?: OpenSearchQuote
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  selectedProjectDirName?: string | null
  onSelectProject?: (dirName: string | null) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: DeleteSession
}

export const Dashboard = memo(function Dashboard({
  onSelectSession,
  onOpenQuoteSource,
  onNewSession,
  creatingSession,
  selectedProjectDirName,
  onSelectProject,
  onDuplicateSession,
  onDeleteSession,
}: DashboardProps) {
  const filter = useSessionListFilter()
  const FilterEmpty = useEditionUi().sessionListFilter?.Empty
  const inventory = useSessionInventory()
  const {
    projects,
    loaded: projectsLoaded,
    error: projectsError,
    refresh: refreshProjects,
  } = useProjects()
  const activeSessions = useMemo(
    () => inventory.sessions.filter((session) => !session.archived),
    [inventory.sessions],
  )
  const loading = !projectsLoaded && projects.length === 0
  const [refreshing, setRefreshing] = useState(false)

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sessionsPage, setSessionsPage] = useState(1)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [searchFilter, setSearchFilter] = useState("")
  const [fetchError, setFetchError] = useState<string | null>(null)

  const sessionRequestGeneration = useRef(0)
  const sessionAbortController = useRef<AbortController | null>(null)

  async function refreshDashboard() {
    setRefreshing(true)
    inventory.refresh()
    await refreshProjects()
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
  }, [])

  // Owners moved, so which sessions the project page holds and whose they are may have too.
  useEffect(() => onListsStale(() => {
    if (selectedProjectDirName) void fetchSessions(selectedProjectDirName)
  }), [fetchSessions, selectedProjectDirName])

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

  const conversationSearch = useSessionContentSearch(selectedProject ? searchFilter : "", filter, selectedProject?.path)

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
        conversationSearch={conversationSearch.response}
        onOpenQuoteSource={onOpenQuoteSource}
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
      fetchError={projectsError ?? inventory.error}
      selectedProjectDirName={selectedProjectDirName ?? null}
      onSelectProject={onSelectProject}
      onRefresh={() => void refreshDashboard()}
    />
  )
})
