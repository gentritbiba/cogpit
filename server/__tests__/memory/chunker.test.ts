// @vitest-environment node
import { describe, expect, it } from "vitest"
import { chunkSession, MAX_CHUNK_CHARS, splitText } from "../../../shared/memory/chunker"
import { renderComposerMessage } from "../../../shared/session/composerContext"
import type { SubAgentMessage } from "../../../shared/session/types"
import { makeSession } from "./helpers"

function subAgent(agentId: string, text: string): SubAgentMessage {
  return {
    agentId,
    agentName: null,
    subagentType: null,
    type: "assistant",
    content: null,
    toolCalls: [],
    thinking: [],
    text: [text],
    timestamp: "2026-11-01T10:05:00.000Z",
    tokenUsage: null,
    model: null,
    isBackground: false,
  }
}

describe("splitText", () => {
  it("keeps a short text whole", () => {
    expect(splitText("one paragraph", 50)).toEqual(["one paragraph"])
  })

  it("cuts at paragraph breaks before lines, sentences and words", () => {
    const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}`
    expect(splitText(text, 40)).toEqual(["a".repeat(30), "b".repeat(30)])
    expect(splitText("First sentence here. Second sentence here.", 30)).toEqual(["First sentence here.", "Second sentence here."])
  })

  it("hard-cuts a text with no boundary and never splits a surrogate pair", () => {
    const pieces = splitText(`${"x".repeat(9)}😀${"y".repeat(10)}`, 10)
    expect(pieces.join("")).toBe(`${"x".repeat(9)}😀${"y".repeat(10)}`)
    expect(pieces[0]).toBe("x".repeat(9))
    expect(pieces.every((piece) => piece.length <= 10)).toBe(true)
  })
})

describe("chunkSession", () => {
  it("chunks prompts, replies, thinking and summaries per block with their own timestamps", () => {
    const session = makeSession([
      { user: "How do we deploy?", thinking: "Consider the pipeline", assistant: "Through the release workflow.", compactionSummary: "Earlier we set up CI." },
    ])
    const chunks = chunkSession(session)
    expect(chunks.map((chunk) => [chunk.kind, chunk.block, chunk.part, chunk.text])).toEqual([
      ["compaction", 0, 0, "Earlier we set up CI."],
      ["user", 1, 0, "How do we deploy?"],
      ["thinking", 2, 0, "Consider the pipeline"],
      ["assistant", 3, 0, "Through the release workflow."],
    ])
    expect(chunks.every((chunk) => chunk.turn === 0 && chunk.turnId === "turn-0")).toBe(true)
    expect(chunks[1].timestamp).toBe("2026-11-01T10:00:00.000Z")
  })

  it("splits a long reply into several parts of one block", () => {
    const paragraph = "word ".repeat(300).trim()
    const chunks = chunkSession(makeSession([{ assistant: [paragraph, paragraph, paragraph].join("\n\n") }]))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.part)).toEqual(chunks.map((_, index) => index))
    expect(new Set(chunks.map((chunk) => chunk.block)).size).toBe(1)
    expect(chunks.every((chunk) => chunk.text.length <= MAX_CHUNK_CHARS)).toBe(true)
  })

  it("strips composer context from prompts and marks automated prompts", () => {
    const typed = renderComposerMessage({
      text: "Why does this fail?",
      context: [{ id: "ctx-abcd1234", kind: "terminal", label: "bash", text: "huge terminal dump" }],
    })
    const chunks = chunkSession(makeSession([
      { user: typed },
      { user: "Crew chat · lead · message 4\nPlease pick up the next task" },
    ]))
    expect(chunks.map((chunk) => [chunk.text, chunk.automated])).toEqual([
      ["Why does this fail?", false],
      ["Crew chat · lead · message 4\nPlease pick up the next task", true],
    ])
  })

  it("indexes inline subagent text only when the subagent has no transcript of its own", () => {
    const session = makeSession([{
      user: "Investigate",
      blocks: [{ kind: "sub_agent", messages: [subAgent("with-file", "from the file"), subAgent("inline-only", "only inline")] }],
    }])
    const chunks = chunkSession(session, { hasSubagentTranscript: (agentId) => agentId === "with-file" })
    expect(chunks.filter((chunk) => chunk.inlineAgentId).map((chunk) => [chunk.inlineAgentId, chunk.text])).toEqual([
      ["inline-only", "only inline"],
    ])
  })

  it("keeps plans, recaps and messages from other agents, and skips machine output", () => {
    const chunks = chunkSession(makeSession([{
      blocks: [
        { kind: "plan_mode", plan: "1. Add the store", status: "approved", toolCalls: [] },
        { kind: "recap", content: "We added the store." },
        { kind: "agent_message", sender: "reviewer", body: "Looks good" },
        { kind: "task_notification", content: "<task-notification>done</task-notification>" },
        { kind: "local_command", content: "<local-command-stdout>usage</local-command-stdout>" },
      ],
    }]))
    expect(chunks.map((chunk) => [chunk.kind, chunk.automated])).toEqual([
      ["plan", false],
      ["recap", false],
      ["agent_message", true],
    ])
  })
})
