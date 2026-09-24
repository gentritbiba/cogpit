import { useCallback } from "react"
import { Archive, ArchiveRestore, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { setSessionsArchived } from "@/lib/sessionArchive"

export type ApplyArchive = (
  sessionIds: readonly string[],
  archived: boolean,
  /** The toast to show once the server agrees; null for a silent change such as an undo. */
  message: string | null,
) => Promise<void>

/**
 * Archive or restore sessions from anywhere in the app.
 *
 * The change lands in the inventory at once and rolls back if the server
 * rejects it, so the sidebar never lags a click. The toast carries an undo so
 * a slip never needs the archived view to fix. A poll that started before the
 * change could land after it, so the inventory refetches once the server has it.
 */
export function useSessionArchive(): ApplyArchive {
  const inventory = useSessionInventoryOptional()
  const setArchived = inventory?.setArchived
  const refresh = inventory?.refresh

  const applyArchive = useCallback<ApplyArchive>(async (sessionIds, archived, message) => {
    setArchived?.(sessionIds, archived)
    const ok = await setSessionsArchived([...sessionIds], archived)
    if (!ok) {
      setArchived?.(sessionIds, !archived)
      toast.error(archived ? "Could not archive session" : "Could not restore session")
      return
    }
    refresh?.()
    if (message) {
      toast(message, {
        action: { label: "Undo", onClick: () => { void applyArchive(sessionIds, !archived, null) } },
      })
    }
  }, [setArchived, refresh])

  return applyArchive
}

export interface SessionArchiveToggle {
  archived: boolean
  label: string
  icon: LucideIcon
  /** Set while the action is unavailable; a running session would only come straight back. */
  disabledReason?: string
  toggle: () => void
}

/**
 * The one archive/restore control for the open session, shared by every
 * chat-view surface. Null when the user does not own the session.
 */
export function useSessionArchiveToggle(
  sessionId: string,
  isLive: boolean,
  canArchive: boolean,
): SessionArchiveToggle | null {
  const inventory = useSessionInventoryOptional()
  const applyArchive = useSessionArchive()
  if (!inventory || !canArchive) return null
  const archived = inventory.isArchived(sessionId)
  return {
    archived,
    label: archived ? "Restore from archive" : "Archive session",
    icon: archived ? ArchiveRestore : Archive,
    disabledReason: isLive && !archived ? "Stop the session before archiving it" : undefined,
    toggle: () => {
      void applyArchive([sessionId], !archived, archived ? "Session restored" : "Session archived")
    },
  }
}
