import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { cn } from "@/lib/utils"

interface InlineEditPanelProps {
  children: ReactNode
  error: string | null
  busy: boolean
  saveLabel: string
  onCancel: () => void
  onSave: () => void
  className?: string
}

/** An editor that unfolds under a list row, with its error and Cancel / Save. */
export function InlineEditPanel({
  children,
  error,
  busy,
  saveLabel,
  onCancel,
  onSave,
  className,
}: InlineEditPanelProps) {
  return (
    <div className={cn("flex flex-col gap-3 border-t px-3 py-3", className)}>
      {children}
      {error && <FieldError>{error}</FieldError>}
      <div className="flex justify-end gap-1.5">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={onSave}>
          {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : saveLabel}
        </Button>
      </div>
    </div>
  )
}
