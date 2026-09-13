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

export function ToolCallStatus({ toolCall, failed = Boolean(toolCall.isError), isAgentActive }: { toolCall: ToolCall; failed?: boolean; isAgentActive?: boolean }) {
  const pending = toolCall.result === null
  const running = pending && isAgentActive && !failed
  const Icon = failed ? XCircle : running ? Loader2 : pending ? Clock3 : Check
  const label = failed ? "Failed" : running ? "Running" : pending ? "No result" : "Completed"
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground", failed && "text-destructive", running && "text-info")} title={label}>
      <Icon role="img" aria-label={`Tool call ${failed ? "failed" : running ? "running" : pending ? "has no result" : "completed"}`} className={cn("size-3.5", running && "motion-safe:animate-spin")} />
      <span className={cn(!failed && !pending && "sr-only")}>{label}</span>
    </span>
  )
}
