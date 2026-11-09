// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = vi.hoisted(() => ({
  filePath: "",
  kind: "claude" as "claude" | "codex",
  requests: [] as string[],
  /** Answers like a server from before turn pages, which ignores `unit=turns`. */
  linePagesOnly: false,
  /** Canned answers, in place of the real routes. */
  answer: null as ((url: string) => Record<string, unknown>) | null,
}))
vi.mock("../../../server/sessionPaths", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../server/sessionPaths")>(),
  resolveSessionFilePath: vi.fn(async () => state.filePath),
}))
vi.mock("../../../server/agents", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../server/agents")>(),
  storeForPath: () => ({ kind: state.kind }),
}))
vi.mock("../../../server/lib/sessionArchive", () => ({
  archiveReason: () => null,
  readArchive: async () => ({ archived: new Map(), kept: new Set() }),
  setSessionsArchived: vi.fn().mockResolvedValue([]),
}))
// The client's requests go to the real page and tool-result routes.
vi.mock("@/lib/auth", () => ({
  authFetch: async (requested: string) => {
    state.requests.push(requested)
    if (state.answer) return new Response(JSON.stringify(state.answer(requested)))
    const url = state.linePagesOnly ? requested.replace("&unit=turns", "") : requested
    const route = url.startsWith("/api/tool-result/") ? "/api/tool-result/" : "/api/sessions/"
    const handler = getRouteHandler(collectRoutes(url.startsWith("/api/tool-result/") ? registerToolResultRoutes : registerProjectRoutes), route)
    const { req, res, next } = createMockReqRes("GET", url.slice(route.length))
    await handler(req, res, next)
    return new Response(res._getData(), { status: res._getStatus() })
  },
}))

import { collectRoutes, createMockReqRes, getRouteHandler } from "../../../server/__tests__/http-fixtures"
import { registerProjectRoutes } from "../../../server/routes/projects"
import { registerToolResultRoutes } from "../../../server/routes/tool-result"
import { setDataRoot } from "../../../server/config"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { formatFor } from "../../../shared/session/agents"
import { textAssistant, toJsonl, toolUseAssistant, userMsg } from "../../__tests__/fixtures"
import { fetchBodyChunk } from "@/lib/toolResultBodies"
import { loadSubagentReturn, parseSubagentJsonl, RETURN_READ_BACK_BYTES } from "@/hooks/useSubagentContent"
import type { SubAgentMessage } from "../../../shared/session/types"

const roots: string[] = []
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "cogpit-subagent-return-"))
  roots.push(root)
  setDataRoot(root)
  state.requests = []
  state.linePagesOnly = false
  state.answer = null
})
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const PAD = "p".repeat(1500)
const BIG = Array.from({ length: 4000 }, (_, i) => `row ${i} ${"z".repeat(12)}`).join("\n")

function writeTranscript(kind: "claude" | "codex", text: string): string {
  state.kind = kind
  state.filePath = join(roots[0]!, "agent.jsonl")
  writeFileSync(state.filePath, text + "\n")
  const dirName = kind === "claude" ? "proj-a" : descriptorFor("codex").dirName.encode("/workspace")
  return `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent("parent-1")}/subagents/agent-${encodeURIComponent("a1")}.jsonl`
}

/** `count` tool round trips, each line padded so a short tail holds only the newest. */
function claudeTools(count: number, from = 0): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => [
    toolUseAssistant("Bash", { command: `step ${from + i} ${PAD}` }, `t-${from + i}`),
    userMsg([{ type: "tool_result", tool_use_id: `t-${from + i}`, content: `ok ${PAD}` }]),
  ]).flat()
}

const load = (url: string) => loadSubagentReturn(url, "a1", formatFor(state.kind))
const returnOf = (messages: SubAgentMessage[]) => messages.findLast((m) => m.text.length > 0)?.text

describe("loadSubagentReturn", () => {
  it("reads only a short projected tail when it ends with the agent's return", async () => {
    const text = toJsonl([
      userMsg("Do the task"),
      textAssistant("Starting out"),
      ...claudeTools(120),
      toolUseAssistant("Bash", { command: "dump" }, "heavy"),
      userMsg([{ type: "tool_result", tool_use_id: "heavy", content: BIG }]),
      textAssistant("All done: the answer"),
    ])
    const url = writeTranscript("claude", text)

    const messages = (await load(url))!

    expect(state.requests).toEqual([`${url}?tail=1&projection=results-v1`])
    expect(returnOf(messages)).toEqual(["All done: the answer"])
    expect(returnOf(messages)).toEqual(returnOf(parseSubagentJsonl(text, "a1")))
    // The transcript's opening lines travel as its header, never as the newest messages.
    expect(messages.some((m) => m.text.includes("Starting out"))).toBe(false)
    expect(messages.length).toBeLessThan(parseSubagentJsonl(text, "a1").length)
  })

  it("lifts an elided result onto its call, and the body opens at the sub-agent's address", async () => {
    const url = writeTranscript("claude", toJsonl([
      userMsg("Do the task"),
      ...claudeTools(40),
      toolUseAssistant("Bash", { command: "dump" }, "heavy"),
      userMsg([{ type: "tool_result", tool_use_id: "heavy", content: BIG }]),
      textAssistant("Done"),
    ]))

    const messages = (await load(url))!
    const heavy = messages.flatMap((m) => m.toolCalls).find((call) => call.id === "heavy")!

    expect(heavy.resultRef).toMatchObject({ bytes: BIG.length, source: { fileName: "parent-1/subagents/agent-a1.jsonl" } })
    expect(heavy.result!.length).toBeLessThan(BIG.length)
    const body = await fetchBodyChunk(heavy.resultRef!, 0)
    expect(body).toMatchObject({ text: BIG, total: BIG.length })
  })

  it("pages back a turn at a time when the tail holds no return", async () => {
    const text = toJsonl([
      userMsg("Do the task"),
      ...claudeTools(20),
      textAssistant("Found it, still checking"),
      ...claudeTools(60, 20),
    ])
    const url = writeTranscript("claude", text)

    const messages = (await load(url))!

    expect(returnOf(messages)).toEqual(["Found it, still checking"])
    expect(state.requests).toHaveLength(2)
    expect(state.requests[1]).toMatch(/\?before=\d+&count=1&unit=turns&projection=results-v1$/)
    expect(messages).toHaveLength(parseSubagentJsonl(text, "a1").length)
  })

  it("parses a small transcript whole, its header lines once", async () => {
    const text = toJsonl([userMsg("Do the task"), textAssistant("Starting out"), ...claudeTools(2), textAssistant("Done")])
    const url = writeTranscript("claude", text)

    const messages = (await load(url))!

    expect(state.requests).toHaveLength(1)
    expect(messages.map((m) => [m.text, m.toolCalls.map((call) => call.result)]))
      .toEqual(parseSubagentJsonl(text, "a1").map((m) => [m.text, m.toolCalls.map((call) => call.result)]))
  })

  it("reads a sub-agent's last turn whole when its text spans more than the tail", async () => {
    const record = (type: string, payload: Record<string, unknown>) => ({ type, timestamp: "2026-07-15T10:00:00Z", payload })
    const say = (text: string) => record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] })
    const turn = (id: string, prompt: string) => [
      record("turn_context", { turn_id: id, model: "gpt-5", cwd: "/workspace" }),
      record("event_msg", { type: "user_message", message: prompt }),
    ]
    const tools = (from: number) => Array.from({ length: 30 }, (_, i) => [
      record("response_item", { type: "function_call", call_id: `c-${from + i}`, name: "shell", arguments: JSON.stringify({ command: ["ls", PAD] }) }),
      record("response_item", { type: "function_call_output", call_id: `c-${from + i}`, output: `ok ${PAD}` }),
    ]).flat()
    const text = toJsonl([
      record("session_meta", { id: "a1", cwd: "/workspace", source: { subagent: { thread_spawn: { agent_path: "/root/worker" } } } }),
      ...turn("t1", "First task"),
      say("First answer"),
      ...turn("t2", "Second task"),
      say("Looking into it"),
      ...tools(0),
      say("Halfway"),
      ...tools(30),
      say("Final answer"),
    ])
    const url = writeTranscript("codex", text)

    const messages = (await load(url))!

    expect(returnOf(messages)).toEqual(["Looking into it", "Halfway", "Final answer"])
    expect(returnOf(messages)).toEqual(returnOf(parseSubagentJsonl(text, "a1")))
    expect(state.requests[1]).toMatch(/\?before=\d+&count=1&unit=turns&projection=results-v1$/)
    expect(messages.some((m) => m.text.includes("First answer"))).toBe(false)
  })

  it("drops only the page's own copy of the prologue, never a later line equal to it (review #6)", async () => {
    const greeting = JSON.stringify(textAssistant("Hello"))
    const lines = [greeting, JSON.stringify(userMsg("Do the task")), JSON.stringify(textAssistant("Working")), greeting]
    state.answer = () => ({ headerLines: [greeting], tailLines: lines, byteOffset: 0, totalSize: 500, hasMore: false })
    // A format whose first turn starts after the opening line, so that line is the prologue.
    const format = { pageCuts: () => [1] }

    const messages = (await loadSubagentReturn("/api/sessions/proj-a/parent-1/subagents/agent-a1.jsonl", "a1", format))!

    expect(messages.map((m) => m.text)).toEqual([["Hello"], ["Working"], ["Hello"]])
  })

  it("takes the first text it finds as the return when the server pages by lines (review #7)", async () => {
    state.linePagesOnly = true
    const results = (count: number) => Array.from({ length: count }, () => userMsg([{ type: "tool_result", tool_use_id: "none", content: `ok ${PAD}` }]))
    const text = toJsonl([userMsg("Do the task"), textAssistant("Earlier"), ...results(200), textAssistant("All done"), ...results(6)])
    const url = writeTranscript("claude", text)

    const messages = (await load(url))!

    expect(returnOf(messages)).toEqual(["All done"])
    expect(messages.some((m) => m.text.includes("Earlier"))).toBe(false)
  })

  it("stops following a return up a cut turn after a bounded read (review #7)", async () => {
    const step = 400 * 1024
    const tailOffset = 50 * 1024 * 1024
    const say = JSON.stringify(textAssistant("Done"))
    const note = JSON.stringify(userMsg([{ type: "tool_result", tool_use_id: "x", content: "ok" }]))
    state.answer = (url) => {
      const before = /before=(\d+)/.exec(url)
      if (!before) return { headerLines: [], tailLines: [say], byteOffset: tailOffset, totalSize: tailOffset + 100, hasMore: true }
      return { lines: [note], byteOffset: Number(before[1]) - step, hasMore: true, unit: "turns", cutTurn: true }
    }

    const messages = (await load("/api/sessions/proj-a/parent-1/subagents/agent-a1.jsonl"))!

    expect(returnOf(messages)).toEqual(["Done"])
    expect(state.requests).toHaveLength(1 + Math.ceil(RETURN_READ_BACK_BYTES / step))
  })

  it("reports a transcript the server refuses", async () => {
    writeTranscript("claude", toJsonl([userMsg("x")]))
    expect(await loadSubagentReturn("/api/sessions/proj-a/parent-1/subagents/agent-a1.txt", "a1", formatFor("claude"))).toBeNull()
  })
})
