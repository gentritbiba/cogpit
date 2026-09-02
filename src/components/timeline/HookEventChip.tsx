import { memo, useState } from "react"
import { ChevronRight, ChevronDown, Webhook, AlertCircle } from "lucide-react"
import type { ParsedHookEvent } from "../../../shared/session/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

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
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "my-1 rounded-md border px-2 py-1 text-xs",
        hasError ? "border-destructive/20 bg-destructive/5" : "bg-muted/30"
      )}
    >
      <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="h-auto w-full justify-start px-0 py-0 text-left font-normal text-muted-foreground" />}>
        <Chev className="size-3 shrink-0" data-icon="inline-start" />
        {hasError ? (
          <AlertCircle className="size-3 text-destructive" data-icon="inline-start" />
        ) : (
          <Webhook className="size-3" data-icon="inline-start" />
        )}
        <span className="font-mono">
          {events.length} hook event{events.length === 1 ? "" : "s"}
        </span>
        <span className="truncate text-muted-foreground/60">
          {events.map((e) => e.eventName).join(", ")}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="ml-5 mt-1 flex flex-col gap-0.5 font-mono">
          {events.map((e, i) => (
            <li key={i} className="text-muted-foreground/80">
              <span className="text-foreground">{e.eventName}</span>
              {e.toolName && <span> · {e.toolName}</span>}
              {e.source && <span className="text-muted-foreground/50"> ({e.source})</span>}
              {e.decision && <span className="text-warning"> → {e.decision}</span>}
              {e.durationMs !== undefined && (
                <span className="text-muted-foreground/50"> {e.durationMs}ms</span>
              )}
              {e.exitCode !== undefined && e.exitCode !== 0 && (
                <span className="text-destructive"> exit {e.exitCode}</span>
              )}
              {e.stderr && (
                <pre className="ml-2 mt-0.5 whitespace-pre-wrap text-destructive">
                  {e.stderr.slice(0, 500)}
                </pre>
              )}
              {e.updatedToolOutput && (
                <span className="text-info"> · output replaced by hook</span>
              )}
              {e.sessionTitle && (
                <span className="text-foreground"> · title: {e.sessionTitle}</span>
              )}
              {e.worktreePath && (
                <span className="text-success"> · path: {e.worktreePath}</span>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
})
