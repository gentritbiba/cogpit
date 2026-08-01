/**
 * Wire contract for GET /api/mission-control — the per-session card payload
 * behind the Mission Control grid.
 *
 * `/api/active-sessions` carries identity and status but none of the density a
 * card needs (tokens, context pressure, diffstat, tool trail). This contract
 * fills that gap and is browser-safe.
 */

/** A file touched by a session, with net line counts. */
export interface MissionControlFileChange {
  path: string
  additions: number
  deletions: number
}

/** Token totals accumulated across every assistant response in the session. */
export interface MissionControlTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /**
   * input + output — the headline card number, matching `computeStats`.
   *
   * Cache reads are deliberately excluded: every call re-reads the whole
   * context, so summing them reports tens of millions for an ordinary session.
   */
  total: number
}

/**
 * Context-window pressure, read from the most recent assistant usage rather
 * than summed: it is the only value that reflects what the model is carrying
 * right now.
 */
export interface MissionControlContext {
  used: number
  limit: number
  /** 0-100, rounded. */
  percent: number
}

/** The tool call a session is executing right now. */
export interface MissionControlCurrentTool {
  name: string
  /** One-line rendering of the tool input (command, file path, pattern…). */
  summary: string
}

/** Everything the grid shows for one session beyond its ActiveSessionInfo. */
export interface MissionControlSummary {
  sessionId: string
  /** Model id from the latest assistant message, when the session has one. */
  model: string | null
  /** ISO timestamp of the first event in the session. */
  startedAt: string | null
  /** ISO timestamp of the most recent event. */
  lastEventAt: string | null
  /** Wall-clock span between the first and last event, in ms. */
  elapsedMs: number
  turnCount: number
  tokens: MissionControlTokens
  context: MissionControlContext | null
  currentTool: MissionControlCurrentTool | null
  /** Most recent tool names, oldest first — the trail shown under the card. */
  toolTrail: string[]
  totalToolCalls: number
  /** Changed files, largest change first. Truncated to a card-sized list. */
  files: MissionControlFileChange[]
  /** Totals across every changed file, including any beyond `files`. */
  filesTotal: { count: number; additions: number; deletions: number }
  /** Latest assistant prose, for the card preview line. */
  lastAssistantText: string | null
  /** True when the last tool result in the session was an error. */
  lastToolErrored: boolean
}

/** A pending permission request, paired with the session that raised it. */
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

/** Response body of GET /api/mission-control. */
export interface MissionControlResponse {
  summaries: MissionControlSummary[]
  permissions: MissionControlPermission[]
  generatedAt: string
}
