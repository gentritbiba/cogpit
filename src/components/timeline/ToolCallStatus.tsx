import {
  Check, CircleHelp, Clock3, FileSearch, FileText, Globe, ListTodo,
  Loader2, MessageSquare, Pencil, Plug, Search, Sparkles, Terminal, Users, XCircle,
} from "lucide-react"
import type { ToolCall } from "../../../shared/session/types"
import { cn } from "@/lib/utils"

export function ToolOperationIcon({ styleName }: { styleName: string }) {
  const Icon = ({
    Read: FileText, Write: Pencil, Edit: Pencil, Bash: Terminal,
    Grep: Search, Glob: FileSearch, WebFetch: Globe, WebSearch: Globe,
    TodoWrite: ListTodo, Task: Users, SendMessage: MessageSquare,
    AskUserQuestion: CircleHelp, Skill: Sparkles,
  })[styleName] ?? Plug
  return <Icon className="size-4 shrink-0" aria-hidden="true" />
}

const TOOL_STATUS = {
  failed: { Icon: XCircle, label: "Failed", description: "failed" },
  awaitingReview: { Icon: Clock3, label: "Awaiting review", description: "awaiting review" },
  running: { Icon: Loader2, label: "Running", description: "running" },
  unavailable: { Icon: Clock3, label: "No result", description: "has no result" },
  completed: { Icon: Check, label: "Completed", description: "completed" },
}

function statusFor(toolCall: ToolCall, failed: boolean, isAgentActive?: boolean): keyof typeof TOOL_STATUS {
  if (failed) return "failed"
  if (toolCall.awaitingReview) return "awaitingReview"
  if (toolCall.result !== null) return "completed"
  return isAgentActive ? "running" : "unavailable"
}

export function ToolCallStatus({ toolCall, failed = Boolean(toolCall.isError), isAgentActive }: { toolCall: ToolCall; failed?: boolean; isAgentActive?: boolean }) {
  const status = statusFor(toolCall, failed, isAgentActive)
  const { Icon, label, description } = TOOL_STATUS[status]
  const running = status === "running"
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground", failed && "text-destructive", running && "text-info")} title={label}>
      <Icon role="img" aria-label={`Tool call ${description}`} className={cn("size-3.5", running && "motion-safe:animate-spin")} />
      <span className={cn(status === "completed" && "sr-only")}>{label}</span>
    </span>
  )
}
