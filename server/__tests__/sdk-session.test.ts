// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Tests for the Claude Agent SDK session lifecycle, with a focus on
 * confirming that when the user changes `effort` / `model` / `mcpConfig`
 * between turns (or mid-turn), the NEXT spawned query actually picks
 * up the new values.
 *
 * We mock `@anthropic-ai/claude-agent-sdk`'s `query` so we can capture
 * the Options object each time the SDK is invoked.
 */

// ── Query mock ──────────────────────────────────────────────────────
// Capture every call to `query` with its options, and expose a Query
// handle whose lifecycle we can drive manually.

interface CapturedCall {
  options: { model?: string; effort?: string; mcpServers?: unknown; stderr?: (data: string) => void }
  // Resolves once the session finishes its turn (emits a `result` msg
  // and closes the iterator). Used to wait between turns in tests.
  completed: Promise<void>
}

const captured: CapturedCall[] = []

let applyFlagSettingsSpy: ReturnType<typeof vi.fn> | null = null
let setModelSpy: ReturnType<typeof vi.fn> | null = null

// When set, the next query's generator yields these messages instead of the
// default one-assistant-one-result exchange.
let scriptedMessages: unknown[] | null = null

// When set, the next query emits this stderr (via the options.stderr callback)
// and then throws scriptedError, modeling a CLI spawn/exit failure.
let scriptedStderr: string | null = null
let scriptedError: Error | null = null

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: (args: { prompt: unknown; options: CapturedCall["options"] }) => {
      let resolveCompleted: () => void = () => {}
      const completed = new Promise<void>((r) => {
        resolveCompleted = r
      })
      captured.push({ options: args.options, completed })

      // Build an async generator that yields one assistant msg, one result,
      // then closes. This models a normal one-turn exchange.
      applyFlagSettingsSpy = vi.fn().mockResolvedValue(undefined)
      setModelSpy = vi.fn().mockResolvedValue(undefined)

      async function* gen() {
        if (scriptedError) {
          if (scriptedStderr) args.options.stderr?.(scriptedStderr)
          const err = scriptedError
          resolveCompleted()
          throw err
        }
        const msgs = scriptedMessages ?? [
          { type: "assistant", message: { content: [] } },
          { type: "result", is_error: false },
        ]
        for (const m of msgs) yield m
        resolveCompleted()
      }
      const iter = gen() as AsyncGenerator<unknown> & {
        applyFlagSettings?: typeof applyFlagSettingsSpy
        setModel?: typeof setModelSpy
        streamInput: typeof vi.fn
        interrupt: typeof vi.fn
      }
      iter.applyFlagSettings = applyFlagSettingsSpy
      iter.setModel = setModelSpy
      iter.streamInput = vi.fn().mockResolvedValue(undefined)
      iter.interrupt = vi.fn().mockResolvedValue(undefined)
      return iter
    },
  }
})

// subagentWatcher pulls in fs — stub it out
vi.mock("../subagentWatcher", () => ({
  watchSubagents: () => ({ close: () => {} }),
}))

// Stream bus — spy on the wiring without exercising the real throttling
vi.mock("../lib/streamBus", () => ({
  publish: vi.fn(),
  publishCompleteMessage: vi.fn(),
  completeMessage: vi.fn(),
  clear: vi.fn(),
  getSnapshot: vi.fn(() => null),
  subscribe: vi.fn(() => () => {}),
}))

// Lazy import after mocks are in place
async function loadModule() {
  return await import("../sdk-session")
}

// Wait for a condition to be true. The mock generator runs synchronously
// in the same microtask, so one awaited tick is usually enough.
async function waitUntil(cond: () => boolean, maxTicks = 50) {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return
    await Promise.resolve()
  }
  throw new Error("waitUntil timed out")
}

beforeEach(() => {
  captured.length = 0
  applyFlagSettingsSpy = null
  setModelSpy = null
  scriptedMessages = null
  scriptedStderr = null
  scriptedError = null
  vi.clearAllMocks()
})

afterEach(async () => {
  const { cleanupAllSDKSessions } = await loadModule()
  cleanupAllSDKSessions()
})

describe("resolveClaudeCliPath", () => {
  const binName = process.platform === "win32" ? "claude.exe" : "claude"
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`

  it("returns undefined outside asar so the SDK resolves its own native binary", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(
      (id) => `/Users/me/app/node_modules/${id}`,
    )
    expect(result).toBeUndefined()
  })

  it("rewrites app.asar paths to app.asar.unpacked", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(
      (id) => `/Applications/Cogpit.app/Contents/Resources/app.asar/node_modules/${id}`,
    )
    expect(result).toBe(
      `/Applications/Cogpit.app/Contents/Resources/app.asar.unpacked/node_modules/${platformPkg}/${binName}`,
    )
  })

  it("returns undefined when the platform package cannot be resolved", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(() => {
      throw new Error("Cannot find module")
    })
    expect(result).toBeUndefined()
  })
})

describe("sdk-session error reporting", () => {
  it("appends captured CLI stderr to the error result", async () => {
    const { createSDKSession } = await loadModule()
    scriptedStderr = "claude: error while loading shared libraries: libfoo.so: cannot open"
    scriptedError = new Error("Claude Code process exited with code 1")

    const state = createSDKSession({
      sessionId: "err1",
      cwd: "/tmp",
      message: "hi",
    })
    let result: Record<string, unknown> | null = null
    state.onResult = (msg) => { result = msg }

    await waitUntil(() => result !== null)
    expect(result!.is_error).toBe(true)
    expect(String(result!.result)).toContain("exited with code 1")
    expect(String(result!.result)).toContain("libfoo.so: cannot open")
  })

  it("does not duplicate stderr already present in the error message", async () => {
    const { createSDKSession } = await loadModule()
    scriptedStderr = "boom"
    scriptedError = new Error("failed: boom")

    const state = createSDKSession({
      sessionId: "err2",
      cwd: "/tmp",
      message: "hi",
    })
    let result: Record<string, unknown> | null = null
    state.onResult = (msg) => { result = msg }

    await waitUntil(() => result !== null)
    expect(String(result!.result)).toBe("Error: failed: boom")
  })
})

describe("sdk-session effort propagation", () => {
  it("createSDKSession passes the initial effort to the first query", async () => {
    const { createSDKSession } = await loadModule()
    createSDKSession({
      sessionId: "s1",
      cwd: "/tmp",
      message: "hi",
      effort: "low",
    })
    await waitUntil(() => captured.length === 1)
    expect(captured[0].options.effort).toBe("low")
  })

  it("resumeSDKSession with a new effort starts the next query with the new effort", async () => {
    const { createSDKSession, resumeSDKSession } = await loadModule()

    createSDKSession({
      sessionId: "s2",
      cwd: "/tmp",
      message: "first",
      effort: "low",
    })
    await waitUntil(() => captured.length === 1)
    expect(captured[0].options.effort).toBe("low")

    // Let the first turn finish before the next "user prompt"
    await captured[0].completed
    await Promise.resolve()

    resumeSDKSession({
      sessionId: "s2",
      cwd: "/tmp",
      message: "second",
      effort: "high",
    })
    await waitUntil(() => captured.length === 2)
    expect(captured[1].options.effort).toBe("high")
  })

  it("sendSDKMessage during a running turn updates state.effort so the NEXT restart uses it", async () => {
    // Regression: prior to the fix, streamInput mid-turn would never
    // record the user's new effort, so if the Query was ever restarted
    // for the same session (after finishing the current turn), it would
    // still use the stale effort.
    const { createSDKSession, sendSDKMessage, sdkSessions } = await loadModule()

    createSDKSession({
      sessionId: "s3",
      cwd: "/tmp",
      message: "first",
      effort: "low",
    })
    await waitUntil(() => captured.length === 1)

    // Simulate the frontend posting a follow-up message WITH a new effort
    // while state.running is still true (mid-turn).
    sendSDKMessage("s3", "follow-up", undefined, { effort: "high" })

    const state = sdkSessions.get("s3")
    expect(state?.effort).toBe("high")
  })

  it("sendSDKMessage during a running turn calls applyFlagSettings to update effort live", async () => {
    const { createSDKSession, sendSDKMessage } = await loadModule()

    createSDKSession({
      sessionId: "s4",
      cwd: "/tmp",
      message: "first",
      effort: "low",
    })
    await waitUntil(() => captured.length === 1)
    expect(applyFlagSettingsSpy).not.toBeNull()

    sendSDKMessage("s4", "follow-up", undefined, { effort: "high" })

    // Give the mid-turn update a tick to dispatch
    await Promise.resolve()
    await Promise.resolve()

    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ effortLevel: "high" }),
    )
  })

  it("sendSDKMessage during a running turn calls setModel when the model changes", async () => {
    const { createSDKSession, sendSDKMessage } = await loadModule()

    createSDKSession({
      sessionId: "s5",
      cwd: "/tmp",
      message: "first",
      model: "claude-sonnet-4-6",
    })
    await waitUntil(() => captured.length === 1)
    expect(setModelSpy).not.toBeNull()

    sendSDKMessage("s5", "follow-up", undefined, { model: "claude-opus-4-7" })

    await Promise.resolve()
    await Promise.resolve()

    expect(setModelSpy).toHaveBeenCalledWith("claude-opus-4-7")
  })
})

describe("sdk-session stream bus wiring", () => {
  async function loadStreamBusMock() {
    return await import("../lib/streamBus")
  }

  it("enables includePartialMessages and forwardSubagentText on queries", async () => {
    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "st1", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)

    const opts = captured[0].options as Record<string, unknown>
    expect(opts.includePartialMessages).toBe(true)
    expect(opts.forwardSubagentText).toBe(true)
  })

  it("publishes stream_event messages to the bus with their parent_tool_use_id", async () => {
    const streamBus = await loadStreamBusMock()
    const rawEvent = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }
    scriptedMessages = [
      { type: "stream_event", event: rawEvent, parent_tool_use_id: null },
      { type: "stream_event", event: rawEvent, parent_tool_use_id: "toolu_42" },
      { type: "result", is_error: false },
    ]

    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "st2", cwd: "/tmp", message: "hi" })
    await waitUntil(() => vi.mocked(streamBus.publish).mock.calls.length >= 2)

    expect(streamBus.publish).toHaveBeenCalledWith("st2", rawEvent, null)
    expect(streamBus.publish).toHaveBeenCalledWith("st2", rawEvent, "toolu_42")
  })

  it("calls completeMessage when the complete assistant message arrives", async () => {
    const streamBus = await loadStreamBusMock()
    scriptedMessages = [
      { type: "assistant", message: { id: "msg_abc", content: [] } },
      { type: "result", is_error: false },
    ]

    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "st3", cwd: "/tmp", message: "hi" })
    await waitUntil(() => vi.mocked(streamBus.completeMessage).mock.calls.length >= 1)

    expect(streamBus.completeMessage).toHaveBeenCalledWith("st3", "msg_abc")
  })

  it("clears the bus when the turn produces a result", async () => {
    const streamBus = await loadStreamBusMock()
    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "st4", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)
    await captured[0].completed
    await waitUntil(() => vi.mocked(streamBus.clear).mock.calls.length >= 1)

    expect(streamBus.clear).toHaveBeenCalledWith("st4")
  })

  it("publishes forwarded subagent messages as complete bus messages", async () => {
    const streamBus = await loadStreamBusMock()
    scriptedMessages = [
      {
        type: "assistant",
        message: {
          id: "msg_sub",
          content: [
            { type: "thinking", thinking: "let me look" },
            { type: "text", text: "subagent says hi" },
          ],
        },
        parent_tool_use_id: "toolu_parent",
      },
      { type: "result", is_error: false },
    ]

    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "st6", cwd: "/tmp", message: "hi" })
    await waitUntil(() => vi.mocked(streamBus.publishCompleteMessage).mock.calls.length >= 1)

    expect(streamBus.publishCompleteMessage).toHaveBeenCalledWith("st6", {
      messageId: "msg_sub",
      parentToolUseId: "toolu_parent",
      blocks: [
        { blockType: "thinking", text: "let me look" },
        { blockType: "text", text: "subagent says hi" },
      ],
    })
    // Subagent messages must NOT be treated as main-thread completions
    expect(streamBus.completeMessage).not.toHaveBeenCalledWith("st6", "msg_sub")
  })

  it("does not register subagent Task calls in pendingTaskCalls (forwardSubagentText)", async () => {
    const taskBlock = { type: "tool_use", name: "Task", id: "toolu_main", input: { prompt: "main task" } }
    const subagentTaskBlock = { type: "tool_use", name: "Task", id: "toolu_nested", input: { prompt: "nested task" } }
    scriptedMessages = [
      // Main-thread assistant message — registers
      { type: "assistant", message: { id: "msg_1", content: [taskBlock] } },
      // Subagent's own assistant message — must NOT register
      { type: "assistant", message: { id: "msg_2", content: [subagentTaskBlock] }, parent_tool_use_id: "toolu_main" },
      { type: "result", is_error: false },
    ]

    const { createSDKSession } = await loadModule()
    const state = createSDKSession({ sessionId: "st5", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)
    await captured[0].completed
    await waitUntil(() => state.pendingTaskCalls.size >= 1)

    expect(state.pendingTaskCalls.has("toolu_main")).toBe(true)
    expect(state.pendingTaskCalls.has("toolu_nested")).toBe(false)
  })
})
