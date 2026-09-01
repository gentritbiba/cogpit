import { useEffect, useState } from "react"
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
  const [lastState, setLastState] = useState(state)

  useEffect(() => {
    if (state) setLastState(state)
  }, [state])

  const renderedState = state ?? lastState
  if (!renderedState) return null

  return (
    <AlertDialog
      open={state !== null}
      onOpenChange={(open) => { if (!open) onCancel() }}
      onOpenChangeComplete={(open) => { if (!open) setLastState(null) }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <AlertTriangle className="text-warning" />
          </AlertDialogMedia>
          <AlertDialogTitle>{TITLES[renderedState.type]}</AlertDialogTitle>
          <AlertDialogDescription>
            {renderedState.copilot
              ? renderedState.copilot.mode === "conversation-and-files"
                ? "This removes the selected turn and everything after it, restoring captured files."
                : "This removes the selected turn and everything after it. Files stay unchanged."
              : DESCRIPTIONS[renderedState.type]}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Turns affected</span>
            <span className="text-foreground font-mono">{renderedState.summary.turnCount}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Files affected</span>
            <span className="text-foreground font-mono">{renderedState.summary.fileCount}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Operations</span>
            <span className="text-foreground font-mono">{renderedState.summary.operationCount}</span>
          </div>
          {renderedState.summary.filePaths.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded-md border bg-muted/30 p-2">
              {renderedState.summary.filePaths.map((fp) => (
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
              renderedState.type === "undo" ? "Undo" : renderedState.type === "redo" ? "Redo" : "Switch"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
