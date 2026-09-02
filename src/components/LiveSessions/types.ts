import type { SessionStatus } from "../../../shared/session/sessionStatus"
import type { AgentKind } from "@/lib/agents"
import type { SessionPullRequest } from "../../../shared/session/prLinks"

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
  /** Background agents still running while the turn has ended (awaiting_agents). */
  agentPendingAgents?: number
  /** Agent-team name when this session is a teammate's own session. */
  teamName?: string
  /** Member name within the team (for example, "cc-research"). */
  agentName?: string
  /** Session ID of the team lead that spawned this teammate session. */
  teamLeadSessionId?: string
  /** Pull requests this session opened, from a whole-file server scan. */
  pullRequests?: SessionPullRequest[]
  /** Exact PR number that caused this session to appear in remote search results. */
  matchedPullRequestNumber?: number
}

export interface RunningProcess {
  pid: number
  memMB: number
  cpu: number
  sessionId: string | null
  agentKind?: AgentKind
  /** Whether Cogpit owns the process and can execute lifecycle controls for it. */
  managed?: boolean
  tty: string
  startTime: string
}
