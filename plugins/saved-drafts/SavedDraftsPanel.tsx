import { useState } from "react"
import { Button } from "@cogpit/plugin-ui/button"

import type { DraftPreview } from "@cogpit/plugin-contracts"

export interface SavedDraftsPanelProps {
  items: DraftPreview[]
  error?: string | null
  corrupt?: boolean
  pendingUpload?: boolean
  busy?: boolean
  hasMore?: boolean
  onLoadMore: () => void
  onCapture: () => void
  onRestore: (id: string, mode: "replace" | "swap" | "merge") => Promise<void>
  onRemove: (id: string) => void
  onBackup: () => Promise<void>
  onRetry: () => void
  onReset: () => void
  onDismissUpload: () => void
}

export function SavedDraftsPanel({ items, error, corrupt, pendingUpload, busy, hasMore, onLoadMore, onCapture, onRestore, onRemove, onBackup, onRetry, onReset, onDismissUpload }: SavedDraftsPanelProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [backedUp, setBackedUp] = useState(false)
  async function restore(id: string, mode: "replace" | "swap" | "merge") {
    try { await onRestore(id, mode); setConfirmId(null) } catch { setConfirmId(id) }
  }
  return <section aria-label="Saved drafts" className="flex h-full flex-col gap-3 overflow-y-auto p-4 text-sm text-foreground">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="m-0 text-base font-semibold">Saved drafts</h1>
      <Button type="button" size="sm" disabled={busy} onClick={onCapture}>Save and clear draft</Button>
    </div>
    <p className="m-0 text-xs text-muted-foreground">Saved in this browser for this account, device, project and composer. Ctrl/⌘+Shift+S saves and clears a draft. ↑/↓ in an empty message recalls your last 30 successful sends. Images stay in the host browser.</p>
    {pendingUpload && <div role="status" className="rounded-md border p-3 text-xs">An image upload is pending or was interrupted. Keep the composer open while it loads; after a reload, reattach the image.
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDismissUpload}>Dismiss upload notice</Button>
    </div>}
    {error && <div role="alert" className="rounded-md border border-warning/50 p-3 text-xs">
      <p className="m-0">{error}</p>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}>Retry storage</Button>
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void onBackup().then(() => setBackedUp(true), () => {}) }}>Download draft backup</Button>
      {corrupt && backedUp && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { onReset(); setBackedUp(false) }}>Reset damaged storage after backup</Button>}
    </div>
    {items.length === 0 && !error && <p className="text-muted-foreground">No saved drafts yet.</p>}
    {items.map((entry) => <article key={entry.id} className="border-t border-border py-3">
      <p className="m-0 text-xs font-medium">{entry.kind === "sending" ? "Unconfirmed send — check session history before resending" : entry.kind === "refused" ? "Failed send" : entry.kind === "sent" ? "Sent message" : "Saved draft"} · <time dateTime={entry.savedAt}>{new Date(entry.savedAt).toLocaleString()}</time></p>
      <p className="my-2 whitespace-pre-wrap break-words">{entry.text || "Context / attachments"}</p>
      <p className="text-xs text-muted-foreground">{entry.context.length} context items · {entry.images.length} images</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} aria-label={`Restore ${entry.text.slice(0, 60) || "saved draft"}`} onClick={() => { void restore(entry.id, "replace") }}>Restore</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Delete ${entry.text.slice(0, 60) || "saved draft"}`} onClick={() => onRemove(entry.id)}>Delete</Button>
      </div>
      {confirmId === entry.id && <div role="group" aria-label="Restore into existing draft" className="mt-2 rounded-md border border-border p-3 text-xs">
        <p className="m-0 mb-2">If your current draft has content, swap saves it first; merge combines both drafts. Storage and context errors must be resolved before restoring.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void restore(entry.id, "swap") }}>Swap drafts</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void restore(entry.id, "merge") }}>Merge drafts</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmId(null)}>Cancel restore</Button>
        </div>
      </div>}
    </article>)}
    {hasMore && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onLoadMore}>Load more drafts</Button>}
  </section>
}
