import type { ReactNode } from "react"

export interface PendingSessionInfo {
  dirName: string
  cwd?: string | null
  firstMessage?: string
}

export interface SessionBrowserProps {
  activeSessionKey: string | null
  onSelectSession: (dirName: string, fileName: string) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  pendingSession?: PendingSessionInfo | null
  isMobile?: boolean
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (dirName: string, fileName: string) => void
  liveSessionsRefreshRef?: React.MutableRefObject<(() => void) | null>
  onPrefetchSession?: (dirName: string, fileName: string) => void
  /** Desktop-only row above the session list (home, search, collapse). */
  header?: ReactNode
}
