import { memo } from "react"
import { LiveSessions } from "@/components/LiveSessions"
import { cn } from "@/lib/utils"
import type { SessionBrowserProps } from "./types"

export const SessionBrowser = memo(function SessionBrowser({
  activeSessionKey,
  onSelectSession,
  onNewSession,
  creatingSession,
  isMobile,
  onDuplicateSession,
  onDeleteSession,
  pendingSession,
  liveSessionsRefreshRef,
  onPrefetchSession,
}: SessionBrowserProps): React.ReactElement {
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col elevation-1",
        isMobile ? "w-full" : "w-72 panel-enter",
      )}
      aria-label="Session browser"
    >
      <LiveSessions
        activeSessionKey={activeSessionKey}
        onSelectSession={onSelectSession}
        onDuplicateSession={onDuplicateSession}
        onDeleteSession={onDeleteSession}
        onNewSession={onNewSession}
        creatingSession={creatingSession}
        pendingSession={pendingSession}
        refreshRef={liveSessionsRefreshRef}
        onPrefetchSession={onPrefetchSession}
      />
    </aside>
  )
})
