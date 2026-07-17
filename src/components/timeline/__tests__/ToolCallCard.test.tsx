import { describe, it, expect, vi, beforeAll } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { getToolSummary, ToolCallCard } from "../ToolCallCard"
import type { ToolCall } from "@/lib/types"
import type { SkillMeta } from "@/hooks/useSkillMetadata"

// Mock authFetch — needed when "Open SKILL.md" button is clicked / answer submission
const mockAuthFetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })
vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetchFn(...args),
  isRemoteClient: vi.fn().mockReturnValue(false),
}))

// Mock useSessionContext — used by ToolCallCard for sessionId
const mockSession = { sessionId: "test-session-id" }
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: vi.fn(() => ({ session: mockSession })),
}))

// Mock shiki (syntax highlighting) to avoid async side-effects in tests
vi.mock("@/lib/shiki", () => ({
  highlightCode: vi.fn().mockResolvedValue([]),
  getLangFromPath: vi.fn().mockReturnValue(null),
}))

// Mock window.matchMedia — required by useIsMobile
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

function makeToolCall(name: string, input: Record<string, unknown>): ToolCall {
  return {
    id: "test-id",
    name,
    input,
    result: null,
    isError: false,
    timestamp: new Date().toISOString(),
  }
}

describe("getToolSummary", () => {
  it("Monitor: returns bash_id and filter", () => {
    expect(getToolSummary(makeToolCall("Monitor", { bash_id: "abc", filter: "ERROR" }))).toBe("abc · filter=ERROR")
  })

  it("Monitor: returns bash_id without filter when filter is absent", () => {
    expect(getToolSummary(makeToolCall("Monitor", { bash_id: "abc" }))).toBe("abc")
  })

  it("CronCreate: returns schedule arrow prompt", () => {
    expect(getToolSummary(makeToolCall("CronCreate", { schedule: "0 */6 * * *", prompt: "/babysit-prs" }))).toBe("0 */6 * * * → /babysit-prs")
  })

  it("CronList: returns empty string", () => {
    expect(getToolSummary(makeToolCall("CronList", {}))).toBe("")
  })

  it("CronDelete: returns id", () => {
    expect(getToolSummary(makeToolCall("CronDelete", { id: "cron_123" }))).toBe("cron_123")
  })

  it("ScheduleWakeup: returns human-friendly delay and reason", () => {
    expect(getToolSummary(makeToolCall("ScheduleWakeup", { delaySeconds: 1800, reason: "polling deploy" }))).toBe("in 30m · polling deploy")
  })

  it("ScheduleWakeup: formats hours correctly", () => {
    expect(getToolSummary(makeToolCall("ScheduleWakeup", { delaySeconds: 3600, reason: "hourly check" }))).toBe("in 1h · hourly check")
  })

  it("ScheduleWakeup: formats seconds correctly", () => {
    expect(getToolSummary(makeToolCall("ScheduleWakeup", { delaySeconds: 45, reason: "quick poll" }))).toBe("in 45s · quick poll")
  })

  it("RemoteTrigger: returns action and id", () => {
    expect(getToolSummary(makeToolCall("RemoteTrigger", { action: "run", id: "trig_42" }))).toBe("run trig_42")
  })

  it("PushNotification: returns title", () => {
    expect(getToolSummary(makeToolCall("PushNotification", { title: "Build done", body: "..." }))).toBe("Build done")
  })

  it("EnterWorktree: returns name with path", () => {
    expect(getToolSummary(makeToolCall("EnterWorktree", { name: "fix-auth", branch: "feat/auth", path: "/x/y" }))).toBe("fix-auth (/x/y)")
  })

  it("ExitWorktree: returns name", () => {
    expect(getToolSummary(makeToolCall("ExitWorktree", { name: "fix-auth" }))).toBe("fix-auth")
  })

  it("Skill: returns skill name", () => {
    expect(getToolSummary(makeToolCall("Skill", { skill: "commit", args: "" }))).toBe("commit")
  })

  it("ToolSearch: returns query", () => {
    expect(getToolSummary(makeToolCall("ToolSearch", { query: "select:Read", max_results: 5 }))).toBe("select:Read")
  })
})

describe("ToolCallCard Skill rendering", () => {
  it("shows source label when skillMetadata is provided", () => {
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["commit", { source: "user", description: "Create a commit", filePath: "/home/user/.claude/skills/commit/SKILL.md" }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} expandAll={false} skillMetadata={skillMeta} />)

    expect(screen.getByText(/source: user/)).toBeTruthy()
  })

  it("shows Open SKILL.md button when filePath is available", () => {
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["commit", { source: "user", filePath: "/home/user/.claude/skills/commit/SKILL.md" }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} expandAll={false} skillMetadata={skillMeta} />)

    expect(screen.getByText("Open SKILL.md")).toBeTruthy()
  })

  it("calls authFetch with correct path when Open SKILL.md is clicked", () => {
    mockAuthFetchFn.mockClear()

    const filePath = "/home/user/.claude/skills/commit/SKILL.md"
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["commit", { source: "user", filePath }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} expandAll={false} skillMetadata={skillMeta} />)

    const btn = screen.getByText("Open SKILL.md")
    fireEvent.click(btn)

    expect(mockAuthFetchFn).toHaveBeenCalledWith(
      "/api/open-in-editor",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: filePath }),
      }),
    )
  })

  it("does not show source label when skillMetadata is absent", () => {
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} expandAll={false} />)

    expect(screen.queryByText(/source:/)).toBeNull()
    expect(screen.queryByText("Open SKILL.md")).toBeNull()
  })

  it("does not show Open SKILL.md button when filePath is empty", () => {
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["simplify", { source: "built-in", filePath: "" }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "simplify", args: "" })

    render(<ToolCallCard toolCall={toolCall} expandAll={false} skillMetadata={skillMeta} />)

    expect(screen.getByText(/source: built-in/)).toBeTruthy()
    expect(screen.queryByText("Open SKILL.md")).toBeNull()
  })
})

describe("ToolCallCard hook badge rendering", () => {
  it("shows 'hook' badge when outputReplacedByHook is true", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "x.ts" }),
      outputReplacedByHook: true,
    }

    render(<ToolCallCard toolCall={toolCall} expandAll={false} />)

    expect(screen.getByText("hook")).toBeTruthy()
  })

  it("shows hook duration when hookDurationMs is set and > 0", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Bash", { command: "ls" }),
      hookDurationMs: 42,
    }

    render(<ToolCallCard toolCall={toolCall} expandAll={false} />)

    expect(screen.getByText("42ms")).toBeTruthy()
  })

  it("shows both 'hook' badge and duration when both fields are set", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Bash", { command: "ls" }),
      outputReplacedByHook: true,
      hookDurationMs: 99,
    }

    render(<ToolCallCard toolCall={toolCall} expandAll={false} />)

    expect(screen.getByText("hook")).toBeTruthy()
    expect(screen.getByText("99ms")).toBeTruthy()
  })

  it("does not show 'hook' badge when outputReplacedByHook is not set", () => {
    const toolCall = makeToolCall("Read", { file_path: "x.ts" })

    render(<ToolCallCard toolCall={toolCall} expandAll={false} />)

    expect(screen.queryByText("hook")).toBeNull()
  })

  it("does not show duration when hookDurationMs is not set", () => {
    const toolCall = makeToolCall("Read", { file_path: "x.ts" })

    render(<ToolCallCard toolCall={toolCall} expandAll={false} />)

    expect(screen.queryByText(/ms$/)).toBeNull()
  })

  it("does not show duration when hookDurationMs is 0", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "x.ts" }),
      hookDurationMs: 0,
    }

    render(<ToolCallCard toolCall={toolCall} expandAll={false} />)

    expect(screen.queryByText("0ms")).toBeNull()
  })
})

describe("ToolCallCard Bash input rendering", () => {
  it("renders Bash input as a readable command card", () => {
    const toolCall = makeToolCall("Bash", {
      command: "cd /workspace && npm test",
      description: "Run the focused test suite",
      timeout: 600_000,
    })

    render(<ToolCallCard toolCall={toolCall} expandAll={true} />)

    expect(screen.getByLabelText("Bash command").textContent).toContain("cd /workspace && npm test")
    expect(screen.getByText("Run the focused test suite")).toBeTruthy()
    expect(screen.getByText("10 min")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy()
    expect(screen.queryByText('"command"')).toBeNull()
  })

  it("shows execution mode and additional Bash options", () => {
    const toolCall = makeToolCall("Bash", {
      cmd: "npm run build",
      run_in_background: true,
      sandbox: "strict",
    })

    render(<ToolCallCard toolCall={toolCall} expandAll={true} />)

    expect(screen.getByLabelText("Bash command").textContent).toContain("npm run build")
    expect(screen.getByText("Background")).toBeTruthy()
    expect(screen.getByText("Sandbox")).toBeTruthy()
    expect(screen.getByText("strict")).toBeTruthy()
  })
})

describe("ToolCallCard Codex exec input rendering", () => {
  it("renders the raw Codex orchestration as readable code", () => {
    const script = `const r = await tools.exec_command({
  cmd: "npm test",
  workdir: "/workspace/cogpit",
  yield_time_ms: 10000,
  max_output_tokens: 20000
});
text(r.output);`
    const toolCall = makeToolCall("exec", { raw: script })

    render(<ToolCallCard toolCall={toolCall} expandAll={true} />)

    const renderedScript = screen.getByLabelText("Codex exec script")
    expect(renderedScript.textContent).toContain("tools.exec_command")
    expect(renderedScript.children.length).toBeGreaterThan(1)
    expect(screen.getByText("Exec command")).toBeTruthy()
    expect(screen.getByText("/workspace/cogpit")).toBeTruthy()
    expect(screen.getByText("10 sec")).toBeTruthy()
    expect(screen.getByText("20,000 tokens")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy script" })).toBeTruthy()
    expect(screen.queryByText('"raw"')).toBeNull()
  })

  it("supports namespaced Codex exec tool names", () => {
    const toolCall = makeToolCall("functions.exec", {
      raw: 'const r = await tools.view_image({ path: "/tmp/screenshot.png" });\nimage(r.image_url);',
    })

    render(<ToolCallCard toolCall={toolCall} expandAll={true} />)

    expect(screen.getByLabelText("Codex exec script").textContent).toContain("tools.view_image")
    expect(screen.getByText("View image")).toBeTruthy()
  })
})

describe("ToolCallCard AskUserQuestion inline form", () => {
  const questions = [
    { question: "What is your name?", options: [] },
    { question: "What do you want to do?", options: [{ label: "Option A" }, { label: "Option B" }] },
  ]

  function makeAskUserQuestionCall(result: string | null = null): ToolCall {
    return {
      id: "tool-use-id-123",
      name: "AskUserQuestion",
      input: { questions },
      result,
      isError: false,
      timestamp: new Date().toISOString(),
    }
  }

  beforeAll(() => {
    mockAuthFetchFn.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })
  })

  it("renders one input per open question when pending and agent active", () => {
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} expandAll={false} isAgentActive={true} />)

    // Open-ended question gets a textarea
    expect(screen.getByPlaceholderText("Type your answer...")).toBeTruthy()
  })

  it("renders option buttons for multiple-choice questions when pending and agent active", () => {
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} expandAll={false} isAgentActive={true} />)

    expect(screen.getByText("Option A")).toBeTruthy()
    expect(screen.getByText("Option B")).toBeTruthy()
  })

  it("renders send answer button when pending and agent active", () => {
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} expandAll={false} isAgentActive={true} />)

    expect(screen.getByText("Send answer")).toBeTruthy()
  })

  it("does NOT render form when agent is NOT active", () => {
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} expandAll={false} isAgentActive={false} />)

    expect(screen.queryByText("Send answer")).toBeNull()
    expect(screen.queryByPlaceholderText("Type your answer...")).toBeNull()
  })

  it("does NOT render form when toolCall already has a result", () => {
    const toolCall = makeAskUserQuestionCall("User responded")
    render(<ToolCallCard toolCall={toolCall} expandAll={false} isAgentActive={true} />)

    expect(screen.queryByText("Send answer")).toBeNull()
  })

  it("calls authFetch with correct payload on form submit", async () => {
    mockAuthFetchFn.mockClear()
    mockAuthFetchFn.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })

    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} expandAll={false} isAgentActive={true} />)

    const submitBtn = screen.getByText("Send answer")
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mockAuthFetchFn).toHaveBeenCalledWith(
        "/api/ask-user-answer",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("test-session-id"),
        }),
      )
      const payload = JSON.parse(mockAuthFetchFn.mock.calls[0][1].body as string) as { answers: Record<string, string> }
      expect(payload.answers).toEqual({
        "What is your name?": "",
        "What do you want to do?": "",
      })
    })
  })

  it("shows error message when fetch fails", async () => {
    mockAuthFetchFn.mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: "Session not found" }),
    })

    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} expandAll={false} isAgentActive={true} />)

    const submitBtn = screen.getByText("Send answer")
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(screen.getByText("Session not found")).toBeTruthy()
    })
  })
})
