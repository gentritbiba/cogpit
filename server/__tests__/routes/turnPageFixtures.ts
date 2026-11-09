/**
 * Synthetic transcripts shaped like the files each CLI writes, for the
 * turn-page tests. Each holds the records that sit around a turn boundary in
 * real files: what a page cut must keep with the turn after it, and what it
 * must leave with the turn before.
 */

type Json = Record<string, unknown>

/** Deterministic text of about `bytes` bytes. */
function filler(seed: number, bytes: number): string {
  const word = `w${seed.toString(36)} `
  return word.repeat(Math.max(1, Math.ceil(bytes / word.length))).slice(0, bytes)
}

function clock(start: number) {
  let tick = 0
  return () => new Date(start + tick++ * 1000).toISOString()
}

/** Turn sizes that vary, with a few turns larger than the first read window. */
export function turnBytes(index: number): number {
  if (index % 13 === 7) return 300_000
  return 2_000 + ((index * 37) % 11) * 6_000
}

// ── Claude Code ─────────────────────────────────────────────────────────────

export function claudeTranscript(turnCount: number, sizeOf: (index: number) => number = turnBytes): string[] {
  const at = clock(Date.UTC(2026, 9, 1))
  let seq = 0
  const id = (prefix: string) => `${prefix}-${++seq}`
  const common = () => ({ uuid: id("rec"), timestamp: at(), sessionId: "claude-session", cwd: "/repo", version: "2.1.300", gitBranch: "main" })
  const user = (content: unknown, extra: Json = {}) => ({ type: "user", ...common(), message: { role: "user", content }, ...extra })
  const assistant = (content: Json[]) => {
    const record = common()
    return {
      type: "assistant",
      ...record,
      message: {
        id: `msg-${record.uuid}`,
        model: "claude-opus-5-5",
        role: "assistant",
        content,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  }
  const text = (value: string) => assistant([{ type: "text", text: value }])
  const toolUse = (name: string, toolUseId: string, input: Json) => assistant([{ type: "tool_use", id: toolUseId, name, input }])
  const toolResult = (toolUseId: string, content: string, extra: Json = {}) =>
    user([{ type: "tool_result", tool_use_id: toolUseId, content }], extra)
  const system = (subtype: string, extra: Json = {}) => ({ type: "system", subtype, ...common(), ...extra })
  const queue = (operation: string, content?: string) => ({ type: "queue-operation", operation, timestamp: at(), sessionId: "claude-session", ...(content ? { content } : {}) })
  const attachment = (type: string, extra: Json = {}) => ({ type: "attachment", ...common(), attachment: { type, ...extra } })
  const noise = () => ({ type: "api-request-blob", hash: id("blob"), blob: "x".repeat(3_000) })
  const snapshot = () => ({ type: "file-history-snapshot", messageId: id("snap"), snapshot: { trackedFileBackups: {} } })

  const records: Json[] = [
    { type: "custom-title", customTitle: "paging fixture", sessionId: "claude-session" },
    { type: "agent-name", agentName: "fixture", sessionId: "claude-session" },
  ]
  for (let turn = 0; turn < turnCount; turn++) {
    const body = filler(turn, sizeOf(turn))
    const prompt = `prompt ${turn}`
    const tool = `tool-${turn}`
    switch (turn % 8) {
      case 0:
        records.push(snapshot(), user(prompt), assistant([{ type: "thinking", thinking: `think ${turn}`, signature: "s" }, { type: "text", text: body }]), system("turn_duration", { durationMs: 1000 + turn }))
        break
      case 1:
        records.push(
          user(prompt),
          toolUse("Bash", tool, { command: `cat ${turn}` }),
          noise(),
          toolResult(tool, body),
          attachment("hook_success", { hookName: "PostToolUse" }),
          text(`read ${turn}`),
          system("turn_duration", { durationMs: 2000 }),
          system("stop_hook_summary", { hookCount: 1 }),
        )
        break
      case 2:
        // A queued prompt reaches the transcript as an enqueue/dequeue pair
        // ahead of the user record, and a steer lands in the middle of a turn.
        records.push(
          queue("enqueue", prompt),
          queue("dequeue"),
          user(prompt),
          toolUse("Read", tool, { file_path: `/repo/${turn}.ts` }),
          queue("enqueue", `steer ${turn}`),
          toolResult(tool, body),
          text(`steered ${turn}`),
        )
        break
      case 3: {
        // A sub-agent reports progress lines, then its result.
        records.push(user(prompt), toolUse("Agent", tool, { description: `agent ${turn}`, prompt: "go", subagent_type: "general-purpose" }))
        for (let step = 0; step < 3; step++) {
          records.push({
            type: "progress",
            ...common(),
            parentToolUseID: tool,
            data: { type: "agent_progress", agentId: `agent-${turn}`, prompt: "", normalizedMessages: [], message: { type: "assistant", timestamp: at(), message: { id: id("sub"), role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: `step ${step} ${body.slice(0, 200)}` }] } } },
          })
        }
        records.push(
          toolResult(tool, body, { toolUseResult: { agentId: `agent-${turn}`, status: "completed", content: [{ type: "text", text: `agent ${turn} done` }], totalDurationMs: 10, totalToolUseCount: 1 } }),
          text(`agent finished ${turn}`),
        )
        break
      }
      case 4:
        // A recap and the prompt's hook attachments come before the prompt.
        records.push(
          system("away_summary", { content: `while you were away ${turn}` }),
          attachment("hook_success", { hookName: "UserPromptSubmit" }),
          attachment("hook_additional_context", { content: ["ctx"] }),
          user(prompt),
          text(body),
        )
        break
      case 5:
        records.push(
          system("compact_boundary", { content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 100_000 } }),
          user(`This session is being continued from a previous conversation.\n\nSummary:\nsummary ${turn}`, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
          text(body),
        )
        break
      case 6:
        // A background agent reports back once its turn has gone quiet.
        records.push(
          user(prompt),
          toolUse("Agent", tool, { description: `bg ${turn}`, prompt: "go", run_in_background: true }),
          toolResult(tool, "Async agent launched"),
          text(`launched ${turn}`),
          system("turn_duration", { durationMs: 500 }),
          noise(),
          user(`<task-notification>\n<task-id>${tool}</task-id>\n<status>completed</status>\n<summary>bg ${turn} done</summary>\n</task-notification>`),
          text(body),
          system("turn_duration", { durationMs: 700 }),
        )
        break
      default:
        records.push(
          { type: "summary", summary: `summary title ${turn}`, leafUuid: id("leaf") },
          user(`<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<command-args></command-args>`),
          system("local_command", { content: `<local-command-stdout>cost ${turn}</local-command-stdout>` }),
          user(prompt),
          text(body),
        )
    }
  }
  return records.map((record) => JSON.stringify(record))
}

// ── Codex ───────────────────────────────────────────────────────────────────

interface CodexOptions {
  /** Ordinal at which a sub-agent's own records start; the records before it copy its parent's history. */
  forkedAt?: number
}

export function codexTranscript(turnCount: number, options: CodexOptions = {}, sizeOf: (index: number) => number = turnBytes): string[] {
  const at = clock(Date.UTC(2026, 9, 2))
  let ordinal = 0
  const record = (type: string, payload: Json) => JSON.stringify({ timestamp: at(), ordinal: ordinal++, type, payload })
  const message = (role: string, text: string) => record("response_item", {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  })
  const turnContext = (turnId: string) => record("turn_context", { turn_id: turnId, cwd: "/repo", model: "gpt-6.1", approval_policy: "never" })
  const tokenCount = (total: number) => record("event_msg", {
    type: "token_count",
    info: { total_token_usage: { input_tokens: total, output_tokens: 10, total_tokens: total + 10 }, last_token_usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
  })

  const meta = {
    id: "codex-session",
    cwd: "/repo",
    cli_version: "0.160.0",
    originator: "codex_cli_rs",
    model_provider: "openai",
    ...(options.forkedAt !== undefined
      ? { parent_thread_id: "parent", source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/worker" } } }, subagent_history_start_ordinal: options.forkedAt }
      : { source: "cli" }),
  }
  const lines = [
    record("session_meta", meta),
    record("event_msg", { type: "task_started", turn_id: "t-0" }),
    record("response_item", { type: "additional_tools", role: "developer", tools: [] }),
    message("developer", "<permissions instructions>"),
    message("user", "<environment_context><cwd>/repo</cwd></environment_context>"),
    record("world_state", { full: true, state: {} }),
  ]
  for (let turn = 0; turn < turnCount; turn++) {
    const body = filler(turn, sizeOf(turn))
    const turnId = `t-${turn}`
    const call = `call-${turn}`
    if (turn > 0) lines.push(record("event_msg", { type: "task_started", turn_id: turnId }))
    lines.push(
      turnContext(turnId),
      record("event_msg", { type: "thread_settings_applied", thread_settings: { model: "gpt-6.1" } }),
      message("user", `prompt ${turn}`),
    )
    // Older CLIs echo the prompt as an event after the response item.
    if (turn % 4 === 1) lines.push(record("event_msg", { type: "user_message", message: `prompt ${turn}` }))
    lines.push(
      record("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: `reason ${turn}` }], encrypted_content: "x" }),
      record("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `cat ${turn}` }), call_id: call }),
      record("response_item", { type: "function_call_output", call_id: call, output: body }),
      tokenCount(1000 + turn),
    )
    if (turn % 5 === 3) {
      // Compaction mid-turn: the turn carries on under the same id.
      lines.push(
        record("token_usage_record", { turn_id: turnId, usage: { input_tokens: 1 } }),
        record("compacted", { message: "", replacement_history: [] }),
        record("world_state", { full: true, state: {} }),
        turnContext(turnId),
        record("event_msg", { type: "thread_settings_applied", thread_settings: { model: "gpt-6.1" } }),
      )
    }
    lines.push(
      message("assistant", `answer ${turn}`),
      record("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: `answer ${turn}` }),
    )
  }
  return lines
}

// ── Copilot ─────────────────────────────────────────────────────────────────

export function copilotTranscript(turnCount: number, sizeOf: (index: number) => number = turnBytes): string[] {
  const at = clock(Date.UTC(2026, 9, 3))
  let seq = 0
  const event = (type: string, data: Json, eventId = `${type}-${++seq}`) => JSON.stringify({ type, data, id: eventId, timestamp: at() })
  const lines = [event("session.start", { sessionId: "copilot-session", copilotVersion: "1.0.82", selectedModel: "claude-sonnet-4.5", context: { cwd: "/repo", branch: "main" } })]
  for (let turn = 0; turn < turnCount; turn++) {
    const call = `tool-${turn}`
    lines.push(
      event("user.message", { content: `prompt ${turn}`, turnId: String(turn) }, `user-${turn}`),
      event("assistant.turn_start", { model: "claude-sonnet-4.5" }),
      event("assistant.reasoning", { content: `reason ${turn}` }),
      event("assistant.message", { content: `looking ${turn}`, model: "claude-sonnet-4.5", toolRequests: [{ toolCallId: call, name: "bash", arguments: { command: `cat ${turn}` } }] }),
      event("tool.execution_start", { toolCallId: call, toolName: "bash", arguments: { command: `cat ${turn}` } }),
      event("tool.execution_complete", { toolCallId: call, success: true, result: { content: filler(turn, sizeOf(turn)) } }),
      event("assistant.usage", { model: "claude-sonnet-4.5", inputTokens: 10, outputTokens: 2, duration: 100 }),
      event("assistant.message", { content: `done ${turn}` }),
      event("assistant.turn_end", {}),
    )
  }
  return lines
}
