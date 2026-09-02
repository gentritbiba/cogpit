import { Flag } from "lucide-react"
import type { ReactNode } from "react"
import { capabilitiesFor, type AgentKind } from "@/lib/agents"
import type { ParsedSession } from "../../../shared/session/types"
import { Button } from "@/components/ui/button"
import { ThreadGoalProvider } from "./ThreadGoalProvider"
import { TranscriptGoalProvider } from "./TranscriptGoalProvider"
import { useGoalControls } from "./context"

interface GoalProviderProps {
  agentKind: AgentKind
  session: ParsedSession
  onSendCommand: (command: string) => void
  children: ReactNode
}

/** Owns the session's long-running goal so the composer can place its two
 *  pieces independently: a full-width row above the input, and a compact
 *  trigger that lives inline with the other composer settings. */
export function GoalProvider({ agentKind, session, onSendCommand, children }: GoalProviderProps) {
  const goals = capabilitiesFor(agentKind).goals
  if (goals === "thread-api") {
    return (
      <ThreadGoalProvider agentKind={agentKind} threadId={session.sessionId}>
        {children}
      </ThreadGoalProvider>
    )
  }
  if (goals === "transcript") {
    return (
      <TranscriptGoalProvider agentKind={agentKind} session={session} onSendCommand={onSendCommand}>
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

/** Both pieces stacked, for the mobile settings sheet where there is no row. */
export function GoalControlsBlock() {
  return (
    <>
      <GoalSection />
      <GoalTrigger />
    </>
  )
}
