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
  options: { model?: string; effort?: string; mcpServers?: unknown }
  // Resolves once the session finishes its turn (emits a `result` msg
  // and closes the iterator). Used to wait between turns in tests.
  completed: Promise<void>
}

const captured: CapturedCall[] = []

let applyFlagSettingsSpy: ReturnType<typeof vi.fn> | null = null
let setModelSpy: ReturnType<typeof vi.fn> | null = null

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
        yield { type: "assistant", message: { content: [] } }
        yield { type: "result", is_error: false }
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
