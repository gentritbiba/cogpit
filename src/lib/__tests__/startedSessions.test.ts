import { describe, expect, it } from "vitest"
import { startedSessions } from "../startedSessions"
import type { ToolCall, Turn } from "../../../shared/session/types"
import { emptyTurn } from "@/__tests__/fixtures"

const LANE = "01a11695-2938-7ec2-9d9c-0c8af023bd5f"
const OTHER = "253c3558-5ef4-40ed-8a58-755f4891dbd0"

/** What `cogpit-session new` prints for a session it started. */
function startOutput(sessionId: string): string {
  return JSON.stringify({ sessionId, dirName: "-repo", next: `cogpit-session wait ${sessionId}` })
}

function shell(id: string, command: string, result: string | null): ToolCall {
  return { id, name: "Bash", input: { command }, result, isError: false, timestamp: "2026-08-19T12:00:00.000Z" }
}

describe("startedSessions", () => {
  it("reads each started session's name and provider from the command that started it", () => {
    const turns: Turn[] = [
      emptyTurn({ toolCalls: [shell("a", `cogpit-session new "Audit" --name audit --agent codex`, startOutput(LANE))] }),
      emptyTurn({
        toolCalls: [shell(
          "b",
          `cogpit-session new "One" --name one; cogpit-session new "Two"`,
          ["11111111-2222-4333-8444-555555555555", OTHER].map(startOutput).join("\n"),
        )],
      }),
    ]

    const started = startedSessions(turns)

    expect(started.get(LANE)).toEqual({ name: "audit", kind: "codex" })
    expect(started.get("11111111-2222-4333-8444-555555555555")).toEqual({ name: "one", kind: "claude" })
    expect(started.get(OTHER)).toEqual({ name: undefined, kind: "claude" })
  })

  it("skips starts that have not returned and commands that are not the CLI", () => {
    const turns: Turn[] = [emptyTurn({
      toolCalls: [
        shell("pending", `cogpit-session new "Audit" --name audit`, null),
        shell("cat", "cat start.json", JSON.stringify({ sessionId: LANE })),
      ],
    })]

    expect(startedSessions(turns).size).toBe(0)
  })

  it("never names a session the command only waited on or checked", () => {
    const report = (sessionId: string) => JSON.stringify({ sessionId, outcome: "running" })
    const turns: Turn[] = [emptyTurn({
      toolCalls: [
        shell("wait", `cogpit-session wait ${OTHER}`, report(OTHER)),
        shell("mixed", `cogpit-session status ${OTHER}; cogpit-session new "x" --name lane-b --agent codex`, `${report(OTHER)}\n${startOutput(LANE)}`),
      ],
    })]

    const started = startedSessions(turns)
    expect(started.get(OTHER)).toBeUndefined()
    expect(started.get(LANE)).toEqual({ name: "lane-b", kind: "codex" })
  })

  it("reads a transcript once per update", () => {
    const turns: Turn[] = [emptyTurn({ toolCalls: [shell("a", `cogpit-session new hi`, startOutput(LANE))] })]

    expect(startedSessions(turns)).toBe(startedSessions(turns))
  })
})
