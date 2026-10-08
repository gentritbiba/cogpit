import type { PendingInput } from "./pendingInput"
import type { SessionPullRequest } from "../session/prLinks"

/**
 * A crew is the sessions one session started through Cogpit (`cogpit-session
 * new`, `create-and-send` with a parent), and theirs. Its root is the first
 * session in that chain nothing started. Session lists carry a member's place
 * in its crew, and a listed root the size and latest activity of the crew
 * riding with it.
 */

/** How a listed session sits in its crew. */
export interface ListedCrew {
  /** The first session in the chain that nothing started. */
  rootId: string
  /** The session that started this one. */
  parentId: string
  /** When it was started, in epoch milliseconds. */
  startedAt: number
  /** The name it was started with. */
  name?: string
  /** What the root is called, given only when the list does not carry the root. */
  rootTitle?: string
  /** What the parent is called, given only when the list does not carry the parent. */
  parentTitle?: string
}

/** On a session listed with its crew: the members riding with it, and when any of the crew last did something. */
export interface ListedCrewSummary {
  size: number
  activityAt: string
}

/** Where a session stands, as `/api/session-status` reports it. */
export type CrewOutcome = "running" | "needs_input" | "completed" | "error" | "not_found" | "unreachable"

/** One session of a crew, as `/api/session-crew/:id` reports it: its place, its state, and what it is waiting on. */
export interface CrewMember {
  sessionId: string
  /** The session that started it; null for the root. */
  parentId: string | null
  /** When it was started, in epoch milliseconds; null for the root. */
  startedAt: number | null
  /** The name it was started with. */
  name?: string
  /** The machine it runs on, when that is not this one. */
  device: { id: string; name: string } | null
  /** Where its transcript is, for opening it; null until it is on disk or while its machine is away. */
  address: { dirName: string; fileName: string } | null
  outcome: CrewOutcome
  status?: string | null
  toolName?: string | null
  waiting: PendingInput[]
  error?: string
  /** What the session list knows about it, for a session on this machine. */
  customTitle?: string
  aiTitle?: string
  firstUserMessage?: string
  cwd?: string
  model?: string
  turnCount?: number
  lastActivityAt?: string
  pullRequests?: SessionPullRequest[]
  /** The task that carries its result to its parent, when one was recorded. */
  result?: { taskId: string; state: "running" | "completed" | "error" | "cancelled"; acknowledged: boolean }
}

export interface SessionCrew {
  /** The session asked about. */
  sessionId: string
  rootId: string
  /** The root first, then every member at any depth, in the order they were started. */
  members: CrewMember[]
}
