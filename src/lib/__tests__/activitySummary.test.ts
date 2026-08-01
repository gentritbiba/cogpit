import { describe, expect, it } from "vitest"
import {
  classifyShellCommand,
  formatActivitySummary,
  isScratchpadPath,
  summarizeActivity,
} from "../activitySummary"
import type { ToolCall } from "../types"

let idCounter = 0
function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  idCounter += 1
  return {
    id: `tool-${idCounter}`,
    name,
    input,
    result: "ok",
    isError: false,
    timestamp: "2026-08-01T12:00:00.000Z",
  }
}

/** Convenience: summarize then format in one step. */
function summarize(toolCalls: ToolCall[], thoughtForMs = 0): string {
  return formatActivitySummary(summarizeActivity(toolCalls, { thoughtForMs }))
}

const SCRATCHPAD =
  "/private/tmp/claude-501/-Users-someone-proj/0c4c77c4-afa4-4f74-9765-31452fb872fe/scratchpad"

describe("classifyShellCommand", () => {
  it("classifies search commands", () => {
    expect(classifyShellCommand("grep -rn foo src")).toBe("search")
    expect(classifyShellCommand("rg pattern")).toBe("search")
    expect(classifyShellCommand("find . -name '*.ts'")).toBe("search")
    expect(classifyShellCommand("which bun")).toBe("search")
  })

  it("classifies read commands", () => {
    expect(classifyShellCommand("cat package.json")).toBe("read")
    expect(classifyShellCommand("head -20 file.ts")).toBe("read")
    expect(classifyShellCommand("jq '.name' package.json")).toBe("read")
    expect(classifyShellCommand("wc -l src/index.ts")).toBe("read")
  })

  it("classifies list commands", () => {
    expect(classifyShellCommand("ls -la")).toBe("list")
    expect(classifyShellCommand("tree src")).toBe("list")
    expect(classifyShellCommand("du -sh .")).toBe("list")
  })

  it("treats anything else as a shell command", () => {
    expect(classifyShellCommand("bun run test")).toBe("shell")
    expect(classifyShellCommand("git status")).toBe("shell")
    expect(classifyShellCommand("rm -rf build")).toBe("shell")
  })

  it("disqualifies the whole command when any segment is not read-only", () => {
    expect(classifyShellCommand("cd /tmp && cat foo.txt")).toBe("shell")
    expect(classifyShellCommand("cat foo.txt | bun run parse.ts")).toBe("shell")
  })

  it("ignores neutral segments without disqualifying the command", () => {
    expect(classifyShellCommand("echo hi && cat foo.txt")).toBe("read")
    expect(classifyShellCommand("echo hi")).toBe("shell")
  })

  it("prefers list over search over read when segments mix", () => {
    expect(classifyShellCommand("ls src && grep -rn foo src")).toBe("list")
    expect(classifyShellCommand("grep -rn foo src | head -20")).toBe("search")
  })

  it("splits on pipes, semicolons, and boolean operators", () => {
    expect(classifyShellCommand("cat a.txt; cat b.txt")).toBe("read")
    expect(classifyShellCommand("cat a.txt || ls")).toBe("list")
  })
})

describe("isScratchpadPath", () => {
  it("recognizes the session scratchpad directory", () => {
    expect(isScratchpadPath(`${SCRATCHPAD}/extract-code.ts`)).toBe(true)
  })

  it("recognizes the Windows-style claude temp dir", () => {
    expect(
      isScratchpadPath("C:\\Users\\me\\AppData\\Local\\Temp\\claude\\proj\\sid\\scratchpad\\x.ts"),
    ).toBe(true)
  })

  it("rejects ordinary project paths", () => {
    expect(isScratchpadPath("/Users/me/proj/src/index.ts")).toBe(false)
    expect(isScratchpadPath("/Users/me/proj/scratchpad/notes.md")).toBe(false)
  })
})

describe("summarizeActivity", () => {
  it("reproduces the Claude Code CLI example line", () => {
    const summary = summarize([
      call("Write", { file_path: `${SCRATCHPAD}/find.ts`, content: "x\n".repeat(67) + "x" }),
      call("Read", { file_path: "/Users/me/proj/src/index.ts" }),
      call("Bash", { command: "bun run find.ts" }),
      call("Bash", { command: "bun run extract.ts" }),
    ])
    expect(summary).toBe("Made 1 scratchpad edit +68, read 1 file, ran 2 shell commands")
  })

  it("capitalizes only the first clause and joins with commas", () => {
    expect(summarize([call("Read", { file_path: "/a.ts" }), call("Bash", { command: "ls" })])).toBe(
      "Read 1 file, listed 1 directory",
    )
  })

  it("returns an empty summary for no tool calls", () => {
    expect(summarizeActivity([]).clauses).toEqual([])
    expect(summarize([])).toBe("")
  })

  it("counts reads by distinct file path", () => {
    expect(
      summarize([
        call("Read", { file_path: "/a.ts" }),
        call("Read", { file_path: "/a.ts" }),
        call("Read", { file_path: "/b.ts" }),
      ]),
    ).toBe("Read 2 files")
  })

  it("falls back to the operation count when reads have no file path", () => {
    expect(
      summarize([call("Bash", { command: "cat a.ts" }), call("Bash", { command: "cat b.ts" })]),
    ).toBe("Read 2 files")
  })

  it("counts searches as operations", () => {
    expect(
      summarize([
        call("Grep", { pattern: "foo" }),
        call("Glob", { pattern: "**/*.ts" }),
        call("Bash", { command: "rg bar" }),
      ]),
    ).toBe("Searched for 3 patterns")
  })

  it("counts edits by distinct file with net line deltas", () => {
    expect(
      summarize([
        call("Edit", { file_path: "/a.ts", old_string: "one\ntwo", new_string: "one\ntwo\nthree" }),
        call("Write", { file_path: "/b.ts", content: "a\nb\nc" }),
      ]),
    ).toBe("Edited 2 files +4")
  })

  it("reports removals when an edit deletes lines", () => {
    expect(
      summarize([
        call("Edit", { file_path: "/a.ts", old_string: "one\ntwo\nthree", new_string: "one" }),
      ]),
    ).toBe("Edited 1 file -2")
  })

  it("sums multi-edit operations", () => {
    expect(
      summarize([
        call("Edit", {
          file_path: "/a.ts",
          edits: [
            { old_string: "a", new_string: "a\nb" },
            { old_string: "c", new_string: "c\nd" },
          ],
        }),
      ]),
    ).toBe("Edited 1 file +2")
  })

  it("keeps scratchpad writes out of the edit clause", () => {
    expect(
      summarize([
        call("Write", { file_path: `${SCRATCHPAD}/a.ts`, content: "a\nb" }),
        call("Write", { file_path: "/proj/b.ts", content: "c" }),
      ]),
    ).toBe("Edited 1 file +1, made 1 scratchpad edit +2")
  })

  it("groups MCP calls by server", () => {
    expect(
      summarize([
        call("mcp__slack__slack_read_channel", {}),
        call("mcp__slack__slack_search_public", {}),
      ]),
    ).toBe("Called slack 2 times")
  })

  it("prettifies claude.ai MCP server names", () => {
    expect(summarize([call("mcp__claude_ai_Google_Drive__search_files", {})])).toBe(
      "Called Google Drive",
    )
  })

  it("counts agents", () => {
    expect(summarize([call("Task", {}), call("Agent", {})])).toBe("Ran 2 agents")
  })

  it("buckets unrecognized tools into the generic clause", () => {
    expect(summarize([call("WebFetch", {}), call("TodoWrite", {})])).toBe("Called 2 tools")
  })

  it("renders thinking time first", () => {
    expect(summarize([call("Read", { file_path: "/a.ts" })], 12_400)).toBe(
      "Thought for 12s, read 1 file",
    )
  })

  it("floors thinking time at one second", () => {
    expect(summarize([], 200)).toBe("Thought for 1s")
  })

  it("formats thinking time over a minute", () => {
    expect(summarize([], 95_000)).toBe("Thought for 1m 35s")
  })

  it("orders clauses the way the CLI does", () => {
    expect(
      summarize(
        [
          call("Write", { file_path: "/proj/a.ts", content: "a" }),
          call("Write", { file_path: `${SCRATCHPAD}/s.ts`, content: "s" }),
          call("Grep", { pattern: "x" }),
          call("Read", { file_path: "/b.ts" }),
          call("Bash", { command: "ls" }),
          call("mcp__slack__slack_read_channel", {}),
          call("Task", {}),
          call("WebFetch", {}),
          call("Bash", { command: "bun test" }),
        ],
        3_000,
      ),
    ).toBe(
      "Thought for 3s, edited 1 file +1, made 1 scratchpad edit +1, searched for 1 pattern, " +
        "read 1 file, listed 1 directory, called slack, ran 1 agent, called 1 tool, " +
        "ran 1 shell command",
    )
  })

  it("exposes line deltas on the clause for styled rendering", () => {
    const { clauses } = summarizeActivity([
      call("Edit", { file_path: "/a.ts", old_string: "a\nb", new_string: "a" }),
    ])
    expect(clauses).toEqual([{ key: "edit", text: "edited 1 file", added: 0, removed: 1 }])
  })
})
