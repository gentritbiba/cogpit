import { describe, expect, it } from "vitest"
import {
  createPullRequestScanner,
  extractPullRequests,
  mergePullRequests,
  type SessionPullRequest,
} from "../../../shared/session/prLinks"
import type { ToolCall } from "../../../shared/session/types"
import { emptyTurn } from "@/__tests__/fixtures"

function scanPullRequests(jsonlText: string): SessionPullRequest[] {
  const scanner = createPullRequestScanner()
  scanner.scan(jsonlText.endsWith("\n") ? jsonlText : `${jsonlText}\n`)
  return scanner.pullRequests
}

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tool-1",
    name: "Bash",
    input: {},
    result: null,
    isError: false,
    timestamp: "2026-08-14T10:00:00.000Z",
    ...overrides,
  }
}

const turn = (toolCalls: ToolCall[]) => emptyTurn({ toolCalls, timestamp: "2026-08-14T10:00:00.000Z" })

function createCall(command: string, result: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return toolCall({ input: { command }, result, ...overrides })
}

describe("extractPullRequests", () => {
  it("returns nothing for a session with no turns", () => {
    expect(extractPullRequests([])).toEqual([])
  })

  it("extracts number, repo and url from a gh pr create call", () => {
    const prs = extractPullRequests([
      turn([createCall(
        'gh pr create --base master --head team-edition --title "Team Edition"',
        "https://github.com/gentritbiba/cogpit/pull/13\n",
      )]),
    ])

    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({
      url: "https://github.com/gentritbiba/cogpit/pull/13",
      number: 13,
      repo: "gentritbiba/cogpit",
      title: "Team Edition",
      isDraft: false,
    })
  })

  it("reads the title from a single-quoted --title flag", () => {
    const prs = extractPullRequests([
      turn([createCall(
        "gh pr create --title 'Fix the thing' --body ''",
        "https://github.com/o/r/pull/4",
      )]),
    ])
    expect(prs[0].title).toBe("Fix the thing")
  })

  it("reads the title from the --title=value form", () => {
    const prs = extractPullRequests([
      turn([createCall("gh pr create --title=quickfix", "https://github.com/o/r/pull/5")]),
    ])
    expect(prs[0].title).toBe("quickfix")
  })

  it("reads the title from the -t shorthand", () => {
    const prs = extractPullRequests([
      turn([createCall('gh pr create -t "Short flag"', "https://github.com/o/r/pull/6")]),
    ])
    expect(prs[0].title).toBe("Short flag")
  })

  it("leaves the title null when the command has no title flag", () => {
    const prs = extractPullRequests([
      turn([createCall("gh pr create --fill", "https://github.com/o/r/pull/7")]),
    ])
    expect(prs[0].title).toBeNull()
  })

  it("detects a create invocation chained after cd", () => {
    const prs = extractPullRequests([
      turn([createCall(
        "cd /Users/me/project && gh pr create --fill",
        "https://github.com/o/r/pull/8",
      )]),
    ])
    expect(prs).toHaveLength(1)
  })

  it("detects a create invocation prefixed with env assignments", () => {
    const prs = extractPullRequests([
      turn([createCall("GH_TOKEN=abc gh pr create --fill", "https://github.com/o/r/pull/9")]),
    ])
    expect(prs).toHaveLength(1)
  })

  it("flags draft pull requests", () => {
    const prs = extractPullRequests([
      turn([createCall('gh pr create --draft --title "WIP"', "https://github.com/o/r/pull/10")]),
    ])
    expect(prs[0].isDraft).toBe(true)
  })

  it("ignores commands that only mention gh pr create inside a quoted argument", () => {
    const prs = extractPullRequests([
      turn([createCall(
        'grep -l "gh pr create" *.jsonl',
        "https://github.com/gentritbiba/cogpit/pull/11\nhttps://github.com/gentritbiba/cogpit/pull/13",
      )]),
    ])
    expect(prs).toEqual([])
  })

  it("ignores gh pr view output because it did not create the pull request", () => {
    const prs = extractPullRequests([
      turn([createCall("gh pr view 13 --json url", '{"url":"https://github.com/o/r/pull/13"}')]),
    ])
    expect(prs).toEqual([])
  })

  it("ignores the git push hint url that points at the pull request compare page", () => {
    const prs = extractPullRequests([
      turn([createCall(
        "gh pr create --fill",
        "remote: Create a pull request for 'feat' on GitHub by visiting:\nremote:   https://github.com/o/r/pull/new/feat",
      )]),
    ])
    expect(prs).toEqual([])
  })

  it("ignores failed create calls", () => {
    const prs = extractPullRequests([
      turn([createCall(
        "gh pr create --fill",
        "a pull request already exists: https://github.com/o/r/pull/12",
        { isError: true },
      )]),
    ])
    expect(prs).toEqual([])
  })

  it("ignores create calls that produced no output yet", () => {
    const prs = extractPullRequests([
      turn([toolCall({ input: { command: "gh pr create --fill" }, result: null })]),
    ])
    expect(prs).toEqual([])
  })

  it("reads Codex array-form shell commands", () => {
    const prs = extractPullRequests([
      turn([toolCall({
        name: "shell",
        input: { command: ["bash", "-lc", 'gh pr create --title "From Codex"'] },
        result: "https://github.com/o/r/pull/21",
      })]),
    ])
    expect(prs[0]).toMatchObject({ number: 21, title: "From Codex" })
  })

  it("reads Codex exec_command input under the cmd key", () => {
    const prs = extractPullRequests([
      turn([toolCall({ input: { cmd: "gh pr create --fill" }, result: "https://github.com/o/r/pull/22" })]),
    ])
    expect(prs[0].number).toBe(22)
  })

  it("keeps one entry per pull request url across repeated calls", () => {
    const call = createCall("gh pr create --fill", "https://github.com/o/r/pull/30")
    const prs = extractPullRequests([turn([call]), turn([{ ...call, id: "tool-2" }])])
    expect(prs).toHaveLength(1)
  })

  it("returns multiple pull requests in creation order", () => {
    const prs = extractPullRequests([
      turn([createCall("gh pr create --fill", "https://github.com/o/r/pull/1")]),
      turn([createCall("gh pr create --fill", "https://github.com/o/r/pull/2")]),
    ])
    expect(prs.map((pr) => pr.number)).toEqual([1, 2])
  })

  it("carries the originating tool call id and timestamp", () => {
    const prs = extractPullRequests([
      turn([createCall("gh pr create --fill", "https://github.com/o/r/pull/40", {
        id: "toolu_abc",
        timestamp: "2026-08-14T11:22:33.000Z",
      })]),
    ])
    expect(prs[0]).toMatchObject({ toolCallId: "toolu_abc", timestamp: "2026-08-14T11:22:33.000Z" })
  })
})

// -- JSONL scanning (server-side, whole-file) --

const CLAUDE_CREATE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-08-14T10:00:00.000Z",
  message: {
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { command: 'gh pr create --title "Windows support"' },
    }],
  },
})

const CLAUDE_RESULT = JSON.stringify({
  type: "user",
  timestamp: "2026-08-14T10:00:05.000Z",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "https://github.com/o/r/pull/11\n",
    }],
  },
})

const CODEX_CREATE = JSON.stringify({
  type: "response_item",
  timestamp: "2026-08-14T11:00:00.000Z",
  payload: {
    type: "function_call",
    call_id: "call_1",
    name: "shell",
    arguments: JSON.stringify({ command: ["bash", "-lc", 'gh pr create --title "From Codex"'] }),
  },
})

const CODEX_RESULT = JSON.stringify({
  type: "response_item",
  timestamp: "2026-08-14T11:00:05.000Z",
  payload: { type: "function_call_output", call_id: "call_1", output: "https://github.com/o/r/pull/22" },
})

const COPILOT_CREATE = JSON.stringify({
  type: "tool.execution_start",
  id: "event-1",
  timestamp: "2026-08-14T12:00:00.000Z",
  data: {
    toolCallId: "call-copilot",
    toolName: "shell",
    arguments: { command: 'gh pr create --title "From Copilot"' },
  },
})

const COPILOT_RESULT = JSON.stringify({
  type: "tool.execution_complete",
  id: "event-2",
  timestamp: "2026-08-14T12:00:05.000Z",
  data: {
    toolCallId: "call-copilot",
    success: true,
    result: { content: "https://github.com/o/r/pull/33" },
  },
})

describe("scanPullRequests", () => {
  it("returns nothing for an empty file", () => {
    expect(scanPullRequests("")).toEqual([])
  })

  it("pairs a Claude tool_use with its tool_result", () => {
    const prs = scanPullRequests(`${CLAUDE_CREATE}\n${CLAUDE_RESULT}\n`)
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({
      number: 11,
      repo: "o/r",
      title: "Windows support",
      toolCallId: "toolu_1",
      timestamp: "2026-08-14T10:00:00.000Z",
    })
  })

  it("pairs a Codex function_call with its output", () => {
    const prs = scanPullRequests(`${CODEX_CREATE}\n${CODEX_RESULT}\n`)
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({ number: 22, title: "From Codex", toolCallId: "call_1" })
  })

  it("pairs Copilot tool events with their output", () => {
    const prs = scanPullRequests(`${COPILOT_CREATE}\n${COPILOT_RESULT}\n`)
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({
      number: 33,
      title: "From Copilot",
      toolCallId: "call-copilot",
    })
  })

  it("finds a pull request created midway through a long file", () => {
    const filler = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `line ${i}` }] } })).join("\n")
    const prs = scanPullRequests(`${filler}\n${CLAUDE_CREATE}\n${CLAUDE_RESULT}\n${filler}\n`)
    expect(prs.map((pr) => pr.number)).toEqual([11])
  })

  it("ignores a result whose tool_use was not a create invocation", () => {
    const view = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "gh pr view 11" } }] },
    })
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "https://github.com/o/r/pull/11" }] },
    })
    expect(scanPullRequests(`${view}\n${result}\n`)).toEqual([])
  })

  it("ignores a create whose result reported an error", () => {
    const failed = JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
          content: "already exists: https://github.com/o/r/pull/11",
        }],
      },
    })
    expect(scanPullRequests(`${CLAUDE_CREATE}\n${failed}\n`)).toEqual([])
  })

  it("reads tool_result content given as text blocks", () => {
    const blocks = JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "https://github.com/o/r/pull/99" }],
        }],
      },
    })
    expect(scanPullRequests(`${CLAUDE_CREATE}\n${blocks}\n`)[0].number).toBe(99)
  })

  it("skips malformed lines without throwing", () => {
    const prs = scanPullRequests(`{not json\n${CLAUDE_CREATE}\n\n${CLAUDE_RESULT}\n`)
    expect(prs).toHaveLength(1)
  })

  it("ignores a quoted mention of the create command", () => {
    const grep = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: 'grep -r "gh pr create" .' } }],
      },
    })
    const output = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "https://github.com/o/r/pull/11" }] },
    })
    expect(scanPullRequests(`${grep}\n${output}\n`)).toEqual([])
  })
})

describe("createPullRequestScanner", () => {
  it("finds a pull request split across two chunks", () => {
    const scanner = createPullRequestScanner()
    scanner.scan(`${CLAUDE_CREATE}\n`)
    expect(scanner.pullRequests).toEqual([])
    scanner.scan(`${CLAUDE_RESULT}\n`)
    expect(scanner.pullRequests.map((pr) => pr.number)).toEqual([11])
  })

  it("buffers a line delivered in fragments", () => {
    const scanner = createPullRequestScanner()
    const half = Math.floor(CLAUDE_CREATE.length / 2)
    scanner.scan(CLAUDE_CREATE.slice(0, half))
    scanner.scan(`${CLAUDE_CREATE.slice(half)}\n`)
    scanner.scan(`${CLAUDE_RESULT}\n`)
    expect(scanner.pullRequests.map((pr) => pr.number)).toEqual([11])
  })

  it("does not emit the same pull request twice", () => {
    const scanner = createPullRequestScanner()
    scanner.scan(`${CLAUDE_CREATE}\n${CLAUDE_RESULT}\n`)
    scanner.scan(`${CLAUDE_RESULT}\n`)
    expect(scanner.pullRequests).toHaveLength(1)
  })
})

describe("mergePullRequests", () => {
  const a = { url: "https://github.com/o/r/pull/1", number: 1, repo: "o/r", title: null, isDraft: false, toolCallId: "t1", timestamp: "2026-08-14T10:00:00.000Z" }
  const b = { url: "https://github.com/o/r/pull/2", number: 2, repo: "o/r", title: "Second", isDraft: false, toolCallId: "t2", timestamp: "2026-08-14T11:00:00.000Z" }

  it("returns the union ordered by creation time", () => {
    expect(mergePullRequests([b], [a]).map((pr) => pr.number)).toEqual([1, 2])
  })

  it("deduplicates by url and prefers the first source", () => {
    const stale = { ...a, title: "stale" }
    const merged = mergePullRequests([a], [stale])
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toBeNull()
  })

  it("tolerates missing sources", () => {
    expect(mergePullRequests([a], undefined)).toEqual([a])
    expect(mergePullRequests(undefined, undefined)).toEqual([])
  })
})

// -- Native pr-link records --

function prLink(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "pr-link",
    sessionId: "s1",
    prNumber: 100,
    prUrl: "https://github.com/HonestCMS/cms/pull/100",
    prRepository: "HonestCMS/cms",
    timestamp: "2026-07-28T20:37:34.139Z",
    ...overrides,
  })
}

describe("pr-link records", () => {
  it("records a pull request the transcript names directly", () => {
    const prs = scanPullRequests(`${prLink()}\n`)
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({
      url: "https://github.com/HonestCMS/cms/pull/100",
      number: 100,
      repo: "HonestCMS/cms",
      title: null,
      isDraft: false,
      toolCallId: "",
      timestamp: "2026-07-28T20:37:34.139Z",
    })
  })

  it("records a GitLab merge request, which the GitHub url pattern never matches", () => {
    const prs = scanPullRequests(`${prLink({
      prNumber: 7,
      prUrl: "https://gitlab.com/group/proj/-/merge_requests/7",
      prRepository: "group/proj",
    })}\n`)
    expect(prs).toEqual([
      expect.objectContaining({
        url: "https://gitlab.com/group/proj/-/merge_requests/7",
        number: 7,
        repo: "group/proj",
      }),
    ])
  })

  it("keeps one entry for a pull request found by both the create command and the record", () => {
    const link = prLink({ prNumber: 11, prUrl: "https://github.com/o/r/pull/11", prRepository: "o/r" })
    const prs = scanPullRequests(`${CLAUDE_CREATE}\n${CLAUDE_RESULT}\n${link}\n`)
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({ number: 11, title: "Windows support", toolCallId: "toolu_1" })
  })

  it("ignores a record with no usable url or number", () => {
    expect(scanPullRequests(`${prLink({ prUrl: "" })}\n`)).toEqual([])
    expect(scanPullRequests(`${prLink({ prNumber: null })}\n`)).toEqual([])
  })

  it("does not mistake a pull request mentioned by some other record type", () => {
    const mention = JSON.stringify({
      type: "summary",
      summary: "opened pr-link https://github.com/o/r/pull/50",
      prUrl: "https://github.com/o/r/pull/50",
      prNumber: 50,
    })
    expect(scanPullRequests(`${mention}\n`)).toEqual([])
  })

  it("finds a record delivered in a later chunk", () => {
    const scanner = createPullRequestScanner()
    scanner.scan(`${prLink()}`)
    expect(scanner.pullRequests).toEqual([])
    scanner.scan("\n")
    expect(scanner.pullRequests.map((pr) => pr.number)).toEqual([100])
  })
})
