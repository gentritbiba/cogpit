// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
import { computeStats, createEmptySessionStats } from "./sessionStats"
import {
  findFailedNestedPatchCallIds,
  parseCodexToolPatches,
} from "./codex-patches"
import {
  inferToolError,
  normalizePlanToTodos,
  parseCustomToolOutput,
} from "./codex-tool-normalization"
import type {
  AudioBlock,
  ContentBlock,
  ImageBlock,
  ParseSessionOptions,
  ParsedSession,
  SubAgentMessage,
  ThinkingBlock,
  TokenUsage,
  ToolCall,
  Turn,
} from "./types"

export {
  extractApplyPatchInputs,
  findFailedNestedPatchCallIds,
  parseApplyPatch,
  parseCodexToolPatches,
} from "./codex-patches"
export { parseCustomToolOutput } from "./codex-tool-normalization"

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
  name: string
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
  firstUserMessage: string
  lastUserMessage: string
  timestamp: string
  lastTimestamp: string
  turnCount: number
  /** True when this session is a Codex sub-agent (spawned by spawn_agent) */
  isSubagent: boolean
  /** Parent session ID for sub-agent sessions */
  parentSessionId: string | null
  /** Canonical collaboration path for the agent that owns this rollout. */
  agentPath: string
}

const SKIP_PROMPT_PREFIXES = [
  "# AGENTS.md instructions for ",
  "<recommended_plugins>",
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
    || record.type === "inter_agent_communication_metadata"
    || record.type === "compacted"
    || record.type === "world_state"
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

const CODEX_IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/is
const CODEX_AUDIO_DATA_URL = /^data:(audio\/(?:wav|x-wav|mpeg|mp4|webm|ogg));base64,(.+)$/is

function parseImageDataUrl(value: unknown): ImageBlock | null {
  if (typeof value !== "string") return null
  const match = CODEX_IMAGE_DATA_URL.exec(value)
  if (!match?.[1] || !match[2]) return null
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1].toLowerCase(),
      data: match[2],
    },
  }
}

function parseAudioDataUrl(value: unknown): AudioBlock | null {
  if (typeof value !== "string") return null
  const match = CODEX_AUDIO_DATA_URL.exec(value)
  if (!match?.[1] || !match[2]) return null
  return {
    type: "audio",
    source: {
      type: "base64",
      media_type: match[1].toLowerCase(),
      data: match[2],
    },
  }
}

function extractEventMessageImages(payload: Record<string, unknown>): ImageBlock[] {
  if (!Array.isArray(payload.images)) return []
  return payload.images
    .map(parseImageDataUrl)
    .filter((image): image is ImageBlock => image !== null)
}

function extractEventMessageAudio(payload: Record<string, unknown>): AudioBlock[] {
  if (!Array.isArray(payload.audio)) return []
  return payload.audio
    .map(parseAudioDataUrl)
    .filter((audio): audio is AudioBlock => audio !== null)
}

function extractResponseMessageImages(payload: Record<string, unknown>): ImageBlock[] {
  if (!Array.isArray(payload.content)) return []
  return payload.content
    .filter((block): block is Record<string, unknown> => (
      isObject(block) && block.type === "input_image"
    ))
    .map((block) => parseImageDataUrl(block.image_url))
    .filter((image): image is ImageBlock => image !== null)
}

function extractResponseMessageAudio(payload: Record<string, unknown>): AudioBlock[] {
  if (!Array.isArray(payload.content)) return []
  return payload.content
    .filter((block): block is Record<string, unknown> => (
      isObject(block) && block.type === "input_audio"
    ))
    .map((block) => parseAudioDataUrl(block.audio_url))
    .filter((audio): audio is AudioBlock => audio !== null)
}

function buildCodexUserContent(
  message: string,
  images: ImageBlock[],
  audio: AudioBlock[] = [],
  localImages: string[] = [],
  localAudio: string[] = [],
): string | ContentBlock[] {
  const attachmentSuffix = [
    ...localImages.map((path) => `\n![image](<${path}>)`),
    ...localAudio.map((path) => `\n[audio attachment](<${path}>)`),
  ].join("")
  const text = message + attachmentSuffix
  if (images.length === 0 && audio.length === 0) return text
  return [
    ...images,
    ...audio,
    ...(text ? [{ type: "text" as const, text }] : []),
  ]
}

function normalizeFunctionName(rawName: string): string {
  // Current collaboration tools carry a namespace separately, but older and
  // transitional rollouts also encoded it in the function name itself.
  const leaf = rawName
    .split(/(?:__|[.:/])+/)
    .filter(Boolean)
    .at(-1) ?? rawName

  const aliases: Record<string, string> = {
    spawnAgent: "spawn_agent",
    waitAgent: "wait_agent",
    sendMessage: "send_message",
    followupTask: "followup_task",
    listAgents: "list_agents",
    interruptAgent: "interrupt_agent",
  }
  const canonicalCollaborationNames = new Set([
    "spawn_agent",
    "wait_agent",
    "send_message",
    "followup_task",
    "list_agents",
    "interrupt_agent",
  ])
  if (aliases[leaf]) return aliases[leaf]
  if (canonicalCollaborationNames.has(leaf)) return leaf
  return rawName
}

interface InterAgentMessage {
  messageType: string | null
  text: string
}

function extractInterAgentMessage(payload: Record<string, unknown>): InterAgentMessage {
  const rawText = extractMessageText(payload, "input_text")
  if (!rawText) return { messageType: null, text: "" }

  // Multi-agent messages use a small plaintext routing envelope. Only the
  // payload belongs in the transcript; routing metadata is already represented
  // by author/recipient fields on the response item.
  const headerEnd = rawText.match(/\r?\nPayload:\s*(?:\r?\n|$)/)
  if (!rawText.startsWith("Message Type:") || !headerEnd || headerEnd.index === undefined) {
    return { messageType: null, text: rawText.trim() }
  }

  const header = rawText.slice(0, headerEnd.index)
  const messageType = header.match(/^Message Type:\s*([^\r\n]+)/)?.[1]?.trim().toUpperCase() ?? null
  const text = rawText.slice(headerEnd.index + headerEnd[0].length).trim()
  return { messageType, text }
}

function agentNameFromPath(agentPath: string): string | null {
  const segments = agentPath.split("/").filter(Boolean)
  return segments.at(-1) ?? null
}

function readableAgentPrompt(value: unknown): string {
  if (typeof value !== "string") return ""
  const prompt = value.trim()
  // Codex 0.144 encrypts delegated task payloads in persisted rollouts. Do not
  // surface that ciphertext as if it were the human-readable agent prompt.
  if (/^gAAAAA[A-Za-z0-9_-]+$/.test(prompt)) return ""
  return prompt
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
  const reportedInputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0
  const cacheCreation = typeof value.cache_write_input_tokens === "number"
    ? value.cache_write_input_tokens
    : typeof value.cache_creation_input_tokens === "number" ? value.cache_creation_input_tokens : 0
  const nativeCachedInput = typeof value.cached_input_tokens === "number"
    ? Math.max(0, value.cached_input_tokens)
    : null
  const cacheRead = nativeCachedInput
    ?? (typeof value.cache_read_input_tokens === "number" ? value.cache_read_input_tokens : 0)
  // Codex reports input_tokens inclusive of cached input. TokenUsage follows
  // the Anthropic-shaped split used by the rest of Cogpit, where input_tokens
  // is uncached and cache_read_input_tokens is tracked separately.
  const inputTokens = nativeCachedInput === null
    ? reportedInputTokens
    : Math.max(0, reportedInputTokens - nativeCachedInput)
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
    || current.subAgentActivity.length > 0
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
  let isSubagent = false
  let parentSessionId: string | null = null
  let agentPath = "/root"

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
      // Detect sub-agent sessions via source.subagent
      const source = isObject(record.payload.source) ? record.payload.source : null
      if (source && isObject(source.subagent)) {
        isSubagent = true
        const threadSpawn = isObject(source.subagent.thread_spawn) ? source.subagent.thread_spawn : null
        if (threadSpawn && typeof threadSpawn.agent_path === "string") {
          agentPath = threadSpawn.agent_path
        }
      }
      if (typeof record.payload.forked_from_id === "string" && record.payload.forked_from_id) {
        parentSessionId = record.payload.forked_from_id
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
    name: "",
    branchedFrom,
    firstUserMessage,
    lastUserMessage,
    timestamp,
    lastTimestamp,
    turnCount,
    isSubagent,
    parentSessionId,
    agentPath,
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

export function parseCodexSession(jsonlText: string, options?: ParseSessionOptions): ParsedSession {
  const records = jsonlText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeParseLine)
    .filter(isCodexRecord)

  const metadata = extractMetadataFromRecords(records)
  const turns: Turn[] = []
  const pendingToolCalls = new Map<string, ToolCall>()
  const webSearchCalls = new Map<string, ToolCall>()
  // apply_patch parent callId → synthetic per-file tool calls
  const patchCallIds = new Map<string, { calls: ToolCall[]; direct: boolean }>()
  // spawn_agent call tracking
  const spawnAgentCalls = new Map<string, {
    callId: string
    message: string
    taskName: string | null
    model: string | null
    agentType: string | null
    timestamp: string
  }>()
  type AgentInfo = {
    agentId: string
    nickname: string | null
    agentPath: string | null
    message: string
    model: string | null
    agentType: string | null
    timestamp: string
    parentToolCallId: string
  }
  // agentId → resolved agent info (from legacy spawn results or 0.144 activity events)
  const agentRegistry = new Map<string, AgentInfo>()
  const agentIdByPath = new Map<string, string>()
  const agentIdBySpawnCall = new Map<string, string>()
  // One mutable presentation object per agent. Content blocks retain a reference
  // to this object, so later activity/final-answer records update in place.
  const agentMessages = new Map<string, { message: SubAgentMessage; turn: Turn }>()

  function upsertAgentMessage(
    agentId: string,
    targetTurn: Turn,
    eventTimestamp: string,
    update: { status?: string; text?: string } = {},
  ): SubAgentMessage {
    const info = agentRegistry.get(agentId)
    let entry = agentMessages.get(agentId)

    if (!entry) {
      const agentMessage: SubAgentMessage = {
        agentId,
        parentToolUseId: info?.parentToolCallId || undefined,
        agentName: info?.nickname ?? (info?.agentPath ? agentNameFromPath(info.agentPath) : null),
        subagentType: info?.agentType ?? null,
        type: "assistant",
        content: null,
        toolCalls: [],
        thinking: [],
        text: [],
        timestamp: info?.timestamp ?? eventTimestamp,
        tokenUsage: null,
        model: info?.model ?? null,
        isBackground: false,
        prompt: info?.message || undefined,
        status: update.status ?? "running",
      }
      targetTurn.subAgentActivity.push(agentMessage)
      const lastBlock = targetTurn.contentBlocks[targetTurn.contentBlocks.length - 1]
      if (lastBlock?.kind === "sub_agent") {
        lastBlock.messages.push(agentMessage)
      } else {
        targetTurn.contentBlocks.push({ kind: "sub_agent", messages: [agentMessage], timestamp: eventTimestamp })
      }
      entry = { message: agentMessage, turn: targetTurn }
      agentMessages.set(agentId, entry)
    }

    const agentMessage = entry.message
    if (info) {
      agentMessage.parentToolUseId = info.parentToolCallId || agentMessage.parentToolUseId
      agentMessage.agentName = info.nickname ?? (info.agentPath ? agentNameFromPath(info.agentPath) : agentMessage.agentName)
      agentMessage.subagentType = info.agentType
      agentMessage.model = info.model
      agentMessage.prompt = info.message || agentMessage.prompt
    }

    if (update.text && !agentMessage.text.includes(update.text)) {
      agentMessage.text.push(update.text)
      agentMessage.content = agentMessage.text.join("\n\n")
    }

    if (update.status) {
      const terminalStatuses = new Set(["completed", "failed", "interrupted"])
      if (!(update.status === "running" && agentMessage.status && terminalStatuses.has(agentMessage.status))) {
        agentMessage.status = update.status
      }
      if (terminalStatuses.has(update.status) && agentMessage.timestamp && eventTimestamp) {
        const startedAt = new Date(agentMessage.timestamp).getTime()
        const endedAt = new Date(eventTimestamp).getTime()
        if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt) {
          agentMessage.durationMs = endedAt - startedAt
        }
      }
    }

    return agentMessage
  }

  let current: Turn | null = null
  let currentTurnId: string | null = null
  let currentModel: string | null = metadata.model || null
  let lastTurnTimestamp = ""
  let pendingCompaction: string | null = null

  function createActiveTurn(turnId: string | null, timestamp: string, model: string | null): Turn {
    const turn = createTurn(turnId, timestamp, model)
    if (pendingCompaction) {
      turn.compactionSummary = pendingCompaction
      pendingCompaction = null
    }
    return turn
  }

  function upsertWebSearchCall(
    targetTurn: Turn,
    id: string,
    input: Record<string, unknown>,
    status: string,
    timestamp: string,
  ) {
    const existing = webSearchCalls.get(id)
    if (existing) {
      existing.input = { ...existing.input, ...input }
      existing.result = status
      existing.isError = status === "failed"
      return
    }

    const toolCall: ToolCall = {
      id,
      name: "WebSearch",
      input,
      result: status,
      isError: status === "failed",
      timestamp,
    }
    webSearchCalls.set(id, toolCall)
    appendToolCall(targetTurn, toolCall, timestamp)
  }

  for (const record of records) {
    const payload = isObject(record.payload) ? record.payload : undefined
    const timestamp = record.timestamp ?? ""

    if (record.type === "compacted") {
      current = finalizeTurn(turns, current, lastTurnTimestamp)
      pendingCompaction = "Conversation compacted"
      lastTurnTimestamp = timestamp
      continue
    }

    // World-state snapshots are model context, not transcript turns.
    if (record.type === "world_state") continue

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
      current ??= createActiveTurn(currentTurnId, timestamp, currentModel)
      const localImages = (Array.isArray(payload.local_images) ? payload.local_images : []).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      )
      const localAudio = (Array.isArray(payload.local_audio) ? payload.local_audio : []).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      )
      current.userMessage = buildCodexUserContent(
        payload.message,
        extractEventMessageImages(payload),
        extractEventMessageAudio(payload),
        localImages,
        localAudio,
      )
      current.timestamp = current.timestamp || timestamp
      lastTurnTimestamp = timestamp
      continue
    }

    current ??= createActiveTurn(currentTurnId, timestamp, currentModel)
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

    if (
      record.type === "event_msg"
      && payload?.type === "web_search_end"
      && typeof payload.call_id === "string"
    ) {
      const input: Record<string, unknown> = {}
      if (typeof payload.query === "string" && payload.query) input.query = payload.query
      if (isObject(payload.action)) input.action = payload.action
      upsertWebSearchCall(current, payload.call_id, input, "completed", timestamp)
      continue
    }

    if (
      record.type === "event_msg"
      && payload?.type === "sub_agent_activity"
      && typeof payload.agent_thread_id === "string"
      && typeof payload.agent_path === "string"
    ) {
      const agentId = payload.agent_thread_id
      const eventId = typeof payload.event_id === "string" ? payload.event_id : ""
      const kind = typeof payload.kind === "string" ? payload.kind : "started"
      const spawnInfo = eventId ? spawnAgentCalls.get(eventId) : undefined
      const existingId = agentIdByPath.get(payload.agent_path)
      const existing = agentRegistry.get(agentId) ?? (existingId ? agentRegistry.get(existingId) : undefined)

      // An `interacted` event may point back at the parent/root agent. Only a
      // `started` event (or a previously known agent) establishes a child.
      if (kind !== "started" && !existing && !spawnInfo) continue

      if (existingId && existingId !== agentId && !agentMessages.has(agentId)) {
        const provisionalEntry = agentMessages.get(existingId)
        if (provisionalEntry) {
          provisionalEntry.message.agentId = agentId
          agentMessages.delete(existingId)
          agentMessages.set(agentId, provisionalEntry)
        }
        agentRegistry.delete(existingId)
      }

      const info: AgentInfo = {
        agentId,
        nickname: existing?.nickname ?? agentNameFromPath(payload.agent_path) ?? spawnInfo?.taskName ?? null,
        agentPath: payload.agent_path,
        message: existing?.message ?? spawnInfo?.message ?? "",
        model: existing?.model ?? spawnInfo?.model ?? null,
        agentType: existing?.agentType ?? spawnInfo?.agentType ?? null,
        timestamp: existing?.timestamp ?? (timestamp || spawnInfo?.timestamp || ""),
        parentToolCallId: existing?.parentToolCallId ?? eventId,
      }
      agentRegistry.set(agentId, info)
      agentIdByPath.set(payload.agent_path, agentId)
      if (eventId && (kind === "started" || spawnInfo)) agentIdBySpawnCall.set(eventId, agentId)

      const status = kind === "interrupted" ? "interrupted" : "running"
      upsertAgentMessage(agentId, current, timestamp, { status })
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
      const images = extractResponseMessageImages(payload)
      const audio = extractResponseMessageAudio(payload)
      if (text || images.length > 0 || audio.length > 0) {
        current.userMessage = buildCodexUserContent(text, images, audio)
      }
      continue
    }

    if (payload.type === "web_search_call" && typeof payload.id === "string") {
      const input: Record<string, unknown> = {}
      if (isObject(payload.action)) input.action = payload.action
      const status = typeof payload.status === "string" ? payload.status : "completed"
      upsertWebSearchCall(current, payload.id, input, status, timestamp)
      continue
    }

    if (payload.type === "agent_message" && typeof payload.author === "string") {
      const author = payload.author
      const recipient = typeof payload.recipient === "string" ? payload.recipient : null
      const interAgentMessage = extractInterAgentMessage(payload)
      if (interAgentMessage.messageType === "NEW_TASK") continue

      const knownAgentId = agentIdByPath.get(author)
      // Outbound root → child routing messages are persisted too. They are not
      // sub-agent output and must not create a synthetic parent agent. A reply
      // without its preceding activity record is still recoverable when its
      // author is a descendant of, and recipient is, this rollout's agent.
      const isPotentialChild = author.startsWith(`${metadata.agentPath}/`)
        && (recipient === null || recipient === metadata.agentPath)
      if (!knownAgentId && !isPotentialChild) continue

      const agentId = knownAgentId ?? author
      if (!knownAgentId) {
        agentRegistry.set(agentId, {
          agentId,
          nickname: agentNameFromPath(author),
          agentPath: author,
          message: "",
          model: null,
          agentType: null,
          timestamp,
          parentToolCallId: "",
        })
        agentIdByPath.set(author, agentId)
      }

      let status: string | undefined
      if (interAgentMessage.messageType === "FINAL_ANSWER") status = "completed"
      else if (interAgentMessage.messageType === "ERROR" || interAgentMessage.messageType === "FAILED") status = "failed"
      else if (interAgentMessage.messageType === "INTERRUPTED") status = "interrupted"
      else if (interAgentMessage.messageType === "MESSAGE") status = "running"

      upsertAgentMessage(agentId, current, timestamp, {
        status,
        text: interAgentMessage.text || undefined,
      })
      continue
    }

    if (payload.type === "function_call" && typeof payload.call_id === "string") {
      const rawName = typeof payload.name === "string" ? payload.name : "tool"
      const functionName = normalizeFunctionName(rawName)
      const parsedInput = parseToolInput(payload.arguments)

      // Normalize Codex tool names + inputs to Claude Code equivalents
      let name = functionName
      let input = parsedInput
      if (functionName === "exec_command") {
        name = "Bash"
      } else if (functionName === "update_plan") {
        name = "TodoWrite"
        input = normalizePlanToTodos(parsedInput)
      }

      // Detect spawn_agent → synthesize sub-agent activity
      if (functionName === "spawn_agent") {
        spawnAgentCalls.set(payload.call_id as string, {
          callId: payload.call_id as string,
          message: readableAgentPrompt(parsedInput.message),
          taskName: typeof parsedInput.task_name === "string" ? parsedInput.task_name : null,
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
          const agentId = typeof result.agent_id === "string"
            ? result.agent_id
            : agentIdBySpawnCall.get(toolCall.id) ?? ""
          const agentPath = typeof result.task_name === "string" ? result.task_name : null
          const nickname = typeof result.nickname === "string"
            ? result.nickname
            : agentPath ? agentNameFromPath(agentPath) : null
          if (agentId) {
            const spawnInfo = spawnAgentCalls.get(toolCall.id)
            const existing = agentRegistry.get(agentId)
            const info: AgentInfo = {
              agentId,
              nickname: nickname ?? existing?.nickname ?? spawnInfo?.taskName ?? null,
              agentPath: agentPath ?? existing?.agentPath ?? null,
              message: existing?.message ?? spawnInfo?.message ?? "",
              model: existing?.model ?? spawnInfo?.model ?? null,
              agentType: existing?.agentType ?? spawnInfo?.agentType ?? null,
              timestamp: existing?.timestamp ?? spawnInfo?.timestamp ?? timestamp,
              parentToolCallId: existing?.parentToolCallId ?? toolCall.id,
            }
            agentRegistry.set(agentId, info)
            agentIdBySpawnCall.set(toolCall.id, agentId)
            if (info.agentPath) agentIdByPath.set(info.agentPath, agentId)
            upsertAgentMessage(agentId, current, timestamp, { status: "running" })
          }
        } catch { /* skip */ }
      }

      // Resolve wait_agent result → attach sub-agent messages to turn
      if (toolCall.name === "wait_agent" && output && current) {
        try {
          const result = JSON.parse(output) as Record<string, unknown>
          const statusMap = isObject(result.status) ? result.status : {}
          for (const [agentId, status] of Object.entries(statusMap)) {
            const statusValue = isObject(status) ? status : {}
            const completedText = typeof statusValue.completed === "string" ? statusValue.completed : ""
            const failedText = typeof statusValue.failed === "string"
              ? statusValue.failed
              : typeof statusValue.error === "string" ? statusValue.error : ""
            const interruptedText = typeof statusValue.interrupted === "string" ? statusValue.interrupted : ""
            const lifecycle = completedText
              ? "completed"
              : failedText ? "failed"
                : interruptedText ? "interrupted"
                  : typeof statusValue.status === "string" ? statusValue.status : "running"
            if (!agentRegistry.has(agentId)) {
              agentRegistry.set(agentId, {
                agentId,
                nickname: null,
                agentPath: null,
                message: "",
                model: null,
                agentType: null,
                timestamp,
                parentToolCallId: "",
              })
            }
            upsertAgentMessage(agentId, current, timestamp, {
              status: lifecycle,
              text: completedText || failedText || interruptedText || undefined,
            })
          }
        } catch { /* skip */ }
      }

      continue
    }

    // Handle custom_tool_call (direct apply_patch, exec wrappers, exec_command)
    if (payload.type === "custom_tool_call" && typeof payload.call_id === "string") {
      const name = typeof payload.name === "string" ? payload.name : "tool"
      const rawInput = typeof payload.input === "string" ? payload.input : ""
      const callId = payload.call_id as string
      const perFileCalls = rawInput
        ? parseCodexToolPatches(name, rawInput, callId, timestamp, metadata.cwd)
        : []

      // Keep the modern exec wrapper visible because it may contain commands or
      // other nested tools in addition to apply_patch. Direct apply_patch keeps
      // its legacy presentation as file calls only.
      if (name !== "apply_patch") {
        const toolCall: ToolCall = {
          id: callId,
          name: name === "exec_command" ? "Bash" : name,
          input: parseToolInput(rawInput),
          result: null,
          isError: false,
          timestamp,
        }
        pendingToolCalls.set(toolCall.id, toolCall)
        appendToolCall(current, toolCall, timestamp)
      }

      for (const tc of perFileCalls) {
        pendingToolCalls.set(tc.id, tc)
        appendToolCall(current, tc, timestamp)
      }
      if (perFileCalls.length > 0) {
        patchCallIds.set(callId, {
          calls: perFileCalls,
          direct: name === "apply_patch",
        })
      }
      continue
    }

    if (payload.type === "custom_tool_call_output" && typeof payload.call_id === "string") {
      const callId = payload.call_id as string
      const { text, isError } = parseCustomToolOutput(payload.output)

      // Check if this is an apply_patch result (maps to multiple per-file calls)
      const patchCalls = patchCallIds.get(callId)
      if (patchCalls) {
        const failedIds = patchCalls.direct && isError
          ? new Set(patchCalls.calls.map((call) => call.id))
          : findFailedNestedPatchCallIds(text, isError, patchCalls.calls)
        for (const patchCall of patchCalls.calls) {
          const tc = pendingToolCalls.get(patchCall.id)
          if (tc) {
            tc.result = text
            tc.isError = failedIds.has(tc.id)
            pendingToolCalls.delete(tc.id)
          }
        }
        patchCallIds.delete(callId)
      }

      const toolCall = pendingToolCalls.get(callId)
      if (toolCall) {
        toolCall.result = text
        toolCall.isError = isError
        pendingToolCalls.delete(callId)
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
    name: "",
    model: metadata.model,
    turns,
    stats: options?.skipStats ? createEmptySessionStats(turns.length) : computeStats(turns),
    rawMessages: options?.skipStats
      ? []
      : records as Array<{ type: string; [key: string]: unknown }>,
    branchedFrom: metadata.branchedFrom,
    agentKind: "codex" as const,
  }
}
