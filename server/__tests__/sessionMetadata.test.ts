// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest"
import { writeFile, rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCodexSessionIdentity, getSessionMeta, getSessionStatus } from "../sessionMetadata"

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
