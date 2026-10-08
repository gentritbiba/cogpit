import { useContext, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { Check, CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSessionChatContextOptional, useSessionContextOptional } from "@/contexts/SessionContext"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { deviceScopedKey } from "@/lib/device"
import { cn } from "@/lib/utils"
import { CogpitBlockScope, type CogpitBlockKind } from "./kinds"
import {
  decisionsMessage,
  parseCogpitBlock,
  type ChecklistBlock,
  type ChecklistState,
  type DecisionsBlock,
  type StatusBlock,
} from "./parse"

/**
 * A block an agent declared in its reply, drawn as what it describes. Loaded
 * on demand with its parser; a block that does not read as its kind shows
 * as the code it is.
 */
export default function CogpitBlock({ kind, source, occurrence = "0", fallback }: { kind: CogpitBlockKind; source: string; occurrence?: string; fallback: ReactNode }) {
  const block = useMemo(() => parseCogpitBlock(kind, source), [kind, source])
  if (!block) return <>{fallback}</>
  switch (block.kind) {
    case "status": return <StatusView block={block} />
    case "checklist": return <ChecklistView block={block} />
    case "decisions": return <DecisionsView block={block} source={source} occurrence={occurrence} />
  }
}

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} data-cogpit-block className="my-3 rounded-lg border border-border bg-card p-3 text-sm">
      {children}
    </section>
  )
}

const TONE: Record<string, string> = { warning: "text-warning", danger: "text-destructive", success: "text-success" }

function StatusView({ block }: { block: StatusBlock }) {
  const { progress } = block
  const percent = progress ? Math.round((progress.done / progress.total) * 100) : null
  return (
    <Frame label={block.title ?? "Status"}>
      {block.title && <h4 className="mb-2 text-[13.5px] font-medium">{block.title}</h4>}
      {progress && (
        <div className="mb-2.5">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label={`${progress.done} of ${progress.total} done`}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-foreground" style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-xs tabular-nums text-muted-foreground">
            <span>{progress.done} of {progress.total} done</span>
            <span>{percent}%</span>
          </div>
        </div>
      )}
      {block.values.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
          {block.values.map((entry) => (
            <div key={entry.label} className="flex justify-between gap-3 border-t border-border/70 py-1.5 text-[12.5px]">
              <dt className={cn("text-muted-foreground", entry.tone && TONE[entry.tone])}>{entry.label}</dt>
              <dd className={cn("text-right tabular-nums", entry.tone && TONE[entry.tone])}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Frame>
  )
}

const CHECK: Record<ChecklistState, { mark: ReactNode; ring: string; text: string; label: string }> = {
  done: { mark: <Check className="size-2.5" />, ring: "border-success text-success", text: "text-muted-foreground line-through decoration-muted-foreground/50", label: "Done" },
  doing: { mark: null, ring: "border-success bg-success/25", text: "", label: "In progress" },
  blocked: { mark: <CircleAlert className="size-2.5" />, ring: "border-warning text-warning", text: "text-warning", label: "Blocked" },
  skipped: { mark: null, ring: "border-dashed border-muted-foreground/60", text: "text-muted-foreground line-through", label: "Skipped" },
  todo: { mark: null, ring: "border-muted-foreground/60", text: "", label: "To do" },
}

function ChecklistView({ block }: { block: ChecklistBlock }) {
  const done = block.items.filter((item) => item.state === "done").length
  return (
    <Frame label={block.title ?? "Checklist"}>
      <div className="mb-1.5 flex items-baseline gap-2">
        {block.title && <h4 className="text-[13.5px] font-medium">{block.title}</h4>}
        <span className="text-xs tabular-nums text-muted-foreground">{done} of {block.items.length}</span>
      </div>
      <ul className="flex flex-col">
        {block.items.map((item, index) => {
          const look = CHECK[item.state]
          return (
            <li key={`${index}:${item.text}`} className="flex items-center gap-2.5 py-1 text-[13px]">
              <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px]", look.ring)} aria-label={look.label} role="img">
                {look.mark}
              </span>
              <span className={cn("min-w-0 flex-1", look.text)}>{item.text}</span>
              {item.note && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{item.note}</span>}
            </li>
          )
        })}
      </ul>
    </Frame>
  )
}

/** A short stable key for a block's text, so its answers survive a reload. */
function blockKey(source: string): string {
  let hash = 5381
  for (let index = 0; index < source.length; index++) hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0
  return (hash >>> 0).toString(36)
}

interface DecisionsState {
  answers: Record<string, string>
  sentAt: number | null
}

function DecisionsView({ block, source, occurrence }: { block: DecisionsBlock; source: string; occurrence: string }) {
  const session = useSessionContextOptional()
  const chat = useSessionChatContextOptional()
  const scope = useContext(CogpitBlockScope)
  const sessionId = session?.session?.sessionId ?? "none"
  // A later reply that repeats the same questions asks them again.
  const [stored, setStored] = useLocalStorage<DecisionsState>(
    deviceScopedKey(`cogpit-decisions:${sessionId}:${blockKey(`${scope?.messageKey ?? ""}\n${occurrence}\n${source}`)}`),
    { answers: {}, sentAt: null },
  )
  const state: DecisionsState = stored ?? { answers: {}, sentAt: null }
  const [current, setCurrent] = useState(0)
  const [reopened, setReopened] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState(false)
  // A second ⌘Enter while the first send is in flight must not send twice.
  const inFlight = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const canSend = Boolean(chat) && session?.permissions.send !== false && state.sentAt === null && !sending
  const answered = block.decisions.filter((decision) => state.answers[decision.id]).length

  const choose = (id: string, option: string) => {
    if (!canSend || inFlight.current) return
    setStored({ ...state, answers: { ...state.answers, [id]: option } })
    setReopened((open) => {
      const next = new Set(open)
      next.delete(id)
      return next
    })
    const nextOpen = block.decisions.findIndex((decision, index) => index > current && !state.answers[decision.id] && decision.id !== id)
    if (nextOpen >= 0) setCurrent(nextOpen)
  }

  const send = async () => {
    if (!chat || !canSend || answered === 0 || inFlight.current) return
    inFlight.current = true
    setSending(true)
    setError(null)
    const sent = await chat.chat.sendMessage(decisionsMessage(block.decisions, state.answers)).catch(() => false)
    inFlight.current = false
    setSending(false)
    if (sent) setStored({ ...state, sentAt: Date.now() })
    else setError("Couldn't send the answers. Try again from the composer if this keeps happening.")
  }
  // A click inside a decision answers it; it must not also make it the current one again.
  const inRow = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation()
    action()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const decision = block.decisions[current]
    if (!decision) return
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault()
      void send()
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setCurrent((index) => Math.max(0, Math.min(block.decisions.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))))
    } else if (event.key === "Enter" && decision.recommended && event.target === event.currentTarget) {
      event.preventDefault()
      choose(decision.id, decision.recommended)
    } else if (/^[1-9]$/.test(event.key) && decision.options[Number(event.key) - 1]) {
      event.preventDefault()
      choose(decision.id, decision.options[Number(event.key) - 1]!)
    }
  }

  const heading = block.title ?? `${block.decisions.length} ${block.decisions.length === 1 ? "decision" : "decisions"}`
  return (
    <section
      aria-label={heading}
      data-cogpit-block
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="my-3 rounded-lg border border-border bg-card p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5">
        <h4 className="text-[13.5px] font-medium">{heading}</h4>
        <span className="text-xs text-muted-foreground">
          {state.sentAt ? "Sent" : "Answer in any order; your answers go back as one message."}
        </span>
      </div>
      <ol className="flex flex-col">
        {block.decisions.map((decision, index) => {
          const answer = state.answers[decision.id]
          const open = !answer || reopened.has(decision.id)
          return (
            <li
              key={decision.id}
              data-decision={decision.id}
              onClick={() => setCurrent(index)}
              className={cn(
                "grid grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 gap-y-1 border-t border-border/70 py-2.5 first:border-t-0",
                index === current && canSend && "rounded-md bg-accent/40",
              )}
            >
              <span className="pt-px text-right text-[11px] tabular-nums text-muted-foreground/80">{index + 1}</span>
              <span className={cn("text-[13px]", open ? "font-medium" : "text-muted-foreground")}>{decision.question}</span>
              {decision.detail && open && <span className="col-start-2 text-xs text-muted-foreground">{decision.detail}</span>}
              {open ? (
                <span className="col-start-2 mt-1 flex flex-wrap items-center gap-1.5">
                  {decision.options.map((option, optionIndex) => (
                    <Button
                      key={option}
                      type="button"
                      size="xs"
                      variant={answer === option ? "default" : "outline"}
                      aria-pressed={answer === option}
                      aria-keyshortcuts={optionIndex < 9 ? String(optionIndex + 1) : undefined}
                      disabled={!canSend}
                      onClick={inRow(() => choose(decision.id, option))}
                    >
                      {option}
                      {option === decision.recommended && <span className="font-normal opacity-60">recommended</span>}
                    </Button>
                  ))}
                </span>
              ) : (
                <span className="col-start-2 flex items-center gap-2 text-[12.5px] text-success">
                  <Check className="size-3.5" aria-hidden="true" />
                  {answer}
                  {canSend && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground"
                      onClick={inRow(() => {
                        setReopened((ids) => new Set(ids).add(decision.id))
                        setCurrent(index)
                      })}
                    >
                      Change
                    </Button>
                  )}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      {state.sentAt === null && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-border/70 pt-2.5 text-xs text-muted-foreground">
          <span className="tabular-nums">{answered} of {block.decisions.length} answered</span>
          <span className="flex-1" />
          {canSend && <span className="hidden sm:inline">1–9 picks · Enter takes the recommended · ⌘Enter sends</span>}
          <Button type="button" size="xs" disabled={!canSend || answered === 0 || sending} onClick={() => void send()}>
            {answered === block.decisions.length ? "Send answers" : `Send ${answered} ${answered === 1 ? "answer" : "answers"}`}
          </Button>
        </div>
      )}
    </section>
  )
}
