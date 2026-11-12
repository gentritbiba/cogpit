import { memo } from "react"
import { LiveSessions } from "@/components/LiveSessions"
import { cn } from "@/lib/utils"
import type { SessionBrowserProps } from "./types"

export const SessionBrowser = memo(function SessionBrowser({
  activeSessionKey,
  onSelectSession,
  onOpenQuoteSource,
  onNewSession,
  onNewFolder,
  defaultAgentKind,
  creatingSession,
  isMobile,
  onDuplicateSession,
  onDeleteSession,
  pendingSession,
  liveSessionsRefreshRef,
  onPrefetchSession,
  header,
}: SessionBrowserProps): React.ReactElement {
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col bg-sidebar",
        isMobile ? "w-full" : "w-80",
      )}
      aria-label="Session browser"
    >
      {header}
      <LiveSessions
        activeSessionKey={activeSessionKey}
        onSelectSession={onSelectSession}
        onOpenQuoteSource={onOpenQuoteSource}
        onDuplicateSession={onDuplicateSession}
        onDeleteSession={onDeleteSession}
        onNewSession={onNewSession}
        onNewFolder={onNewFolder}
        defaultAgentKind={defaultAgentKind}
        creatingSession={creatingSession}
        pendingSession={pendingSession}
        refreshRef={liveSessionsRefreshRef}
        onPrefetchSession={onPrefetchSession}
      />
    </aside>
  )
})
