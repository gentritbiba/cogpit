import type { SessionStatus } from "@/lib/sessionStatus"

export interface ActiveSessionInfo {
  dirName: string
  projectShortName: string
  fileName: string
  sessionId: string
  slug?: string
  /** AI-generated session title from Claude Code's ai-title JSONL events. */
  aiTitle?: string
  firstUserMessage?: string
  lastUserMessage?: string
  gitBranch?: string
  cwd?: string
  lastModified: string
  lastActivityAt?: string
  turnCount?: number
  size: number
  isActive?: boolean
  agentStatus?: SessionStatus
  agentToolName?: string
  agentTerminalReason?: string
  /** Agent-team name when this session is a teammate's own session. */
  teamName?: string
  /** Member name within the team (for example, "cc-research"). */
  agentName?: string
  /** Session ID of the team lead that spawned this teammate session. */
  teamLeadSessionId?: string
}

export interface RunningProcess {
  pid: number
  memMB: number
  cpu: number
  sessionId: string | null
  tty: string
  args: string
  startTime: string
}
