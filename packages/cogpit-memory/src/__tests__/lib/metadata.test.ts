import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionMeta, getSessionStatus } from "../../lib/metadata"

const tempDirs: string[] = []

function event(type: string, data: Record<string, unknown> = {}, agentId?: string): string {
  return JSON.stringify({
    type,
    data,
    timestamp: "2026-08-01T12:00:00.000Z",
    ...(agentId ? { agentId } : {}),
  })
}

function sessionFile(...lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cogpit-memory-status-"))
  tempDirs.push(dir)
  const filePath = join(dir, "events.jsonl")
  writeFileSync(filePath, lines.join("\n"))
  return filePath
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Copilot durable session status", () => {
  it("treats a turn ending after a final assistant message as completed", async () => {
    const filePath = sessionFile(
      event("user.message", { content: "Hello" }),
      event("assistant.message", { content: "Done", toolRequests: [] }),
      event("assistant.turn_end", { turnId: "0" }),
    )

    await expect(getSessionStatus(filePath)).resolves.toEqual({ status: "completed" })
  })

  it("uses the preceding root message and ignores nested agent messages", async () => {
    const filePath = sessionFile(
      event("user.message", { content: "Run it" }),
      event("assistant.message", {
        content: "",
        toolRequests: [{ toolCallId: "tool-1", name: "bash", arguments: { command: "pwd" } }],
      }),
      event("assistant.message", { content: "Nested done", toolRequests: [] }, "subagent-1"),
      event("assistant.turn_end", { turnId: "0" }),
    )

    await expect(getSessionStatus(filePath)).resolves.toEqual({ status: "processing" })
  })

  it("moves past a completed permission while its tool resumes", async () => {
    const filePath = sessionFile(
      event("user.message", { content: "Create a file" }),
      event("tool.execution_start", { toolName: "create" }),
      event("permission.requested", { requestId: "path" }),
      event("permission.completed", {
        requestId: "path",
        result: { kind: "approved" },
      }),
    )

    await expect(getSessionStatus(filePath)).resolves.toEqual({ status: "thinking" })
  })

  it("tracks running and completed Copilot subagents in the tail", async () => {
    const running = sessionFile(
      event("user.message", { content: "Delegate this" }),
      event("assistant.message", { toolRequests: [{ name: "task" }] }),
      event("assistant.turn_end", { turnId: "0" }),
      event("subagent.started", { agentDisplayName: "Inspect the parser" }, "subagent-1"),
      event("tool.execution_start", { toolName: "view" }, "subagent-1"),
    )
    const completed = sessionFile(
      event("user.message", { content: "Delegate this" }),
      event("assistant.message", { toolRequests: [{ name: "task" }] }),
      event("assistant.turn_end", { turnId: "0" }),
      event("subagent.started", {}, "subagent-1"),
      event("subagent.completed", {}, "subagent-1"),
    )

    await expect(getSessionStatus(running)).resolves.toEqual({
      status: "awaiting_agents",
      pendingAgents: 1,
      pendingAgentDescriptions: ["Inspect the parser"],
      pendingQueue: 0,
      backgroundAgents: [{ description: "Inspect the parser", startedAt: "2026-08-01T12:00:00.000Z", done: false }],
    })
    await expect(getSessionStatus(completed)).resolves.toEqual({ status: "processing" })
  })
})

describe("Claude session metadata", () => {
  const at = "2026-11-17T12:00:00.000Z"
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "user", sessionId: "claude-1", cwd: "/work/app", timestamp: at, message: { role: "user", content }, ...extra })
  const assistant = (model: string, text: string) =>
    JSON.stringify({ type: "assistant", sessionId: "claude-1", timestamp: at, message: { role: "assistant", model, content: [{ type: "text", text }] } })
  const toolResult = () => user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }])

  it("counts only typed prompts as turns, not tool results", async () => {
    const filePath = sessionFile(
      user("first question about the app"),
      assistant("claude-opus-5-5", "answer"),
      toolResult(),
      toolResult(),
      user("second question about the app"),
    )

    const meta = await getSessionMeta(filePath)

    expect(meta.turnCount).toBe(2)
    expect(meta.lastUserMessage).toBe("second question about the app")
  })

  it("reads the latest prompt and model from the end of a file too large to read whole", async () => {
    const filePath = sessionFile(
      user(`opening prompt ${"x".repeat(70_000)}`),
      assistant("claude-fable-5-2", "early answer"),
      ...Array.from({ length: 40 }, () => toolResult()),
      user("the latest thing I asked"),
      assistant("claude-opus-5-5", "latest answer"),
      toolResult(),
    )

    const meta = await getSessionMeta(filePath)

    expect(meta.lastUserMessage).toBe("the latest thing I asked")
    expect(meta.model).toBe("claude-opus-5-5")
  })
})
