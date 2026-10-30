import { EMPTY_DRAFT, isDraftEmpty, type ComposerDraft } from "../../../shared/session/composerContext"

export interface UnsentMessage { id: string; draft: ComposerDraft; pending: boolean }
interface RecoverySnapshot { draft: ComposerDraft; revision: number; messages: UnsentMessage[] }
const recoveries = new Map<string, UnsentRecovery>()

class UnsentRecovery {
  private listeners = new Set<() => void>()
  private snapshot: RecoverySnapshot = { draft: structuredClone(EMPTY_DRAFT), revision: 0, messages: [] }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(snapshot: RecoverySnapshot) { this.snapshot = snapshot; this.listeners.forEach((listener) => listener()) }
  edit(draft: ComposerDraft) {
    if (JSON.stringify(draft) === JSON.stringify(this.snapshot.draft)) return
    this.publish({ ...this.snapshot, draft: structuredClone(draft), revision: this.snapshot.revision + 1 })
  }
  capture(draft: ComposerDraft): string {
    const id = crypto.randomUUID()
    this.publish({ ...this.snapshot, messages: [...this.snapshot.messages, { id, draft: structuredClone(draft), pending: true }] })
    return id
  }
  settle(id: string, accepted: boolean, clearedRevision: number): ComposerDraft | null {
    const message = this.snapshot.messages.find((item) => item.id === id)
    if (!message) return null
    const restore = !accepted && this.snapshot.revision === clearedRevision && isDraftEmpty(this.snapshot.draft)
    this.publish({ ...this.snapshot, ...(restore ? { draft: structuredClone(message.draft), revision: this.snapshot.revision + 1 } : {}), messages: accepted || restore ? this.snapshot.messages.filter((item) => item.id !== id) : this.snapshot.messages.map((item) => item.id === id ? { ...item, pending: false } : item) })
    return restore ? structuredClone(message.draft) : null
  }
  restore(id: string): ComposerDraft | null {
    const message = this.snapshot.messages.find((item) => item.id === id)
    if (!message || message.pending || !isDraftEmpty(this.snapshot.draft)) return null
    this.publish({ draft: structuredClone(message.draft), revision: this.snapshot.revision + 1, messages: this.snapshot.messages.filter((item) => item.id !== id) })
    return structuredClone(message.draft)
  }
}

export function unsentRecovery(scope: string) {
  let recovery = recoveries.get(scope)
  if (!recovery) { recovery = new UnsentRecovery(); recoveries.set(scope, recovery) }
  return recovery
}
export function resetUnsentRecoveriesForTest() { recoveries.clear() }

export function downloadUnsentBackup(draft: ComposerDraft) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url; link.download = "cogpit-unsent-message.json"; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
