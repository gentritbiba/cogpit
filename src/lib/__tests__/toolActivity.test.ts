import { describe, expect, it } from "vitest"
import type { ThinkingBlock, ToolCall } from "../../../shared/session/types"
import {
  summarizeToolActivity,
  toolCallFailed,
  toolActivityEntries,
  visibleToolActivity,
} from "../toolActivity"

function call(id: string, name = "Read", overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    name,
    input: {},
    result: "ok",
    isError: false,
    timestamp: "2026-09-13T12:00:00Z",
    ...overrides,
  }
}

function thought(thinking: string): ThinkingBlock {
  return { type: "thinking", thinking, signature: thinking }
}

function partialShellFailure(name = "Bash", commandKey = "command"): ToolCall {
  return call("partial-failure", name, {
    input: { [commandKey]: "echo ---READ; cat missing.ts; echo ---NEXT; ls src" },
    result: "---READ\ncat: missing.ts: No such file or directory\n---NEXT\nindex.ts",
  })
}

describe("toolCallFailed", () => {
  it("retains an explicit failure even without output", () => {
    expect(toolCallFailed(call("failed", "Read", { isError: true, result: null }))).toBe(true)
  })

  it("detects a failed command hidden by a successful final command in a shell batch", () => {
    expect(toolCallFailed(partialShellFailure())).toBe(true)
    expect(toolCallFailed(partialShellFailure("functions.exec_command", "cmd"))).toBe(true)
  })

  it("does not interpret arbitrary tool output or source code as shell failures", () => {
    const batch = partialShellFailure()
    expect(toolCallFailed({ ...batch, name: "Read" })).toBe(false)
    expect(toolCallFailed({ ...batch, input: { command: "cat fixture.txt" } })).toBe(false)
    expect(toolCallFailed({ ...batch, name: "exec", input: { raw: 'await tools.exec_command({cmd: "bun test"})' } })).toBe(false)
    expect(toolCallFailed({ ...batch, result: "error: this is text without batch markers" })).toBe(false)
  })

  it("does not fail pending batches, empty successful sections or multiline file contents", () => {
    const batch = partialShellFailure()
    expect(toolCallFailed({ ...batch, result: null })).toBe(false)
    expect(toolCallFailed({ ...batch, result: "---READ\n---NEXT\nindex.ts" })).toBe(false)
    expect(toolCallFailed({ ...batch, result: "---READ\nerror: printed source\nline two\nline three\nline four\n---NEXT\nindex.ts" })).toBe(false)
  })
})

describe("summarizeToolActivity", () => {
  it("combines equivalent operations across tool formats", () => {
    const summary = summarizeToolActivity([
      call("read-one"),
      call("read-two"),
      call("edit", "functions.apply_patch", { input: { raw: "*** Update File: a.ts" } }),
      call("shell-one", "Bash"),
      call("shell-two", "functions.exec_command"),
    ])

    expect(summary.text).toBe("2 reads · 1 edit · 2 commands")
    expect(summary.groups).toEqual([
      { label: "read", count: 2, text: "2 reads" },
      { label: "edit", count: 1, text: "1 edit" },
      { label: "command", count: 2, text: "2 commands" },
    ])
    expect(summary.completed).toBe(5)
  })

  it("uses the operation inside a tool script and readable labels for other tools", () => {
    const summary = summarizeToolActivity([
      call("nested", "exec", { input: { raw: 'await tools.exec_command({cmd: "bun test"})' } }),
      call("native", "Bash"),
      call("external", "mcp__google_drive__list_files"),
    ])

    expect(summary.text).toBe("2 commands · Google Drive ×1")
    expect(summary.text).not.toMatch(/exec|mcp__|Bash/)
  })

  it("keeps failures, running calls, missing results and empty successes distinct", () => {
    const calls = [
      call("success"),
      call("empty", "Read", { result: "" }),
      call("failed", "Read", { isError: true, result: "error" }),
      call("failed-missing", "Read", { isError: true, result: null }),
      call("pending", "Read", { result: null }),
    ]

    expect(summarizeToolActivity(calls, true)).toMatchObject({
      total: 5, completed: 2, failed: 2, running: 1, unavailable: 0,
    })
    expect(summarizeToolActivity(calls, false)).toMatchObject({
      total: 5, completed: 2, failed: 2, running: 0, unavailable: 1,
    })
  })

  it("returns an empty summary without inventing activity", () => {
    expect(summarizeToolActivity([])).toEqual({
      total: 0, completed: 0, failed: 0, running: 0, unavailable: 0,
      groups: [], text: "",
    })
  })

  it("counts a partially failed shell batch as failed instead of completed", () => {
    expect(summarizeToolActivity([partialShellFailure(), call("success")], true)).toMatchObject({
      total: 2, completed: 1, failed: 1, running: 0, unavailable: 0,
    })
  })
})

describe("toolActivityEntries", () => {
  it("flattens batches and thinking blocks without changing chronology or content", () => {
    const first = call("first")
    const second = call("second")
    const third = call("third")
    const thoughts = [thought("Initial thought"), thought("More reasoning")]
    const entries = toolActivityEntries([first, second, third], [
      { kind: "tool_calls", toolCalls: [first, second] },
      { kind: "thinking", blocks: thoughts },
      { kind: "tool_calls", toolCalls: [third] },
    ])

    expect(entries).toEqual([
      { kind: "tool_call", toolCall: first },
      { kind: "tool_call", toolCall: second },
      { kind: "thinking", blocks: [thoughts[0]] },
      { kind: "thinking", blocks: [thoughts[1]] },
      { kind: "tool_call", toolCall: third },
    ])
    expect(entries[2].kind === "thinking" && entries[2].blocks[0]).toBe(thoughts[0])
  })

  it("keeps each call when there is no interleaved activity", () => {
    const calls = [call("first"), call("second")]
    expect(toolActivityEntries(calls)).toEqual(calls.map((toolCall) => ({ kind: "tool_call", toolCall })))
  })
})

describe("visibleToolActivity", () => {
  it("keeps an earlier partially failed shell batch visible", () => {
    const entries = toolActivityEntries([
      partialShellFailure(), call("old-success"), call("one"), call("two"), call("three"),
    ])
    expect(visibleToolActivity(entries, true, true)).toEqual({
      visible: [entries[0], ...entries.slice(-3)], hidden: 1,
    })
  })

  it("limits the live tail by individual entries even inside a single large batch", () => {
    const calls = Array.from({ length: 20 }, (_, index) => call(String(index)))
    const entries = toolActivityEntries(calls, [{ kind: "tool_calls", toolCalls: calls }])
    expect(visibleToolActivity(entries, true, true)).toEqual({
      visible: entries.slice(-3), hidden: 17,
    })
  })

  it("preserves every running and failed call before the recent tail in chronological order", () => {
    const entries = toolActivityEntries([
      call("pending-first", "Read", { result: null }),
      call("older-success"),
      call("failed", "Read", { isError: true }),
      call("pending-second", "Read", { result: null }),
      call("older-success-two"),
      call("recent-one"),
      call("recent-two"),
      call("recent-three"),
    ])

    expect(visibleToolActivity(entries, true, true)).toEqual({
      visible: [entries[0], entries[2], entries[3], ...entries.slice(-3)],
      hidden: 2,
    })
  })

  it("does not treat historical missing output as running", () => {
    const entries = toolActivityEntries([
      call("missing", "Read", { result: null }), call("one"), call("two"), call("three"),
    ])
    expect(visibleToolActivity(entries, true, false)).toEqual({ visible: entries.slice(-3), hidden: 1 })
  })

  it("reveals all thinking and calls when the reader expands the group", () => {
    const thoughts = Array.from({ length: 5 }, (_, index) => thought(`Reason ${index}`))
    const entries = toolActivityEntries([], [{ kind: "thinking", blocks: thoughts }])
    expect(visibleToolActivity(entries, true)).toEqual({ visible: entries.slice(-3), hidden: 2 })
    expect(visibleToolActivity(entries, false)).toEqual({ visible: entries, hidden: 0 })
  })

  it("does not duplicate recent failures or pending calls", () => {
    const entries = toolActivityEntries([
      call("pending", "Read", { result: null }), call("failed", "Read", { isError: true }),
    ])
    expect(visibleToolActivity(entries, true, true)).toEqual({ visible: entries, hidden: 0 })
    expect(visibleToolActivity([], true, true)).toEqual({ visible: [], hidden: 0 })
  })
})
