/**
 * Everything blocking a session on a human: permission requests
 * (`GET /api/permissions`) and AskUserQuestion calls (`GET /api/user-questions`,
 * which strand a session even under bypassPermissions).
 *
 * One context rather than two so the sidebar strip, the header badge and the
 * Mission Control grid cannot drift by each unioning the two sets by hand. Both
 * endpoints read in-memory registries only (no filesystem, no `ps`), so polling
 * them on one tick is cheap and both lists come from the same instant.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { authFetch } from "@/lib/auth"
import { respondToPermission, type PermissionDecision } from "@/lib/permissionApi"
import {
  submitUserQuestionAnswers,
  type AnswerResult,
  type UserQuestionAnswerMap,
} from "@/lib/askUserApi"
import { getToolSummary } from "../../shared/session/toolSummary"
import type {
  MissionControlPermission,
  MissionControlQuestion,
  UserQuestionsResponse,
} from "../../shared/contracts/missionControl"

const POLL_INTERVAL = 3_000

interface RawPermission {
  requestId: string
  toolName: string
  input?: Record<string, unknown>
  title?: string
  description?: string
  availableDecisions?: PermissionDecision[]
  timestamp: number
}

export interface PendingHumanInput {
  permissionsBySession: Map<string, MissionControlPermission[]>
  questionsBySession: Map<string, MissionControlQuestion[]>
  /** Sessions blocked on a permission. */
  awaitingPermission: Set<string>
  /** Sessions blocked on a question. */
  awaitingQuestion: Set<string>
  /** Request ids and tool-use ids currently being answered. */
  responding: Set<string>
  respond: (
    sessionId: string,
    requestId: string,
    behavior: PermissionDecision,
  ) => Promise<void>
  answerQuestion: (
    sessionId: string,
    toolUseId: string,
    answers: UserQuestionAnswerMap,
  ) => Promise<AnswerResult>
  refresh: () => void
}

const PendingHumanInputContext = createContext<PendingHumanInput | null>(null)

/**
 * Read one endpoint, yielding its body only when the raw text differs from the
 * last body accepted from *that* endpoint — a shared dedupe key would let a
 * stable permissions payload suppress a changed questions payload. An
 * unchanged, failed or unparseable read yields undefined, leaving the previous
 * list standing: a stale blocker beats dropping one the user must still answer.
 */
async function readIfChanged<T>(url: string, seen: RefObject<string>): Promise<T | undefined> {
  try {
    const res = await authFetch(url)
    if (!res.ok) return undefined
    const text = await res.text()
    if (text === seen.current) return undefined
    seen.current = text
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function toPermissionMap(
  bySession: Record<string, RawPermission[]>,
): Map<string, MissionControlPermission[]> {
  const map = new Map<string, MissionControlPermission[]>()
  for (const [sessionId, requests] of Object.entries(bySession)) {
    map.set(sessionId, requests.map((r) => ({
      sessionId,
      requestId: r.requestId,
      toolName: r.toolName,
      summary: getToolSummary({ name: r.toolName, input: r.input ?? {} }),
      title: r.title,
      description: r.description,
      ...(r.availableDecisions && { availableDecisions: r.availableDecisions }),
      timestamp: r.timestamp,
    })))
  }
  return map
}

function toQuestionMap(
  bySession: Record<string, MissionControlQuestion[]>,
): Map<string, MissionControlQuestion[]> {
  const map = new Map<string, MissionControlQuestion[]>()
  for (const [sessionId, questions] of Object.entries(bySession)) {
    if (Array.isArray(questions) && questions.length > 0) map.set(sessionId, questions)
  }
  return map
}

/** Drop the answered item, forgetting the session once nothing is left on it. */
function drop<T>(
  bySession: Map<string, T[]>,
  sessionId: string,
  answered: (item: T) => boolean,
): Map<string, T[]> {
  const next = new Map(bySession)
  const remaining = (next.get(sessionId) ?? []).filter((item) => !answered(item))
  if (remaining.length > 0) next.set(sessionId, remaining)
  else next.delete(sessionId)
  return next
}

export function PendingHumanInputProvider({ children }: { children: ReactNode }) {
  const [permissionsBySession, setPermissionsBySession] =
    useState<Map<string, MissionControlPermission[]>>(new Map())
  const [questionsBySession, setQuestionsBySession] =
    useState<Map<string, MissionControlQuestion[]>>(new Map())
  const [responding, setResponding] = useState<Set<string>>(new Set())
  const lastPermissionsRef = useRef("")
  const lastQuestionsRef = useRef("")

  const fetchNow = useCallback(async () => {
    const [permissions, questions] = await Promise.all([
      readIfChanged<{ bySession?: Record<string, RawPermission[]> }>(
        "/api/permissions",
        lastPermissionsRef,
      ),
      readIfChanged<Partial<UserQuestionsResponse>>("/api/user-questions", lastQuestionsRef),
    ])
    if (permissions) setPermissionsBySession(toPermissionMap(permissions.bySession ?? {}))
    if (questions) setQuestionsBySession(toQuestionMap(questions.bySession ?? {}))
  }, [])

  useEffect(() => {
    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") void fetchNow()
    }
    pollWhenVisible()
    const id = setInterval(pollWhenVisible, POLL_INTERVAL)
    document.addEventListener("visibilitychange", pollWhenVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", pollWhenVisible)
    }
  }, [fetchNow])

  /**
   * Both answers share a shape: flag the id as in flight, run the call, then
   * always unflag and re-poll so the server's view replaces the optimistic edit.
   */
  const withResponding = useCallback(async <T,>(
    id: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    setResponding((prev) => new Set(prev).add(id))
    try {
      return await run()
    } finally {
      setResponding((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      void fetchNow()
    }
  }, [fetchNow])

  const respond = useCallback((
    sessionId: string,
    requestId: string,
    behavior: PermissionDecision,
  ): Promise<void> => withResponding(requestId, async () => {
    // A refused or failed answer is left alone: the next poll re-surfaces it.
    const accepted = await respondToPermission(sessionId, requestId, behavior)
      .catch(() => false)
    if (!accepted) return
    // Release the card now rather than waiting out the poll, and clear the
    // dedupe key so the next payload re-applies over the optimistic removal.
    setPermissionsBySession((prev) => drop(prev, sessionId, (p) => p.requestId === requestId))
    lastPermissionsRef.current = ""
  }), [withResponding])

  const answerQuestion = useCallback((
    sessionId: string,
    toolUseId: string,
    answers: UserQuestionAnswerMap,
  ): Promise<AnswerResult> => withResponding(toolUseId, async () => {
    const result = await submitUserQuestionAnswers(sessionId, toolUseId, answers)
    if (result.ok) {
      setQuestionsBySession((prev) => drop(prev, sessionId, (q) => q.toolUseId === toolUseId))
      lastQuestionsRef.current = ""
    }
    return result
  }), [withResponding])

  const awaitingPermission = useMemo(
    () => new Set(permissionsBySession.keys()),
    [permissionsBySession],
  )
  const awaitingQuestion = useMemo(
    () => new Set(questionsBySession.keys()),
    [questionsBySession],
  )
  const refresh = useCallback(() => { void fetchNow() }, [fetchNow])

  const value = useMemo<PendingHumanInput>(() => ({
    permissionsBySession,
    questionsBySession,
    awaitingPermission,
    awaitingQuestion,
    responding,
    respond,
    answerQuestion,
    refresh,
  }), [
    permissionsBySession, questionsBySession, awaitingPermission, awaitingQuestion,
    responding, respond, answerQuestion, refresh,
  ])

  return (
    <PendingHumanInputContext.Provider value={value}>
      {children}
    </PendingHumanInputContext.Provider>
  )
}

export function usePendingHumanInput(): PendingHumanInput {
  const ctx = useContext(PendingHumanInputContext)
  if (!ctx) {
    throw new Error("usePendingHumanInput must be used within a PendingHumanInputProvider")
  }
  return ctx
}
