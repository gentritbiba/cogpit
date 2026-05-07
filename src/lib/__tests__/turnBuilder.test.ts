/**
 * Tests for turnBuilder hook_progress parsing.
 *
 * Real-world hook_progress shape (v2.1.29, v2.1.71 observed on disk):
 *   data: { type: "hook_progress", hookEvent: "PostToolUse", hookName: "PostToolUse:Read", command: "callback" }
 *   parentToolUseID: "<tool-use-id>"
 *   toolUseID: "<tool-use-id>"
 *
 * Newer SDK fields (plan-documented, not yet observed in local samples):
 *   data.hook_event_name, data.source, data.tool_name, data.output, data.stderr,
 *   data.exit_code, data.decision, data.duration_ms, data.hookSpecificOutput
 */

import { describe, it, expect, beforeEach } from "vitest"
import { parseSession } from "@/lib/parser"
import {
  resetFixtureCounter,
  userMsg,
  textAssistant,
  toolUseAssistant,
  toolResultMsg,
  turnDurationMsg,
  toJsonl,
} from "@/__tests__/fixtures"
import type { ProgressMessage, ParsedHookEvent } from "@/lib/types"

beforeEach(() => {
  resetFixtureCounter()
})

// ── Fixture helpers ──────────────────────────────────────────────────────────

function hookProgressMsg(
  parentToolUseID: string,
  data: Record<string, unknown>,
  overrides: Partial<ProgressMessage> = {}
): ProgressMessage {
  return {
    type: "progress",
    uuid: `hook-${Math.random().toString(36).slice(2)}`,
    timestamp: "2025-01-15T10:00:01.500Z",
    sessionId: "test-session-1",
    parentToolUseID,
    toolUseID: parentToolUseID,
    data: { type: "hook_progress", ...data } as ProgressMessage["data"],
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("hook_progress parsing", () => {
  it("produces a hook_event content block from a progress message with hook_event_name (newer SDK field)", () => {
    const toolId = "toolu_abc123"
    const jsonl = toJsonl([
      userMsg("Do some work"),
      toolUseAssistant("Read", { file_path: "src/main.ts" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_use_id: toolId,
        source: "settings",
        command: "/usr/local/bin/my-hook",
        output: "hook ran ok",
        exit_code: 0,
        duration_ms: 42,
      }),
      toolResultMsg(toolId, "file contents"),
      textAssistant("Done!"),
      turnDurationMsg(2000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)

    const block = hookBlocks[0]
    expect(block.kind).toBe("hook_event")
    if (block.kind !== "hook_event") return

    expect(block.events).toHaveLength(1)
    const ev = block.events[0]
    expect(ev.eventName).toBe("PostToolUse")
    expect(ev.toolName).toBe("Read")
    expect(ev.toolUseId).toBe(toolId)
    expect(ev.source).toBe("settings")
    expect(ev.command).toBe("/usr/local/bin/my-hook")
    expect(ev.output).toBe("hook ran ok")
    expect(ev.exitCode).toBe(0)
    expect(ev.durationMs).toBe(42)
    expect(ev.timestamp).toBeTruthy()
  })

  it("produces a hook_event block from older hookEvent field (v2.1.29/v2.1.71 on-disk format)", () => {
    const toolId = "toolu_old123"
    const jsonl = toJsonl([
      userMsg("Do some work"),
      toolUseAssistant("Read", { file_path: "src/main.ts" }, toolId),
      hookProgressMsg(toolId, {
        hookEvent: "PostToolUse",
        hookName: "PostToolUse:Read",
        command: "callback",
      }),
      toolResultMsg(toolId, "file contents"),
      textAssistant("Done!"),
      turnDurationMsg(2000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)

    const block = hookBlocks[0]
    if (block.kind !== "hook_event") return
    expect(block.events).toHaveLength(1)
    expect(block.events[0].eventName).toBe("PostToolUse")
    expect(block.events[0].command).toBe("callback")
  })

  it("groups multiple consecutive hook events into one block", () => {
    const toolId1 = "toolu_111"
    const toolId2 = "toolu_222"
    const jsonl = toJsonl([
      userMsg("Multi-tool"),
      toolUseAssistant("Read", { file_path: "a.ts" }, toolId1),
      hookProgressMsg(toolId1, {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        duration_ms: 10,
      }),
      hookProgressMsg(toolId2, {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        duration_ms: 20,
      }),
      toolResultMsg(toolId1, "content"),
      textAssistant("Done."),
      turnDurationMsg(1500),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    // Both consecutive events should be in one block
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    expect(hookBlocks[0].events).toHaveLength(2)
    expect(hookBlocks[0].events[0].durationMs).toBe(10)
    expect(hookBlocks[0].events[1].durationMs).toBe(20)
  })

  it("extracts hookSpecificOutput.updatedToolOutput onto ParsedHookEvent", () => {
    const toolId = "toolu_upd456"
    const jsonl = toJsonl([
      userMsg("Run with hook output replacement"),
      toolUseAssistant("Bash", { command: "ls" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        hookSpecificOutput: {
          updatedToolOutput: "filtered output from hook",
        },
      }),
      toolResultMsg(toolId, "raw result"),
      textAssistant("Done."),
      turnDurationMsg(1000),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    const ev = hookBlocks[0].events[0]
    expect(ev.updatedToolOutput).toBe("filtered output from hook")
  })

  it("extracts hookSpecificOutput.sessionTitle", () => {
    const toolId = "toolu_title789"
    const jsonl = toJsonl([
      userMsg("Set title hook"),
      toolUseAssistant("Bash", { command: "echo hi" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "UserPromptSubmit",
        hookSpecificOutput: {
          sessionTitle: "My Great Session",
        },
      }),
      toolResultMsg(toolId, "ok"),
      textAssistant("Done."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    expect(hookBlocks[0].events[0].sessionTitle).toBe("My Great Session")
  })

  it("extracts hookSpecificOutput.worktreePath", () => {
    const toolId = "toolu_wt000"
    const jsonl = toJsonl([
      userMsg("Worktree hook"),
      toolUseAssistant("EnterWorktree", { name: "fix-auth" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "WorktreeCreate",
        hookSpecificOutput: {
          worktreePath: "/tmp/worktrees/fix-auth",
        },
      }),
      toolResultMsg(toolId, "ok"),
      textAssistant("Done."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    expect(hookBlocks[0].events[0].worktreePath).toBe("/tmp/worktrees/fix-auth")
  })

  it("flows duration_ms through to durationMs on ParsedHookEvent", () => {
    const toolId = "toolu_dur321"
    const jsonl = toJsonl([
      userMsg("Duration test"),
      toolUseAssistant("Bash", { command: "sleep 1" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "PostToolUse",
        duration_ms: 1234,
      }),
      toolResultMsg(toolId, "ok"),
      textAssistant("Done."),
      turnDurationMsg(2000),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    expect(hookBlocks[0].events[0].durationMs).toBe(1234)
  })

  it("parses error events (exit_code != 0) without filtering them out", () => {
    const toolId = "toolu_err999"
    const jsonl = toJsonl([
      userMsg("Error hook test"),
      toolUseAssistant("Bash", { command: "fail" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        exit_code: 1,
        stderr: "command failed",
      }),
      toolResultMsg(toolId, "err", true),
      textAssistant("Failed."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    // Error events must NOT be filtered out
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    const ev = hookBlocks[0].events[0]
    expect(ev.eventName).toBe("PostToolUseFailure")
    expect(ev.exitCode).toBe(1)
    expect(ev.stderr).toBe("command failed")
  })

  it("parses StopFailure events without filtering", () => {
    const toolId = "toolu_sf000"
    const jsonl = toJsonl([
      userMsg("StopFailure test"),
      toolUseAssistant("Bash", { command: "stop" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "StopFailure",
        decision: "block",
      }),
      toolResultMsg(toolId, "ok"),
      textAssistant("Stopped."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    const ev = hookBlocks[0].events[0]
    expect(ev.eventName).toBe("StopFailure")
    expect(ev.decision).toBe("block")
  })

  it("does not emit a hook_event block when there are no hook_progress messages", () => {
    const jsonl = toJsonl([
      userMsg("Plain session"),
      textAssistant("Hello!"),
      turnDurationMsg(1000),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(0)
  })

  it("uses 'unknown' as eventName when no event name field is present", () => {
    const toolId = "toolu_noname"
    const jsonl = toJsonl([
      userMsg("Mystery hook"),
      toolUseAssistant("Bash", { command: "x" }, toolId),
      hookProgressMsg(toolId, {
        command: "callback",
        // no hook_event_name or hookEvent
      }),
      toolResultMsg(toolId, "ok"),
      textAssistant("Done."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    expect(hookBlocks[0].events[0].eventName).toBe("unknown")
  })

  it("preserves timestamp on ParsedHookEvent", () => {
    const toolId = "toolu_ts111"
    const ts = "2025-06-01T12:00:00.000Z"
    const jsonl = toJsonl([
      userMsg("Timestamp test"),
      toolUseAssistant("Read", { file_path: "x.ts" }, toolId),
      hookProgressMsg(toolId, { hook_event_name: "PostToolUse" }, { timestamp: ts }),
      toolResultMsg(toolId, "ok"),
      textAssistant("Done."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const hookBlocks = session.turns[0].contentBlocks.filter(
      (b) => b.kind === "hook_event"
    )
    expect(hookBlocks).toHaveLength(1)
    if (hookBlocks[0].kind !== "hook_event") return
    expect(hookBlocks[0].events[0].timestamp).toBe(ts)
  })
})
