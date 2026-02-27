import type {
  RawMessage,
  ParsedSession,
  Turn,
  ToolCall,
  SubAgentMessage,
  SessionStats,
  TokenUsage,
  ThinkingBlock,
  ContentBlock,
  ImageBlock,
  UserMessage,
  AssistantMessage,
  ProgressMessage,
  SystemMessage,
  SummaryMessage,
  UserContent,
} from "./types"
import {
  calculateTurnCostEstimated,
  calculateSubAgentCostEstimated,
  estimateTotalOutputTokens,
  estimateSubAgentOutput,
} from "./token-costs"

// ── Helpers ─────────────────────────────────────────────────────────────────

function isUserMessage(msg: RawMessage): msg is UserMessage {
  return msg.type === "user"
}

function isAssistantMessage(msg: RawMessage): msg is AssistantMessage {
  return msg.type === "assistant"
}

function isProgressMessage(msg: RawMessage): msg is ProgressMessage {
  return msg.type === "progress"
}

function isSystemMessage(msg: RawMessage): msg is SystemMessage {
  return msg.type === "system"
}

function isSummaryMessage(msg: RawMessage): msg is SummaryMessage {
  return msg.type === "summary"
}

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

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseLines(jsonlText: string): RawMessage[] {
  const messages: RawMessage[] = []
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as RawMessage)
    } catch {
      // skip malformed lines
    }
  }
  return messages
}

function extractSessionMetadata(messages: RawMessage[]) {
  const meta = { sessionId: "", version: "", gitBranch: "", cwd: "", slug: "", model: "", branchedFrom: undefined as { sessionId: string; turnIndex?: number | null } | undefined }

  for (const msg of messages) {
    if (msg.sessionId && !meta.sessionId) meta.sessionId = msg.sessionId
    if (msg.version && !meta.version) meta.version = msg.version
    if (msg.gitBranch && !meta.gitBranch) meta.gitBranch = msg.gitBranch
    if (msg.cwd && !meta.cwd) meta.cwd = msg.cwd
    if (msg.slug && !meta.slug) meta.slug = msg.slug
    if ((msg as Record<string, unknown>).branchedFrom && !meta.branchedFrom) {
      meta.branchedFrom = (msg as Record<string, unknown>).branchedFrom as typeof meta.branchedFrom
    }
    if (isAssistantMessage(msg) && msg.message.model && !meta.model) {
      meta.model = msg.message.model
    }
    if (meta.sessionId && meta.version && meta.gitBranch && meta.cwd && meta.model) break
  }

  return meta
}

function buildCompactionSummary(turns: Turn[], title: string): string {
  if (turns.length === 0) return title

  const toolCounts: Record<string, number> = {}
  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1
    }
  }

  // Extract user prompts (first line only)
  const prompts: string[] = []
  for (const turn of turns) {
    if (!turn.userMessage) continue
    const text = extractTextFromContent(
      typeof turn.userMessage === "string" ? turn.userMessage : turn.userMessage as ContentBlock[]
    )
    const firstLine = text.split("\n")[0].trim()
    if (firstLine.length > 0) {
      prompts.push(firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine)
    }
  }

  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} x${count}`)
    .join(", ")

  const parts = [`**${title}**`, `${turns.length} turns compacted`]
  if (topTools) parts.push(`Tools: ${topTools}`)
  if (prompts.length > 0) {
    parts.push("Prompts:")
    const shown = prompts.slice(0, 6)
    for (const p of shown) parts.push(`- ${p}`)
    if (prompts.length > 6) parts.push(`- ...and ${prompts.length - 6} more`)
  }

  return parts.join("\n")
}

function buildTurns(messages: RawMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  // Track compaction summary to attach to the next turn
  let pendingCompaction: string | null = null

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
    turns.push(current)
    current = null
    agentBlockMap.clear()
  }

  for (const msg of messages) {
    // Capture compaction/summary markers — build a rich summary from preceding turns
    if (isSummaryMessage(msg)) {
      finalizeTurn()
      pendingCompaction = buildCompactionSummary(
        turns,
        msg.summary ?? "Conversation compacted"
      )
      continue
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
                pending.turn.toolCalls[pending.index].isError = block.is_error
                pendingToolUses.delete(block.tool_use_id)
              }
            }
          }
          continue
        }
      }

      finalizeTurn()
      current = {
        id: msg.uuid ?? crypto.randomUUID(),
        userMessage: msg.message.content,
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
      if (pendingCompaction) {
        current.compactionSummary = pendingCompaction
        pendingCompaction = null
      }
      continue
    }

    if (isAssistantMessage(msg)) {
      if (!current) {
        // Assistant message without a preceding user message; create a synthetic turn
        current = {
          id: msg.uuid ?? crypto.randomUUID(),
          userMessage: null,
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

      current.model = msg.message.model
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

          // Track Task tool calls metadata for agent name/type display
          if (block.name === "Task") {
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
                    match.isError = block.is_error
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

    if (isSystemMessage(msg) && msg.subtype === "turn_duration" && current) {
      current.durationMs = msg.durationMs ?? null
      continue
    }
  }

  // Finalize the last turn
  finalizeTurn()

  return turns
}

function mergeTokenUsage(
  existing: TokenUsage | null,
  incoming: TokenUsage
): TokenUsage {
  if (!existing) {
    return { ...incoming }
  }
  return {
    input_tokens: existing.input_tokens + incoming.input_tokens,
    output_tokens: existing.output_tokens + incoming.output_tokens,
    cache_creation_input_tokens:
      (existing.cache_creation_input_tokens ?? 0) +
      (incoming.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (existing.cache_read_input_tokens ?? 0) +
      (incoming.cache_read_input_tokens ?? 0),
  }
}

function countToolCalls(
  toolCalls: readonly { name: string; isError: boolean }[],
  counts: Record<string, number>,
): number {
  let errors = 0
  for (const tc of toolCalls) {
    counts[tc.name] = (counts[tc.name] ?? 0) + 1
    if (tc.isError) errors++
  }
  return errors
}

function addUsageToStats(
  stats: SessionStats,
  usage: { input_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  estimatedOutput: number,
  cost: number,
): void {
  stats.totalInputTokens += usage.input_tokens
  stats.totalOutputTokens += estimatedOutput
  stats.totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0
  stats.totalCacheReadTokens += usage.cache_read_input_tokens ?? 0
  stats.totalCostUSD += cost
}

function computeStats(turns: Turn[]): SessionStats {
  const stats: SessionStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUSD: 0,
    toolCallCounts: {},
    errorCount: 0,
    totalDurationMs: 0,
    turnCount: turns.length,
  }

  for (const turn of turns) {
    if (turn.tokenUsage) {
      addUsageToStats(stats, turn.tokenUsage, estimateTotalOutputTokens(turn), calculateTurnCostEstimated(turn))
    }
    if (turn.durationMs) stats.totalDurationMs += turn.durationMs
    stats.errorCount += countToolCalls(turn.toolCalls, stats.toolCallCounts)

    for (const sa of turn.subAgentActivity) {
      stats.errorCount += countToolCalls(sa.toolCalls, stats.toolCallCounts)
      if (sa.tokenUsage) {
        addUsageToStats(stats, sa.tokenUsage, estimateSubAgentOutput(sa), calculateSubAgentCostEstimated(sa))
      }
    }
  }

  return stats
}

// ── Public API ──────────────────────────────────────────────────────────────

export function parseSession(jsonlText: string): ParsedSession {
  const rawMessages = parseLines(jsonlText)
  const metadata = extractSessionMetadata(rawMessages)
  const turns = buildTurns(rawMessages)
  const stats = computeStats(turns)

  return {
    ...metadata,
    turns,
    stats,
    rawMessages,
  }
}

/**
 * Incrementally append new JSONL lines to an existing parsed session.
 * Avoids re-parsing all turns from scratch — only re-processes the last
 * (potentially incomplete) turn and any new messages.
 */
export function parseSessionAppend(
  existing: ParsedSession,
  newJsonlText: string
): ParsedSession {
  const newMessages = parseLines(newJsonlText)
  if (newMessages.length === 0) return existing

  const allRawMessages = [...existing.rawMessages, ...newMessages]

  // Find the raw message index where the last existing turn started.
  // We pop the last turn and re-build from that point forward.
  // This way, even for a 500-turn session, we only re-process ~1 turn's worth of messages.
  let lastTurnStartIdx = existing.rawMessages.length // default: start of new messages
  let turnsToKeep = existing.turns.length > 0 ? existing.turns.length - 1 : 0
  if (existing.turns.length > 0) {
    // Walk backwards through existing raw messages to find the last non-meta
    // user message (which starts a turn)
    let userMsgCount = 0
    for (let i = existing.rawMessages.length - 1; i >= 0; i--) {
      const msg = existing.rawMessages[i]
      if (msg.type === "user" && !msg.isMeta) {
        const content = msg.message?.content
        // Skip tool-result user messages
        if (Array.isArray(content) && content.some((b: { type: string }) => b.type === "tool_result")) {
          continue
        }
        userMsgCount++
        if (userMsgCount === 1) {
          lastTurnStartIdx = i
          break
        }
      }
    }

    // Check if new messages include progress events whose parentToolUseID
    // belongs to an earlier turn (not the last one being rebuilt).  Claude
    // Code can flush sub-agent progress events AFTER the parent turn's
    // tool_result and even after the next turn has started.  When that
    // happens we need to rebuild from the turn that owns the tool call so
    // the sub-agent content block lands in the correct turn.
    const progressParentIds = new Set<string>()
    for (const msg of newMessages) {
      if (msg.type === "progress") {
        const parentId = (msg as ProgressMessage).parentToolUseID
        if (parentId) progressParentIds.add(parentId)
      }
    }

    if (progressParentIds.size > 0) {
      // Walk earlier turns to see if any own the referenced tool calls
      for (let t = existing.turns.length - 2; t >= 0; t--) {
        const turn = existing.turns[t]
        const ownsProgressParent = turn.toolCalls.some((tc) => progressParentIds.has(tc.id))
        if (ownsProgressParent) {
          // Need to rebuild from this earlier turn.  Find its start in rawMessages.
          turnsToKeep = t
          let found = 0
          for (let i = 0; i < existing.rawMessages.length; i++) {
            const msg = existing.rawMessages[i]
            if (msg.type === "user" && !msg.isMeta) {
              const content = msg.message?.content
              if (Array.isArray(content) && content.some((b: { type: string }) => b.type === "tool_result")) {
                continue
              }
              if (found === t) {
                lastTurnStartIdx = i
                break
              }
              found++
            }
          }
          break
        }
      }
    }
  }

  // Keep all turns before the rebuild point
  const keptTurns = existing.turns.slice(0, turnsToKeep)

  // Re-build turns from the last turn's start through all new messages
  const tailMessages = allRawMessages.slice(lastTurnStartIdx)
  const tailTurns = buildTurns(tailMessages)

  const allTurns = [...keptTurns, ...tailTurns]
  const stats = computeStats(allTurns)

  // Preserve metadata from existing (already extracted)
  return {
    sessionId: existing.sessionId,
    version: existing.version,
    gitBranch: existing.gitBranch,
    cwd: existing.cwd,
    slug: existing.slug,
    model: existing.model || (allTurns.length > 0 ? allTurns[allTurns.length - 1].model || "" : ""),
    turns: allTurns,
    stats,
    rawMessages: allRawMessages,
    branchedFrom: existing.branchedFrom,
  }
}

export function getUserMessageText(content: UserContent | null): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return extractTextFromContent(content)
}

export function getUserMessageImages(content: UserContent | null): ImageBlock[] {
  if (content === null || typeof content === "string") return []
  return content.filter((b): b is ImageBlock => b.type === "image")
}

// ── Tool Colors ─────────────────────────────────────────────────────────────

const TOOL_COLORS: Record<string, string> = {
  Read: "text-blue-400",
  Write: "text-green-400",
  Edit: "text-amber-400",
  Bash: "text-red-400",
  Grep: "text-purple-400",
  Glob: "text-cyan-400",
  Task: "text-indigo-400",
  WebFetch: "text-orange-400",
  WebSearch: "text-orange-400",
  NotebookEdit: "text-green-400",
  EnterPlanMode: "text-purple-400",
  ExitPlanMode: "text-purple-400",
  AskUserQuestion: "text-pink-400",
}

export function getToolColor(toolName: string): string {
  return TOOL_COLORS[toolName] ?? "text-slate-400"
}

// ── Plan Mode & Interactive Prompt Detection ─────────────────────────────────

export interface PlanApprovalState {
  type: "plan"
  allowedPrompts?: Array<{ tool: string; prompt: string }>
}

export interface UserQuestionState {
  type: "question"
  questions: Array<{
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

export type PendingInteraction = PlanApprovalState | UserQuestionState | null

/**
 * Check if the previous turn's last tool call is the same interactive tool
 * with a pending/error result -- indicates a stuck loop we should suppress.
 */
function isStuckInteractiveLoop(turns: Turn[], toolName: string): boolean {
  if (turns.length < 2) return false
  const prevTurn = turns[turns.length - 2]
  const prevLastTC = prevTurn.toolCalls[prevTurn.toolCalls.length - 1]
  return prevLastTC?.name === toolName && (prevLastTC.result === null || prevLastTC.isError)
}

/**
 * Detect if the session is waiting for user interaction (plan approval or
 * AskUserQuestion). Returns the interaction state or null.
 */
export function detectPendingInteraction(session: ParsedSession): PendingInteraction {
  const { turns } = session
  if (turns.length === 0) return null

  const lastTurn = turns[turns.length - 1]
  if (!lastTurn || lastTurn.toolCalls.length === 0) return null

  const lastToolCall = lastTurn.toolCalls[lastTurn.toolCalls.length - 1]
  if (!lastToolCall) return null

  const { name } = lastToolCall
  if (name !== "ExitPlanMode" && name !== "AskUserQuestion") return null

  // A successful (non-error) result means the user already responded
  if (lastToolCall.result !== null && !lastToolCall.isError) return null

  // Suppress if the agent is stuck re-calling the same interactive tool
  if (isStuckInteractiveLoop(turns, name)) return null

  const input = lastToolCall.input as Record<string, unknown>

  if (name === "ExitPlanMode") {
    return {
      type: "plan",
      allowedPrompts: input.allowedPrompts as PlanApprovalState["allowedPrompts"],
    }
  }

  // AskUserQuestion
  const questions = input.questions as UserQuestionState["questions"] | undefined
  if (questions && questions.length > 0) {
    return { type: "question", questions }
  }

  return null
}
