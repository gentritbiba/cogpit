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
import { parseSession, parseSessionAppend } from "@/lib/parser"
import {
  resetFixtureCounter,
  userMsg,
  textAssistant,
  toolUseAssistant,
  toolResultMsg,
  turnDurationMsg,
  toJsonl,
  peerAttachment,
  peerEnqueueMsg,
} from "@/__tests__/fixtures"
import type { ProgressMessage, SystemMessage, TurnContentBlock } from "@/lib/types"

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

// ── PostToolUse hook cross-linking tests ─────────────────────────────────────

describe("PostToolUse hook cross-linking onto ToolCall", () => {
  it("sets outputReplacedByHook and hookDurationMs when updatedToolOutput is present", () => {
    const toolId = "toolu_crosslink1"
    const jsonl = toJsonl([
      userMsg("Read with hook replacement"),
      toolUseAssistant("Read", { file_path: "src/main.ts" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_use_id: toolId,
        duration_ms: 42,
        hookSpecificOutput: { updatedToolOutput: "replaced!" },
      }),
      toolResultMsg(toolId, "original output"),
      textAssistant("Done."),
      turnDurationMsg(1000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)
    const tc = session.turns[0].toolCalls[0]
    expect(tc.outputReplacedByHook).toBe(true)
    expect(tc.hookDurationMs).toBe(42)
  })

  it("sums hookDurationMs across multiple hook events on the same tool call", () => {
    const toolId = "toolu_crosslink2"
    const jsonl = toJsonl([
      userMsg("Multiple hooks"),
      toolUseAssistant("Bash", { command: "ls" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "PostToolUse",
        tool_use_id: toolId,
        duration_ms: 10,
        hookSpecificOutput: { updatedToolOutput: "first" },
      }),
      hookProgressMsg(toolId, {
        hook_event_name: "PostToolUse",
        tool_use_id: toolId,
        duration_ms: 20,
        hookSpecificOutput: { updatedToolOutput: "second" },
      }),
      toolResultMsg(toolId, "raw"),
      textAssistant("Done."),
      turnDurationMsg(1000),
    ])

    const session = parseSession(jsonl)
    const tc = session.turns[0].toolCalls[0]
    expect(tc.outputReplacedByHook).toBe(true)
    expect(tc.hookDurationMs).toBe(30)
  })

  it("does not set outputReplacedByHook when updatedToolOutput is absent", () => {
    const toolId = "toolu_crosslink3"
    const jsonl = toJsonl([
      userMsg("Hook without replacement"),
      toolUseAssistant("Read", { file_path: "x.ts" }, toolId),
      hookProgressMsg(toolId, {
        hook_event_name: "PostToolUse",
        tool_use_id: toolId,
        duration_ms: 5,
      }),
      toolResultMsg(toolId, "ok"),
      textAssistant("Done."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const tc = session.turns[0].toolCalls[0]
    expect(tc.outputReplacedByHook).toBeUndefined()
    expect(tc.hookDurationMs).toBe(5)
  })

  it("skips gracefully when tool_use_id does not match any tool call", () => {
    const toolId = "toolu_crosslink4"
    const unknownId = "toolu_unknown99"
    const jsonl = toJsonl([
      userMsg("Unmatched hook"),
      toolUseAssistant("Read", { file_path: "x.ts" }, toolId),
      hookProgressMsg(unknownId, {
        hook_event_name: "PostToolUse",
        tool_use_id: unknownId,
        duration_ms: 7,
        hookSpecificOutput: { updatedToolOutput: "replaced" },
      }),
      toolResultMsg(toolId, "ok"),
      textAssistant("Done."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    // Should not throw; the existing tool call is unaffected
    const tc = session.turns[0].toolCalls[0]
    expect(tc.outputReplacedByHook).toBeUndefined()
    expect(tc.hookDurationMs).toBeUndefined()
  })
})

// ── Plan mode grouping tests ─────────────────────────────────────────────────

/**
 * EnterPlanMode schema (observed from Claude Code):
 *   input: { plan: string }  — the plan text (markdown)
 *
 * ExitPlanMode schema:
 *   input: { path?: string } — optional file path where plan was saved
 *
 * The parser groups EnterPlanMode → [intermediate tool calls] → ExitPlanMode
 * into a single plan_mode content block instead of separate tool_calls blocks.
 */

function planModeSession(opts: {
  enterInput?: Record<string, unknown>
  exitInput?: Record<string, unknown>
  intermediateTools?: Array<{ name: string; input: Record<string, unknown>; id: string }>
  hasExitResult?: boolean
  exitIsError?: boolean
  omitExit?: boolean
}) {
  const {
    enterInput = { plan: "## Plan\n\n1. Read the file\n2. Edit it" },
    exitInput = { path: "/tmp/plan.md" },
    intermediateTools = [],
    hasExitResult = true,
    exitIsError = false,
    omitExit = false,
  } = opts

  const enterId = "enter_plan_1"
  const exitId = "exit_plan_1"

  const msgs: Array<Record<string, unknown>> = [
    userMsg("Please plan this"),
    toolUseAssistant("EnterPlanMode", enterInput, enterId),
    toolResultMsg(enterId, "ok"),
  ]

  for (const tool of intermediateTools) {
    msgs.push(toolUseAssistant(tool.name, tool.input, tool.id))
    msgs.push(toolResultMsg(tool.id, "result"))
  }

  if (!omitExit) {
    msgs.push(toolUseAssistant("ExitPlanMode", exitInput, exitId))
    if (hasExitResult) {
      msgs.push(toolResultMsg(exitId, "plan approved", exitIsError))
    }
  }

  msgs.push(textAssistant("Plan complete."))
  msgs.push(turnDurationMsg(3000))
  return toJsonl(msgs)
}

describe("plan_mode grouping", () => {
  it("groups EnterPlanMode → ExitPlanMode into one plan_mode block", () => {
    const jsonl = planModeSession({})
    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    const planBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)

    const block = planBlocks[0]
    if (block.kind !== "plan_mode") return
    expect(block.plan).toBe("## Plan\n\n1. Read the file\n2. Edit it")
    expect(block.planFilePath).toBe("/tmp/plan.md")
    expect(block.status).toBe("approved")
    expect(block.toolCalls).toHaveLength(0)
  })

  it("does NOT produce a separate tool_calls block for the Enter/Exit pair", () => {
    const jsonl = planModeSession({})
    const session = parseSession(jsonl)
    const toolCallBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "tool_calls")
    // The enter/exit tool calls must not appear as a separate tool_calls block
    expect(toolCallBlocks).toHaveLength(0)
  })

  it("embeds intermediate tool calls under toolCalls in the plan_mode block", () => {
    const jsonl = planModeSession({
      intermediateTools: [
        { name: "Read", input: { file_path: "src/main.ts" }, id: "inter_1" },
        { name: "Read", input: { file_path: "src/lib.ts" }, id: "inter_2" },
      ],
    })
    const session = parseSession(jsonl)
    const planBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)
    if (planBlocks[0].kind !== "plan_mode") return
    expect(planBlocks[0].toolCalls).toHaveLength(2)
    expect(planBlocks[0].toolCalls[0].name).toBe("Read")
    expect(planBlocks[0].toolCalls[1].name).toBe("Read")
  })

  it("sets status to 'approved' when ExitPlanMode has a non-error result", () => {
    const jsonl = planModeSession({ exitIsError: false })
    const session = parseSession(jsonl)
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "plan_mode")
    if (!block || block.kind !== "plan_mode") return
    expect(block.status).toBe("approved")
  })

  it("sets status to 'rejected' when ExitPlanMode result is an error", () => {
    const jsonl = planModeSession({ exitIsError: true })
    const session = parseSession(jsonl)
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "plan_mode")
    if (!block || block.kind !== "plan_mode") return
    expect(block.status).toBe("rejected")
  })

  it("sets status to 'pending' when ExitPlanMode has no result yet", () => {
    const jsonl = planModeSession({ hasExitResult: false })
    const session = parseSession(jsonl)
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "plan_mode")
    if (!block || block.kind !== "plan_mode") return
    expect(block.status).toBe("pending")
  })

  it("sets status to 'pending' and emits plan_mode block when no ExitPlanMode yet", () => {
    const jsonl = planModeSession({ omitExit: true })
    const session = parseSession(jsonl)
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "plan_mode")
    expect(block).toBeDefined()
    if (!block || block.kind !== "plan_mode") return
    expect(block.plan).toBe("## Plan\n\n1. Read the file\n2. Edit it")
    expect(block.status).toBe("pending")
    expect(block.planFilePath).toBeUndefined()
  })

  it("embeds non-readonly tools (e.g. Bash) without filtering", () => {
    const jsonl = planModeSession({
      intermediateTools: [
        { name: "Bash", input: { command: "ls" }, id: "bash_1" },
      ],
    })
    const session = parseSession(jsonl)
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "plan_mode")
    if (!block || block.kind !== "plan_mode") return
    // Bash must be embedded — no filtering
    expect(block.toolCalls).toHaveLength(1)
    expect(block.toolCalls[0].name).toBe("Bash")
  })

  it("does not treat a plan_mode block's embedded calls as flat toolCalls on the turn", () => {
    const jsonl = planModeSession({
      intermediateTools: [
        { name: "Read", input: { file_path: "a.ts" }, id: "inter_r1" },
      ],
    })
    const session = parseSession(jsonl)
    // The turn's flat toolCalls should only include Enter+Exit (for stats/search compat)
    // but NOT intermediate ones, since those are embedded in the plan_mode block
    const planBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)
  })

  it("does not break grouping when a hook_event block appears before the Read inside the plan (Enter → hook → Read → Exit)", () => {
    const enterId = "enter_hook_before"
    const readId = "read_hook_before"
    const exitId = "exit_hook_before"

    const jsonl = toJsonl([
      userMsg("Plan with early hook"),
      toolUseAssistant("EnterPlanMode", { plan: "hook before read" }, enterId),
      toolResultMsg(enterId, "ok"),
      // hook_event between Enter and the first intermediate tool call
      hookProgressMsg(enterId, { hook_event_name: "PostToolUse", tool_name: "EnterPlanMode", tool_use_id: enterId, duration_ms: 5 }),
      toolUseAssistant("Read", { file_path: "src/a.ts" }, readId),
      toolResultMsg(readId, "file content"),
      toolUseAssistant("ExitPlanMode", { path: "/tmp/plan.md" }, exitId),
      toolResultMsg(exitId, "plan approved"),
      textAssistant("Done."),
      turnDurationMsg(2000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    // Must produce exactly ONE plan_mode block (not pending)
    const planBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)
    const planBlock = planBlocks[0]
    if (planBlock.kind !== "plan_mode") return
    expect(planBlock.status).toBe("approved")
    // The Read is embedded in the plan block
    expect(planBlock.toolCalls).toHaveLength(1)
    expect(planBlock.toolCalls[0].name).toBe("Read")

    // The hook_event block must still appear in the turn's contentBlocks
    const hookBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "hook_event")
    expect(hookBlocks).toHaveLength(1)
  })

  it("does not break grouping when a hook_event block appears after the Read inside the plan (Enter → Read → hook → Exit)", () => {
    const enterId = "enter_hook_after"
    const readId = "read_hook_after"
    const exitId = "exit_hook_after"

    const jsonl = toJsonl([
      userMsg("Plan with hook after read"),
      toolUseAssistant("EnterPlanMode", { plan: "hook after read" }, enterId),
      toolResultMsg(enterId, "ok"),
      toolUseAssistant("Read", { file_path: "src/b.ts" }, readId),
      toolResultMsg(readId, "file content"),
      // hook_event between the Read and ExitPlanMode
      hookProgressMsg(readId, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: readId, duration_ms: 10 }),
      toolUseAssistant("ExitPlanMode", { path: "/tmp/plan.md" }, exitId),
      toolResultMsg(exitId, "plan approved"),
      textAssistant("Done."),
      turnDurationMsg(2000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    // Must produce exactly ONE plan_mode block (not pending)
    const planBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)
    const planBlock = planBlocks[0]
    if (planBlock.kind !== "plan_mode") return
    expect(planBlock.status).toBe("approved")
    expect(planBlock.toolCalls).toHaveLength(1)
    expect(planBlock.toolCalls[0].name).toBe("Read")

    // The hook_event block must still appear in the turn's contentBlocks
    const hookBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "hook_event")
    expect(hookBlocks).toHaveLength(1)
  })

  it("does not break grouping when a text block appears between Enter and Exit", () => {
    const enterId = "enter_text_between"
    const readId = "read_text_between"
    const exitId = "exit_text_between"

    // We simulate a text block by inserting a textAssistant message between the tools.
    // In real sessions, Claude may emit a text block mid-plan-mode.
    const jsonl = toJsonl([
      userMsg("Plan with text between"),
      // First assistant message: EnterPlanMode
      toolUseAssistant("EnterPlanMode", { plan: "text between plan" }, enterId),
      toolResultMsg(enterId, "ok"),
      // Second assistant message: text block
      textAssistant("Thinking about the plan..."),
      // Third assistant message: Read + Exit
      toolUseAssistant("Read", { file_path: "src/c.ts" }, readId),
      toolResultMsg(readId, "file content"),
      toolUseAssistant("ExitPlanMode", { path: "/tmp/plan.md" }, exitId),
      toolResultMsg(exitId, "plan approved"),
      textAssistant("Done."),
      turnDurationMsg(2000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    // Must produce exactly ONE plan_mode block (not pending)
    const planBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)
    const planBlock = planBlocks[0]
    if (planBlock.kind !== "plan_mode") return
    expect(planBlock.status).toBe("approved")
    // Read is embedded
    expect(planBlock.toolCalls).toHaveLength(1)
    expect(planBlock.toolCalls[0].name).toBe("Read")

    // The text block must still appear in the turn's contentBlocks
    const textBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "text")
    expect(textBlocks.length).toBeGreaterThanOrEqual(1)
  })

  it("does not break plan grouping when a queued prompt appears between Enter and Exit", () => {
    const enterId = "enter_queued_prompt"
    const readId = "read_queued_prompt"
    const exitId = "exit_queued_prompt"

    const jsonl = toJsonl([
      userMsg("Plan with a steer"),
      toolUseAssistant("EnterPlanMode", { plan: "queued prompt plan" }, enterId),
      toolResultMsg(enterId, "ok"),
      {
        type: "queue-operation",
        operation: "enqueue",
        content: "Please include regression tests",
        timestamp: "2025-01-15T10:00:01.500Z",
      },
      toolUseAssistant("Read", { file_path: "src/plan.ts" }, readId),
      toolResultMsg(readId, "file content"),
      toolUseAssistant("ExitPlanMode", { path: "/tmp/plan.md" }, exitId),
      toolResultMsg(exitId, "plan approved"),
      textAssistant("Done."),
    ])

    const session = parseSession(jsonl)
    const planBlocks = session.turns[0].contentBlocks.filter((block) => block.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)
    if (planBlocks[0].kind !== "plan_mode") return
    expect(planBlocks[0].status).toBe("approved")
    expect(planBlocks[0].toolCalls.map((tool) => tool.name)).toEqual(["Read"])

    const queuedBlocks = session.turns[0].contentBlocks.filter((block) => block.kind === "queued_prompt")
    expect(queuedBlocks).toHaveLength(1)
    if (queuedBlocks[0].kind !== "queued_prompt") return
    expect(queuedBlocks[0].content).toBe("Please include regression tests")
  })

  it("does not break plan grouping when a peer message appears between Enter and Exit", () => {
    // A peer message is the same record a human steer used to be — it just
    // renders as `agent_message` now. Leaving it out of the scanner's
    // passthrough list aborts the scan, so the plan never sees its Exit.
    const enterId = "enter_agent_message"
    const readId = "read_agent_message"
    const exitId = "exit_agent_message"

    const jsonl = toJsonl([
      userMsg("Plan with a peer steer"),
      toolUseAssistant("EnterPlanMode", { plan: "peer message plan" }, enterId),
      toolResultMsg(enterId, "ok"),
      peerEnqueueMsg("csp-and-proxy", "one blocking question on finding #1."),
      toolUseAssistant("Read", { file_path: "src/plan.ts" }, readId),
      toolResultMsg(readId, "file content"),
      toolUseAssistant("ExitPlanMode", { path: "/tmp/plan.md" }, exitId),
      toolResultMsg(exitId, "plan approved"),
      textAssistant("Done."),
    ])

    const blocks = parseSession(jsonl).turns[0].contentBlocks

    const planBlocks = blocks.filter((block) => block.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)
    if (planBlocks[0].kind !== "plan_mode") return
    expect(planBlocks[0].status).toBe("approved")
    expect(planBlocks[0].toolCalls.map((tool) => tool.name)).toEqual(["Read"])

    // Neither the absorbed Read nor a bare ExitPlanMode may leak into the timeline.
    const looseTools = blocks.flatMap((block) =>
      block.kind === "tool_calls" ? block.toolCalls.map((tool) => tool.name) : []
    )
    expect(looseTools).not.toContain("ExitPlanMode")
    expect(looseTools).not.toContain("Read")

    const agentBlocks = blocks.filter((block) => block.kind === "agent_message")
    expect(agentBlocks).toHaveLength(1)
    if (agentBlocks[0].kind !== "agent_message") return
    expect(agentBlocks[0].sender).toBe("csp-and-proxy")
    expect(agentBlocks[0].body).toBe("one blocking question on finding #1.")
  })

  it("produces plan_mode block plus trailing tool calls when a Read follows ExitPlanMode in the same logical block", () => {
    const enterId = "enter_trailing"
    const exitId = "exit_trailing"
    const trailingReadId = "trailing_read"

    // ExitPlanMode and a trailing Read are in the same assistant message
    const jsonl = toJsonl([
      userMsg("Plan with trailing read"),
      toolUseAssistant("EnterPlanMode", { plan: "trailing read plan" }, enterId),
      toolResultMsg(enterId, "ok"),
      // Single assistant message with Exit + trailing Read
      {
        type: "assistant",
        uuid: "msg_trailing",
        timestamp: "2025-01-15T10:00:01Z",
        sessionId: "test-session-1",
        message: {
          model: "claude-opus-4-6-20250115",
          id: "msg_trailing",
          role: "assistant",
          content: [
            { type: "tool_use", id: exitId, name: "ExitPlanMode", input: { path: "/tmp/plan.md" } },
            { type: "tool_use", id: trailingReadId, name: "Read", input: { file_path: "src/trailing.ts" } },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      toolResultMsg(exitId, "plan approved"),
      toolResultMsg(trailingReadId, "trailing file content"),
      textAssistant("Done."),
      turnDurationMsg(2000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    // plan_mode block must exist and be approved
    const planBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "plan_mode")
    expect(planBlocks).toHaveLength(1)
    const planBlock = planBlocks[0]
    if (planBlock.kind !== "plan_mode") return
    expect(planBlock.status).toBe("approved")
    // No tools are embedded (Enter and Exit were in the same block, nothing between them)
    expect(planBlock.toolCalls).toHaveLength(0)

    // The trailing Read must appear as a tool_calls block in the turn
    const toolCallBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "tool_calls")
    expect(toolCallBlocks).toHaveLength(1)
    if (toolCallBlocks[0].kind !== "tool_calls") return
    expect(toolCallBlocks[0].toolCalls[0].name).toBe("Read")
  })
})

// ── Recap / away_summary parsing tests ─────────────────────────────────────────
//
// Real shape (observed in production JSONL, Claude Code v2.1.114+):
//   { type: "system", subtype: "away_summary", content: "...", isMeta: false, ... }
//
// The /recap command produces the same system message shape.
// Content is plain text (not markdown), but we preserve it verbatim.

let recapCounter = 0
function awaySummaryMsg(
  content: string,
  overrides: Partial<SystemMessage> = {}
): SystemMessage {
  return {
    type: "system",
    subtype: "away_summary",
    content,
    isMeta: false,
    uuid: `recap-${++recapCounter}`,
    timestamp: "2025-01-15T10:00:00.500Z",
    ...overrides,
  }
}

describe("recap / away_summary parsing", () => {
  it("produces a recap content block from a system message with subtype 'away_summary'", () => {
    const jsonl = toJsonl([
      awaySummaryMsg("Finished the nav refactor — all phases done."),
      userMsg("Pick up where we left off"),
      textAssistant("Sure!"),
      turnDurationMsg(1000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    const recapBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "recap")
    expect(recapBlocks).toHaveLength(1)

    const block = recapBlocks[0]
    if (block.kind !== "recap") return
    expect(block.content).toBe("Finished the nav refactor — all phases done.")
  })

  it("preserves the recap content text verbatim", () => {
    const rawText = "Round 1 done. Next: round 2 running. (disable recaps in /config)"
    const jsonl = toJsonl([
      awaySummaryMsg(rawText),
      userMsg("Continue"),
      textAssistant("On it."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const recapBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "recap")
    expect(recapBlocks).toHaveLength(1)
    if (recapBlocks[0].kind !== "recap") return
    expect(recapBlocks[0].content).toBe(rawText)
  })

  it("preserves the timestamp from the away_summary message", () => {
    const ts = "2026-04-20T10:58:07.711Z"
    const jsonl = toJsonl([
      awaySummaryMsg("Some recap", { timestamp: ts }),
      userMsg("Go"),
      textAssistant("Going."),
      turnDurationMsg(500),
    ])

    const session = parseSession(jsonl)
    const recapBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "recap")
    expect(recapBlocks).toHaveLength(1)
    if (recapBlocks[0].kind !== "recap") return
    expect(recapBlocks[0].timestamp).toBe(ts)
  })

  it("non-recap system messages (turn_duration, compact_boundary) are unaffected", () => {
    const jsonl = toJsonl([
      userMsg("Hello"),
      textAssistant("Hi!"),
      turnDurationMsg(1000),
    ])

    const session = parseSession(jsonl)
    expect(session.turns).toHaveLength(1)

    const recapBlocks = session.turns[0].contentBlocks.filter((b) => b.kind === "recap")
    expect(recapBlocks).toHaveLength(0)
  })

  it("places the recap block before the user message content in the first turn", () => {
    const jsonl = toJsonl([
      awaySummaryMsg("Summary of last session"),
      userMsg("Let's go"),
      textAssistant("Ready."),
      turnDurationMsg(800),
    ])

    const session = parseSession(jsonl)
    const turn = session.turns[0]

    const recapIndex = turn.contentBlocks.findIndex((b) => b.kind === "recap")
    expect(recapIndex).toBe(0)
  })
})

// ── queued prompt visibility ──────────────────────────────────────────────

describe("queued prompt visibility", () => {
  beforeEach(() => {
    resetFixtureCounter()
  })

  function queuedSession(content: string) {
    return parseSession(toJsonl([
      userMsg("Do the thing"),
      {
        type: "queue-operation",
        operation: "enqueue",
        content,
        timestamp: "2025-01-15T10:00:01.500Z",
      },
      textAssistant("Done."),
    ]))
  }

  function queuedBlocks(content: string) {
    return queuedSession(content).turns[0].contentBlocks.filter((b) => b.kind === "queued_prompt")
  }

  it("hides a bare task notification", () => {
    expect(queuedBlocks("<task-notification>\n<task-id>abc</task-id>\n</task-notification>"))
      .toHaveLength(0)
  })

  it("hides a task notification wrapped in a system-reminder envelope", () => {
    // Claude Code 2.1.234+ wraps background-task notifications this way.
    const wrapped = "<system-reminder>\n<task-notification>\n<task-id>abc</task-id>\n"
      + "</task-notification>\n</system-reminder>"
    expect(queuedBlocks(wrapped)).toHaveLength(0)
  })

  it("hides a bare system-reminder envelope", () => {
    expect(queuedBlocks("<system-reminder>Background note</system-reminder>")).toHaveLength(0)
  })

  it("hides a local command envelope", () => {
    expect(queuedBlocks("<local-command-stdout>ok</local-command-stdout>")).toHaveLength(0)
  })

  it("shows a real queued prompt", () => {
    const blocks = queuedBlocks("Please include regression tests")
    expect(blocks).toHaveLength(1)
    if (blocks[0].kind !== "queued_prompt") return
    expect(blocks[0].content).toBe("Please include regression tests")
  })

  it("shows a prompt that merely mentions a system reminder", () => {
    const blocks = queuedBlocks("why did a system-reminder show up?")
    expect(blocks).toHaveLength(1)
  })

  it("shows a prompt that opens with an unrelated angle bracket", () => {
    const blocks = queuedBlocks("<Button> renders twice — why?")
    expect(blocks).toHaveLength(1)
  })
})

// ── per-message reasoning effort ──────────────────────────────────────────

describe("reasoning effort", () => {
  beforeEach(() => {
    resetFixtureCounter()
  })

  it("carries the effort recorded on the assistant message onto the turn", () => {
    const session = parseSession(toJsonl([
      userMsg("Think hard"),
      textAssistant("Done.", { effort: "xhigh" }),
    ]))
    expect(session.turns[0].effort).toBe("xhigh")
  })

  it("leaves effort undefined when the record carries none", () => {
    const session = parseSession(toJsonl([
      userMsg("Think hard"),
      textAssistant("Done."),
    ]))
    expect(session.turns[0].effort).toBeUndefined()
  })

  it("keeps the last effort when a turn spans several assistant messages", () => {
    // Effort can be changed mid-session; the turn reflects what it ended on.
    const session = parseSession(toJsonl([
      userMsg("Think hard"),
      textAssistant("Working.", { effort: "medium" }),
      textAssistant("Done.", { effort: "max" }),
    ]))
    expect(session.turns[0].effort).toBe("max")
  })
})

// ── response attribution ──────────────────────────────────────────────────

describe("attribution", () => {
  beforeEach(() => {
    resetFixtureCounter()
  })

  it("carries skill attribution onto the turn", () => {
    const session = parseSession(toJsonl([
      userMsg("Commit this"),
      textAssistant("Done.", { attributionSkill: "commit" }),
    ]))
    expect(session.turns[0].attribution).toEqual({ skill: "commit" })
  })

  it("carries agent, plugin and MCP attribution", () => {
    const session = parseSession(toJsonl([
      userMsg("Search"),
      textAssistant("Done.", {
        attributionAgent: "Explore",
        attributionPlugin: "superpowers",
        attributionMcpServer: "clickup",
        attributionMcpTool: "clickup_get_task",
      }),
    ]))
    expect(session.turns[0].attribution).toEqual({
      agent: "Explore",
      plugin: "superpowers",
      mcpServer: "clickup",
      mcpTool: "clickup_get_task",
    })
  })

  it("leaves attribution undefined when the record carries none", () => {
    const session = parseSession(toJsonl([
      userMsg("Hi"),
      textAssistant("Done."),
    ]))
    expect(session.turns[0].attribution).toBeUndefined()
  })

  it("merges attribution across the assistant messages of one turn", () => {
    // A turn can start under a skill and later call an MCP tool.
    const session = parseSession(toJsonl([
      userMsg("Do it"),
      textAssistant("Working.", { attributionSkill: "commit" }),
      textAssistant("Done.", { attributionMcpServer: "clickup" }),
    ]))
    expect(session.turns[0].attribution).toEqual({ skill: "commit", mcpServer: "clickup" })
  })

  it("ignores non-string attribution values", () => {
    const session = parseSession(toJsonl([
      userMsg("Hi"),
      textAssistant("Done.", { attributionSkill: 42 as unknown as string }),
    ]))
    expect(session.turns[0].attribution).toBeUndefined()
  })
})

// ── Agent mail ───────────────────────────────────────────────────────────────

describe("agent mail", () => {
  const agentMessages = (blocks: TurnContentBlock[]) =>
    blocks.filter(
      (b): b is Extract<TurnContentBlock, { kind: "agent_message" }> => b.kind === "agent_message"
    )

  it("emits agent_message for a peer origin, with the envelope stripped", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question on finding #1."),
      textAssistant("done"),
    ]))

    const block = session.turns[0].contentBlocks.find((b) => b.kind === "agent_message")
    if (block?.kind !== "agent_message") throw new Error("expected agent_message")
    expect(block.sender).toBe("csp-and-proxy")
    expect(block.body).toBe("one blocking question on finding #1.")
  })

  // `origin.kind === "human"` says the reader typed this, whatever the text
  // happens to contain — quoting an agent's message back, or drafting the
  // wording for one, is ordinary. Only the pre-`origin` fallback is allowed to
  // read a sender out of the text, so this prompt must stay the reader's own
  // rather than become mail from an agent that never sent it.
  it("keeps a human origin as queued_prompt even when the text carries an envelope", () => {
    const attachment = peerAttachment("x", "unused")
    attachment.attachment.origin = { kind: "human" }
    attachment.attachment.prompt =
      `<agent-message from="not-really">please review this framing</agent-message>`

    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      attachment,
      textAssistant("done"),
    ]))

    const kinds = session.turns[0].contentBlocks.map((b) => b.kind)
    expect(kinds).toContain("queued_prompt")
    expect(kinds).not.toContain("agent_message")
  })

  // `origin` is the record Claude Code wrote; the envelope is text it happened
  // to also send. On disk the two agree, so nothing noticed which one the
  // parser read. They can disagree — the envelope is matched with a regex whose
  // idea of where the body ends is a guess — and when they do, `origin` wins.
  it("prefers origin.body over the body it could strip from the envelope", () => {
    const attachment = peerAttachment(
      "csp-and-proxy",
      "what the envelope says",
      "task-1",
      "2026-08-21T19:26:25.853Z",
      { body: "what origin says" },
    )

    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      attachment,
      textAssistant("done"),
    ]))

    const [block] = agentMessages(session.turns[0].contentBlocks)
    expect(block.body).toBe("what origin says")
  })

  it("strips the envelope itself when a peer origin carries no body", () => {
    const attachment = peerAttachment(
      "csp-and-proxy",
      "one blocking question on finding #1.",
      "task-1",
      "2026-08-21T19:26:25.853Z",
      { body: undefined },
    )

    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      attachment,
      textAssistant("done"),
    ]))

    const [block] = agentMessages(session.turns[0].contentBlocks)
    expect(block.body).toBe("one blocking question on finding #1.")
  })

  // `name` and `from` hold the same string in every record on disk, which is
  // why reading one for the other went unnoticed. The precedence is still a
  // choice, so pin which field wins — and note that reply pairing joins this
  // value against `SendMessage.input.to`, which follows `from`.
  it("takes the sender from origin.name ahead of origin.from", () => {
    const attachment = peerAttachment(
      "docs-sweep",
      "one blocking question",
      "task-1",
      "2026-08-21T19:26:25.853Z",
      { name: "docs-sweep", from: "docs-sweep@team-alpha" },
    )

    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      attachment,
      textAssistant("done"),
    ]))

    const [block] = agentMessages(session.turns[0].contentBlocks)
    expect(block.sender).toBe("docs-sweep")
  })

  // The text is not a second chance at the sender: a peer origin naming nobody
  // in a form `parseAgentEnvelope` recognises still has to render as mail, or
  // the next envelope Claude Code invents turns every peer message back into a
  // "Queued while working" card.
  it("falls back to origin.from when origin.name is absent", () => {
    const attachment = peerAttachment(
      "vehicle-batch",
      "half-blocked on a decision",
      "task-1",
      "2026-08-21T19:26:25.853Z",
      { name: undefined },
    )
    attachment.attachment.prompt = "half-blocked on a decision"

    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      attachment,
      textAssistant("done"),
    ]))

    const blocks = agentMessages(session.turns[0].contentBlocks)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].sender).toBe("vehicle-batch")
    expect(blocks[0].body).toBe("half-blocked on a decision")
  })

  it("falls back to the envelope when origin is absent", () => {
    const attachment = peerAttachment("vehicle-batch", "half-blocked on a decision")
    delete attachment.attachment.origin

    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      attachment,
      textAssistant("done"),
    ]))

    const block = session.turns[0].contentBlocks.find((b) => b.kind === "agent_message")
    if (block?.kind !== "agent_message") throw new Error("expected agent_message")
    expect(block.sender).toBe("vehicle-batch")
    expect(block.body).toBe("half-blocked on a decision")
  })

  it("leaves a plain queued prompt with no origin as queued_prompt", () => {
    const attachment = peerAttachment("x", "y")
    delete attachment.attachment.origin
    attachment.attachment.prompt = "also check the tests"

    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      attachment,
      textAssistant("done"),
    ]))

    expect(session.turns[0].contentBlocks.map((b) => b.kind)).toContain("queued_prompt")
  })

  // Claude Code writes each peer message twice: once as a queue-operation
  // enqueue carrying the raw envelope, then again as an attachment whose
  // `prompt` is that same raw string. Verified against all four peer messages
  // in the honest-cms sample — `prompt` matches the enqueue's `content`
  // exactly, while `origin.body` never does. The enqueue ledger keys on the
  // raw text for that reason; keying it on the stripped body would make both
  // copies render.
  it("renders a peer message once when both the enqueue and the attachment carry it", () => {
    const sender = "csp-and-proxy"
    const body = "one blocking question on finding #1."

    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerEnqueueMsg(sender, body),
      peerAttachment(sender, body),
      textAssistant("done"),
    ]))

    const agentMessages = session.turns[0].contentBlocks.filter((b) => b.kind === "agent_message")
    expect(agentMessages).toHaveLength(1)
    expect(session.turns[0].contentBlocks.filter((b) => b.kind === "queued_prompt")).toHaveLength(0)

    const block = agentMessages[0]
    if (block.kind !== "agent_message") throw new Error("expected agent_message")
    expect(block.sender).toBe(sender)
    expect(block.body).toBe(body)
  })

  // `origin.senderTaskId` names the sending agent's *task*, not the message.
  // In `…honest-cms/ddb6fc34….jsonl`, csp-and-proxy asked a blocking question at
  // 23:34:09 and reported done at 23:48:49; both records carry
  // senderTaskId=ada0f1591dbec7898. Any dedup keyed on that id silently drops
  // the second message, which is why the block no longer carries the field.
  it("keeps two different messages that share a sender task id", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question", "ada0f1591dbec7898"),
      peerAttachment("csp-and-proxy", "batch-2 done", "ada0f1591dbec7898"),
      textAssistant("done"),
    ]))

    const blocks = session.turns[0].contentBlocks.filter((b) => b.kind === "agent_message")
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => (b.kind === "agent_message" ? b.body : null)))
      .toEqual(["one blocking question", "batch-2 done"])
  })

  /**
   * A reply is a `SendMessage` tool_use carrying `{ to, summary, message }`.
   * `to` uses the same agent name that arrives in `origin.from` — verified in
   * `…honest-cms/ddb6fc34….jsonl` for `certified-status-fix` and
   * `vehicle-batch` — so the sender name is the join key. It is also the only
   * one available: the block deliberately carries no task id, because that id
   * names the sending agent's task rather than the message.
   */
  const sendMessage = (to: string, summary: string, id: string) =>
    toolUseAssistant("SendMessage", { to, summary, message: "..." }, id)

  it("attaches the SendMessage that answered a peer message", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question"),
      sendMessage("csp-and-proxy", "Answered your question", "sm-1"),
      textAssistant("done"),
    ]))

    const [block] = agentMessages(session.turns[0].contentBlocks)
    expect(block.reply?.summary).toBe("Answered your question")
    expect(block.reply?.timestamp).toBe("2025-01-15T10:00:01Z")
  })

  // `to` is a common enough parameter name that other tools carry it, and agent
  // names are borrowed from the workstream they own — so a channel, an issue
  // queue or a branch can share a sender's exact name. Only `SendMessage`
  // reaches a peer agent, so only `SendMessage` can be a reply.
  it("does not read another tool's `to` argument as a reply", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("docs-sweep", "one blocking question"),
      toolUseAssistant(
        "mcp__slack__slack_send_message",
        { to: "docs-sweep", summary: "posted the recap", message: "..." },
        "slack-1",
      ),
      textAssistant("done"),
    ]))

    const [block] = agentMessages(session.turns[0].contentBlocks)
    expect(block.reply).toBeUndefined()
  })

  it("leaves a message unanswered when the SendMessage targets another sender", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question"),
      sendMessage("someone-else", "unrelated", "sm-1"),
      textAssistant("done"),
    ]))

    const [block] = agentMessages(session.turns[0].contentBlocks)
    expect(block.reply).toBeUndefined()
  })

  // Sending an agent instructions and then hearing back from it is the normal
  // flow. Pairing backwards would label the instruction a reply and mark every
  // inbound message answered before it arrived.
  it("does not pair a SendMessage that preceded the message", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      sendMessage("csp-and-proxy", "go do batch 2", "sm-1"),
      peerAttachment("csp-and-proxy", "one blocking question"),
      textAssistant("done"),
    ]))

    const [block] = agentMessages(session.turns[0].contentBlocks)
    expect(block.reply).toBeUndefined()
  })

  it("pairs two messages from one sender to their two replies oldest-first", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("w", "first"),
      peerAttachment("w", "second"),
      sendMessage("w", "re first", "sm-1"),
      sendMessage("w", "re second", "sm-2"),
      textAssistant("done"),
    ]))

    const blocks = agentMessages(session.turns[0].contentBlocks)
    expect(blocks.map((b) => b.body)).toEqual(["first", "second"])
    expect(blocks.map((b) => b.reply?.summary)).toEqual(["re first", "re second"])
  })

  // Two agents waiting at once is the normal shape of a fan-out, and the
  // replies rarely come back in the order the questions arrived. The queue is
  // per sender for that reason: a single global queue would hand beta's answer
  // to alpha and then find alpha's answer had nothing left to claim.
  it("answers each sender from its own queue when several are outstanding", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("alpha", "alpha's question"),
      peerAttachment("beta", "beta's question"),
      sendMessage("beta", "re beta", "sm-1"),
      sendMessage("alpha", "re alpha", "sm-2"),
      textAssistant("done"),
    ]))

    const blocks = agentMessages(session.turns[0].contentBlocks)
    expect(blocks.map((b) => b.sender)).toEqual(["alpha", "beta"])
    expect(blocks.map((b) => b.reply?.summary)).toEqual(["re alpha", "re beta"])
  })

  // The queue per sender has to drain, not latch. Holding "this sender was
  // answered" instead of "these messages are outstanding" marks every later
  // message from a sender you once replied to as answered.
  it("does not carry a reply over to the same sender's next message", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("vehicle-batch", "first question"),
      sendMessage("vehicle-batch", "re first", "sm-1"),
      peerAttachment("vehicle-batch", "second question"),
      textAssistant("done"),
    ]))

    const blocks = agentMessages(session.turns[0].contentBlocks)
    expect(blocks.map((b) => b.body)).toEqual(["first question", "second question"])
    expect(blocks.map((b) => b.reply?.summary)).toEqual(["re first", undefined])
  })

  // The live path rebuilds only the last turn on each appended line, so the
  // pairing pass inside that rebuild cannot see a message two turns above it.
  // Without a recompute over the joined list, the reply a running session just
  // sent would vanish from the card it answered.
  it("keeps a pairing alive when a later line rebuilds the tail", () => {
    const existing = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("certified-status-fix", "one blocking question"),
      textAssistant("done"),
      userMsg("unrelated"),
      textAssistant("still working"),
    ]))
    expect(agentMessages(existing.turns[0].contentBlocks)[0].reply).toBeUndefined()

    const updated = parseSessionAppend(existing, toJsonl([
      sendMessage("certified-status-fix", "Fixed the type error you flagged", "sm-1"),
    ]))

    const [block] = agentMessages(updated.turns[0].contentBlocks)
    expect(block.reply?.summary).toBe("Fixed the type error you flagged")
  })

  it("pairs a reply that lands in a later turn", () => {
    const session = parseSession(toJsonl([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("vehicle-batch", "half-blocked on a decision"),
      textAssistant("done"),
      userMsg("next"),
      sendMessage("vehicle-batch", "unblocked you", "sm-1"),
      textAssistant("done again"),
    ]))

    const [block] = agentMessages(session.turns[0].contentBlocks)
    expect(block.reply?.summary).toBe("unblocked you")
  })
})

// ── task notifications ────────────────────────────────────────────────────

describe("task notification records", () => {
  beforeEach(() => {
    resetFixtureCounter()
  })

  const NOTIFICATION = "<task-notification>\n<task-id>abc</task-id>\n"
    + "<status>completed</status>\n<summary>Wait for CI completed</summary>\n</task-notification>"

  /** A background task reporting back, as Claude Code 2.1.220+ writes it. */
  function notificationMsg(content = NOTIFICATION, overrides: Record<string, unknown> = {}) {
    return userMsg(content, { origin: { kind: "task-notification" }, ...overrides })
  }

  it("resumes the launching turn instead of opening one of its own", () => {
    const session = parseSession(toJsonl([
      userMsg("Merge the PR when CI passes"),
      textAssistant("Waiting on CI."),
      notificationMsg(),
      textAssistant("CI is green, merged."),
    ]))

    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].contentBlocks.map((b) => b.kind)).toEqual([
      "text",
      "task_notification",
      "text",
    ])
  })

  it("carries the record verbatim so the renderer can parse the notification", () => {
    const session = parseSession(toJsonl([
      userMsg("Merge the PR when CI passes"),
      notificationMsg(),
    ]))

    const block = session.turns[0].contentBlocks.find((b) => b.kind === "task_notification")
    expect(block).toBeDefined()
    if (block?.kind !== "task_notification") return
    expect(block.content).toBe(NOTIFICATION)
  })

  it("recognises a pre-2.1.220 record with no origin by its shape", () => {
    const session = parseSession(toJsonl([
      userMsg("Merge the PR when CI passes"),
      userMsg(NOTIFICATION),
      textAssistant("Merged."),
    ]))

    expect(session.turns).toHaveLength(1)
  })

  it("recognises a notification wrapped in a system-reminder envelope", () => {
    // Claude Code 2.1.234+ wraps background-task notifications this way.
    const session = parseSession(toJsonl([
      userMsg("Merge the PR when CI passes"),
      userMsg(`<system-reminder>\n${NOTIFICATION}\n</system-reminder>`),
      textAssistant("Merged."),
    ]))

    expect(session.turns).toHaveLength(1)
  })

  it("still opens a turn for a prompt that quotes a notification", () => {
    const session = parseSession(toJsonl([
      userMsg("Merge the PR when CI passes"),
      userMsg(`why did this fire?\n${NOTIFICATION}`),
      textAssistant("Because the task finished."),
    ]))

    expect(session.turns).toHaveLength(2)
  })

  it("opens a promptless fragment when the window starts past the launching turn", () => {
    // A paged window can begin mid-conversation; a null userMessage is what
    // `prependTurns` looks for to stitch the halves back together.
    const session = parseSession(toJsonl([
      notificationMsg(),
      textAssistant("CI is green, merged."),
    ]))

    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBeNull()
    expect(session.turns[0].contentBlocks[0].kind).toBe("task_notification")
  })

  it("sums the durations of every stretch the turn worked", () => {
    const session = parseSession(toJsonl([
      userMsg("Merge the PR when CI passes"),
      textAssistant("Waiting on CI."),
      turnDurationMsg(4000),
      notificationMsg(),
      textAssistant("CI is green, merged."),
      turnDurationMsg(1000),
    ]))

    expect(session.turns[0].durationMs).toBe(5000)
  })
})
