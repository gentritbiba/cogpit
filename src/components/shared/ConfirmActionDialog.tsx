import { useState, type ReactElement, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { FieldError } from "@/components/ui/field"

interface ConfirmActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The button that opens the dialog. Omit it when a menu item opens the dialog. */
  trigger?: ReactElement
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  destructive?: boolean
  /**
   * Runs the action and resolves to an error to show, or null. The caller
   * closes the dialog on success, because a successful action often removes
   * the row that owns it.
   */
  onConfirm: () => Promise<string | null>
}

/** Asks before a consequential row action and stays locked while it runs. */
export function ConfirmActionDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: ConfirmActionDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function changeOpen(nextOpen: boolean) {
    if (busy) return
    setError(null)
    onOpenChange(nextOpen)
  }

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      setError(await onConfirm())
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      {trigger && <AlertDialogTrigger render={trigger} />}
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <FieldError className="text-center">{error}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
