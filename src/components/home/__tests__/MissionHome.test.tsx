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
vi.mock("@/hooks/useSessionNames", () => ({ useSessionNames: () => ({ names: {} }) }))
vi.mock("@/hooks/useProjectNames", () => ({ useProjectNames: () => ({ names: {} }) }))
vi.mock("@/hooks/useListedPermissions", () => ({ useListedPermissions: () => () => ({ canInteract: state.canInteract }) }))
import { MissionHome } from "../MissionHome"

const row = (sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo => ({
  sessionId, dirName: "-workspace", fileName: `${sessionId}.jsonl`, projectShortName: "workspace",
  lastModified: new Date().toISOString(), size: 1, customTitle: sessionId, ...overrides,
})
const permission = (sessionId: string, requestId: string, timestamp = 1) => ({
  sessionId, requestId, timestamp, toolName: "Bash", summary: "bun test",
})

beforeEach(() => {
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
    fireEvent.click(within(yours).getByRole("button", { name: /lead/ }))
    expect(onOpenSession).toHaveBeenCalledWith("-workspace", "lead.jsonl")
    expect(screen.getByText("Nothing is waiting on you.")).toBeInTheDocument()
    fireEvent.click(within(yours).getByRole("button", { name: "Open lane" }))
    expect(onOpenSession).toHaveBeenLastCalledWith("-workspace", "lane.jsonl")
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
})
