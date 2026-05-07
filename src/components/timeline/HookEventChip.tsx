import { memo, useState } from "react"
import { ChevronRight, ChevronDown, Webhook, AlertCircle } from "lucide-react"
import type { ParsedHookEvent } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Props {
  events: ParsedHookEvent[]
}

const TERMINAL_EVENTS = new Set(["StopFailure", "PermissionDenied", "PostToolUseFailure"])

export const HookEventChip = memo(function HookEventChip({ events }: Props) {
  const [open, setOpen] = useState(false)
  if (events.length === 0) return null
  const hasError = events.some(
    (e) => TERMINAL_EVENTS.has(e.eventName) || (e.exitCode !== undefined && e.exitCode !== 0)
  )
  const Chev = open ? ChevronDown : ChevronRight
  return (
    <div
      className={cn(
        "py-1 px-2 my-1 rounded text-[11px]",
        hasError ? "bg-red-950/15" : "bg-elevation-0/40"
      )}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full text-left text-muted-foreground hover:text-foreground"
      >
        <Chev className="w-3 h-3 shrink-0" />
        {hasError ? (
          <AlertCircle className="w-3 h-3 text-red-400" />
        ) : (
          <Webhook className="w-3 h-3" />
        )}
        <span className="font-mono">
          {events.length} hook event{events.length === 1 ? "" : "s"}
        </span>
        <span className="truncate text-muted-foreground/60">
          {events.map((e) => e.eventName).join(", ")}
        </span>
      </button>
      {open && (
        <ul className="mt-1 ml-5 space-y-0.5 font-mono">
          {events.map((e, i) => (
            <li key={i} className="text-muted-foreground/80">
              <span className="text-foreground">{e.eventName}</span>
              {e.toolName && <span> · {e.toolName}</span>}
              {e.source && <span className="text-muted-foreground/50"> ({e.source})</span>}
              {e.decision && <span className="text-amber-400"> → {e.decision}</span>}
              {e.durationMs !== undefined && (
                <span className="text-muted-foreground/50"> {e.durationMs}ms</span>
              )}
              {e.exitCode !== undefined && e.exitCode !== 0 && (
                <span className="text-red-400"> exit {e.exitCode}</span>
              )}
              {e.stderr && (
                <pre className="mt-0.5 ml-2 text-red-300/80 whitespace-pre-wrap">
                  {e.stderr.slice(0, 500)}
                </pre>
              )}
              {e.updatedToolOutput && (
                <span className="text-blue-400"> · output replaced by hook</span>
              )}
              {e.sessionTitle && (
                <span className="text-purple-400"> · title: {e.sessionTitle}</span>
              )}
              {e.worktreePath && (
                <span className="text-emerald-400"> · path: {e.worktreePath}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})
