import type { AgentKind } from "../session/agent-descriptors"
import type { GrantSource, OccurrenceHold, OccurrenceState } from "./triggers"

/**
 * Scheduled and webhook-triggered tasks (item 8). A task starts a new
 * session in one project, with one provider account, model and workspace,
 * each time it runs. Definitions, runs and webhook secrets are stored by the
 * shared trigger store; this is the browser-safe view of them.
 */

export const AUTOMATION_KIND = "automation"

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
export type Weekday = (typeof WEEKDAYS)[number]

/**
 * `interval` — every `everyMinutes` from when the task was saved;
 * `daily` — at `time` (HH:MM) on the given weekdays in an IANA time zone,
 * following daylight-saving changes: a time skipped by a spring-forward runs
 * at the first moment after the gap, and a time repeated by a fall-back runs
 * once, at its first occurrence.
 */
export type AutomationSchedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string; days: Weekday[]; timeZone: string }

/** `skip` records missed slots as skipped; `run-once` runs once for all of them when the host is back. */
export type MissedRunPolicy = "skip" | "run-once"
/** `skip` skips a run while the previous run's session is still working; `allow` starts it anyway. */
export type OverlapPolicy = "skip" | "allow"

export interface AutomationWebhook {
  enabled: boolean
  /**
   * `cogpit` — `X-Cogpit-Timestamp` (unix seconds, within five minutes) and
   * `X-Cogpit-Signature: sha256=<hex HMAC of "timestamp.body">`, with
   * `X-Cogpit-Delivery` naming the delivery;
   * `github` — `X-Hub-Signature-256: sha256=<hex HMAC of the body>` with
   * `X-GitHub-Delivery`.
   */
  scheme: "cogpit" | "github"
  /** Deliveries arriving within this many seconds of the first one run together. */
  coalesceSeconds: number
}

export interface AutomationDefinition {
  name: string
  /** What the session is asked to do. Webhook deliveries are attached after it, as untrusted data. */
  prompt: string
  project: { dirName: string; cwd: string }
  provider: { agent: AgentKind; instanceId: string; model?: string; effort?: string; permissionMode?: string }
  /** `worktree` starts each run in a new worktree (and its setup recipe) named after the task. */
  workspace: "project" | "worktree"
  schedule: AutomationSchedule | null
  webhook: AutomationWebhook | null
  missed: MissedRunPolicy
  overlap: OverlapPolicy
}

export interface AutomationTask extends AutomationDefinition {
  id: string
  revision: number
  state: "active" | "paused"
  nextRunAt: number | null
  /** Where the task's authority comes from; `none` means every run waits for its owner to reauthorize it. */
  authority: { source: GrantSource; revoked: boolean } | null
  webhookUrl: string | null
  /** Whether the webhook URL is reachable from outside this machine, as far as the server knows. */
  webhookReachability: "public" | "local-only" | "unavailable"
  webhookSecrets: Array<{ id: string; createdAt: number }>
  createdAt: number
  updatedAt: number
}

export interface AutomationRun {
  id: string
  /** `schedule`, `webhook` or `manual`. */
  trigger: "schedule" | "webhook" | "manual"
  state: OccurrenceState
  hold?: OccurrenceHold
  reason?: string
  dueAt: number
  createdAt: number
  finishedAt?: number
  deliveries: number
  /** The session the run started, once it did; `working` while it still runs. */
  session?: { sessionId: string; dirName?: string; fileName?: string; working: boolean }
}

/** What a create or edit sends. A new webhook secret is returned once, never stored where it can be listed. */
export interface SaveAutomationRequest {
  definition: AutomationDefinition
  state?: "active" | "paused"
  expectedRevision?: number
}

export interface SaveAutomationResponse {
  task: AutomationTask
  /** Present only when this save created or rotated the webhook secret. */
  webhookSecret?: string
}

export const AUTOMATION_LIMITS = Object.freeze({ nameChars: 120, promptChars: 20_000, minIntervalMinutes: 5, maxIntervalMinutes: 60 * 24 * 30, webhookBodyBytes: 64 * 1024, maxCoalesceSeconds: 600, deliveriesPerRun: 20 })
