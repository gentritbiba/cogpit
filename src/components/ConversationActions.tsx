import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { ProviderInstance } from "../../shared/contracts/orchestration"
import { AGENT_KINDS, descriptorFor, type AgentKind } from "@/lib/agents"
import { authFetch } from "@/lib/auth"
import { conversationStateFor } from "@/lib/conversationState"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export function ConversationActions({ sessionId, onOpen, open, onOpenChange }: { sessionId: string; onOpen: (dirName: string, fileName: string) => void; open: boolean; onOpenChange: (open: boolean) => void }) {
  const owner = useMemo(() => conversationStateFor(sessionId), [sessionId])
  const state = useSyncExternalStore(owner.subscribe, owner.snapshot)
  const [instances, setInstances] = useState<ProviderInstance[]>([])
  const [target, setTarget] = useState(AGENT_KINDS.at(-1)! as string)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [recoveredSessionId, setRecoveredSessionId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const attempt = useRef<{ id: string; payload: string } | null>(null)
  const [pendingDestination, setPendingDestination] = useState<{ dirName: string; fileName: string; epoch: number } | null>(null)
  const [closeCompleted, setCloseCompleted] = useState(!open)
  const ownerEpoch = useRef(0)
  useEffect(() => { if (open) setCloseCompleted(false) }, [open])
  useEffect(() => {
    const epoch = ++ownerEpoch.current
    const controller = new AbortController()
    void authFetch("/api/provider-instances", { signal: controller.signal }).then(async (response) => { if (response.ok) { const data = await response.json() as { instances: ProviderInstance[] }; if (epoch === ownerEpoch.current) setInstances(data.instances.filter((instance) => !instance.retired)) } }).catch(() => {})
    return () => { ownerEpoch.current = epoch + 1; controller.abort() }
  }, [sessionId])
  useEffect(() => {
    if (!closeCompleted || !pendingDestination || pendingDestination.epoch !== ownerEpoch.current) return
    setPendingDestination(null)
    onOpen(pendingDestination.dirName, pendingDestination.fileName)
  }, [closeCompleted, pendingDestination, onOpen])
  async function transition(mode: "resume" | "handoff") {
    if (!state.conversation) return
    const epoch = ownerEpoch.current
    const instance = instances.find((value) => value.id === target)
    const binding = state.conversation.binding
    const body = { sessionId, expectedRevision: state.conversation.revision, mode, agent: mode === "resume" ? binding.agent : instance?.agent ?? target as AgentKind, instanceId: mode === "resume" ? binding.instanceId : instance?.id ?? "default", message }
    const payload = JSON.stringify(body)
    if (!attempt.current || attempt.current.payload !== payload) attempt.current = { id: crypto.randomUUID(), payload }
    setBusy(true); setError(null)
    try {
      const response = await authFetch("/api/conversation-transition", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, commandId: attempt.current.id }) })
      const result = await response.json() as { error?: string; dirName?: string; fileName?: string }
      if (epoch !== ownerEpoch.current) return
      if (!response.ok) throw new Error(result.error || "Provider handoff failed")
      if (result.dirName && result.fileName) setPendingDestination({ dirName: result.dirName, fileName: result.fileName, epoch })
      onOpenChange(false); attempt.current = null
    } catch (cause) { if (epoch === ownerEpoch.current) setError(cause instanceof Error ? cause.message : "Provider handoff failed") } finally { if (epoch === ownerEpoch.current) setBusy(false) }
  }
  async function resolveHandoff(confirmNotCreated = false) {
    if (!state.pendingTransition) return
    if (confirmNotCreated && !window.confirm("Confirm you inspected the target provider’s history and no session was created for this handoff. This releases the conversation so you can start a new handoff.")) return
    const epoch = ownerEpoch.current
    setBusy(true); setError(null)
    try {
      const response = await authFetch("/api/conversation-transition", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resolve", sessionId, commandId: state.pendingTransition.id, confirmNotCreated, targetSessionId: confirmNotCreated ? undefined : recoveredSessionId || state.pendingTransition.sessionId }) })
      const result = await response.json() as { error?: string; dirName?: string; fileName?: string }
      if (epoch !== ownerEpoch.current) return
      if (!response.ok) throw new Error(result.error || "Handoff reconciliation failed")
      attempt.current = null
      window.dispatchEvent(new Event("cogpit-command-accepted"))
      if (result.dirName && result.fileName) onOpen(result.dirName, result.fileName)
    } catch (cause) { if (epoch === ownerEpoch.current) setError(cause instanceof Error ? cause.message : "Handoff reconciliation failed") } finally { if (epoch === ownerEpoch.current) setBusy(false) }
  }
  return <div className="flex flex-col gap-2 px-3 empty:hidden">
    {state.conversation && state.conversation.binding.sessionId !== sessionId && state.currentAddress && <Button size="xs" variant="outline" onClick={() => onOpen(state.currentAddress!.dirName, state.currentAddress!.fileName)}>Open current conversation session</Button>}
    {state.pendingTransition && <Alert><AlertDescription className="flex flex-col gap-2"><p>A provider handoff needs reconciliation. Inspect the target provider’s history before choosing a recovery action.</p><Input aria-label="Recovered session ID" placeholder={state.pendingTransition.sessionId || "Native session ID found in history"} value={recoveredSessionId} onChange={(event) => setRecoveredSessionId(event.target.value)} /><Button size="xs" disabled={busy || !(recoveredSessionId || state.pendingTransition.sessionId)} onClick={() => void resolveHandoff()}>Attach recovered session</Button><Button size="xs" variant="outline" disabled={busy} onClick={() => void resolveHandoff(true)}>Confirm no session was created</Button></AlertDescription></Alert>}
    <Dialog open={open} onOpenChange={(next) => { if (next) setCloseCompleted(false); onOpenChange(next) }} onOpenChangeComplete={(isOpen) => {
      setCloseCompleted(!isOpen)
    }}><DialogContent><DialogHeader><DialogTitle>Continue this conversation</DialogTitle><DialogDescription>Native resume keeps the current provider and account. Context handoff starts a new native session with up to 12 recent turns and 24,000 characters of text context. Files remain in the same project.</DialogDescription></DialogHeader><FieldDescription>Conversation: {state.conversation?.id || "Loading…"}</FieldDescription>{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}<FieldGroup>
      <Field><FieldLabel>Target provider or account</FieldLabel><Select value={target} onValueChange={(value) => value && setTarget(value)}><SelectTrigger aria-label="Handoff provider"><SelectValue>{instances.find((instance) => instance.id === target)?.label || descriptorFor(target as AgentKind)?.displayName}</SelectValue></SelectTrigger><SelectContent><SelectGroup>{AGENT_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{descriptorFor(kind).displayName} · Default profile</SelectItem>)}{instances.map((instance) => <SelectItem key={instance.id} value={instance.id}>{instance.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      <Field><FieldLabel htmlFor="handoff-message">Next request</FieldLabel><Input id="handoff-message" value={message} onChange={(event) => setMessage(event.target.value)} /><FieldDescription>Tool state and permissions are established by the new provider.</FieldDescription></Field>
      <Button disabled={busy || !state.conversation} onClick={() => void transition("handoff")}>Start context handoff</Button><Button variant="outline" disabled={busy || !state.conversation} onClick={() => void transition("resume")}>Keep current native session</Button>
    </FieldGroup></DialogContent></Dialog>
    {!open && error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>
}
