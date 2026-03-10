import { memo } from "react"
import { BottomSheet } from "@/components/ui/bottom-sheet"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import type { ParsedSession } from "@/lib/types"

interface MobileFileChangesProps {
  open: boolean
  onClose: () => void
  session: ParsedSession
  sessionChangeKey: number
}

/**
 * Bottom-sheet wrapper for file changes on mobile.
 * Opens when the user taps a changed-files indicator in the timeline.
 */
export const MobileFileChanges = memo(function MobileFileChanges({
  open,
  onClose,
  session,
  sessionChangeKey,
}: MobileFileChangesProps) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="File Changes"
      initialHeight={50}
      maxHeight={92}
    >
      <FileChangesPanel session={session} sessionChangeKey={sessionChangeKey} />
    </BottomSheet>
  )
})
