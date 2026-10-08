import { useMemo, useState, useSyncExternalStore } from "react"
import { conversationStateFor, EMPTY_CONVERSATION } from "@/lib/conversationState"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useSessionNamer } from "@/hooks/useSessionNamer"
import { taskWakeupSummary } from "@/lib/userMessageContent"

const noopSubscribe = () => () => {}
const emptySnapshot = () => EMPTY_CONVERSATION

/** Messages whose delivery failed or could not be confirmed. Waiting messages show in the timeline. */
export function ConversationQueue({ sessionId, readOnly = false }: { sessionId: string | null; readOnly?: boolean }) {
  const owner = useMemo(() => sessionId ? conversationStateFor(sessionId) : null, [sessionId])
  const state = useSyncExternalStore(owner?.subscribe ?? noopSubscribe, owner?.snapshot ?? emptySnapshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resending, setResending] = useState<string | null>(null)
  const nameOf = useSessionNamer()
  const commands = state.commands.filter((c) => c.state === "failed" || c.state === "unknown")
  async function action(body: Record<string, unknown>) {
    if (!owner || !sessionId || readOnly) return
    setBusy(true); setError(null)
    try { await owner.action({ ...body, sessionId }); setResending(null) }
    catch (error) { setError(error instanceof Error ? error.message : "Queue update failed") }
    finally { setBusy(false) }
  }
  if (!sessionId || (!commands.length && !error)) return null
  return <section className="flex max-h-72 flex-col gap-2 overflow-y-auto p-3" aria-label="Message delivery problems">
    {error && <Alert variant="destructive"><AlertTitle>Queue update failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {commands.map((command) => <div className="flex flex-col gap-2" key={command.id}>
      <div className="flex items-center gap-2">
        <Badge variant="destructive">{command.state}</Badge>
        <span className="min-w-0 flex-1 truncate" title={command.message}>{(command.message && taskWakeupSummary(command.message, nameOf)) || command.message || "Image attachment"}</span>
      </div>
      {command.error && <p className="text-sm text-muted-foreground">{command.error}</p>}
      {command.state === "unknown" && !readOnly && <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void action({ action: "resolve", commandId: command.id, disposition: "completed" })}>History confirms completion</Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void action({ action: "resolve", commandId: command.id, disposition: "failed" })}>History confirms failure</Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => setResending(command.id)}>Resend…</Button>
      </div>}
      {resending === command.id && <Alert><AlertTitle>This may send a duplicate</AlertTitle><AlertDescription>Review the conversation first. Cogpit could not confirm the original delivery.<Button size="xs" variant="destructive" disabled={busy} onClick={() => void action({ action: "resend", commandId: command.id, newCommandId: crypto.randomUUID(), confirmDuplicateRisk: true })}>Confirm resend</Button><Button size="xs" variant="ghost" onClick={() => setResending(null)}>Keep waiting</Button></AlertDescription></Alert>}
    </div>)}
  </section>
}
