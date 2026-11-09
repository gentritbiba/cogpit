import { Flag } from "lucide-react"
import type { ReactNode } from "react"
import { capabilitiesFor, type AgentKind } from "@/lib/agents"
import type { TranscriptGoalState } from "../../../shared/session/sessionDigest"
import { useOpenSession } from "@/contexts/SessionContext"
import { Button } from "@/components/ui/button"
import { ThreadGoalProvider } from "./ThreadGoalProvider"
import { TranscriptGoalProvider } from "./TranscriptGoalProvider"
import { useGoalControls } from "./context"

interface GoalProviderProps {
  agentKind: AgentKind
  sessionId: string
  /** Resolves false when the session refused the command. */
  onSendCommand: (command: string) => Promise<boolean>
  children: ReactNode
}

/** Owns the session's long-running goal so the composer can place its two
 *  pieces independently: a full-width row above the input, and a compact
 *  trigger that lives inline with the other composer settings. */
function sameGoal(a: TranscriptGoalState | null, b: TranscriptGoalState | null): boolean {
  return a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b))
}

export function GoalProvider({ agentKind, sessionId, onSendCommand, children }: GoalProviderProps) {
  const goals = capabilitiesFor(agentKind).goals
  const transcriptGoal = useOpenSession((open) => open?.digest.goal ?? null, sameGoal)
  if (goals === "thread-api") {
    return (
      <ThreadGoalProvider agentKind={agentKind} threadId={sessionId}>
        {children}
      </ThreadGoalProvider>
    )
  }
  if (goals === "transcript") {
    return (
      <TranscriptGoalProvider agentKind={agentKind} goal={transcriptGoal} onSendCommand={onSendCommand}>
        {children}
      </TranscriptGoalProvider>
    )
  }
  return children
}

/** The goal row. Renders nothing until a goal exists or is being edited, so an
 *  empty goal never costs the composer a row of vertical space. */
export function GoalSection() {
  return useGoalControls().section
}

/** Compact "Set goal" chip for the composer settings row. */
export function GoalTrigger() {
  const { canCreate, beginEditing } = useGoalControls()
  if (!canCreate) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={beginEditing}
      title="Set a long-running goal for this session"
    >
      <Flag data-icon="inline-start" />
      Set goal
    </Button>
  )
}
