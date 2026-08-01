/**
 * Everything currently blocking a session on a human, across every session.
 *
 * Two distinct things strand an agent, and the app needs both in one place:
 *
 * - a **permission** request (`GET /api/permissions`), which never fires when a
 *   session runs with bypassPermissions;
 * - an **AskUserQuestion** call (`GET /api/user-questions`), which blocks
 *   regardless of permission mode and is therefore the signal that matters most
 *   for anyone running agents unattended.
 *
 * The sidebar strip, the header badge and the Mission Control grid all consume
 * this. Two separate contexts would mean every consumer unions two sets by
 * hand, and any one of them could forget — the exact drift a shared context
 * exists to prevent. Both endpoints read in-memory registries only (no
 * filesystem, no `ps`), so polling them together costs one extra request on an
 * existing tick and guarantees both lists come from the same instant.
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

export function PendingHumanInputProvider({ children }: { children: ReactNode }) {
  const [permissionsBySession, setPermissionsBySession] =
    useState<Map<string, MissionControlPermission[]>>(new Map)
  const [questionsBySession, setQuestionsBySession] =
    useState<Map<string, MissionControlQuestion[]>>(new Map)
  const [responding, setResponding] = useState<Set<string>>(new Set())
  const cancelledRef = useRef(false)
  // One dedupe key per endpoint. A single shared key would let a stable
  // permissions payload suppress a changed questions payload, and the grid
  // would silently stop updating.
  const lastPermissionsRef = useRef<string>("")
  const lastQuestionsRef = useRef<string>("")

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

  const fetchNow = useCallback(async () => {
    const [permRes, questionRes] = await Promise.all([
      authFetch("/api/permissions").catch(() => null),
      authFetch("/api/user-questions").catch(() => null),
    ])
    if (cancelledRef.current) return

    if (permRes?.ok) {
      try {
        const text = await permRes.text()
        if (!cancelledRef.current && text !== lastPermissionsRef.current) {
          lastPermissionsRef.current = text
          const data = JSON.parse(text) as { bySession?: Record<string, RawPermission[]> }
          const next = new Map<string, MissionControlPermission[]>()
          for (const [sessionId, requests] of Object.entries(data.bySession ?? {})) {
            next.set(sessionId, requests.map((r) => ({
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
          setPermissionsBySession(next)
        }
      } catch {
        // Keep the previous list: a stale entry is better than dropping
        // something the user still has to answer.
      }
    }

    if (questionRes?.ok) {
      try {
        const text = await questionRes.text()
        if (!cancelledRef.current && text !== lastQuestionsRef.current) {
          lastQuestionsRef.current = text
          const data = JSON.parse(text) as Partial<UserQuestionsResponse>
          const next = new Map<string, MissionControlQuestion[]>()
          for (const [sessionId, questions] of Object.entries(data.bySession ?? {})) {
            if (Array.isArray(questions) && questions.length > 0) next.set(sessionId, questions)
          }
          setQuestionsBySession(next)
        }
      } catch {
        // As above.
      }
    }
  }, [])

  useEffect(() => {
    const pollWhenVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void fetchNow()
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchNow()
    }

    pollWhenVisible()
    const id = setInterval(pollWhenVisible, POLL_INTERVAL)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [fetchNow])

  const respond = useCallback(async (
    sessionId: string,
    requestId: string,
    behavior: PermissionDecision,
  ) => {
    setResponding((prev) => new Set(prev).add(requestId))
    try {
      if (await respondToPermission(sessionId, requestId, behavior)) {
        // Release the card immediately rather than waiting out the poll.
        setPermissionsBySession((prev) => {
          const next = new Map(prev)
          const remaining = (next.get(sessionId) ?? []).filter((p) => p.requestId !== requestId)
          if (remaining.length > 0) next.set(sessionId, remaining)
          else next.delete(sessionId)
          return next
        })
        lastPermissionsRef.current = ""
      }
    } catch {
      // The next poll re-surfaces the request if the answer did not land.
    } finally {
      setResponding((prev) => {
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
      void fetchNow()
    }
  }, [fetchNow])

  const answerQuestion = useCallback(async (
    sessionId: string,
    toolUseId: string,
    answers: UserQuestionAnswerMap,
  ): Promise<AnswerResult> => {
    setResponding((prev) => new Set(prev).add(toolUseId))
    try {
      const result = await submitUserQuestionAnswers(sessionId, toolUseId, answers)
      if (result.ok) {
        setQuestionsBySession((prev) => {
          const next = new Map(prev)
          const remaining = (next.get(sessionId) ?? []).filter((q) => q.toolUseId !== toolUseId)
          if (remaining.length > 0) next.set(sessionId, remaining)
          else next.delete(sessionId)
          return next
        })
        lastQuestionsRef.current = ""
      }
      return result
    } finally {
      setResponding((prev) => {
        const next = new Set(prev)
        next.delete(toolUseId)
        return next
      })
      void fetchNow()
    }
  }, [fetchNow])

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
