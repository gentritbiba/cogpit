import { useCallback, useState } from "react"
import { ShieldAlert } from "lucide-react"
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
import { FULL_ACCESS_MODE, type PermissionMode } from "@/lib/permissions"

const EXPLAINED_KEY = "cogpit:full-access-explained"

function explained(): boolean {
  try {
    return localStorage.getItem(EXPLAINED_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * The access picker's change, with Full access explained in plain words the
 * first time anyone on this browser chooses it. Every other mode, and Full
 * access once confirmed, goes straight through; the confirmed one through
 * `apply`, the way the picker applies a change to a running session.
 */
export function useFullAccessConfirmation(
  onChange: ((mode: PermissionMode) => void) | undefined,
  apply: (change: () => void) => void,
) {
  const [asking, setAsking] = useState(false)

  const change = useCallback((mode: PermissionMode) => {
    if (mode === FULL_ACCESS_MODE && !explained()) setAsking(true)
    else onChange?.(mode)
  }, [onChange])

  const confirm = useCallback(() => {
    try {
      localStorage.setItem(EXPLAINED_KEY, "1")
    } catch {
      // Unsaved, it is explained again next time.
    }
    setAsking(false)
    if (onChange) apply(() => onChange(FULL_ACCESS_MODE))
  }, [onChange, apply])

  const dialog = <FullAccessDialog open={asking} onCancel={() => setAsking(false)} onConfirm={confirm} />
  return { change: onChange ? change : undefined, dialog }
}

function FullAccessDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="text-warning">
            <ShieldAlert />
          </AlertDialogMedia>
          <AlertDialogTitle>Let the agent act without asking?</AlertDialogTitle>
          <AlertDialogDescription>
            With Full access, the agent runs commands and changes or deletes files without asking you first.
            Use it only in folders you trust. You can switch back at any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep asking first</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>Use Full access</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
