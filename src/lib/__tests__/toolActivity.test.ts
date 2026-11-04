import { describe, expect, it } from "vitest"
import type { ThinkingBlock, ToolCall } from "../../../shared/session/types"
import {
  activitySentence,
  summarizeToolActivity,
  toolCallFailed,
  toolActivityEntries,
  toolVerb,
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

  it("counts the commands that drive a crew as crew calls", () => {
    const summary = summarizeToolActivity([
      call("start", "Bash", { input: { command: "cogpit-session new \"Fix the tests\" --name lane" } }),
      call("wait", "Bash", { input: { command: "cogpit-session wait 01a11695-2938-7ec2-9d9c-0c8af023bd5f" } }),
      call("status", "Bash", { input: { command: "git status" } }),
    ])
    expect(summary.text).toBe("2 crew calls · 1 command")
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
      total: 0, completed: 0, awaitingReview: 0, failed: 0, running: 0, unavailable: 0,
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
  it("keeps an edit awaiting review visible outside the live tail", () => {
    const calls = [call("review", "Edit", { awaitingReview: true }), ...Array.from({ length: 5 }, (_, i) => call(String(i)))]
    expect(summarizeToolActivity(calls, true)).toMatchObject({ completed: 5, awaitingReview: 1, running: 0 })
    const { visible } = visibleToolActivity(toolActivityEntries(calls), true, true)
    expect(visible).toContainEqual({ kind: "tool_call", toolCall: calls[0] })
  })
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

describe("toolVerb", () => {
  it("opens a finished call's row with what it did", () => {
    expect(toolVerb("Read file", false)).toBe("Read")
    expect(toolVerb("Run command", false)).toBe("Ran")
    expect(toolVerb("Edit file", false)).toBe("Edited")
    expect(toolVerb("Apply patch", false)).toBe("Edited")
    expect(toolVerb("Search web", false)).toBe("Searched the web")
  })

  it("speaks in the present while the call runs", () => {
    expect(toolVerb("Read file", true)).toBe("Reading")
    expect(toolVerb("Run command", true)).toBe("Running")
    expect(toolVerb("Edit file", true)).toBe("Editing")
    expect(toolVerb("Spawn agent", true)).toBe("Starting agent")
  })

  it("keeps a tool's own label when it has no verb, in either tense", () => {
    expect(toolVerb("mcp__linear__create_issue", false)).toBe("mcp__linear__create_issue")
    expect(toolVerb("mcp__linear__create_issue", true)).toBe("mcp__linear__create_issue")
    // Past-only verbs fall back to the label while running rather than claiming completion.
    expect(toolVerb("Capture page", true)).toBe("Capture page")
  })
})

describe("activitySentence", () => {
  it("reads a group's operations as one sentence, in the order they first ran", () => {
    const summary = summarizeToolActivity([
      call("shell-one", "Bash"),
      call("read-one"),
      call("shell-two", "functions.exec_command"),
      call("read-two"),
      call("edit", "Edit"),
    ])
    expect(activitySentence(summary)).toBe("Ran 2 commands, read 2 files, made 1 edit")
  })

  it("counts singular operations in words", () => {
    const summary = summarizeToolActivity([call("search", "Grep"), call("read")])
    expect(activitySentence(summary)).toBe("Searched once, read 1 file")
  })

  it("adds the time spent thinking, rounded to seconds", () => {
    const summary = summarizeToolActivity([call("shell", "Bash")])
    expect(activitySentence(summary, 4_400, 2)).toBe("Ran 1 command, thought for 4s")
  })

  it("says it thought when thinking was too short to time and nothing else ran", () => {
    expect(activitySentence(summarizeToolActivity([]), 0, 1)).toBe("Thought")
    expect(activitySentence(summarizeToolActivity([call("read")]), 300, 1)).toBe("Read 1 file")
  })

  it("names tools without a phrase by their label and count", () => {
    const summary = summarizeToolActivity([call("a", "mcp__linear__list"), call("b", "mcp__linear__list")])
    expect(activitySentence(summary)).toBe(`Used ${summary.groups[0]!.label} ×2`)
  })

  it("falls back to a neutral word for an empty group", () => {
    expect(activitySentence(summarizeToolActivity([]))).toBe("Worked")
  })
})
