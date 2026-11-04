import { useMemo } from "react"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useSessionNamer } from "@/hooks/useSessionNamer"
import { agentKindForDirName, type AgentKind } from "@/lib/agents"
import { revealSessionById, revealSessionPath, sessionPath } from "@/lib/revealSession"
import { describeSessionRow } from "@/components/LiveSessions/sessionRowState"
import type { SessionRowState } from "@/components/timeline/SessionRow"

export interface SessionPeek {
  /** The session list's name for it; undefined when it is not listed here. */
  title: string | undefined
  kind: AgentKind | null
  /** Where it stands right now, when the session list can tell. */
  liveState: Extract<SessionRowState, "working" | "needs-you"> | null
  /** What it is doing right now, as the sidebar says it ("Using Bash"). */
  activity: string | null
  /** The first thing it was asked, as the session list read it. */
  firstMessage: string | undefined
  /** Listed, and not running: it has stopped since it was started. */
  settled: boolean
  open: () => void
}

function liveStateOf(row: ReturnType<typeof describeSessionRow> | null): SessionPeek["liveState"] {
  if (row?.dotState === "attention") return "needs-you"
  // A live session waiting for its next instruction has finished its work.
  if (row?.isRunning && !row.isNativeIdle) return "working"
  return null
}

/**
 * What a timeline row needs to show another session: its name and provider
 * from the session list, and whether it is working or waiting on someone.
 * A session the list does not hold still opens, by id.
 */
export function useSessionPeek(sessionId: string | null): SessionPeek {
  const inventory = useSessionInventoryOptional()
  const nameOf = useSessionNamer()
  const session = sessionId ? inventory?.sessions.find((value) => value.sessionId === sessionId) : undefined
  const proc = sessionId ? inventory?.procBySession.get(sessionId) : undefined
  const row = session ? describeSessionRow(session, proc) : null
  const title = sessionId ? nameOf(sessionId) : undefined
  const liveState = liveStateOf(row)
  const statusLabel = row?.statusLabel
  return useMemo(() => ({
    title,
    kind: session ? agentKindForDirName(session.dirName) : null,
    firstMessage: session?.firstUserMessage,
    liveState,
    activity: liveState === "working" ? statusLabel ?? null : null,
    settled: Boolean(session) && liveState === null,
    open: () => {
      if (session) revealSessionPath(sessionPath(session.dirName, session.fileName))
      else if (sessionId) void revealSessionById(sessionId)
    },
  }), [liveState, statusLabel, session, sessionId, title])
}
