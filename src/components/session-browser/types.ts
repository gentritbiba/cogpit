import type { ReactNode } from "react"

/** Delete a session; resolves true once the server has, and a list drops its row only then. */
export type DeleteSession = (dirName: string, fileName: string) => Promise<boolean>

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
  onDeleteSession?: DeleteSession
  liveSessionsRefreshRef?: React.MutableRefObject<(() => void) | null>
  onPrefetchSession?: (dirName: string, fileName: string) => void
  /** Desktop-only row above the session list (home, search, collapse). */
  header?: ReactNode
}
