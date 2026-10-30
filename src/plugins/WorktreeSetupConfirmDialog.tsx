import { useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"

export interface WorktreeSetupProposal { proposalId: string; command: string; timeoutMs: number }

/**
 * Cogpit's own confirmation of a setup command a plugin proposed. The plugin
 * frame cannot reach the save; only this dialog's Save does, after the user
 * trusts the exact command shown here.
 */
export function WorktreeSetupConfirmDialog({ pluginName, proposal, projectPath, save, onClose }: {
  pluginName: string
  proposal: WorktreeSetupProposal
  projectPath: string | null
  save: (proposalId: string, signal: AbortSignal) => Promise<unknown>
  onClose: () => void
}) {
  const id = useId()
  const command = proposal.command.trim()
  const [trusted, setTrusted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const close = () => { controller.current?.abort(); onClose() }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto text-left">
        <DialogTitle>{command ? "Trust this setup command?" : "Disable worktree setup?"}</DialogTitle>
        <DialogDescription>
          {command ? `${pluginName} asks to run this command in every new worktree of this project, before the agent's first prompt.` : `${pluginName} asks to stop running a setup command in new worktrees of this project.`}
        </DialogDescription>
        {projectPath && <p className="break-all font-mono text-xs text-muted-foreground">{projectPath}</p>}
        {command && <>
          <pre aria-label="Setup command" className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted p-3 font-mono text-xs">{proposal.command}</pre>
          <p className="text-xs text-muted-foreground">Timeout: {Math.round(proposal.timeoutMs / 60_000)} min</p>
          <div className="rounded-lg border bg-muted/30 p-3">
            <label className="flex items-start gap-3 text-sm leading-relaxed" htmlFor={`${id}-trust`}>
              <Checkbox id={`${id}-trust`} className="mt-0.5 shrink-0" checked={trusted} onCheckedChange={setTrusted} />
              I trust this command and the project code it runs in new worktrees.
            </label>
          </div>
        </>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button disabled={saving || (!!command && !trusted)} onClick={() => {
            controller.current?.abort()
            const current = controller.current = new AbortController()
            setSaving(true); setError(null)
            void save(proposal.proposalId, current.signal).then(() => { if (!current.signal.aborted) onClose() }, (failure: unknown) => {
              if (!current.signal.aborted) { setError(failure instanceof Error ? failure.message : "Unable to save setup"); setSaving(false) }
            })
          }}>{saving ? "Saving…" : command ? "Save setup recipe" : "Disable setup"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
