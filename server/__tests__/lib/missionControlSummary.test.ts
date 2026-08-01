// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
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
