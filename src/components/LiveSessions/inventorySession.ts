import type { SessionInventory } from "@/contexts/SessionInventoryContext"
import { revealSessionPath, sessionPath } from "@/lib/revealSession"
import { describeSessionRow } from "./sessionRowState"
import { memberName } from "./crew"
import { sessionTitle } from "./sessionListView"

export interface InventorySession {
  title: string
  /** What it is doing right now, as the sidebar labels it; null when idle. */
  activity: string | null
  open: () => void
}

/** What the sidebar knows about a session; null when it is not listed on this device. */
export function inventorySession(inventory: SessionInventory | null, sessionId: string): InventorySession | null {
  const session = inventory?.sessions.find((value) => value.sessionId === sessionId)
  if (!inventory || !session) return null
  const path = sessionPath(session.dirName, session.fileName)
  const parent = session.crew && inventory.sessions.find((value) => value.sessionId === session.crew?.parentId)
  return {
    title: session.crew ? memberName(session, { parent: parent || undefined }) : sessionTitle(session),
    activity: describeSessionRow(session, inventory.procBySession.get(sessionId)).statusLabel,
    open: () => revealSessionPath(path),
  }
}
