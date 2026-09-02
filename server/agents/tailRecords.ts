import { AGENT_KINDS, type AgentKind } from "../../shared/session/agent-descriptors"
import type { RawRecord, SessionStatusInfo } from "../../shared/session/types"

/**
 * Per-agent interpretation of a single transcript record, for the reverse tail
 * scan that derives session status.
 *
 * The scan itself — reading 4KB chunks backwards, splitting lines, stopping as
 * soon as the verdict is decided — is agent-neutral and stays in
 * `sessionMetadata.ts`. What each record *means* is not, and lives here.
 */

export type TailVerdict =
  /** Cannot affect the verdict; drop it. */
  | { readonly kind: "ignore" }
  /** Keep the record and keep scanning. */
  | { readonly kind: "keep"; readonly sawUserActivity?: boolean }
  /** Keep the record and answer from everything collected so far. */
  | { readonly kind: "answer" }
  /**
   * Keep the record, but answer only if the collected records are conclusive —
   * an idle verdict here means the scan has not read back far enough yet.
   */
  | { readonly kind: "answer-if-active" }
  /** Keep the record and switch the scan into its filtered second phase. */
  | { readonly kind: "turn-end"; readonly awaitUserActivity?: boolean }
  /** Answer immediately with a fixed status; the record itself is dropped. */
  | { readonly kind: "final"; readonly status: SessionStatusInfo }

const IGNORE: TailVerdict = { kind: "ignore" }
const KEEP: TailVerdict = { kind: "keep" }
const ANSWER: TailVerdict = { kind: "answer" }

export interface AgentTailFormat {
  readonly kind: AgentKind
  /**
   * Substrings that mark a line as still able to change a settled verdict.
   * A cheap string test that keeps the filtered phase from parsing lines it
   * would only discard.
   */
  readonly markers: readonly string[]
  /** Verdict for a record read before any turn-ending line was seen. */
  classify(record: RawRecord): TailVerdict
  /** Verdict for a record read after this agent's own turn-ending line. */
  classifyAfterTurnEnd(record: RawRecord): TailVerdict
}

// ── Claude ──────────────────────────────────────────────────────────────────

const claudeTail: AgentTailFormat = {
  kind: "claude",
  // Background agent/workflow launches, task notifications and TaskStop calls
  // can all still change a verdict that a turn-ending line looked to settle.
  markers: ["async_launched", "task-notification", '"TaskStop"'],

  classify(record) {
    // terminal_reason system message — the session ended abnormally.
    if (record.type === "system" && (record as { subtype?: string }).subtype === "terminal_reason") {
      const reason = (record as { reason?: string }).reason
      return reason ? { kind: "final", status: { status: "completed", terminalReason: reason } } : IGNORE
    }

    if (record.type === "progress") {
      const data = (record as {
        data?: {
          type?: string
          decision?: string
          hookSpecificOutput?: { permissionDecision?: string }
        }
      }).data
      if (data?.type !== "hook_progress") return IGNORE
      const decision = data.decision ?? data.hookSpecificOutput?.permissionDecision
      // A deferred hook is the agent waiting on a human, which outranks
      // whatever the surrounding records say.
      return decision === "defer" ? ANSWER : IGNORE
    }

    // Task-notification attachments in the tail mean a wakeup is being
    // delivered; the status derivation reads them during its own walk.
    if (record.type === "attachment") return KEEP

    if (record.type === "assistant" || record.type === "user" || record.type === "queue-operation") {
      // end_turn needs user context and pending background-launch info, so it
      // switches to the filtered scan instead of deciding here.
      const stopReason = (record.message as { stop_reason?: string } | undefined)?.stop_reason
      if (record.type === "assistant" && stopReason === "end_turn") {
        return { kind: "turn-end", awaitUserActivity: true }
      }
      const canDerive = record.type === "assistant"
        || (record.type === "user" && !(record as { isMeta?: boolean }).isMeta)
      return canDerive ? ANSWER : KEEP
    }

    return IGNORE
  },

  classifyAfterTurnEnd(record) {
    if (
      record.type !== "user"
      && record.type !== "assistant"
      && record.type !== "queue-operation"
      && record.type !== "attachment"
    ) return IGNORE
    const isRealUserTurn = record.type === "user" && !(record as { isMeta?: boolean }).isMeta
    return { kind: "keep", sawUserActivity: isRealUserTurn }
  },
}

// ── Codex ───────────────────────────────────────────────────────────────────

const codexTail: AgentTailFormat = {
  kind: "codex",
  // function_call_output is included because output lines carry only a call_id —
  // the tracker links them back to the spawn/wait/interrupt call they answer.
  markers: [
    "spawn_agent",
    "spawnAgent",
    "wait_agent",
    "waitAgent",
    "interrupt_agent",
    "interruptAgent",
    "sub_agent_activity",
    "agent_message",
    "function_call_output",
  ],

  classify(record) {
    if (record.type === "event_msg") {
      const payload = record.payload as { type?: string } | undefined
      switch (payload?.type) {
        case "task_complete":
          // Spawned collab agents may still be running — keep scanning for
          // their lifecycle records.
          return { kind: "turn-end" }
        case "task_started":
          return { kind: "final", status: { status: "processing" } }
        case "agent_message":
          return { kind: "final", status: { status: "thinking" } }
        default:
          return IGNORE
      }
    }

    if (record.type === "response_item") {
      const payload = record.payload as { type?: string; role?: string } | undefined
      const decides = payload?.type === "function_call"
        || (payload?.type === "message" && (payload.role === "assistant" || payload.role === "user"))
      return decides ? ANSWER : IGNORE
    }

    return IGNORE
  },

  classifyAfterTurnEnd(record) {
    return record.type === "event_msg" || record.type === "response_item" ? KEEP : IGNORE
  },
}

// ── Copilot ─────────────────────────────────────────────────────────────────

/** A sub-agent's own lifecycle record, as opposed to its chatter. */
function isSubagentLifecycle(record: RawRecord): boolean {
  return record.type.startsWith("subagent.")
    && typeof record.agentId === "string"
    && record.agentId.length > 0
}

/** Sub-agent output is noise for the parent session's status. */
function isSubagentNoise(record: RawRecord): boolean {
  return typeof record.agentId === "string" && record.agentId.length > 0
}

const copilotTail: AgentTailFormat = {
  kind: "copilot",
  markers: ['"abort"', '"assistant.message"', '"user.message"', '"subagent.'],

  classify(record) {
    if (isSubagentLifecycle(record)) return KEEP

    const decidable = record.type === "abort"
      || record.type === "user.message"
      || record.type.startsWith("assistant.")
      || record.type.startsWith("permission.")
      || record.type.startsWith("session.")
      || record.type.startsWith("tool.")
      || record.type.startsWith("user_input.")
    if (!decidable || isSubagentNoise(record)) return IGNORE

    if (record.type === "assistant.turn_end") return { kind: "turn-end" }
    // A session boundary is conclusive even when it derives as idle: there is
    // nothing older that could change the answer.
    if (record.type === "session.start" || record.type === "session.resume") return ANSWER
    return { kind: "answer-if-active" }
  },

  classifyAfterTurnEnd(record) {
    if (isSubagentLifecycle(record)) return KEEP
    if (isSubagentNoise(record)) return IGNORE
    const decides = record.type === "abort"
      || record.type === "assistant.message"
      || record.type === "user.message"
    return decides ? ANSWER : IGNORE
  },
}

// ── Registry ────────────────────────────────────────────────────────────────

const TAIL_FORMATS: Readonly<Record<AgentKind, AgentTailFormat>> = Object.freeze({
  claude: claudeTail,
  codex: codexTail,
  copilot: copilotTail,
})

export function tailFormatFor(kind: AgentKind): AgentTailFormat {
  return TAIL_FORMATS[kind]
}

export interface TailMatch {
  readonly format: AgentTailFormat
  readonly verdict: TailVerdict
}

/**
 * The first format that claims `record`, or null when none does.
 *
 * A scan that has not yet seen a turn-ending line does not know which agent
 * wrote the transcript, so it asks each in detection order. Their record
 * vocabularies are disjoint — Claude's bare `assistant`/`user`, Codex's
 * `event_msg`/`response_item`, Copilot's dotted namespace — so at most one ever
 * answers, and the order only decides who is asked first.
 */
export function classifyTailRecord(record: RawRecord): TailMatch | null {
  for (const kind of AGENT_KINDS) {
    const format = TAIL_FORMATS[kind]
    const verdict = format.classify(record)
    if (verdict.kind !== "ignore") return { format, verdict }
  }
  return null
}
