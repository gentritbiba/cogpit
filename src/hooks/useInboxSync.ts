import { useEffect } from "react"
import { authFetch } from "@/lib/auth"
import { editionUi } from "@/edition/registry"
import type { CogpitNotification } from "../../shared/notifications"

const POLL_INTERVAL_MS = 15_000

/**
 * Reads the active device's notification inbox and hands it to the edition.
 * Core shows no inbox of its own; system notifications are raised by the server.
 */
export function useInboxSync(): void {
  useEffect(() => {
    async function read(): Promise<void> {
      // The edition UI can load after this mounts, so ask on every read.
      const onInboxRead = editionUi().onInboxRead
      if (!onInboxRead || document.visibilityState !== "visible") return
      try {
        const res = await authFetch("/api/notifications?limit=100")
        if (!res.ok) return
        const data = await res.json() as { notifications?: CogpitNotification[] }
        if (!Array.isArray(data.notifications)) return
        onInboxRead(data.notifications)
      } catch {
        // Transient network failure — the next poll retries.
      }
    }

    // Also read on focus: someone coming back to the app sees what arrived meanwhile.
    void read()
    const timer = window.setInterval(() => void read(), POLL_INTERVAL_MS)
    const onFocus = () => void read()
    window.addEventListener("focus", onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [])
}
