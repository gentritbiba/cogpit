import type { ParsedSession } from "@/lib/types"
import type { ProcessEntry } from "@/hooks/useProcessPanel"

// ── API types ──────────────────────────────────────────────────────────────

export interface ProjectInfo {
  dirName: string
  path: string
  shortName: string
  sessionCount: number
  lastModified: string | null
}

export interface SessionInfo {
  fileName: string
  sessionId: string
  size: number
  lastModified: string | null
  version?: string
  gitBranch?: string
  model?: string
  slug?: string
  cwd?: string
  firstUserMessage?: string
  timestamp?: string
  turnCount?: number
  lineCount?: number
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
}

// ── Component Props ────────────────────────────────────────────────────────

export type View = "projects" | "sessions" | "detail"

/** Info about a session that is currently being created (pending first message response) */
export interface PendingSessionInfo {
  dirName: string
  cwd?: string | null
  firstMessage?: string
}

export interface SessionBrowserProps {
  /** ID of the currently loaded session (drives sidebar view switching) */
  sessionId: string | null
  /** "dirName/fileName" key identifying the currently loaded session */
  activeSessionKey: string | null
  onLoadSession: (
    session: ParsedSession,
    source: { dirName: string; fileName: string; rawText: string }
  ) => void
  sidebarTab: "live" | "browse" | "teams"
  onSidebarTabChange: (tab: "live" | "browse" | "teams") => void
  onSelectTeam?: (teamName: string) => void
  /** Create a new Claude session in the given project */
  onNewSession?: (dirName: string, cwd?: string) => void
  /** True while a new session is being created */
  creatingSession?: boolean
  /** Info about the session currently being created */
  pendingSession?: PendingSessionInfo | null
  /** When true, renders full-width mobile layout */
  isMobile?: boolean
  /** When true, only show the Teams tab (used for mobile teams tab) */
  teamsOnly?: boolean
  /** Duplicate a session (full copy) */
  onDuplicateSession?: (dirName: string, fileName: string) => void
  /** Delete a session file */
  onDeleteSession?: (dirName: string, fileName: string) => void
  /** Open a session in a new tab (Ctrl+click / middle-click) */
  onOpenInNewTab?: (dirName: string, fileName: string, label: string) => void
  /** Called before fetching a new session to free connections held by the current session */
  onBeforeSessionSwitch?: () => void
  /** Ref callback to imperatively trigger a refresh of the live sessions list */
  liveSessionsRefreshRef?: React.MutableRefObject<(() => void) | null>
  /** Project working directory — used for script discovery */
  projectDir?: string | null
  /** Called when a script process is started from the sidebar dock */
  onScriptStarted?: (entry: ProcessEntry) => void
}
