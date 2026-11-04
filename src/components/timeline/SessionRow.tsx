import { useId, useState, type CSSProperties, type ReactNode } from "react"
import { ArrowUpRight, Bot, ChevronRight } from "lucide-react"
import type { AgentKind } from "@/lib/agents"
import { agentIcon, agentMarkColor } from "@/lib/agents/presentation"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

export type SessionRowState = "starting" | "working" | "needs-you" | "finished" | "failed" | "cancelled" | "started"

const STATES: Record<SessionRowState, { label: string; dot: string | null; text: string }> = {
  starting: { label: "Starting", dot: "bg-info", text: "text-info" },
  working: { label: "Working", dot: "bg-success", text: "text-success" },
  "needs-you": { label: "Needs you", dot: "bg-warning", text: "text-warning" },
  finished: { label: "Finished", dot: null, text: "text-muted-foreground" },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
  cancelled: { label: "Stopped", dot: null, text: "text-muted-foreground" },
  started: { label: "Started", dot: null, text: "text-muted-foreground" },
}

/** "1:54 AM" today, "Oct 6, 10:43 PM" on an earlier day. */
export function clockLabel(at: string | number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ""
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`
}

/** The provider's mark in a disc, in its brand color where it has one, with the session's state as a dot on its edge. */
function SessionAvatar({ kind, state }: { kind: AgentKind | null; state: SessionRowState }) {
  const Icon = kind ? agentIcon(kind) : Bot
  const { dot } = STATES[state]
  const brand = kind ? agentMarkColor(kind) : null
  return (
    <span
      aria-hidden="true"
      style={brand ? { "--mark": brand } as CSSProperties : undefined}
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full",
        brand
          ? "bg-[color-mix(in_oklab,var(--mark)_16%,transparent)] text-[var(--mark)] ring-1 ring-[color-mix(in_oklab,var(--mark)_35%,transparent)]"
          : "bg-muted text-foreground/85 ring-1 ring-border/70",
      )}
    >
      <Icon className="size-4" />
      {dot && <span data-session-dot={state} className={cn("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background", dot)} />}
    </span>
  )
}

interface SessionRowProps {
  kind: AgentKind | null
  state: SessionRowState
  title: string
  /** One line under the title: what it reported, or what it was asked. */
  preview?: string
  /** Replaces the state's own word, such as a live "Using Bash". */
  statusLabel?: string
  time?: string | number
  /** Opens the session itself. */
  onOpen?: () => void
  /** What the row unfolds to in place: the reply, or the brief. */
  detail?: ReactNode
  defaultOpen?: boolean
}

/**
 * A session this one started, or one reporting back to it: who it is (the
 * provider's mark), what it is called, the last thing worth reading, and
 * where it stands. A row with detail unfolds in place and opens the session
 * from its own button; one without opens the session when clicked.
 */
export function SessionRow({ kind, state, title, preview, statusLabel, time, onOpen, detail, defaultOpen = false }: SessionRowProps) {
  const [open, setOpen] = useState(defaultOpen)
  const detailId = useId()
  const { label, text } = STATES[state]
  const status = statusLabel ?? label
  const unfolds = detail !== undefined && detail !== null
  const clock = time === undefined ? "" : clockLabel(time)

  const body = (
    <>
      <SessionAvatar kind={kind} state={state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        {preview && <span className="truncate text-xs leading-5 text-muted-foreground">{preview}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2.5 text-xs">
        <span className={cn("max-w-40 truncate", text)}>{status}</span>
        {clock && <span className="hidden tabular-nums text-muted-foreground sm:inline">{clock}</span>}
      </span>
      {(unfolds || onOpen) && (
        <ChevronRight
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", unfolds && open && "rotate-90")}
        />
      )}
    </>
  )
  const rowClass = "flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <div data-session-row={state} className="group/session min-w-0">
      <div className="flex min-w-0 items-center gap-1">
        {unfolds ? (
          <button
            type="button"
            className={rowClass}
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`${title}, ${status}${preview ? `: ${preview}` : ""}`}
            onClick={() => setOpen(!open)}
          >
            {body}
          </button>
        ) : onOpen ? (
          <button type="button" className={rowClass} aria-label={`Open ${title}, ${status}`} onClick={onOpen}>
            {body}
          </button>
        ) : (
          <div className={cn(rowClass, "hover:bg-transparent")} aria-label={`${title}, ${status}`}>{body}</div>
        )}
        {unfolds && onOpen && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/session:opacity-100"
            aria-label={`Open ${title}`}
            title="Open session"
            onClick={onOpen}
          >
            <ArrowUpRight data-icon="inline-start" />
          </Button>
        )}
      </div>
      {unfolds && (
        <Collapsible open={open}>
          <CollapsibleContent id={detailId}>
            <div className="mb-2 ml-[52px] mr-2 min-w-0">{detail}</div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
