import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { ArrowUp, Pencil, X } from "lucide-react"
import type { CommandReceipt } from "../../shared/contracts/orchestration"
import type { Turn } from "../../shared/session/types"
import { getUserMessageText } from "../../shared/session/parser"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { conversationStateFor, EMPTY_CONVERSATION } from "@/lib/conversationState"
import { UserMessage } from "@/components/timeline/UserMessage"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

const noopSubscribe = () => () => {}
const emptySnapshot = () => EMPTY_CONVERSATION
const NO_TURNS: Turn[] = []
const NOT_STARTED = new Set<CommandReceipt["state"]>(["queued", "held", "dispatching", "delivered"])
const CLOCK_SKEW_MS = 2000

function isStartedAs(turn: Turn, command: CommandReceipt): boolean {
  return getUserMessageText(turn.userMessage).trim() === (command.message ?? "").trim()
}

/**
 * Commands that have not yet appeared as turns. A delivered command stays
 * until the transcript shows its turn, which can arrive before the queue's
 * next poll; a delivered steer joins the running turn instead of starting one.
 */
export function waitingCommands(commands: CommandReceipt[], turns: Turn[]): CommandReceipt[] {
  const shown = new Set<number>()
  return commands
    .filter((command) => NOT_STARTED.has(command.state) && (command.intent !== "steer" || command.state === "queued" || command.state === "held"))
    .sort((a, b) => a.position - b.position)
    .filter((command) => {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (Date.parse(turns[i]!.timestamp) < command.createdAt - CLOCK_SKEW_MS) break
        if (!shown.has(i) && isStartedAs(turns[i]!, command)) { shown.add(i); return false }
      }
      return true
    })
}

/** Keys by text and occurrence, so a message keeps its element when the optimistic copy hands over to the accepted command. */
function occurrenceKeys(messages: string[]): string[] {
  const seen = new Map<string, number>()
  return messages.map((message) => {
    const n = seen.get(message) ?? 0
    seen.set(message, n + 1)
    return `${message}#${n}`
  })
}

function QueuedMessage({ message, actions, editor, error }: { message: string; actions?: ReactNode; editor?: ReactNode; error?: string }) {
  return (
    <div className="group/queued rounded-lg border border-dashed border-border bg-prompt-surface p-3 transition-colors focus-within:border-ring">
      {editor ?? (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <UserMessage content={message} timestamp="" />
          </div>
          {/* Delayed so a message the agent picks up right away never flashes its controls. */}
          {actions && (
            <div className="motion-enter flex shrink-0 items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover/queued:opacity-100 sm:group-focus-within/queued:opacity-100" style={{ animationDelay: "400ms" }}>
              {actions}
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}

interface QueuedTurnsProps {
  /** Null while a new session is still being created. */
  sessionId: string | null
  turns?: Turn[]
  /** Messages sent from here that the server has not accepted yet. */
  pendingMessages: string[]
  canManage: boolean
  isMobile: boolean
}

export function QueuedTurns({ sessionId, turns = NO_TURNS, pendingMessages, canManage, isMobile }: QueuedTurnsProps) {
  const owner = useMemo(() => sessionId && canManage ? conversationStateFor(sessionId) : null, [sessionId, canManage])
  const state = useSyncExternalStore(owner?.subscribe ?? noopSubscribe, owner?.snapshot ?? emptySnapshot)
  const waiting = useMemo(() => waitingCommands(state.commands, turns), [state.commands, turns])
  const [editing, setEditing] = useState<{ id: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ id: string | null; message: string } | null>(null)

  if (!waiting.length && !pendingMessages.length) return null

  const canSteer = state.conversation ? descriptorFor(state.conversation.binding.agent).capabilities.midTurnSteering : false
  const movable = waiting.filter((command) => command.state === "queued" || command.state === "held").map((command) => command.id)
  const paused = waiting.find((command) => command.state === "held")
  const keys = occurrenceKeys([...waiting.map((command) => command.message ?? ""), ...pendingMessages])

  async function act(commandId: string | null, body: Record<string, unknown>) {
    if (!owner || !sessionId) return
    setBusy(true); setFailure(null)
    try { await owner.action({ ...body, sessionId }); setEditing(null) }
    catch (error) { setFailure({ id: commandId, message: error instanceof Error ? error.message : "Couldn't update the queue" }) }
    finally { setBusy(false) }
  }

  function moveUp(commandId: string) {
    const ids = [...movable]
    const index = ids.indexOf(commandId)
    if (index < 1) return
    ids.splice(index - 1, 2, ids[index]!, ids[index - 1]!)
    void act(commandId, { action: "reorder", commandIds: ids })
  }

  function saveEdit(commandId: string, message: string) {
    if (!message.trim()) return
    void act(commandId, { action: "edit", commandId, newCommandId: crypto.randomUUID(), message })
  }

  return (
    <section aria-label="Queued messages" className={cn("flex flex-col gap-2 py-5", !isMobile && "px-4")}>
      <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0">{paused ? "Queue paused" : "Queued"}</span>
        {paused?.error && <span className="min-w-0 truncate" title={paused.error}>{paused.error}</span>}
        {paused && canManage && <Button size="xs" variant="outline" className="ml-auto" disabled={busy} onClick={() => void act(null, { action: "resume" })}>Resume</Button>}
      </div>
      {failure?.id === null && <p className="text-xs text-destructive">{failure.message}</p>}
      {waiting.map((command, i) => {
        const message = command.message ?? ""
        const draft = editing?.id === command.id ? editing.message : null
        const manageable = canManage && (command.state === "queued" || command.state === "held")
        return (
          <QueuedMessage
            key={keys[i]}
            message={message}
            error={failure?.id === command.id ? failure.message : undefined}
            actions={manageable && draft === null && <>
              {movable.indexOf(command.id) > 0 && (
                <Button size="icon-xs" variant="ghost" aria-label="Move up" title="Move up" disabled={busy} onClick={() => moveUp(command.id)}><ArrowUp /></Button>
              )}
              <Button size="icon-xs" variant="ghost" aria-label="Edit" title="Edit" disabled={busy} onClick={() => setEditing({ id: command.id, message })}><Pencil /></Button>
              <Button size="icon-xs" variant="ghost" aria-label="Remove from queue" title="Remove from queue" disabled={busy} onClick={() => void act(command.id, { action: "cancel", commandId: command.id })}><X /></Button>
              <Button
                size="xs"
                variant="ghost"
                title={canSteer ? "Add this to the current turn" : "Stop the current turn and send this now"}
                disabled={busy}
                onClick={() => void act(command.id, { action: canSteer ? "steer" : "restart", commandId: command.id, newCommandId: crypto.randomUUID() })}
              >
                Send now
              </Button>
            </>}
            editor={draft !== null ? (
              <form onSubmit={(event) => { event.preventDefault(); saveEdit(command.id, draft) }}>
                <Textarea
                  aria-label="Edit queued message"
                  autoFocus
                  value={draft}
                  className="min-h-0 resize-none rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 md:text-sm"
                  onChange={(event) => setEditing({ id: command.id, message: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setEditing(null)
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); saveEdit(command.id, draft) }
                  }}
                />
                <div className="mt-2 flex justify-end gap-1">
                  <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button type="submit" size="xs" disabled={busy || !draft.trim()}>Save</Button>
                </div>
              </form>
            ) : undefined}
          />
        )
      })}
      {pendingMessages.map((message, i) => <QueuedMessage key={keys[waiting.length + i]} message={message} />)}
    </section>
  )
}
