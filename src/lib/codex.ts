import { computeStats } from "./sessionStats"
import type {
  ParsedSession,
  SubAgentMessage,
  ThinkingBlock,
  TokenUsage,
  ToolCall,
  Turn,
} from "./types"

interface CodexRecord {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

interface CodexMetadata {
  sessionId: string
  version: string
  gitBranch: string
  cwd: string
  model: string
  slug: string
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
  firstUserMessage: string
  lastUserMessage: string
  timestamp: string
  lastTimestamp: string
  turnCount: number
}

const SKIP_PROMPT_PREFIXES = [
  "<environment_context>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<skills_instructions>",
]

function randomTurnId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function safeParseLine(line: string): CodexRecord | null {
  try {
    return JSON.parse(line) as CodexRecord
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCodexRecord(record: CodexRecord | null): record is CodexRecord {
  if (!record || typeof record.type !== "string") return false
  return record.type === "session_meta"
    || record.type === "turn_context"
    || record.type === "event_msg"
    || record.type === "response_item"
}

function extractMessageText(payload: Record<string, unknown> | undefined, blockType: "input_text" | "output_text"): string {
  const content = payload?.content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block): block is Record<string, unknown> => isObject(block) && block.type === blockType && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim()
}

function normalizePromptText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  if (SKIP_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return ""
  return trimmed
}

function mergeTokenUsage(existing: TokenUsage | null, incoming: TokenUsage): TokenUsage {
  if (!existing) return { ...incoming }
  return {
    input_tokens: existing.input_tokens + incoming.input_tokens,
    output_tokens: existing.output_tokens + incoming.output_tokens,
    cache_creation_input_tokens:
      (existing.cache_creation_input_tokens ?? 0) + (incoming.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (existing.cache_read_input_tokens ?? 0) + (incoming.cache_read_input_tokens ?? 0),
  }
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!isObject(value)) return null
  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0
  const cacheCreation = typeof value.cache_creation_input_tokens === "number" ? value.cache_creation_input_tokens : 0
  const cacheRead = typeof value.cache_read_input_tokens === "number" ? value.cache_read_input_tokens : 0
  if (inputTokens === 0 && outputTokens === 0 && cacheCreation === 0 && cacheRead === 0) return null
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  }
}

function appendAssistantText(turn: Turn, text: string, timestamp: string): void {
  if (!text) return
  turn.assistantText.push(text)
  const last = turn.contentBlocks[turn.contentBlocks.length - 1]
  if (last && last.kind === "text") {
    last.text.push(text)
    return
  }
  turn.contentBlocks.push({ kind: "text", text: [text], timestamp })
}

function appendThinking(turn: Turn, text: string, timestamp: string): void {
  if (!text) return
  const block: ThinkingBlock = { type: "thinking", thinking: text, signature: "" }
  turn.thinking.push(block)
  const last = turn.contentBlocks[turn.contentBlocks.length - 1]
  if (last && last.kind === "thinking") {
    last.blocks.push(block)
    return
  }
  turn.contentBlocks.push({ kind: "thinking", blocks: [block], timestamp })
}

function appendToolCall(turn: Turn, toolCall: ToolCall, timestamp: string): void {
  turn.toolCalls.push(toolCall)
  const last = turn.contentBlocks[turn.contentBlocks.length - 1]
  if (last && last.kind === "tool_calls" && last.timestamp === timestamp) {
    last.toolCalls.push(toolCall)
    return
  }
  turn.contentBlocks.push({ kind: "tool_calls", toolCalls: [toolCall], timestamp })
}

function finalizeTurn(turns: Turn[], current: Turn | null, lastTimestamp: string): Turn | null {
  if (!current) return null
  const hasContent = current.userMessage !== null
    || current.assistantText.length > 0
    || current.toolCalls.length > 0
    || current.thinking.length > 0
  if (!hasContent) return null

  if (current.timestamp && lastTimestamp) {
    const start = new Date(current.timestamp).getTime()
    const end = new Date(lastTimestamp).getTime()
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      current.durationMs = end - start
    }
  }

  turns.push(current)
  return null
}

function parseToolInput(argumentsText: unknown): Record<string, unknown> {
  if (typeof argumentsText !== "string" || !argumentsText.trim()) return {}
  try {
    const parsed = JSON.parse(argumentsText)
    return isObject(parsed) ? parsed : { value: parsed }
  } catch {
    return { raw: argumentsText }
  }
}

function inferToolError(output: string | null): boolean {
  if (!output) return false
  const exitMatch = output.match(/Process exited with code (\d+)/)
  if (exitMatch) return exitMatch[1] !== "0"
  return /\b(error|failed|exception)\b/i.test(output)
}

/** Parse a Codex apply_patch string into per-file Edit/Write tool calls. */
export function parseApplyPatch(
  patchText: string,
  callId: string,
  timestamp: string,
): ToolCall[] {
  const toolCalls: ToolCall[] = []
  // Split into per-file sections
  const filePattern = /\*\*\*\s+(Update File|Add File|Delete File):\s*(.+)/g
  const sections: Array<{ action: string; filePath: string; startIdx: number }> = []
  let match: RegExpExecArray | null
  while ((match = filePattern.exec(patchText)) !== null) {
    sections.push({
      action: match[1],
      filePath: match[2].trim(),
      startIdx: match.index + match[0].length,
    })
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    const endIdx = i + 1 < sections.length ? sections[i + 1].startIdx - sections[i + 1].filePath.length - 20 : patchText.length
    const body = patchText.slice(section.startIdx, endIdx)

    // Parse hunks between @@ markers
    const hunkBodies = body.split(/^@@.*$/m).filter((s) => s.trim())
    const oldLines: string[] = []
    const newLines: string[] = []

    for (const hunk of hunkBodies) {
      for (const line of hunk.split("\n")) {
        if (line.startsWith("-")) {
          oldLines.push(line.slice(1))
        } else if (line.startsWith("+")) {
          newLines.push(line.slice(1))
        } else if (line.startsWith(" ")) {
          oldLines.push(line.slice(1))
          newLines.push(line.slice(1))
        }
      }
    }

    const fileId = sections.length > 1 ? `${callId}:file-${i}` : callId

    if (section.action === "Add File") {
      toolCalls.push({
        id: fileId,
        name: "Write",
        input: { file_path: section.filePath, content: newLines.join("\n") },
        result: null,
        isError: false,
        timestamp,
      })
    } else if (section.action === "Delete File") {
      toolCalls.push({
        id: fileId,
        name: "Edit",
        input: { file_path: section.filePath, old_string: oldLines.join("\n"), new_string: "" },
        result: null,
        isError: false,
        timestamp,
      })
    } else {
      // Update File → Edit
      toolCalls.push({
        id: fileId,
        name: "Edit",
        input: {
          file_path: section.filePath,
          old_string: oldLines.join("\n"),
          new_string: newLines.join("\n"),
        },
        result: null,
        isError: false,
        timestamp,
      })
    }
  }

  return toolCalls
}

/** Normalize Codex update_plan input to TodoWrite format. */
function normalizePlanToTodos(input: Record<string, unknown>): Record<string, unknown> {
  const plan = Array.isArray(input.plan) ? input.plan : []
  const todos = plan
    .filter((item): item is Record<string, unknown> => isObject(item))
    .map((item) => ({
      content: typeof item.step === "string" ? item.step : "",
      status: typeof item.status === "string" ? item.status : "pending",
      activeForm: typeof item.step === "string" ? item.step : "",
    }))
  return { todos }
}

/** Parse Codex custom_tool_call output JSON. */
function parseCustomToolOutput(output: string | null): { text: string; isError: boolean } {
  if (!output) return { text: "", isError: false }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    const text = typeof parsed.output === "string" ? parsed.output : output
    const meta = isObject(parsed.metadata) ? parsed.metadata : null
    const isError = meta ? (meta.exit_code !== 0 && meta.exit_code !== undefined) : inferToolError(text)
    return { text, isError }
  } catch {
    return { text: output, isError: inferToolError(output) }
  }
}

function createTurn(turnId: string | null, timestamp: string, model: string | null): Turn {
  return {
    id: turnId || randomTurnId("codex-turn"),
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp,
    durationMs: null,
    tokenUsage: null,
    model,
  }
}

function extractPromptFromRecord(record: CodexRecord): string {
  if (record.type === "event_msg" && isObject(record.payload) && record.payload.type === "user_message" && typeof record.payload.message === "string") {
    return normalizePromptText(record.payload.message)
  }
  if (record.type === "response_item" && isObject(record.payload) && record.payload.type === "message" && record.payload.role === "user") {
    return normalizePromptText(extractMessageText(record.payload, "input_text"))
  }
  return ""
}

function extractMetadataFromRecords(records: CodexRecord[]): CodexMetadata {
  let sessionId = ""
  let version = ""
  let gitBranch = ""
  let cwd = ""
  let model = ""
  let branchedFrom: { sessionId: string; turnIndex?: number | null } | undefined
  let firstUserMessage = ""
  let lastUserMessage = ""
  let timestamp = ""
  let lastTimestamp = ""
  let turnCount = 0

  let previousPrompt = ""

  for (const record of records) {
    if (!isObject(record.payload)) continue
    if (record.type === "session_meta") {
      sessionId ||= typeof record.payload.id === "string" ? record.payload.id : ""
      version ||= typeof record.payload.cli_version === "string" ? record.payload.cli_version : ""
      cwd ||= typeof record.payload.cwd === "string" ? record.payload.cwd : ""
      if (!branchedFrom && isObject(record.payload.branchedFrom)) {
        const sourceId = typeof record.payload.branchedFrom.sessionId === "string"
          ? record.payload.branchedFrom.sessionId
          : ""
        if (sourceId) {
          branchedFrom = {
            sessionId: sourceId,
            turnIndex: typeof record.payload.branchedFrom.turnIndex === "number"
              ? record.payload.branchedFrom.turnIndex
              : null,
          }
        }
      }
      const git = isObject(record.payload.git) ? record.payload.git : null
      gitBranch ||= git && typeof git.branch === "string" ? git.branch : ""
    }
    if (record.type === "turn_context") {
      model ||= typeof record.payload.model === "string" ? record.payload.model : ""
      cwd ||= typeof record.payload.cwd === "string" ? record.payload.cwd : ""
    }

    const prompt = extractPromptFromRecord(record)
    if (!prompt) continue
    if (prompt === previousPrompt) continue

    if (!firstUserMessage) firstUserMessage = prompt
    lastUserMessage = prompt
    previousPrompt = prompt
    turnCount++
    if (!timestamp) timestamp = record.timestamp ?? ""
    lastTimestamp = record.timestamp ?? lastTimestamp
  }

  if (lastTimestamp === "") lastTimestamp = timestamp

  return {
    sessionId,
    version,
    gitBranch,
    cwd,
    model,
    slug: "",
    branchedFrom,
    firstUserMessage,
    lastUserMessage,
    timestamp,
    lastTimestamp,
    turnCount,
  }
}

export function isCodexSessionText(jsonlText: string): boolean {
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    return isCodexRecord(safeParseLine(trimmed))
  }
  return false
}

export function extractCodexMetadataFromLines(lines: string[]) {
  const records = lines.map(safeParseLine).filter(isCodexRecord)
  return extractMetadataFromRecords(records)
}

export function parseCodexSession(jsonlText: string): ParsedSession {
  const records = jsonlText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeParseLine)
    .filter(isCodexRecord)

  const metadata = extractMetadataFromRecords(records)
  const turns: Turn[] = []
  const pendingToolCalls = new Map<string, ToolCall>()
  // apply_patch parent callId → per-file synthetic tool call IDs
  const patchCallIds = new Map<string, string[]>()
  // spawn_agent call tracking
  const spawnAgentCalls = new Map<string, {
    callId: string
    message: string
    model: string | null
    agentType: string | null
    timestamp: string
  }>()
  // agentId → resolved agent info (from spawn_agent results)
  const agentRegistry = new Map<string, {
    agentId: string
    nickname: string | null
    message: string
    model: string | null
    agentType: string | null
    timestamp: string
    parentToolCallId: string
  }>()

  let current: Turn | null = null
  let currentTurnId: string | null = null
  let currentModel: string | null = metadata.model || null
  let lastTurnTimestamp = ""

  for (const record of records) {
    const payload = isObject(record.payload) ? record.payload : undefined
    const timestamp = record.timestamp ?? ""

    if (record.type === "turn_context") {
      current = finalizeTurn(turns, current, lastTurnTimestamp)
      currentTurnId = typeof payload?.turn_id === "string" ? payload.turn_id : null
      currentModel = typeof payload?.model === "string" ? payload.model : currentModel
      lastTurnTimestamp = timestamp
      continue
    }

    if (record.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string") {
      if (current && (current.assistantText.length > 0 || current.toolCalls.length > 0 || current.thinking.length > 0)) {
        current = finalizeTurn(turns, current, lastTurnTimestamp)
      }
      current ??= createTurn(currentTurnId, timestamp, currentModel)
      current.userMessage = payload.message
      current.timestamp = current.timestamp || timestamp
      lastTurnTimestamp = timestamp
      continue
    }

    current ??= createTurn(currentTurnId, timestamp, currentModel)
    if (!current.model && currentModel) current.model = currentModel
    if (!current.timestamp) current.timestamp = timestamp
    if (timestamp) lastTurnTimestamp = timestamp

    if (record.type === "event_msg" && payload?.type === "token_count") {
      const info = isObject(payload.info) ? payload.info : null
      const lastUsage = info ? parseTokenUsage(info.last_token_usage) : null
      if (lastUsage) {
        current.tokenUsage = mergeTokenUsage(current.tokenUsage, lastUsage)
      }
      continue
    }

    if (record.type !== "response_item" || !payload) continue

    if (payload.type === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? payload.summary.filter((item): item is string => typeof item === "string").join("\n")
        : ""
      appendThinking(current, summary.trim(), timestamp)
      continue
    }

    if (payload.type === "message" && payload.role === "assistant") {
      appendAssistantText(current, extractMessageText(payload, "output_text"), timestamp)
      continue
    }

    if (payload.type === "message" && payload.role === "user" && current.userMessage === null) {
      const text = normalizePromptText(extractMessageText(payload, "input_text"))
      if (text) current.userMessage = text
      continue
    }

    if (payload.type === "function_call" && typeof payload.call_id === "string") {
      const rawName = typeof payload.name === "string" ? payload.name : "tool"
      const parsedInput = parseToolInput(payload.arguments)

      // Normalize Codex tool names + inputs to Claude Code equivalents
      let name = rawName
      let input = parsedInput
      if (rawName === "exec_command") {
        name = "Bash"
      } else if (rawName === "update_plan") {
        name = "TodoWrite"
        input = normalizePlanToTodos(parsedInput)
      }

      // Detect spawn_agent → synthesize sub-agent activity
      if (rawName === "spawn_agent") {
        spawnAgentCalls.set(payload.call_id as string, {
          callId: payload.call_id as string,
          message: typeof parsedInput.message === "string" ? parsedInput.message : "",
          model: typeof parsedInput.model === "string" ? parsedInput.model : null,
          agentType: typeof parsedInput.agent_type === "string" ? parsedInput.agent_type : null,
          timestamp,
        })
      }

      const toolCall: ToolCall = {
        id: payload.call_id,
        name,
        input,
        result: null,
        isError: false,
        timestamp,
      }
      pendingToolCalls.set(toolCall.id, toolCall)
      appendToolCall(current, toolCall, timestamp)
      continue
    }

    if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
      const toolCall = pendingToolCalls.get(payload.call_id)
      if (!toolCall) continue
      const output = typeof payload.output === "string" ? payload.output : null
      toolCall.result = output
      toolCall.isError = inferToolError(output)
      pendingToolCalls.delete(payload.call_id)

      // Resolve spawn_agent result → create sub-agent entry
      if (toolCall.name === "spawn_agent" && output) {
        try {
          const result = JSON.parse(output) as Record<string, unknown>
          const agentId = typeof result.agent_id === "string" ? result.agent_id : ""
          const nickname = typeof result.nickname === "string" ? result.nickname : null
          if (agentId) {
            const spawnInfo = spawnAgentCalls.get(toolCall.id)
            agentRegistry.set(agentId, {
              agentId,
              nickname,
              message: spawnInfo?.message ?? "",
              model: spawnInfo?.model ?? null,
              agentType: spawnInfo?.agentType ?? null,
              timestamp: spawnInfo?.timestamp ?? timestamp,
              parentToolCallId: toolCall.id,
            })
          }
        } catch { /* skip */ }
      }

      // Resolve wait_agent result → attach sub-agent messages to turn
      if (toolCall.name === "wait_agent" && output && current) {
        try {
          const result = JSON.parse(output) as Record<string, unknown>
          const statusMap = isObject(result.status) ? result.status : {}
          for (const [agentId, status] of Object.entries(statusMap)) {
            const info = agentRegistry.get(agentId)
            const completedText = isObject(status) && typeof (status as Record<string, unknown>).completed === "string"
              ? (status as Record<string, unknown>).completed as string
              : null
            const agentMsg: SubAgentMessage = {
              agentId,
              agentName: info?.nickname ?? null,
              subagentType: info?.agentType ?? null,
              type: "assistant",
              content: completedText,
              toolCalls: [],
              thinking: [],
              text: completedText ? [completedText] : [],
              timestamp: info?.timestamp ?? timestamp,
              tokenUsage: null,
              model: info?.model ?? null,
              isBackground: false,
              prompt: info?.message ?? undefined,
              status: completedText ? "completed" : "running",
            }
            current.subAgentActivity.push(agentMsg)
          }
        } catch { /* skip */ }
      }

      continue
    }

    // Handle custom_tool_call (apply_patch, exec_command)
    if (payload.type === "custom_tool_call" && typeof payload.call_id === "string") {
      const name = typeof payload.name === "string" ? payload.name : "tool"
      const rawInput = typeof payload.input === "string" ? payload.input : ""

      if (name === "apply_patch" && rawInput) {
        // Split into per-file Edit/Write tool calls
        const perFileCalls = parseApplyPatch(rawInput, payload.call_id as string, timestamp)
        for (const tc of perFileCalls) {
          pendingToolCalls.set(tc.id, tc)
          appendToolCall(current, tc, timestamp)
        }
        // Track the parent call_id to apply results later
        patchCallIds.set(payload.call_id as string, perFileCalls.map((tc) => tc.id))
      } else {
        // exec_command or other custom tools
        const toolCall: ToolCall = {
          id: payload.call_id,
          name: name === "exec_command" ? "Bash" : name,
          input: parseToolInput(rawInput),
          result: null,
          isError: false,
          timestamp,
        }
        pendingToolCalls.set(toolCall.id, toolCall)
        appendToolCall(current, toolCall, timestamp)
      }
      continue
    }

    if (payload.type === "custom_tool_call_output" && typeof payload.call_id === "string") {
      const callId = payload.call_id as string
      const output = typeof payload.output === "string" ? payload.output : null
      const { text, isError } = parseCustomToolOutput(output)

      // Check if this is an apply_patch result (maps to multiple per-file calls)
      const fileCallIds = patchCallIds.get(callId)
      if (fileCallIds) {
        for (const id of fileCallIds) {
          const tc = pendingToolCalls.get(id)
          if (tc) {
            tc.result = text
            tc.isError = isError
            pendingToolCalls.delete(id)
          }
        }
        patchCallIds.delete(callId)
      } else {
        const toolCall = pendingToolCalls.get(callId)
        if (toolCall) {
          toolCall.result = text
          toolCall.isError = isError
          pendingToolCalls.delete(callId)
        }
      }
      continue
    }
  }

  finalizeTurn(turns, current, lastTurnTimestamp)

  return {
    sessionId: metadata.sessionId,
    version: metadata.version,
    gitBranch: metadata.gitBranch,
    cwd: metadata.cwd,
    slug: metadata.slug,
    model: metadata.model,
    turns,
    stats: computeStats(turns),
    rawMessages: records as Array<{ type: string; [key: string]: unknown }>,
    branchedFrom: metadata.branchedFrom,
    agentKind: "codex" as const,
  }
}
