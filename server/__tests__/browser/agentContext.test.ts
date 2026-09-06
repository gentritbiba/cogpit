// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { HookInput, PreToolUseHookSpecificOutput } from "@anthropic-ai/claude-agent-sdk"
import {
  BROWSER_CONTEXT_APPEND,
  BROWSER_HOOK_TOOL,
  browserPreToolUseHook,
  redirectToThrowaway,
  throwawayBrowserName,
} from "../../browser/agentContext"
import { isValidBrowserName, MAX_BROWSER_NAME_LENGTH } from "../../../shared/browser/names"
import { getCommandText } from "../../../shared/session/toolSummary"

const AGENT = "sub1"
const TMP = "tmp-sub1"

describe("BROWSER_CONTEXT_APPEND", () => {
  it("says the four things a skill would otherwise have to be read for", () => {
    expect(BROWSER_CONTEXT_APPEND).toContain("Browser panel")
    expect(BROWSER_CONTEXT_APPEND).toContain("`default`")
    expect(BROWSER_CONTEXT_APPEND).toContain("--session tmp-")
    expect(BROWSER_CONTEXT_APPEND).toContain("cogpit-browser")
  })

  it("stays short enough to send on every request", () => {
    expect(BROWSER_CONTEXT_APPEND.split("\n")).toHaveLength(4)
  })
})

describe("redirectToThrowaway", () => {
  it.each([
    ["inserts a session when there is none", "agent-browser open https://x", `agent-browser --session ${TMP} open https://x`],
    ["replaces a named session", "agent-browser --session github open x", `agent-browser --session ${TMP} open x`],
    ["replaces the equals form", "agent-browser --session=default open x", `agent-browser --session ${TMP} open x`],
    [
      "rewrites both halves of a chain",
      "agent-browser open x && agent-browser snapshot -i",
      `agent-browser --session ${TMP} open x && agent-browser --session ${TMP} snapshot -i`,
    ],
    [
      "leaves the throwaway half of a mixed chain alone",
      "agent-browser --session tmp-keep open x; agent-browser --session github snapshot",
      `agent-browser --session tmp-keep open x; agent-browser --session ${TMP} snapshot`,
    ],
    [
      "keeps a path-prefixed binary",
      "/usr/local/bin/agent-browser open x",
      `/usr/local/bin/agent-browser --session ${TMP} open x`,
    ],
    [
      "rewrites a newline-separated chain",
      "agent-browser open x\nagent-browser close",
      `agent-browser --session ${TMP} open x\nagent-browser --session ${TMP} close`,
    ],
  ])("%s", (_name, command, expected) => {
    expect(redirectToThrowaway(command, AGENT)).toEqual({ command: expected, changed: true })
  })

  it.each([
    ["a command already on a throwaway", "agent-browser --session tmp-x open y"],
    ["every call of a chain already on one", "agent-browser --session tmp-x open y && agent-browser --session tmp-x close"],
    ["a filename that only looks like the binary", "cat notes/agent-browser-plan.md"],
    ["a command with no browser call at all", "bun run test"],
  ])("leaves %s untouched", (_name, command) => {
    expect(redirectToThrowaway(command, AGENT)).toEqual({ command, changed: false })
  })

  it("rewrites an argv-array command once it is rendered as text", () => {
    const command = getCommandText({ command: ["agent-browser", "open", "https://x"] })
    expect(redirectToThrowaway(command, AGENT)).toEqual({
      command: `agent-browser --session ${TMP} open https://x`,
      changed: true,
    })
  })

  it.each([
    ["unbalanced quoting", `agent-browser open "https://x`],
    ["the binary inside a quoted string", `sh -c "agent-browser open x"`],
    ["a session name from a variable", "agent-browser --session $BROWSER open x"],
    ["a quoted session name from a variable", `agent-browser --session "$BROWSER" open x`],
    ["a session flag with no readable value", `agent-browser --session="" open x`],
    ["two session flags in one call", "agent-browser --session a --session b open x"],
    ["a separator hidden inside an argument", `agent-browser fill @e1 "a; b" --session github`],
  ])("refuses to guess at %s", (_name, command) => {
    expect(redirectToThrowaway(command, AGENT)).toBeNull()
  })

  it("does not mistake --session-name for the session flag", () => {
    expect(redirectToThrowaway("agent-browser --session-name x open y", AGENT)).toEqual({
      command: `agent-browser --session ${TMP} --session-name x open y`,
      changed: true,
    })
  })

  it("sanitises an agent id into a legal browser name", () => {
    expect(throwawayBrowserName("Agent_1/B!")).toBe("tmp-agent_1-b-")
    expect(redirectToThrowaway("agent-browser open x", "Agent_1/B!")).toEqual({
      command: "agent-browser --session tmp-agent_1-b- open x",
      changed: true,
    })
  })

  it("truncates a long agent id to a name the shim accepts", () => {
    const name = throwawayBrowserName("a".repeat(60))
    expect(name).toHaveLength(MAX_BROWSER_NAME_LENGTH)
    expect(isValidBrowserName(name)).toBe(true)
    expect(redirectToThrowaway("agent-browser open x", "a".repeat(60))?.command)
      .toBe(`agent-browser --session ${name} open x`)
  })
})

// ── The hook ────────────────────────────────────────────────────────────

function hookInput(overrides: Record<string, unknown> = {}): HookInput {
  return {
    session_id: "s1",
    transcript_path: "/tmp/s1.jsonl",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: BROWSER_HOOK_TOOL,
    tool_use_id: "t1",
    agent_id: AGENT,
    tool_input: { command: "agent-browser open https://x" },
    ...overrides,
  } as HookInput
}

async function runHook(input: HookInput): Promise<{ hookSpecificOutput?: PreToolUseHookSpecificOutput }> {
  const result = await browserPreToolUseHook(input, "t1", { signal: new AbortController().signal })
  return result as { hookSpecificOutput?: PreToolUseHookSpecificOutput }
}

describe("browserPreToolUseHook", () => {
  it("never touches the main thread, which has no agent id", async () => {
    expect(await runHook(hookInput({ agent_id: undefined }))).toEqual({})
  })

  it("redirects a subagent's call and says so", async () => {
    const output = (await runHook(hookInput())).hookSpecificOutput
    expect(output?.updatedInput).toEqual({ command: `agent-browser --session ${TMP} open https://x` })
    expect(output?.additionalContext).toContain(TMP)
    expect(output?.additionalContext).toContain("Cogpit redirected")
    expect(output?.permissionDecision).toBeUndefined()
  })

  it("keeps the rest of the tool input", async () => {
    const input = hookInput({ tool_input: { command: "agent-browser open x", timeout: 5000 } })
    expect((await runHook(input)).hookSpecificOutput?.updatedInput)
      .toEqual({ command: `agent-browser --session ${TMP} open x`, timeout: 5000 })
  })

  it.each([
    ["a call already on a throwaway", { tool_input: { command: "agent-browser --session tmp-a open x" } }],
    ["a command that is not browser work", { tool_input: { command: "bun run test" } }],
    ["a filename that only looks like the binary", { tool_input: { command: "cat agent-browser-plan.md" } }],
    ["another tool", { tool_name: "Read", tool_input: { file_path: "/agent-browser" } }],
    ["another event", { hook_event_name: "PostToolUse" }],
    ["a tool input that is not an object", { tool_input: "agent-browser open x" }],
  ])("passes %s through", async (_name, overrides) => {
    expect(await runHook(hookInput(overrides))).toEqual({})
  })

  it("denies a command it cannot rewrite, with a reason the agent can act on", async () => {
    const input = hookInput({ tool_input: { command: "agent-browser --session $BROWSER open x" } })
    const output = (await runHook(input)).hookSpecificOutput
    expect(output?.permissionDecision).toBe("deny")
    expect(output?.permissionDecisionReason).toContain("--session tmp-")
    expect(output?.updatedInput).toBeUndefined()
  })

  it("swallows a failure rather than breaking the tool call", async () => {
    const toolInput = {}
    Object.defineProperty(toolInput, "command", {
      get() { throw new Error("unreadable input") },
      enumerable: true,
    })
    expect(await runHook(hookInput({ tool_input: toolInput }))).toEqual({})
  })
})
