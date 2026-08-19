import { AlertTriangle, Loader2 } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <AlertTriangle className="text-warning" />
          </AlertDialogMedia>
          <AlertDialogTitle>{TITLES[state.type]}</AlertDialogTitle>
          <AlertDialogDescription>
            {DESCRIPTIONS[state.type]}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2 py-2">
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
            <div className="mt-2 max-h-32 overflow-y-auto rounded-md border bg-muted/30 p-2">
              {state.summary.filePaths.map((fp) => (
                <div key={fp} className="truncate font-mono text-xs text-muted-foreground">
                  {fp}
                </div>
              ))}
            </div>
          )}
        </div>

        {applyError && (
          <Alert variant="destructive">
            <AlertDescription>{applyError}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isApplying}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isApplying}
          >
            {isApplying ? (
              <>
                <Loader2 data-icon="inline-start" className="animate-spin" />
                Applying...
              </>
            ) : (
              state.type === "undo" ? "Undo" : state.type === "redo" ? "Redo" : "Switch"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
