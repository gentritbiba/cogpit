import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PendingHumanInput } from "@/contexts/PendingHumanInputContext"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"

const state = vi.hoisted(() => ({
  sessions: [] as ActiveSessionInfo[], input: {} as PendingHumanInput, canInteract: true,
}))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventory: () => ({ sessions: state.sessions, procBySession: new Map(), processes: [] }),
}))
vi.mock("@/contexts/PendingHumanInputContext", () => ({ usePendingHumanInput: () => state.input }))
const renameSession = vi.fn()
vi.mock("@/hooks/useSessionNames", () => ({ useSessionNames: () => ({ names: {}, rename: renameSession }) }))
vi.mock("@/hooks/useProjectNames", () => ({ useProjectNames: () => ({ names: {} }) }))
vi.mock("@/hooks/useListedPermissions", () => ({ useListedPermissions: () => () => ({ canInteract: state.canInteract }) }))
vi.mock("@/components/ProjectSwitcherList", () => ({ ProjectSwitcherList: () => null, useProjectList: () => [] }))
vi.mock("@/components/ChatInput/ChatInputSettings", () => ({
  ChatInputSettings: ({ agentKind, selectedModel, onAgentKindChange }: { agentKind: string; selectedModel: string; onAgentKindChange?: (kind: "codex") => void }) => (
    <button type="button" onClick={() => onAgentKindChange?.("codex")}>Model {agentKind} {selectedModel || "default"}</button>
  ),
}))
import { MissionHome } from "../MissionHome"

const row = (sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo => ({
  sessionId, dirName: "-workspace", fileName: `${sessionId}.jsonl`, projectShortName: "workspace", cwd: "/workspace",
  lastModified: new Date().toISOString(), size: 1, customTitle: sessionId, ...overrides,
})
const start = () => ({
  defaultAgentKind: "claude" as const,
  model: { selectedModel: "", onModelChange: vi.fn(), selectedEffort: "", onEffortChange: vi.fn() },
  onStart: vi.fn(),
})
const projectChip = (name: string) => within(screen.getByRole("group", { name: "Projects" })).getByRole("button", { name })
const permission = (sessionId: string, requestId: string, timestamp = 1) => ({
  sessionId, requestId, timestamp, toolName: "Bash", summary: "bun test",
})

beforeEach(() => {
  renameSession.mockClear()
  state.sessions = [row("lead"), row("lane", { crew: { rootId: "lead", parentId: "lead", startedAt: 1 } })]
  state.canInteract = true
  state.input = {
    permissionsBySession: new Map(), questionsBySession: new Map(), elicitationsBySession: new Map(), dialogsBySession: new Map(),
    awaitingPermission: new Set(), awaitingQuestion: new Set(), awaitingElicitation: new Set(), awaitingDialog: new Set(), awaitingPlan: new Set(),
    responding: new Set(), refresh: vi.fn(), respond: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn(), answerElicitation: vi.fn(), answerDialog: vi.fn(),
  }
})

describe("MissionHome", () => {
  it("lists roots once and opens the coordinator, keeping members in its crew", () => {
    const onOpenSession = vi.fn()
    render(<MissionHome onOpenSession={onOpenSession} />)
    const yours = screen.getByRole("region", { name: "Your sessions" })
    expect(within(yours).getAllByRole("listitem")).toHaveLength(1)
    fireEvent.click(within(yours).getByRole("button", { name: /^lead/ }))
    expect(onOpenSession).toHaveBeenCalledWith("-workspace", "lead.jsonl")
    expect(screen.getByText("Nothing is waiting on you.")).toBeInTheDocument()
    fireEvent.click(within(yours).getByRole("button", { name: "Show crew (1)" }))
    fireEvent.click(within(yours).getByRole("button", { name: "Open lane" }))
    expect(onOpenSession).toHaveBeenLastCalledWith("-workspace", "lane.jsonl")
  })

  it("names the crew members that need the user or are working and lists the rest on demand", () => {
    const member = (id: string, startedAt: number, overrides: Partial<ActiveSessionInfo> = {}) =>
      row(id, { crew: { rootId: "lead", parentId: "lead", startedAt }, ...overrides })
    state.sessions = [
      row("lead"),
      ...Array.from({ length: 200 }, (_, index) => member(`done${index}`, index)),
      member("asker", 300, { lastActivityAt: new Date(Date.now() - 60_000).toISOString() }),
      member("nested", 301, { crew: { rootId: "lead", parentId: "asker", startedAt: 301 } }),
    ]
    state.input.awaitingPermission = new Set(["asker", "nested"])
    render(<MissionHome onOpenSession={vi.fn()} />)
    const crew = screen.getByRole("group", { name: "lead crew" })
    expect(within(crew).getAllByRole("button", { name: /^Open / }).map((chip) => chip.textContent)).toEqual(["nested", "asker"])
    fireEvent.click(within(crew).getByRole("button", { name: "Show crew (202)" }))
    const list = screen.getByRole("list", { name: "lead crew members" })
    expect(within(list).getAllByRole("button")).toHaveLength(202)
    expect(within(list).getAllByRole("button")[0]).toHaveTextContent("nested · via asker")
    expect(within(list).getAllByRole("button")[0]).toHaveTextContent("needs you")
  })

  it("answers the oldest request in place and protects an in-flight keyboard answer", async () => {
    let finish!: () => void
    state.input.respond = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    state.input.permissionsBySession = new Map([
      ["lane", [permission("lane", "old", 1)]], ["lead", [permission("lead", "new", 2)]],
    ])
    render(<MissionHome onOpenSession={vi.fn()} />)
    const queue = screen.getByRole("region", { name: "Needs you" })
    expect(within(queue).getByText("1 of 2")).toBeInTheDocument()
    fireEvent.keyDown(queue, { key: "Enter" })
    fireEvent.keyDown(queue, { key: "Enter" })
    expect(state.input.respond).toHaveBeenCalledExactlyOnceWith("lane", "old", "allow")
    finish()
  })

  it("moves and opens with the keyboard, without taking shortcuts from an answer field", () => {
    state.input.permissionsBySession = new Map([["lane", [permission("lane", "old")]], ["lead", [permission("lead", "new", 2)]]])
    const onOpenSession = vi.fn()
    render(<MissionHome onOpenSession={onOpenSession} />)
    const queue = screen.getByRole("region", { name: "Needs you" })
    fireEvent.keyDown(queue, { key: "j" })
    expect(within(queue).getByText("2 of 2")).toBeInTheDocument()
    fireEvent.keyDown(queue, { key: "o" })
    expect(onOpenSession).toHaveBeenCalledWith("-workspace", "lead.jsonl")
    const field = document.createElement("textarea")
    queue.append(field)
    fireEvent.keyDown(field, { key: "k" })
    expect(within(queue).getByText("2 of 2")).toBeInTheDocument()
    field.remove()
  })

  it("excludes requests the caller cannot answer, including unlisted sessions", () => {
    state.canInteract = false
    state.input.permissionsBySession = new Map([["unlisted", [permission("unlisted", "p")]]])
    render(<MissionHome onOpenSession={vi.fn()} />)
    expect(screen.getByText("Nothing is waiting on you.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument()
  })

  it("defaults Enter to deny when the provider requests it", () => {
    state.input.permissionsBySession = new Map([["lane", [{ ...permission("lane", "p"), defaultToNo: true }]]])
    render(<MissionHome onOpenSession={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole("region", { name: "Needs you" }), { key: "Enter" })
    expect(state.input.respond).toHaveBeenCalledWith("lane", "p", "deny")
  })

  it("starts a session in the latest project with the message typed on the home", () => {
    const starter = start()
    render(<MissionHome onOpenSession={vi.fn()} start={starter} />)
    expect(projectChip("workspace")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Model claude default" })).toBeInTheDocument()
    const field = screen.getByRole("textbox", { name: "First message" })
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled()
    fireEvent.change(field, { target: { value: "  fix the login form \n" } })
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true })
    expect(starter.onStart).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: "Enter" })
    expect(starter.onStart).toHaveBeenCalledExactlyOnceWith("-workspace", "/workspace", "fix the login form")
    expect(field).toHaveValue("")
  })

  it("starts in the same folder with another agent when the picker switches provider", () => {
    const starter = start()
    render(<MissionHome onOpenSession={vi.fn()} start={starter} />)
    fireEvent.click(screen.getByRole("button", { name: "Model claude default" }))
    expect(screen.getByRole("button", { name: "Model codex default" })).toBeInTheDocument()
    expect(projectChip("workspace")).toHaveAttribute("aria-pressed", "true")
    const field = screen.getByRole("textbox", { name: "First message" })
    fireEvent.change(field, { target: { value: "hello" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(starter.onStart).toHaveBeenCalledExactlyOnceWith(expect.not.stringMatching(/^-workspace$/), "/workspace", "hello")
  })

  it("keeps the project shown when typing began, even as sessions reorder", () => {
    const starter = start()
    const { rerender } = render(<MissionHome onOpenSession={vi.fn()} start={starter} />)
    const field = screen.getByRole("textbox", { name: "First message" })
    fireEvent.change(field, { target: { value: "ship it" } })
    state.sessions = [row("newer", { dirName: "-elsewhere", cwd: "/elsewhere", lastModified: new Date(Date.now() + 60_000).toISOString() }), ...state.sessions]
    rerender(<MissionHome onOpenSession={vi.fn()} start={starter} />)
    expect(projectChip("workspace")).toHaveAttribute("aria-pressed", "true")
    expect(projectChip("elsewhere")).toHaveAttribute("aria-pressed", "false")
    fireEvent.keyDown(field, { key: "Enter" })
    expect(starter.onStart).toHaveBeenCalledExactlyOnceWith("-workspace", "/workspace", "ship it")
  })

  it("switches where the session starts from a recent-project chip", () => {
    state.sessions = [row("here"), row("there", { dirName: "-elsewhere", cwd: "/elsewhere", lastModified: new Date(Date.now() - 60_000).toISOString() })]
    const starter = start()
    render(<MissionHome onOpenSession={vi.fn()} start={starter} />)
    expect(projectChip("workspace")).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(projectChip("elsewhere"))
    expect(projectChip("elsewhere")).toHaveAttribute("aria-pressed", "true")
    expect(projectChip("workspace")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "Other project" })).toBeInTheDocument()
    const field = screen.getByRole("textbox", { name: "First message" })
    fireEvent.change(field, { target: { value: "go" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(starter.onStart).toHaveBeenCalledExactlyOnceWith("-elsewhere", "/elsewhere", "go")
  })

  it("marks rows whose session or crew is working or waiting", () => {
    state.sessions = [row("lead"), row("lane", { crew: { rootId: "lead", parentId: "lead", startedAt: 1 } }), row("quiet")]
    state.input.permissionsBySession = new Map([["lane", [permission("lane", "p")]]])
    state.input.awaitingPermission = new Set(["lane"])
    render(<MissionHome onOpenSession={vi.fn()} />)
    const yours = screen.getByRole("region", { name: "Your sessions" })
    const leadRow = within(yours).getByRole("button", { name: /^lead/ })
    expect(leadRow.querySelector(".bg-warning")).not.toBeNull()
    expect(within(yours).getByRole("button", { name: /^quiet/ }).querySelector(".bg-warning, .bg-success")).toBeNull()
  })

  it("suggests the checkout a worktree session belongs to", () => {
    state.sessions = [row("wt", { dirName: "-repo--worktrees-feature", cwd: "/repo/.worktrees/feature" })]
    const starter = start()
    render(<MissionHome onOpenSession={vi.fn()} start={starter} />)
    expect(projectChip("repo")).toHaveAttribute("aria-pressed", "true")
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value: "hi" } })
    fireEvent.keyDown(screen.getByRole("textbox", { name: "First message" }), { key: "Enter" })
    expect(starter.onStart).toHaveBeenCalledExactlyOnceWith("-repo", "/repo", "hi")
  })

  it("asks for a project when no session suggests one", () => {
    state.sessions = []
    render(<MissionHome onOpenSession={vi.fn()} start={start()} />)
    expect(screen.getByRole("button", { name: "Choose a project" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Model / })).not.toBeInTheDocument()
  })

  it("searches every session, including ones too old to list, and clears with Escape", () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
    state.sessions = [row("lead"), row("today"), row("recent"), row("ancient", { lastModified: old, lastActivityAt: old, lastUserMessage: "migrate billing" })]
    render(<MissionHome onOpenSession={vi.fn()} />)
    const yours = screen.getByRole("region", { name: "Your sessions" })
    expect(within(yours).queryByRole("button", { name: /^ancient/ })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: "/" })
    const search = screen.getByRole("searchbox", { name: "Search sessions" })
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: "billing" } })
    expect(within(yours).getAllByRole("listitem")).toHaveLength(1)
    expect(within(yours).getByRole("button", { name: /^ancient/ })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: "nothing here" } })
    expect(within(yours).getByText("No session matches “nothing here”.")).toBeInTheDocument()
    fireEvent.keyDown(search, { key: "Escape" })
    expect(search).toHaveValue("")
    expect(within(yours).getAllByRole("listitem")).toHaveLength(3)
  })

  it("renames a session in place, saving with Enter and clearing back to its own title", () => {
    render(<MissionHome onOpenSession={vi.fn()} />)
    const yours = screen.getByRole("region", { name: "Your sessions" })
    fireEvent.click(within(yours).getByRole("button", { name: "Rename lead" }))
    const field = within(yours).getByRole("textbox", { name: "Session name" })
    expect(field).toHaveValue("lead")
    fireEvent.change(field, { target: { value: "  Payload dashboard " } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(renameSession).toHaveBeenCalledExactlyOnceWith("lead", "Payload dashboard")
    expect(within(yours).queryByRole("textbox", { name: "Session name" })).not.toBeInTheDocument()

    fireEvent.click(within(yours).getByRole("button", { name: "Rename lead" }))
    fireEvent.change(within(yours).getByRole("textbox", { name: "Session name" }), { target: { value: "" } })
    fireEvent.blur(within(yours).getByRole("textbox", { name: "Session name" }))
    expect(renameSession).toHaveBeenLastCalledWith("lead", "")
  })

  it("drops a rename with Escape and never opens the session while editing", () => {
    const onOpenSession = vi.fn()
    render(<MissionHome onOpenSession={onOpenSession} />)
    const yours = screen.getByRole("region", { name: "Your sessions" })
    fireEvent.click(within(yours).getByRole("button", { name: "Rename lead" }))
    const field = within(yours).getByRole("textbox", { name: "Session name" })
    fireEvent.change(field, { target: { value: "nope" } })
    fireEvent.keyDown(field, { key: "Escape" })
    expect(renameSession).not.toHaveBeenCalled()
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(within(yours).getByRole("button", { name: /^lead/ })).toBeInTheDocument()
  })
})
