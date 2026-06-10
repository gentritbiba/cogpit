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
} from "./types"
import {
  isUserMessage,
  isAssistantMessage,
  isProgressMessage,
  isSystemMessage,
  isSummaryMessage,
  isCompactBoundary,
} from "./messageTypeGuards"

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

// ── Local mergeTokenUsage (duplicated to avoid circular deps) ────────────────

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
    speed: incoming.speed ?? existing.speed,
  }
}

// ── Compaction Summary ───────────────────────────────────────────────────────

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
                // Re-emit passthrough blocks (hook_event, text) that appeared mid-scan
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
            } else if (next.kind === "hook_event" || next.kind === "text") {
              // Skip hook_event and text blocks — don't break the scan.
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

export function buildTurns(messages: RawMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  // Track compaction summary to attach to the next turn
  let pendingCompaction: string | null = null

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

    // compact_boundary system message (Claude Code v2.1.34+) — real compaction signal
    if (isCompactBoundary(msg)) {
      finalizeTurn()
      pendingCompaction = buildCompactionSummary(
        turns,
        msg.content ?? "Conversation compacted"
      )
      continue
    }

    // away_summary system message (Claude Code v2.1.108+) — produced by /recap
    // and automatically when returning to a long-running session.
    // Real shape: { type: "system", subtype: "away_summary", content: "..." }
    if (isSystemMessage(msg) && msg.subtype === "away_summary" && msg.content) {
      pendingRecap = { content: msg.content, timestamp: msg.timestamp }
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
      if (pendingRecap) {
        current.contentBlocks.push({ kind: "recap", content: pendingRecap.content, timestamp: pendingRecap.timestamp })
        pendingRecap = null
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
      current.durationMs = msg.durationMs ?? null
      continue
    }
  }

  // Finalize the last turn
  finalizeTurn()

  return turns
}
