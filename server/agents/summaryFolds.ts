import type { EditOp } from "../../shared/diff-utils"
import { formatForRecords } from "../../shared/session/agents"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import {
  hasFailedExit,
  normalizeFunctionName,
  parseCustomToolOutput,
} from "../../shared/session/codex-tool-normalization"
import { computeContextUsage } from "../../shared/session/contextWindow"
import {
  asRecordOrEmpty,
  foldFileEdit,
  isFileEditTool,
  notePendingTool,
  notePreview,
  noteToolCall,
  num,
  recordEdit,
  str,
  type SessionAccumulator,
} from "./summaryAccumulator"

/**
 * How each agent's transcript records fold into a Mission Control summary.
 *
 * One record is enough to name the format — the three vocabularies are
 * disjoint and a transcript never mixes them — so `foldSummaryEntry` asks the
 * format registry per record rather than per file.
 */

type SummaryFold = (acc: SessionAccumulator, entry: Record<string, unknown>) => void

// ── Claude ──────────────────────────────────────────────────────────────────

function foldClaudeAssistant(acc: SessionAccumulator, entry: Record<string, unknown>): void {
  const message = asRecordOrEmpty(entry.message)
  const model = str(message.model)
  if (model) acc.model = model

  const usage = asRecordOrEmpty(message.usage)
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheCreation = num(usage.cache_creation_input_tokens)
  acc.tokens.input += input
  acc.tokens.output += output
  acc.tokens.cacheRead += cacheRead
  acc.tokens.cacheCreation += cacheCreation

  if (input || output || cacheRead || cacheCreation) {
    // Latest response wins: it reports the whole window the model is carrying.
    const context = computeContextUsage(usage, model || acc.model || "", "claude")
    acc.context = {
      used: context.used,
      limit: context.limit,
      percent: Math.round(context.percent),
    }
  }

  const content = Array.isArray(message.content) ? message.content : []
  for (const raw of content) {
    const block = asRecordOrEmpty(raw)
    if (block.type === "text") {
      notePreview(acc, str(block.text))
      continue
    }
    if (block.type !== "tool_use") continue

    const name = str(block.name)
    if (!name) continue
    const toolInput = asRecordOrEmpty(block.input)
    noteToolCall(acc, name)
    notePendingTool(acc, str(block.id), name, toolInput)
    if (isFileEditTool(name)) foldFileEdit(acc, name, toolInput)
  }
}

function foldClaudeUser(acc: SessionAccumulator, entry: Record<string, unknown>): void {
  const content = asRecordOrEmpty(entry.message).content
  if (typeof content === "string") {
    acc.turnCount += 1
    return
  }
  if (!Array.isArray(content)) return

  let sawToolResult = false
  for (const raw of content) {
    const block = asRecordOrEmpty(raw)
    if (block.type !== "tool_result") continue
    sawToolResult = true
    const id = str(block.tool_use_id)
    if (id) acc.pendingToolUses.delete(id)
    acc.lastToolErrored = block.is_error === true
  }
  // A user line carrying only tool results is the agent's own loop, not a turn.
  if (!sawToolResult) acc.turnCount += 1
}

const foldClaude: SummaryFold = (acc, entry) => {
  if (entry.type === "assistant") foldClaudeAssistant(acc, entry)
  else if (entry.type === "user") foldClaudeUser(acc, entry)
}

// ── Copilot ─────────────────────────────────────────────────────────────────

function copilotText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((part) => {
      if (typeof part === "string") return part ? [part] : []
      const record = asRecordOrEmpty(part)
      const text = str(record.text) || str(record.content)
      return text ? [text] : []
    })
    .join("\n")
}

function normalizeCopilotToolName(name: string): string {
  switch (name.toLowerCase().replace(/-/g, "_")) {
    case "ask_user": return "AskUserQuestion"
    case "bash":
    case "powershell":
    case "shell": return "Bash"
    case "create": return "Write"
    case "edit": return "Edit"
    case "glob": return "Glob"
    case "grep": return "Grep"
    case "task": return "Task"
    case "view": return "Read"
    case "web_fetch": return "WebFetch"
    default: return name
  }
}

function normalizeCopilotToolInput(
  name: string,
  value: unknown,
): Record<string, unknown> {
  const input = asRecordOrEmpty(value)
  if (name === "Edit") {
    return {
      ...input,
      file_path: str(input.file_path) || str(input.path),
      old_string: str(input.old_string) || str(input.old_str),
      new_string: str(input.new_string) || str(input.new_str),
    }
  }
  if (name === "Write") {
    return {
      ...input,
      file_path: str(input.file_path) || str(input.path),
      content: str(input.content) || str(input.file_text),
    }
  }
  if (name === "Bash" && typeof input.command !== "string" && typeof input.cmd === "string") {
    return { ...input, command: input.cmd }
  }
  return input
}

/** Copilot announces the same call in assistant.message and tool.execution_start. */
function foldCopilotToolUse(
  acc: SessionAccumulator,
  id: string,
  rawName: string,
  rawInput: unknown,
): void {
  if (!rawName) return
  const name = normalizeCopilotToolName(rawName)
  const input = normalizeCopilotToolInput(name, rawInput)
  const isNew = !id || !acc.announcedToolUses.has(id)

  if (isNew) {
    noteToolCall(acc, name)
    if (id) acc.announcedToolUses.add(id)
  }

  notePendingTool(acc, id, name, input)

  if (
    isFileEditTool(name)
    && (!id || !acc.foldedFileEdits.has(id))
    && foldFileEdit(acc, name, input)
    && id
  ) {
    acc.foldedFileEdits.add(id)
  }
}

function foldCopilotUsage(
  acc: SessionAccumulator,
  data: Record<string, unknown>,
  inputIncludesCache: boolean,
): boolean {
  const cacheRead = num(data.cacheReadTokens)
  const cacheCreation = num(data.cacheWriteTokens)
  const reportedInput = num(data.inputTokens)
  const input = inputIncludesCache
    ? Math.max(0, reportedInput - cacheRead - cacheCreation)
    : reportedInput
  const output = num(data.outputTokens)
  if (!input && !output && !cacheRead && !cacheCreation) return false

  acc.tokens.input += input
  acc.tokens.output += output
  acc.tokens.cacheRead += cacheRead
  acc.tokens.cacheCreation += cacheCreation
  return true
}

function replaceCopilotShutdownUsage(
  acc: SessionAccumulator,
  data: Record<string, unknown>,
): void {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  let found = false
  const modelMetrics = asRecordOrEmpty(data.modelMetrics)
  for (const value of Object.values(modelMetrics)) {
    const usage = asRecordOrEmpty(asRecordOrEmpty(value).usage)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheCreation = num(usage.cacheWriteTokens)
    const reportedInput = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    if (!reportedInput && !output && !cacheRead && !cacheCreation) continue
    found = true
    totals.input += Math.max(0, reportedInput - cacheRead - cacheCreation)
    totals.output += output
    totals.cacheRead += cacheRead
    totals.cacheCreation += cacheCreation
  }

  if (!found) {
    const details = asRecordOrEmpty(data.tokenDetails)
    totals.input = num(asRecordOrEmpty(details.input).tokenCount)
    totals.output = num(asRecordOrEmpty(details.output).tokenCount)
    totals.cacheRead = num(asRecordOrEmpty(details.cache_read).tokenCount)
    totals.cacheCreation = num(asRecordOrEmpty(details.cache_write).tokenCount)
    found = Object.values(totals).some((value) => value > 0)
  }

  if (found) acc.tokens = totals
}

function setCopilotContext(
  acc: SessionAccumulator,
  usage: Record<string, unknown>,
): void {
  const model = str(usage.model) || acc.model || ""
  const context = computeContextUsage({
    input_tokens: num(usage.inputTokens),
    cache_creation_input_tokens: num(usage.cacheWriteTokens),
    cache_read_input_tokens: num(usage.cacheReadTokens),
  }, model, "copilot")
  if (!context.used) return
  acc.context = { used: context.used, limit: context.limit, percent: Math.round(context.percent) }
}

/** Each Copilot event names the model in its own field. */
function copilotModel(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "session.start":
    case "session.resume": return str(data.selectedModel)
    case "session.auto_mode_resolved": return str(data.chosenModel)
    case "session.model_change": return str(data.newModel)
    case "session.shutdown": return str(data.currentModel)
    default: return str(data.model)
  }
}

const foldCopilot: SummaryFold = (acc, entry) => {
  const type = str(entry.type)
  const data = asRecordOrEmpty(entry.data)
  const nested = typeof entry.agentId === "string" && entry.agentId.length > 0

  if (!nested) {
    const model = copilotModel(type, data)
    if (model) acc.model = model
  }

  if (type === "user.message") {
    if (!nested) acc.turnCount += 1
    return
  }

  if (type === "assistant.message") {
    if (!nested) notePreview(acc, copilotText(data.content))
    if (Array.isArray(data.toolRequests)) {
      for (const value of data.toolRequests) {
        const request = asRecordOrEmpty(value)
        foldCopilotToolUse(
          acc,
          str(request.toolCallId),
          str(request.name),
          request.arguments,
        )
      }
    }
    return
  }

  if (type === "tool.execution_start") {
    foldCopilotToolUse(acc, str(data.toolCallId), str(data.toolName), data.arguments)
    return
  }

  if (type === "tool.execution_complete") {
    const id = str(data.toolCallId)
    if (!acc.announcedToolUses.has(id) && str(data.toolName)) {
      foldCopilotToolUse(acc, id, str(data.toolName), data.arguments)
    }
    if (id) acc.pendingToolUses.delete(id)
    acc.lastToolErrored = data.success === false || data.error !== undefined
    return
  }

  if (type === "assistant.usage") {
    if (foldCopilotUsage(acc, data, false) && !nested) setCopilotContext(acc, data)
    return
  }

  if (type === "session.shutdown" && !nested) {
    replaceCopilotShutdownUsage(acc, data)
    const currentTokens = num(data.currentTokens)
    if (currentTokens) setCopilotContext(acc, { inputTokens: currentTokens, model: acc.model })
  }
}

// ── Codex ───────────────────────────────────────────────────────────────────

/** Codex reports input inclusive of cache; the rest of Cogpit keeps them apart. */
function codexTokens(usage: Record<string, unknown>): SessionAccumulator["tokens"] {
  const cacheRead = num(usage.cached_input_tokens)
  const cacheCreation = num(usage.cache_write_input_tokens)
  return {
    input: Math.max(0, num(usage.input_tokens) - cacheRead),
    // reasoning_output_tokens is a subset of output_tokens, not an addition.
    output: num(usage.output_tokens),
    cacheRead,
    cacheCreation,
  }
}

/**
 * Reconstruct both sides of a unified diff hunk so the net-diff math sees the
 * same shape it gets from an Edit tool call. Codex reports an update only as a
 * diff — there is no before/after content anywhere in the transcript.
 */
function editOpFromUnifiedDiff(unifiedDiff: string): EditOp {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("@@")) continue
    if (line.startsWith("-")) oldLines.push(line.slice(1))
    else if (line.startsWith("+")) newLines.push(line.slice(1))
    else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    }
  }
  return { oldString: oldLines.join("\n"), newString: newLines.join("\n"), isWrite: false }
}

/** Fold the structured file changes a completed `apply_patch` reports. */
function foldCodexFileChanges(acc: SessionAccumulator, changes: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(changes)) {
    const change = asRecordOrEmpty(value)
    if (change.type === "add") {
      recordEdit(acc, path, { oldString: "", newString: str(change.content), isWrite: true })
    } else if (change.type === "update") {
      recordEdit(acc, path, editOpFromUnifiedDiff(str(change.unified_diff)))
    }
    // A delete carries no content, so there are no lines to attribute to it.
  }
}

function foldCodexToolCall(
  acc: SessionAccumulator,
  callId: string,
  rawName: string,
  input: Record<string, unknown>,
): void {
  const name = normalizeFunctionName(rawName)
  noteToolCall(acc, name)
  notePendingTool(acc, callId, name, input)
}

function foldCodexEvent(acc: SessionAccumulator, payload: Record<string, unknown>): void {
  const type = str(payload.type)

  if (type === "token_count") {
    // total_token_usage is cumulative for the whole session, so it replaces
    // rather than adds — summing it would multiply every earlier turn back in.
    const info = asRecordOrEmpty(payload.info)
    const total = asRecordOrEmpty(info.total_token_usage)
    if (Object.keys(total).length > 0) acc.tokens = codexTokens(total)

    // The window the model is carrying is the last request's input, because
    // Codex re-sends the whole conversation on every request.
    const last = asRecordOrEmpty(info.last_token_usage)
    const context = computeContextUsage({
      input_tokens: num(last.input_tokens) - num(last.cached_input_tokens),
      cache_read_input_tokens: num(last.cached_input_tokens),
      cache_creation_input_tokens: num(last.cache_write_input_tokens),
    }, acc.model ?? "", "codex")
    if (context.used) {
      const limit = num(info.model_context_window) || context.limit
      acc.context = {
        used: context.used,
        limit,
        percent: Math.round(Math.min(100, (context.used / limit) * 100)),
      }
    }
    return
  }

  if (type === "user_message") {
    acc.turnCount += 1
    return
  }

  if (type === "agent_message" && str(payload.phase) === "final_answer") {
    notePreview(acc, str(payload.message))
    return
  }

  if (type === "task_complete") {
    notePreview(acc, str(payload.last_agent_message))
    return
  }

  if (type === "patch_apply_end") {
    foldCodexFileChanges(acc, asRecordOrEmpty(payload.changes))
    return
  }

  if (type === "mcp_tool_call_end") {
    const invocation = asRecordOrEmpty(payload.invocation)
    const name = `mcp__${str(invocation.server)}__${str(invocation.tool)}`
    foldCodexToolCall(acc, str(payload.call_id), name, asRecordOrEmpty(invocation.arguments))
    acc.pendingToolUses.delete(str(payload.call_id))
    acc.lastToolErrored = "Err" in asRecordOrEmpty(payload.result)
  }
}

function foldCodexResponseItem(acc: SessionAccumulator, payload: Record<string, unknown>): void {
  const type = str(payload.type)

  if (type === "function_call") {
    let input: Record<string, unknown> = {}
    try {
      input = asRecordOrEmpty(JSON.parse(str(payload.arguments)))
    } catch {
      input = { raw: str(payload.arguments) }
    }
    foldCodexToolCall(acc, str(payload.call_id), str(payload.name), input)
    return
  }

  if (type === "custom_tool_call") {
    // The input of a custom tool is a raw script, not JSON; the tool summarizer
    // recognises it under `raw` and lexes the nested calls out of it.
    foldCodexToolCall(acc, str(payload.call_id), str(payload.name), { raw: str(payload.input) })
    return
  }

  if (type === "function_call_output") {
    acc.pendingToolUses.delete(str(payload.call_id))
    acc.lastToolErrored = hasFailedExit(str(payload.output))
    return
  }

  if (type === "custom_tool_call_output") {
    acc.pendingToolUses.delete(str(payload.call_id))
    acc.lastToolErrored = parseCustomToolOutput(payload.output).isError
    return
  }

  if (type === "message" && str(payload.role) === "assistant") {
    const content = Array.isArray(payload.content) ? payload.content : []
    notePreview(acc, content
      .map((block) => str(asRecordOrEmpty(block).text))
      .filter(Boolean)
      .join("\n"))
  }
}

const foldCodex: SummaryFold = (acc, entry) => {
  const type = str(entry.type)
  const payload = asRecordOrEmpty(entry.payload)

  // Model is per turn and can change mid-session, so the newest wins.
  if (type === "turn_context") {
    const model = str(payload.model)
    if (model) acc.model = model
    return
  }
  if (type === "event_msg") foldCodexEvent(acc, payload)
  else if (type === "response_item") foldCodexResponseItem(acc, payload)
}

// ── Registry ────────────────────────────────────────────────────────────────

const FOLDS: Readonly<Record<AgentKind, SummaryFold>> = Object.freeze({
  claude: foldClaude,
  codex: foldCodex,
  copilot: foldCopilot,
})

/** Fold one parsed transcript record into the accumulator, whichever agent wrote it. */
export function foldSummaryEntry(acc: SessionAccumulator, entry: Record<string, unknown>): void {
  FOLDS[formatForRecords([entry]).kind](acc, entry)
}
