import { describe, expect, it } from "vitest"
import {
  extractCopilotMetadataFromLines,
  isCopilotSessionText,
  parseCopilotSession,
} from "../../../shared/session/copilot"
import { detectPendingInteraction, parseSession, parseSessionAppend } from "../../../shared/session/parser"
import { formatForText } from "../../../shared/session/agents"

interface EventOptions {
  id?: string
  timestamp?: string
  agentId?: string
}

function event(
  type: string,
  data: Record<string, unknown> = {},
  options: EventOptions = {},
): string {
  return JSON.stringify({
    type,
    data,
    id: options.id ?? `${type}-id`,
    timestamp: options.timestamp ?? "2026-08-01T12:00:00.000Z",
    ...(options.agentId ? { agentId: options.agentId } : {}),
  })
}

function sessionStart(): string {
  return event("session.start", {
    sessionId: "copilot-session",
    copilotVersion: "1.0.81",
    selectedModel: "claude-sonnet-4.5",
    context: { cwd: "/workspace/project", branch: "main" },
  })
}

describe("Copilot session detection and metadata", () => {
  it("detects Copilot JSONL through the shared parser and provider registry", () => {
    const text = ["{partial", sessionStart()].join("\n")

    expect(isCopilotSessionText(text)).toBe(true)
    expect(parseSession(text).agentKind).toBe("copilot")
    expect(formatForText(text).kind).toBe("copilot")
    expect(isCopilotSessionText(JSON.stringify({ type: "user", message: {} }))).toBe(false)
  })

  it("extracts root-session metadata and ignores nested agent events", () => {
    const lines = [
      sessionStart(),
      event("user.message", { content: "First prompt" }, {
        timestamp: "2026-08-01T12:00:01.000Z",
      }),
      event("user.message", { content: "Nested prompt" }, {
        timestamp: "2026-08-01T12:00:02.000Z",
        agentId: "subagent-1",
      }),
      event("session.model_change", { newModel: "gpt-5" }),
      event("session.title_changed", { title: "Ship Copilot support" }),
      event("user.message", { content: "Last prompt" }, {
        timestamp: "2026-08-01T12:00:03.000Z",
      }),
      event("session.usage_checkpoint", {
        totalNanoAiu: 123,
        totalPremiumRequests: 1,
      }, { timestamp: "2026-08-01T12:00:04.000Z" }),
    ]

    expect(extractCopilotMetadataFromLines(lines)).toEqual({
      sessionId: "copilot-session",
      version: "1.0.81",
      gitBranch: "main",
      cwd: "/workspace/project",
      model: "gpt-5",
      slug: "",
      name: "Ship Copilot support",
      firstUserMessage: "First prompt",
      lastUserMessage: "Last prompt",
      timestamp: "2026-08-01T12:00:01.000Z",
      lastTimestamp: "2026-08-01T12:00:04.000Z",
      turnCount: 2,
      isSubagent: false,
      parentSessionId: null,
    })
  })
})

describe("parseCopilotSession", () => {
  it("restores persisted user and tool-result images from binary assets", () => {
    const text = [
      sessionStart(),
      event("session.binary_asset", {
        assetId: "sha256:image",
        byteLength: 3,
        data: "cG5n",
        mimeType: "image/png",
        type: "image",
      }),
      event("user.message", {
        content: "Check these images",
        attachments: [{
          type: "blob",
          assetId: "sha256:image",
          byteLength: 3,
          mimeType: "image/png",
          displayName: "input.png",
        }],
      }),
      event("tool.execution_start", {
        toolCallId: "image-tool",
        toolName: "view_image",
        arguments: { path: "/tmp/output.png" },
      }),
      event("tool.execution_complete", {
        toolCallId: "image-tool",
        success: true,
        result: {
          content: "",
          contents: [{ type: "image", data: "dGh1bWI=", mimeType: "image/webp" }],
          binaryResultsForLlm: [{
            type: "image",
            assetId: "sha256:image",
            byteLength: 3,
            mimeType: "image/png",
          }],
        },
      }),
    ].join("\n")

    const [turn] = parseCopilotSession(text).turns
    expect(turn.userMessage).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "cG5n" },
      },
      { type: "text", text: "Check these images" },
    ])
    expect(turn.toolCalls[0].resultImages).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/webp", data: "dGh1bWI=" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "cG5n" },
      },
    ])
  })

  it("parses reasoning, messages, tool execution, usage, and duration", () => {
    const text = [
      sessionStart(),
      event("user.message", { content: "List the files", turnId: "turn-1" }, {
        id: "user-event-1",
        timestamp: "2026-08-01T12:00:01.000Z",
      }),
      event("assistant.turn_start", { model: "claude-sonnet-4.5" }, {
        timestamp: "2026-08-01T12:00:01.200Z",
      }),
      event("assistant.reasoning", { content: "I should inspect the directory." }, {
        timestamp: "2026-08-01T12:00:02.000Z",
      }),
      event("assistant.message", {
        content: "I’ll check.",
        model: "claude-sonnet-4.5",
        toolRequests: [{
          toolCallId: "tool-1",
          name: "bash",
          arguments: { command: "ls" },
        }],
      }, { timestamp: "2026-08-01T12:00:02.500Z" }),
      event("tool.execution_start", {
        toolCallId: "tool-1",
        toolName: "bash",
        arguments: { command: "ls" },
      }, { timestamp: "2026-08-01T12:00:03.000Z" }),
      event("tool.execution_complete", {
        toolCallId: "tool-1",
        success: true,
        result: { detailedContent: "README.md\nsrc" },
      }, { timestamp: "2026-08-01T12:00:04.000Z" }),
      event("assistant.usage", {
        model: "claude-sonnet-4.5",
        reasoningEffort: "high",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 5,
        reasoningTokens: 4,
        duration: 250,
      }, { timestamp: "2026-08-01T12:00:04.500Z" }),
      event("assistant.message", { content: "Done." }, {
        timestamp: "2026-08-01T12:00:04.750Z",
      }),
      event("assistant.turn_end", {}, { timestamp: "2026-08-01T12:00:05.000Z" }),
    ].join("\n")

    const session = parseCopilotSession(text)

    expect(session.agentKind).toBe("copilot")
    expect(session.sessionId).toBe("copilot-session")
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0]).toMatchObject({
      id: "turn-1@user-event-1",
      userMessage: "List the files",
      assistantText: ["I’ll check.", "Done."],
      model: "claude-sonnet-4.5",
      effort: "high",
      durationMs: 4_000,
      tokenUsage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 30,
        output_tokens_details: { thinking_tokens: 4 },
      },
    })
    expect(session.turns[0].thinking[0].thinking).toBe("I should inspect the directory.")
    expect(session.turns[0].toolCalls).toEqual([{
      id: "tool-1",
      name: "Bash",
      input: { command: "ls" },
      result: "README.md\nsrc",
      isError: false,
      timestamp: "2026-08-01T12:00:03.000Z",
    }])
    expect(session.stats).toMatchObject({
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCacheCreationTokens: 5,
      totalCacheReadTokens: 30,
      totalDurationMs: 4_000,
      toolCallCounts: { Bash: 1 },
      errorCount: 0,
      turnCount: 1,
    })
  })

  it("normalizes ask_user calls for existing interaction detection", () => {
    const text = [
      sessionStart(),
      event("user.message", { content: "Ask me" }),
      event("tool.execution_start", {
        toolCallId: "question-1",
        toolName: "ask_user",
        arguments: {
          question: "Which option?",
          choices: ["A", { label: "B", description: "Second choice" }],
          multi_select: true,
        },
      }),
    ].join("\n")

    const session = parseCopilotSession(text)
    expect(session.turns[0].toolCalls[0]).toMatchObject({
      id: "question-1",
      name: "AskUserQuestion",
      input: {
        questions: [{
          question: "Which option?",
          options: [
            { label: "A" },
            { label: "B", description: "Second choice" },
          ],
          multiSelect: true,
        }],
      },
      result: null,
    })
    expect(detectPendingInteraction(session)).toEqual({
      type: "question",
      toolUseId: "question-1",
      questions: [{
        question: "Which option?",
        options: [
          { label: "A" },
          { label: "B", description: "Second choice" },
        ],
        multiSelect: true,
      }],
    })
  })

  it("normalizes built-in file tools to the shared Edit and Write shape", () => {
    const text = [
      sessionStart(),
      event("user.message", { content: "Update the files" }),
      event("tool.execution_start", {
        toolCallId: "edit-1",
        toolName: "edit",
        arguments: { path: "/workspace/project/a.ts", old_str: "old", new_str: "new" },
      }),
      event("tool.execution_start", {
        toolCallId: "create-1",
        toolName: "create",
        arguments: { path: "/workspace/project/b.ts", file_text: "created" },
      }),
    ].join("\n")

    expect(parseCopilotSession(text).turns[0].toolCalls).toEqual([
      expect.objectContaining({
        id: "edit-1",
        name: "Edit",
        input: expect.objectContaining({
          file_path: "/workspace/project/a.ts",
          old_string: "old",
          new_string: "new",
        }),
      }),
      expect.objectContaining({
        id: "create-1",
        name: "Write",
        input: expect.objectContaining({
          file_path: "/workspace/project/b.ts",
          content: "created",
        }),
      }),
    ])
  })

  it("parses the persisted model and usage shapes from a single-turn durable session", () => {
    const text = [
      event("session.start", {
        sessionId: "copilot-session",
        version: 1,
        copilotVersion: "1.0.82",
        selectedModel: "auto",
        context: { cwd: "/workspace/project", branch: "main" },
      }),
      event("session.auto_mode_resolved", { chosenModel: "claude-haiku-4.5" }),
      event("user.message", { content: "Hi", turnId: "0" }, {
        id: "user-event-0",
        timestamp: "2026-08-01T12:00:01.000Z",
      }),
      event("assistant.turn_start", { turnId: "0" }, {
        timestamp: "2026-08-01T12:00:01.100Z",
      }),
      event("assistant.message", {
        content: "Hello",
        model: "claude-haiku-4.5",
        reasoningText: "I should answer briefly.",
      }, {
        timestamp: "2026-08-01T12:00:03.000Z",
      }),
      event("assistant.turn_end", { turnId: "0" }, {
        timestamp: "2026-08-01T12:00:03.000Z",
      }),
      event("session.usage_checkpoint", {
        modelCacheState: [],
        promptCacheBreakState: [],
        totalNanoAiu: 123,
        totalPremiumRequests: 1,
      }, { timestamp: "2026-08-01T12:00:03.500Z" }),
      event("session.shutdown", {
        totalApiDurationMs: 2_753,
        currentModel: "claude-haiku-4.5",
        tokenDetails: {
          input: { tokenCount: 10 },
          cache_write: { tokenCount: 17_149 },
          output: { tokenCount: 60 },
        },
        modelMetrics: {
          "claude-haiku-4.5": {
            usage: {
              inputTokens: 17_159,
              outputTokens: 60,
              cacheReadTokens: 0,
              cacheWriteTokens: 17_149,
              reasoningTokens: 44,
            },
          },
        },
      }, { timestamp: "2026-08-01T12:00:04.000Z" }),
    ].join("\n")

    const session = parseCopilotSession(text)

    expect(session.model).toBe("claude-haiku-4.5")
    expect(session.turns[0]).toMatchObject({
      id: "0@user-event-0",
      model: "claude-haiku-4.5",
      assistantText: ["Hello"],
      durationMs: 2_000,
      tokenUsage: {
        input_tokens: 10,
        output_tokens: 60,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 17_149,
        output_tokens_details: { thinking_tokens: 44 },
      },
    })
    expect(session.turns[0].thinking[0].thinking).toBe("I should answer briefly.")
    expect(session.stats).toMatchObject({
      totalInputTokens: 10,
      totalOutputTokens: 60,
      totalCacheCreationTokens: 17_149,
      totalCacheReadTokens: 0,
    })
  })

  it("keeps resumed multi-turn shutdown usage aggregate-only", () => {
    const text = [
      event("session.start", {
        sessionId: "copilot-session",
        copilotVersion: "1.0.82",
        selectedModel: "claude-haiku-4.5",
        context: { cwd: "/workspace/project", branch: "main" },
      }),
      event("user.message", { content: "First", turnId: "0" }, {
        id: "user-event-first",
        timestamp: "2026-08-01T12:00:01.000Z",
      }),
      event("assistant.message", { content: "One", model: "claude-haiku-4.5" }, {
        timestamp: "2026-08-01T12:00:02.000Z",
      }),
      event("assistant.turn_end", {}, { timestamp: "2026-08-01T12:00:03.000Z" }),
      event("session.resume", {
        eventCount: 4,
        resumeTime: "2026-08-01T13:00:00.000Z",
        selectedModel: "claude-haiku-4.5",
        context: { cwd: "/workspace/project", branch: "main" },
      }, { timestamp: "2026-08-01T13:00:00.000Z" }),
      event("user.message", { content: "Second", turnId: "0" }, {
        id: "user-event-second",
        timestamp: "2026-08-01T13:00:01.000Z",
      }),
      event("assistant.message", { content: "Two", model: "claude-haiku-4.5" }, {
        timestamp: "2026-08-01T13:00:02.000Z",
      }),
      event("assistant.turn_end", {}, { timestamp: "2026-08-01T13:00:03.000Z" }),
      event("session.usage_checkpoint", {
        modelCacheState: [],
        promptCacheBreakState: [],
        totalNanoAiu: 456,
        totalPremiumRequests: 2,
      }, { timestamp: "2026-08-01T13:00:03.500Z" }),
      event("session.shutdown", {
        currentModel: "claude-haiku-4.5",
        modelMetrics: {
          "claude-haiku-4.5": {
            usage: {
              inputTokens: 250,
              outputTokens: 50,
              cacheReadTokens: 30,
              cacheWriteTokens: 20,
            },
          },
        },
      }, { timestamp: "2026-08-01T13:00:04.000Z" }),
    ].join("\n")

    const session = parseCopilotSession(text)

    expect(session.turns).toHaveLength(2)
    expect(session.turns.map((turn) => turn.id)).toEqual([
      "0@user-event-first",
      "0@user-event-second",
    ])
    expect(session.turns.map((turn) => turn.tokenUsage)).toEqual([null, null])
    expect(session.stats).toMatchObject({
      totalInputTokens: 200,
      totalOutputTokens: 50,
      totalCacheCreationTokens: 20,
      totalCacheReadTokens: 30,
    })
  })

  it("preserves nested events while ignoring unknown and malformed records", () => {
    const text = [
      sessionStart(),
      event("user.message", { content: "Root prompt" }),
      event("assistant.message", { content: "Nested response" }, { agentId: "subagent-1" }),
      event("tool.execution_start", {
        toolCallId: "nested-tool",
        toolName: "shell",
      }, { agentId: "subagent-1" }),
      event("assistant.future_event", { anything: true }),
      "{malformed",
      event("session.error", {
        errorType: "model",
        statusCode: 429,
        errorCode: "rate_limit",
        message: "Rate limited",
      }),
    ].join("\n")

    const session = parseCopilotSession(text)
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].assistantText).toEqual([])
    expect(session.turns[0].subAgentActivity).toEqual([
      expect.objectContaining({
        agentId: "subagent-1",
        text: ["Nested response"],
        toolCalls: [expect.objectContaining({ id: "nested-tool", name: "Bash" })],
      }),
    ])
    expect(session.turns[0].toolCalls).toEqual([expect.objectContaining({
      name: "Error",
      input: { errorType: "model", statusCode: 429, errorCode: "rate_limit" },
      result: "Rate limited",
      isError: true,
    })])
    expect(session.rawMessages).toHaveLength(6)
    expect(session.stats.errorCount).toBe(1)
  })

  it("parses Copilot subagent lifecycle, transcript, tools, usage, and completion", () => {
    const text = [
      sessionStart(),
      event("user.message", { content: "Inspect the package", turnId: "turn-1" }, {
        id: "user-event-1",
      }),
      event("tool.execution_start", {
        toolCallId: "parent-tool",
        toolName: "task",
        arguments: { agent: "explore", description: "Read package metadata" },
      }),
      event("subagent.started", {
        toolCallId: "parent-tool",
        agentName: "explore",
        agentDisplayName: "read-package-name",
        description: "Read package metadata",
        model: "claude-haiku-4.5",
        agentType: "explore",
        executionMode: "sync",
      }, { agentId: "agent-1" }),
      event("subagent.configured", {
        toolCallId: "parent-tool",
        agentName: "explore",
        model: "claude-haiku-4.5",
      }, { agentId: "agent-1" }),
      event("user.message", { content: "Read package.json" }, { agentId: "agent-1" }),
      event("assistant.reasoning", { content: "I should inspect the file." }, {
        agentId: "agent-1",
      }),
      event("tool.execution_start", {
        toolCallId: "nested-tool",
        toolName: "shell",
        arguments: { command: "cat package.json" },
      }, { agentId: "agent-1" }),
      event("tool.execution_complete", {
        toolCallId: "nested-tool",
        toolName: "shell",
        success: true,
        result: { content: "agent-window" },
      }, { agentId: "agent-1" }),
      event("assistant.message", {
        content: "The package is agent-window.",
        model: "claude-haiku-4.5",
      }, { agentId: "agent-1" }),
      event("assistant.usage", {
        inputTokens: 20,
        outputTokens: 5,
      }, { agentId: "agent-1" }),
      event("subagent.completed", {
        toolCallId: "parent-tool",
        agentName: "explore",
        agentDisplayName: "read-package-name",
        model: "claude-haiku-4.5",
        agentType: "explore",
        totalToolCalls: 1,
        totalTokens: 25,
        durationMs: 4_299,
      }, { agentId: "agent-1" }),
    ].join("\n")

    const [turn] = parseCopilotSession(text).turns
    expect(turn.subAgentActivity).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        parentToolUseId: "parent-tool",
        agentName: "read-package-name",
        subagentType: "explore",
        prompt: "Read package metadata",
        status: "completed",
        durationMs: 4_299,
        toolUseCount: 1,
        model: "claude-haiku-4.5",
        thinking: ["I should inspect the file."],
        text: ["The package is agent-window."],
        tokenUsage: expect.objectContaining({ input_tokens: 20, output_tokens: 5 }),
        toolCalls: [expect.objectContaining({
          id: "nested-tool",
          name: "Bash",
          result: "agent-window",
          isError: false,
        })],
      }),
    ])
    expect(turn.contentBlocks).toContainEqual(expect.objectContaining({
      kind: "sub_agent",
      messages: turn.subAgentActivity,
    }))
  })

  it("supports index-only parsing without retaining raw events or computing stats", () => {
    const text = [sessionStart(), event("user.message", { content: "Hello" })].join("\n")
    const session = parseCopilotSession(text, { skipStats: true })

    expect(session.turns).toHaveLength(1)
    expect(session.rawMessages).toEqual([])
    expect(session.stats.turnCount).toBe(1)
    expect(session.stats.totalInputTokens).toBe(0)
  })
})

describe("Copilot append parsing", () => {
  it("reparses an in-progress Copilot turn with completed tools", () => {
    const first = [
      sessionStart(),
      event("user.message", { content: "Run pwd", turnId: "turn-1" }),
      event("tool.execution_start", {
        toolCallId: "tool-1",
        toolName: "shell",
        arguments: { command: "pwd" },
      }),
    ].join("\n")
    const appended = [
      event("tool.execution_complete", {
        toolCallId: "tool-1",
        success: true,
        result: { content: "/workspace/project" },
      }),
      event("assistant.message", { content: "That is the project directory." }),
      event("assistant.turn_end"),
    ].join("\n")

    const initial = parseSession(first)
    const initialTurnId = initial.turns[0].id
    const session = parseSessionAppend(initial, appended)

    expect(session.agentKind).toBe("copilot")
    expect(session.rawMessages).toHaveLength(6)
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].id).toBe(initialTurnId)
    expect(session.turns[0].toolCalls).toEqual([expect.objectContaining({
      id: "tool-1",
      result: "/workspace/project",
      isError: false,
    })])
    expect(session.turns[0].assistantText).toEqual(["That is the project directory."])
  })
})
