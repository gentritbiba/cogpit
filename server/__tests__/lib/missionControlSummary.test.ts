// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetMissionControlCache, summarizeSession } from "../../lib/missionControlSummary"

let dir: string
let file: string

function assistant(
  content: unknown[],
  usage: Record<string, number> = {},
  timestamp = "2026-08-01T10:00:00.000Z",
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      model: "claude-opus-5",
      content,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
  })
}

function userText(text: string, timestamp = "2026-08-01T10:00:00.000Z"): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    message: { content: [{ type: "text", text }] },
  })
}

function toolResult(id: string, isError = false, timestamp = "2026-08-01T10:00:05.000Z"): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
  })
}

function copilotEvent(
  type: string,
  data: Record<string, unknown>,
  options: { timestamp?: string; agentId?: string } = {},
): string {
  return JSON.stringify({
    type,
    data,
    timestamp: options.timestamp ?? "2026-08-01T10:00:00.000Z",
    ...(options.agentId ? { agentId: options.agentId } : {}),
  })
}

function write(lines: string[]): void {
  writeFileSync(file, lines.join("\n") + "\n")
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-summary-"))
  file = join(dir, "session.jsonl")
  resetMissionControlCache()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("summarizeSession", () => {
  it("returns null for a missing file", async () => {
    expect(await summarizeSession("s", join(dir, "nope.jsonl"))).toBeNull()
  })

  it("accumulates token totals without counting cache reads", async () => {
    // Every call re-reads the whole context, so summing cache reads reports
    // tens of millions for an ordinary session.
    write([
      assistant([{ type: "text", text: "one" }], { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 9_000 }),
      assistant([{ type: "text", text: "two" }], { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 9_000 }),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.tokens.total).toBe(42)
    expect(s!.tokens.cacheRead).toBe(18_000)
  })

  it("reads context pressure from the latest response, not the sum", async () => {
    write([
      assistant([{ type: "text", text: "a" }], { input_tokens: 5, cache_read_input_tokens: 100 }),
      assistant([{ type: "text", text: "b" }], { input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 90 }),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.context!.used).toBe(600)
  })

  it("reports the newest unresolved tool call as the current tool", async () => {
    write([
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }]),
      toolResult("t1"),
      assistant([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test" } }]),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.currentTool).toEqual({ name: "Bash", summary: "bun test" })
  })

  it("clears the current tool once its result arrives", async () => {
    write([
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      toolResult("t1"),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.currentTool).toBeNull()
  })

  it("tracks the tool trail and total call count", async () => {
    write([
      assistant([{ type: "tool_use", id: "1", name: "Read", input: {} }]),
      assistant([{ type: "tool_use", id: "2", name: "Grep", input: {} }]),
      assistant([{ type: "tool_use", id: "3", name: "Edit", input: {} }]),
      assistant([{ type: "tool_use", id: "4", name: "Bash", input: {} }]),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.toolTrail).toEqual(["Grep", "Edit", "Bash"])
    expect(s!.totalToolCalls).toBe(4)
  })

  it("counts real user turns but not the agent's own tool-result loop", async () => {
    write([
      userText("do the thing"),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      toolResult("t1"),
      userText("now do this"),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.turnCount).toBe(2)
  })

  it("computes per-file diffstat from Edit and Write calls", async () => {
    write([
      assistant([{
        type: "tool_use", id: "1", name: "Write",
        input: { file_path: "/x.ts", content: "a\nb\nc\n" },
      }]),
      assistant([{
        type: "tool_use", id: "2", name: "Edit",
        input: { file_path: "/y.ts", old_string: "one\ntwo", new_string: "one\nTWO\nthree" },
      }]),
    ])
    const s = await summarizeSession("s", file)
    const byPath = Object.fromEntries(s!.files.map((f) => [f.path, f]))
    expect(byPath["/x.ts"].additions).toBeGreaterThan(0)
    expect(byPath["/y.ts"].deletions).toBeGreaterThan(0)
    expect(s!.filesTotal.count).toBe(2)
  })

  it("reports net line counts however many times one hunk is re-edited", async () => {
    // Each edit chains onto the previous one, so the file went from "v0" to
    // "v70" — one line changed, not seventy.
    write(
      Array.from({ length: 70 }, (_, i) =>
        assistant([{
          type: "tool_use", id: `e${i}`, name: "Edit",
          input: { file_path: "/chain.ts", old_string: `v${i}`, new_string: `v${i + 1}` },
        }]),
      ),
    )
    const s = await summarizeSession("s", file)
    expect(s!.files).toEqual([{ path: "/chain.ts", additions: 1, deletions: 1 }])
  })

  it("records a failing tool result", async () => {
    write([
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }]),
      toolResult("t1", true),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.lastToolErrored).toBe(true)
  })

  it("derives elapsed time from first and last event", async () => {
    write([
      userText("go", "2026-08-01T10:00:00.000Z"),
      assistant([{ type: "text", text: "done" }], {}, "2026-08-01T10:03:12.000Z"),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.elapsedMs).toBe(192_000)
  })

  it("ignores malformed lines instead of failing the whole session", async () => {
    write([
      "{ not json",
      assistant([{ type: "text", text: "still counted" }], { output_tokens: 3 }),
    ])
    const s = await summarizeSession("s", file)
    expect(s!.tokens.output).toBe(3)
  })

  it("folds Copilot root and nested activity into a useful card", async () => {
    write([
      copilotEvent("session.start", {
        sessionId: "copilot-session",
        selectedModel: "claude-sonnet-4.5",
      }, { timestamp: "2026-08-01T10:00:00.000Z" }),
      copilotEvent("user.message", { content: "Update the file" }, {
        timestamp: "2026-08-01T10:00:01.000Z",
      }),
      copilotEvent("assistant.message", {
        model: "claude-sonnet-4.5",
        content: "I will delegate the edit.",
        toolRequests: [{
          toolCallId: "task-1",
          name: "task",
          arguments: { description: "Update the implementation" },
        }],
      }, { timestamp: "2026-08-01T10:00:02.000Z" }),
      copilotEvent("tool.execution_start", {
        toolCallId: "task-1",
        toolName: "task",
        arguments: { description: "Update the implementation" },
      }),
      copilotEvent("user.message", { content: "Nested prompt" }, { agentId: "agent-1" }),
      copilotEvent("assistant.message", {
        model: "claude-haiku-4.5",
        content: "Nested progress must not replace the root preview.",
        toolRequests: [{
          toolCallId: "edit-1",
          name: "edit",
          arguments: { path: "/workspace/a.ts", old_str: "old", new_str: "new\nline" },
        }],
      }, { agentId: "agent-1" }),
      copilotEvent("tool.execution_start", {
        toolCallId: "edit-1",
        toolName: "edit",
        arguments: { path: "/workspace/a.ts", old_str: "old", new_str: "new\nline" },
      }, { agentId: "agent-1" }),
      copilotEvent("tool.execution_complete", {
        toolCallId: "edit-1",
        success: true,
      }, { agentId: "agent-1" }),
      copilotEvent("tool.execution_complete", { toolCallId: "task-1", success: true }),
      copilotEvent("assistant.usage", {
        model: "claude-sonnet-4.5",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 5,
      }),
      copilotEvent("assistant.usage", {
        model: "claude-haiku-4.5",
        inputTokens: 40,
        outputTokens: 10,
        cacheReadTokens: 8,
        cacheWriteTokens: 2,
      }, { agentId: "agent-1" }),
      copilotEvent("session.shutdown", {
        currentModel: "claude-sonnet-4.5",
        currentTokens: 12_000,
        modelMetrics: {
          "claude-sonnet-4.5": {
            usage: {
              inputTokens: 160,
              outputTokens: 25,
              cacheReadTokens: 40,
              cacheWriteTokens: 10,
            },
          },
          "claude-haiku-4.5": {
            usage: {
              inputTokens: 70,
              outputTokens: 15,
              cacheReadTokens: 20,
              cacheWriteTokens: 5,
            },
          },
        },
      }, { timestamp: "2026-08-01T10:00:09.000Z" }),
    ])

    const s = await summarizeSession("copilot-session", file)
    expect(s).toMatchObject({
      model: "claude-sonnet-4.5",
      turnCount: 1,
      totalToolCalls: 2,
      toolTrail: ["Task", "Edit"],
      currentTool: null,
      lastAssistantText: "I will delegate the edit.",
      lastToolErrored: false,
      tokens: {
        input: 155,
        output: 40,
        cacheRead: 60,
        cacheCreation: 15,
        total: 195,
      },
      context: { used: 12_000 },
      elapsedMs: 9_000,
    })
    expect(s!.files).toEqual([{ path: "/workspace/a.ts", additions: 2, deletions: 1 }])
  })

  it("updates a Copilot current tool when its completion is appended", async () => {
    write([
      copilotEvent("session.start", { selectedModel: "gpt-5" }),
      copilotEvent("user.message", { content: "Run it" }),
      copilotEvent("tool.execution_start", {
        toolCallId: "shell-1",
        toolName: "shell",
        arguments: { command: "bun test" },
      }),
    ])

    const running = await summarizeSession("copilot-session", file)
    expect(running!.currentTool).toEqual({ name: "Bash", summary: "bun test" })

    appendFileSync(file, copilotEvent("tool.execution_complete", {
      toolCallId: "shell-1",
      success: false,
      error: { message: "failed" },
    }) + "\n")

    const completed = await summarizeSession("copilot-session", file)
    expect(completed!.currentTool).toBeNull()
    expect(completed!.lastToolErrored).toBe(true)
    expect(completed!.totalToolCalls).toBe(1)
  })
})

describe("summarizeSession — incremental reads", () => {
  it("folds only appended bytes and matches a cold parse of the same content", async () => {
    write([assistant([{ type: "text", text: "first" }], { output_tokens: 4 })])
    const afterFirst = await summarizeSession("s", file)
    expect(afterFirst!.tokens.output).toBe(4)

    appendFileSync(file, assistant([{ type: "text", text: "second" }], { output_tokens: 6 }) + "\n")
    const incremental = await summarizeSession("s", file)
    expect(incremental!.tokens.output).toBe(10)

    // A fresh accumulator over the identical file must agree.
    resetMissionControlCache()
    const cold = await summarizeSession("s", file)
    expect(cold!.tokens.output).toBe(incremental!.tokens.output)
    expect(cold!.totalToolCalls).toBe(incremental!.totalToolCalls)
  })

  it("does not double-count when nothing was appended", async () => {
    write([assistant([{ type: "text", text: "x" }], { output_tokens: 5 })])
    await summarizeSession("s", file)
    const second = await summarizeSession("s", file)
    expect(second!.tokens.output).toBe(5)
  })

  it("holds back a half-written trailing line until the rest arrives", async () => {
    // A live agent is mid-write when the poll lands; parsing the fragment would
    // drop the event entirely once the remainder appends.
    const complete = assistant([{ type: "text", text: "whole" }], { output_tokens: 7 })
    const split = Math.floor(complete.length / 2)
    writeFileSync(file, complete.slice(0, split))

    const partial = await summarizeSession("s", file)
    expect(partial!.tokens.output).toBe(0)

    appendFileSync(file, complete.slice(split) + "\n")
    const whole = await summarizeSession("s", file)
    expect(whole!.tokens.output).toBe(7)
  })

  it("re-reads from scratch when the file shrinks", async () => {
    write([
      assistant([{ type: "text", text: "a" }], { output_tokens: 10 }),
      assistant([{ type: "text", text: "b" }], { output_tokens: 10 }),
    ])
    await summarizeSession("s", file)

    // Rewritten shorter — the accumulator no longer describes this file.
    write([assistant([{ type: "text", text: "only" }], { output_tokens: 3 })])
    const s = await summarizeSession("s", file)
    expect(s!.tokens.output).toBe(3)
  })
})

describe("summarizeSession — corruption and rewrite guards", () => {
  it("keeps a multi-byte character whole when a poll lands mid-character", async () => {
    // The rocket is 4 UTF-8 bytes. Decoding the two halves separately yields
    // U+FFFD on both sides — JSON.parse survives it, so the damage is silent
    // and permanent for the life of the process.
    const line = assistant([{
      type: "tool_use", id: "t1", name: "Bash", input: { command: "echo 🚀 done" },
    }])
    const bytes = Buffer.from(line + "\n", "utf8")
    const rocket = Buffer.from("🚀", "utf8")
    const split = bytes.indexOf(rocket) + 2 // mid-character

    writeFileSync(file, bytes.subarray(0, split))
    await summarizeSession("s", file)
    appendFileSync(file, bytes.subarray(split))

    const s = await summarizeSession("s", file)
    expect(s!.currentTool).toEqual({ name: "Bash", summary: "echo 🚀 done" })
  })

  it("rebuilds when a file is rewritten to a larger size", async () => {
    // Size alone only catches a shrink. A rewrite that lands larger would keep
    // the old totals and fold the new bytes in at an offset that is now
    // mid-line, leaving the card reporting work that no longer exists.
    write([
      assistant([{ type: "tool_use", id: "a", name: "Bash", input: {} }], { output_tokens: 15 }),
      assistant([{ type: "tool_use", id: "b", name: "Bash", input: {} }], { output_tokens: 15 }),
      assistant([{ type: "tool_use", id: "c", name: "Bash", input: {} }], { output_tokens: 15 }),
      assistant([{ type: "tool_use", id: "d", name: "Bash", input: {} }], { output_tokens: 15 }),
    ])
    const stale = await summarizeSession("s", file)
    expect(stale!.totalToolCalls).toBe(4)

    // One event, padded so the file ends up strictly LARGER than before —
    // otherwise the shrink check catches it and the guard is never exercised.
    const before = statSync(file).size
    write([assistant(
      [{ type: "tool_use", id: "z", name: "Bash", input: { command: "x".repeat(4000) } }],
      { output_tokens: 15 },
    )])
    expect(statSync(file).size).toBeGreaterThan(before)

    const s = await summarizeSession("s", file)
    expect(s!.totalToolCalls).toBe(1)
    expect(s!.tokens.output).toBe(15)
  })

  it("still folds a plain append without re-reading from the start", async () => {
    write([assistant([{ type: "text", text: "one" }], { output_tokens: 4 })])
    await summarizeSession("s", file)
    appendFileSync(file, assistant([{ type: "text", text: "two" }], { output_tokens: 6 }) + "\n")

    const s = await summarizeSession("s", file)
    expect(s!.tokens.output).toBe(10)
  })
})
