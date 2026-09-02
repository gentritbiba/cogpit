// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Turn builder — state machine that converts raw JSONL messages into Turn objects.
 */

import type {
  RawMessage,
  Turn,
  TurnContentBlock,
  ToolCall,
  SubAgentMessage,
  TokenUsage,
  ThinkingBlock,
  ContentBlock,
  AgentToolUseResult,
  ParsedHookEvent,
  HookProgressData,
  AssistantMessage,
  UserMessage,
  MessageAttribution,
  CompactionMeta,
  UserContent,
} from "./types"
import {
  isUserMessage,
  isAssistantMessage,
  isProgressMessage,
  isSystemMessage,
  isSummaryMessage,
  isCompactBoundary,
  isCompactSummaryMessage,
  isQueueOperationMessage,
  isAttachmentMessage,
} from "./messageTypeGuards"
import { parseAgentEnvelope } from "./agentEnvelope"

function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}

function extractToolResultText(content: string | ContentBlock[] | undefined | null): string {
  if (!content) return ""
  if (typeof content === "string") return content
  return content
    .map((b) => {
      if (b.type === "text") return b.text
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

/**
 * Queue entries also carry internal task notifications; only user-authored
 * prompts belong in the timeline.
 *
 * Claude Code 2.1.234+ wraps background-task notifications in a
 * <system-reminder> envelope, so the task-notification marker is matched
 * anywhere in the content rather than only at the very start. The leading-"<"
 * guard keeps prose that merely mentions one of these tags visible.
 */
function isVisibleQueuedPrompt(content: string | null | undefined): content is string {
  if (!content?.trim()) return false
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("<")) return true
  return !trimmed.includes("<task-notification>")
    && !trimmed.startsWith("<system-reminder>")
    && !trimmed.startsWith("<local-command-")
}

const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>[\s\S]*?<\/task-notification>/g
const ANY_TAG_RE = /<[^>]*>/g

/**
 * True when a user record is nothing but background tasks reporting back.
 *
 * `origin.kind` is authoritative and present from Claude Code 2.1.220. Older
 * records are recognised by shape: drop the notification blocks and any
 * envelope tags around them, and a wake-up has nothing left. A prompt that
 * quotes a notification keeps its prose and stays a prompt.
 */
function isTaskNotificationRecord(msg: UserMessage): boolean {
  if (msg.origin?.kind === "task-notification") return true
  const text = extractTextFromContent(msg.message.content)
  if (!text.includes("<task-notification>")) return false
  return text.replace(TASK_NOTIFICATION_BLOCK_RE, "").replace(ANY_TAG_RE, "").trim() === ""
}

interface QueuedPromptSource {
  /**
   * The prompt exactly as written. This is the enqueue ledger's key — the
   * queue-operation copy and this attachment copy only reconcile on an exact
   * raw match, so never substitute the stripped body here.
   */
  raw: string
  /** Peer sender, or null when the reader typed this. */
  sender: string | null
  /** Envelope-free body. Equals `raw` when there was no envelope. */
  body: string
}

/**
 * A prompt queued mid-turn, or null for anything else.
 * Claude Code leaves `content` empty on the queue-operation record and writes
 * the prompt here instead, so this is the only copy for most queued prompts.
 */
function queuedCommandPrompt(msg: RawMessage): QueuedPromptSource | null {
  if (!isAttachmentMessage(msg)) return null
  const attachment = msg.attachment
  if (!attachment || attachment.type !== "queued_command") return null
  if (attachment.commandMode !== "prompt") return null
  const prompt = attachment.prompt
  if (prompt == null) return null
  const raw = typeof prompt === "string" ? prompt : extractTextFromContent(prompt)
  if (!isVisibleQueuedPrompt(raw)) return null

  const origin = attachment.origin
  if (origin?.kind === "peer") {
    const sender = origin.name ?? origin.from ?? null
    if (sender) {
      return {
        raw,
        sender,
        body: origin.body ?? parseAgentEnvelope(raw).body,
      }
    }
  }
  if (origin?.kind === "human") {
    return { raw, sender: null, body: raw }
  }

  // Pre-`origin` records: the envelope in the text is all we have.
  const parsed = parseAgentEnvelope(raw)
  return { raw, sender: parsed.sender, body: parsed.body }
}

/** Maps the flat `attribution*` record fields onto their MessageAttribution keys. */
const ATTRIBUTION_FIELDS = [
  ["attributionAgent", "agent"],
  ["attributionSkill", "skill"],
  ["attributionPlugin", "plugin"],
  ["attributionMcpServer", "mcpServer"],
  ["attributionMcpTool", "mcpTool"],
] as const

/**
 * Folds one assistant record's attribution into the turn's.
 *
 * Later messages win per field, and a turn with nothing attributed keeps
 * `undefined` rather than an empty object, so callers can branch on presence.
 */
function mergeAttribution(
  current: MessageAttribution | undefined,
  msg: AssistantMessage,
): MessageAttribution | undefined {
  let merged = current
  for (const [field, key] of ATTRIBUTION_FIELDS) {
    const value = msg[field]
    if (typeof value !== "string" || !value) continue
    merged = { ...merged, [key]: value }
  }
  return merged
}

// ── Local mergeTokenUsage (duplicated to avoid circular deps) ────────────────

function mergeTokenUsage(
  existing: TokenUsage | null,
  incoming: TokenUsage
): TokenUsage {
  if (!existing) {
    return { ...incoming }
  }
  // Thinking tokens are a slice of output_tokens, so they add up the same way.
  // Dropping them here used to make a turn with several assistant records fall
  // back to a 4-chars-per-token estimate even though every record reported the
  // exact count.
  const thinking =
    (existing.output_tokens_details?.thinking_tokens ?? 0) +
    (incoming.output_tokens_details?.thinking_tokens ?? 0)
  return {
    input_tokens: existing.input_tokens + incoming.input_tokens,
    output_tokens: existing.output_tokens + incoming.output_tokens,
    cache_creation_input_tokens:
      (existing.cache_creation_input_tokens ?? 0) +
      (incoming.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (existing.cache_read_input_tokens ?? 0) +
      (incoming.cache_read_input_tokens ?? 0),
    speed: incoming.speed ?? existing.speed,
    ...(existing.output_tokens_details || incoming.output_tokens_details
      ? { output_tokens_details: { thinking_tokens: thinking } }
      : {}),
  }
}

// ── Compaction Summary ───────────────────────────────────────────────────────

/** Boilerplate Claude Code wraps around the summary when it replays it as a user message. */
const RESUME_PREAMBLE_RE =
  /^This session is being continued from a previous conversation[\s\S]*?\n\nSummary:\s*\n/
const RESUME_INSTRUCTIONS_RE =
  /\n+(?:If you need specific details from before compaction|(?:Please c|C)ontinue the conversation from where it left off)[\s\S]*$/

/**
 * Pull the model-written summary out of the post-compaction user message.
 * Text that doesn't carry the boilerplate is returned as-is.
 */
function extractCompactionSummary(content: UserContent): string {
  const text = extractTextFromContent(content).trim()
  return text.replace(RESUME_PREAMBLE_RE, "").replace(RESUME_INSTRUCTIONS_RE, "").trim()
}

/** The boundary record also carries preserved-message uuid lists we have no use for. */
function normalizeCompactionMeta(meta: CompactionMeta | undefined): CompactionMeta | undefined {
  if (!meta) return undefined
  return { trigger: meta.trigger, preTokens: meta.preTokens, postTokens: meta.postTokens }
}

interface PendingCompaction {
  summary?: string
  meta?: CompactionMeta
}

function createTurn(msg: RawMessage, userMessage: UserContent | null): Turn {
  return {
    id: msg.uuid ?? crypto.randomUUID(),
    userMessage,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: msg.timestamp ?? "",
    durationMs: null,
    tokenUsage: null,
    model: null,
  }
}

// ── Plan Mode grouping ───────────────────────────────────────────────────────

/**
 * Post-processes a turn's contentBlocks to group EnterPlanMode → ... → ExitPlanMode
 * tool call sequences into a single `plan_mode` content block.
 *
 * EnterPlanMode.input.plan — the plan text (markdown string)
 * ExitPlanMode.input.path  — optional file path where plan was saved
 *
 * Status:
 *   "approved" — ExitPlanMode has a non-error tool result
 *   "rejected" — ExitPlanMode has an error tool result
 *   "pending"  — ExitPlanMode not yet seen, or result not yet received
 */
function groupPlanModeBlocks(blocks: TurnContentBlock[]): TurnContentBlock[] {
  const result: TurnContentBlock[] = []
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]

    // Only inspect tool_calls blocks for EnterPlanMode
    if (block.kind === "tool_calls") {
      const enterIdx = block.toolCalls.findIndex((tc) => tc.name === "EnterPlanMode")
      if (enterIdx !== -1) {
        const enterCall = block.toolCalls[enterIdx]
        const plan = String(enterCall.input.plan ?? "")
        const timestamp = block.timestamp

        // Collect non-Enter tool calls from the same block (before enter)
        const before = block.toolCalls.slice(0, enterIdx)
        if (before.length > 0) {
          result.push({ kind: "tool_calls", toolCalls: before, timestamp: block.timestamp })
        }

        // Collect embedded tool calls (after enter in same block + subsequent blocks)
        const embedded: ToolCall[] = []

        // Same block: tools after EnterPlanMode
        const afterEnterInSameBlock = block.toolCalls.slice(enterIdx + 1)
        const exitInSameBlock = afterEnterInSameBlock.findIndex((tc) => tc.name === "ExitPlanMode")
        if (exitInSameBlock !== -1) {
          // ExitPlanMode is in the same tool_calls block
          embedded.push(...afterEnterInSameBlock.slice(0, exitInSameBlock))
          const exitCall = afterEnterInSameBlock[exitInSameBlock]
          const planFilePath = exitCall.input.path ? String(exitCall.input.path) : undefined
          let status: "pending" | "approved" | "rejected" = "pending"
          if (exitCall.result !== null) {
            status = exitCall.isError ? "rejected" : "approved"
          }
          result.push({ kind: "plan_mode", plan, planFilePath, status, toolCalls: embedded, timestamp })
          // Any tools after ExitPlanMode in same block
          const after = afterEnterInSameBlock.slice(exitInSameBlock + 1)
          if (after.length > 0) {
            result.push({ kind: "tool_calls", toolCalls: after, timestamp: block.timestamp })
          }
          i++
          continue
        } else {
          // ExitPlanMode is in a later block — scan forward
          embedded.push(...afterEnterInSameBlock)

          let exitCall: ToolCall | undefined
          let planFilePath: string | undefined
          let status: "pending" | "approved" | "rejected" = "pending"
          let j = i + 1

          // Passthrough blocks are skipped during the scan (they don't break the
          // EnterPlanMode → ExitPlanMode grouping) and are re-emitted in their
          // original chronological position after the plan_mode block is formed.
          const passthroughBlocks: TurnContentBlock[] = []

          while (j < blocks.length) {
            const next = blocks[j]
            if (next.kind === "tool_calls") {
              const exitIdx = next.toolCalls.findIndex((tc) => tc.name === "ExitPlanMode")
              if (exitIdx !== -1) {
                // Tools before ExitPlanMode in this block
                embedded.push(...next.toolCalls.slice(0, exitIdx))
                exitCall = next.toolCalls[exitIdx]
                planFilePath = exitCall.input.path ? String(exitCall.input.path) : undefined
                if (exitCall.result !== null) {
                  status = exitCall.isError ? "rejected" : "approved"
                }
                // Tools after ExitPlanMode in this block
                const tail = next.toolCalls.slice(exitIdx + 1)
                result.push({ kind: "plan_mode", plan, planFilePath, status, toolCalls: embedded, timestamp })
                // Re-emit passthrough blocks that appeared mid-scan
                result.push(...passthroughBlocks)
                // Push tail of exit block back for further processing
                if (tail.length > 0) {
                  result.push({ kind: "tool_calls", toolCalls: tail, timestamp: next.timestamp })
                }
                i = j + 1
                break
              } else {
                // This block has no ExitPlanMode — embed all its tool calls
                embedded.push(...next.toolCalls)
                j++
              }
            } else if (
              next.kind === "hook_event"
              || next.kind === "text"
              || next.kind === "queued_prompt"
              || next.kind === "agent_message"
            ) {
              // Passthrough presentation blocks don't break the scan.
              // Collect them for re-emission in chronological position after the plan block.
              passthroughBlocks.push(next)
              j++
            } else {
              // Any other block kind (sub_agent, background_agent, recap, etc.) — stop scanning
              break
            }
          }

          if (!exitCall) {
            // No ExitPlanMode found — emit pending plan_mode with all collected embedded calls
            result.push({ kind: "plan_mode", plan, planFilePath: undefined, status: "pending", toolCalls: embedded, timestamp })
            // Re-emit passthrough blocks even in the pending case
            result.push(...passthroughBlocks)
            i = j
          }
          continue
        }
      }
    }

    result.push(block)
    i++
  }
  return result
}

// ── Build Turns State Machine ────────────────────────────────────────────────

/** Drops the pairing a previous run left on this turn, without touching the original. */
function clearAgentMessageReplies(turn: Turn): Turn {
  if (!turn.contentBlocks.some((b) => b.kind === "agent_message")) return turn
  return {
    ...turn,
    contentBlocks: turn.contentBlocks.map((block) => {
      if (block.kind !== "agent_message") return block
      const { reply: _paired, ...unpaired } = block
      return unpaired
    }),
  }
}

/**
 * Attach each peer message to the `SendMessage` that answered it.
 *
 * Walks blocks in chronological order holding the still-unanswered messages per
 * sender, so a reply claims the oldest outstanding message from that sender and
 * pairing only ever runs forward in time. A `SendMessage` sent *before* any
 * inbound message from that sender is an instruction, not a reply.
 *
 * The join is on the sender name, which is the only key available: the block
 * carries no task id, because `origin.senderTaskId` names the sending agent's
 * task rather than the message. `SendMessage.input.to` uses the same names that
 * arrive in `origin.from`, so the join holds.
 *
 * A pure recompute: every existing pairing is cleared before the walk, so the
 * answer depends only on the list handed in. Callers that assemble a transcript
 * from several `buildTurns` calls — the page stitcher and the incremental
 * append — re-run it over the joined list and get what a single parse of that
 * list would have produced. Turns holding no peer message come back by
 * reference, so a re-run costs nothing for the rest of the transcript.
 */
export function pairAgentMessageReplies(turns: readonly Turn[]): Turn[] {
  const repaired = turns.map(clearAgentMessageReplies)
  const unanswered = new Map<string, Array<Extract<TurnContentBlock, { kind: "agent_message" }>>>()

  for (const turn of repaired) {
    for (const block of turn.contentBlocks) {
      if (block.kind === "agent_message") {
        const waiting = unanswered.get(block.sender)
        if (waiting) waiting.push(block)
        else unanswered.set(block.sender, [block])
        continue
      }
      if (block.kind !== "tool_calls") continue

      for (const call of block.toolCalls) {
        if (call.name !== "SendMessage") continue
        const to = call.input.to
        if (typeof to !== "string" || !to) continue
        const target = unanswered.get(to)?.shift()
        if (!target) continue
        const summary = call.input.summary
        target.reply = {
          summary: typeof summary === "string" ? summary : "",
          timestamp: call.timestamp || block.timestamp || "",
        }
      }
    }
  }

  return repaired
}

/**
 * Raw-message index where each turn `buildTurns` would produce begins, so
 * `starts[i]` is the index that produces `turns[i]`.
 *
 * Incremental appends need both a rebuild cut point and the number of turns
 * that precede it. Deriving them separately is how an append drifts out of
 * sync with a full re-parse, so both come from this one pass.
 *
 * Mirrors the turn-creation rule of `buildTurns` below — a parser test asserts
 * the two agree, so keep them in lockstep.
 *
 * This is a cheap forward scan on the append hot path, which is the only reason
 * it restates the rule instead of calling `buildTurnsWithStarts`. It is
 * deliberately NOT used to cut a transcript: undo and branching go through
 * `AgentFormat.turnBoundaries`, which is derived from the real turn walk,
 * because a boundary that disagrees with the parser truncates history. Widen
 * this only alongside `buildTurns`, never on its own.
 */
export function findTurnStartIndices(messages: RawMessage[]): number[] {
  const starts: number[] = []
  let hasOpenTurn = false

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (isSummaryMessage(msg) || isCompactBoundary(msg)) {
      hasOpenTurn = false
      continue
    }

    if (isUserMessage(msg) && !msg.isMeta) {
      const content = msg.message.content
      const continuesOpenTurn = hasOpenTurn
        && Array.isArray(content)
        && content.some((b) => b.type === "tool_result")
      if (continuesOpenTurn) continue
      starts.push(i)
      hasOpenTurn = true
      continue
    }

    if (isAssistantMessage(msg) && !hasOpenTurn) {
      starts.push(i)
      hasOpenTurn = true
    }
  }

  return starts
}

export interface BuiltTurns {
  turns: Turn[]
  /** Index, into `messages`, of the record that opened each turn. */
  turnStartIndices: number[]
}

/**
 * Build turns and report where each one started.
 *
 * Turn boundaries used to be derived by a separate predicate that restated this
 * function's turn rule; the two drifted, and because boundaries decide where a
 * transcript gets physically cut, the disagreement silently truncated history.
 * Both now come from this one walk.
 */
export function buildTurnsWithStarts(messages: RawMessage[]): BuiltTurns {
  const turns: Turn[] = []
  const turnStartIndices: number[] = []
  let pendingTurnStart: number | null = null
  let recordIndex = 0
  let current: Turn | null = null

  // Track the compaction to attach to the next turn
  let pendingCompaction: PendingCompaction | null = null

  /** A boundary with no summary message after it still marks the turn it precedes. */
  function attachPendingCompaction(turn: Turn) {
    if (!pendingCompaction) return
    turn.compactionSummary = pendingCompaction.summary
    turn.compactionMeta = pendingCompaction.meta
    pendingCompaction = null
  }

  // Track away_summary / recap to prepend as a recap content block on the next turn
  let pendingRecap: { content: string; timestamp?: string } | null = null

  // Map from tool_use id -> index in current turn's toolCalls
  const pendingToolUses = new Map<string, { turn: Turn; index: number }>()

  // Deduplicate usage: Claude Code logs multiple JSONL entries per API call
  // (one per content block: thinking, text, tool_use), all sharing the same
  // message.id with identical usage data. Only count usage once per message ID.
  const seenMessageIds = new Set<string>()

  // Map from parentToolUseID -> sub-agent messages for grouping
  const subAgentMap = new Map<string, SubAgentMessage[]>()

  // Track which parentToolUseIDs already have a content block (sub_agent or background_agent)
  // so we can append to an existing block rather than creating duplicates
  const agentBlockMap = new Map<string, { kind: "sub_agent" | "background_agent"; messages: SubAgentMessage[] }>()

  // Track parentToolUseIDs from Task tool calls with run_in_background: true
  const backgroundAgentParentIds = new Set<string>()

  // Track Task tool call metadata (name, subagent_type) by tool_use ID
  const taskMetaMap = new Map<string, { name: string | null; subagentType: string | null }>()

  // A queued prompt may either be an in-turn steer or the durable precursor to
  // the next ordinary user record. Hold it until the next non-queue record so
  // the latter shape can be reconciled without rendering the prompt twice.
  const pendingQueuedPrompts: Array<{
    turn: Turn
    /** Ledger key and `queued_prompt` content. Always the raw prompt text. */
    content: string
    timestamp?: string
    sender: string | null
    body: string
  }> = []

  // Prompt text already recorded from a queue-operation enqueue, counted per
  // turn. Claude Code writes the same prompt a second time as a queued_command
  // attachment once it reaches the model, so that later copy is matched against
  // this ledger and dropped. Counting (rather than a set) keeps a prompt the
  // user genuinely queued twice in one turn rendering twice.
  const enqueueSourcedPrompts = new Map<Turn, Map<string, number>>()

  function noteEnqueueSourced(turn: Turn, content: string) {
    let counts = enqueueSourcedPrompts.get(turn)
    if (!counts) {
      counts = new Map()
      enqueueSourcedPrompts.set(turn, counts)
    }
    counts.set(content, (counts.get(content) ?? 0) + 1)
  }

  function consumeEnqueueSourced(turn: Turn, content: string): boolean {
    const counts = enqueueSourcedPrompts.get(turn)
    const remaining = counts?.get(content)
    if (!counts || !remaining) return false
    if (remaining === 1) counts.delete(content)
    else counts.set(content, remaining - 1)
    return true
  }

  function flushPendingQueuedPrompts() {
    for (const prompt of pendingQueuedPrompts) {
      prompt.turn.contentBlocks.push(
        prompt.sender
          ? {
              kind: "agent_message",
              sender: prompt.sender,
              body: prompt.body,
              timestamp: prompt.timestamp,
            }
          : {
              kind: "queued_prompt",
              content: prompt.content,
              timestamp: prompt.timestamp,
            },
      )
    }
    pendingQueuedPrompts.length = 0
  }

  function flushSubAgentMessages(parentId: string) {
    if (!current) return
    const agentMsgs = subAgentMap.get(parentId)
    if (!agentMsgs || agentMsgs.length === 0) return

    current.subAgentActivity.push(...agentMsgs)
    subAgentMap.delete(parentId)

    const kind = backgroundAgentParentIds.has(parentId) ? "background_agent" as const : "sub_agent" as const
    const existingBlock = agentBlockMap.get(parentId)
    if (existingBlock) {
      existingBlock.messages.push(...agentMsgs)
    } else {
      const block = { kind, messages: [...agentMsgs] }
      current.contentBlocks.push(block)
      agentBlockMap.set(parentId, block)
    }
  }

  function finalizeTurn() {
    if (!current) return
    // Flush any remaining sub-agent messages (including orphans with no matching tool call)
    for (const tc of current.toolCalls) {
      flushSubAgentMessages(tc.id)
    }
    // Also flush orphaned sub-agent messages (parentToolUseID didn't match any tool call)
    for (const [parentId] of subAgentMap) {
      flushSubAgentMessages(parentId)
    }

    // Cross-link PostToolUse hook events onto their matching ToolCall.
    // Done at finalization time so all hook events are collected before we scan.
    for (const block of current.contentBlocks) {
      if (block.kind !== "hook_event") continue
      for (const ev of block.events) {
        // Only PostToolUse events (both older "PostToolUse:ToolName" and newer exact match)
        const isPostToolUse =
          ev.eventName === "PostToolUse" ||
          ev.eventName.startsWith("PostToolUse:")
        if (!isPostToolUse || !ev.toolUseId) continue

        const toolCall = current.toolCalls.find((tc) => tc.id === ev.toolUseId)
        if (!toolCall) continue

        if (ev.updatedToolOutput) {
          toolCall.outputReplacedByHook = true
        }
        if (ev.durationMs !== undefined) {
          toolCall.hookDurationMs = (toolCall.hookDurationMs ?? 0) + ev.durationMs
        }
      }
    }

    // Group EnterPlanMode → ExitPlanMode sequences into plan_mode blocks
    current.contentBlocks = groupPlanModeBlocks(current.contentBlocks)
    turns.push(current)
    if (pendingTurnStart !== null) turnStartIndices.push(pendingTurnStart)
    pendingTurnStart = null
    current = null
    agentBlockMap.clear()
  }

  for (recordIndex = 0; recordIndex < messages.length; recordIndex++) {
    const msg = messages[recordIndex]
    // Legacy summary record — carries a one-line title, no body
    if (isSummaryMessage(msg)) {
      finalizeTurn()
      pendingCompaction = { summary: msg.summary }
      continue
    }

    // compact_boundary system message (Claude Code v2.1.34+) — real compaction
    // signal. Its `content` is a fixed placeholder; the summary arrives with
    // the isCompactSummary user message that follows.
    if (isCompactBoundary(msg)) {
      finalizeTurn()
      pendingCompaction = { meta: normalizeCompactionMeta(msg.compactMetadata) }
      continue
    }

    // The replayed compaction summary is not a user prompt: it opens a turn
    // that carries the summary instead of rendering the boilerplate as if the
    // user had typed it.
    if (isCompactSummaryMessage(msg)) {
      finalizeTurn()
      pendingTurnStart = recordIndex
        current = createTurn(msg, null)
      current.compactionSummary = extractCompactionSummary(msg.message.content)
      current.compactionMeta = pendingCompaction?.meta
      pendingCompaction = null
      continue
    }

    // away_summary system message (Claude Code v2.1.108+) — produced by /recap
    // and automatically when returning to a long-running session.
    // Real shape: { type: "system", subtype: "away_summary", content: "..." }
    if (isSystemMessage(msg) && msg.subtype === "away_summary" && msg.content) {
      pendingRecap = { content: msg.content, timestamp: msg.timestamp }
      continue
    }

    // Claude Code records messages submitted during an active turn as
    // queue-operation/enqueue entries instead of normal user messages. Keep
    // those prompts inline at their chronological position so they remain
    // visible after the in-memory optimistic preview is gone or the page reloads.
    if (isQueueOperationMessage(msg)) {
      // Claude Code 2.1.217+ writes an enqueue/dequeue pair immediately before
      // an ordinary user record. With no active turn, the following user record
      // is the durable transcript entry, so creating a synthetic turn here would
      // duplicate the prompt. Enqueues during an active turn remain useful as
      // chronological steer/queued-prompt blocks.
      if (current && msg.operation === "enqueue" && isVisibleQueuedPrompt(msg.content)) {
        // This record carries no `origin`, so the envelope is the only signal.
        const parsed = parseAgentEnvelope(msg.content)
        pendingQueuedPrompts.push({
          turn: current,
          content: msg.content,
          timestamp: msg.timestamp,
          sender: parsed.sender,
          body: parsed.body,
        })
        noteEnqueueSourced(current, msg.content)
      }
      continue
    }

    // The durable copy of a prompt queued mid-turn. Held alongside enqueue
    // prompts so the shared flush can drop it if an ordinary user record for
    // the same text follows.
    if (isAttachmentMessage(msg)) {
      const queued = queuedCommandPrompt(msg)
      if (current && queued !== null && !consumeEnqueueSourced(current, queued.raw)) {
        pendingQueuedPrompts.push({
          turn: current,
          content: queued.raw,
          timestamp: msg.attachment?.timestamp ?? msg.timestamp,
          sender: queued.sender,
          body: queued.body,
        })
      }
      continue
    }

    if (pendingQueuedPrompts.length > 0) {
      const userContent = isUserMessage(msg) && !msg.isMeta
        ? msg.message.content
        : null
      if (typeof userContent === "string") {
        const duplicateIndex = pendingQueuedPrompts.findIndex(
          (prompt) => prompt.content === userContent
        )
        if (duplicateIndex >= 0) {
          const [dropped] = pendingQueuedPrompts.splice(duplicateIndex, 1)
          consumeEnqueueSourced(dropped.turn, dropped.content)
        }
      }
      flushPendingQueuedPrompts()
    }

    // User messages start a new turn (skip meta / tool-result-only messages)
    if (isUserMessage(msg) && !msg.isMeta) {
      // If user message is a tool result, attach to existing turn
      const content = msg.message.content
      if (typeof content !== "string" && Array.isArray(content)) {
        const hasToolResult = content.some((b) => b.type === "tool_result")
        if (hasToolResult && current) {
          // Match tool results to pending tool uses
          for (const block of content) {
            if (block.type === "tool_result") {
              const pending = pendingToolUses.get(block.tool_use_id)
              if (pending) {
                pending.turn.toolCalls[pending.index].result =
                  extractToolResultText(block.content)
                pending.turn.toolCalls[pending.index].isError = block.is_error === true
                pendingToolUses.delete(block.tool_use_id)
              }
            }
          }

          // New format (v2.1.63+): Agent/Task results include toolUseResult
          // with a summary instead of inline agent_progress messages.
          // Synthesize a SubAgentMessage from the summary so the panel renders.
          const toolUseResult = msg.toolUseResult as AgentToolUseResult | undefined
          if (toolUseResult?.agentId) {
            const toolUseId = content.find((b) => b.type === "tool_result")?.tool_use_id ?? ""
            const taskMeta = taskMetaMap.get(toolUseId)
            const isBackground = backgroundAgentParentIds.has(toolUseId)

            // Extract text from the result content
            const resultText: string[] = []
            if (Array.isArray(toolUseResult.content)) {
              for (const block of toolUseResult.content as ContentBlock[]) {
                if (block.type === "text") resultText.push(block.text)
              }
            }

            const agentMsg: SubAgentMessage = {
              agentId: toolUseResult.agentId,
              parentToolUseId: toolUseId || undefined,
              agentName: taskMeta?.name ?? null,
              subagentType: taskMeta?.subagentType ?? null,
              type: "assistant",
              content: toolUseResult.content,
              toolCalls: [],
              thinking: [],
              text: resultText,
              timestamp: msg.timestamp ?? "",
              tokenUsage: toolUseResult.usage ? {
                input_tokens: toolUseResult.usage.input_tokens ?? 0,
                output_tokens: toolUseResult.usage.output_tokens ?? 0,
                cache_creation_input_tokens: toolUseResult.usage.cache_creation_input_tokens ?? 0,
                cache_read_input_tokens: toolUseResult.usage.cache_read_input_tokens ?? 0,
              } : null,
              model: null,
              isBackground,
              prompt: toolUseResult.prompt,
              status: toolUseResult.status,
              durationMs: toolUseResult.totalDurationMs,
              toolUseCount: toolUseResult.totalToolUseCount,
            }

            // Only add if no agent_progress messages already populated this agent
            // (backward compat: old format has inline progress, new format has toolUseResult)
            const existingBlock = agentBlockMap.get(toolUseId)
            if (!existingBlock) {
              current.subAgentActivity.push(agentMsg)
              const kind = isBackground ? "background_agent" as const : "sub_agent" as const
              const block = { kind, messages: [agentMsg] }
              current.contentBlocks.push(block)
              agentBlockMap.set(toolUseId, block)
            }
          }

          continue
        }
      }

      // A background task reporting back is not a prompt: it resumes the turn
      // that launched the task, so the work it triggers stays filed under the
      // request that asked for it instead of opening a turn of its own.
      if (isTaskNotificationRecord(msg)) {
        const notification = {
          kind: "task_notification" as const,
          content: extractTextFromContent(content),
          timestamp: msg.timestamp,
        }
        if (current) {
          current.contentBlocks.push(notification)
          continue
        }
        // No turn to resume: a paged window opened past the launching prompt.
        // A null userMessage marks this as the tail half of a cut turn, so
        // `prependTurns` stitches it back once the older page arrives.
        pendingTurnStart = recordIndex
        current = createTurn(msg, null)
        current.contentBlocks.push(notification)
        attachPendingCompaction(current)
        continue
      }

      finalizeTurn()
      pendingTurnStart = recordIndex
        current = createTurn(msg, msg.message.content)
      attachPendingCompaction(current)
      if (pendingRecap) {
        current.contentBlocks.push({ kind: "recap", content: pendingRecap.content, timestamp: pendingRecap.timestamp })
        pendingRecap = null
      }
      continue
    }

    if (isAssistantMessage(msg)) {
      if (!current) {
        // Assistant message without a preceding user message; create a synthetic turn
        pendingTurnStart = recordIndex
        current = createTurn(msg, null)
        attachPendingCompaction(current)
      }

      current.model = msg.message.model
      // Effort can be changed mid-session, so the turn reflects what it ended on.
      if (msg.effort) current.effort = msg.effort
      current.attribution = mergeAttribution(current.attribution, msg)
      // Only merge usage once per unique message ID (deduplication)
      const msgId = msg.message.id
      if (!seenMessageIds.has(msgId)) {
        seenMessageIds.add(msgId)
        current.tokenUsage = mergeTokenUsage(current.tokenUsage, msg.message.usage)
      }
      const msgTs = msg.timestamp ?? ""

      // Collect thinking blocks from this message, then flush as one content block
      const msgThinking: ThinkingBlock[] = []
      // Collect consecutive tool_use blocks, then flush as one content block
      const msgToolCalls: ToolCall[] = []

      // current is guaranteed non-null here (assigned above or created as synthetic turn)
      const activeTurn = current

      function flushToolCalls() {
        if (msgToolCalls.length > 0) {
          activeTurn.contentBlocks.push({ kind: "tool_calls", toolCalls: [...msgToolCalls], timestamp: msgTs })
          msgToolCalls.length = 0
        }
      }

      function flushThinking() {
        if (msgThinking.length > 0) {
          // Merge with last thinking block if consecutive
          const last = activeTurn.contentBlocks[activeTurn.contentBlocks.length - 1]
          if (last && last.kind === "thinking") {
            last.blocks.push(...msgThinking)
          } else {
            activeTurn.contentBlocks.push({ kind: "thinking", blocks: [...msgThinking], timestamp: msgTs })
          }
          msgThinking.length = 0
        }
      }

      for (const block of msg.message.content) {
        if (block.type === "thinking") {
          flushToolCalls()
          const tb = block as ThinkingBlock
          // Skip thinking blocks with empty content (redacted extended thinking
          // where only the signature is persisted)
          if (!tb.thinking) continue
          current.thinking.push(tb)
          msgThinking.push(tb)
        } else if (block.type === "text") {
          flushToolCalls()
          flushThinking()
          // claude -p writes thinking as raw <thinking> tags in text blocks
          const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g
          let remaining = block.text
          let match: RegExpExecArray | null
          while ((match = thinkingRegex.exec(block.text)) !== null) {
            const thinkingText = match[1].trim()
            if (thinkingText) {
              const tb: ThinkingBlock = { type: "thinking", thinking: thinkingText, signature: "" }
              current.thinking.push(tb)
              current.contentBlocks.push({ kind: "thinking", blocks: [tb], timestamp: msgTs })
            }
            remaining = remaining.replace(match[0], "")
          }
          remaining = remaining.trim()
          if (remaining) {
            current.assistantText.push(remaining)
            // Merge with last text block if consecutive, otherwise create new
            const last = current.contentBlocks[current.contentBlocks.length - 1]
            if (last && last.kind === "text") {
              last.text.push(remaining)
            } else {
              current.contentBlocks.push({ kind: "text", text: [remaining], timestamp: msgTs })
            }
          }
        } else if (block.type === "tool_use") {
          flushThinking()
          const tc: ToolCall = {
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
            result: null,
            isError: false,
            timestamp: msg.timestamp ?? "",
          }
          const idx = current.toolCalls.length
          current.toolCalls.push(tc)
          msgToolCalls.push(tc)
          pendingToolUses.set(block.id, { turn: current, index: idx })

          // Track Task/Agent tool calls metadata for agent name/type display
          // "Task" is deprecated (pre-v2.1.63); kept for old sessions
          if (block.name === "Task" || block.name === "Agent") {
            const input = block.input as Record<string, unknown>
            if (input.run_in_background === true) {
              backgroundAgentParentIds.add(block.id)
            }
            taskMetaMap.set(block.id, {
              name: (input.name as string) ?? null,
              subagentType: (input.subagent_type as string) ?? null,
            })
          }
        }
      }
      // Flush any remaining batches
      flushThinking()
      flushToolCalls()
      continue
    }

    // @deprecated agent_progress handling — Claude Code v2.1.63+ uses toolUseResult instead.
    // Kept for old sessions and subagentWatcher live progress synthesis.
    if (isProgressMessage(msg) && msg.data.type === "agent_progress") {
      const data = msg.data
      const parentId = msg.parentToolUseID ?? ""

      // Extract token usage from sub-agent assistant messages (deduplicated by message ID)
      let subAgentUsage: TokenUsage | null = null
      if (data.message.type === "assistant") {
        const innerMsg = data.message.message as Record<string, unknown>
        const msgId = innerMsg.id as string | undefined
        const usage = innerMsg.usage as TokenUsage | undefined
        if (usage && msgId && !seenMessageIds.has(msgId)) {
          seenMessageIds.add(msgId)
          subAgentUsage = {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          }
        }
      }

      const innerModel = data.message.type === "assistant"
        ? ((data.message.message as Record<string, unknown>).model as string | undefined) ?? null
        : null

      const taskMeta = taskMetaMap.get(parentId)
      const agentMsg: SubAgentMessage = {
        agentId: data.agentId,
        parentToolUseId: parentId || undefined,
        agentName: taskMeta?.name ?? null,
        subagentType: taskMeta?.subagentType ?? null,
        type: data.message.type,
        content: data.message.message.content,
        toolCalls: [],
        thinking: [],
        text: [],
        timestamp: data.message.timestamp ?? msg.timestamp ?? "",
        tokenUsage: subAgentUsage,
        model: innerModel,
        isBackground: backgroundAgentParentIds.has(parentId),
      }

      // Extract details from assistant sub-agent messages
      if (data.message.type === "assistant") {
        const innerContent = data.message.message.content
        if (Array.isArray(innerContent)) {
          for (const block of innerContent as ContentBlock[]) {
            if (block.type === "thinking") {
              agentMsg.thinking.push(block.thinking)
            } else if (block.type === "text") {
              agentMsg.text.push(block.text)
            } else if (block.type === "tool_use") {
              agentMsg.toolCalls.push({
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
                result: null,
                isError: false,
                timestamp: data.message.timestamp ?? msg.timestamp ?? "",
              })
            }
          }
        }
      } else if (data.message.type === "user") {
        const innerContent = data.message.message.content
        if (Array.isArray(innerContent)) {
          for (const block of innerContent as ContentBlock[]) {
            if (block.type === "tool_result") {
              // Try to match to previous sub-agent tool call
              const existing = subAgentMap.get(parentId)
              if (existing) {
                for (const prev of existing) {
                  const match = prev.toolCalls.find(
                    (tc) => tc.id === block.tool_use_id
                  )
                  if (match) {
                    match.result = extractToolResultText(block.content)
                    match.isError = block.is_error === true
                  }
                }
              }
            }
          }
        }
      }

      let agentMsgs = subAgentMap.get(parentId)
      if (!agentMsgs) {
        agentMsgs = []
        subAgentMap.set(parentId, agentMsgs)
      }
      agentMsgs.push(agentMsg)

      // Flush immediately so sub-agent activity appears chronologically
      // in contentBlocks (near the tool call that spawned it)
      if (current) {
        flushSubAgentMessages(parentId)
      }
      continue
    }

    // hook_progress handling — parse hook lifecycle events into a hook_event content block
    if (isProgressMessage(msg) && msg.data.type === "hook_progress") {
      const data = msg.data as HookProgressData
      // Resolve event name: newer SDK uses hook_event_name, older SDK uses hookEvent
      const eventName = String(data.hook_event_name ?? data.hookEvent ?? "unknown")
      const hookSpecific = data.hookSpecificOutput as Record<string, unknown> | undefined

      const ev: ParsedHookEvent = {
        eventName,
        source: data.source !== undefined ? String(data.source) : undefined,
        toolName: data.tool_name !== undefined ? String(data.tool_name) : undefined,
        toolUseId: data.tool_use_id !== undefined ? String(data.tool_use_id) : undefined,
        command: data.command !== undefined ? String(data.command) : undefined,
        output: data.output !== undefined ? String(data.output) : undefined,
        stderr: data.stderr !== undefined ? String(data.stderr) : undefined,
        exitCode: data.exit_code !== undefined ? Number(data.exit_code) : undefined,
        decision: data.decision !== undefined ? String(data.decision) : undefined,
        durationMs: data.duration_ms !== undefined ? Number(data.duration_ms) : undefined,
        updatedToolOutput: hookSpecific?.updatedToolOutput !== undefined
          ? String(hookSpecific.updatedToolOutput)
          : undefined,
        sessionTitle: hookSpecific?.sessionTitle !== undefined
          ? String(hookSpecific.sessionTitle)
          : undefined,
        worktreePath: hookSpecific?.worktreePath !== undefined
          ? String(hookSpecific.worktreePath)
          : undefined,
        timestamp: msg.timestamp ?? "",
      }

      if (current) {
        // Group consecutive hook events into one block to avoid N separate blocks
        const last = current.contentBlocks[current.contentBlocks.length - 1]
        if (last && last.kind === "hook_event") {
          last.events.push(ev)
        } else {
          current.contentBlocks.push({ kind: "hook_event", events: [ev], timestamp: msg.timestamp })
        }
      }
      continue
    }

    if (isSystemMessage(msg) && msg.subtype === "turn_duration" && current) {
      // Claude Code times each stretch of work separately, so a turn a
      // background task resumed reports one duration per stretch. It worked for
      // their sum — the idle wait between them is not work.
      if (msg.durationMs !== undefined && msg.durationMs !== null) {
        current.durationMs = (current.durationMs ?? 0) + msg.durationMs
      }
      continue
    }
  }

  // Finalize the last turn
  flushPendingQueuedPrompts()
  finalizeTurn()

  // Pairing is a 1:1 map, so it cannot disturb the start indexes.
  return { turns: pairAgentMessageReplies(turns), turnStartIndices }
}

/** Turns only — the common case. */
export function buildTurns(messages: RawMessage[]): Turn[] {
  return buildTurnsWithStarts(messages).turns
}
