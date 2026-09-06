import { describe, expect, it } from "vitest"
import { latestBrowserActivity } from "../../../shared/session/browserActivity"
import type { ParsedSession, ToolCall, Turn } from "../../../shared/session/types"

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tool-1",
    name: "Bash",
    input: {},
    result: "ok",
    isError: false,
    timestamp: "2026-09-06T10:00:00.000Z",
    ...overrides,
  }
}

function turn(toolCalls: ToolCall[], overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    userMessage: null,
    contentBlocks: [],
    thinking: [],
    assistantText: [],
    toolCalls,
    subAgentActivity: [],
    timestamp: "2026-09-06T10:00:00.000Z",
    durationMs: null,
    tokenUsage: null,
    model: null,
    ...overrides,
  }
}

function session(turns: Turn[]): ParsedSession {
  return {
    sessionId: "s1",
    version: "1",
    gitBranch: "browser-panel",
    cwd: "/repo",
    slug: "",
    name: "",
    model: "",
    turns,
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount: turns.length,
    },
    rawMessages: [],
  }
}

function activityFor(command: unknown, overrides: Partial<ToolCall> = {}) {
  return latestBrowserActivity(session([turn([toolCall({ input: { command }, ...overrides })])]))
}

describe("latestBrowserActivity", () => {
  it("returns null without a session or without turns", () => {
    expect(latestBrowserActivity(null)).toBeNull()
    expect(latestBrowserActivity(session([]))).toBeNull()
    expect(latestBrowserActivity(session([turn([])]))).toBeNull()
  })

  it("reports a plain invocation against the default browser", () => {
    expect(activityFor("agent-browser open https://x")).toEqual({
      session: "default",
      command: "agent-browser open https://x",
      timestamp: "2026-09-06T10:00:00.000Z",
      toolCallId: "tool-1",
      done: true,
    })
  })

  it.each(["--session github", "--session=github"])("reads the browser name from %s", (flag) => {
    expect(activityFor(`agent-browser ${flag} open https://x`)?.session).toBe("github")
  })

  it("reads an argv-array command", () => {
    expect(activityFor(["agent-browser", "open", "x"])).toMatchObject({
      session: "default",
      command: "agent-browser open x",
    })
  })

  it.each(["exec_command", "functions.exec_command"])("accepts %s as a shell call", (name) => {
    expect(activityFor("agent-browser open x", { name })?.command).toBe("agent-browser open x")
  })

  it("cuts a chained command at the first separator", () => {
    expect(activityFor("agent-browser open x && agent-browser snapshot -i")?.command)
      .toBe("agent-browser open x")
    expect(activityFor("agent-browser open x; echo done")?.command).toBe("agent-browser open x")
    expect(activityFor("agent-browser open x\nagent-browser close")?.command)
      .toBe("agent-browser open x")
  })

  it("starts the command at the binary even when it was called through a path", () => {
    expect(activityFor("/usr/local/bin/agent-browser open x")?.command).toBe("agent-browser open x")
  })

  it("truncates a long invocation to 120 characters", () => {
    const command = activityFor(`agent-browser fill @e1 "${"x".repeat(200)}"`)?.command
    expect(command).toHaveLength(120)
    expect(command?.endsWith("…")).toBe(true)
  })

  it("marks a call that has not returned as still running", () => {
    expect(activityFor("agent-browser open x", { result: null })?.done).toBe(false)
  })

  it("ignores commands that only mention the binary as part of a filename", () => {
    expect(activityFor("cat agent-browser-plan.md")).toBeNull()
    expect(activityFor("cat notes/agent-browser-plan.md")).toBeNull()
    expect(activityFor("cat agent-browser.md")).toBeNull()
  })

  it.each([
    'git commit -m "fix agent-browser"',
    'rg "agent-browser; agent-browser" server',
    "cat /tmp/agent-browser",
    "echo ok # agent-browser open x",
    "command -v agent-browser",
    `sh -c 'agent-browser open x'`,
  ])("does not show browser activity for %s", (command) => {
    expect(activityFor(command)).toBeNull()
  })

  it("keeps separators inside arguments and reads the later session flag", () => {
    const command = 'agent-browser fill @e1 "a; b && c" --session work'
    expect(activityFor(command)).toMatchObject({ session: "work", command })
  })

  it("finds a real invocation after an inert mention", () => {
    expect(activityFor('echo "agent-browser" && agent-browser --session work open x'))
      .toMatchObject({ session: "work", command: "agent-browser --session work open x" })
  })

  it("ends the caption at a pipe without reading the next command's flags", () => {
    expect(activityFor('agent-browser snapshot | rg --session work'))
      .toMatchObject({ session: "default", command: "agent-browser snapshot" })
  })

  it("ignores non-browser and non-shell calls", () => {
    expect(activityFor("bun run test")).toBeNull()
    expect(activityFor("agent-browser open x", { name: "Read" })).toBeNull()
  })

  it("takes the newest matching call across turns and tool calls", () => {
    const activity = latestBrowserActivity(session([
      turn([toolCall({ id: "old", input: { command: "agent-browser open old" } })]),
      turn(
        [
          toolCall({ id: "mid", input: { command: "agent-browser open mid" } }),
          toolCall({ id: "other", input: { command: "bun run test" } }),
          toolCall({ id: "new", input: { command: "agent-browser --session github open new" } }),
        ],
        { id: "turn-2" },
      ),
    ]))
    expect(activity).toMatchObject({ toolCallId: "new", session: "github" })
  })

  it("skips throwaway browsers and keeps scanning older calls", () => {
    const activity = latestBrowserActivity(session([
      turn([toolCall({ id: "named", input: { command: "agent-browser --session github open x" } })]),
      turn(
        [toolCall({ id: "throwaway", input: { command: "agent-browser --session tmp-x open y" } })],
        { id: "turn-2" },
      ),
    ]))
    expect(activity).toMatchObject({ toolCallId: "named", session: "github" })
  })

  it("never reads a subagent's browser calls", () => {
    const withSubAgent = turn([], {
      subAgentActivity: [{
        agentId: "a1",
        agentName: null,
        subagentType: null,
        type: "assistant",
        content: null,
        toolCalls: [toolCall({ id: "sub", input: { command: "agent-browser open x" } })],
        thinking: [],
        text: [],
        timestamp: "2026-09-06T10:00:00.000Z",
        tokenUsage: null,
        model: null,
        isBackground: false,
      }],
    })
    expect(latestBrowserActivity(session([withSubAgent]))).toBeNull()
  })
})
