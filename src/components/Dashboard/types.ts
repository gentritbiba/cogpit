import type { SessionStatus } from "@/lib/sessionStatus"
import type { SessionPullRequest } from "../../../shared/session/prLinks"

export interface ProjectInfo {
  dirName: string
  path: string
  shortName: string
  sessionCount: number
  lastModified: string | null
}

/** A session row as returned by `GET /api/sessions/:dirName`. */
export interface SessionInfo {
  fileName: string
  sessionId: string
  size: number
  /** File mtime — when the transcript last grew, including background writes. */
  lastModified: string | null
  /** Timestamp of the last user message; closer to "when work last happened". */
  lastActivityAt?: string
  version?: string
  gitBranch?: string
  model?: string
  slug?: string
  name?: string
  /** Claude Code's generated session title, the best label when present. */
  aiTitle?: string
  /** The CLI's own session title, seeded from the opening prompt. */
  customTitle?: string
  cwd?: string
  firstUserMessage?: string
  lastUserMessage?: string
  timestamp?: string
  turnCount?: number
  lineCount?: number
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
  teamName?: string
  agentName?: string
  agentStatus?: SessionStatus
  agentToolName?: string
  agentTerminalReason?: string
  agentPendingAgents?: number
  pullRequests?: SessionPullRequest[]
  matchedPullRequestNumber?: number
}
