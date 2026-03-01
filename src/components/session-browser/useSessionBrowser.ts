import { useState, useEffect, useCallback } from "react"
import { authFetch } from "@/lib/auth"
import { parseSession } from "@/lib/parser"
import type { ParsedSession } from "@/lib/types"
import type { View, ProjectInfo, SessionInfo } from "./types"

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
  loadSessionFile: (project: ProjectInfo, session: SessionInfo) => Promise<void>
  loadLiveSession: (dirName: string, fileName: string) => Promise<void>
  handleBack: () => void
  handleSelectSession: (s: SessionInfo) => void
  handleDeleteSession: (s: SessionInfo) => void
  handleDuplicateSession: (s: SessionInfo) => void
  handleLoadMoreSessions: () => void
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useSessionBrowser({
  sessionId,
  onLoadSession,
  onDeleteSession,
  onDuplicateSession,
}: {
  sessionId: string | null
  onLoadSession: (
    session: ParsedSession,
    source: { dirName: string; fileName: string; rawText: string }
  ) => void
  onDeleteSession?: (dirName: string, fileName: string) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
}): UseSessionBrowserReturn {
  const [view, setView] = useState<View>(sessionId ? "detail" : "projects")
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsTotal, setSessionsTotal] = useState(0)
  const [sessionsPage, setSessionsPage] = useState(1)
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [searchFilter, setSearchFilter] = useState("")
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Load projects on mount
  const loadProjects = useCallback(async () => {
    setIsLoading(true)
    setFetchError(null)
    try {
      const res = await authFetch("/api/projects")
      if (!res.ok) throw new Error(`Failed to load projects (${res.status})`)
      const data = await res.json()
      setProjects(data)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load projects")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // When session changes externally, switch to detail view
  useEffect(() => {
    if (sessionId) setView("detail")
  }, [sessionId])

  const loadSessions = useCallback(async (project: ProjectInfo, page = 1, append = false) => {
    setIsLoading(true)
    setFetchError(null)
    if (!append) {
      setSelectedProject(project)
    }
    try {
      const res = await authFetch(`/api/sessions/${encodeURIComponent(project.dirName)}?page=${page}&limit=20`)
      if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`)
      const data = await res.json()
      if (append) {
        setSessions((prev) => [...prev, ...data.sessions])
      } else {
        setSessions(data.sessions)
      }
      setSessionsTotal(data.total)
      setSessionsPage(page)
      if (!append) setView("sessions")
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load sessions")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadSessionFile = useCallback(
    async (project: ProjectInfo, session: SessionInfo) => {
      setIsLoading(true)
      setFetchError(null)
      try {
        const res = await authFetch(
          `/api/sessions/${encodeURIComponent(project.dirName)}/${encodeURIComponent(session.fileName)}`
        )
        if (!res.ok) throw new Error(`Failed to load session (${res.status})`)
        const text = await res.text()
        const parsed = parseSession(text)
        onLoadSession(parsed, {
          dirName: project.dirName,
          fileName: session.fileName,
          rawText: text,
        })
        setView("detail")
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : "Failed to load session")
      } finally {
        setIsLoading(false)
      }
    },
    [onLoadSession]
  )

  const loadLiveSession = useCallback(
    async (dirName: string, fileName: string) => {
      setIsLoading(true)
      setFetchError(null)
      try {
        const res = await authFetch(
          `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
        )
        if (!res.ok) throw new Error(`Failed to load session (${res.status})`)
        const text = await res.text()
        const parsed = parseSession(text)
        onLoadSession(parsed, { dirName, fileName, rawText: text })
        setView("detail")
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : "Failed to load session")
      } finally {
        setIsLoading(false)
      }
    },
    [onLoadSession]
  )

  const handleBack = useCallback(() => {
    if (view === "detail" && selectedProject) {
      setView("sessions")
    } else if (view === "detail") {
      setView("projects")
    } else if (view === "sessions") {
      setView("projects")
      setSelectedProject(null)
      setSessions([])
      setSessionsTotal(0)
      setSessionsPage(1)
    }
    setSearchFilter("")
  }, [view, selectedProject])

  const handleSelectSession = useCallback(
    (s: SessionInfo) => {
      if (selectedProject) loadSessionFile(selectedProject, s)
    },
    [selectedProject, loadSessionFile]
  )

  const handleDeleteSession = useCallback(
    (s: SessionInfo) => {
      if (!selectedProject || !onDeleteSession) return
      onDeleteSession(selectedProject.dirName, s.fileName)
      setSessions((prev) => prev.filter((x) => x.fileName !== s.fileName))
      setSessionsTotal((prev) => prev - 1)
    },
    [selectedProject, onDeleteSession]
  )

  const handleDuplicateSession = useCallback(
    (s: SessionInfo) => {
      if (!selectedProject || !onDuplicateSession) return
      onDuplicateSession(selectedProject.dirName, s.fileName)
    },
    [selectedProject, onDuplicateSession]
  )

  const handleLoadMoreSessions = useCallback(() => {
    if (selectedProject) loadSessions(selectedProject, sessionsPage + 1, true)
  }, [selectedProject, sessionsPage, loadSessions])

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
    loadSessionFile,
    loadLiveSession,
    handleBack,
    handleSelectSession,
    handleDeleteSession,
    handleDuplicateSession,
    handleLoadMoreSessions,
  }
}
