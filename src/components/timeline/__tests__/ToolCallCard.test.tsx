import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { getToolTextStyle, ToolCallCard } from "../ToolCallCard"
import { getToolSummary, getToolTier } from "../../../../shared/session/toolSummary"
import { CollapsibleToolCalls } from "../CollapsibleToolCalls"
import type { ToolCall } from "../../../../shared/session/types"
import type { SkillMeta } from "@/hooks/useSkillMetadata"

// Mock jsonFetch — needed when "Open SKILL.md" button is clicked / answer submission
const mockJsonFetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) }),
  jsonFetch: (...args: unknown[]) => mockJsonFetchFn(...args),
  authUrl: (url: string) => url,
  isRemoteClient: vi.fn().mockReturnValue(false),
}))

// Mock useSessionContext — used by ToolCallCard for sessionId and for the
// pending-interaction lookup that decides whether a question is answerable.
const mockSession = { sessionId: "test-session-id", cwd: "/repo" }
let mockPendingInteraction: unknown = null
const mockSendMessage = vi.fn()
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: vi.fn(() => ({
    session: mockSession,
    pendingInteraction: mockPendingInteraction,
  })),
  useSessionChatContext: vi.fn(() => ({ chat: { sendMessage: mockSendMessage } })),
}))

// Mock shiki (syntax highlighting) to avoid async side-effects in tests
vi.mock("@/lib/shiki", () => ({
  highlightCode: vi.fn().mockResolvedValue([]),
  getLangFromPath: vi.fn().mockReturnValue(null),
}))

vi.mock("@/components/timeline/LiveSubagentTranscript", () => ({
  LiveSubagentTranscript: ({ toolUseId }: { toolUseId: string }) => (
    <div data-testid="live-subagent-transcript">{toolUseId}</div>
  ),
}))

// Mock window.matchMedia — required by useIsMobile
let mobileViewport = false

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mobileViewport,
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
  it.each<[string, Record<string, unknown>, string]>([
    ["Monitor", { bash_id: "abc", filter: "ERROR" }, "abc · filter=ERROR"],
    ["Monitor", { bash_id: "abc" }, "abc"],
    ["CronCreate", { schedule: "0 */6 * * *", prompt: "/babysit-prs" }, "0 */6 * * * → /babysit-prs"],
    ["CronList", {}, ""],
    ["CronDelete", { id: "cron_123" }, "cron_123"],
    ["ScheduleWakeup", { delaySeconds: 1800, reason: "polling deploy" }, "in 30m · polling deploy"],
    ["ScheduleWakeup", { delaySeconds: 3600, reason: "hourly check" }, "in 1h · hourly check"],
    ["ScheduleWakeup", { delaySeconds: 45, reason: "quick poll" }, "in 45s · quick poll"],
    ["RemoteTrigger", { action: "run", id: "trig_42" }, "run trig_42"],
    ["PushNotification", { title: "Build done", body: "..." }, "Build done"],
    ["EnterWorktree", { name: "fix-auth", branch: "feat/auth", path: "/x/y" }, "fix-auth (/x/y)"],
    ["ExitWorktree", { name: "fix-auth" }, "fix-auth"],
    ["Skill", { skill: "commit", args: "" }, "commit"],
    ["ToolSearch", { query: "select:Read", max_results: 5 }, "select:Read"],
  ])("summarizes %s %j as '%s'", (name, input, expected) => {
    expect(getToolSummary(makeToolCall(name, input))).toBe(expected)
  })
})

describe("getToolTier", () => {
  it("counts spawning, steering and messaging agents as changing the world", () => {
    for (const name of ["Agent", "TaskCreate", "TaskUpdate", "TaskStop", "SendMessage", "EndConversation"]) {
      expect(getToolTier(name)).toBe("mutating")
    }
  })

  it("counts launching a workflow as changing the world", () => {
    // A workflow run spawns a fleet of agents that edit the repo.
    expect(getToolTier("Workflow")).toBe("mutating")
  })

  it("counts inspecting and reporting on that work as read-only", () => {
    for (const name of ["ListAgents", "TaskList", "TaskOutput", "LSP", "StructuredOutput", "ReportFindings"]) {
      expect(getToolTier(name)).toBe("readOnly")
    }
  })
})

describe("getToolTextStyle", () => {
  it("gives calls that change the world full strength", () => {
    for (const name of ["Write", "Edit", "Bash", "exec", "Task"]) {
      expect(getToolTextStyle(name)).toBe("text-foreground")
    }
  })

  it("mutes read-only calls", () => {
    for (const name of ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]) {
      expect(getToolTextStyle(name)).toBe("text-muted-foreground")
    }
  })

  it("mutes unknown tools rather than inventing a hue for them", () => {
    expect(getToolTextStyle("SomeUnknownMcpTool")).toBe("text-muted-foreground")
  })

  it("reserves red for failures, whatever the tool was", () => {
    expect(getToolTextStyle("Read", true)).toBe("text-destructive")
    expect(getToolTextStyle("Bash", true)).toBe("text-destructive")
  })
})

describe("ToolCallCard status icon", () => {
  it("marks completed calls with a quiet success icon", () => {
    const toolCall: ToolCall = { ...makeToolCall("Read", { file_path: "x.ts" }), result: "contents" }

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.queryByRole("img", { name: "Tool call failed" })).toBeNull()
    expect(screen.queryByRole("img", { name: "Tool call running" })).toBeNull()
    expect(screen.getByRole("img", { name: "Tool call completed" })).toBeInTheDocument()
  })

  it("marks a failed call", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "x.ts" }),
      result: "ENOENT",
      isError: true,
    }

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.getByRole("img", { name: "Tool call failed" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Read file details/ })).toHaveAccessibleDescription(/failed/i)
  })

  it("marks a call that is still running", () => {
    const toolCall = makeToolCall("Bash", { command: "bun test" })

    render(<ToolCallCard toolCall={toolCall} isAgentActive />)

    expect(screen.getByRole("img", { name: "Tool call running" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Run command details/ })).toHaveAccessibleDescription(/running/i)
  })
})

describe("ToolCallCard timestamp", () => {
  it("carries the wall clock on hover instead of printing it on every row", () => {
    const timestamp = "2026-08-19T17:14:37.000Z"
    const expected = new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    const toolCall: ToolCall = { ...makeToolCall("Read", { file_path: "x.ts" }), timestamp, result: "ok" }

    const { container } = render(<ToolCallCard toolCall={toolCall} />)

    // Costs no visible ink: the only node carrying it is screen-reader-only.
    const printed = screen.queryByText(expected)
    expect(printed?.tagName).toBe("TIME")
    expect(printed?.className).toContain("sr-only")
    // Mouse users get it from the row's tooltip.
    expect(container.querySelector(`[title="${expected}"]`)).toBeTruthy()
  })

  it("gives assistive tech a machine-readable time", () => {
    const timestamp = "2026-08-19T17:14:37.000Z"
    const toolCall: ToolCall = { ...makeToolCall("Read", { file_path: "x.ts" }), timestamp, result: "ok" }

    const { container } = render(<ToolCallCard toolCall={toolCall} />)

    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(timestamp)
  })
})

describe("ToolCallCard Skill rendering", () => {
  it("shows source label when skillMetadata is provided", () => {
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["commit", { source: "user", description: "Create a commit", filePath: "/home/user/.claude/skills/commit/SKILL.md" }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} skillMetadata={skillMeta} />)

    expect(screen.getByText(/source: user/)).toBeTruthy()
  })

  it("shows Open SKILL.md button when filePath is available", () => {
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["commit", { source: "user", filePath: "/home/user/.claude/skills/commit/SKILL.md" }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} skillMetadata={skillMeta} />)

    expect(screen.getByText("Open SKILL.md")).toBeTruthy()
  })

  it("calls jsonFetch with correct path when Open SKILL.md is clicked", () => {
    mockJsonFetchFn.mockClear()

    const filePath = "/home/user/.claude/skills/commit/SKILL.md"
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["commit", { source: "user", filePath }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} skillMetadata={skillMeta} />)

    const btn = screen.getByText("Open SKILL.md")
    fireEvent.click(btn)

    expect(screen.getByRole("button", { name: /Use skill details: commit/ })).toHaveAttribute("aria-expanded", "false")
    expect(mockJsonFetchFn).toHaveBeenCalledWith(
      "/api/open-in-editor",
      expect.objectContaining({ path: filePath, mode: "file" }),
    )
  })

  it("does not show source label when skillMetadata is absent", () => {
    const toolCall = makeToolCall("Skill", { skill: "commit", args: "" })

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.queryByText(/source:/)).toBeNull()
    expect(screen.queryByText("Open SKILL.md")).toBeNull()
  })

  it("does not show Open SKILL.md button when filePath is empty", () => {
    const skillMeta: Map<string, SkillMeta> = new Map([
      ["simplify", { source: "built-in", filePath: "" }],
    ])
    const toolCall = makeToolCall("Skill", { skill: "simplify", args: "" })

    render(<ToolCallCard toolCall={toolCall} skillMetadata={skillMeta} />)

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

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.getByText("hook")).toBeTruthy()
  })

  it("shows hook duration when hookDurationMs is set and > 0", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Bash", { command: "ls" }),
      hookDurationMs: 42,
    }

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.getByText("42ms")).toBeTruthy()
  })

  it("shows both 'hook' badge and duration when both fields are set", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Bash", { command: "ls" }),
      outputReplacedByHook: true,
      hookDurationMs: 99,
    }

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.getByText("hook")).toBeTruthy()
    expect(screen.getByText("99ms")).toBeTruthy()
  })

  it("does not show 'hook' badge when outputReplacedByHook is not set", () => {
    const toolCall = makeToolCall("Read", { file_path: "x.ts" })

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.queryByText("hook")).toBeNull()
  })

  it("does not show duration when hookDurationMs is not set", () => {
    const toolCall = makeToolCall("Read", { file_path: "x.ts" })

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.queryByText(/ms$/)).toBeNull()
  })

  it("does not show duration when hookDurationMs is 0", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "x.ts" }),
      hookDurationMs: 0,
    }

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.queryByText("0ms")).toBeNull()
  })
})

describe("ToolCallCard image reads", () => {
  it.each([
    ["Read", { file_path: "/tmp/shot.png" }],
    ["view_image", { path: "/tmp/shot.png" }],
  ])("prefers persisted images over the local-file fallback for %s", (name, input) => {
    const toolCall: ToolCall = {
      ...makeToolCall(name, input),
      result: "",
      resultImages: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "cG5n" },
      }],
    }

    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)

    expect(screen.getAllByRole("img", { name: /Tool result image/ })).toHaveLength(1)
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull()
    expect(screen.getByRole("img", { name: "Tool result image 1" })).toHaveAttribute(
      "src",
      "data:image/png;base64,cG5n",
    )
    expect(screen.queryByText("Result")).toBeNull()
    expect(screen.queryByText("No output")).toBeNull()
  })

  it("renders persisted tool-result images", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("image_tool", {}),
      result: "",
      resultImages: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "cG5n" },
      }],
    }

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.getByRole("img", { name: "Tool result image 1" })).toHaveAttribute(
      "src",
      "data:image/png;base64,cG5n",
    )
  })

  it("previews an image read inline through the local-file proxy", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "/tmp/qa-09.png" }),
      result: "",
    }

    render(<ToolCallCard toolCall={toolCall} />)

    const img = screen.getByRole("img", { name: "qa-09.png" }) as HTMLImageElement
    expect(img.getAttribute("src")).toBe("/api/local-file?path=%2Ftmp%2Fqa-09.png")
    // Inline, so the preview is visible without opening the disclosure.
    expect(screen.getByRole("button", { name: /Read file details/ })).toHaveAttribute("aria-expanded", "false")
  })

  it("previews a Codex view_image call", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("view_image", { path: "/tmp/shot.jpeg" }),
      result: "",
    }

    render(<ToolCallCard toolCall={toolCall} />)

    const img = screen.getByRole("img", { name: "shot.jpeg" }) as HTMLImageElement
    expect(img.getAttribute("src")).toBe("/api/local-file?path=%2Ftmp%2Fshot.jpeg")
  })

  it("drops the always-empty result well an image read leaves behind", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "/tmp/qa-09.png" }),
      result: "",
    }

    render(<ToolCallCard toolCall={toolCall} />)
    fireEvent.click(screen.getByRole("button", { name: /Read file details/ }))

    expect(screen.getByRole("button", { name: "Raw input" })).toBeTruthy()
    expect(document.querySelector("pre")).toBeNull()
  })

  it("keeps the text result when a read returns one", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "src/example.ts" }),
      result: "export const answer = 42",
    }

    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)

    expect(screen.queryByRole("img", { name: /Tool result image/ })).toBeNull()
    expect(screen.getByText("export const answer = 42")).toBeInTheDocument()
  })

  it("does not preview a failed image read", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "/tmp/qa-09.png" }),
      result: "",
      isError: true,
    }

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.queryByRole("img", { name: "qa-09.png" })).toBeNull()
  })

  it("does not preview a relative path the proxy cannot resolve", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "assets/logo.png" }),
      result: "",
    }

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.queryByRole("img", { name: "logo.png" })).toBeNull()
  })
})

describe("ToolCallCard desktop disclosure", () => {
  it("uses the entire action and description header as the accessible disclosure target", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "src/example.ts" }),
      result: "export const answer = 42",
    }

    render(<ToolCallCard toolCall={toolCall} />)

    const disclosure = screen.getByRole("button", { name: /Read file details: src\/example\.ts/ })
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("button", { name: "Raw input" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Result" })).toBeNull()

    fireEvent.click(screen.getByText("Read file"))

    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    const panelId = disclosure.getAttribute("aria-controls")
    expect(panelId).toBeTruthy()
    expect(document.getElementById(panelId!)).toHaveAttribute("data-slot", "collapsible-content")
    expect(document.getElementById(panelId!)).toHaveClass("h-[var(--collapsible-panel-height)]")
    expect(screen.getByText("export const answer = 42")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Raw input" })).toBeTruthy()
  })

  it("supports Enter and Space through native button keyboard behavior", async () => {
    const user = userEvent.setup()
    const toolCall: ToolCall = {
      ...makeToolCall("Grep", { pattern: "needle" }),
      result: "src/example.ts:1:needle",
    }

    render(<ToolCallCard toolCall={toolCall} />)

    const disclosure = screen.getByRole("button", { name: /Search files details: needle/ })
    disclosure.focus()
    await user.keyboard("{Enter}")
    expect(disclosure).toHaveAttribute("aria-expanded", "true")

    await user.keyboard(" ")
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
  })

  it("selects the diff for a valid Edit instead of its result", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Edit", {
        file_path: "src/example.ts",
        old_string: "const answer = 41",
        new_string: "const answer = 42",
      }),
      result: "Edit applied successfully",
    }

    render(<ToolCallCard toolCall={toolCall} />)
    const disclosure = screen.getByRole("button", { name: /Edit file details: src\/example\.ts/ })
    expect(screen.queryByRole("button", { name: "Diff" })).toBeNull()
    fireEvent.click(disclosure)

    expect(screen.getAllByText("src/example.ts")).toHaveLength(2)
    fireEvent.click(screen.getByTitle("Expand diff"))
    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    expect(screen.queryByText("Edit applied successfully")).toBeNull()
  })

  it("falls back to the result when an Edit cannot produce a diff", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Edit", { file_path: "src/example.ts", new_string: "const answer = 42" }),
      result: "Edit could not find the old text",
    }

    render(<ToolCallCard toolCall={toolCall} />)
    fireEvent.click(screen.getByRole("button", { name: /Edit file details: src\/example\.ts/ }))

    expect(screen.getByText("Edit could not find the old text")).toBeTruthy()
    expect(screen.queryByTitle("Expand diff")).toBeNull()
  })

  it.each(["Read", "Grep"])("selects the result for %s", (name) => {
    const toolCall: ToolCall = {
      ...makeToolCall(name, name === "Read" ? { file_path: "src/example.ts" } : { pattern: "needle" }),
      result: `${name} result`,
    }

    render(<ToolCallCard toolCall={toolCall} />)
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${name === "Read" ? "Read file" : "Search files"} details`) }))

    expect(screen.getByText(`${name} result`)).toBeTruthy()
    expect(screen.queryByLabelText("Bash command")).toBeNull()
  })

  it("uses the result as the fallback for other tools", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Write", { file_path: "src/example.ts", content: "export {}" }),
      result: "Wrote src/example.ts",
    }

    render(<ToolCallCard toolCall={toolCall} />)
    fireEvent.click(screen.getByRole("button", { name: /Write file details: src\/example\.ts/ }))

    expect(screen.getByText("Wrote src/example.ts")).toBeTruthy()
    expect(screen.queryByText('"content"')).toBeNull()
  })

  it("clamps CRLF Read results to eight lines and preserves line numbers", () => {
    const result = Array.from(
      { length: 10 },
      (_, index) => `${index + 1}→line ${index + 1}`,
    ).join("\r\n")
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "src/example.ts" }),
      result,
    }

    render(<ToolCallCard toolCall={toolCall} />)
    fireEvent.click(screen.getByRole("button", { name: /Read file details: src\/example\.ts/ }))

    expect(screen.getByText("8")).toBeInTheDocument()
    expect(screen.getByText("line 8")).toBeInTheDocument()
    expect(screen.queryByText("line 9")).toBeNull()
    const resultBlock = screen.getByText("line 1").closest("pre")
    expect(resultBlock).toHaveClass("font-mono", "max-h-96", "overflow-auto")
    expect(resultBlock).toHaveAttribute("tabindex", "0")

    fireEvent.click(screen.getByRole("button", { name: "+2 lines" }))
    expect(screen.getByText("line 10")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Show less" }))
    expect(screen.queryByText("line 9")).toBeNull()
    expect(screen.getByRole("button", { name: "+2 lines" })).toBeInTheDocument()
  })

  it("counts formatted JSON lines before clamping", () => {
    const result = JSON.stringify(Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`key${index + 1}`, index + 1]),
    ))
    const toolCall: ToolCall = {
      ...makeToolCall("WebFetch", { url: "https://example.com" }),
      result,
    }

    render(<ToolCallCard toolCall={toolCall} />)
    fireEvent.click(screen.getByRole("button", { name: /Open page details/ }))

    expect(screen.getByRole("button", { name: "+2 lines" })).toBeInTheDocument()
    expect(screen.getByText(/"key7"/)).toBeInTheDocument()
    expect(screen.queryByText(/"key8"/)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "+2 lines" }))
    expect(screen.getByText(/"key8"/)).toBeInTheDocument()
  })

  it("clamps plain text results and leaves exactly eight lines unexpanded", () => {
    const nineLineCall: ToolCall = {
      ...makeToolCall("Grep", { pattern: "match" }),
      result: Array.from({ length: 9 }, (_, index) => `match ${index + 1}`).join("\n"),
    }

    const { unmount } = render(<ToolCallCard toolCall={nineLineCall} />)
    fireEvent.click(screen.getByRole("button", { name: /Search files details/ }))

    expect(screen.getByRole("button", { name: "+1 line" })).toBeInTheDocument()
    expect(screen.queryByText("match 9")).toBeNull()
    unmount()

    const eightLineCall: ToolCall = {
      ...makeToolCall("Grep", { pattern: "exact" }),
      result: Array.from({ length: 8 }, (_, index) => `exact ${index + 1}`).join("\n"),
    }
    const { container } = render(<ToolCallCard toolCall={eightLineCall} />)
    fireEvent.click(screen.getByRole("button", { name: /Search files details/ }))

    expect(container.querySelector("pre")).toHaveTextContent("exact 8")
    expect(screen.queryByRole("button", { name: /^\+\d+ lines$/ })).toBeNull()
  })

  it("exposes failed command output immediately and lets readers expand it", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Bash", { command: "failing-command" }),
      result: Array.from({ length: 10 }, (_, index) => `error ${index + 1}`).join("\n"),
      isError: true,
    }

    render(<ToolCallCard toolCall={toolCall} />)
    fireEvent.click(screen.getByRole("button", { name: /Run command details/ }))

    const resultBlock = screen.getByText(/error 1/).closest("pre")
    expect(resultBlock).toHaveClass("text-destructive", "max-h-96", "overflow-auto")
    expect(screen.queryByText(/error 10/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "+2 lines" }))
    expect(screen.getByText(/error 10/)).toBeInTheDocument()
  })

  it("keeps raw JSON input behind its own disclosure", async () => {
    const user = userEvent.setup()
    const toolCall: ToolCall = {
      ...makeToolCall("Write", { file_path: "src/example.ts", content: "export {}" }),
      result: "Wrote src/example.ts",
    }

    render(<ToolCallCard toolCall={toolCall} />)
    const disclosure = screen.getByRole("button", { name: /Write file details: src\/example\.ts/ })
    fireEvent.click(disclosure)

    expect(screen.queryByText('"content"')).toBeNull()
    const inputDisclosure = screen.getByRole("button", { name: "Raw input" })
    expect(inputDisclosure).toHaveAttribute("aria-expanded", "false")
    await user.click(inputDisclosure)

    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    expect(inputDisclosure).toHaveAttribute("aria-expanded", "true")
    const inputPanelId = inputDisclosure.getAttribute("aria-controls")
    expect(inputPanelId).toBeTruthy()
    expect(document.getElementById(inputPanelId!)).toHaveClass("h-[var(--collapsible-panel-height)]")
    const inputBlock = screen.getByText(/"content"/).closest("pre")
    expect(inputBlock).toHaveClass("max-h-96", "overflow-y-auto", "font-mono")
    expect(inputBlock).toHaveAttribute("tabindex", "0")
  })

  it("opens only the primary panel during bulk payload expansion", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "src/example.ts", offset: 12 }),
      result: "bulk result",
    }

    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)

    expect(screen.getByRole("button", { name: /Read file details: src\/example\.ts/ })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("bulk result")).toBeTruthy()
    expect(screen.queryByText('"offset"')).toBeNull()
    expect(screen.getByRole("button", { name: "Raw input" })).toHaveAttribute("aria-expanded", "false")
  })

  it("does not collapse when a nested copy control is used", async () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Bash", { command: "bun test" }),
      result: "all tests passed",
    }

    render(<ToolCallCard toolCall={toolCall} />)
    const disclosure = screen.getByRole("button", { name: /Run command details: bun test/ })
    fireEvent.click(disclosure)
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    await waitFor(() => expect(screen.getByRole("button", { name: "Commands copied" })).toBeTruthy())
    expect(screen.getByRole("region", { name: "Bash command" })).toBeTruthy()
  })

  it("keeps a live Task transcript visible independently of the disclosure", () => {
    const toolCall = makeToolCall("Task", { description: "Audit the parser" })

    render(<ToolCallCard toolCall={toolCall} isAgentActive />)

    expect(screen.getByTestId("live-subagent-transcript")).toHaveTextContent("test-id")
    expect(screen.getByRole("button", { name: /Spawn agent details: Audit the parser/ })).toHaveAttribute("aria-expanded", "false")
  })
})

describe("ToolCallCard Bash input rendering", () => {
  it("keeps command payloads closed by default", () => {
    const toolCall = makeToolCall("Bash", { command: "bun test" })

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.queryByRole("region", { name: "Bash command" })).toBeNull()
  })

  it("renders Bash input as a readable command card", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Bash", {
        command: "cd /workspace && npm test",
        description: "Run the focused test suite",
        timeout: 600_000,
      }),
      result: "18 tests passed",
    }

    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)

    expect(screen.getByRole("region", { name: "Bash command" }).textContent).toContain("cd /workspace && npm test")
    expect(screen.getByText("Run the focused test suite")).toBeTruthy()
    expect(screen.getByText("10 min timeout")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy()
    expect(screen.queryByText('"command"')).toBeNull()
    expect(screen.getByText("18 tests passed")).toBeTruthy()
  })

  it("keeps long command summaries bounded after opening the complete command", () => {
    const command = Array.from({ length: 12 }, (_, index) => `bun run check:step-${index + 1}`).join("\n")
    const toolCall: ToolCall = { ...makeToolCall("Bash", { command }), result: "Checks passed" }

    render(<ToolCallCard toolCall={toolCall} />)

    const disclosure = screen.getByRole("button", { name: /Run command details/ })
    const summary = within(disclosure).getByTitle(/^bun run check:step-1/)
    expect(summary).toHaveClass("line-clamp-2")
    fireEvent.click(disclosure)

    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    expect(summary).toHaveClass("line-clamp-2")
    const commandBlock = within(screen.getByRole("region", { name: "Bash command" })).getByText(/check:step-12/).closest("pre")
    expect(commandBlock?.textContent).toBe(command)
    expect(commandBlock).not.toHaveClass("line-clamp-2")
    expect(screen.getByText("Checks passed")).toBeInTheDocument()
  })

  it("shows execution mode and additional Bash options", () => {
    const toolCall = makeToolCall("Bash", {
      cmd: "npm run build",
      run_in_background: true,
      sandbox: "strict",
    })

    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)

    expect(screen.getByRole("region", { name: "Bash command" }).textContent).toContain("npm run build")
    expect(screen.getByText("Background")).toBeTruthy()
    expect(screen.getByText("Sandbox strict")).toBeTruthy()
  })
})

describe("ToolCallCard Codex exec input rendering", () => {
  it("shows the semantic operation and target instead of exec source", () => {
    const script = 'const r = await tools.web__run({ search_query: [{ q: "Codex app-server items" }] }); text(r);'
    const toolCall = makeToolCall("exec", { raw: script })

    render(<ToolCallCard toolCall={toolCall} />)

    expect(screen.getByText("Search web")).toBeTruthy()
    expect(screen.getByText("Codex app-server items")).toBeTruthy()
    expect(screen.queryByText("exec")).toBeNull()
    expect(screen.queryByText(/const r = await/)).toBeNull()
  })

  it("renders the raw Codex orchestration as readable code", () => {
    const script = `const r = await tools.exec_command({
  cmd: "npm test",
  workdir: "/workspace/cogpit",
  yield_time_ms: 10000,
  max_output_tokens: 20000
});
text(r.output);`
    const toolCall: ToolCall = {
      ...makeToolCall("exec", { raw: script }),
      result: "focused tests passed",
    }

    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)

    expect(screen.queryByLabelText("Codex exec script")).toBeNull()
    expect(screen.getByLabelText("Command")).toHaveTextContent("npm test")
    fireEvent.click(screen.getByRole("button", { name: "Source" }))
    const renderedScript = screen.getByLabelText("Codex exec script")
    expect(renderedScript.textContent).toContain("tools.exec_command")
    expect(renderedScript.children.length).toBeGreaterThan(1)
    expect(screen.getByRole("region", { name: "Run command" })).toBeTruthy()
    expect(screen.getByText("/workspace/cogpit")).toBeTruthy()
    expect(screen.getByText("10 sec")).toBeTruthy()
    expect(screen.getByText("20,000 tokens")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy script" })).toBeTruthy()
    expect(screen.queryByText('"raw"')).toBeNull()
    expect(screen.getByText("focused tests passed")).toBeTruthy()
  })

  it("supports namespaced Codex exec tool names", () => {
    const toolCall = makeToolCall("functions.exec", {
      raw: 'const r = await tools.view_image({ path: "/tmp/screenshot.png" });\nimage(r.image_url);',
    })

    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)

    expect(screen.getByRole("region", { name: "View image" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Source" }))
    expect(screen.getByLabelText("Codex exec script").textContent).toContain("tools.view_image")
    expect(screen.getAllByText("View image")).toHaveLength(2)
  })

  it("renders nested agent messages as recipient and readable message before the source", () => {
    const message = `gAAAAA${"AbCd0123".repeat(40)}`
    const toolCall = makeToolCall("exec", {
      raw: `const r = await tools.send_message({ target: "renderer", message: "${message}" }); text(r);`,
    })
    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)
    expect(screen.getByText("Recipient")).toBeTruthy()
    expect(screen.getByText("renderer")).toBeTruthy()
    expect(screen.getByText("Encrypted message")).toBeTruthy()
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByLabelText("Codex exec script")).toBeNull()
    expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute("aria-expanded", "false")
  })

  it("shows every nested command separately while preserving the full source", () => {
    const script = 'await Promise.all([tools.exec_command({cmd:"bun test"}), tools.exec_command({cmd:"bun run build"})])'
    const toolCall = makeToolCall("functions.exec", { raw: script })
    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)
    expect(screen.getAllByLabelText("Command")).toHaveLength(2)
    expect(screen.getByText("bun test")).toBeTruthy()
    expect(screen.getByText("bun run build")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Source" }))
    expect(screen.getByLabelText("Codex exec script")).toHaveTextContent(script)
  })

})

describe("ToolCallCard provider parity", () => {
  it.each(["Bash", "exec_command", "functions.exec_command"])("renders %s argv as readable commands", (name) => {
    const toolCall: ToolCall = {
      ...makeToolCall(name, { command: ["git", "show", "HEAD:src/a b.ts"] }),
      result: "file content",
    }
    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)
    expect(screen.getByRole("button", { name: /Run command details/ })).toBeTruthy()
    expect(screen.getByRole("region", { name: "Bash command" })).toHaveTextContent("git show 'HEAD:src/a b.ts'")
    expect(screen.getByText("file content")).toBeTruthy()
  })

  it("shows an Edit failure alongside the requested diff", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Edit", { file_path: "src/example.ts", old_string: "before", new_string: "after" }),
      result: "The old text was not found",
      isError: true,
    }
    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)
    expect(screen.getByText("The old text was not found")).toHaveClass("text-destructive")
    expect(screen.getByRole("button", { name: "Expand diff" })).toBeTruthy()
    expect(screen.getByText("Error")).toBeTruthy()
  })

  it("renders namespaced image results through the local-file proxy", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("functions.view_image", { path: "/tmp/screenshot.png" }),
      result: "",
    }
    render(<ToolCallCard toolCall={toolCall} />)
    expect(screen.getByRole("img", { name: "screenshot.png" })).toHaveAttribute("src", "/api/local-file?path=%2Ftmp%2Fscreenshot.png")
  })

  it("keeps empty output distinct from a pending call", () => {
    const toolCall: ToolCall = { ...makeToolCall("SomeUnknownTool", {}), result: "" }
    const { rerender } = render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)
    expect(screen.getByText("No output")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Copy result" })).toBeNull()
    rerender(<ToolCallCard toolCall={{ ...toolCall, result: null }} expandToolPayloads isAgentActive />)
    expect(screen.queryByText("No output")).toBeNull()
    expect(screen.getByRole("img", { name: "Tool call running" })).toBeTruthy()
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
    mockJsonFetchFn.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })
  })

  beforeEach(() => {
    mockPendingInteraction = {
      type: "question",
      toolUseId: "tool-use-id-123",
      questions,
    }
  })

  afterEach(() => {
    mockPendingInteraction = null
  })

  it("renders the answer form while live traffic is stale", () => {
    // Regression: a session blocked on AskUserQuestion emits no SSE traffic by
    // construction, so useLiveSession's 30s stale timer flips isLive (and thus
    // isAgentActive) to false. Gating the form on that removed the only way to
    // answer — the session then hung until the CLI's permission stream died
    // hours later. Answerability comes from the pending interaction, not from
    // traffic.
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={false} />)

    expect(screen.getByText("Send answer")).toBeTruthy()
    expect(screen.getByPlaceholderText("Type your answer...")).toBeTruthy()
  })

  it("renders one input per open question when pending and agent active", () => {
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    // Open-ended question gets a textarea
    expect(screen.getByPlaceholderText("Type your answer...")).toBeTruthy()
  })

  it("renders option buttons for multiple-choice questions when pending and agent active", () => {
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    const optionA = screen.getByRole("button", { name: "Option A" })
    expect(optionA).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByText("Option B")).toBeTruthy()

    fireEvent.click(optionA)

    expect(optionA).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(optionA)

    expect(optionA).toHaveAttribute("aria-pressed", "true")
  })

  it("renders send answer button when pending and agent active", () => {
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    expect(screen.getByText("Send answer")).toBeTruthy()
  })

  it("does NOT render form when the question is no longer the pending interaction", () => {
    mockPendingInteraction = null
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    expect(screen.queryByText("Send answer")).toBeNull()
    expect(screen.queryByPlaceholderText("Type your answer...")).toBeNull()
  })

  it("does NOT render form when a different question is pending", () => {
    mockPendingInteraction = {
      type: "question",
      toolUseId: "some-other-tool-use-id",
      questions,
    }
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    expect(screen.queryByText("Send answer")).toBeNull()
  })

  it("does NOT render form when toolCall already has a result", () => {
    const toolCall = makeAskUserQuestionCall("User responded")
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    expect(screen.queryByText("Send answer")).toBeNull()
  })

  it("calls jsonFetch with correct payload on form submit", async () => {
    mockJsonFetchFn.mockClear()
    mockJsonFetchFn.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })

    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    const submitBtn = screen.getByText("Send answer")
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mockJsonFetchFn).toHaveBeenCalledWith(
        "/api/ask-user-answer",
        expect.objectContaining({ sessionId: "test-session-id" }),
      )
      const payload = mockJsonFetchFn.mock.calls[0][1] as { answers: Record<string, string> }
      expect(payload.answers).toEqual({
        "What is your name?": "",
        "What do you want to do?": "",
      })
    })
  })

  it("delivers the answer as a message when the server cannot resolve it", async () => {
    // A session started from the terminal was never owned by this server, so
    // /api/ask-user-answer 404s. Never make the user retype: send the answer as
    // a normal message, which resumes the session.
    mockSendMessage.mockClear()
    mockJsonFetchFn.mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ error: "Session not found" }),
    })

    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    fireEvent.click(screen.getByRole("button", { name: "Option A" }))
    fireEvent.click(screen.getByText("Send answer"))

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
    })
    expect(String(mockSendMessage.mock.calls[0][0])).toContain("Option A")
  })

  it("delivers the answer as a message when the request throws", async () => {
    mockSendMessage.mockClear()
    mockJsonFetchFn.mockRejectedValue(new Error("offline"))

    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    fireEvent.click(screen.getByRole("button", { name: "Option A" }))
    fireEvent.click(screen.getByText("Send answer"))

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
    })
  })
})

describe("ToolCallCard async questions", () => {
  const questions = [{ question: "What is your budget?", options: [] }]

  /**
   * An async question's result is an acceptance receipt, not an answer: the
   * agent keeps working and the reply arrives as a later message. Reading
   * `result !== null` as "answered" marked every one of these as settled and
   * hid the only affordance for answering it.
   */
  function makeAsyncQuestionCall(): ToolCall {
    return {
      id: "tool-use-id-123",
      name: "AskUserQuestion",
      input: { questions },
      result: '{"accepted":true}',
      isError: false,
      asyncQuestion: true,
      timestamp: new Date().toISOString(),
    }
  }

  beforeEach(() => {
    mockJsonFetchFn.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })
    mockPendingInteraction = { type: "question", toolUseId: "tool-use-id-123", questions }
  })

  afterEach(() => {
    mockPendingInteraction = null
  })

  it("offers the answer form even though the call already has a result", () => {
    render(<ToolCallCard toolCall={makeAsyncQuestionCall()} isAgentActive={false} />)

    expect(screen.getByText("Send answer")).toBeTruthy()
    expect(screen.queryByText("Answered")).toBeNull()
  })

  it("does not present the acceptance receipt as a recorded response", () => {
    mockPendingInteraction = null
    render(<ToolCallCard toolCall={makeAsyncQuestionCall()} isAgentActive={false} />)

    expect(screen.queryByText("Recorded response")).toBeNull()
    expect(screen.getByText("What is your budget?")).toBeTruthy()
    expect(screen.getByText("No answer recorded")).toBeTruthy()
  })
})

describe("ToolCallCard AskUserQuestion history", () => {
  it("opens raw question details only at the payload expansion level", () => {
    const toolCall: ToolCall = {
      id: "expanded-question-id",
      name: "AskUserQuestion",
      input: { questions: [{ question: "Ship it?", options: [{ label: "Yes" }] }] },
      result: 'Your questions have been answered: "Ship it?"="Yes".',
      isError: false,
      timestamp: new Date().toISOString(),
    }

    const { rerender } = render(
      <ToolCallCard toolCall={toolCall} isAgentActive={false} />,
    )
    expect(screen.queryByText("Input")).toBeNull()
    expect(screen.queryByText("Result")).toBeNull()

    rerender(
      <ToolCallCard
        toolCall={toolCall}
        expandToolPayloads
        isAgentActive={false}
      />,
    )
    expect(screen.getByText("Input")).toBeInTheDocument()
    expect(screen.getByText("Result")).toBeInTheDocument()
  })

  it("renders the question, option descriptions, and selected answer as readable history", () => {
    const question = "Which fixes should I implement?"
    const result = `Your questions have been answered: "${question}"="Both (Recommended)". You can now continue with these answers in mind.`
    const toolCall: ToolCall = {
      id: "answered-question-id",
      name: "AskUserQuestion",
      input: {
        questions: [{
          header: "Fix scope",
          question,
          options: [
            { label: "Both (Recommended)", description: "Compression plus a byte-budgeted initial tail." },
            { label: "Compression only", description: "The smallest server-side change." },
          ],
        }],
      },
      result,
      isError: false,
      timestamp: new Date().toISOString(),
    }

    render(<ToolCallCard toolCall={toolCall} isAgentActive={false} />)

    expect(screen.getByRole("region", { name: "Question history" })).toBeTruthy()
    expect(screen.getByText("Decision requested")).toBeTruthy()
    expect(screen.getByText("Answered")).toBeTruthy()
    expect(screen.getByText(question)).toBeTruthy()
    expect(screen.getByText("Compression plus a byte-budgeted initial tail.")).toBeTruthy()
    expect(screen.getByText("The smallest server-side change.")).toBeTruthy()
    expect(screen.getByText("Selected")).toBeTruthy()
    expect(screen.queryByText("Input")).toBeNull()
    expect(screen.queryByText("Result")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Raw details" }))

    expect(screen.getByText("Input")).toBeTruthy()
    expect(screen.getByText("Result")).toBeTruthy()
  })

  it("renders free-form answers without exposing the raw result", () => {
    const question = "Anything else to consider?"
    const toolCall: ToolCall = {
      id: "free-form-question-id",
      name: "AskUserQuestion",
      input: { questions: [{ question }] },
      result: `Your questions have been answered: "${question}"="Keep the mobile layout compact.". You can now continue with these answers in mind.`,
      isError: false,
      timestamp: new Date().toISOString(),
    }

    render(<ToolCallCard toolCall={toolCall} isAgentActive={false} />)

    expect(screen.getByText("Answer")).toBeTruthy()
    expect(screen.getByText("Keep the mobile layout compact.")).toBeTruthy()
    expect(screen.queryByText(/Your questions have been answered/)).toBeNull()
  })

  it("keeps an activity group open when it contains question history", () => {
    const questionCall: ToolCall = {
      id: "grouped-question-id",
      name: "AskUserQuestion",
      input: { questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }] },
      result: 'Your questions have been answered: "Ship it?"="Yes".',
      isError: false,
      timestamp: new Date().toISOString(),
    }
    const readCall: ToolCall = {
      id: "grouped-read-id",
      name: "Read",
      input: { file_path: "/tmp/example.ts" },
      result: "contents",
      isError: false,
      timestamp: new Date().toISOString(),
    }

    render(
      <CollapsibleToolCalls
        toolCalls={[readCall, questionCall]}
        expandAll={false}
        expandToolPayloads={false}
        activeToolCallId={null}
      />,
    )

    expect(screen.getByRole("region", { name: "Question history" })).toBeTruthy()
    const disclosure = screen.getByRole("button", { name: /2 tool calls/i })
    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    expect(disclosure).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(disclosure)
    expect(screen.getByRole("region", { name: "Question history" })).toBeInTheDocument()
    expect(disclosure).toHaveAttribute("aria-expanded", "true")
  })
})

describe("CollapsibleToolCalls", () => {
  it("keeps adjacent shell calls independently readable in one activity group", () => {
    const first: ToolCall = {
      ...makeToolCall("Bash", { command: "bun test", description: "Run tests" }),
      id: "bash-one",
      result: "passed",
    }
    const second: ToolCall = {
      ...makeToolCall("Bash", { command: "bun run build", description: "Build app" }),
      id: "bash-two",
      result: "built",
    }

    render(
      <CollapsibleToolCalls
        toolCalls={[first, second]}
        activityItems={[
          { kind: "tool_calls", toolCalls: [first] },
          { kind: "tool_calls", toolCalls: [second] },
        ]}
        expandAll
        expandToolPayloads={false}
        activeToolCallId={null}
      />,
    )

    expect(screen.getByText("2 tool calls")).toBeInTheDocument()
    expect(screen.getByText("2 commands")).toBeInTheDocument()
    const firstDisclosure = screen.getByRole("button", { name: /Run command details: Run tests/ })
    const secondDisclosure = screen.getByRole("button", { name: /Run command details: Build app/ })
    expect(firstDisclosure).toHaveAttribute("aria-expanded", "false")
    expect(secondDisclosure).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(firstDisclosure)
    expect(screen.getByText("passed")).toBeInTheDocument()
    expect(screen.queryByText("built")).toBeNull()
    expect(secondDisclosure).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(secondDisclosure)
    expect(screen.getByText("built")).toBeInTheDocument()
    expect(screen.getAllByRole("region", { name: "Bash command" })).toHaveLength(2)
    expect(screen.queryByRole("region", { name: "Bash commands" })).toBeNull()
    expect(screen.queryByRole("button", { name: /Run command ×2 details/ })).toBeNull()
  })

  it("marks every parallel pending call as running, including non-shell tools", () => {
    const pendingRead: ToolCall = { ...makeToolCall("Read", { file_path: "src/pending.ts" }), id: "pending-read" }
    const pendingSearch: ToolCall = { ...makeToolCall("Grep", { pattern: "pending-symbol" }), id: "pending-search" }
    const pendingShell: ToolCall = { ...makeToolCall("Bash", { command: "bun test" }), id: "pending-shell" }
    const completed: ToolCall = { ...makeToolCall("Read", { file_path: "src/completed.ts" }), id: "completed", result: "source" }

    render(
      <CollapsibleToolCalls
        toolCalls={[pendingRead, pendingSearch, pendingShell, completed]}
        expandAll
        expandToolPayloads={false}
        activeToolCallId={null}
        isAgentActive
      />,
    )

    expect(screen.getByText("3 running")).toBeInTheDocument()
    expect(screen.getAllByRole("img", { name: "Tool call running" })).toHaveLength(3)
    for (const target of [/Read file details: src\/pending.ts/, /Search files details: pending-symbol/, /Run command details: bun test/]) {
      const disclosure = screen.getByRole("button", { name: target })
      expect(within(disclosure).getByRole("img", { name: "Tool call running" })).toBeInTheDocument()
    }
    expect(within(screen.getByRole("button", { name: /Read file details: src\/completed.ts/ })).queryByRole("img", { name: "Tool call running" })).toBeNull()
  })

  it("lets the user collapse a live group and leaves its running count visible", () => {
    const completed: ToolCall = { ...makeToolCall("Read", { file_path: "/tmp/completed.ts" }), id: "completed", result: "contents" }
    const pending: ToolCall = { ...makeToolCall("Edit", { file_path: "/tmp/in-progress.ts" }), id: "pending" }

    render(
      <CollapsibleToolCalls
        toolCalls={[completed, pending]}
        expandAll={false}
        expandToolPayloads={false}
        activeToolCallId={null}
        isAgentActive
      />,
    )

    const disclosure = screen.getByRole("button", { name: /Collapse 2 tool calls/ })
    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("/tmp/in-progress.ts")).toBeInTheDocument()

    fireEvent.click(disclosure)

    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("/tmp/in-progress.ts")).toBeNull()
    expect(within(disclosure).getByText("1 running")).toBeInTheDocument()
  })

  it("summarizes equivalent operations consistently across providers without duplicate tool chips", () => {
    const toolCalls: ToolCall[] = [
      { ...makeToolCall("Read", { file_path: "/tmp/read.ts" }), id: "read", result: "ok" },
      { ...makeToolCall("Bash", { command: "bun test" }), id: "bash", result: "ok" },
      { ...makeToolCall("functions.exec_command", { cmd: "bun run build" }), id: "exec", result: "ok" },
      { ...makeToolCall("Grep", { pattern: "needle" }), id: "search", result: "ok" },
    ]

    render(
      <CollapsibleToolCalls toolCalls={toolCalls} expandAll={false} expandToolPayloads={false} activeToolCallId={null} />,
    )

    const disclosure = screen.getByRole("button", { name: /Expand 4 tool calls/ })
    expect(within(disclosure).getByText("4 tool calls")).toBeInTheDocument()
    expect(within(disclosure).getByText("1 read · 2 commands · 1 search")).toBeInTheDocument()
    expect(within(disclosure).queryByText("Read file")).toBeNull()
    expect(within(disclosure).queryByText(/Run command/)).toBeNull()
    expect(screen.queryByText(/×2/)).toBeNull()
  })

  it("gives collapsed failures an explicit count", () => {
    const toolCalls: ToolCall[] = [
      { ...makeToolCall("Read", { file_path: "/tmp/a.ts" }), id: "read", result: "ok" },
      { ...makeToolCall("Bash", { command: "bun test" }), id: "shell", result: "exit 1", isError: true },
      { ...makeToolCall("Read", { file_path: "/tmp/missing.ts" }), id: "failed-read", result: "ENOENT", isError: true },
    ]

    render(
      <CollapsibleToolCalls toolCalls={toolCalls} expandAll={false} expandToolPayloads={false} activeToolCallId={null} />,
    )

    const disclosure = screen.getByRole("button", { name: /Expand 3 tool calls/ })
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    expect(within(disclosure).getByText("2 failed")).toHaveClass("text-destructive")
    expect(disclosure).toHaveAccessibleDescription("2 failed")
    expect(screen.queryByText("ENOENT")).toBeNull()
  })

  it("keeps successful groups free of failure and pending labels", () => {
    const toolCalls: ToolCall[] = [
      { ...makeToolCall("Bash", { command: "bun test" }), id: "shell", result: "ok" },
      { ...makeToolCall("Read", { file_path: "src/a.ts" }), id: "read", result: "" },
    ]

    render(
      <CollapsibleToolCalls toolCalls={toolCalls} expandAll={false} expandToolPayloads={false} activeToolCallId={null} />,
    )

    const disclosure = screen.getByRole("button", { name: /Expand 2 tool calls/ })
    expect(within(disclosure).queryByText(/failed|running|no result/i)).toBeNull()
  })

  it("supports opening and closing the group with Enter and Space", async () => {
    const user = userEvent.setup()
    const toolCalls: ToolCall[] = [
      { ...makeToolCall("Read", { file_path: "src/a.ts" }), id: "first", result: "first source" },
      { ...makeToolCall("Read", { file_path: "src/b.ts" }), id: "second", result: "second source" },
    ]
    render(
      <CollapsibleToolCalls toolCalls={toolCalls} expandAll={false} expandToolPayloads={false} activeToolCallId={null} />,
    )

    const disclosure = screen.getByRole("button", { name: /Expand 2 tool calls/ })
    const panelId = disclosure.getAttribute("aria-controls")
    expect(panelId).toBeTruthy()
    disclosure.focus()
    await user.keyboard("{Enter}")
    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    expect(document.getElementById(panelId!)).toBeInTheDocument()
    expect(screen.getByText("src/a.ts")).toBeInTheDocument()
    await user.keyboard(" ")
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("src/a.ts")).toBeNull()
  })

  it("bounds live history while keeping older pending and failed calls visible", () => {
    const toolCalls: ToolCall[] = Array.from({ length: 7 }, (_, index) => ({
      ...makeToolCall("Read", { file_path: `src/step-${index}.ts` }),
      id: `step-${index}`,
      result: index === 0 || index === 6 ? null : index === 1 ? "ENOENT" : "contents",
      isError: index === 1,
    }))
    render(
      <CollapsibleToolCalls toolCalls={toolCalls} expandAll={false} expandToolPayloads={false} activeToolCallId={null} isAgentActive />,
    )

    for (const index of [0, 1, 4, 5, 6]) {
      expect(screen.getByText(`src/step-${index}.ts`)).toBeInTheDocument()
    }
    expect(screen.queryByText("src/step-2.ts")).toBeNull()
    expect(screen.queryByText("src/step-3.ts")).toBeNull()
    expect(screen.getAllByRole("img", { name: "Tool call running" })).toHaveLength(2)
    expect(screen.getByRole("img", { name: "Tool call failed" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show 2 earlier steps" }))
    expect(screen.getByText("src/step-2.ts")).toBeInTheDocument()
    expect(screen.getByText("src/step-3.ts")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /earlier steps/ })).toBeNull()
  })

  it("shows missing historical results without claiming they are still running", () => {
    const toolCalls: ToolCall[] = [
      { ...makeToolCall("Read", { file_path: "src/a.ts" }), id: "pending" },
      { ...makeToolCall("Read", { file_path: "src/b.ts" }), id: "done", result: "" },
    ]
    render(
      <CollapsibleToolCalls toolCalls={toolCalls} expandAll={false} expandToolPayloads={false} activeToolCallId={null} />,
    )

    expect(screen.getByText("1 no result")).toBeInTheDocument()
    expect(screen.queryByText(/running/i)).toBeNull()
  })
})

describe("ToolCallCard mobile payload controls", () => {
  beforeEach(() => {
    mobileViewport = true
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    })
  })

  afterEach(() => {
    mobileViewport = false
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    })
  })

  it.each([
    ["Unix", "/Users/designer/projects/cogpit/src/components/timeline/", "ToolCallCard.tsx"],
    ["Windows", "C:\\Users\\designer\\projects\\cogpit\\src\\components\\timeline\\", "ToolCallCard.tsx"],
  ])("preserves the basename of a long %s path and keeps the full path accessible", (_platform, directory, basename) => {
    const filePath = `${directory}${basename}`
    const toolCall: ToolCall = { ...makeToolCall("Read", { file_path: filePath }), result: "File contents" }

    render(<ToolCallCard toolCall={toolCall} />)

    const disclosure = screen.getByRole("button", { name: `Toggle Read file details: ${filePath}` })
    const summary = within(disclosure).getByTitle(filePath)
    expect(within(summary).getByText(directory)).toHaveClass("truncate")
    expect(within(summary).getByText(basename)).toHaveClass("shrink-0")
    expect(summary.textContent).toBe(filePath)

    fireEvent.click(disclosure)
    expect(within(screen.getByLabelText("Call details")).getByText(filePath)).toBeInTheDocument()
    expect(disclosure).toHaveAccessibleName(`Toggle Read file details: ${filePath}`)
  })

  it("keeps a non-path description readable even when it mentions a long file path", () => {
    const description = "Inspect /Users/designer/projects/cogpit/src/components/timeline/ToolCallCard.tsx"
    const toolCall: ToolCall = { ...makeToolCall("Bash", { command: "bun run check", description }), result: "Checked" }

    render(<ToolCallCard toolCall={toolCall} />)

    const disclosure = screen.getByRole("button", { name: `Toggle Run command details: ${description}` })
    const summary = within(disclosure).getByTitle(description)
    expect(summary).toHaveClass("line-clamp-2")
    expect(within(disclosure).getByText(description)).toBe(summary)
    expect(within(summary).queryByText("ToolCallCard.tsx")).toBeNull()
  })

  it("uses the same disclosure and detail structure on mobile", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Edit", {
        file_path: "src/mobile.ts",
        old_string: "const mobile = false",
        new_string: "const mobile = true",
      }),
      result: "Edit applied",
    }

    render(<ToolCallCard toolCall={toolCall} isAgentActive={false} />)
    const disclosure = screen.getByRole("button", { name: /Edit file details/ })
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "Expand diff" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Raw input" })).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("button", { name: "Diff" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Result" })).toBeNull()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
  })

  it("bounds long single-line results and lets mobile readers expand and copy them", async () => {
    const result = "x".repeat(1001)
    const toolCall: ToolCall = {
      ...makeToolCall("Write", { file_path: "src/mobile.ts" }),
      result,
    }

    const { container } = render(
      <ToolCallCard toolCall={toolCall} isAgentActive={false} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Write file details/ }))

    const resultBlock = container.querySelector("pre")
    expect(resultBlock).toHaveClass("max-h-96", "overflow-auto")
    expect(resultBlock?.textContent).toBe("x".repeat(1000))
    const more = screen.getByRole("button", { name: "Show more" })
    expect(more).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(more)
    expect(resultBlock?.textContent).toBe(result)
    expect(more).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Result copied" })).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Show less" }))
    expect(resultBlock?.textContent).toBe("x".repeat(1000))
  })

  it("uses line-based expansion for mobile Read results", () => {
    const toolCall: ToolCall = {
      ...makeToolCall("Read", { file_path: "src/mobile.ts" }),
      result: Array.from({ length: 10 }, (_, index) => `${index + 1}→line ${index + 1}`).join("\n"),
    }
    render(<ToolCallCard toolCall={toolCall} expandToolPayloads />)
    expect(screen.getByText("line 8")).toBeTruthy()
    expect(screen.queryByText("line 9")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "+2 lines" }))
    expect(screen.getByText("line 10")).toBeTruthy()
  })

  it("keeps mobile payloads closed by default", () => {
    const toolCall: ToolCall = { ...makeToolCall("Read", { file_path: "x.ts" }), result: "source" }
    render(<ToolCallCard toolCall={toolCall} />)
    expect(screen.getByRole("button", { name: /Read file details/ })).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("source")).toBeNull()
  })

})

describe("ToolCallCard mobile AskUserQuestion rendering", () => {
  const questions = [
    { question: "What should we do next?", options: [{ label: "Continue" }, { label: "Pause" }] },
  ]

  function makeAskUserQuestionCall(result: string | null): ToolCall {
    return {
      id: "mobile-question-id",
      name: "AskUserQuestion",
      input: { questions },
      result,
      isError: false,
      timestamp: new Date().toISOString(),
    }
  }

  beforeEach(() => {
    mobileViewport = true
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    })
  })

  afterEach(() => {
    mobileViewport = false
    mockPendingInteraction = null
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    })
  })

  it("keeps a completed question expanded as readable history", () => {
    const toolCall = makeAskUserQuestionCall("User chose Continue")
    render(<ToolCallCard toolCall={toolCall} isAgentActive={false} />)

    expect(screen.getByRole("region", { name: "Question history" })).toBeTruthy()
    expect(screen.getByText("Decision requested")).toBeTruthy()
    expect(screen.getByText("Answered")).toBeTruthy()
    expect(screen.getByText("Selected")).toBeTruthy()
    expect(screen.queryByText("Input")).toBeNull()
    expect(screen.queryByText("Result")).toBeNull()
    expect(screen.queryByRole("button", { name: "Expand Question tool call" })).toBeNull()
  })

  it("keeps a live active question expanded and actionable", () => {
    mockPendingInteraction = {
      type: "question",
      toolUseId: "mobile-question-id",
      questions,
    }
    const toolCall = makeAskUserQuestionCall(null)
    render(<ToolCallCard toolCall={toolCall} isAgentActive={true} />)

    expect(screen.getByText("Decision requested")).toBeTruthy()
    expect(screen.getByText("Waiting for answer")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Expand Question tool call" })).toBeNull()
    expect(screen.getByText("Continue")).toBeTruthy()
    expect(screen.getByText("Pause")).toBeTruthy()
    expect(screen.getByText("Send answer")).toBeTruthy()
  })

  it("uses the payload expansion level for mobile question details", () => {
    const toolCall = makeAskUserQuestionCall("User chose Continue")

    render(<ToolCallCard toolCall={toolCall} expandToolPayloads isAgentActive={false} />)

    expect(screen.getByText("Input")).toBeTruthy()
    expect(screen.getByText("Result")).toBeTruthy()
  })
})

describe("ToolCallCard sectioned Bash commands", () => {
  const sectioned: ToolCall = {
    ...makeToolCall("Bash", {
      command: "echo ---HOTSWAP; grep -rl hot-swap server; echo ---CONFIG; cat src/a.tsx; echo ---CAPS; grep -n configWrite src; echo ---ROUTE; ls server/routes; echo ---TESTS; ls server/__tests__",
      description: "Survey settings infrastructure",
    }),
    result: "---HOTSWAP\nserver/lib/cliProcess.ts\n---CONFIG\nline1\nline2\nline3\n---CAPS\n---ROUTE\nconfig.ts\n---TESTS\nfoo.test.ts",
  }

  it("uses the command description as its readable collapsed summary", () => {
    render(<ToolCallCard toolCall={sectioned} />)
    const disclosure = screen.getByRole("button", { name: /Run command details: Survey settings infrastructure/ })
    expect(within(disclosure).getByText("Run command")).toBeInTheDocument()
    expect(within(disclosure).getByText("Survey settings infrastructure")).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Sections:/)).toBeNull()
    expect(screen.queryByText(/echo ---HOTSWAP/)).toBeNull()
  })

  it("expands into one row per section with its command and output size", () => {
    render(<ToolCallCard toolCall={sectioned} />)
    fireEvent.click(screen.getByRole("button", { name: /Run command details/ }))

    expect(screen.getByText("5 commands")).toBeInTheDocument()
    expect(screen.getByText("Survey settings infrastructure")).toBeInTheDocument()
    const config = screen.getByRole("button", { name: "CONFIG section: cat src/a.tsx" })
    expect(config.textContent).toContain("3 lines")
    expect(screen.queryByRole("button", { name: "CAPS section: grep -n configWrite src" })).toBeNull()
    expect(screen.getByLabelText("CAPS section: grep -n configWrite src").textContent).toContain("No output")
    expect(screen.getByRole("region", { name: "Bash commands" })).toBeInTheDocument()
    expect(screen.queryByText("line1")).toBeNull()

    fireEvent.click(config)
    expect(screen.getByText("line1")).toBeInTheDocument()
    expect(screen.getByText("line3")).toBeInTheDocument()
  })

  it("marks sections the result never reached", () => {
    const truncated: ToolCall = { ...sectioned, result: "---HOTSWAP\nserver/lib/cliProcess.ts\n---CONFIG\nline1" }
    render(<ToolCallCard toolCall={truncated} />)
    fireEvent.click(screen.getByRole("button", { name: /Run command details/ }))
    expect(screen.getByLabelText(/ROUTE section/).textContent).toContain("Not run")
    expect(screen.getAllByText("Not run")).toHaveLength(3)
  })

  it("names unlabelled sections after their leading command word", () => {
    const bare: ToolCall = {
      ...makeToolCall("Bash", { command: "ls server; echo ---; grep -rn foo src" }),
      result: "a\n---\nb",
    }
    render(<ToolCallCard toolCall={bare} />)
    expect(screen.getByText("2 commands · ls, grep")).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Sections:/)).toBeNull()
  })

  it("shows output sizes on individual sections without a redundant volume header", () => {
    render(<ToolCallCard toolCall={sectioned} />)
    fireEvent.click(screen.getByRole("button", { name: /Run command details/ }))
    expect(screen.queryByRole("img", { name: /Output share/ })).toBeNull()
    expect(screen.getByRole("button", { name: "CONFIG section: cat src/a.tsx" })).toHaveTextContent("3 lines")
    expect(screen.queryByText("6 lines")).toBeNull()
  })

  it("summarizes a command batch without adding aggregate kind labels", () => {
    const mixed: ToolCall = {
      ...makeToolCall("Bash", {
        command: "echo ---SRC; cat src/a.ts; echo ---FIND; grep -rn foo src; echo ---PATCH; sed -i '' 's/a/b/' src/a.ts; echo ---TEST; bun run test",
      }),
      result: "---SRC\nconst a = 1\n---FIND\nsrc/b.ts:4:foo\n---PATCH\n---TEST\nok",
    }
    render(<ToolCallCard toolCall={mixed} />)
    expect(screen.getByText("4 commands · SRC, FIND, PATCH, TEST")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Run command details/ }))
    expect(screen.getByText("4 commands")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /SRC section/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /FIND section/ })).toBeInTheDocument()
    expect(screen.getByLabelText(/PATCH section/)).toHaveTextContent("No output")
    expect(screen.getByRole("button", { name: /TEST section/ })).toBeInTheDocument()
    expect(screen.queryByText("1 read · 1 search · 1 run · 1 write")).toBeNull()
  })

  it("exposes an earlier section failure before opening a shell call that returned success", () => {
    const swallowed: ToolCall = {
      ...makeToolCall("Bash", { command: "echo ---A; cat src/missing.ts; echo ---B; ls src" }),
      result: "---A\ncat: src/missing.ts: No such file or directory\n---B\nApp.tsx",
      isError: false,
    }
    render(<ToolCallCard toolCall={swallowed} />)

    const disclosure = screen.getByRole("button", { name: /Run command details/ })
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    expect(within(disclosure).getByText("Failed")).toBeInTheDocument()
    expect(disclosure).toHaveAccessibleDescription(/failed/i)
    expect(within(disclosure).getByRole("img", { name: "Tool call failed" })).toBeInTheDocument()
    expect(within(disclosure).queryByRole("img", { name: "Tool call completed" })).toBeNull()

    fireEvent.click(disclosure)
    expect(within(screen.getByRole("button", { name: /A section/ })).getByText("Failed")).toHaveClass("text-destructive")
  })

  it("counts an earlier section failure in a collapsed activity group", () => {
    const swallowed: ToolCall = {
      ...makeToolCall("Bash", { command: "echo ---A; cat src/missing.ts; echo ---B; ls src" }),
      id: "sectioned-shell",
      result: "---A\ncat: src/missing.ts: No such file or directory\n---B\nApp.tsx",
      isError: false,
    }
    const completed: ToolCall = { ...makeToolCall("Read", { file_path: "src/App.tsx" }), id: "read", result: "source" }

    render(
      <CollapsibleToolCalls toolCalls={[swallowed, completed]} expandAll={false} expandToolPayloads={false} activeToolCallId={null} />,
    )

    const disclosure = screen.getByRole("button", { name: /Expand 2 tool calls/ })
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    expect(within(disclosure).getByText("1 failed")).toHaveClass("text-destructive")
    expect(disclosure).toHaveAccessibleDescription("1 failed")
    expect(screen.queryByRole("button", { name: /Run command details/ })).toBeNull()
  })

  it("opens files named in a command, resolved against the session cwd", () => {
    const withPaths: ToolCall = {
      ...makeToolCall("Bash", { command: "echo ---A; sed -n 1,80p server/routes/config.ts; echo ---B; grep -rn foo src" }),
      result: "---A\nline\n---B\nsrc/b.ts:4:foo",
    }
    render(<ToolCallCard toolCall={withPaths} />)
    fireEvent.click(screen.getByRole("button", { name: /Run command details/ }))
    expect(screen.getByText("L1–80")).toBeInTheDocument()
    fireEvent.click(screen.getByTitle("Open /repo/server/routes/config.ts"))
    expect(mockJsonFetchFn).toHaveBeenCalledWith(
      "/api/open-in-editor",
      expect.objectContaining({ path: "/repo/server/routes/config.ts" }),
    )
    fireEvent.click(screen.getByRole("button", { name: /B section/ }))
    fireEvent.click(screen.getByTitle("Open /repo/src/b.ts:4"))
    expect(mockJsonFetchFn).toHaveBeenLastCalledWith(
      "/api/open-in-editor",
      expect.objectContaining({ path: "/repo/src/b.ts", line: 4 }),
    )
  })

  it("uses the same command UI for an ordinary Bash call", () => {
    const plain: ToolCall = { ...makeToolCall("Bash", { command: "bun test" }), result: "ok" }
    render(<ToolCallCard toolCall={plain} />)
    fireEvent.click(screen.getByRole("button", { name: /Run command details/ }))
    expect(screen.getByRole("region", { name: "Bash command" })).toBeInTheDocument()
    expect(screen.getByText("ok")).toBeInTheDocument()
    expect(screen.queryByText("1 command")).toBeNull()
    expect(screen.queryByLabelText("bun section: bun test")).toBeNull()
  })
})
