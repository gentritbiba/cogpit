import { describe, it, expect } from "vitest"
import { parseCodexSession, isCodexSessionText, extractCodexMetadataFromLines, parseApplyPatch } from "@/lib/codex"

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

function userMessage(text: string, timestamp = "2024-01-01T00:00:02.000Z"): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: { type: "user_message", message: text },
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

function functionCallOutput(callId: string, output: string, timestamp = "2024-01-01T00:00:04.000Z"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp,
    payload: { type: "function_call_output", call_id: callId, output },
  })
}

function tokenCount(inputTokens: number, outputTokens: number, timestamp = "2024-01-01T00:00:05.000Z"): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
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

// ── isCodexSessionText ─────────────────────────────────────────────────────

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
})
