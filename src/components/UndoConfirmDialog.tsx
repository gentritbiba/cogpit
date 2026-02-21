import { AlertTriangle, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { UndoConfirmState } from "@/hooks/useUndoRedo"

interface UndoConfirmDialogProps {
  state: UndoConfirmState | null
  isApplying: boolean
  applyError: string | null
  onConfirm: () => void
  onCancel: () => void
}

const TITLES: Record<string, string> = {
  undo: "Undo turns?",
  redo: "Redo turns?",
  "branch-switch": "Switch branch?",
}

const DESCRIPTIONS: Record<string, string> = {
  undo: "This will revert file changes from the following turns.",
  redo: "This will re-apply file changes from the following turns.",
  "branch-switch": "This will switch to a different branch, undoing current changes and applying the branch's changes.",
}

export function UndoConfirmDialog({
  state,
  isApplying,
  applyError,
  onConfirm,
  onCancel,
}: UndoConfirmDialogProps) {
  if (!state) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent className="sm:max-w-md elevation-4 border-border/30">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <AlertTriangle className="size-4 text-amber-400" />
            {TITLES[state.type]}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {DESCRIPTIONS[state.type]}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Turns affected</span>
            <span className="text-foreground font-mono">{state.summary.turnCount}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Files affected</span>
            <span className="text-foreground font-mono">{state.summary.fileCount}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Operations</span>
            <span className="text-foreground font-mono">{state.summary.operationCount}</span>
          </div>
          {state.summary.filePaths.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded border border-border bg-elevation-0 p-2">
              {state.summary.filePaths.map((fp) => (
                <div key={fp} className="text-[11px] font-mono text-muted-foreground truncate">
                  {fp}
                </div>
              ))}
            </div>
          )}
        </div>

        {applyError && (
          <div className="rounded border border-red-800/60 bg-red-900/20 px-3 py-2 text-sm text-red-400">
            {applyError}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={isApplying}
            className="text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isApplying}
            className="bg-amber-600 hover:bg-amber-500 text-white"
          >
            {isApplying ? (
              <>
                <Loader2 className="size-4 animate-spin mr-2" />
                Applying...
              </>
            ) : (
              state.type === "undo" ? "Undo" : state.type === "redo" ? "Redo" : "Switch"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
