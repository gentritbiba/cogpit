import { useEffect, useMemo, useRef } from "react"
import { authUrl } from "@/lib/auth"
import type { TabSnapshot, TabAction } from "@/hooks/useTabState"

/**
 * Opens lightweight SSE connections for background tabs to detect new activity.
 * Only listens for "lines" events — does NOT parse JSONL content.
 * Dispatches MARK_ACTIVITY when new content arrives on a background tab.
 */
export function useBackgroundTabWatcher(
  tabs: TabSnapshot[],
  activeTabId: string | null,
  dispatch: React.Dispatch<TabAction>
) {
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  // Derive a stable list of background tab identifiers so the effect only
  // re-runs when the actual set of background tabs changes — not on every
  // MARK_ACTIVITY dispatch (which produces a new `tabs` array reference).
  const backgroundTabKeys = useMemo(() => {
    return tabs
      .filter((t) => t.id !== activeTabId && t.dirName && t.fileName)
      .map((t) => ({ id: t.id, dirName: t.dirName, fileName: t.fileName! }))
  }, [tabs, activeTabId])

  // Serialize to a string for stable effect dependency
  const backgroundKey = useMemo(
    () => backgroundTabKeys.map((t) => t.id).join("|"),
    [backgroundTabKeys]
  )

  useEffect(() => {
    if (backgroundTabKeys.length === 0) return

    const sources: EventSource[] = []

    for (const tab of backgroundTabKeys) {
      const url = `/api/watch/${encodeURIComponent(tab.dirName)}/${encodeURIComponent(tab.fileName)}`
      const es = new EventSource(authUrl(url))

      es.addEventListener("lines", () => {
        dispatchRef.current({
          type: "MARK_ACTIVITY",
          tabId: tab.id,
          turnCount: 0, // We only need the boolean flag; exact count isn't critical
        })
      })

      es.onerror = () => {
        // Silently ignore — SSE will auto-reconnect
      }

      sources.push(es)
    }

    return () => {
      for (const es of sources) {
        es.close()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only when background tab set changes
  }, [backgroundKey])
}
