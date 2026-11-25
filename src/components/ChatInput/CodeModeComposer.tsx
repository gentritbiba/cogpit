import { SquareTerminal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { descriptorFor, type AgentKind } from "@/lib/agents"
import { codeModeAvailable, resumeInCodeMode, showCodeModeTerminal, useCanRunCodeMode } from "@/lib/agents/codeMode"

interface CodeModeComposerProps {
  sessionId: string
  agentKind: AgentKind
  cwd: string | null
  /** A terminal here is running the session right now. */
  running: boolean
}

/**
 * Stands in for the composer on a session that runs in Code Mode, which the
 * agent CLI continues only in its own terminal: it points at that terminal,
 * or opens one where the terminal panel can.
 */
export function CodeModeComposer({ sessionId, agentKind, cwd, running }: CodeModeComposerProps) {
  const canRun = useCanRunCodeMode() && codeModeAvailable(agentKind, sessionId)
  const { displayName } = descriptorFor(agentKind)

  return (
    <div className="px-3 pt-1 pb-3">
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-input bg-popover px-4 py-3 text-sm shadow-lg shadow-black/5">
        <SquareTerminal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-muted-foreground">
          {running
            ? `${displayName} is running this session in the terminal. Type there; the chat follows along.`
            : `This session was started for Code Mode, which only runs in ${displayName}'s own terminal.`}
          {!canRun && " Continue it from the terminal panel on a computer."}
        </p>
        {canRun && running && (
          <Button size="sm" variant="outline" onClick={() => showCodeModeTerminal(sessionId)}>Show terminal</Button>
        )}
        {canRun && !running && cwd && (
          <Button size="sm" onClick={() => resumeInCodeMode(agentKind, sessionId, cwd)}>Continue in terminal</Button>
        )}
      </div>
    </div>
  )
}
