import type { ReactNode } from "react"
import { ConversationActions } from "./ConversationActions"
import { ConversationQueue } from "./ConversationQueue"
import { DelegatedSessions } from "./DelegatedSessions"
import { BoardLine } from "./board/BoardLine"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"

interface ConversationComposerProps {
  sessionId: string | null
  readOnly: boolean
  onOpen: (dirName: string, fileName: string) => void
  handoffOpen: boolean
  onHandoffOpenChange: (open: boolean) => void
  /** Whether the Crew panel is on screen, which makes the crew line redundant. */
  crewOpen?: boolean
  onOpenCrew?: () => void
  children: ReactNode
}

export function ConversationComposer({ sessionId, readOnly, onOpen, handoffOpen, onHandoffOpenChange, crewOpen, onOpenCrew, children }: ConversationComposerProps) {
  // A crew shares its lead's board; a session in none shows its own.
  const crewRootId = useSessionInventoryOptional()?.sessions.find((session) => session.sessionId === sessionId)?.crew?.rootId
  return <div className="flex flex-col gap-2 rounded-t-xl bg-canvas/95 pt-2">
    <BoardLine boardSessionId={crewRootId ?? sessionId} />
    {sessionId && !readOnly && <ConversationActions key={`actions:${sessionId}`} sessionId={sessionId} onOpen={onOpen} open={handoffOpen} onOpenChange={onHandoffOpenChange} />}
    <ConversationQueue key={`queue:${sessionId ?? "pending"}`} sessionId={sessionId} readOnly={readOnly} />
    {sessionId && <DelegatedSessions key={`delegated:${sessionId}`} sessionId={sessionId} crewOpen={crewOpen} onOpenCrew={onOpenCrew} />}
    {children}
  </div>
}
