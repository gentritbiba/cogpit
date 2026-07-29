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
})

describe("resolveClaudeCliPath", () => {
  const binName = process.platform === "win32" ? "claude.exe" : "claude"
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const devResolve = (id: string) => `/Users/me/app/node_modules/${id}`
  const asarResolve = (id: string) =>
    `/Applications/Cogpit.app/Contents/Resources/app.asar/node_modules/${id}`
  const unpackedBin = `/Applications/Cogpit.app/Contents/Resources/app.asar.unpacked/node_modules/${platformPkg}/${binName}`
  const installedBin = `/usr/local/bin/${binName}`
  /** No CLI on PATH — the pre-existing vendored-binary behavior. */
  const noneOnPath = { findOnPath: () => undefined, readVersion: () => undefined }

  it("returns undefined outside asar so the SDK resolves its own native binary", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    expect(resolveClaudeCliPath(devResolve, noneOnPath)).toBeUndefined()
  })

  it("rewrites app.asar paths to app.asar.unpacked", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    expect(resolveClaudeCliPath(asarResolve, noneOnPath)).toBe(unpackedBin)
  })

  it("rewrites app.asar paths that use Windows separators", async () => {
    // Regression: the rewrite matched "/app.asar/" only, so the packaged
    // Windows app tried to spawn the CLI from inside the archive.
    const root = "C:\\Users\\me\\AppData\\Local\\Programs\\Cogpit\\resources"
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(
      (id) => `${root}\\app.asar\\node_modules\\${id.replace(/\//g, "\\")}`,
      noneOnPath,
    )
    expect(result).toBe(
      `${root}\\app.asar.unpacked\\node_modules\\@anthropic-ai\\${platformPkg.split("/")[1]}\\${binName}`,
    )
  })

  it("returns undefined when the platform package cannot be resolved", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(() => {
      throw new Error("Cannot find module")
    }, noneOnPath)
    expect(result).toBeUndefined()
  })

  it("prefers the installed CLI when it is newer than the vendored binary", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(devResolve, {
      findOnPath: () => installedBin,
      readVersion: (bin) => (bin === installedBin ? [2, 1, 220] : [2, 1, 215]),
    })
    expect(result).toBe(installedBin)
  })

  it("prefers the installed CLI when it matches the vendored version", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(devResolve, {
      findOnPath: () => installedBin,
      readVersion: () => [2, 1, 215],
    })
    expect(result).toBe(installedBin)
  })

  it("falls back to the vendored binary when the installed CLI is older", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(devResolve, {
      findOnPath: () => installedBin,
      readVersion: (bin) => (bin === installedBin ? [2, 0, 9] : [2, 1, 215]),
    })
    expect(result).toBeUndefined()
  })

  it("falls back to the unpacked binary when the installed CLI is older, inside asar", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(asarResolve, {
      findOnPath: () => installedBin,
      readVersion: (bin) => (bin === installedBin ? [2, 0, 9] : [2, 1, 215]),
    })
    expect(result).toBe(unpackedBin)
  })

  it("ignores an installed CLI that will not report a version", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(devResolve, {
      findOnPath: () => installedBin,
      readVersion: (bin) => (bin === installedBin ? undefined : [2, 1, 215]),
    })
    expect(result).toBeUndefined()
  })

  it("uses the installed CLI when the vendored binary has no readable version", async () => {
    const { resolveClaudeCliPath } = await loadModule()
    const result = resolveClaudeCliPath(devResolve, {
      findOnPath: () => installedBin,
      readVersion: (bin) => (bin === installedBin ? [2, 1, 220] : undefined),
    })
    expect(result).toBe(installedBin)
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
