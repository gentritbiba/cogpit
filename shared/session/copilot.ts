// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
import { normalizeFunctionName } from "./codex-tool-normalization"
import { computeStats, createEmptySessionStats } from "./sessionStats"
import { appendAssistantText } from "./turnContent"
import type {
  ContentBlock,
  ImageBlock,
  ParseSessionOptions,
  ParsedSession,
  RawRecord,
  SessionStatusInfo,
  SubAgentMessage,
  ThinkingBlock,
  TokenUsage,
  ToolCall,
  Turn,
  UserContent,
} from "./types"

interface CopilotEvent {
  type: string
  data: Record<string, unknown>
  id?: string
  timestamp?: string
  agentId?: unknown
  [key: string]: unknown
}

interface CopilotMetadata {
  sessionId: string
  version: string
  gitBranch: string
  cwd: string
  model: string
  slug: string
  name: string
  firstUserMessage: string
  lastUserMessage: string
  timestamp: string
  lastTimestamp: string
  turnCount: number
  isSubagent: false
  parentSessionId: null
}

const COPILOT_EVENT_PREFIX = /^(?:assistant|auto_mode|auto_mode_switch|background_tasks|canvas|command|custom|elicitation|exit_plan_mode|extensions|external_tool|factory|hook|managed_settings|mcp|model|pending_messages|permission|sampling|session|skill|subagent|system|tool|ui|user_input)\./

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRootEvent(event: CopilotEvent): boolean {
  return typeof event.agentId !== "string" || event.agentId.length === 0
}

function isCopilotEvent(value: unknown): value is CopilotEvent {
  if (!isObject(value) || typeof value.type !== "string" || !isObject(value.data)) return false
  return value.type === "abort"
    || value.type === "binary_asset"
    || value.type === "user.message"
    || COPILOT_EVENT_PREFIX.test(value.type)
}

function safeParseLine(line: string): CopilotEvent | null {
  try {
    const value: unknown = JSON.parse(line)
    return isCopilotEvent(value) ? value : null
  } catch {
    return null
  }
}

function parseEvents(jsonlText: string): CopilotEvent[] {
  return jsonlText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeParseLine)
    .filter((event): event is CopilotEvent => event !== null)
}

function readString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string") ?? ""
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function eventTimestamp(event: CopilotEvent): string {
  return typeof event.timestamp === "string" ? event.timestamp : ""
}

function eventId(event: CopilotEvent, prefix: string): string {
  if (typeof event.id === "string" && event.id) return event.id
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function turnEventId(event: CopilotEvent): string {
  const durableEventId = eventId(event, "copilot-turn")
  const sourceTurnId = readString(event.data.turnId)
  return sourceTurnId ? `${sourceTurnId}@${durableEventId}` : durableEventId
}

function applyContext(
  context: unknown,
  current: { cwd: string; gitBranch: string },
): void {
  if (!isObject(context)) return
  const cwd = readString(context.cwd)
  const branch = readString(context.branch)
  if (cwd) current.cwd = cwd
  if (branch) current.gitBranch = branch
}

function extractMetadata(events: CopilotEvent[]): CopilotMetadata {
  const metadata: CopilotMetadata = {
    sessionId: "",
    version: "",
    gitBranch: "",
    cwd: "",
    model: "",
    slug: "",
    name: "",
    firstUserMessage: "",
    lastUserMessage: "",
    timestamp: "",
    lastTimestamp: "",
    turnCount: 0,
    isSubagent: false,
    parentSessionId: null,
  }

  for (const event of events) {
    if (!isRootEvent(event)) continue
    const { data } = event
    const timestamp = eventTimestamp(event)
    if (timestamp) metadata.lastTimestamp = timestamp

    if (event.type === "session.start") {
      metadata.sessionId ||= readString(data.sessionId)
      metadata.version ||= readString(data.copilotVersion)
        || (typeof data.version === "number" ? String(data.version) : readString(data.version))
      applyContext(data.context, metadata)
      metadata.model = readString(data.selectedModel) || metadata.model
      continue
    }

    if (event.type === "session.resume") {
      applyContext(data.context, metadata)
      metadata.model = readString(data.selectedModel) || metadata.model
      continue
    }

    if (event.type === "session.context_changed") {
      applyContext(data, metadata)
      continue
    }

    if (event.type === "session.auto_mode_resolved") {
      metadata.model = readString(data.chosenModel) || metadata.model
      continue
    }

    if (event.type === "session.model_change") {
      metadata.model = readString(data.newModel) || metadata.model
      continue
    }

    if (event.type === "session.title_changed") {
      metadata.name = readString(data.title) || metadata.name
      continue
    }

    if (event.type === "session.shutdown") {
      metadata.model = readString(data.currentModel) || metadata.model
      continue
    }

    if (
      event.type === "assistant.turn_start"
      || event.type === "assistant.turn_end"
      || event.type === "assistant.message"
      || event.type === "assistant.usage"
      || event.type === "tool.execution_start"
      || event.type === "tool.execution_complete"
    ) {
      metadata.model = readString(data.model) || metadata.model
    }

    if (event.type !== "user.message") continue
    metadata.turnCount++
    metadata.timestamp ||= timestamp
    const content = readString(data.content).trim()
    if (!content) continue
    metadata.firstUserMessage ||= content
    metadata.lastUserMessage = content
  }

  metadata.lastTimestamp ||= metadata.timestamp
  return metadata
}

export function isCopilotSessionText(jsonlText: string): boolean {
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (isCopilotEvent(value)) return true
    } catch {
      // A partial first line can occur in paged reads. Keep looking.
    }
  }
  return false
}

/** True when already-parsed raw records came from this CLI. */
export function isCopilotRawRecords(records: readonly { type?: unknown }[]): boolean {
  return isCopilotEventType(records[0]?.type)
}

export function extractCopilotMetadataFromLines(lines: string[]): CopilotMetadata {
  const events = lines.map((line) => safeParseLine(line.trim())).filter(
    (event): event is CopilotEvent => event !== null,
  )
  return extractMetadata(events)
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((part) => {
      const text = typeof part === "string"
        ? part
        : isObject(part) ? readString(part.text, part.content) : ""
      return text ? [text] : []
    })
    .join("\n")
}

interface CopilotBinaryAsset {
  data: string
  mimeType: string
}

function collectBinaryAssets(events: CopilotEvent[]): Map<string, CopilotBinaryAsset> {
  const assets = new Map<string, CopilotBinaryAsset>()
  for (const event of events) {
    if (event.type !== "session.binary_asset" && event.type !== "binary_asset") continue
    const assetId = readString(event.data.assetId)
    const data = readString(event.data.data)
    const mimeType = readString(event.data.mimeType)
    if (assetId && data && mimeType) assets.set(assetId, { data, mimeType })
  }
  return assets
}

function resolveImage(
  value: unknown,
  assets: Map<string, CopilotBinaryAsset>,
): ImageBlock | null {
  if (!isObject(value)) return null
  const asset = assets.get(readString(value.assetId))
  const mimeType = readString(value.mimeType, asset?.mimeType).toLowerCase()
  const data = readString(value.data, asset?.data)
  if (!mimeType.startsWith("image/") || !data) return null
  return {
    type: "image",
    source: { type: "base64", media_type: mimeType, data },
  }
}

function extractImages(
  values: unknown,
  assets: Map<string, CopilotBinaryAsset>,
): ImageBlock[] {
  if (!Array.isArray(values)) return []
  const images: ImageBlock[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const image = resolveImage(value, assets)
    if (!image) continue
    const key = `${image.source.media_type}:${image.source.data}`
    if (seen.has(key)) continue
    seen.add(key)
    images.push(image)
  }
  return images
}

function buildUserContent(
  data: Record<string, unknown>,
  assets: Map<string, CopilotBinaryAsset>,
): string | ContentBlock[] {
  const text = readString(data.content)
  const images = extractImages(data.attachments, assets)
  if (images.length === 0) return text
  return [...images, ...(text ? [{ type: "text" as const, text }] : [])]
}

function extractToolResultImages(
  data: Record<string, unknown>,
  assets: Map<string, CopilotBinaryAsset>,
): ImageBlock[] {
  if (!isObject(data.result)) return []
  return extractImages([
    ...(Array.isArray(data.result.contents) ? data.result.contents : []),
    ...(Array.isArray(data.result.binaryResultsForLlm)
      ? data.result.binaryResultsForLlm
      : []),
  ], assets)
}

function mergeTokenUsage(existing: TokenUsage | null, incoming: TokenUsage): TokenUsage {
  if (!existing) return { ...incoming }
  const existingThinking = existing.output_tokens_details?.thinking_tokens ?? 0
  const incomingThinking = incoming.output_tokens_details?.thinking_tokens ?? 0
  return {
    input_tokens: existing.input_tokens + incoming.input_tokens,
    output_tokens: existing.output_tokens + incoming.output_tokens,
    cache_creation_input_tokens:
      (existing.cache_creation_input_tokens ?? 0) + (incoming.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (existing.cache_read_input_tokens ?? 0) + (incoming.cache_read_input_tokens ?? 0),
    ...(existingThinking || incomingThinking
      ? { output_tokens_details: { thinking_tokens: existingThinking + incomingThinking } }
      : {}),
  }
}

function parseUsage(
  data: Record<string, unknown>,
  inputIncludesCache = false,
): TokenUsage | null {
  const cacheCreationInputTokens = readNumber(data.cacheWriteTokens)
  const cacheReadInputTokens = readNumber(data.cacheReadTokens)
  const inputTokens = readNumber(data.inputTokens)
  const usage: TokenUsage = {
    input_tokens: inputIncludesCache
      ? Math.max(0, inputTokens - cacheCreationInputTokens - cacheReadInputTokens)
      : inputTokens,
    output_tokens: readNumber(data.outputTokens),
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
  }
  const thinkingTokens = readNumber(data.reasoningTokens)
  if (thinkingTokens) usage.output_tokens_details = { thinking_tokens: thinkingTokens }
  if (
    usage.input_tokens === 0
    && usage.output_tokens === 0
    && usage.cache_creation_input_tokens === 0
    && usage.cache_read_input_tokens === 0
    && thinkingTokens === 0
  ) return null
  return usage
}

function parseModelMetrics(data: Record<string, unknown>): TokenUsage | null {
  if (!isObject(data.modelMetrics)) return null
  let total: TokenUsage | null = null
  for (const value of Object.values(data.modelMetrics)) {
    if (!isObject(value) || !isObject(value.usage)) continue
    const usage = parseUsage(value.usage, true)
    if (usage) total = mergeTokenUsage(total, usage)
  }
  return total
}

function normalizeChoice(value: unknown): { label: string; description?: string } | null {
  if (typeof value === "string") return { label: value }
  if (!isObject(value)) return null
  const label = readString(value.label, value.title, value.value, value.name)
  if (!label) return null
  const description = readString(value.description)
  return description ? { label, description } : { label }
}

function normalizeChoices(value: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(value)) return []
  return value.map(normalizeChoice).filter((choice): choice is NonNullable<typeof choice> => choice !== null)
}

function normalizeQuestion(value: unknown) {
  if (!isObject(value)) return null
  const question = readString(value.question, value.prompt, value.text, value.message)
  if (!question) return null
  const header = readString(value.header, value.title)
  const multiSelect = typeof value.multiSelect === "boolean"
    ? value.multiSelect
    : typeof value.multi_select === "boolean" ? value.multi_select : undefined
  return {
    question,
    ...(header ? { header } : {}),
    options: normalizeChoices(value.options ?? value.choices),
    ...(multiSelect === undefined ? {} : { multiSelect }),
  }
}

function normalizeAskUserInput(input: Record<string, unknown>): Record<string, unknown> {
  const source = Array.isArray(input.questions) ? input.questions : [input]
  const questions = source.map(normalizeQuestion).filter((question) => question !== null)

  return questions.length > 0 ? { ...input, questions } : input
}

function normalizeToolName(name: string): string {
  switch (name.toLowerCase().replace(/-/g, "_")) {
    case "ask_user": return "AskUserQuestion"
    case "bash":
    case "powershell":
    case "shell": return "Bash"
    case "create": return "Write"
    case "edit": return "Edit"
    default: return name
  }
}

function normalizeToolInput(name: string, value: unknown): Record<string, unknown> {
  const input = isObject(value) ? value : value === undefined ? {} : { value }
  if (name === "AskUserQuestion") return normalizeAskUserInput(input)
  if (name === "Edit") {
    return {
      ...input,
      file_path: readString(input.file_path, input.path),
      old_string: readString(input.old_string, input.old_str),
      new_string: readString(input.new_string, input.new_str),
    }
  }
  if (name === "Write") {
    return {
      ...input,
      file_path: readString(input.file_path, input.path),
      content: readString(input.content, input.file_text),
    }
  }
  if (name === "Bash" && typeof input.command !== "string" && typeof input.cmd === "string") {
    return { ...input, command: input.cmd }
  }
  return input
}

function extractToolResult(data: Record<string, unknown>): string {
  const error = data.error
  if (typeof error === "string") return error
  if (isObject(error)) {
    const message = readString(error.message, error.code)
    if (message) return message
  }

  const result = data.result
  if (typeof result === "string") return result
  if (!isObject(result)) return result === undefined ? "" : safeStringify(result)
  if (typeof result.detailedContent === "string") return result.detailedContent
  if (typeof result.content === "string") return result.content

  if (Array.isArray(result.contents)) {
    const content = result.contents
      .flatMap((part) => {
        const text = typeof part === "string"
          ? part
          : isObject(part) ? readString(part.text, part.content, part.output) : ""
        return text ? [text] : []
      })
      .join("\n")
    if (content) return content
  }

  if (result.structuredContent !== undefined) return safeStringify(result.structuredContent)
  return safeStringify(result)
}

function appendThinking(
  turn: Turn,
  text: string,
  timestamp: string,
  signature: string,
): void {
  if (!text || turn.thinking.some((block) => block.thinking === text)) return

  const block: ThinkingBlock = { type: "thinking", thinking: text, signature }
  turn.thinking.push(block)
  const last = turn.contentBlocks[turn.contentBlocks.length - 1]
  if (last?.kind === "thinking") {
    last.blocks.push(block)
    return
  }
  turn.contentBlocks.push({ kind: "thinking", blocks: [block], timestamp })
}

function appendToolCall(turn: Turn, call: ToolCall, timestamp: string): void {
  turn.toolCalls.push(call)
  const last = turn.contentBlocks[turn.contentBlocks.length - 1]
  if (last?.kind === "tool_calls") {
    last.toolCalls.push(call)
    return
  }
  turn.contentBlocks.push({ kind: "tool_calls", toolCalls: [call], timestamp })
}

function newToolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
  timestamp: string,
): ToolCall {
  return { id, name, input, result: null, isError: false, timestamp }
}

function toolCallsFromRequests(
  value: unknown,
  timestamp: string,
  isPending: (id: string) => boolean,
): ToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: ToolCall[] = []
  for (const request of value) {
    if (!isObject(request)) continue
    const id = readString(request.toolCallId)
    const rawName = readString(request.name)
    if (!id || !rawName || isPending(id)) continue
    const name = normalizeToolName(rawName)
    calls.push(newToolCall(id, name, normalizeToolInput(name, request.arguments), timestamp))
  }
  return calls
}

function updateToolCallStart(
  call: ToolCall,
  name: string,
  input: unknown,
  timestamp: string,
): void {
  call.name = name
  call.input = normalizeToolInput(name, input)
  call.timestamp = timestamp || call.timestamp
}

function updateToolCallResult(
  call: ToolCall,
  data: Record<string, unknown>,
  binaryAssets: Map<string, CopilotBinaryAsset>,
): void {
  call.result = extractToolResult(data)
  const resultImages = extractToolResultImages(data, binaryAssets)
  if (resultImages.length > 0) call.resultImages = resultImages
  call.isError = data.success === false || (data.error !== undefined && data.error !== null)
}

function createTurn(
  id: string,
  timestamp: string,
  userMessage: UserContent | null,
  model: string | null,
  effort: string | undefined,
  isFragment: boolean,
): Turn {
  return {
    id,
    userMessage,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls: [],
    subAgentActivity: [],
    timestamp,
    durationMs: null,
    tokenUsage: null,
    model,
    ...(effort ? { effort } : {}),
    ...(isFragment ? { isFragment: true } : {}),
  }
}

function hasTurnContent(turn: Turn): boolean {
  return turn.userMessage !== null
    || turn.assistantText.length > 0
    || turn.thinking.length > 0
    || turn.toolCalls.length > 0
    || turn.subAgentActivity.length > 0
}

export function parseCopilotSession(
  jsonlText: string,
  options?: ParseSessionOptions,
): ParsedSession {
  const events = parseEvents(jsonlText)
  const metadata = extractMetadata(events)
  const binaryAssets = collectBinaryAssets(events)
  const turns: Turn[] = []
  const pendingToolCalls = new Map<string, { call: ToolCall; turn: Turn }>()
  const agentMessages = new Map<string, { message: SubAgentMessage; turn: Turn }>()
  const pendingAgentToolCalls = new Map<string, { call: ToolCall; message: SubAgentMessage }>()
  const endTimestamps = new WeakMap<Turn, string>()
  const apiDurationMs = new WeakMap<Turn, number>()

  let current: Turn | null = null
  let currentModel: string | null = null
  let currentEffort: string | undefined
  let sawAssistantUsage = false
  let sawAssistantDuration = false
  let shutdownUsage: TokenUsage | null = null

  function noteTimestamp(turn: Turn, timestamp: string): void {
    if (timestamp) endTimestamps.set(turn, timestamp)
  }

  function ensureTurn(event: CopilotEvent): Turn {
    if (!current) {
      current = createTurn(
        turnEventId(event),
        eventTimestamp(event),
        null,
        currentModel,
        currentEffort,
        true,
      )
    }
    return current
  }

  function finalizeCurrent(): void {
    if (!current) return
    if (hasTurnContent(current)) turns.push(current)
    current = null
  }

  function ensureAgent(event: CopilotEvent): SubAgentMessage | null {
    const agentId = typeof event.agentId === "string" ? event.agentId : ""
    if (!agentId) return null
    const existing = agentMessages.get(agentId)
    if (existing) return existing.message

    const data = event.data
    const parentToolUseId = readString(data.toolCallId)
    const targetTurn = parentToolUseId
      ? pendingToolCalls.get(parentToolUseId)?.turn ?? current
      : current
    if (!targetTurn) return null
    const executionMode = readString(data.executionMode)
    const message: SubAgentMessage = {
      agentId,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      agentName: readString(data.agentDisplayName, data.agentName) || null,
      subagentType: readString(data.agentType, data.agentName) || null,
      type: "assistant",
      content: null,
      toolCalls: [],
      thinking: [],
      text: [],
      timestamp: eventTimestamp(event),
      tokenUsage: null,
      model: readString(data.model) || null,
      isBackground: executionMode === "background",
      ...(readString(data.description) ? { prompt: readString(data.description) } : {}),
      status: "running",
    }
    targetTurn.subAgentActivity.push(message)
    targetTurn.contentBlocks.push({
      kind: message.isBackground ? "background_agent" : "sub_agent",
      messages: [message],
      timestamp: message.timestamp,
    })
    agentMessages.set(agentId, { message, turn: targetTurn })
    return message
  }

  function applyAgentEvent(event: CopilotEvent): boolean {
    if (isRootEvent(event)) return false
    const message = ensureAgent(event)
    if (!message) return true
    const { data } = event
    const timestamp = eventTimestamp(event)

    if (event.type === "subagent.started" || event.type === "subagent.configured") {
      message.parentToolUseId ||= readString(data.toolCallId) || undefined
      message.agentName = readString(data.agentDisplayName, data.agentName) || message.agentName
      message.subagentType = readString(data.agentType, data.agentName) || message.subagentType
      message.model = readString(data.model) || message.model
      message.prompt ||= readString(data.description) || undefined
      message.isBackground ||= readString(data.executionMode) === "background"
      message.status = "running"
      return true
    }

    if (event.type === "subagent.completed" || event.type === "subagent.failed") {
      message.agentName = readString(data.agentDisplayName, data.agentName) || message.agentName
      message.subagentType = readString(data.agentType, data.agentName) || message.subagentType
      message.model = readString(data.model) || message.model
      message.durationMs = readNumber(data.durationMs) || message.durationMs
      message.toolUseCount = readNumber(data.totalToolCalls) || message.toolUseCount
      message.status = event.type === "subagent.completed" ? "completed" : "failed"
      const failure = readString(data.error, data.message)
      if (failure && !message.text.includes(failure)) message.text.push(failure)
      return true
    }

    if (event.type === "user.message") {
      message.prompt ||= readString(data.content) || undefined
      return true
    }

    if (event.type === "assistant.reasoning") {
      const reasoning = readString(data.content)
      if (reasoning && !message.thinking.includes(reasoning)) message.thinking.push(reasoning)
      return true
    }

    if (event.type === "assistant.message") {
      message.model = readString(data.model) || message.model
      const reasoning = readString(data.reasoningText)
      if (reasoning && !message.thinking.includes(reasoning)) message.thinking.push(reasoning)
      const text = textFromValue(data.content)
      if (text && !message.text.includes(text)) message.text.push(text)
      for (const call of toolCallsFromRequests(
        data.toolRequests,
        timestamp,
        (id) => pendingAgentToolCalls.has(id),
      )) {
        message.toolCalls.push(call)
        pendingAgentToolCalls.set(call.id, { call, message })
      }
      return true
    }

    if (event.type === "assistant.usage") {
      message.model = readString(data.model) || message.model
      const usage = parseUsage(data)
      if (usage) message.tokenUsage = mergeTokenUsage(message.tokenUsage, usage)
      return true
    }

    if (event.type === "tool.execution_start") {
      const callId = readString(data.toolCallId) || eventId(event, "copilot-agent-tool")
      const rawName = readString(data.toolName) || "Tool"
      const name = normalizeToolName(rawName)
      const existing = pendingAgentToolCalls.get(callId)
      if (existing) {
        updateToolCallStart(existing.call, name, data.arguments, timestamp)
      } else {
        const call = newToolCall(
          callId,
          name,
          normalizeToolInput(name, data.arguments),
          timestamp,
        )
        message.toolCalls.push(call)
        pendingAgentToolCalls.set(callId, { call, message })
      }
      return true
    }

    if (event.type === "tool.execution_complete") {
      const callId = readString(data.toolCallId) || eventId(event, "copilot-agent-tool")
      let pending = pendingAgentToolCalls.get(callId)
      if (!pending) {
        const rawName = readString(data.toolName) || "Tool"
        const name = normalizeToolName(rawName)
        const call = newToolCall(callId, name, {}, timestamp)
        message.toolCalls.push(call)
        pending = { call, message }
      }
      updateToolCallResult(pending.call, data, binaryAssets)
      pendingAgentToolCalls.delete(callId)
      return true
    }

    return true
  }

  for (const event of events) {
    if (applyAgentEvent(event)) continue
    const { data } = event
    const timestamp = eventTimestamp(event)

    if (event.type === "session.start" || event.type === "session.resume") {
      currentModel = readString(data.selectedModel) || currentModel
      currentEffort = readString(data.reasoningEffort) || currentEffort
      continue
    }

    if (event.type === "session.auto_mode_resolved") {
      currentModel = readString(data.chosenModel) || currentModel
      if (current) current.model = currentModel
      continue
    }

    if (event.type === "session.model_change") {
      currentModel = readString(data.newModel) || currentModel
      const effort = data.reasoningEffort
      if (typeof effort === "string") currentEffort = effort
      if (current) {
        current.model = currentModel
        if (currentEffort) current.effort = currentEffort
      }
      continue
    }

    if (event.type === "session.shutdown") {
      currentModel = readString(data.currentModel) || currentModel
      if (current && !current.model) current.model = currentModel
      shutdownUsage = parseModelMetrics(data) ?? shutdownUsage
      const duration = readNumber(data.totalApiDurationMs)
      if (current && !sawAssistantDuration && duration) apiDurationMs.set(current, duration)
      continue
    }

    if (event.type === "user.message") {
      finalizeCurrent()
      current = createTurn(
        turnEventId(event),
        timestamp,
        buildUserContent(data, binaryAssets),
        currentModel,
        currentEffort,
        false,
      )
      noteTimestamp(current, timestamp)
      continue
    }

    if (event.type === "assistant.turn_start") {
      currentModel = readString(data.model) || currentModel
      const turn = ensureTurn(event)
      turn.model = currentModel
      if (currentEffort) turn.effort = currentEffort
      noteTimestamp(turn, timestamp)
      continue
    }

    if (event.type === "assistant.reasoning") {
      const turn = ensureTurn(event)
      appendThinking(
        turn,
        readString(data.content),
        timestamp,
        readString(data.reasoningId) || eventId(event, "copilot-thinking"),
      )
      noteTimestamp(turn, timestamp)
      continue
    }

    if (event.type === "assistant.message") {
      currentModel = readString(data.model) || currentModel
      const turn = ensureTurn(event)
      turn.model = currentModel
      if (currentEffort) turn.effort = currentEffort
      appendThinking(
        turn,
        readString(data.reasoningText),
        timestamp,
        eventId(event, "copilot-thinking"),
      )
      appendAssistantText(turn, textFromValue(data.content), timestamp)

      for (const call of toolCallsFromRequests(
        data.toolRequests,
        timestamp,
        (id) => pendingToolCalls.has(id),
      )) {
        appendToolCall(turn, call, timestamp)
        pendingToolCalls.set(call.id, { call, turn })
      }

      noteTimestamp(turn, timestamp)
      continue
    }

    if (event.type === "assistant.usage") {
      currentModel = readString(data.model) || currentModel
      currentEffort = readString(data.reasoningEffort) || currentEffort
      const usage = parseUsage(data)
      const duration = readNumber(data.duration)
      if (usage) sawAssistantUsage = true
      if (duration) sawAssistantDuration = true
      const turn = ensureTurn(event)
      turn.model = currentModel
      if (currentEffort) turn.effort = currentEffort
      if (usage) turn.tokenUsage = mergeTokenUsage(turn.tokenUsage, usage)
      if (duration) apiDurationMs.set(turn, (apiDurationMs.get(turn) ?? 0) + duration)
      noteTimestamp(turn, timestamp)
      continue
    }

    if (event.type === "tool.execution_start") {
      currentModel = readString(data.model) || currentModel
      const turn = ensureTurn(event)
      turn.model = currentModel
      const callId = readString(data.toolCallId) || eventId(event, "copilot-tool")
      const rawName = readString(data.toolName) || "Tool"
      const name = normalizeToolName(rawName)
      const existing = pendingToolCalls.get(callId)
      if (existing) {
        updateToolCallStart(existing.call, name, data.arguments, timestamp)
      } else {
        const call = newToolCall(
          callId,
          name,
          normalizeToolInput(name, data.arguments),
          timestamp,
        )
        appendToolCall(turn, call, timestamp)
        pendingToolCalls.set(callId, { call, turn })
      }
      noteTimestamp(turn, timestamp)
      continue
    }

    if (event.type === "tool.execution_complete") {
      currentModel = readString(data.model) || currentModel
      const callId = readString(data.toolCallId) || eventId(event, "copilot-tool")
      let pending = pendingToolCalls.get(callId)
      if (!pending) {
        const turn = ensureTurn(event)
        const rawName = readString(data.toolName) || "Tool"
        const name = normalizeToolName(rawName)
        const call = newToolCall(callId, name, {}, timestamp)
        appendToolCall(turn, call, timestamp)
        pending = { call, turn }
      }
      updateToolCallResult(pending.call, data, binaryAssets)
      pendingToolCalls.delete(callId)
      noteTimestamp(pending.turn, timestamp)
      continue
    }

    if (event.type === "session.error") {
      const turn = ensureTurn(event)
      const errorType = readString(data.errorType) || "unknown"
      const input: Record<string, unknown> = { errorType }
      if (typeof data.statusCode === "number") input.statusCode = data.statusCode
      if (typeof data.errorCode === "string") input.errorCode = data.errorCode
      appendToolCall(turn, {
        id: eventId(event, "copilot-error"),
        name: "Error",
        input,
        result: readString(data.message) || "Copilot session error",
        isError: true,
        timestamp,
      }, timestamp)
      noteTimestamp(turn, timestamp)
      continue
    }

    if (
      event.type === "assistant.turn_end"
      || event.type === "assistant.idle"
      || event.type === "session.idle"
    ) {
      if (current) noteTimestamp(current, timestamp)
    }
  }

  finalizeCurrent()

  if (!sawAssistantUsage && shutdownUsage && turns.length === 1) {
    turns[0].tokenUsage = mergeTokenUsage(turns[0].tokenUsage, shutdownUsage)
  }

  if (metadata.model) {
    for (const turn of turns) turn.model ||= metadata.model
  }

  for (const turn of turns) {
    const endTimestamp = endTimestamps.get(turn)
    const start = Date.parse(turn.timestamp)
    const end = endTimestamp ? Date.parse(endTimestamp) : Number.NaN
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      turn.durationMs = end - start
    } else {
      const duration = apiDurationMs.get(turn) ?? 0
      if (duration) turn.durationMs = duration
    }
  }

  const stats = options?.skipStats ? createEmptySessionStats(turns.length) : computeStats(turns)
  if (!options?.skipStats && !sawAssistantUsage && shutdownUsage && turns.length > 1) {
    stats.totalInputTokens = shutdownUsage.input_tokens
    stats.totalOutputTokens = shutdownUsage.output_tokens
    stats.totalCacheCreationTokens = shutdownUsage.cache_creation_input_tokens ?? 0
    stats.totalCacheReadTokens = shutdownUsage.cache_read_input_tokens ?? 0
  }

  return {
    sessionId: metadata.sessionId,
    version: metadata.version,
    gitBranch: metadata.gitBranch,
    cwd: metadata.cwd,
    slug: metadata.slug,
    name: metadata.name,
    model: metadata.model,
    turns,
    stats,
    rawMessages: options?.skipStats
      ? []
      : events as Array<{ type: string; [key: string]: unknown }>,
    agentKind: "copilot",
  }
}

/**
 * Incrementally extend a parsed session with newly written lines.
 *
 * Copilot's durable events carry cross-turn state (permission requests, usage
 * roll-ups, sub-agent lifecycles), so the whole transcript is re-parsed rather
 * than only its tail.
 */
export function appendCopilotSession(existing: ParsedSession, newJsonlText: string): ParsedSession {
  const prefix = existing.rawMessages.map((record) => JSON.stringify(record)).join("\n")
  return parseCopilotSession(prefix ? `${prefix}\n${newJsonlText}` : newJsonlText)
}

// ── Status ──────────────────────────────────────────────────────────────────

/** True when a record `type` belongs to this CLI's durable event stream. */
export function isCopilotEventType(type: unknown): type is string {
  return typeof type === "string" && (
    type === "abort"
    || type === "binary_asset"
    || type === "user.message"
    || type.startsWith("assistant.")
    || type.startsWith("permission.")
    || type.startsWith("session.")
    || type.startsWith("subagent.")
    || type.startsWith("tool.")
    || type.startsWith("user_input.")
  )
}

/** Derive status from Copilot CLI's durable session events. */
export function deriveCopilotSessionStatus(rawMessages: readonly RawRecord[]): SessionStatusInfo {
  const pendingAgents = new Map<string, string>()
  for (const event of rawMessages) {
    const agentId = typeof event.agentId === "string" ? event.agentId : ""
    if (
      !agentId
      && (event.type === "abort" || event.type === "session.shutdown" || event.type === "session.error")
    ) {
      pendingAgents.clear()
      continue
    }
    if (!agentId || !event.type.startsWith("subagent.")) continue
    const data = isObject(event.data) ? event.data : {}
    if (event.type === "subagent.completed" || event.type === "subagent.failed") {
      pendingAgents.delete(agentId)
      continue
    }
    if (event.type === "subagent.started" || event.type === "subagent.configured") {
      const description = [data.agentDisplayName, data.description, data.agentName]
        .find((value): value is string => typeof value === "string") ?? ""
      pendingAgents.set(agentId, description || pendingAgents.get(agentId) || "")
    }
  }
  if (pendingAgents.size > 0) {
    const descriptions = [...pendingAgents.values()]
    return {
      status: "awaiting_agents",
      pendingQueue: 0,
      pendingAgents: descriptions.length,
      pendingAgentDescriptions: descriptions.filter((description) => description.length > 0),
    }
  }

  let sawUserActivity = false
  const completedPermissionRequests = new Set<string>()
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const event = rawMessages[i]
    if (typeof event.agentId === "string" && event.agentId) continue
    const data = isObject(event.data) ? event.data : {}

    switch (event.type) {
      case "abort":
      case "session.shutdown":
        return { status: "completed" }
      case "assistant.turn_end": {
        // session.idle is not durable in every CLI version. Infer whether this
        // model iteration ended the request or handed work to tools.
        for (let j = i - 1; j >= 0; j--) {
          const previous = rawMessages[j]
          if (typeof previous.agentId === "string" && previous.agentId) continue
          if (previous.type === "user.message") break
          if (previous.type === "abort") return { status: "completed" }
          if (previous.type !== "assistant.message") continue
          const previousData = isObject(previous.data) ? previous.data : {}
          return Array.isArray(previousData.toolRequests) && previousData.toolRequests.length > 0
            ? { status: "processing" }
            : { status: "completed" }
        }
        return { status: "processing" }
      }
      case "session.error":
        return {
          status: "completed",
          terminalReason: typeof data.message === "string" ? data.message : "Copilot session error",
        }
      case "assistant.idle":
      case "session.idle":
        return { status: sawUserActivity ? "completed" : "idle" }
      case "permission.completed": {
        const requestId = typeof data.requestId === "string" ? data.requestId : ""
        if (requestId) completedPermissionRequests.add(requestId)
        continue
      }
      case "permission.requested": {
        const requestId = typeof data.requestId === "string" ? data.requestId : ""
        if (requestId && completedPermissionRequests.has(requestId)) continue
        return { status: "deferred" }
      }
      case "user_input.requested":
        return { status: "tool_use", toolName: "AskUserQuestion" }
      case "tool.execution_start":
        if (completedPermissionRequests.size > 0) return { status: "thinking" }
        return {
          status: "tool_use",
          toolName: typeof data.toolName === "string"
            ? normalizeFunctionName(data.toolName)
            : typeof data.name === "string" ? normalizeFunctionName(data.name) : undefined,
        }
      case "tool.execution_complete":
        return { status: "thinking" }
      case "assistant.turn_start":
        return { status: "processing" }
      case "assistant.message":
      case "assistant.message_delta":
      case "assistant.reasoning":
      case "assistant.reasoning_delta":
        return { status: "thinking" }
      case "user.message":
        sawUserActivity = true
        return { status: "processing" }
      case "session.start":
      case "session.resume":
        return { status: sawUserActivity ? "processing" : "idle" }
    }
  }
  return { status: "idle" }
}

// ── Branching ──────────────────────────────────────────────────────────────

/**
 * Copilot branches through its own fork RPC (`capabilities.nativeFork`), so a
 * copied-and-cut transcript is never made and there is no header shape to
 * invent for one.
 */
export function brandCopilotBranch(): never {
  throw new Error("Copilot sessions branch through the CLI's fork API, not by copying the transcript")
}

// ── Turn boundaries ─────────────────────────────────────────────────────────

/**
 * Indexes of the `user.message` events that open a turn.
 *
 * Sub-agent events carry an `agentId` and belong to the turn already in
 * flight. An event with no durable `id` cannot be addressed by the CLI's fork
 * and rewind RPCs, so it cannot be a boundary either.
 */
export function copilotTurnBoundaries(
  records: readonly Record<string, unknown>[],
): number[] {
  const boundaries: number[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record.type !== "user.message" || typeof record.agentId === "string") continue
    const data = record.data
    if (!data || typeof data !== "object" || Array.isArray(data)) continue
    if (typeof record.id !== "string" || !record.id) continue
    boundaries.push(index)
  }
  return boundaries
}
