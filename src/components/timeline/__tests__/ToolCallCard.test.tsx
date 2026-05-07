import { describe, it, expect, vi, beforeAll } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { getToolSummary, ToolCallCard } from "../ToolCallCard"
import type { ToolCall } from "@/lib/types"
import type { SkillMeta } from "@/hooks/useSkillMetadata"

// Mock authFetch — needed when "Open SKILL.md" button is clicked
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true }),
  isRemoteClient: vi.fn().mockReturnValue(false),
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

  it("calls authFetch with correct path when Open SKILL.md is clicked", async () => {
    const { authFetch } = await import("@/lib/auth")
    const mockAuthFetch = authFetch as unknown as ReturnType<typeof vi.fn>
    mockAuthFetch.mockClear()

    const filePath = "/home/user/.claude/skills/commit/SKILL.md"
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["commit", { source: "user", filePath }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} expandAll={false} skillMetadata={skillMeta} />)

    const btn = screen.getByText("Open SKILL.md")
    fireEvent.click(btn)

    expect(mockAuthFetch).toHaveBeenCalledWith(
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
