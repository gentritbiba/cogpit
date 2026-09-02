import { memo } from "react"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { ParsedSession } from "../../shared/session/types"

interface MobileFileChangesProps {
  open: boolean
  onClose: () => void
  session: ParsedSession
  sessionChangeKey: number
}

/**
 * Sheet wrapper for file changes on mobile.
 * Opens when the user taps a changed-files indicator in the timeline.
 */
export const MobileFileChanges = memo(function MobileFileChanges({
  open,
  onClose,
  session,
  sessionChangeKey,
}: MobileFileChangesProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <SheetContent side="bottom" className="h-[72svh] max-h-[92svh] rounded-t-xl">
        <SheetHeader className="shrink-0 px-4 py-3">
          <SheetTitle>File changes</SheetTitle>
          <SheetDescription className="sr-only">
            Review files changed in this session.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <FileChangesPanel session={session} sessionChangeKey={sessionChangeKey} />
        </div>
      </SheetContent>
    </Sheet>
  )
})
