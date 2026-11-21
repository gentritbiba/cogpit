import { memo } from "react"
import { useDisclosure, useDisclosureKey } from "./disclosure"
import { ChevronRight, Webhook, AlertCircle } from "lucide-react"
import type { ParsedHookEvent } from "../../../shared/session/types"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

interface Props {
  events: ParsedHookEvent[]
}

const TERMINAL_EVENTS = new Set(["StopFailure", "PermissionDenied", "PostToolUseFailure"])

export const HookEventChip = memo(function HookEventChip({ events }: Props) {
  const [open, setOpen] = useDisclosure(useDisclosureKey("hooks"), false)
  if (events.length === 0) return null
  const hasError = events.some(
    (e) => TERMINAL_EVENTS.has(e.eventName) || (e.exitCode !== undefined && e.exitCode !== 0)
  )
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 text-xs">
      <CollapsibleTrigger
        className={cn(
          "group/tool flex min-h-8 pointer-fine:min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 py-0.5 text-left text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          hasError && "bg-destructive/5",
        )}
      >
        {hasError
          ? <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          : <Webhook className="size-3.5 shrink-0" aria-hidden="true" />}
        <span className="shrink-0">
          {events.length} hook event{events.length === 1 ? "" : "s"}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
          {events.map((e) => e.eventName).join(", ")}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-[transform,opacity] pointer-fine:opacity-0 pointer-fine:group-hover/tool:opacity-100 pointer-fine:group-focus-visible/tool:opacity-100",
            open && "rotate-90 pointer-fine:opacity-100",
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mb-1 ml-[15px] flex flex-col gap-0.5 border-l border-border/60 py-1 pl-4 font-mono">
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
