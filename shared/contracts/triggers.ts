import type { AgentKind } from "../session/agent-descriptors"
import type { CommandReceipt } from "./orchestration"

/**
 * Durable trigger occurrences and the unattended authority they run under.
 *
 * A trigger is a consumer's definition (a schedule, a webhook, a usage-limit
 * continuation); each due event of it is one occurrence with its own durable
 * identity. An occurrence reaches an agent only through the existing durable
 * command path (a deterministic command id) or the existing creation
 * operation (a deterministic request id), so a crash at any boundary leaves
 * a receipt to reconcile rather than a duplicate delivery.
 */

/** What an unattended execution may do; a grant names the ones it allows. */
export type UnattendedAction = "session.create" | "session.send"
export const UNATTENDED_ACTIONS: readonly UnattendedAction[] = ["session.create", "session.send"]

/**
 * Exactly what a grant lets its executions reach. Every field present must
 * match the execution: a grant for one project cannot start a session in
 * another, nor send to a session it does not name.
 */
export interface ExecutionTarget {
  agent: AgentKind
  /** Provider instance (account); "default" for the agent's own. */
  instanceId: string
  /** Project dirName a created session is filed under. */
  dirName?: string
  /** Working directory a created session runs in. */
  cwd?: string
  /** Workspace a created session uses: the project itself, or a named worktree. */
  workspace?: string
  /** The one session a send may reach. */
  sessionId?: string
  /** The provider binding revision a send was authorized against; a handoff changes it. */
  bindingRevision?: number
}

/**
 * Where an unattended execution's authority comes from:
 * `personal` — the personal edition's one owner, limited to this grant;
 * `edition` — a durable grant the installed edition issued and re-checks;
 * `none` — the edition cannot authorize unattended work, so every
 * occurrence is held until someone with access reauthorizes it live.
 */
export type GrantSource = "personal" | "edition" | "none"

/** A durable, revocable and scope-limited authority. Never carries a cookie, token or request. */
export interface ExecutionGrant {
  id: string
  /** Bumped by every change; an occurrence admitted under an older revision is re-checked. */
  revision: number
  /** The account the grant acts as: a user id, or "local" in personal edition. */
  scope: string
  source: GrantSource
  actions: UnattendedAction[]
  target: ExecutionTarget
  /** What the grant is for, shown wherever it is listed. */
  label: string
  createdAt: number
  updatedAt: number
  expiresAt?: number
  revokedAt?: number
  revokedReason?: string
}

/** How an occurrence refers to the grant it runs under. */
export interface GrantRef {
  grantId: string
  revision: number
}

/**
 * `scheduled` — waiting for `dueAt`;
 * `admitting` — claimed by the dispatcher, its command not yet admitted;
 * `creating` — its session creation began and has not reported back;
 * `admitted` — its durable command exists; `command` reports delivery;
 * `held` — waiting for reauthorization or review (`reason` says which);
 * `unknown` — a crash left the provider outcome unknown; reconcile, never replay;
 * `completed`, `failed`, `cancelled`, `skipped` — terminal.
 */
export type OccurrenceState =
  | "scheduled"
  | "admitting"
  | "creating"
  | "admitted"
  | "held"
  | "unknown"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"

export const TERMINAL_OCCURRENCE_STATES: readonly OccurrenceState[] = ["completed", "failed", "cancelled", "skipped"]

/** Why an occurrence is held, so the UI can offer the matching control. */
export type OccurrenceHold = "reauthorize" | "review" | "binding"

/** Untrusted data an occurrence carries for its consumer, such as a webhook body. Never authority, never interpolated into a shell. */
export interface OccurrenceInput {
  /** The delivery or slot key it arrived with. */
  key: string
  receivedAt: number
  /** Bounded, already-validated text or JSON the consumer wraps as data. */
  data: unknown
}

export interface TriggerOccurrence {
  id: string
  scope: string
  triggerId: string
  /** The consumer that owns it, such as `automation` or `recovery`. */
  kind: string
  /** The key it was first recorded with: a schedule slot, a webhook delivery id. */
  key: string
  state: OccurrenceState
  dueAt: number
  action: UnattendedAction
  grant: GrantRef | null
  /** Consumer-owned description of the execution, re-read at execution. */
  request: Record<string, unknown>
  /** Every delivery a burst coalesced into this one, oldest first. */
  inputs: OccurrenceInput[]
  /** Deterministic durable identities, derived from the occurrence id. */
  commandId: string
  creationId: string
  /** The session it reached or created. */
  sessionId?: string
  /** The durable command's receipt while it is `admitted`. */
  command?: CommandReceipt
  hold?: OccurrenceHold
  reason?: string
  attempt: number
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

/** A consumer's durable definition, stored generically; `data` is the consumer's own. */
export interface TriggerRecord<T = Record<string, unknown>> {
  id: string
  scope: string
  kind: string
  revision: number
  state: "active" | "paused"
  grant: GrantRef | null
  /** The next time its consumer wants an occurrence recorded. */
  nextDueAt: number | null
  data: T
  createdAt: number
  updatedAt: number
}

/** Deterministic ids an occurrence's command and session creation use; both satisfy the durable id pattern. */
export function occurrenceCommandId(occurrenceId: string): string { return `trg-${occurrenceId}` }
export function occurrenceCreationId(occurrenceId: string): string { return `trgc-${occurrenceId}` }

export function isTerminalOccurrence(state: OccurrenceState): boolean { return TERMINAL_OCCURRENCE_STATES.includes(state) }
