// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
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
  prompt: unknown
  options: {
    model?: string
    effort?: string
    resume?: string
    settings?: unknown
    mcpServers?: unknown
    stderr?: (data: string) => void
    canUseTool?: (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID: string; signal?: AbortSignal },
    ) => Promise<unknown>
    onElicitation?: (
      request: Record<string, unknown>,
      options: { signal: AbortSignal; requestId: string },
    ) => Promise<unknown>
    onUserDialog?: (
      request: { dialogKind: string; payload: Record<string, unknown>; toolUseID?: string },
      options: { signal: AbortSignal; requestId: string },
    ) => Promise<unknown>
    supportedDialogKinds?: string[]
    env?: NodeJS.ProcessEnv
    plugins?: { type: string; path: string }[]
    systemPrompt?: { type: string; preset: string; append?: string }
    hooks?: { PreToolUse?: { matcher?: string; hooks: unknown[] }[] }
  }
  // Resolves once the session finishes its turn (emits a `result` msg
  // and closes the iterator). Used to wait between turns in tests.
  completed: Promise<void>
}

const captured: CapturedCall[] = []

let applyFlagSettingsSpy: ReturnType<typeof vi.fn> | null = null
let setModelSpy: ReturnType<typeof vi.fn> | null = null
let setPermissionModeSpy: ReturnType<typeof vi.fn> | null = null
let setMcpServersSpy: ReturnType<typeof vi.fn> | null = null
let streamInputSpy: ReturnType<typeof vi.fn> | null = null

// When set, the next query's generator yields these messages instead of the
// default one-assistant-one-result exchange.
let scriptedMessages: unknown[] | null = null

// When set, the next query emits this stderr (via the options.stderr callback)
// and then throws scriptedError, modeling a CLI spawn/exit failure.
let scriptedStderr: string | null = null
let scriptedError: Error | null = null
let holdQueryOpen = false
let releaseHeldQuery: (() => void) | null = null
let holdQueryAfterMessages = false
let releaseQueryAfterMessages: (() => void) | null = null

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: (args: { prompt: unknown; options: CapturedCall["options"] }) => {
      let resolveCompleted: () => void = () => {}
      const completed = new Promise<void>((r) => {
        resolveCompleted = r
      })
      captured.push({ prompt: args.prompt, options: args.options, completed })

      // Build an async generator that yields one assistant msg, one result,
      // then closes. This models a normal one-turn exchange.
      applyFlagSettingsSpy = vi.fn().mockResolvedValue(undefined)
      setModelSpy = vi.fn().mockResolvedValue(undefined)
      setPermissionModeSpy = vi.fn().mockResolvedValue(undefined)
      setMcpServersSpy = vi.fn().mockResolvedValue({ added: [], removed: [], errors: {} })
      streamInputSpy = vi.fn().mockResolvedValue(undefined)

      async function* gen() {
        if (holdQueryOpen) {
          await new Promise<void>((resolve) => { releaseHeldQuery = resolve })
        }
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
        if (holdQueryAfterMessages) {
          await new Promise<void>((resolve) => { releaseQueryAfterMessages = resolve })
        }
        resolveCompleted()
      }
      const iter = gen() as AsyncGenerator<unknown> & {
        applyFlagSettings?: typeof applyFlagSettingsSpy
        setModel?: typeof setModelSpy
        streamInput: ReturnType<typeof vi.fn>
        interrupt: ReturnType<typeof vi.fn>
        setPermissionMode: ReturnType<typeof vi.fn>
        setMcpServers: ReturnType<typeof vi.fn>
        stopTask: ReturnType<typeof vi.fn>
        backgroundTasks: ReturnType<typeof vi.fn>
        rewindFiles: ReturnType<typeof vi.fn>
        close: ReturnType<typeof vi.fn>
      }
      iter.applyFlagSettings = applyFlagSettingsSpy
      iter.setModel = setModelSpy
      iter.streamInput = streamInputSpy
      iter.interrupt = vi.fn().mockResolvedValue(undefined)
      iter.setPermissionMode = setPermissionModeSpy
      iter.setMcpServers = setMcpServersSpy
      iter.stopTask = vi.fn().mockResolvedValue(undefined)
      iter.backgroundTasks = vi.fn().mockResolvedValue(true)
      iter.rewindFiles = vi.fn().mockResolvedValue({ canRewind: true })
      iter.close = vi.fn()
      return iter
    },
  }
})

// subagentWatcher pulls in fs — stub it out
vi.mock("../subagentWatcher", () => ({
  watchSubagents: vi.fn(() => ({ close: vi.fn() })),
}))

// Stream bus — spy on the wiring without exercising the real throttling
vi.mock("../lib/streamBus", () => ({
  publish: vi.fn(),
  publishCompleteMessage: vi.fn(),
  completeMessage: vi.fn(),
  publishError: vi.fn(),
  publishAgentProgress: vi.fn(),
  publishPromptSuggestion: vi.fn(),
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

// The query env is built from the managed browser tree, so every test in this
// file reads a temp one rather than the developer's.
let browserRoot = ""
let previousBrowserHome: string | undefined

beforeEach(() => {
  previousBrowserHome = process.env.COGPIT_BROWSER_HOME
  browserRoot = mkdtempSync(join(tmpdir(), "cogpit-sdk-browser-"))
  process.env.COGPIT_BROWSER_HOME = join(browserRoot, "browser")
  captured.length = 0
  applyFlagSettingsSpy = null
  setModelSpy = null
  setPermissionModeSpy = null
  setMcpServersSpy = null
  streamInputSpy = null
  scriptedMessages = null
  scriptedStderr = null
  scriptedError = null
  holdQueryOpen = false
  releaseHeldQuery = null
  holdQueryAfterMessages = false
  releaseQueryAfterMessages = null
  vi.clearAllMocks()
})

afterEach(async () => {
  const { cleanupAllSDKSessions } = await loadModule()
  cleanupAllSDKSessions()
  if (previousBrowserHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousBrowserHome
  rmSync(browserRoot, { recursive: true, force: true })
})

describe("sdk-session browser support", () => {
  it("puts the shim first on PATH and loads the browser plugin", async () => {
    const { binDir, pluginDir } = await import("../browser/paths")
    const { ensureShim } = await import("../browser/shim")
    const { ensurePlugin } = await import("../browser/skill")
    ensureShim("/usr/local/bin/agent-browser")
    ensurePlugin()

    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "browser-env", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)

    const { env, plugins } = captured[0].options
    expect(env!.PATH!.split(delimiter)[0]).toBe(binDir())
    expect(env!.COGPIT_SESSION_ID).toBe("browser-env")
    expect(plugins).toEqual([{ type: "local", path: pluginDir() }])
  })

  it("tells every agent about the panel and hooks a subagent's browser calls", async () => {
    const { BROWSER_CONTEXT_APPEND, BROWSER_HOOK_TOOL, browserPreToolUseHook } =
      await import("../browser/agentContext")
    const { ensureShim } = await import("../browser/shim")
    ensureShim("/usr/local/bin/agent-browser")

    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "browser-context", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)

    const { systemPrompt, hooks } = captured[0].options
    expect(systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: BROWSER_CONTEXT_APPEND })
    expect(hooks!.PreToolUse).toEqual([{ matcher: BROWSER_HOOK_TOOL, hooks: [browserPreToolUseHook] }])
  })

  it("leaves PATH and plugins alone when the browser tree is not installed", async () => {
    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "browser-absent", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)

    const { env, plugins, systemPrompt, hooks } = captured[0].options
    expect(env!.PATH).toBe(process.env.PATH)
    expect(env!.COGPIT_SESSION_ID).toBe("browser-absent")
    expect(plugins).toBeUndefined()
    expect(systemPrompt).toBeUndefined()
    expect(hooks).toBeUndefined()
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

describe("sdk-session AskUserQuestion handling", () => {
  it("resolves the blocked tool with answers keyed by question text", async () => {
    const { createSDKSession, resolveUserQuestion, sdkSessions } = await loadModule()
    createSDKSession({ sessionId: "question-1", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)

    const input = {
      questions: [{ question: "Which option?", options: [{ label: "A" }, { label: "B" }] }],
    }
    const resultPromise = captured[0].options.canUseTool!("AskUserQuestion", input, {
      toolUseID: "tool-question-1",
    })

    expect(sdkSessions.get("question-1")?.pendingUserQuestions.size).toBe(1)
    expect(resolveUserQuestion("question-1", "tool-question-1", { "Which option?": "B" }))
      .toEqual({ found: true })
    await expect(resultPromise).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which option?": "B" } },
    })
    expect(sdkSessions.get("question-1")?.pendingUserQuestions.size).toBe(0)
  })

  it("exposes blocked questions for a dashboard, stripping option previews", async () => {
    const { createSDKSession, getSDKUserQuestions, listUserQuestionSessionIds } = await loadModule()
    createSDKSession({ sessionId: "question-list", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)

    void captured[0].options.canUseTool!("AskUserQuestion", {
      questions: [{
        question: "Pick a layout",
        header: "Layout",
        multiSelect: true,
        options: [
          { label: "Grid", description: "Cards in a grid", preview: "x".repeat(5000) },
          { label: "List", description: "One per row" },
          { label: "" },
        ],
      }],
    }, { toolUseID: "tool-list-1" })

    expect(listUserQuestionSessionIds()).toContain("question-list")
    const [pending] = getSDKUserQuestions("question-list")
    expect(pending.toolUseId).toBe("tool-list-1")
    expect(pending.askedAt).toBeGreaterThan(0)
    expect(pending.questions).toEqual([{
      question: "Pick a layout",
      header: "Layout",
      multiSelect: true,
      options: [
        // The preview itself is dropped: it can run to kilobytes and this list
        // is polled app-wide. Only its existence survives.
        { label: "Grid", description: "Cards in a grid", hasPreview: true },
        { label: "List", description: "One per row", hasPreview: false },
      ],
    }])
  })

  it("reports no blocked questions for an unknown session", async () => {
    const { getSDKUserQuestions } = await loadModule()
    expect(getSDKUserQuestions("nope")).toEqual([])
  })

  it("registers canUseTool in bypassPermissions mode and still blocks AskUserQuestion", async () => {
    // Regression: canUseTool used to be omitted in bypass mode, so the CLI
    // errored AskUserQuestion instantly ("Answer questions?") and the
    // dashboard showed a dead question bar that swallowed all input.
    const { createSDKSession, resolveUserQuestion, sdkSessions } = await loadModule()
    createSDKSession({
      sessionId: "question-bypass",
      cwd: "/tmp",
      message: "hi",
      permissionMode: "bypassPermissions",
    })
    await waitUntil(() => captured.length === 1)

    expect(captured[0].options.canUseTool).toBeDefined()

    const input = {
      questions: [{ question: "Which option?", options: [{ label: "A" }, { label: "B" }] }],
    }
    const resultPromise = captured[0].options.canUseTool!("AskUserQuestion", input, {
      toolUseID: "tool-question-bypass",
    })

    expect(sdkSessions.get("question-bypass")?.pendingUserQuestions.size).toBe(1)
    expect(resolveUserQuestion("question-bypass", "tool-question-bypass", { "Which option?": "A" }))
      .toEqual({ found: true })
    await expect(resultPromise).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which option?": "A" } },
    })
  })

  it("auto-allows regular tools via canUseTool in bypassPermissions mode", async () => {
    const { createSDKSession, sdkSessions } = await loadModule()
    createSDKSession({
      sessionId: "bypass-regular",
      cwd: "/tmp",
      message: "hi",
      permissionMode: "bypassPermissions",
    })
    await waitUntil(() => captured.length === 1)

    const input = { command: "ls" }
    await expect(captured[0].options.canUseTool!("Bash", input, { toolUseID: "tool-bash-1" }))
      .resolves.toEqual({ behavior: "allow", updatedInput: input })
    // Must not queue a visible permission request in bypass mode
    expect(sdkSessions.get("bypass-regular")?.pendingPermissions.size).toBe(0)
  })
})

describe("sdk-session turn completion", () => {
  it("settles a parked onResult when the query ends without emitting a result", async () => {
    // Regression: a query can end without ever yielding a `result` message —
    // Query.close() (used by teardownState/stopSDKSession) ends the iterator
    // cleanly rather than throwing. The finally block cleared `running` but
    // left `onResult` parked, so the HTTP response held open by
    // /api/send-message never ended and the composer stayed "connected"
    // forever.
    const { createSDKSession, sdkSessions } = await loadModule()
    scriptedMessages = [{ type: "assistant", message: { content: [] } }]
    holdQueryAfterMessages = true

    createSDKSession({ sessionId: "no-result", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)
    await waitUntil(() => releaseQueryAfterMessages !== null)

    // Model the send-message route parking the HTTP response on onResult.
    let result: Record<string, unknown> | null = null
    sdkSessions.get("no-result")!.onResult = (msg) => { result = msg }

    releaseQueryAfterMessages!()

    await waitUntil(() => result !== null)
    expect(result!.type).toBe("result")
    expect(result!.is_error).toBe(true)
    expect(sdkSessions.get("no-result")?.running).toBe(false)
    expect(sdkSessions.get("no-result")?.onResult).toBeNull()
  })
})

describe("sdk-session send resilience", () => {
  it("restarts the turn instead of enqueueing into an aborted query", async () => {
    // Regression: the SDK aborts the whole query when a transport write fails
    // (dead CLI), but activeQuery/messageStream stay set until runQuery's
    // finally runs. Sending in that window enqueued into a stream nobody reads
    // — the route answered HTTP 200 and the message vanished, which is why a
    // session "just stops" after a couple of messages.
    const { createSDKSession, sendSDKMessage, sdkSessions } = await loadModule()
    holdQueryAfterMessages = true

    createSDKSession({ sessionId: "aborted-send", cwd: "/tmp", message: "one" })
    await waitUntil(() => captured.length === 1)

    const state = sdkSessions.get("aborted-send")!
    expect(state.activeQuery).not.toBeNull()
    expect(state.messageStream).not.toBeNull()

    // Model the SDK aborting the query after a failed write to a dead process.
    state.abort!.abort()

    sendSDKMessage("aborted-send", "two", undefined, {})

    await waitUntil(() => captured.length === 2)
    expect(captured[1].options.resume).toBe("aborted-send")
  })

  it("carries session-scoped tool grants across a resume", async () => {
    // Losing "always allow" grants on resume makes the new process re-prompt
    // for tools the user already approved; an unanswered prompt blocks the
    // turn forever, which reads as the session stalling.
    const { createSDKSession, resumeSDKSession, sdkSessions } = await loadModule()
    createSDKSession({ sessionId: "grants", cwd: "/tmp", message: "one" })
    await waitUntil(() => captured.length === 1)
    sdkSessions.get("grants")!.sessionAllowedTools.add("Bash")

    resumeSDKSession({ sessionId: "grants", cwd: "/tmp", message: "two" })
    await waitUntil(() => captured.length === 2)

    expect(sdkSessions.get("grants")!.sessionAllowedTools.has("Bash")).toBe(true)
  })

  it("does not wipe the live stream when a superseded query finishes", async () => {
    // resumeSDKSession replaces the state under the same session id. The old
    // state's finally still runs later and used to streamBus.clear() that id,
    // blanking the NEW query's streaming overlay mid-turn.
    const streamBus = await import("../lib/streamBus")
    const { createSDKSession, resumeSDKSession, sdkSessions } = await loadModule()
    holdQueryAfterMessages = true

    createSDKSession({ sessionId: "superseded", cwd: "/tmp", message: "one" })
    await waitUntil(() => captured.length === 1)
    await waitUntil(() => releaseQueryAfterMessages !== null)
    const releaseFirst = releaseQueryAfterMessages!
    releaseQueryAfterMessages = null
    const superseded = sdkSessions.get("superseded")!

    // Keep the replacement query parked too, so the only clear() that could
    // land in the assertion window is the superseded state's own finally.
    const fresh = resumeSDKSession({ sessionId: "superseded", cwd: "/tmp", message: "two" })
    await waitUntil(() => captured.length === 2)
    await waitUntil(() => releaseQueryAfterMessages !== null)
    expect(sdkSessions.get("superseded")).toBe(fresh)
    expect(superseded).not.toBe(fresh)

    // Settling onResult is unconditional in the finally, so it is a reliable
    // marker that the superseded query's cleanup actually ran.
    let finallyRan = false
    superseded.onResult = () => { finallyRan = true }

    vi.mocked(streamBus.clear).mockClear()
    releaseFirst()
    await waitUntil(() => finallyRan)

    expect(streamBus.clear).not.toHaveBeenCalled()
  })
})

describe("sdk-session silent turn failures", () => {
  it("reports a failed turn over the stream bus when no HTTP response is waiting", async () => {
    // The enqueue path (every message after the first on a live query) answers
    // 200 the moment the message is queued and parks no onResult, so a turn
    // that failed afterwards was dropped on the floor: no error, no new turn.
    const streamBus = await import("../lib/streamBus")
    const { createSDKSession } = await loadModule()
    scriptedMessages = [{ type: "result", is_error: true, result: "CLI exited with code 1" }]

    createSDKSession({ sessionId: "silent-fail", cwd: "/tmp", message: "hi" })

    await waitUntil(() => vi.mocked(streamBus.publishError).mock.calls.length > 0)
    const [sessionId, message] = vi.mocked(streamBus.publishError).mock.calls[0]
    expect(sessionId).toBe("silent-fail")
    expect(String(message)).toContain("CLI exited with code 1")
  })

  it("reports a thrown query error over the stream bus when nothing is listening", async () => {
    const streamBus = await import("../lib/streamBus")
    const { createSDKSession } = await loadModule()
    scriptedError = new Error("spawn failed")

    createSDKSession({ sessionId: "thrown-fail", cwd: "/tmp", message: "hi" })

    await waitUntil(() => vi.mocked(streamBus.publishError).mock.calls.length > 0)
    expect(String(vi.mocked(streamBus.publishError).mock.calls[0][1])).toContain("spawn failed")
  })

  it("does not duplicate the error when an HTTP response is already waiting", async () => {
    const streamBus = await import("../lib/streamBus")
    const { createSDKSession, sdkSessions } = await loadModule()
    holdQueryOpen = true
    scriptedMessages = [{ type: "result", is_error: true, result: "boom" }]

    createSDKSession({ sessionId: "http-waiting", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)

    let delivered: Record<string, unknown> | null = null
    sdkSessions.get("http-waiting")!.onResult = (msg) => { delivered = msg }
    releaseHeldQuery!()

    await waitUntil(() => delivered !== null)
    expect(delivered!.is_error).toBe(true)
    expect(streamBus.publishError).not.toHaveBeenCalled()
  })
})

describe("sdk-session progress summaries and prompt suggestions", () => {
  it("asks the CLI for subagent progress summaries and prompt suggestions", async () => {
    const { createSDKSession } = await loadModule()
    createSDKSession({ sessionId: "opts", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)

    const options = captured[0].options as Record<string, unknown>
    expect(options.agentProgressSummaries).toBe(true)
    expect(options.promptSuggestions).toBe(true)
  })

  it("publishes a subagent progress summary keyed by its tool_use id", async () => {
    const streamBus = await import("../lib/streamBus")
    const { createSDKSession } = await loadModule()
    scriptedMessages = [
      {
        type: "system",
        subtype: "task_progress",
        task_id: "task_1",
        tool_use_id: "toolu_7",
        description: "Explore the auth module",
        usage: { total_tokens: 10, tool_uses: 1, duration_ms: 30_000 },
        summary: "Analyzing authentication module",
      },
      { type: "result", is_error: false },
    ]

    createSDKSession({ sessionId: "progress", cwd: "/tmp", message: "hi" })

    await waitUntil(() => vi.mocked(streamBus.publishAgentProgress).mock.calls.length > 0)
    expect(vi.mocked(streamBus.publishAgentProgress).mock.calls[0]).toEqual([
      "progress",
      "toolu_7",
      "Analyzing authentication module",
    ])
  })

  it("ignores a task_progress event with no summary yet", async () => {
    // The first ~30s of a subagent run emit progress with no summary; there is
    // nothing to show, and publishing an empty one would blank a good summary.
    const streamBus = await import("../lib/streamBus")
    const { createSDKSession } = await loadModule()
    scriptedMessages = [
      {
        type: "system",
        subtype: "task_progress",
        task_id: "task_1",
        tool_use_id: "toolu_7",
        description: "Explore the auth module",
        usage: { total_tokens: 10, tool_uses: 1, duration_ms: 1_000 },
      },
      { type: "result", is_error: false },
    ]

    createSDKSession({ sessionId: "progress-empty", cwd: "/tmp", message: "hi" })

    await waitUntil(() => captured.length === 1)
    await captured[0].completed
    expect(streamBus.publishAgentProgress).not.toHaveBeenCalled()
  })

  it("publishes a prompt suggestion that arrives after the result message", async () => {
    // The suggestion is emitted after `result`, at which point processSDKEvent
    // has already cleared the bus for this session. Iteration must continue
    // past `result` and the publish must still reach a live subscriber.
    const streamBus = await import("../lib/streamBus")
    const { createSDKSession } = await loadModule()
    scriptedMessages = [
      { type: "result", is_error: false },
      { type: "prompt_suggestion", suggestion: "Run the tests", uuid: "u1", session_id: "suggest" },
    ]

    createSDKSession({ sessionId: "suggest", cwd: "/tmp", message: "hi" })

    await waitUntil(() => vi.mocked(streamBus.publishPromptSuggestion).mock.calls.length > 0)
    expect(vi.mocked(streamBus.publishPromptSuggestion).mock.calls[0]).toEqual([
      "suggest",
      "Run the tests",
    ])
  })
})

describe("sdk-session subagent watcher lifecycle", () => {
  it("does not attach a watcher after a query has already completed", async () => {
    const watcherModule = await import("../subagentWatcher")
    const watchSubagents = vi.mocked(watcherModule.watchSubagents)
    const { attachSubagentWatcher, createSDKSession } = await loadModule()
    const state = createSDKSession({ sessionId: "watch-late", cwd: "/tmp", message: "hi" })

    await captured[0].completed
    await waitUntil(() => !state.running)
    state.jsonlPath = "/tmp/watch-late.jsonl"
    attachSubagentWatcher(state)

    expect(watchSubagents).not.toHaveBeenCalled()
    expect(state.subagentWatcher).toBeNull()
  })

  it("closes the watcher on natural completion and reattaches for the next query", async () => {
    const watcherModule = await import("../subagentWatcher")
    const watchSubagents = vi.mocked(watcherModule.watchSubagents)
    const firstClose = vi.fn()
    const secondClose = vi.fn()
    watchSubagents
      .mockReturnValueOnce({ close: firstClose })
      .mockReturnValueOnce({ close: secondClose })

    const { createSDKSession, sendSDKMessage } = await loadModule()
    const state = createSDKSession({ sessionId: "watch-repeat", cwd: "/tmp", message: "first" })
    await captured[0].completed
    await waitUntil(() => !state.running)
    state.jsonlPath = "/tmp/watch-repeat.jsonl"

    sendSDKMessage("watch-repeat", "second")
    expect(state.subagentWatcher).not.toBeNull()
    await captured[1].completed
    await waitUntil(() => state.subagentWatcher === null)
    expect(firstClose).toHaveBeenCalledTimes(1)

    sendSDKMessage("watch-repeat", "third")
    expect(state.subagentWatcher).not.toBeNull()
    await captured[2].completed
    await waitUntil(() => state.subagentWatcher === null)
    expect(secondClose).toHaveBeenCalledTimes(1)
    expect(watchSubagents).toHaveBeenCalledTimes(2)
  })

  it("closes an active watcher when the session is explicitly stopped", async () => {
    holdQueryOpen = true
    const watcherModule = await import("../subagentWatcher")
    const watchSubagents = vi.mocked(watcherModule.watchSubagents)
    const close = vi.fn()
    watchSubagents.mockReturnValueOnce({ close })

    const { attachSubagentWatcher, createSDKSession, sdkSessions, stopSDKSession } = await loadModule()
    const state = createSDKSession({ sessionId: "watch-stop", cwd: "/tmp", message: "hi" })
    state.jsonlPath = "/tmp/watch-stop.jsonl"
    attachSubagentWatcher(state)

    expect(stopSDKSession("watch-stop")).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(sdkSessions.has("watch-stop")).toBe(false)
    releaseHeldQuery?.()
  })
})

describe("sdk-session effort propagation", () => {
  it("queues follow-ups on one persistent input stream instead of starting or closing another query", async () => {
    holdQueryAfterMessages = true
    const { createSDKSession, sendSDKMessage } = await loadModule()
    const state = createSDKSession({
      sessionId: "persistent-input",
      cwd: "/tmp",
      message: "first",
      ultracode: true,
    })
    await waitUntil(() => captured.length === 1)
    await waitUntil(() => !state.running)

    // A turn result was emitted, but the SDK query remains alive because a
    // background workflow can continue beyond that boundary.
    expect(state.activeQuery).not.toBeNull()

    const input = captured[0].prompt as AsyncIterable<Record<string, unknown>>
    const messages = input[Symbol.asyncIterator]()
    const first = await messages.next()

    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({
      type: "user",
      message: { content: [{ type: "text", text: "first" }] },
    })

    sendSDKMessage("persistent-input", "follow-up")
    const second = await messages.next()

    expect(second.done).toBe(false)
    expect(second.value).toMatchObject({
      type: "user",
      message: { content: [{ type: "text", text: "follow-up" }] },
    })
    expect(captured).toHaveLength(1)
    expect(streamInputSpy).not.toHaveBeenCalled()

    state.messageStream?.close()
    releaseQueryAfterMessages?.()
  })

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

  it("sendSDKMessage applies Max live — applyFlagSettings accepts it session-scoped", async () => {
    const { createSDKSession, sendSDKMessage } = await loadModule()

    createSDKSession({
      sessionId: "s4-max",
      cwd: "/tmp",
      message: "first",
      effort: "high",
    })
    await waitUntil(() => captured.length === 1)

    sendSDKMessage("s4-max", "follow-up", undefined, { effort: "max" })

    await Promise.resolve()
    await Promise.resolve()

    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ effortLevel: "max" }),
    )
  })

  it("updateSDKSession applies Max live instead of staging it for the next resume", async () => {
    const { createSDKSession, updateSDKSession } = await loadModule()

    createSDKSession({
      sessionId: "live-max",
      cwd: "/tmp",
      message: "first",
      effort: "high",
    })
    await waitUntil(() => captured.length === 1)

    const result = await updateSDKSession("live-max", { effort: "max" })

    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ effortLevel: "max" }),
    )
    expect(result.appliedLive).toContain("effortLevel")
  })

  it("clears the effort override live when the user picks the provider default", async () => {
    const { createSDKSession, updateSDKSession } = await loadModule()

    createSDKSession({
      sessionId: "live-default-effort",
      cwd: "/tmp",
      message: "first",
      effort: "max",
    })
    await waitUntil(() => captured.length === 1)

    await updateSDKSession("live-default-effort", { effort: "" })

    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ effortLevel: null }),
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

  it("ultracode at creation forces xhigh effort and injects the ultracode setting", async () => {
    const { createSDKSession } = await loadModule()

    createSDKSession({
      sessionId: "u1",
      cwd: "/tmp",
      message: "first",
      effort: "low",
      ultracode: true,
    })
    await waitUntil(() => captured.length === 1)

    // effort is pinned to xhigh regardless of the selected "low"
    expect(captured[0].options.effort).toBe("xhigh")
    // ultracode is supplied via the settings layer, with workflows enabled
    expect(captured[0].options.settings).toEqual(
      expect.objectContaining({ ultracode: true, enableWorkflows: true }),
    )
  })

  it("non-ultracode sessions do not inject the ultracode setting", async () => {
    const { createSDKSession } = await loadModule()

    createSDKSession({
      sessionId: "u2",
      cwd: "/tmp",
      message: "first",
      effort: "high",
    })
    await waitUntil(() => captured.length === 1)

    expect(captured[0].options.effort).toBe("high")
    expect(captured[0].options.settings).toBeUndefined()
  })

  it("passes Fast as an independent Claude session setting", async () => {
    const { createSDKSession } = await loadModule()
    createSDKSession({
      sessionId: "fast-1",
      cwd: "/tmp",
      message: "first",
      effort: "low",
      fastMode: true,
    })
    await waitUntil(() => captured.length === 1)

    expect(captured[0].options.effort).toBe("low")
    expect(captured[0].options.settings).toEqual(expect.objectContaining({ fastMode: true }))
  })

  it("applies Fast and Auto live without restarting the query", async () => {
    const { createSDKSession, updateSDKSession, sdkSessions } = await loadModule()
    createSDKSession({ sessionId: "live-settings", cwd: "/tmp", message: "first" })
    await waitUntil(() => captured.length === 1)

    const result = await updateSDKSession("live-settings", {
      fastMode: true,
      permissionMode: "auto",
    })

    expect(sdkSessions.get("live-settings")?.fastMode).toBe(true)
    expect(sdkSessions.get("live-settings")?.permissionMode).toBe("auto")
    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(expect.objectContaining({ fastMode: true }))
    expect(setPermissionModeSpy).toHaveBeenCalledWith("auto")
    expect(result.found).toBe(true)
  })

  it("applies Ultracode through live settings and pins effort to xhigh", async () => {
    const { createSDKSession, updateSDKSession, sdkSessions } = await loadModule()
    createSDKSession({
      sessionId: "live-ultracode",
      cwd: "/tmp",
      message: "first",
      effort: "high",
    })
    await waitUntil(() => captured.length === 1)

    const result = await updateSDKSession("live-ultracode", { ultracode: true })

    expect(sdkSessions.get("live-ultracode")?.ultracode).toBe(true)
    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(expect.objectContaining({
      ultracode: true,
      enableWorkflows: true,
      effortLevel: "xhigh",
    }))
    expect(result.appliedLive).toEqual(expect.arrayContaining([
      "ultracode",
      "enableWorkflows",
      "effortLevel",
    ]))
  })

  it("applies scoped tool rules and clears MCP servers live", async () => {
    const { createSDKSession, updateSDKSession } = await loadModule()
    createSDKSession({
      sessionId: "live-permissions",
      cwd: "/tmp",
      message: "first",
      mcpConfig: JSON.stringify({ local: { command: "test" } }),
    })
    await waitUntil(() => captured.length === 1)

    const result = await updateSDKSession("live-permissions", {
      allowedTools: ["Bash(git status)"],
      disallowedTools: ["Bash(rm *)"],
      mcpConfig: null,
    })

    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(expect.objectContaining({
      permissions: {
        allow: ["Bash(git status)"],
        deny: ["Bash(rm *)"],
        defaultMode: "default",
      },
    }))
    expect(setMcpServersSpy).toHaveBeenCalledWith({})
    expect(result.appliedLive).toEqual(expect.arrayContaining(["permissions", "mcpConfig"]))
  })

  it("enabling ultracode mid-turn applies the flag and pins effort to xhigh live", async () => {
    const { createSDKSession, sendSDKMessage, sdkSessions } = await loadModule()

    createSDKSession({
      sessionId: "u3",
      cwd: "/tmp",
      message: "first",
      effort: "low",
    })
    await waitUntil(() => captured.length === 1)
    expect(applyFlagSettingsSpy).not.toBeNull()

    sendSDKMessage("u3", "follow-up", undefined, { ultracode: true })

    await Promise.resolve()
    await Promise.resolve()

    expect(sdkSessions.get("u3")?.ultracode).toBe(true)
    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ultracode: true }),
    )
    // effort jumps to xhigh because ultracode pins it
    expect(applyFlagSettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ effortLevel: "xhigh" }),
    )
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

  it("registers nested subagent Task calls so agents deeper than one level resolve", async () => {
    // Claude Code 2.1.219 raised the default spawn depth from 1 to 3. A depth-2
    // agent's opening prompt matches a Task call made INSIDE another subagent,
    // so that call has to be a candidate or the nested agent can never bind to
    // a parent and its transcript is dropped.
    const taskBlock = { type: "tool_use", name: "Task", id: "toolu_main", input: { prompt: "main task" } }
    const subagentTaskBlock = { type: "tool_use", name: "Task", id: "toolu_nested", input: { prompt: "nested task" } }
    scriptedMessages = [
      { type: "assistant", message: { id: "msg_1", content: [taskBlock] } },
      { type: "assistant", message: { id: "msg_2", content: [subagentTaskBlock] }, parent_tool_use_id: "toolu_main" },
      { type: "result", is_error: false },
    ]

    const { createSDKSession } = await loadModule()
    const state = createSDKSession({ sessionId: "st5", cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)
    await captured[0].completed
    await waitUntil(() => state.pendingTaskCalls.size >= 2)

    expect(state.pendingTaskCalls.get("toolu_main")).toBe("main task")
    expect(state.pendingTaskCalls.get("toolu_nested")).toBe("nested task")
  })

  it("still publishes subagent text to the bus while registering its nested Task calls", async () => {
    // Registering must not cost the live-transcript publish, nor start treating
    // a subagent message as a main-thread completion.
    const nested = { type: "tool_use", name: "Agent", id: "toolu_nested2", input: { prompt: "deep task" } }
    const text = { type: "text", text: "spawning a helper" }
    scriptedMessages = [
      { type: "assistant", message: { id: "msg_s", content: [text, nested] }, parent_tool_use_id: "toolu_p" },
      { type: "result", is_error: false },
    ]

    const streamBus = await import("../lib/streamBus")
    const { createSDKSession } = await loadModule()
    const state = createSDKSession({ sessionId: "st7", cwd: "/tmp", message: "hi" })
    await waitUntil(() => vi.mocked(streamBus.publishCompleteMessage).mock.calls.length >= 1)

    expect(streamBus.publishCompleteMessage).toHaveBeenCalledWith("st7", {
      messageId: "msg_s",
      parentToolUseId: "toolu_p",
      blocks: [{ blockType: "text", text: "spawning a helper" }],
    })
    expect(streamBus.completeMessage).not.toHaveBeenCalledWith("st7", "msg_s")
    await waitUntil(() => state.pendingTaskCalls.has("toolu_nested2"))
  })
})

describe("sdk-session mid-turn permission mode change", () => {
  function addPending(
    state: { pendingPermissions: Map<string, unknown> },
    requestId: string,
    toolName: string,
  ) {
    const resolve = vi.fn()
    state.pendingPermissions.set(requestId, {
      requestId,
      toolName,
      input: { file_path: "/tmp/x" },
      toolUseId: requestId,
      timestamp: Date.now(),
      resolve,
    })
    return resolve
  }

  it("switching to bypassPermissions auto-allows every pending approval", async () => {
    const { createSDKSession, updateSDKSession, sdkSessions } = await loadModule()
    holdQueryOpen = true
    createSDKSession({ sessionId: "perm-live-1", cwd: "/tmp", message: "first" })
    await waitUntil(() => captured.length === 1)

    const state = sdkSessions.get("perm-live-1")!
    const bashResolve = addPending(state, "req-bash", "Bash")
    const editResolve = addPending(state, "req-edit", "Edit")

    await updateSDKSession("perm-live-1", { permissionMode: "bypassPermissions" })

    expect(bashResolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }))
    expect(editResolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }))
    expect(state.pendingPermissions.size).toBe(0)
    expect(setPermissionModeSpy).toHaveBeenCalledWith("bypassPermissions")
    releaseHeldQuery?.()
  })

  it("switching to acceptEdits auto-allows only pending edit approvals", async () => {
    const { createSDKSession, updateSDKSession, sdkSessions } = await loadModule()
    holdQueryOpen = true
    createSDKSession({ sessionId: "perm-live-2", cwd: "/tmp", message: "first" })
    await waitUntil(() => captured.length === 1)

    const state = sdkSessions.get("perm-live-2")!
    const bashResolve = addPending(state, "req-bash", "Bash")
    const writeResolve = addPending(state, "req-write", "Write")

    await updateSDKSession("perm-live-2", { permissionMode: "acceptEdits" })

    expect(writeResolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }))
    expect(bashResolve).not.toHaveBeenCalled()
    expect(state.pendingPermissions.size).toBe(1)
    expect(state.pendingPermissions.has("req-bash")).toBe(true)
    releaseHeldQuery?.()
  })

  it("an unrelated mode change leaves pending approvals untouched", async () => {
    const { createSDKSession, updateSDKSession, sdkSessions } = await loadModule()
    holdQueryOpen = true
    createSDKSession({ sessionId: "perm-live-3", cwd: "/tmp", message: "first" })
    await waitUntil(() => captured.length === 1)

    const state = sdkSessions.get("perm-live-3")!
    const bashResolve = addPending(state, "req-bash", "Bash")

    await updateSDKSession("perm-live-3", { permissionMode: "plan" })

    expect(bashResolve).not.toHaveBeenCalled()
    expect(state.pendingPermissions.size).toBe(1)
    releaseHeldQuery?.()
  })
})

describe("sdk-session MCP elicitation handling", () => {
  /** Start a live session whose query is held open, and return its onElicitation. */
  async function startSession(sessionId: string) {
    const mod = await loadModule()
    holdQueryOpen = true
    mod.createSDKSession({ sessionId, cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)
    return { mod, options: captured[0].options }
  }

  it("parks a form elicitation until the UI answers it", async () => {
    const { mod, options } = await startSession("elicit-form")
    const controller = new AbortController()

    const pending = options.onElicitation!({
      serverName: "github",
      message: "Enter your access token",
      mode: "form",
      title: "GitHub",
      requestedSchema: {
        type: "object",
        properties: {
          token: { type: "string", title: "Token", description: "A classic PAT" },
          scope: { type: "string", enum: ["repo", "gist"] },
          remember: { type: "boolean", default: true },
        },
        required: ["token"],
      },
    }, { signal: controller.signal, requestId: "req-form-1" })

    expect(mod.sdkSessions.get("elicit-form")?.pendingElicitations.size).toBe(1)
    expect(mod.listAgentPromptSessionIds()).toContain("elicit-form")
    const [parked] = mod.getSDKElicitations("elicit-form")
    expect(parked.requestId).toBe("req-form-1")
    expect(parked.serverName).toBe("github")
    expect(parked.mode).toBe("form")
    expect(parked.askedAt).toBeGreaterThan(0)
    expect(parked.fields).toEqual([
      { name: "token", label: "Token", type: "string", required: true, description: "A classic PAT" },
      {
        name: "scope",
        label: "scope",
        type: "enum",
        required: false,
        options: [{ value: "repo", label: "repo" }, { value: "gist", label: "gist" }],
      },
      { name: "remember", label: "remember", type: "boolean", required: false, defaultValue: true },
    ])

    expect(mod.resolveElicitation("elicit-form", "req-form-1", {
      action: "accept",
      content: { token: "ghp_x", scope: "repo", remember: false },
    })).toEqual({ found: true })
    await expect(pending).resolves.toEqual({
      action: "accept",
      content: { token: "ghp_x", scope: "repo", remember: false },
    })
    expect(mod.sdkSessions.get("elicit-form")?.pendingElicitations.size).toBe(0)
    releaseHeldQuery?.()
  })

  it("parks a url elicitation with the link to open", async () => {
    const { mod, options } = await startSession("elicit-url")
    const controller = new AbortController()

    const pending = options.onElicitation!({
      serverName: "linear",
      message: "Authorize Cogpit in your browser",
      mode: "url",
      url: "https://linear.app/oauth/authorize?x=1",
      elicitationId: "elic-9",
    }, { signal: controller.signal, requestId: "req-url-1" })

    const [parked] = mod.getSDKElicitations("elicit-url")
    expect(parked).toMatchObject({
      requestId: "req-url-1",
      mode: "url",
      url: "https://linear.app/oauth/authorize?x=1",
      fields: [],
    })

    expect(mod.resolveElicitation("elicit-url", "req-url-1", { action: "accept" }))
      .toEqual({ found: true })
    await expect(pending).resolves.toEqual({ action: "accept" })
    releaseHeldQuery?.()
  })

  it("declines a parked elicitation when the request aborts", async () => {
    const { mod, options } = await startSession("elicit-abort")
    const controller = new AbortController()

    const pending = options.onElicitation!(
      { serverName: "github", message: "Token?" },
      { signal: controller.signal, requestId: "req-abort-1" },
    )
    expect(mod.sdkSessions.get("elicit-abort")?.pendingElicitations.size).toBe(1)

    controller.abort()

    await expect(pending).resolves.toEqual({ action: "decline" })
    expect(mod.sdkSessions.get("elicit-abort")?.pendingElicitations.size).toBe(0)
    releaseHeldQuery?.()
  })

  it("declines a schema it cannot render instead of parking it forever", async () => {
    const streamBus = await import("../lib/streamBus")
    const { mod, options } = await startSession("elicit-rich")
    const controller = new AbortController()

    const pending = options.onElicitation!({
      serverName: "jira",
      message: "Configure the board",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { filters: { type: "array", items: { type: "string" } } },
      },
    }, { signal: controller.signal, requestId: "req-rich-1" })

    await expect(pending).resolves.toEqual({ action: "decline" })
    expect(mod.sdkSessions.get("elicit-rich")?.pendingElicitations.size).toBe(0)
    // A silent decline is the bug this handler exists to remove: say why.
    expect(streamBus.publishError).toHaveBeenCalledWith(
      "elicit-rich",
      expect.stringContaining("jira"),
    )
    expect(vi.mocked(streamBus.publishError).mock.calls[0][1]).toContain("filters")
    releaseHeldQuery?.()
  })

  it("refuses an answer whose content is not primitive form values", async () => {
    const { mod, options } = await startSession("elicit-bad")
    const controller = new AbortController()

    void options.onElicitation!(
      { serverName: "github", message: "Token?" },
      { signal: controller.signal, requestId: "req-bad-1" },
    )

    expect(mod.resolveElicitation("elicit-bad", "req-bad-1", {
      action: "accept",
      content: { nested: { deep: true } } as never,
    })).toEqual({ found: false })
    expect(mod.sdkSessions.get("elicit-bad")?.pendingElicitations.size).toBe(1)
    releaseHeldQuery?.()
  })

  it("reports nothing pending for an unknown session or request", async () => {
    const { mod } = await startSession("elicit-none")
    expect(mod.getSDKElicitations("nope")).toEqual([])
    expect(mod.resolveElicitation("nope", "req-x", { action: "decline" })).toEqual({ found: false })
    expect(mod.resolveElicitation("elicit-none", "req-x", { action: "decline" }))
      .toEqual({ found: false })
    releaseHeldQuery?.()
  })

  it("cancels parked elicitations when the session is stopped", async () => {
    const { mod, options } = await startSession("elicit-stop")
    const controller = new AbortController()

    const pending = options.onElicitation!(
      { serverName: "github", message: "Token?" },
      { signal: controller.signal, requestId: "req-stop-1" },
    )

    mod.stopSDKSession("elicit-stop")

    await expect(pending).resolves.toEqual({ action: "cancel" })
    releaseHeldQuery?.()
  })
})

describe("sdk-session user dialogs", () => {
  async function startSession(sessionId: string) {
    const mod = await loadModule()
    holdQueryOpen = true
    mod.createSDKSession({ sessionId, cwd: "/tmp", message: "hi" })
    await waitUntil(() => captured.length === 1)
    return { mod, options: captured[0].options }
  }

  it("declares only the dialog kinds the UI renders, alongside the callback", async () => {
    const { options } = await startSession("dialog-opts")
    // A non-empty list without onUserDialog throws at option intake, and a kind
    // Cogpit cannot render would be routed to a surface that drops it.
    expect(options.supportedDialogKinds).toEqual(["refusal_fallback_prompt"])
    expect(options.onUserDialog).toBeDefined()
    releaseHeldQuery?.()
  })

  it("parks a refusal fallback dialog until the user chooses", async () => {
    const { mod, options } = await startSession("dialog-refusal")
    const controller = new AbortController()

    const pending = options.onUserDialog!({
      dialogKind: "refusal_fallback_prompt",
      payload: {
        originalModel: "claude-opus-5",
        fallbackModel: "claude-opus-4-8",
        guidanceText: "Try a narrower request",
        retractedMessageUuids: ["uuid-1"],
      },
    }, { signal: controller.signal, requestId: "dlg-1" })

    expect(mod.listAgentPromptSessionIds()).toContain("dialog-refusal")
    expect(mod.getSDKUserDialogs("dialog-refusal")).toEqual([{
      sessionId: "dialog-refusal",
      requestId: "dlg-1",
      dialogKind: "refusal_fallback_prompt",
      askedAt: expect.any(Number),
      originalModel: "claude-opus-5",
      fallbackModel: "claude-opus-4-8",
      guidanceText: "Try a narrower request",
    }])

    expect(mod.resolveUserDialog("dialog-refusal", "dlg-1", "retry_fallback"))
      .toEqual({ found: true })
    await expect(pending).resolves.toEqual({
      behavior: "completed",
      result: "retry_fallback",
    })
    expect(mod.getSDKUserDialogs("dialog-refusal")).toEqual([])
    releaseHeldQuery?.()
  })

  it("answers a dismissed dialog with cancelled so the CLI applies its default", async () => {
    const { mod, options } = await startSession("dialog-dismiss")
    const controller = new AbortController()

    const pending = options.onUserDialog!({
      dialogKind: "refusal_fallback_prompt",
      payload: { originalModel: "a", fallbackModel: "b" },
    }, { signal: controller.signal, requestId: "dlg-2" })

    expect(mod.resolveUserDialog("dialog-dismiss", "dlg-2", "cancelled")).toEqual({ found: true })
    await expect(pending).resolves.toEqual({ behavior: "cancelled" })
    releaseHeldQuery?.()
  })

  it("rejects a choice the dialog kind does not define", async () => {
    const { mod, options } = await startSession("dialog-bad-choice")
    const controller = new AbortController()

    void options.onUserDialog!({
      dialogKind: "refusal_fallback_prompt",
      payload: { originalModel: "a", fallbackModel: "b" },
    }, { signal: controller.signal, requestId: "dlg-3" })

    expect(mod.resolveUserDialog("dialog-bad-choice", "dlg-3", "explode" as never))
      .toEqual({ found: false })
    expect(mod.getSDKUserDialogs("dialog-bad-choice")).toHaveLength(1)
    releaseHeldQuery?.()
  })

  it("leaves an undeclared dialog kind unanswered instead of settling it", async () => {
    // On a multi-client session the request reaches every attached client, so
    // answering "cancelled" here would dismiss a dialog another client declared
    // and is rendering. Returning null sends no answer; the CLI cancels it at
    // its own deadline. (sdk.d.ts, SDKControlRequestUserDialogRequest.dialog_kind)
    const { mod, options } = await startSession("dialog-unknown")
    const controller = new AbortController()

    const pending = options.onUserDialog!({
      dialogKind: "some_future_prompt",
      payload: { anything: true },
    }, { signal: controller.signal, requestId: "dlg-4" })

    await expect(pending).resolves.toBeNull()
    expect(mod.getSDKUserDialogs("dialog-unknown")).toEqual([])
    releaseHeldQuery?.()
  })

  it("cancels a declared dialog kind whose payload it cannot read", async () => {
    // This kind IS declared, so Cogpit owns it: settling as cancelled makes the
    // CLI apply the dialog's default rather than wait out the park deadline.
    const { mod, options } = await startSession("dialog-malformed")
    const controller = new AbortController()

    const pending = options.onUserDialog!({
      dialogKind: "refusal_fallback_prompt",
      payload: { originalModel: 42 },
    }, { signal: controller.signal, requestId: "dlg-6" })

    await expect(pending).resolves.toEqual({ behavior: "cancelled" })
    expect(mod.getSDKUserDialogs("dialog-malformed")).toEqual([])
    releaseHeldQuery?.()
  })

  it("cancels a parked dialog when the request aborts", async () => {
    const { mod, options } = await startSession("dialog-abort")
    const controller = new AbortController()

    const pending = options.onUserDialog!({
      dialogKind: "refusal_fallback_prompt",
      payload: { originalModel: "a", fallbackModel: "b" },
    }, { signal: controller.signal, requestId: "dlg-5" })

    controller.abort()

    await expect(pending).resolves.toEqual({ behavior: "cancelled" })
    expect(mod.getSDKUserDialogs("dialog-abort")).toEqual([])
    releaseHeldQuery?.()
  })
})
