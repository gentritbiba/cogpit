import { useEffect, useRef } from "react"
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

  useEffect(() => {
    const backgroundTabs = tabs.filter(
      (t) => t.id !== activeTabId && t.dirName && t.fileName
    )

    if (backgroundTabs.length === 0) return

    const sources: EventSource[] = []

    for (const tab of backgroundTabs) {
      const url = `/api/watch/${encodeURIComponent(tab.dirName)}/${encodeURIComponent(tab.fileName!)}`
      const es = new EventSource(authUrl(url))

      es.addEventListener("lines", () => {
        dispatchRef.current({
          type: "MARK_ACTIVITY",
          tabId: tab.id,
          turnCount: tab.lastKnownTurnCount + 1,
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
  }, [tabs, activeTabId])
}
