import { jsonFetch } from "@/lib/auth"

/**
 * Archive or restore sessions on the Cogpit server. Archiving only hides a
 * session from the sidebar; the transcript is untouched. Resolves to whether
 * the server accepted the change.
 */
export async function setSessionsArchived(sessionIds: string[], archived: boolean): Promise<boolean> {
  try {
    const res = await jsonFetch("/api/archive-sessions", { sessionIds, archived })
    return res.ok
  } catch {
    return false
  }
}
