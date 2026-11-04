import {
  CircleHelp, FileSearch, FileText, Globe, ListTodo,
  MessageSquare, Network, Pencil, Plug, Search, Sparkles, Terminal, Users,
} from "lucide-react"
import type { ToolCall } from "../../../shared/session/types"
import { cn } from "@/lib/utils"

export function ToolOperationIcon({ styleName }: { styleName: string }) {
  const Icon = ({
    Read: FileText, Write: Pencil, Edit: Pencil, Bash: Terminal,
    Grep: Search, Glob: FileSearch, WebFetch: Globe, WebSearch: Globe,
    TodoWrite: ListTodo, Task: Users, SendMessage: MessageSquare,
    AskUserQuestion: CircleHelp, Skill: Sparkles, Crew: Network,
  })[styleName] ?? Plug
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />
}

const TOOL_STATUS = {
  failed: { label: "Failed", visible: true },
  awaitingReview: { label: "Awaiting review", visible: true },
  running: { label: "Running", visible: false },
  unavailable: { label: "No result", visible: true },
  completed: { label: "Completed", visible: false },
}

function statusFor(toolCall: ToolCall, failed: boolean, isAgentActive?: boolean): keyof typeof TOOL_STATUS {
  if (failed) return "failed"
  if (toolCall.awaitingReview) return "awaitingReview"
  if (toolCall.result !== null) return "completed"
  return isAgentActive ? "running" : "unavailable"
}

/**
 * Where a call stands, in words. A running or completed call reads from the
 * row's icon and verb, so only a failure, a call held for review and one that
 * never got a result are drawn.
 */
export function ToolCallStatus({ toolCall, failed = Boolean(toolCall.isError), isAgentActive }: { toolCall: ToolCall; failed?: boolean; isAgentActive?: boolean }) {
  const status = statusFor(toolCall, failed, isAgentActive)
  const { label, visible } = TOOL_STATUS[status]
  return (
    <span data-tool-status={status} className={cn("shrink-0 text-xs text-muted-foreground", failed && "text-destructive", !visible && "sr-only")}>
      {label}
    </span>
  )
}
