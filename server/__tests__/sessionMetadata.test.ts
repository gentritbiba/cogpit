// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest"
import { writeFile, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getCodexSessionIdentity,
  getCopilotSessionIdentity,
  getSessionMeta,
  getSessionStatus,
  searchSessionMessages,
} from "../sessionMetadata"

const cleanups: string[] = []

async function writeSession(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cogpit-meta-test-"))
  cleanups.push(dir)
  const filePath = join(dir, "session.jsonl")
  await writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return filePath
}

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function userLine(text: string, timestamp = "2026-06-10T10:00:00Z") {
  return {
    type: "user",
    sessionId: "s1",
    cwd: "/tmp/proj",
    timestamp,
    message: { role: "user", content: [{ type: "text", text }] },
  }
}

describe("getCodexSessionIdentity", () => {
  it("extracts project and subagent identity from the rollout header", async () => {
    const filePath = await writeSession([
      {
        type: "session_meta",
        payload: {
          id: "codex-sub-1",
          cwd: "/code/cogpit",
          forked_from_id: "codex-parent",
          source: { subagent: { thread_spawn: { agent_path: "/root/scout" } } },
          git: { branch: "feature/cold-load" },
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "ignored" } },
    ])

    await expect(getCodexSessionIdentity(filePath)).resolves.toEqual({
      sessionId: "codex-sub-1",
      cwd: "/code/cogpit",
      gitBranch: "feature/cold-load",
      isSubagent: true,
      parentSessionId: "codex-parent",
    })
  })

  it("returns null for non-Codex JSONL", async () => {
    const filePath = await writeSession([userLine("regular Claude session")])
    await expect(getCodexSessionIdentity(filePath)).resolves.toBeNull()
  })
})

describe("Copilot session metadata", () => {
  it("extracts identity and list metadata from durable Copilot events", async () => {
    const filePath = await writeSession([
      {
        type: "session.start",
        timestamp: "2026-08-31T10:00:00Z",
        data: {
          sessionId: "8b62e405-4685-4548-8fa8-35ea66337737",
          copilotVersion: "0.0.350",
          selectedModel: "gpt-5.1",
          context: { cwd: "/code/copilot-project", branch: "feat/copilot" },
        },
      },
      {
        type: "user.message",
        timestamp: "2026-08-31T10:00:01Z",
        data: { content: "add Copilot support" },
      },
      {
        type: "session.title_changed",
        timestamp: "2026-08-31T10:00:02Z",
        data: { title: "Add Copilot support" },
      },
    ])

    await expect(getCopilotSessionIdentity(filePath)).resolves.toEqual({
      sessionId: "8b62e405-4685-4548-8fa8-35ea66337737",
      cwd: "/code/copilot-project",
      gitBranch: "feat/copilot",
      isSubagent: false,
      parentSessionId: null,
    })
    const meta = await getSessionMeta(filePath)
    expect(meta).toMatchObject({
      sessionId: "8b62e405-4685-4548-8fa8-35ea66337737",
      cwd: "/code/copilot-project",
      gitBranch: "feat/copilot",
      model: "gpt-5.1",
      name: "Add Copilot support",
      firstUserMessage: "add Copilot support",
      turnCount: 1,
    })
    await expect(searchSessionMessages(filePath, "Copilot")).resolves.toContain("add Copilot support")
  })

  it("derives live and completed status from root Copilot events", async () => {
    const live = await writeSession([
      { type: "session.start", data: { sessionId: "s1", context: { cwd: "/tmp" } } },
      { type: "user.message", data: { content: "run tests" } },
      { type: "tool.execution_start", data: { toolName: "shell" } },
    ])
    await expect(getSessionStatus(live)).resolves.toEqual({ status: "tool_use", toolName: "shell" })

    const done = await writeSession([
      { type: "session.start", data: { sessionId: "s2", context: { cwd: "/tmp" } } },
      { type: "user.message", data: { content: "run tests" } },
      { type: "assistant.message", data: { content: "All tests passed" } },
      { type: "assistant.turn_end", data: {} },
      { type: "session.title_changed", data: { title: "Run tests" } },
    ])
    await expect(getSessionStatus(done)).resolves.toEqual({ status: "completed" })
  })

  it("reports an interrupted Copilot tool turn as completed", async () => {
    const filePath = await writeSession([
      { type: "session.start", data: { sessionId: "s1", context: { cwd: "/tmp" } } },
      { type: "user.message", data: { content: "run a long command" } },
      { type: "assistant.message", data: { toolRequests: [{ name: "shell" }] } },
      { type: "tool.execution_start", data: { toolName: "shell" } },
      { type: "abort", data: {} },
      { type: "assistant.turn_end", data: {} },
    ])

    await expect(getSessionStatus(filePath)).resolves.toEqual({ status: "completed" })
  })

  it("moves past a completed Copilot permission while its tool resumes", async () => {
    const filePath = await writeSession([
      { type: "session.start", data: { sessionId: "s1", context: { cwd: "/tmp" } } },
      { type: "user.message", data: { content: "create a file" } },
      { type: "tool.execution_start", data: { toolName: "create" } },
      { type: "permission.requested", data: { requestId: "path" } },
      {
        type: "permission.completed",
        data: { requestId: "path", result: { kind: "approved" } },
      },
    ])

    await expect(getSessionStatus(filePath)).resolves.toEqual({ status: "thinking" })
  })

  it("reports awaiting agents for an external Copilot session with a running subagent", async () => {
    const filePath = await writeSession([
      { type: "session.start", data: { sessionId: "s1", context: { cwd: "/tmp" } } },
      { type: "user.message", data: { content: "delegate this" } },
      { type: "assistant.message", data: { toolRequests: [{ name: "task" }] } },
      { type: "assistant.turn_end", data: {} },
      {
        type: "subagent.started",
        agentId: "agent-1",
        data: { agentDisplayName: "Inspect the parser" },
      },
      { type: "tool.execution_start", agentId: "agent-1", data: { toolName: "view" } },
    ])

    await expect(getSessionStatus(filePath)).resolves.toEqual({
      status: "awaiting_agents",
      pendingAgents: 1,
      pendingAgentDescriptions: ["Inspect the parser"],
      pendingQueue: 0,
    })
  })

  it("does not keep a completed external Copilot subagent pending", async () => {
    const filePath = await writeSession([
      { type: "session.start", data: { sessionId: "s1", context: { cwd: "/tmp" } } },
      { type: "user.message", data: { content: "delegate this" } },
      { type: "assistant.message", data: { toolRequests: [{ name: "task" }] } },
      { type: "assistant.turn_end", data: {} },
      { type: "subagent.started", agentId: "agent-1", data: {} },
      { type: "subagent.completed", agentId: "agent-1", data: {} },
    ])

    await expect(getSessionStatus(filePath)).resolves.toEqual({ status: "processing" })
  })
})

describe("getSessionMeta agent detection", () => {
  /**
   * Detection now runs through the shared format registry rather than a
   * hand-rolled copy of it, which was missing a third of the Copilot event
   * namespace. A transcript that opens on one of those events used to fall
   * through to the Claude reader and come back shaped wrong.
   */
  it.each([
    ["user_input.requested", { id: "q1" }],
    ["permission.requested", { toolCallId: "t1" }],
    ["subagent.started", { agentId: "a1" }],
  ])("reads a transcript opening on %s as Copilot", async (type, data) => {
    const filePath = await writeSession([
      { type, data, timestamp: "2026-08-01T10:00:00.000Z" },
      { type: "user.message", data: { content: "hello" }, timestamp: "2026-08-01T10:00:01.000Z" },
    ])

    const meta = await getSessionMeta(filePath)
    // The Copilot reader reports the last event time; the Claude reader, which
    // used to take this file, reports nothing at all.
    expect(meta.lastTimestamp).toBe("2026-08-01T10:00:01.000Z")
    expect(meta.turnCount).toBe(1)
  })

  it("still reads an untagged transcript as Claude", async () => {
    const filePath = await writeSession([
      { type: "user", sessionId: "claude-1", message: { content: "hello" } },
    ])

    const meta = await getSessionMeta(filePath)
    expect(meta.sessionId).toBe("claude-1")
  })
})

describe("getSessionMeta ai-title support", () => {
  it("extracts the AI-generated title from ai-title events", async () => {
    const filePath = await writeSession([
      userLine("please fix the login flow for me"),
      { type: "ai-title", aiTitle: "Fix login flow", sessionId: "s1" },
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.aiTitle).toBe("Fix login flow")
    expect(meta.firstUserMessage).toBe("please fix the login flow for me")
  })

  it("uses the most recent ai-title when the session was retitled", async () => {
    const filePath = await writeSession([
      userLine("please fix the login flow for me"),
      { type: "ai-title", aiTitle: "Fix login flow", sessionId: "s1" },
      userLine("now add tests too"),
      { type: "ai-title", aiTitle: "Fix login flow and add tests", sessionId: "s1" },
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.aiTitle).toBe("Fix login flow and add tests")
  })

  it("returns an empty aiTitle for sessions without ai-title events", async () => {
    const filePath = await writeSession([userLine("hello there friend")])
    const meta = await getSessionMeta(filePath)
    expect(meta.aiTitle).toBe("")
  })

  it("finds an ai-title beyond the 32KB head window in large sessions (partial read)", async () => {
    // Pad past the 64KB partial-read threshold AND the 32KB head window with
    // filler assistant lines, then place the ai-title after the padding so
    // only the backward tail scan can find it.
    const filler = Array.from({ length: 40 }, (_, i) => ({
      type: "assistant",
      sessionId: "s1",
      message: {
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: `filler ${i} ` + "x".repeat(2000) }],
      },
    }))
    const filePath = await writeSession([
      userLine("kick off a really long session"),
      ...filler,
      { type: "ai-title", aiTitle: "Long session title", sessionId: "s1" },
      userLine("one more message", "2026-06-10T11:00:00Z"),
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.aiTitle).toBe("Long session title")
  })
})

describe("getSessionMeta turn count", () => {
  it("counts prompts, not the user records Claude Code writes around them", async () => {
    const filePath = await writeSession([
      userLine("first request"),
      {
        type: "user",
        sessionId: "s1",
        timestamp: "2026-06-10T10:00:01Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      },
      {
        type: "user",
        sessionId: "s1",
        timestamp: "2026-06-10T10:00:02Z",
        origin: { kind: "task-notification" },
        message: {
          role: "user",
          content: "<task-notification><task-id>abc</task-id></task-notification>",
        },
      },
      userLine("second request", "2026-06-10T10:00:03Z"),
    ])

    const meta = await getSessionMeta(filePath)

    expect(meta.turnCount).toBe(2)
  })

  it("never titles a session with a background task's report", async () => {
    const filePath = await writeSession([
      userLine("build the importer"),
      {
        type: "user",
        sessionId: "s1",
        timestamp: "2026-06-10T10:00:02Z",
        origin: { kind: "task-notification" },
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>",
        },
      },
    ])

    const meta = await getSessionMeta(filePath)

    expect(meta.lastUserMessage).toBe("build the importer")
  })
})

describe("getSessionMeta agent-team tags", () => {
  it("extracts teamName and agentName from teammate session lines", async () => {
    const filePath = await writeSession([
      { type: "agent-setting", agentSetting: "claude-code-guide", sessionId: "s1" },
      {
        ...userLine("<teammate-message teammate_id=\"team-lead\">do research</teammate-message>"),
        teamName: "session-ad264e74",
        agentName: "cc-research",
      },
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.teamName).toBe("session-ad264e74")
    expect(meta.agentName).toBe("cc-research")
  })

  it("returns empty team tags for regular sessions", async () => {
    const filePath = await writeSession([userLine("hello there friend")])
    const meta = await getSessionMeta(filePath)
    expect(meta.teamName).toBe("")
    expect(meta.agentName).toBe("")
  })
})

describe("getSessionMeta worktree and agent-setting records", () => {
  function worktreeState(overrides: Record<string, unknown> = {}) {
    return {
      type: "worktree-state",
      sessionId: "s1",
      worktreeSession: {
        originalCwd: "/tmp/proj",
        preEnterOriginalCwd: "/tmp/proj",
        worktreePath: "/tmp/proj/.claude/worktrees/mission-control",
        worktreeName: "mission-control",
        worktreeBranch: "worktree-mission-control",
        originalBranch: "master",
        originalHeadCommit: "0be44047b9c9b48400c9952c996225ec69002e2e",
        sessionId: "s1",
        ...overrides,
      },
    }
  }

  it("extracts worktree identity from a worktree-state record", async () => {
    const filePath = await writeSession([
      worktreeState(),
      userLine("work on the mission control panel"),
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.worktreeName).toBe("mission-control")
    expect(meta.worktreeBranch).toBe("worktree-mission-control")
    expect(meta.originalBranch).toBe("master")
  })

  it("uses the most recent worktree-state when the session moved worktrees", async () => {
    const filePath = await writeSession([
      worktreeState(),
      userLine("first task"),
      worktreeState({ worktreeName: "cc-catchup", worktreeBranch: "worktree-cc-catchup" }),
      userLine("second task"),
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.worktreeName).toBe("cc-catchup")
    expect(meta.worktreeBranch).toBe("worktree-cc-catchup")
  })

  it("extracts the launch agent type from an agent-setting record", async () => {
    const filePath = await writeSession([
      { type: "agent-setting", agentSetting: "general-purpose", sessionId: "s1" },
      userLine("go research the parser"),
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.agentSetting).toBe("general-purpose")
  })

  it("keeps the first agent-setting when the record repeats", async () => {
    const filePath = await writeSession([
      { type: "agent-setting", agentSetting: "general-purpose", sessionId: "s1" },
      userLine("go research the parser"),
      { type: "agent-setting", agentSetting: "explore", sessionId: "s1" },
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.agentSetting).toBe("general-purpose")
  })

  it("leaves both undefined for sessions without either record", async () => {
    const filePath = await writeSession([userLine("hello there friend")])
    const meta = await getSessionMeta(filePath)
    expect(meta.worktreeName).toBeUndefined()
    expect(meta.worktreeBranch).toBeUndefined()
    expect(meta.originalBranch).toBeUndefined()
    expect(meta.agentSetting).toBeUndefined()
  })

  it("survives partial and malformed sidecar records", async () => {
    const filePath = await writeSession([
      { type: "worktree-state", sessionId: "s1" },
      { type: "worktree-state", sessionId: "s1", worktreeSession: null },
      { type: "worktree-state", sessionId: "s1", worktreeSession: "not-an-object" },
      { type: "agent-setting", sessionId: "s1" },
      userLine("still parses the rest of the session"),
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.worktreeName).toBeUndefined()
    expect(meta.agentSetting).toBeUndefined()
    expect(meta.firstUserMessage).toBe("still parses the rest of the session")
  })

  it("clears worktree identity once the session leaves the worktree", async () => {
    const filePath = await writeSession([
      worktreeState(),
      userLine("work in the worktree"),
      { type: "worktree-state", sessionId: "s1", worktreeSession: null },
      userLine("back on master"),
    ])
    const meta = await getSessionMeta(filePath)
    expect(meta.worktreeName).toBeUndefined()
    expect(meta.originalBranch).toBeUndefined()
  })
})

describe("getSessionStatus background agents", () => {
  const endTurn = { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [] } }

  function asyncLaunch(toolUseId: string, agentId: string, description: string) {
    return {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Async agent launched successfully." }],
      },
      toolUseResult: { isAsync: true, status: "async_launched", agentId, description },
    }
  }

  it("keeps scanning past the decision point to find pending background launches", async () => {
    const filePath = await writeSession([
      userLine("kick off the agents"),
      asyncLaunch("tu1", "ag1", "Explore the parser"),
      // Ordinary tool activity between the launch and the end of the turn —
      // a single-phase scan would stop at the tool_result user line below.
      { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "file contents" }] } },
      endTurn,
    ])

    const status = await getSessionStatus(filePath)
    expect(status.status).toBe("awaiting_agents")
    expect(status.pendingAgents).toBe(1)
    expect(status.pendingAgentDescriptions).toEqual(["Explore the parser"])
  })

  it("returns completed once the launch has a task-notification", async () => {
    const filePath = await writeSession([
      userLine("kick off the agents"),
      asyncLaunch("tu1", "ag1", "Explore the parser"),
      endTurn,
      {
        type: "user",
        message: { role: "user", content: "<task-notification>\n<task-id>ag1</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>completed</status>\n</task-notification>" },
      },
      endTurn,
    ])

    const status = await getSessionStatus(filePath)
    expect(status.status).toBe("completed")
  })

  it("reports awaiting_agents for a Codex session with running collab agents", async () => {
    const filePath = await writeSession([
      { type: "session_meta", payload: { id: "codex-1", cwd: "/tmp/proj" } },
      { type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "c1", arguments: "{\"message\":\"go\",\"task_name\":\"researcher\"}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "{\"agent_id\":\"agA\",\"task_name\":\"/root/researcher\"}" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ])

    const status = await getSessionStatus(filePath)
    expect(status.status).toBe("awaiting_agents")
    expect(status.pendingAgents).toBe(1)
  })

  it("reports completed for a Codex session whose collab agents finished", async () => {
    const filePath = await writeSession([
      { type: "session_meta", payload: { id: "codex-1", cwd: "/tmp/proj" } },
      { type: "response_item", payload: { type: "function_call", name: "spawn_agent", call_id: "c1", arguments: "{\"message\":\"go\"}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "{\"agent_id\":\"agA\"}" } },
      { type: "response_item", payload: { type: "function_call", name: "wait_agent", call_id: "c2", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "{\"status\":{\"agA\":{\"completed\":\"done\"}}}" } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ])

    const status = await getSessionStatus(filePath)
    expect(status.status).toBe("completed")
  })
})
