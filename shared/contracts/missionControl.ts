/**
 * Wire contract for GET /api/mission-control — the per-session card payload
 * behind the Mission Control grid. Browser-safe.
 */

export interface MissionControlFileChange {
  path: string
  additions: number
  deletions: number
}

export interface MissionControlTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /**
   * input + output. Cache reads are deliberately excluded: every call re-reads
   * the whole context, so summing them reports tens of millions of tokens for
   * an ordinary session.
   */
  total: number
}

/** Read from the latest assistant usage, not summed — only that reflects what the model carries now. */
export interface MissionControlContext {
  used: number
  limit: number
  /** 0-100, rounded. */
  percent: number
}

export interface MissionControlCurrentTool {
  name: string
  /** One-line rendering of the tool input (command, file path, pattern…). */
  summary: string
}

/** Everything the grid shows for one session beyond its ActiveSessionInfo. */
export interface MissionControlSummary {
  sessionId: string
  model: string | null
  startedAt: string | null
  lastEventAt: string | null
  elapsedMs: number
  turnCount: number
  tokens: MissionControlTokens
  context: MissionControlContext | null
  currentTool: MissionControlCurrentTool | null
  /** Most recent tool names, oldest first. */
  toolTrail: string[]
  totalToolCalls: number
  /** Largest change first, truncated to a card-sized list. */
  files: MissionControlFileChange[]
  /** Totals across every changed file, including any beyond `files`. */
  filesTotal: { count: number; additions: number; deletions: number }
  lastAssistantText: string | null
  lastToolErrored: boolean
}

/** A pending permission request, served by GET /api/permissions. */
export interface MissionControlPermission {
  sessionId: string
  requestId: string
  toolName: string
  /** One-line rendering of the request (the command, the path…). */
  summary: string
  title?: string
  description?: string
  /** Decisions the underlying provider accepts for this exact request. */
  availableDecisions?: ("allow" | "allow_always" | "deny")[]
  timestamp: number
}

export interface MissionControlQuestionOption {
  label: string
  description?: string
  /**
   * Whether the option carried a rich preview (a mockup, a code snippet). The
   * preview itself is deliberately not sent: it can run to kilobytes and this
   * list is polled app-wide. Cards surface the flag and point at the session.
   */
  hasPreview: boolean
}

export interface MissionControlQuestionItem {
  question: string
  header?: string
  multiSelect: boolean
  options: MissionControlQuestionOption[]
}

/**
 * An AskUserQuestion call blocking a session, served by GET /api/user-questions.
 * Read from the in-memory resolver map, so being listed proves the question is
 * still live and answerable.
 */
export interface MissionControlQuestion {
  sessionId: string
  /** The blocked tool call — the id required to answer it. */
  toolUseId: string
  askedAt: number
  questions: MissionControlQuestionItem[]
}

/** Response body of GET /api/user-questions. */
export interface UserQuestionsResponse {
  bySession: Record<string, MissionControlQuestion[]>
}

/** Response body of GET /api/mission-control. */
export interface MissionControlResponse {
  summaries: MissionControlSummary[]
  generatedAt: string
}
