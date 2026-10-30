import type { CreatedComposerSession } from "@/lib/composerDraftIdentity"
import { z } from "zod"
import { deviceScopedKey } from "@/lib/device"
import { validateContext, EMPTY_DRAFT, isDraftEmpty, parseComposerMessage, renderComposerMessage, type ComposerDraft } from "../../../shared/session/composerContext"

export const MAX_ATTACHMENT_BYTES = 3_500_000
const attachment = z.object({ id: z.string().min(1), mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), data: z.string().min(1).max(MAX_ATTACHMENT_BYTES).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine((data) => data.length % 4 === 0), contextId: z.string().optional() }).strict()
const envelope = z.object({ v: z.literal(1), text: z.string(), context: z.array(z.unknown()), attachments: z.array(attachment) }).strict()

export function validateDraft(value: unknown): ComposerDraft {
  const parsed = envelope.parse(value)
  const draft = parsed as ComposerDraft
  if (draft.context.length) {
    const refusal = validateContext(draft.context)
    if (refusal) throw new Error(refusal)
    const decoded = parseComposerMessage(renderComposerMessage(draft))
    if (!decoded || decoded.context.length !== draft.context.length || decoded.context.some((item, i) => renderComposerMessage({ text: "", context: [item] }) !== renderComposerMessage({ text: "", context: [draft.context[i]!] }))) throw new Error("Invalid saved context")
    for (const item of draft.context) {
      if (item.kind === "browser" && !draft.attachments.some((image) => image.contextId === item.id)) throw new Error("The saved capture is missing its image bytes. Reattach the capture or restore a backup.")
    }
  }
  if (new Set(draft.attachments.map((image) => image.id)).size !== draft.attachments.length) throw new Error("Duplicate saved attachment")
  if (draft.attachments.some((image) => image.contextId && !draft.context.some((item) => item.id === image.contextId))) throw new Error("A saved image has lost its context. Restore a backup or reattach it.")
  return structuredClone(draft)
}

export function composerScope(cwd: string | null | undefined, identity: string): string {
  return JSON.stringify([deviceScopedKey("composer-v1"), cwd ?? "", identity])
}

export type SavedPrompt = { id: string; kind: "stash" | "sending" | "refused" | "sent"; savedAt: string; draft: ComposerDraft; createdTarget?: string }
export interface DraftRecord { v: 1; draft: ComposerDraft; entries: SavedPrompt[]; pendingUpload?: boolean }
export interface DraftSnapshot { record: DraftRecord; error: string | null; corrupt: string | null }
const schema = z.object({ v: z.literal(1), draft: z.unknown(), pendingUpload: z.boolean().optional(), entries: z.array(z.object({ id: z.string(), kind: z.enum(["stash", "sending", "refused", "sent"]), savedAt: z.string(), draft: z.unknown(), createdTarget: z.string().optional() }).strict()) }).strict()
const stores = new Map<string, DraftStore>()
const emptyRecord = (): DraftRecord => ({ v: 1, draft: structuredClone(EMPTY_DRAFT), entries: [] })

export class DraftStore {
  private listeners = new Set<() => void>()
  private snapshot: DraftSnapshot = { record: emptyRecord(), error: null, corrupt: null }
  constructor(readonly key: string, private storage: () => Storage = () => localStorage) { this.read() }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(snapshot: DraftSnapshot) { this.snapshot = snapshot; this.listeners.forEach((listener) => listener()) }
  read = () => {
    try {
      const raw = this.storage().getItem(this.key)
      if (raw === null) return
      try {
        const value = schema.parse(JSON.parse(raw))
        const record: DraftRecord = { v: 1, pendingUpload: value.pendingUpload, draft: validateDraft(value.draft), entries: value.entries.map((entry) => ({ ...entry, draft: validateDraft(entry.draft) })) }
        this.publish({ record, error: null, corrupt: null })
      } catch {
        this.publish({ ...this.snapshot, corrupt: raw, error: "Saved prompts are damaged or contain expired attachment references. Download the backup before resetting storage; your current draft is kept." })
      }
    } catch {
      this.publish({ ...this.snapshot, error: "Draft storage is unavailable. Keep this tab open, retry storage or download a backup." })
    }
  }
  private write(record: DraftRecord): boolean {
    if (this.snapshot.corrupt !== null) { this.publish({ ...this.snapshot, record }); return false }
    try {
      validateDraft(record.draft)
      record.entries.forEach((entry) => validateDraft(entry.draft))
      this.storage().setItem(this.key, JSON.stringify(record))
      this.publish({ record, error: null, corrupt: null })
      return true
    } catch (error) {
      this.publish({ record, corrupt: null, error: `Draft was kept in this tab but could not be saved (${error instanceof Error && error.name === "ZodError" ? "invalid or oversized attachment" : "storage denied, full, or invalid data"}). Retry or download a backup before leaving.` })
      return false
    }
  }
  markUpload(pendingUpload: boolean): boolean { return this.write({ ...this.snapshot.record, pendingUpload }) }
  saveDraft(draft: ComposerDraft): boolean {
    if (JSON.stringify(draft) === JSON.stringify(this.snapshot.record.draft)) return this.snapshot.error === null
    return this.write({ ...this.snapshot.record, draft: structuredClone(draft) })
  }
  save(draft: ComposerDraft, kind: SavedPrompt["kind"] = "stash"): string | null {
    if (isDraftEmpty(draft)) return null
    const id = crypto.randomUUID()
    const record = this.snapshot.record
    const entry: SavedPrompt = { id, kind, savedAt: new Date().toISOString(), draft: structuredClone(draft) }
    // A failed explicit save must leave the live draft and stash list unchanged.
    const saved = this.write({ ...record, draft: structuredClone(EMPTY_DRAFT), entries: [...record.entries, entry] })
    if (!saved) this.publish({ ...this.snapshot, record })
    return saved ? id : null
  }
  retainImport(text: string): boolean {
    const entry: SavedPrompt = { id: crypto.randomUUID(), kind: "stash", savedAt: new Date().toISOString(), draft: { v: 1, text, context: [], attachments: [] } }
    return this.write({ ...this.snapshot.record, entries: [...this.snapshot.record.entries, entry] })
  }
  created(id: string, identity: CreatedComposerSession): void {
    const [accountDevice] = JSON.parse(this.key) as [string]
    const target = JSON.stringify([accountDevice, identity.cwd, JSON.stringify([identity.dirName, identity.sessionId])])
    const record = this.snapshot.record
    this.write({ ...record, entries: record.entries.map((entry) => entry.id === id ? { ...entry, createdTarget: target } : entry) })
    this.transferAccepted(id)
  }
  private transferAccepted(id: string): void {
    const entry = this.snapshot.record.entries.find((item) => item.id === id)
    if (entry?.kind !== "sent" || !entry.createdTarget || entry.createdTarget === this.key) return
    const destination = draftStore(entry.createdTarget)
    const accepted = { ...entry, createdTarget: undefined }
    const targetRecord = destination.getSnapshot().record
    if (targetRecord.entries.some((item) => item.id === id) || destination.write({ ...targetRecord, entries: [...targetRecord.entries, accepted] })) this.remove(id)
    else this.publish({ ...this.snapshot, error: "The first prompt was sent, but recall could not be saved in the new session. Its complete journal is kept here; retry storage or download a backup." })
  }
  settle(id: string, sent: boolean): void {
    const record = this.snapshot.record
    const entry = record.entries.find((item) => item.id === id)
    if (!entry) return
    if (!sent && isDraftEmpty(record.draft)) {
      this.write({ ...record, draft: entry.draft, entries: record.entries.filter((item) => item.id !== id) })
    } else {
      const entries = record.entries.map((item) => item.id === id ? { ...item, kind: sent ? "sent" as const : "refused" as const } : item)
      const oldHistory = entries.filter((item) => item.kind === "sent").slice(0, -30)
      this.write({ ...record, entries: entries.filter((item) => !oldHistory.includes(item)) })
      if (sent) this.transferAccepted(id)
    }
  }
  restore(id: string, mode: "replace" | "swap" | "merge"): ComposerDraft | null {
    const record = this.snapshot.record
    const entry = record.entries.find((item) => item.id === id)
    if (!entry || (mode === "replace" && !isDraftEmpty(record.draft))) return null
    try {
      const next = mode === "merge" ? mergeDrafts(record.draft, entry.draft) : validateDraft(entry.draft)
      const entries = record.entries.filter((item) => item.id !== id || item.kind === "sent")
      if (mode === "swap" && !isDraftEmpty(record.draft)) entries.push({ id: crypto.randomUUID(), kind: "stash", savedAt: new Date().toISOString(), draft: record.draft })
      if (this.write({ ...record, draft: next, entries })) return next
      this.publish({ ...this.snapshot, record })
      return null
    } catch (error) {
      this.publish({ ...this.snapshot, error: error instanceof Error ? error.message : "Cannot restore this prompt" })
      return null
    }
  }
  remove(id: string): boolean {
    const record = this.snapshot.record
    if (this.write({ ...record, entries: record.entries.filter((item) => item.id !== id) })) return true
    this.publish({ ...this.snapshot, record })
    return false
  }
  retry = () => {
    if (this.snapshot.corrupt !== null || !this.write(this.snapshot.record)) return false
    this.snapshot.record.entries.forEach((entry) => this.transferAccepted(entry.id))
    return this.snapshot.error === null
  }
  backup = () => JSON.stringify({ scope: this.key, ...this.snapshot.record, ...(this.snapshot.corrupt !== null ? { damagedStorage: this.snapshot.corrupt } : {}) }, null, 2)
  resetAfterBackup = () => {
    const record = this.snapshot.record
    this.publish({ ...this.snapshot, corrupt: null })
    return this.write(record)
  }
}

export function draftStore(key: string): DraftStore {
  let store = stores.get(key)
  if (!store) { store = new DraftStore(key); stores.set(key, store) }
  return store
}

export function resetDraftStoresForTest(): void { stores.clear() }

export function mergeDrafts(current: ComposerDraft, saved: ComposerDraft): ComposerDraft {
  const context = [...current.context]
  const attachments = [...current.attachments]
  for (const item of saved.context) {
    const existing = context.find((old) => old.id === item.id)
    if (existing && renderComposerMessage({ text: "", context: [existing] }) !== renderComposerMessage({ text: "", context: [item] })) throw new Error("Context changed since saving. Use Swap to preserve both versions.")
    if (!existing) context.push(item)
  }
  for (const image of saved.attachments) {
    const existing = attachments.find((old) => old.id === image.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(image)) throw new Error("An attachment changed since saving. Use Swap to preserve both versions.")
    if (!existing) attachments.push(image)
  }
  return validateDraft({ v: 1, text: [current.text, saved.text].filter(Boolean).join("\n\n"), context, attachments })
}

export function canRecall(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }, selectionStart: number, selectionEnd: number, draft: ComposerDraft, recalling: boolean, suggestions: boolean): boolean {
  return (event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && selectionStart === selectionEnd && (!recalling || selectionEnd === draft.text.length) && !suggestions && (isDraftEmpty(draft) || recalling)
}
