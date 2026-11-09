import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react"
import { useSessionContext } from "@/contexts/SessionContext"
import { WORKING_STATUSES } from "@/lib/sessionActivity"
import type { SessionSource } from "@/lib/sessionSource"
import type { Branch } from "../../../shared/session/types"
import type { ComposerAttachment, ComposerContextItem, QuoteSource } from "../../../shared/session/composerContext"
import { DisclosureProvider } from "./disclosure"

/**
 * The session facts rows need. Unlike the session context, which is rebuilt on
 * every streamed record, this changes only when one of these facts does, so a
 * record re-renders the rows whose turn changed and nothing else.
 */
export interface TimelineRowFacts {
  sessionId: string | null
  sessionSource: SessionSource | null
  cwd: string
  isLive: boolean
  isSubAgentView: boolean
  turnCount: number
  /** The tool call selected in the stats and sidebar panels; only the selected turn's row reads it. */
  activeToolCallId: string | null
  canSend: boolean
  canAnswer: boolean
  /** Tool call id of the question the session is waiting on, if any. */
  openQuestionId: string | undefined
  branches: readonly Branch[]
  branchesAtTurn?: (turnIndex: number) => Branch[]
  restoreToHere?: (turnIndex: number) => void
  openBranches?: (turnIndex: number) => void
  branchFromHere?: (turnIndex: number) => void
  editCommand?: (commandName: string) => void
  expandCommand?: (commandName: string, args?: string) => Promise<string | null>
  addComposerContext?: (item: ComposerContextItem, attachments?: ComposerAttachment[]) => string | null
  openQuoteSource?: (source: QuoteSource, text: string) => Promise<boolean>
}

/** Whether the session's last turn is still being worked on; only its row reads this. */
export interface TimelineLiveStatus {
  live: boolean
  working: boolean
}

const RowFactsContext = createContext<TimelineRowFacts | null>(null)
const LiveStatusContext = createContext<TimelineLiveStatus>({ live: false, working: false })

export function useTimelineRowFacts(): TimelineRowFacts | null {
  return useContext(RowFactsContext)
}

export function useTimelineLiveStatus(): TimelineLiveStatus {
  return useContext(LiveStatusContext)
}

type Fn = (...args: never[]) => unknown

/** A wrapper whose identity changes only when `present` does, calling the latest `fn`. */
function useStable<F extends Fn>(fn: F | undefined): F | undefined {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  const present = fn !== undefined
  return useMemo(
    () => (present ? ((...args: Parameters<F>) => (latest.current as F)(...args)) as F : undefined),
    [present],
  )
}

export function TimelineRowsProvider({ sessionKey, children }: {
  sessionKey?: string
  children: ReactNode
}) {
  const { session, sessionSource, activeToolCallId, isLive, isSubAgentView, permissions, pendingInteraction, undoRedo, actions } = useSessionContext()
  const sessionId = session?.sessionId ?? null
  const cwd = session?.cwd ?? ""
  const turnCount = session?.turns.length ?? 0
  const live = isLive && session !== null
  const working = live && WORKING_STATUSES.has(session.digest.status.status)
  const openQuestionId = pendingInteraction?.type === "question" ? pendingInteraction.toolUseId : undefined
  const undoEnabled = undoRedo.enabled && !isSubAgentView

  const branchesAtTurn = useStable(undoRedo.branchesAtTurn)
  const restoreToHere = useStable(undoEnabled ? undoRedo.requestUndo : undefined)
  const openBranches = useStable(actions.handleOpenBranches)
  const branchFromHere = useStable(actions.handleBranchFromHere)
  const editCommand = useStable(actions.handleEditCommand)
  const expandCommand = useStable(actions.handleExpandCommand)
  const addComposerContext = useStable(actions.handleAddComposerContext)
  const openQuoteSource = useStable(actions.handleOpenQuoteSource)

  const facts = useMemo<TimelineRowFacts>(() => ({
    sessionId,
    sessionSource,
    cwd,
    isLive: live,
    isSubAgentView,
    turnCount,
    activeToolCallId,
    canSend: permissions.send,
    canAnswer: permissions.answer,
    openQuestionId,
    branches: undoRedo.branches,
    branchesAtTurn,
    restoreToHere,
    openBranches,
    branchFromHere,
    editCommand,
    expandCommand,
    addComposerContext,
    openQuoteSource,
  }), [
    sessionId, sessionSource, cwd, live, isSubAgentView, turnCount, activeToolCallId, permissions.send, permissions.answer,
    openQuestionId, undoRedo.branches, branchesAtTurn, restoreToHere, openBranches, branchFromHere,
    editCommand, expandCommand, addComposerContext, openQuoteSource,
  ])
  const status = useMemo(() => ({ live, working }), [live, working])

  return (
    <DisclosureProvider sessionKey={sessionKey}>
      <RowFactsContext.Provider value={facts}>
        <LiveStatusContext.Provider value={status}>
          {children}
        </LiveStatusContext.Provider>
      </RowFactsContext.Provider>
    </DisclosureProvider>
  )
}
