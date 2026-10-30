import { useState } from "react"
import { Archive, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { isDraftEmpty, type ComposerDraft } from "../../../shared/session/composerContext"
import type { DraftSnapshot, DraftStore } from "./draftStore"

export function downloadDraftBackup(store: DraftStore): void {
  const url = URL.createObjectURL(new Blob([store.backup()], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = "cogpit-prompts-backup.json"
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function StashControls({ store, snapshot, draft, onSave, onRestore }: {
  store: DraftStore
  snapshot: DraftSnapshot
  draft: ComposerDraft
  onSave: () => void
  onRestore: (id: string, mode: "replace" | "swap" | "merge") => void
}) {
  const [open, setOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [backedUp, setBackedUp] = useState(false)
  const entries = snapshot.record.entries
  const saved = entries.filter((entry) => entry.kind !== "sent")
  return <>
    <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
      <Button type="button" variant="ghost" size="xs" disabled={isDraftEmpty(draft)} onClick={onSave} aria-label="Save prompt stash" title="Save and clear prompt (Ctrl/⌘+Shift+S)"><Save data-icon="inline-start" />Stash</Button>
      <Button type="button" variant="ghost" size="xs" aria-expanded={open} aria-controls="prompt-stashes" onClick={() => setOpen(!open)}><Archive data-icon="inline-start" />Saved prompts ({saved.length})</Button>
    </div>
    {snapshot.record.pendingUpload && <div role="status" className="mb-2 text-xs text-warning">An image upload is pending or was interrupted. Keep this composer open while it loads; after a reload, reattach the image.
      <Button type="button" variant="ghost" size="xs" onClick={() => store.markUpload(false)}>Dismiss upload notice</Button>
    </div>}
    {snapshot.error && <div role="alert" className="mb-2 rounded border border-warning/50 p-2 text-xs">
      <p>{snapshot.error}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="xs" onClick={() => store.retry()}>Retry storage</Button>
        <Button type="button" variant="outline" size="xs" onClick={() => { downloadDraftBackup(store); setBackedUp(true) }}>Download draft backup</Button>
        {snapshot.corrupt !== null && backedUp && <Button type="button" variant="outline" size="xs" onClick={() => { store.resetAfterBackup(); setBackedUp(false) }}>Reset damaged storage after backup</Button>}
      </div>
    </div>}
    {open && <section id="prompt-stashes" aria-label="Saved prompts" className="mb-2 max-h-72 overflow-y-auto rounded-lg border bg-popover p-2 text-xs">
      <p className="mb-2 text-muted-foreground">Saved on this browser for this account, device, project and composer. Ctrl/⌘+Shift+S stashes; ↑/↓ in an empty message recalls your last 30 successful sends.</p>
      {entries.length === 0 && <p>No saved prompts yet.</p>}
      {[...entries].reverse().map((entry) => <div key={entry.id} className="border-t py-2 first:border-0">
        <p className="font-medium">{entry.kind === "sending" ? "Unconfirmed send — check session history before resending" : entry.kind === "refused" ? "Failed send" : entry.kind === "sent" ? "Sent prompt" : "Stashed prompt"} · <time dateTime={entry.savedAt}>{new Date(entry.savedAt).toLocaleString()}</time></p>
        <p className="my-1 whitespace-pre-wrap break-words">{entry.draft.text.slice(0, 180) || "Context / attachments"}{entry.draft.text.length > 180 ? "…" : ""}</p>
        <p className="text-muted-foreground">{entry.draft.context.length} context items · {entry.draft.attachments.length} images</p>
        {entry.createdTarget && entry.kind === "sent" && <Button type="button" variant="outline" size="xs" onClick={() => store.retry()}>Retry recall handoff</Button>}
        <div className="mt-1 flex gap-2">
          <Button type="button" variant="outline" size="xs" aria-label={`Restore ${entry.draft.text.slice(0, 60) || "saved prompt"}`} onClick={() => { if (isDraftEmpty(draft)) onRestore(entry.id, "replace"); else setConfirmId(entry.id) }}>Restore</Button>
          <Button type="button" variant="ghost" size="xs" aria-label={`Delete ${entry.draft.text.slice(0, 60) || "saved prompt"}`} onClick={() => { store.remove(entry.id); setConfirmId(null) }}>Delete</Button>
        </div>
        {confirmId === entry.id && <div role="group" aria-label="Restore into existing draft" className="mt-2 rounded border p-2">
          <p>Your current draft has content. Swap saves it as a stash; merge combines both prompts.</p>
          <div className="mt-1 flex gap-2">
            <Button type="button" variant="outline" size="xs" onClick={() => { onRestore(entry.id, "swap"); setConfirmId(null) }}>Swap drafts</Button>
            <Button type="button" variant="outline" size="xs" onClick={() => { onRestore(entry.id, "merge"); setConfirmId(null) }}>Merge drafts</Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmId(null)}>Cancel restore</Button>
          </div>
        </div>}
      </div>)}
    </section>}
  </>
}
