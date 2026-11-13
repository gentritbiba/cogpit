import { useCallback, useState } from "react"

import { authFetch } from "@/lib/auth"
import { readError } from "@/lib/httpJson"
import type { SlackLinksReport } from "../../shared/contracts/slack"
import { messageOf, useReport } from "./useReport"

/** The host's Slack links, plus the two changes the app may make to one: its settings, and unlinking it. */
export function useSlackLinks() {
  const { state, refresh, supersede } = useReport<SlackLinksReport>("/api/slack")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = useCallback(async (sessionId: string, body: Record<string, unknown>) => {
    setBusy(sessionId)
    setError(null)
    supersede()
    try {
      const res = await authFetch("/api/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...body }),
      })
      if (!res.ok) setError(await readError(res, `Request failed (${res.status})`))
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }, [refresh, supersede])

  const setAutoPost = useCallback((sessionId: string, autoPost: boolean) => act(sessionId, { action: "update", autoPost }), [act])
  const unlink = useCallback((sessionId: string) => act(sessionId, { action: "unlink" }), [act])

  return { state, busy, error, refresh, setAutoPost, unlink }
}
