import { describe, it, expect } from "vitest"
import {
  appendCodexSession,
  codexPageHeaderLine,
  createCodexPromptReader,
  extractApplyPatchInputs,
  extractCodexMetadataFromLines,
  isCodexSessionText,
  parseApplyPatch,
  parseCodexSession,
  parseCodexToolPatches,
} from "../../../shared/session/codex"
import { parseCodexSession as parseCanonicalCodexSession } from "../../../shared/session/codex"
import { prependTurns } from "@/lib/timelinePaging"

// ── Fixtures ──────────────────────────────────────────────────────────────────

function sessionMeta(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: "2024-01-01T00:00:00.000Z",
    payload: {
      id: "test-session-id",
      cli_version: "1.2.3",
      cwd: "/home/user/project",
      git: { branch: "main" },
      ...overrides,
    },
  })
}

function turnContext(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "turn_context",
    timestamp: "2024-01-01T00:00:01.000Z",
    payload: {
      turn_id: "turn-1",
      model: "gpt-4o",
      cwd: "/home/user/project",
      ...overrides,
    },
  })
}

function userMessage(text: string, timestamp = "2024-01-01T00:00:02.000Z", localImages?: string[]): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "user_message",
      message: text,
      ...(localImages && { local_images: localImages }),
    },
  })
}

function assistantMessage(text: string, timestamp = "2024-01-01T00:00:03.000Z"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  })
}

function reasoningMessage(summary: string, timestamp = "2024-01-01T00:00:02.500Z"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: { type: "reasoning", summary: [summary] },
  })
}

function functionCall(callId: string, name: string, args: string, timestamp = "2024-01-01T00:00:03.000Z"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: { type: "function_call", call_id: callId, name, arguments: args },
  })
}

function namespacedFunctionCall(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  timestamp = "2024-01-01T00:00:03.000Z",
): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: {
      type: "function_call",
      call_id: callId,
      name,
      namespace: "collaboration",
      arguments: JSON.stringify(args),
    },
  })
}

function subAgentActivity(
  eventId: string,
  agentThreadId: string,
  agentPath: string,
  kind: "started" | "interacted" | "interrupted",
  timestamp = "2024-01-01T00:00:04.000Z",
): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "sub_agent_activity",
      event_id: eventId,
      agent_thread_id: agentThreadId,
      agent_path: agentPath,
      kind,
    },
  })
}

function interAgentMessage(
  author: string,
  messageType: "MESSAGE" | "FINAL_ANSWER" | "INTERRUPTED",
  text: string,
  timestamp = "2024-01-01T00:00:05.000Z",
): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: {
      type: "agent_message",
      author,
      recipient: "/root",
      content: [
        {
          type: "input_text",
          text: `Message Type: ${messageType}\nTask name: /root\nSender: ${author}\nPayload:\n${text}`,
        },
        { type: "encrypted_content", encrypted_content: "opaque-transport-data" },
      ],
      inter_agent_communication_metadata: { turn_id: "turn-1" },
    },
  })
}

function functionCallOutput(callId: string, output: string, timestamp = "2024-01-01T00:00:04.000Z"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: { type: "function_call_output", call_id: callId, output },
  })
}

function tokenCount(
  inputTokens: number,
  outputTokens: number,
  usageOverrides: Record<string, unknown> = {},
  timestamp = "2024-01-01T00:00:05.000Z",
): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens, ...usageOverrides } },
    },
  })
}

const SIMPLE_SESSION = [
  sessionMeta(),
  turnContext(),
  userMessage("Hello"),
  assistantMessage("Hi there!"),
].join("\n")

const MULTI_TURN_SESSION = [
  sessionMeta(),
  turnContext({ turn_id: "turn-1" }),
  userMessage("What is 2+2?", "2024-01-01T00:00:01.000Z"),
  assistantMessage("4", "2024-01-01T00:00:02.000Z"),
  turnContext({ turn_id: "turn-2" }),
  userMessage("Thanks!", "2024-01-01T00:00:03.000Z"),
  assistantMessage("You're welcome!", "2024-01-01T00:00:04.000Z"),
].join("\n")

const TOOL_USE_SESSION = [
  sessionMeta(),
  turnContext(),
  userMessage("What files are here?"),
  functionCall("call-1", "bash", JSON.stringify({ command: "ls" })),
  functionCallOutput("call-1", "file1.ts\nfile2.ts"),
  assistantMessage("I see file1.ts and file2.ts."),
].join("\n")

const REASONING_SESSION = [
  sessionMeta(),
  turnContext(),
  userMessage("Think about this"),
  reasoningMessage("Let me consider the options..."),
  assistantMessage("After careful thought, here is my answer."),
].join("\n")

const TOKEN_COUNT_SESSION = [
  sessionMeta(),
  turnContext(),
  userMessage("Hello"),
  assistantMessage("Hi!"),
  tokenCount(100, 50),
].join("\n")

const BRANCHED_SESSION = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2024-01-01T00:00:00.000Z",
    payload: {
      id: "branch-session-id",
      cli_version: "1.2.3",
      cwd: "/home/user/project",
      branchedFrom: { sessionId: "original-session-id", turnIndex: 1 },
    },
  }),
  turnContext(),
  userMessage("Branched message"),
  assistantMessage("Branched response"),
].join("\n")

describe("Codex request_user_input", () => {
  const QUESTION = "What month or approximate dates do you have in mind?"

  function questionSession(toolName: string): string {
    return [
      sessionMeta(),
      turnContext(),
      userMessage("Find me a place to stay"),
      functionCall("call-q", toolName, JSON.stringify({
        questions: [{ title: QUESTION, options: ["June", "July"] }],
      })),
      functionCallOutput("call-q", JSON.stringify({ accepted: true })),
    ].join("\n")
  }

  it.each(["request_user_input", "request_user_input_async"])(
    "renders %s as an AskUserQuestion the question card can read",
    (toolName) => {
      const [toolCall] = parseCodexSession(questionSession(toolName)).turns[0].toolCalls

      expect(toolCall.name).toBe("AskUserQuestion")
      expect(toolCall.input.questions).toEqual([
        { question: QUESTION, options: [{ label: "June" }, { label: "July" }] },
      ])
    },
  )

  it("marks the async variant so its receipt is not read as an answer", () => {
    const [toolCall] = parseCodexSession(questionSession("request_user_input_async")).turns[0].toolCalls

    expect(toolCall.asyncQuestion).toBe(true)
    expect(toolCall.result).toBe('{"accepted":true}')
  })

  it("leaves the blocking variant unmarked — its result really is the answer", () => {
    const [toolCall] = parseCodexSession(questionSession("request_user_input")).turns[0].toolCalls

    expect(toolCall.asyncQuestion).toBeUndefined()
  })

  /** Codex 0.15x+ writes a prompt only as a response_item, including one steered into a running turn. */
  function promptItem(text: string, timestamp = "2024-01-01T00:00:05.000Z"): string {
    return JSON.stringify({
      type: "response_item",
      timestamp,
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    })
  }

  const CREW_DELIVERY = "Crew chat · Lead · message 7\nYou were tagged in this message:\n\nJuly works for us"

  it("keeps a message steered into the running turn and reads it as the answer", () => {
    const [turn] = parseCodexSession([
      questionSession("request_user_input_async"),
      promptItem(CREW_DELIVERY, "2024-01-01T00:00:04.000Z"),
      promptItem("June"),
      assistantMessage("Booking for June", "2024-01-01T00:00:06.000Z"),
    ].join("\n")).turns

    expect(turn.contentBlocks.filter((block) => block.kind === "queued_prompt")).toEqual([
      { kind: "queued_prompt", content: CREW_DELIVERY, timestamp: "2024-01-01T00:00:04.000Z" },
      { kind: "queued_prompt", content: "June", timestamp: "2024-01-01T00:00:05.000Z" },
    ])
    expect(turn.toolCalls[0].asyncAnswer).toBe("June")
  })

  it("leaves the question open when only a crew message follows it", () => {
    const [turn] = parseCodexSession([
      questionSession("request_user_input_async"),
      promptItem(CREW_DELIVERY),
    ].join("\n")).turns

    expect(turn.toolCalls[0].asyncAnswer).toBeUndefined()
  })

  it("reads the prompt that starts the next turn as the answer", () => {
    const { turns } = parseCodexSession([
      questionSession("request_user_input_async"),
      turnContext({ turn_id: "turn-2" }),
      promptItem("July"),
    ].join("\n"))

    expect(turns).toHaveLength(2)
    expect(turns[0].toolCalls[0].asyncAnswer).toBe("July")
  })

  it("does not render an older CLI's echo of a steered message twice", () => {
    const { turns } = parseCodexSession([
      questionSession("request_user_input_async"),
      promptItem("June\n<image>attached</image>"),
      tokenCount(10, 2),
      userMessage("June", "2024-01-01T00:00:05.000Z"),
    ].join("\n"))

    expect(turns).toHaveLength(1)
    expect(turns[0].contentBlocks.filter((block) => block.kind === "queued_prompt")).toHaveLength(1)
  })

  it("reads a reply as steered when the window opens mid-turn", () => {
    const [turn] = parseCodexSession([
      sessionMeta(),
      functionCall("call-q", "request_user_input_async", JSON.stringify({ questions: [{ title: QUESTION }] })),
      promptItem("June"),
    ].join("\n")).turns

    expect(turn.isFragment).toBe(true)
    expect(turn.userMessage).toBeNull()
    expect(turn.toolCalls[0].asyncAnswer).toBe("June")
  })

  it("shows a steered reply once when a page cut separates it from an older CLI's echo", () => {
    const older = parseCanonicalCodexSession([
      questionSession("request_user_input_async"),
      promptItem("<image name=[Image #1]>\n</image>\nJune"),
    ].join("\n")).turns
    const newer = parseCanonicalCodexSession([
      sessionMeta(),
      userMessage("June", "2024-01-01T00:00:06.000Z", ["/tmp/june.png"]),
      assistantMessage("Booking for June", "2024-01-01T00:00:07.000Z"),
    ].join("\n")).turns

    const joined = prependTurns(newer, older, "codex")

    expect(joined.flatMap((turn) => turn.contentBlocks).filter((block) => block.kind === "queued_prompt")).toHaveLength(0)
    const echoed = "June\n![image](</tmp/june.png>)"
    expect(joined.map((turn) => turn.userMessage)).toEqual(["Find me a place to stay", echoed])
    expect(joined[0].toolCalls[0].asyncAnswer).toBe(echoed)
  })

  it("keeps a steered reply when the next page opens on a new turn with the same prompt", () => {
    const older = parseCanonicalCodexSession([
      questionSession("request_user_input_async"),
      promptItem("Continue"),
    ].join("\n")).turns
    const newer = parseCanonicalCodexSession([
      sessionMeta(),
      turnContext({ turn_id: "turn-2" }),
      userMessage("Continue", "2024-01-01T00:00:06.000Z"),
    ].join("\n")).turns

    const joined = prependTurns(newer, older, "codex")

    expect(joined[0].contentBlocks.at(-1)).toMatchObject({ kind: "queued_prompt", content: "Continue" })
    expect(joined.map((turn) => turn.userMessage)).toEqual(["Find me a place to stay", "Continue"])
  })

  it("keeps a steered reply when the next page opens with a different prompt", () => {
    const older = parseCanonicalCodexSession([
      questionSession("request_user_input_async"),
      promptItem("Which month?\nJune"),
    ].join("\n")).turns
    const newer = parseCanonicalCodexSession([
      sessionMeta(),
      turnContext({ turn_id: "turn-2" }),
      promptItem("Which month?\nJuly"),
    ].join("\n")).turns

    const joined = prependTurns(newer, older, "codex")

    expect(joined[0].contentBlocks.at(-1)).toMatchObject({ kind: "queued_prompt", content: "Which month?\nJune" })
    expect(joined[0].toolCalls[0].asyncAnswer).toBe("Which month?\nJune")
  })

  it("links a reply to a question asked on an older page", () => {
    const header = [sessionMeta(), turnContext()].join("\n")
    const older = parseCanonicalCodexSession(questionSession("request_user_input_async")).turns
    const newer = parseCanonicalCodexSession([
      header,
      turnContext({ turn_id: "turn-2" }),
      promptItem("July"),
    ].join("\n")).turns

    const [asked] = prependTurns(newer, older, "codex")

    expect(asked.toolCalls[0].asyncAnswer).toBe("July")
    expect(asked.contentBlocks.flatMap((block) => block.kind === "tool_calls" ? block.toolCalls : []))
      .toContain(asked.toolCalls[0])
  })
})

// ── isCodexSessionText ─────────────────────────────────────────────────────

describe("structured Codex tool results", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "synthetic-pixels" },
  }

  it.each(["function_call", "custom_tool_call"])("retains text and images from %s output", (type) => {
    const session = parseCodexSession([
      sessionMeta(),
      turnContext(),
      userMessage("Inspect the preview"),
      JSON.stringify({
        type: "response_item",
        payload: { type, call_id: "image-call", name: "functions.view_image", arguments: "{}", input: "{}" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: `${type}_output`,
          call_id: "image-call",
          output: [{ type: "text", text: "Preview ready" }, image],
        },
      }),
    ].join("\n"))

    expect(session.turns[0].toolCalls[0]).toMatchObject({
      name: "view_image",
      result: "Preview ready",
      isError: false,
      resultImages: [image],
    })
  })

  it("completes image-only function calls and respects structured error flags", () => {
    const session = parseCodexSession([
      sessionMeta(),
      turnContext(),
      userMessage("Inspect the preview"),
      functionCall("image-call", "view_image", "{}"),
      JSON.stringify({ type: "response_item", payload: {
        type: "function_call_output", call_id: "image-call", output: [image],
      } }),
      functionCall("failed-call", "mcp__server__search", "{}"),
      JSON.stringify({ type: "response_item", payload: {
        type: "function_call_output", call_id: "failed-call",
        output: { content: [{ type: "text", text: "Access denied" }], isError: true },
      } }),
    ].join("\n"))

    expect(session.turns[0].toolCalls[0]).toMatchObject({ result: "", isError: false, resultImages: [image] })
    expect(session.turns[0].toolCalls[1]).toMatchObject({ result: "Access denied", isError: true })
  })

  it.each([false, true])("preserves MCP event images with existing call=%s", (existingCall) => {
    const session = parseCodexSession([
      sessionMeta(),
      turnContext(),
      userMessage("Show a screenshot"),
      ...(existingCall ? [functionCall("mcp-image", "mcp__browser__screenshot", "{}")] : []),
      JSON.stringify({ type: "event_msg", payload: {
        type: "mcp_tool_call_end",
        call_id: "mcp-image",
        invocation: { server: "browser", tool: "screenshot", arguments: {} },
        result: { Ok: { content: [{ type: "image", mimeType: "image/png", data: "synthetic-pixels" }], isError: false } },
      } }),
    ].join("\n"))

    expect(session.turns[0].toolCalls).toHaveLength(1)
    expect(session.turns[0].toolCalls[0]).toMatchObject({
      name: "mcp__browser__screenshot", result: "", isError: false, resultImages: [image],
    })
  })

  it("normalizes prefixed commands, plans, and direct patches before rendering", () => {
    const session = parseCodexSession([
      sessionMeta(),
      turnContext(),
      userMessage("Update the file"),
      functionCall("command", "functions.exec_command", JSON.stringify({ cmd: "bun run test" })),
      functionCall("plan", "functions.update_plan", JSON.stringify({ plan: [{ step: "Verify", status: "in_progress" }] })),
      JSON.stringify({ type: "response_item", payload: {
        type: "custom_tool_call", call_id: "patch", name: "functions.apply_patch",
        input: "*** Begin Patch\n*** Add File: src/new.ts\n+export const ready = true\n*** End Patch",
      } }),
    ].join("\n"))

    const [command, plan, patch] = session.turns[0].toolCalls
    expect(command).toMatchObject({ name: "Bash", input: { cmd: "bun run test" } })
    expect(plan).toMatchObject({ name: "TodoWrite", input: { todos: [{ content: "Verify", status: "in_progress", activeForm: "Verify" }] } })
    expect(patch).toMatchObject({ name: "Write", input: { file_path: "/home/user/project/src/new.ts" } })
  })
})

describe("isCodexSessionText", () => {
  it("returns true for Codex JSONL starting with session_meta", () => {
    expect(isCodexSessionText(SIMPLE_SESSION)).toBe(true)
  })

  it("returns true for JSONL starting with turn_context", () => {
    const text = [turnContext(), userMessage("hi")].join("\n")
    expect(isCodexSessionText(text)).toBe(true)
  })

  it("returns false for Claude JSONL", () => {
    const claudeMsg = JSON.stringify({ type: "user", sessionId: "abc", message: { role: "user", content: "hi" } })
    expect(isCodexSessionText(claudeMsg)).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(isCodexSessionText("")).toBe(false)
  })

  it("returns false for whitespace-only string", () => {
    expect(isCodexSessionText("  \n  \n  ")).toBe(false)
  })
})

// ── extractCodexMetadataFromLines ─────────────────────────────────────────

describe("extractCodexMetadataFromLines", () => {
  it("extracts sessionId, version, cwd, gitBranch, model", () => {
    const meta = extractCodexMetadataFromLines(SIMPLE_SESSION.split("\n"))
    expect(meta.sessionId).toBe("test-session-id")
    expect(meta.version).toBe("1.2.3")
    expect(meta.cwd).toBe("/home/user/project")
    expect(meta.gitBranch).toBe("main")
    expect(meta.model).toBe("gpt-4o")
  })

  it("extracts firstUserMessage and lastUserMessage", () => {
    const meta = extractCodexMetadataFromLines(MULTI_TURN_SESSION.split("\n"))
    expect(meta.firstUserMessage).toBe("What is 2+2?")
    expect(meta.lastUserMessage).toBe("Thanks!")
  })

  it("skips injected AGENTS.md instructions when selecting the task preview", () => {
    const meta = extractCodexMetadataFromLines([
      sessionMeta(),
      userMessage("# AGENTS.md instructions for /home/user/project\n\n<INSTRUCTIONS>\nRepository context\n</INSTRUCTIONS>"),
      userMessage("Inspect the session API"),
    ])

    expect(meta.firstUserMessage).toBe("Inspect the session API")
    expect(meta.lastUserMessage).toBe("Inspect the session API")
    expect(meta.turnCount).toBe(1)
  })

  it("counts turns correctly", () => {
    const meta = extractCodexMetadataFromLines(MULTI_TURN_SESSION.split("\n"))
    expect(meta.turnCount).toBe(2)
  })

  it("extracts branchedFrom info", () => {
    const meta = extractCodexMetadataFromLines(BRANCHED_SESSION.split("\n"))
    expect(meta.branchedFrom?.sessionId).toBe("original-session-id")
    expect(meta.branchedFrom?.turnIndex).toBe(1)
  })

  it("returns empty strings for missing fields", () => {
    const meta = extractCodexMetadataFromLines([])
    expect(meta.sessionId).toBe("")
    expect(meta.firstUserMessage).toBe("")
    expect(meta.isSubagent).toBe(false)
    expect(meta.parentSessionId).toBeNull()
  })

  it("detects sub-agent sessions via source.subagent", () => {
    const subagentMeta = JSON.stringify({
      type: "session_meta",
      timestamp: "2024-01-01T00:00:00.000Z",
      payload: {
        id: "sub-agent-id",
        forked_from_id: "parent-session-id",
        cwd: "/home/user/project",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "parent-session-id",
              depth: 1,
              agent_nickname: "Explorer",
              agent_role: "explorer",
            },
          },
        },
      },
    })
    const meta = extractCodexMetadataFromLines([subagentMeta])
    expect(meta.isSubagent).toBe(true)
    expect(meta.parentSessionId).toBe("parent-session-id")
    expect(meta.sessionId).toBe("sub-agent-id")
  })

  it("reads the parent from every header shape a spawned rollout uses", () => {
    const header = (payload: Record<string, unknown>) => JSON.stringify({
      type: "session_meta",
      timestamp: "2026-09-20T10:00:00.000Z",
      payload: { id: "child-id", cwd: "/home/user/project", ...payload },
    })
    const threadSpawn = { subagent: { thread_spawn: { parent_thread_id: "spawning-thread", depth: 1 } } }

    expect(extractCodexMetadataFromLines([header({ source: threadSpawn })]).parentSessionId)
      .toBe("spawning-thread")
    expect(extractCodexMetadataFromLines([
      header({ parent_thread_id: "spawning-thread", source: threadSpawn }),
    ]).parentSessionId).toBe("spawning-thread")
    expect(extractCodexMetadataFromLines([
      header({ parent_thread_id: "reviewed-thread", source: { subagent: "review" } }),
    ]).parentSessionId).toBe("reviewed-thread")
  })

  it("marks regular sessions as not sub-agent", () => {
    const meta = extractCodexMetadataFromLines(SIMPLE_SESSION.split("\n"))
    expect(meta.isSubagent).toBe(false)
    expect(meta.parentSessionId).toBeNull()
  })
})

// ── parseCodexSession ──────────────────────────────────────────────────────

describe("parseCodexSession", () => {
  it("parses a simple 1-turn session", () => {
    const session = parseCodexSession(SIMPLE_SESSION)
    expect(session.sessionId).toBe("test-session-id")
    expect(session.cwd).toBe("/home/user/project")
    expect(session.model).toBe("gpt-4o")
    expect(session.agentKind).toBe("codex")
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBe("Hello")
    expect(session.turns[0].assistantText).toEqual(["Hi there!"])
  })

  it("honors the index-only contract through the canonical implementation and facade", () => {
    const full = parseCanonicalCodexSession(TOOL_USE_SESSION)
    const indexOnly = parseCanonicalCodexSession(TOOL_USE_SESSION, { skipStats: true })

    expect(parseCodexSession).toBe(parseCanonicalCodexSession)
    expect(parseCodexSession(TOOL_USE_SESSION, { skipStats: true })).toEqual(indexOnly)
    expect(indexOnly.turns).toEqual(full.turns)
    expect(indexOnly.rawMessages).toEqual([])
    expect(indexOnly.stats).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: full.turns.length,
    })
    expect(full.rawMessages.length).toBeGreaterThan(0)
    expect(full.stats.toolCallCounts).toEqual({ bash: 1 })
  })

  it("parses a multi-turn session", () => {
    const session = parseCodexSession(MULTI_TURN_SESSION)
    expect(session.turns).toHaveLength(2)
    expect(session.turns[0].userMessage).toBe("What is 2+2?")
    expect(session.turns[0].assistantText[0]).toBe("4")
    expect(session.turns[1].userMessage).toBe("Thanks!")
    expect(session.turns[1].assistantText[0]).toBe("You're welcome!")
  })

  it("parses tool calls and outputs", () => {
    const session = parseCodexSession(TOOL_USE_SESSION)
    expect(session.turns).toHaveLength(1)
    const turn = session.turns[0]
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0].name).toBe("bash")
    expect(turn.toolCalls[0].input).toEqual({ command: "ls" })
    expect(turn.toolCalls[0].result).toBe("file1.ts\nfile2.ts")
    expect(turn.toolCalls[0].isError).toBe(false)
  })

  it("parses reasoning blocks", () => {
    const session = parseCodexSession(REASONING_SESSION)
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].thinking).toHaveLength(1)
    expect(session.turns[0].thinking[0].thinking).toBe("Let me consider the options...")
  })

  it("accumulates token usage", () => {
    const session = parseCodexSession(TOKEN_COUNT_SESSION)
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].tokenUsage?.input_tokens).toBe(100)
    expect(session.turns[0].tokenUsage?.output_tokens).toBe(50)
  })

  it("splits Codex cached input from uncached input", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Hello"),
      assistantMessage("Hi!"),
      tokenCount(100, 50, { cached_input_tokens: 30 }),
    ].join("\n")

    const usage = parseCodexSession(text).turns[0].tokenUsage
    expect(usage?.input_tokens).toBe(70)
    expect(usage?.cache_read_input_tokens).toBe(30)
    expect(usage?.output_tokens).toBe(50)
  })

  it("clamps uncached Codex input to zero", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Hello"),
      tokenCount(20, 5, { cached_input_tokens: 30 }),
    ].join("\n")

    const usage = parseCodexSession(text).turns[0].tokenUsage
    expect(usage?.input_tokens).toBe(0)
    expect(usage?.cache_read_input_tokens).toBe(30)
  })

  it("preserves Anthropic-shaped cache usage fields", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Hello"),
      tokenCount(100, 50, {
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      }),
    ].join("\n")

    const usage = parseCodexSession(text).turns[0].tokenUsage
    expect(usage?.input_tokens).toBe(100)
    expect(usage?.cache_creation_input_tokens).toBe(20)
    expect(usage?.cache_read_input_tokens).toBe(30)
  })

  it("maps Codex 0.145 cache-write tokens to cache creation", () => {
    const text = [
      sessionMeta({ cli_version: "0.145.0" }),
      turnContext(),
      userMessage("Hello"),
      tokenCount(100, 50, {
        cached_input_tokens: 30,
        cache_write_input_tokens: 12,
      }),
    ].join("\n")

    const usage = parseCodexSession(text).turns[0].tokenUsage
    expect(usage?.input_tokens).toBe(70)
    expect(usage?.cache_creation_input_tokens).toBe(12)
    expect(usage?.cache_read_input_tokens).toBe(30)
  })

  it("populates rawMessages", () => {
    const session = parseCodexSession(SIMPLE_SESSION)
    expect(session.rawMessages.length).toBeGreaterThan(0)
    expect(session.rawMessages[0].type).toBe("session_meta")
  })

  it("sets agentKind to codex", () => {
    const session = parseCodexSession(SIMPLE_SESSION)
    expect(session.agentKind).toBe("codex")
  })

  it("parses branchedFrom metadata", () => {
    const session = parseCodexSession(BRANCHED_SESSION)
    expect(session.branchedFrom?.sessionId).toBe("original-session-id")
    expect(session.branchedFrom?.turnIndex).toBe(1)
  })

  it("returns empty turns for empty input", () => {
    const session = parseCodexSession("")
    expect(session.turns).toHaveLength(0)
    expect(session.sessionId).toBe("")
  })

  it("builds content blocks with correct kinds", () => {
    const session = parseCodexSession(TOOL_USE_SESSION)
    const turn = session.turns[0]
    const kinds = turn.contentBlocks.map((b) => b.kind)
    expect(kinds).toContain("tool_calls")
    expect(kinds).toContain("text")
  })

  it("infers tool error from exit code", () => {
    const errorOutput = JSON.stringify({
      type: "response_item",
      timestamp: "2024-01-01T00:00:05.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "Process exited with code 1",
      },
    })
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("run"),
      functionCall("call-1", "bash", JSON.stringify({ command: "exit 1" })),
      errorOutput,
    ].join("\n")
    const session = parseCodexSession(text)
    expect(session.turns[0].toolCalls[0].isError).toBe(true)
  })

  it("computes turn stats", () => {
    const session = parseCodexSession(MULTI_TURN_SESSION)
    expect(session.stats.turnCount).toBe(2)
  })

  it("skips system prompt prefixes from user messages", () => {
    const withSystemPrompt = [
      sessionMeta(),
      turnContext(),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: { type: "user_message", message: "<environment_context>system stuff</environment_context>" },
      }),
      userMessage("Real user message"),
      assistantMessage("Response"),
    ].join("\n")
    const session = parseCodexSession(withSystemPrompt)
    // System prompt turn should be skipped or filtered
    const userMessages = session.turns.map((t) => t.userMessage).filter(Boolean)
    expect(userMessages).not.toContain(expect.stringContaining("<environment_context>"))
  })

  it("parses custom_tool_call (apply_patch) into per-file Edit tool calls", () => {
    const patchInput = [
      "*** Begin Patch",
      "*** Update File: /home/user/project/src/app.ts",
      "@@",
      " import { foo } from './foo'",
      "-const x = 1",
      "+const x = 2",
      "@@",
    ].join("\n")
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Fix the constant"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-patch-1",
          name: "apply_patch",
          input: patchInput,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch-1",
          output: JSON.stringify({
            output: "Success. Updated the following files:\nM /home/user/project/src/app.ts\n",
            metadata: { exit_code: 0, duration_seconds: 0.1 },
          }),
        },
      }),
      assistantMessage("Fixed."),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns).toHaveLength(1)
    const turn = session.turns[0]
    // apply_patch with one file → one Edit tool call
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0].name).toBe("Edit")
    expect(turn.toolCalls[0].input.file_path).toBe("/home/user/project/src/app.ts")
    expect(turn.toolCalls[0].input.old_string).toContain("const x = 1")
    expect(turn.toolCalls[0].input.new_string).toContain("const x = 2")
    expect(turn.toolCalls[0].isError).toBe(false)
  })

  it("parses multi-file apply_patch into separate tool calls", () => {
    const patchInput = [
      "*** Begin Patch",
      "*** Update File: /home/user/project/a.ts",
      "@@",
      "-old a",
      "+new a",
      "@@",
      "*** Update File: /home/user/project/b.ts",
      "@@",
      "-old b",
      "+new b",
      "@@",
    ].join("\n")
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Update both files"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-multi",
          name: "apply_patch",
          input: patchInput,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-multi",
          output: JSON.stringify({ output: "Success.", metadata: { exit_code: 0 } }),
        },
      }),
    ].join("\n")

    const session = parseCodexSession(text)
    const turn = session.turns[0]
    expect(turn.toolCalls).toHaveLength(2)
    expect(turn.toolCalls[0].name).toBe("Edit")
    expect(turn.toolCalls[0].input.file_path).toBe("/home/user/project/a.ts")
    expect(turn.toolCalls[1].name).toBe("Edit")
    expect(turn.toolCalls[1].input.file_path).toBe("/home/user/project/b.ts")
  })

  it("promotes exec-wrapped apply_patch calls into visible file edits", () => {
    const patchInput = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@",
      "-const x = 1",
      "+const x = 2",
      "*** End Patch",
    ].join("\n")
    const execInput = [
      `const patch = ${JSON.stringify(patchInput)};`,
      "const result = await tools.apply_patch(patch);",
      "text(result);",
    ].join("\n")
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Fix the file"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-exec-patch",
          name: "exec",
          input: execInput,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-exec-patch",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n1 pass\n0 fail\n" },
            { type: "input_text", text: "{}" },
          ],
        },
      }),
    ].join("\n")

    const turn = parseCodexSession(text).turns[0]
    expect(turn.toolCalls).toHaveLength(2)
    expect(turn.toolCalls[0]).toMatchObject({
      id: "call-exec-patch",
      name: "exec",
      isError: false,
    })
    expect(turn.toolCalls[0].result).toContain("Script completed")
    expect(turn.toolCalls[1]).toMatchObject({
      id: "call-exec-patch:patch-0",
      name: "Edit",
      isError: false,
      input: {
        file_path: "/home/user/project/src/app.ts",
        old_string: "const x = 1",
        new_string: "const x = 2",
      },
    })
    expect(turn.toolCalls[1].result).toContain("Script completed")
  })

  it("keeps successful nested patches visible when a later exec step fails", () => {
    const patchInput = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Patch and test"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-patch-test",
          name: "exec",
          input: `const patch = ${JSON.stringify(patchInput)};\nawait tools.apply_patch(patch);`,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch-test",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
            { type: "input_text", text: JSON.stringify({ chunk_id: "aa11bb", exit_code: 1, output: "Tests failed" }) },
          ],
        },
      }),
    ].join("\n")

    const [execCall, editCall] = parseCodexSession(text).turns[0].toolCalls
    expect(execCall.isError).toBe(true)
    expect(editCall.name).toBe("Edit")
    expect(editCall.isError).toBe(false)
  })

  it("attributes a nested patch failure without tainting an earlier patch", () => {
    const firstPatch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old a",
      "+new a",
      "*** End Patch",
    ].join("\n")
    const secondPatch = [
      "*** Begin Patch",
      "*** Update File: src/b.ts",
      "@@",
      "-old b",
      "+new b",
      "*** End Patch",
    ].join("\n")
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Patch both files"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-two-patches",
          name: "exec",
          input: [
            `await tools.apply_patch(${JSON.stringify(firstPatch)});`,
            `await tools.apply_patch(${JSON.stringify(secondPatch)});`,
          ].join("\n"),
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-two-patches",
          output: JSON.stringify({
            output: "apply_patch failed to apply /home/user/project/src/b.ts",
            metadata: { exit_code: 1 },
          }),
        },
      }),
    ].join("\n")

    const [, firstEdit, secondEdit] = parseCodexSession(text).turns[0].toolCalls
    expect(firstEdit).toMatchObject({
      id: "call-two-patches:patch-0",
      isError: false,
    })
    expect(secondEdit).toMatchObject({
      id: "call-two-patches:patch-1",
      isError: true,
    })
  })

  it("marks later nested patches unexecuted after an earlier patch fails", () => {
    const makePatch = (file: string) => [
      "*** Begin Patch",
      `*** Update File: src/${file}.ts`,
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Patch both files"),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-first-fails",
          name: "exec",
          input: [
            `await tools.apply_patch(${JSON.stringify(makePatch("a"))});`,
            `await tools.apply_patch(${JSON.stringify(makePatch("b"))});`,
          ].join("\n"),
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-first-fails",
          output: JSON.stringify({
            output: "apply_patch failed to apply /home/user/project/src/a.ts",
            metadata: { exit_code: 1 },
          }),
        },
      }),
    ].join("\n")

    const [, firstEdit, secondEdit] = parseCodexSession(text).turns[0].toolCalls
    expect(firstEdit.isError).toBe(true)
    expect(secondEdit.isError).toBe(true)
  })

  it("parses Add File in apply_patch as Write tool call", () => {
    const patchInput = [
      "*** Begin Patch",
      "*** Add File: /home/user/project/new.ts",
      "@@",
      "+export const hello = 'world'",
      "@@",
    ].join("\n")
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Create file"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-add",
          name: "apply_patch",
          input: patchInput,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-add",
          output: JSON.stringify({ output: "Success.", metadata: { exit_code: 0 } }),
        },
      }),
    ].join("\n")

    const session = parseCodexSession(text)
    const turn = session.turns[0]
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0].name).toBe("Write")
    expect(turn.toolCalls[0].input.file_path).toBe("/home/user/project/new.ts")
    expect(turn.toolCalls[0].input.content).toContain("hello")
  })

  it("parses custom_tool_call exec_command as Bash", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Run ls"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-exec-1",
          name: "exec_command",
          input: JSON.stringify({ command: "ls -la" }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-exec-1",
          output: JSON.stringify({ output: "file1.ts\nfile2.ts", metadata: { exit_code: 0 } }),
        },
      }),
    ].join("\n")

    const session = parseCodexSession(text)
    const turn = session.turns[0]
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0].name).toBe("Bash")
    expect(turn.toolCalls[0].input.command).toBe("ls -la")
    expect(turn.toolCalls[0].result).toContain("file1.ts")
    expect(turn.toolCalls[0].isError).toBe(false)
  })

  it("marks custom_tool_call as error when exit_code != 0", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Run failing command"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-err",
          name: "exec_command",
          input: JSON.stringify({ command: "false" }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-err",
          output: JSON.stringify({ output: "command failed", metadata: { exit_code: 1 } }),
        },
      }),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns[0].toolCalls[0].isError).toBe(true)
  })

  it("normalizes update_plan to TodoWrite with todos format", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Plan the work"),
      functionCall(
        "call-plan-1",
        "update_plan",
        JSON.stringify({
          plan: [
            { step: "Read the code", status: "completed" },
            { step: "Write the fix", status: "in_progress" },
            { step: "Run tests", status: "pending" },
          ],
        }),
      ),
      functionCallOutput("call-plan-1", "ok"),
      assistantMessage("Working on it."),
    ].join("\n")

    const session = parseCodexSession(text)
    const turn = session.turns[0]
    const planCall = turn.toolCalls.find((tc) => tc.name === "TodoWrite")
    expect(planCall).toBeDefined()
    const todos = (planCall!.input as { todos: Array<{ content: string; status: string; activeForm: string }> }).todos
    expect(todos).toHaveLength(3)
    expect(todos[0]).toEqual({ content: "Read the code", status: "completed", activeForm: "Read the code" })
    expect(todos[1]).toEqual({ content: "Write the fix", status: "in_progress", activeForm: "Write the fix" })
    expect(todos[2]).toEqual({ content: "Run tests", status: "pending", activeForm: "Run tests" })
  })

  it("parses spawn_agent/wait_agent into subAgentActivity", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Spawn a sub agent"),
      functionCall(
        "call-spawn-1",
        "spawn_agent",
        JSON.stringify({ agent_type: "default", model: "gpt-4o-mini", message: "Do something" }),
        "2024-01-01T00:00:03.000Z",
      ),
      functionCallOutput(
        "call-spawn-1",
        JSON.stringify({ agent_id: "agent-abc-123", nickname: "Plato" }),
        "2024-01-01T00:00:04.000Z",
      ),
      functionCall(
        "call-wait-1",
        "wait_agent",
        JSON.stringify({ ids: ["agent-abc-123"], timeout_ms: 15000 }),
        "2024-01-01T00:00:05.000Z",
      ),
      functionCallOutput(
        "call-wait-1",
        JSON.stringify({ status: { "agent-abc-123": { completed: "Task done." } }, timed_out: false }),
        "2024-01-01T00:00:10.000Z",
      ),
      assistantMessage("The sub-agent finished.", "2024-01-01T00:00:11.000Z"),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns).toHaveLength(1)
    const turn = session.turns[0]

    // Sub-agent activity should be populated
    expect(turn.subAgentActivity).toHaveLength(1)
    expect(turn.subAgentActivity[0].agentId).toBe("agent-abc-123")
    expect(turn.subAgentActivity[0].agentName).toBe("Plato")
    expect(turn.subAgentActivity[0].subagentType).toBe("default")
    expect(turn.subAgentActivity[0].text).toEqual(["Task done."])
    expect(turn.subAgentActivity[0].model).toBe("gpt-4o-mini")
    expect(turn.subAgentActivity[0].prompt).toBe("Do something")

    // Content blocks should include a sub_agent block for inline rendering
    const subBlocks = turn.contentBlocks.filter((b) => b.kind === "sub_agent")
    expect(subBlocks).toHaveLength(1)
    expect(subBlocks[0].messages).toHaveLength(1)
    expect(subBlocks[0].messages[0].agentId).toBe("agent-abc-123")
  })

  it("upserts current Codex multi-agent activity and strips routing envelopes", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Delegate this audit"),
      namespacedFunctionCall("call-spawn-modern", "collaboration.spawnAgent", {
        task_name: "auditor",
        fork_turns: "all",
        message: "Review the parser",
      }),
      subAgentActivity(
        "call-spawn-modern",
        "agent-thread-modern",
        "/root/auditor",
        "started",
        "2024-01-01T00:00:04.000Z",
      ),
      functionCallOutput(
        "call-spawn-modern",
        JSON.stringify({ task_name: "/root/auditor" }),
        "2024-01-01T00:00:04.100Z",
      ),
      // Outbound routing records are persisted alongside replies. This must not
      // synthesize a second `/root` agent.
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.200Z",
        payload: {
          type: "agent_message",
          author: "/root",
          recipient: "/root/auditor",
          content: [{
            type: "input_text",
            text: "Message Type: NEW_TASK\nTask name: /root/auditor\nSender: /root\nPayload:\nReview the parser",
          }],
        },
      }),
      interAgentMessage(
        "/root/auditor",
        "MESSAGE",
        "I found the relevant code.",
        "2024-01-01T00:00:05.000Z",
      ),
      subAgentActivity(
        "call-send-modern",
        "agent-thread-modern",
        "/root/auditor",
        "interacted",
        "2024-01-01T00:00:05.100Z",
      ),
      JSON.stringify({
        type: "inter_agent_communication_metadata",
        timestamp: "2024-01-01T00:00:05.200Z",
        payload: { trigger_turn: false },
      }),
      interAgentMessage(
        "/root/auditor",
        "FINAL_ANSWER",
        "The parser needs an upsert map.",
        "2024-01-01T00:00:10.000Z",
      ),
      // Replayed/forked records should update the same object, not duplicate it.
      interAgentMessage(
        "/root/auditor",
        "FINAL_ANSWER",
        "The parser needs an upsert map.",
        "2024-01-01T00:00:10.000Z",
      ),
    ].join("\n")

    const session = parseCodexSession(text)
    const turn = session.turns[0]
    expect(turn.subAgentActivity).toHaveLength(1)
    expect(turn.subAgentActivity[0]).toMatchObject({
      agentId: "agent-thread-modern",
      parentToolUseId: "call-spawn-modern",
      agentName: "auditor",
      prompt: "Review the parser",
      status: "completed",
      durationMs: 6000,
    })
    expect(turn.subAgentActivity[0].text).toEqual([
      "I found the relevant code.",
      "The parser needs an upsert map.",
    ])
    expect(String(turn.subAgentActivity[0].content)).not.toContain("Message Type:")

    const subAgentBlocks = turn.contentBlocks.filter((block) => block.kind === "sub_agent")
    expect(subAgentBlocks).toHaveLength(1)
    expect(subAgentBlocks[0].messages).toHaveLength(1)
    expect(turn.toolCalls[0].name).toBe("spawn_agent")
    expect(session.rawMessages.some((record) => record.type === "inter_agent_communication_metadata")).toBe(true)
  })

  it("maps current interrupted activity without duplicating the agent", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("Stop if blocked"),
      namespacedFunctionCall("call-spawn-interrupted", "spawn_agent", {
        task_name: "scout",
        message: "Inspect the issue",
      }),
      subAgentActivity(
        "call-spawn-interrupted",
        "agent-thread-interrupted",
        "/root/scout",
        "started",
        "2024-01-01T00:00:04.000Z",
      ),
      functionCallOutput(
        "call-spawn-interrupted",
        JSON.stringify({ task_name: "/root/scout" }),
        "2024-01-01T00:00:04.100Z",
      ),
      subAgentActivity(
        "call-interrupt-modern",
        "agent-thread-interrupted",
        "/root/scout",
        "interrupted",
        "2024-01-01T00:00:06.000Z",
      ),
    ].join("\n")

    const agent = parseCodexSession(text).turns[0].subAgentActivity
    expect(agent).toHaveLength(1)
    expect(agent[0].agentId).toBe("agent-thread-interrupted")
    expect(agent[0].status).toBe("interrupted")
    expect(agent[0].durationMs).toBe(2000)
  })

  it("appends local_images as markdown image references in userMessage", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      userMessage("check this screenshot", undefined, ["/tmp/screenshot1.png", "/var/folders/abc/image2.jpg"]),
      assistantMessage("Got it"),
    ].join("\n")
    const session = parseCodexSession(text)
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBe(
      "check this screenshot\n![image](</tmp/screenshot1.png>)\n![image](</var/folders/abc/image2.jpg>)",
    )
  })

  it("converts Codex event image data URLs into renderable image blocks", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: {
          type: "user_message",
          message: "check both screenshots",
          images: [
            "data:image/png;base64,cG5n",
            "data:image/jpeg;base64,anBlZw==",
          ],
          local_images: [],
        },
      }),
      assistantMessage("Got it"),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns[0].userMessage).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "cG5n" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "anBlZw==" },
      },
      { type: "text", text: "check both screenshots" },
    ])
  })

  it("parses Codex 0.145 audio and local-audio attachments", () => {
    const text = [
      sessionMeta({ cli_version: "0.145.0" }),
      turnContext(),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: {
          type: "user_message",
          message: "listen to this",
          images: [],
          local_images: [],
          audio: ["data:audio/mpeg;base64,bXAz"],
          local_audio: ["/tmp/note.wav"],
          text_elements: [],
        },
      }),
      assistantMessage("Got it"),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns[0].userMessage).toEqual([
      {
        type: "audio",
        source: { type: "base64", media_type: "audio/mpeg", data: "bXAz" },
      },
      { type: "text", text: "listen to this\n[audio attachment](</tmp/note.wav>)" },
    ])
  })

  it("reads input_image blocks when a Codex response item is the only user record", () => {
    const text = [
      sessionMeta(),
      turnContext(),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "image only fallback" },
            { type: "input_image", image_url: "data:image/webp;base64,d2VicA==" },
          ],
        },
      }),
      assistantMessage("Got it"),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns[0].userMessage).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/webp", data: "d2VicA==" },
      },
      { type: "text", text: "image only fallback" },
    ])
  })

  it("reads input_audio blocks when a Codex response item is the only user record", () => {
    const text = [
      sessionMeta({ cli_version: "0.145.0" }),
      turnContext(),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_audio", audio_url: "data:audio/wav;base64,d2F2" },
            { type: "input_text", text: "audio fallback" },
          ],
        },
      }),
      assistantMessage("Got it"),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns[0].userMessage).toEqual([
      {
        type: "audio",
        source: { type: "base64", media_type: "audio/wav", data: "d2F2" },
      },
      { type: "text", text: "audio fallback" },
    ])
  })

  it("skips injected recommended-plugin context in Codex 0.145 rollouts", () => {
    const injected = "<recommended_plugins>\n- GitHub\n</recommended_plugins>\n<environment_context>internal</environment_context>"
    const text = [
      sessionMeta({ cli_version: "0.145.0" }),
      turnContext(),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:01.500Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: injected }],
        },
      }),
      userMessage("the actual prompt"),
      assistantMessage("the answer"),
    ].join("\n")

    const session = parseCodexSession(text)
    const metadata = extractCodexMetadataFromLines(text.split("\n"))
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBe("the actual prompt")
    expect(metadata.firstUserMessage).toBe("the actual prompt")
    expect(metadata.turnCount).toBe(1)
  })

  it("retains Codex compaction boundaries and world-state records", () => {
    const text = [
      sessionMeta({ cli_version: "0.145.0" }),
      turnContext({ turn_id: "turn-before" }),
      userMessage("before compaction"),
      assistantMessage("before answer"),
      JSON.stringify({
        type: "compacted",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: { message: "", replacement_history: [], window_number: 2 },
      }),
      JSON.stringify({
        type: "world_state",
        timestamp: "2024-01-01T00:00:04.100Z",
        payload: { full: true, state: [] },
      }),
      turnContext({ turn_id: "turn-after" }),
      userMessage("after compaction", "2024-01-01T00:00:05.000Z"),
      assistantMessage("after answer", "2024-01-01T00:00:06.000Z"),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns).toHaveLength(2)
    expect(session.turns[1].compactionSummary).toBe("Conversation compacted")
    expect(session.rawMessages.map((record) => record.type)).toContain("compacted")
    expect(session.rawMessages.map((record) => record.type)).toContain("world_state")
  })

  it("records and deduplicates persisted Codex web searches", () => {
    const text = [
      sessionMeta({ cli_version: "0.145.0" }),
      turnContext(),
      userMessage("find the docs"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "web_search_end",
          call_id: "ws_123",
          query: "official docs",
          action: { type: "search", query: "official docs" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.100Z",
        payload: {
          type: "web_search_call",
          id: "ws_123",
          status: "completed",
          action: { type: "search", query: "official docs" },
        },
      }),
      assistantMessage("found it"),
    ].join("\n")

    const session = parseCodexSession(text)
    expect(session.turns[0].toolCalls).toHaveLength(1)
    expect(session.turns[0].toolCalls[0]).toMatchObject({
      id: "ws_123",
      name: "WebSearch",
      input: { query: "official docs" },
      result: "completed",
      isError: false,
    })
  })

  it("parses native Codex tool-search call and output records", () => {
    const text = [
      sessionMeta({ cli_version: "0.147.0" }),
      turnContext(),
      userMessage("find a tool"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "tool_search_call",
          id: "ts_item_1",
          call_id: "ts_call_1",
          status: "completed",
          execution: "client",
          arguments: { query: "resource readers" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "tool_search_output",
          call_id: "ts_call_1",
          status: "completed",
          execution: "client",
          tools: [{ name: "read_mcp_resource" }, { name: "list_mcp_resources" }],
        },
      }),
    ].join("\n")

    expect(parseCodexSession(text).turns[0].toolCalls[0]).toMatchObject({
      id: "ts_call_1",
      name: "ToolSearch",
      input: { query: "resource readers" },
      result: "Found 2 tools: read_mcp_resource, list_mcp_resources",
      isError: false,
    })
  })

  it("parses MCP completion events that have no response-item pair", () => {
    const text = [
      sessionMeta({ cli_version: "0.147.0" }),
      turnContext(),
      userMessage("inspect the design"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "mcp_call_1",
          invocation: {
            server: "figma",
            tool: "get_metadata",
            arguments: { nodeId: "12:34" },
          },
          result: {
            Ok: {
              content: [{ type: "text", text: "Frame metadata" }],
              isError: false,
            },
          },
        },
      }),
    ].join("\n")

    expect(parseCodexSession(text).turns[0].toolCalls[0]).toMatchObject({
      id: "mcp_call_1",
      name: "mcp__figma__get_metadata",
      input: { nodeId: "12:34" },
      result: "Frame metadata",
      isError: false,
    })
  })

  it("marks failed MCP completion events as errors", () => {
    const text = [
      sessionMeta({ cli_version: "0.147.0" }),
      turnContext(),
      userMessage("inspect the design"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "mcp_call_failed",
          invocation: { server: "figma", tool: "get_metadata", arguments: {} },
          result: { Err: "Connection refused" },
        },
      }),
    ].join("\n")

    expect(parseCodexSession(text).turns[0].toolCalls[0]).toMatchObject({
      result: "Connection refused",
      isError: true,
    })
  })

  it("ignores completed-item records, which only restate what an exec call ran", () => {
    const text = [
      sessionMeta({ cli_version: "0.147.0" }),
      turnContext(),
      userMessage("run and research"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "exec_call_1",
          name: "exec",
          input: 'await tools.exec_command({ cmd: "bun run test" })',
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id: "exec-00000000-0000-4000-8000-000000000001",
            command: ["bun", "run", "test"],
            cwd: "/workspace",
            aggregated_output: "3165 passed",
            status: "completed",
            exit_code: 0,
          },
        },
      }),
    ].join("\n")

    const { toolCalls } = parseCodexSession(text).turns[0]
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({ name: "exec" })
  })

  it("skips synthesizing an MCP call that already ran inside an exec script", () => {
    const text = [
      sessionMeta({ cli_version: "0.147.0" }),
      turnContext(),
      userMessage("inspect the design"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "exec-00000000-0000-4000-8000-000000000002",
          invocation: { server: "figma", tool: "get_metadata", arguments: {} },
          result: { Ok: { content: [{ type: "text", text: "Frame metadata" }] } },
        },
      }),
    ].join("\n")

    expect(parseCodexSession(text).turns[0].toolCalls).toEqual([])
  })

  it("handles empty local_images gracefully", () => {
    const text = [sessionMeta(), turnContext(), userMessage("just text", undefined, []), assistantMessage("ok")].join(
      "\n",
    )
    const session = parseCodexSession(text)
    expect(session.turns[0].userMessage).toBe("just text")
  })
})

// ── parseApplyPatch ──────────────────────────────────────────────────────

describe("parseApplyPatch", () => {
  it("parses single-file Update patch", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /src/app.ts",
      "@@",
      " import { bar }",
      "-const x = 1",
      "+const x = 2",
      "@@",
    ].join("\n")

    const calls = parseApplyPatch(patch, "call-1", "ts")
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe("Edit")
    expect(calls[0].input.file_path).toBe("/src/app.ts")
    expect(calls[0].input.old_string).toContain("const x = 1")
    expect(calls[0].input.new_string).toContain("const x = 2")
    // Context lines should appear in both
    expect(calls[0].input.old_string).toContain("import { bar }")
    expect(calls[0].input.new_string).toContain("import { bar }")
  })

  it("parses Add File as Write", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /src/new.ts",
      "@@",
      "+export const x = 1",
      "+export const y = 2",
      "@@",
    ].join("\n")

    const calls = parseApplyPatch(patch, "call-2", "ts")
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe("Write")
    expect(calls[0].input.file_path).toBe("/src/new.ts")
    expect(calls[0].input.content).toContain("export const x = 1")
  })

  it("parses multi-file patch into separate calls with unique IDs", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /a.ts",
      "@@",
      "-old",
      "+new",
      "@@",
      "*** Update File: /b.ts",
      "@@",
      "-foo",
      "+bar",
      "@@",
    ].join("\n")

    const calls = parseApplyPatch(patch, "call-3", "ts")
    expect(calls).toHaveLength(2)
    expect(calls[0].id).toBe("call-3:file-0")
    expect(calls[1].id).toBe("call-3:file-1")
    expect(calls[0].input.file_path).toBe("/a.ts")
    expect(calls[1].input.file_path).toBe("/b.ts")
  })

  it("returns empty array for empty patch", () => {
    const calls = parseApplyPatch("", "call-4", "ts")
    expect(calls).toHaveLength(0)
  })

  it("resolves relative paths and records move destinations", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")

    const calls = parseApplyPatch(patch, "call-move", "ts", "/workspace")
    expect(calls[0].input).toMatchObject({
      file_path: "/workspace/src/new.ts",
      old_path: "/workspace/src/old.ts",
      old_string: "old",
      new_string: "new",
    })
  })
})

describe("extractApplyPatchInputs", () => {
  it("extracts assigned and inline patches passed to the nested tool", () => {
    const first = "*** Begin Patch\n*** Add File: a.ts\n+one\n*** End Patch"
    const second = "*** Begin Patch\n*** Add File: b.ts\n+two\n*** End Patch"
    const source = [
      `const patch = ${JSON.stringify(first)};`,
      "await tools.apply_patch(patch);",
      `await tools.apply_patch(${JSON.stringify(second)});`,
    ].join("\n")

    expect(extractApplyPatchInputs(source)).toEqual([first, second])
    expect(parseCodexToolPatches("exec", source, "call-exec", "ts", "/workspace")).toHaveLength(2)
  })

  it("ignores patch-looking strings that are not passed to apply_patch", () => {
    const patch = "*** Begin Patch\n*** Add File: ignored.ts\n+x\n*** End Patch"
    expect(extractApplyPatchInputs(`const example = ${JSON.stringify(patch)};\ntext(example);`)).toEqual([])
  })
})

describe("parseCodexSession paged windows", () => {
  const HEADER = [
    sessionMeta(),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2024-01-01T00:00:00.000Z",
      payload: { type: "task_started", turn_id: "turn-1" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2024-01-01T00:00:00.500Z",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>x" }] },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2024-01-01T00:00:00.600Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>\nnone" }] },
    }),
  ]

  it("does not open a turn on the header records every page repeats", () => {
    // A page that starts mid-turn carries the file header. Without the guard
    // the header opened a turn stamped with the session-start timestamp.
    const { turns } = parseCanonicalCodexSession([
      ...HEADER,
      assistantMessage("tail of an earlier turn", "2024-01-01T00:05:00.000Z"),
    ].join("\n"))

    expect(turns).toHaveLength(1)
    expect(turns[0].timestamp).toBe("2024-01-01T00:05:00.000Z")
    expect(turns[0].isFragment).toBe(true)
  })

  it("does not mark a turn that opens with its own prompt as a fragment", () => {
    const { turns } = parseCanonicalCodexSession([
      ...HEADER,
      turnContext(),
      userMessage("Hello"),
      assistantMessage("Hi there!"),
    ].join("\n"))

    expect(turns).toHaveLength(1)
    expect(turns[0].isFragment).toBeFalsy()
    expect(turns[0].userMessage).toBe("Hello")
  })

  it("gives segments that share one turn_id distinct ids", () => {
    // Codex reuses turn_id across turn_context records (a compaction writes a
    // second one), and timeline paging deduplicates by turn id.
    const { turns } = parseCanonicalCodexSession([
      sessionMeta(),
      turnContext({ turn_id: "turn-1" }),
      userMessage("First", "2024-01-01T00:00:02.000Z"),
      assistantMessage("done", "2024-01-01T00:00:03.000Z"),
      JSON.stringify({ type: "compacted", timestamp: "2024-01-01T00:00:04.000Z", payload: { message: "" } }),
      turnContext({ turn_id: "turn-1", timestamp: "2024-01-01T00:00:05.000Z" }),
      assistantMessage("continued", "2024-01-01T00:00:06.000Z"),
    ].join("\n"))

    expect(turns).toHaveLength(2)
    expect(turns[0].id).not.toBe(turns[1].id)
    expect(new Set(turns.map((t) => t.id)).size).toBe(2)
  })

  it("names turns sharing a turn id and start time the same in a full parse and after an append (review #9)", () => {
    const lines = [
      sessionMeta(),
      turnContext({ turn_id: "turn-1", timestamp: "2024-01-01T00:00:01.000Z" }),
      userMessage("First", "2024-01-01T00:00:01.000Z"),
      assistantMessage("done", "2024-01-01T00:00:02.000Z"),
      turnContext({ turn_id: "turn-1", timestamp: "2024-01-01T00:00:01.000Z" }),
      userMessage("Again", "2024-01-01T00:00:01.000Z"),
      assistantMessage("done again", "2024-01-01T00:00:03.000Z"),
    ]
    const full = parseCanonicalCodexSession(lines.join("\n")).turns.map((turn) => turn.id)
    expect(full).toEqual(["turn-1@2024-01-01T00:00:01.000Z", "turn-1@2024-01-01T00:00:01.000Z#2"])

    for (let split = 1; split < lines.length; split++) {
      const start = parseCanonicalCodexSession(lines.slice(0, split).join("\n"))
      const appended = appendCodexSession(start, lines.slice(split).join("\n"))
      expect(appended.turns.map((turn) => turn.id)).toEqual(full)
    }
  })

  it("reassembles a turn split across pages without losing its prompt", () => {
    const older = [
      ...HEADER,
      turnContext(),
      userMessage("Add view transitions"),
      assistantMessage("Starting.", "2024-01-01T00:00:03.000Z"),
    ]
    const newer = [...HEADER, assistantMessage("Finished.", "2024-01-01T00:05:00.000Z")]

    const olderTurns = parseCanonicalCodexSession(older.join("\n")).turns
    const newerTurns = parseCanonicalCodexSession(newer.join("\n")).turns
    const joined = prependTurns(newerTurns, olderTurns, "codex")

    expect(joined).toHaveLength(1)
    expect(joined[0].userMessage).toBe("Add view transitions")
    expect(joined[0].assistantText).toEqual(["Starting.", "Finished."])
  })
})

describe("Codex 0.16x rollout records", () => {
  function record(ordinal: number, type: string, payload: Record<string, unknown>, timestamp = "2024-01-01T00:00:01.000Z"): string {
    return JSON.stringify({ timestamp, ordinal, type, payload })
  }
  function prompt(ordinal: number, text: string): string {
    return record(ordinal, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] })
  }
  function answer(ordinal: number, text: string): string {
    return record(ordinal, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] })
  }

  it("renders a failed turn's task_complete error as its reply", () => {
    const session = parseCodexSession([
      sessionMeta(),
      turnContext(),
      userMessage("build it"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:04.000Z",
        payload: {
          type: "task_complete",
          last_agent_message: null,
          error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" },
        },
      }),
    ].join("\n"))

    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBe("build it")
    expect(session.turns[0].assistantText).toEqual(["You've hit your usage limit."])
    expect(session.turns[0].contentBlocks).toEqual([
      { kind: "text", text: ["You've hit your usage limit."], timestamp: "2024-01-01T00:00:04.000Z" },
    ])
  })

  describe("sub-agent history copied from the parent", () => {
    const childMeta = (start: number) => record(0, "session_meta", {
      id: "child",
      cwd: "/repo",
      parent_thread_id: "parent",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/worker" } } },
      subagent_history_start_ordinal: start,
    })
    const inherited = [
      record(1, "session_meta", { id: "parent", cwd: "/repo" }),
      prompt(2, "the parent's prompt"),
      answer(3, "the parent's reply"),
    ]

    it("starts the child at its own history", () => {
      const text = [childMeta(4), ...inherited, prompt(4, "the child's task"), answer(5, "done")].join("\n")
      const session = parseCodexSession(text)
      expect(session.sessionId).toBe("child")
      expect(session.turns.map((turn) => turn.userMessage)).toEqual(["the child's task"])
      expect(session.rawMessages.map((raw) => raw.ordinal)).toEqual([0, 4, 5])

      const meta = extractCodexMetadataFromLines(text.split("\n"))
      expect(meta.firstUserMessage).toBe("the child's task")
      expect(meta.parentSessionId).toBe("parent")
      expect(meta.turnCount).toBe(1)
    })

    it("keeps everything when the boundary sits past the last record", () => {
      const session = parseCodexSession([childMeta(4), ...inherited].join("\n"))
      expect(session.turns.map((turn) => turn.userMessage)).toEqual(["the parent's prompt"])
    })

    describe("on a page of the rollout", () => {
      const own = [prompt(4, "the child's task"), answer(5, "done")]
      const pageHeader = (start: number, lastLines: string[]) => codexPageHeaderLine(childMeta(start), async () => lastLines)

      it("marks a sub-agent's header with the rollout's last ordinal, read from its last parseable line", async () => {
        const header = JSON.parse(await pageHeader(4, [...own, "{\"timestamp\":\"partial"]))
        expect(header.rolloutLastOrdinal).toBe(5)
        expect(header.payload.subagent_history_start_ordinal).toBe(4)

        const plain = record(0, "session_meta", { id: "root", cwd: "/repo" })
        const lastLines = async (): Promise<string[]> => { throw new Error("not needed") }
        await expect(codexPageHeaderLine(plain, lastLines)).resolves.toBe(plain)
      })

      it("leaves out copied history on an older page that holds nothing else", async () => {
        const header = await pageHeader(4, own)
        const olderPage = parseCodexSession([header, ...inherited].join("\n"))
        expect(olderPage.turns).toEqual([])

        const tailPage = parseCodexSession([header, ...own].join("\n"))
        expect(tailPage.turns.map((turn) => turn.userMessage)).toEqual(["the child's task"])
      })

      it("keeps a converted rollout's records, whose boundary is at the end of the file", async () => {
        const header = await pageHeader(4, inherited)
        const page = parseCodexSession([header, ...inherited.slice(1)].join("\n"))
        expect(page.turns.map((turn) => turn.userMessage)).toEqual(["the parent's prompt"])
      })
    })
  })

  it("reads sub-agent identity, model and effort from SubAgentActivity items", () => {
    const activity = (id: string, kind: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      type: "event_msg",
      timestamp: "2024-01-01T00:00:04.000Z",
      payload: {
        type: "item_completed",
        item: { type: "SubAgentActivity", id, kind, agent_thread_id: "thread-7", agent_path: "/root/reviewer", model: null, reasoning_effort: null, ...extra },
      },
    })
    const session = parseCodexSession([
      sessionMeta(),
      turnContext(),
      userMessage("review it"),
      namespacedFunctionCall("call-1", "spawn_agent", { task_name: "reviewer", message: "review the diff" }),
      activity("call-1", "started", { model: "gpt-6.1-sol", reasoning_effort: "xhigh" }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:04.100Z",
        payload: { type: "function_call_output", call_id: "call-1", output: "{\"task_name\":\"/root/reviewer\"}" },
      }),
      activity("subagent-completed-1", "completed"),
    ].join("\n"))

    const [agent] = session.turns[0].subAgentActivity
    expect(session.turns[0].subAgentActivity).toHaveLength(1)
    expect(agent).toMatchObject({
      agentId: "thread-7",
      agentName: "reviewer",
      parentToolUseId: "call-1",
      model: "gpt-6.1-sol",
      effort: "xhigh",
      status: "completed",
      prompt: "review the diff",
    })
  })
})

describe("createCodexPromptReader", () => {
  const userItem = (text: string) => ({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  })
  const echo = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } })
  const reply = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } }

  function prompts(records: object[]): string[] {
    const read = createCodexPromptReader()
    return records.map(read).filter(Boolean)
  }

  it("reads prompts a current rollout writes only as response items, skipping injected context", () => {
    expect(prompts([
      userItem("# AGENTS.md instructions for /proj\n\n<INSTRUCTIONS>x</INSTRUCTIONS>"),
      userItem("<environment_context>\n  <cwd>/proj</cwd>\n</environment_context>"),
      userItem("first"),
      reply,
      userItem("second"),
    ])).toEqual(["first", "second"])
  })

  it("skips an older rollout's echo but keeps a prompt repeated in a later turn", () => {
    expect(prompts([
      userItem("<environment_context></environment_context>"),
      userItem("continue"),
      echo("continue"),
      reply,
      userItem("continue"),
      echo("continue"),
    ])).toEqual(["continue", "continue"])
  })

  it("pairs an echo with its prompt even when their text differs", () => {
    expect(prompts([userItem("<image name=[Image #1]>\n</image>\nlook"), echo("look")]))
      .toEqual(["<image name=[Image #1]>\n</image>\nlook"])
  })

  it("reads a prompt written only as an event", () => {
    expect(prompts([echo("hello"), reply, echo("again")])).toEqual(["hello", "again"])
  })
})
