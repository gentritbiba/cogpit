import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"
import type { ConversationState } from "@/lib/conversationState"
import { makeTurn } from "@/__tests__/fixtures"

const owner = vi.hoisted(() => ({ state: {} as ConversationState, action: vi.fn(async () => {}), subscribed: 0 }))
vi.mock("@/lib/conversationState", () => ({
  EMPTY_CONVERSATION: { conversation: null, commands: [], cursor: 0, freshness: "waiting" },
  conversationStateFor: () => ({ snapshot: () => owner.state, subscribe: () => { owner.subscribed++; return () => {} }, action: owner.action }),
}))
import { QueuedTurns, waitingCommands } from "../QueuedTurns"

const turnStartedAt = Date.parse("2025-01-15T10:00:00Z")
function command(patch: Partial<CommandReceipt>): CommandReceipt {
  return { id: "c1", conversationId: "conversation", sessionId: "s1", bindingRevision: 1, state: "queued", intent: "queue", message: "test", createdAt: turnStartedAt + 60_000, updatedAt: 1, position: 1, ...patch }
}
function withCommands(commands: CommandReceipt[]) {
  owner.state = { conversation: { id: "conversation", revision: 1, binding: { hostId: "local", agent: "claude", instanceId: "default", sessionId: "s1" }, createdAt: 1, updatedAt: 1 }, commands, cursor: 1, freshness: "current" }
}

beforeEach(() => {
  owner.action.mockClear()
  owner.subscribed = 0
  withCommands([])
})

describe("waitingCommands", () => {
  it("keeps commands that have not started a turn, in queue order", () => {
    const commands = [command({ id: "b", position: 2, message: "second" }), command({ id: "a", position: 1, state: "held" }), command({ id: "done", state: "completed" }), command({ id: "gone", state: "cancelled" })]
    expect(waitingCommands(commands, []).map((c) => c.id)).toEqual(["a", "b"])
  })

  it("drops a delivered command once its turn renders, even before the queue refreshes", () => {
    const delivered = command({ state: "queued", createdAt: turnStartedAt - 500 })
    expect(waitingCommands([delivered], [makeTurn({ userMessage: "test" })])).toEqual([])
    expect(waitingCommands([delivered], [makeTurn({ userMessage: "something else" })])).toEqual([delivered])
  })

  it("ignores turns that started before the command was queued", () => {
    const queued = command({ createdAt: turnStartedAt + 60_000 })
    expect(waitingCommands([queued], [makeTurn({ userMessage: "test" })])).toEqual([queued])
  })

  it("matches one turn per command when the same text is queued twice", () => {
    const commands = [command({ id: "a", position: 1, createdAt: turnStartedAt }), command({ id: "b", position: 2, createdAt: turnStartedAt })]
    expect(waitingCommands(commands, [makeTurn({ userMessage: "test" })]).map((c) => c.id)).toEqual(["b"])
  })

  it("drops a delivered steer, which joins the running turn", () => {
    expect(waitingCommands([command({ intent: "steer", state: "delivered" })], [])).toEqual([])
    expect(waitingCommands([command({ intent: "steer", state: "queued" })], [])).toHaveLength(1)
  })
})

describe("QueuedTurns", () => {
  it("puts the queue controls inside each queued message", async () => {
    withCommands([command({ id: "first", position: 1, message: "first" }), command({ id: "second", position: 2, message: "second" })])
    render(<QueuedTurns sessionId="s1" turns={[makeTurn()]} pendingMessages={[]} canManage isMobile={false} />)

    expect(screen.getByRole("region", { name: "Queued messages" })).toHaveTextContent("Queued")
    expect(screen.queryByText(/^Turn \d/)).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Move up" })).toHaveLength(1)

    await userEvent.click(screen.getByRole("button", { name: "Move up" }))
    expect(owner.action).toHaveBeenCalledWith({ action: "reorder", commandIds: ["second", "first"], sessionId: "s1" })
    await userEvent.click(screen.getAllByRole("button", { name: "Remove from queue" })[0]!)
    expect(owner.action).toHaveBeenLastCalledWith({ action: "cancel", commandId: "first", sessionId: "s1" })
  })

  it("sends now by interrupting, or by steering where the agent supports it", async () => {
    withCommands([command({ id: "first" })])
    const { unmount } = render(<QueuedTurns sessionId="s1" turns={[]} pendingMessages={[]} canManage isMobile={false} />)
    await userEvent.click(screen.getByRole("button", { name: "Send now" }))
    expect(owner.action).toHaveBeenLastCalledWith(expect.objectContaining({ action: "restart", commandId: "first" }))
    unmount()

    owner.state = { ...owner.state, conversation: { ...owner.state.conversation!, binding: { ...owner.state.conversation!.binding, agent: "codex" } } }
    render(<QueuedTurns sessionId="s1" turns={[]} pendingMessages={[]} canManage isMobile={false} />)
    await userEvent.click(screen.getByRole("button", { name: "Send now" }))
    expect(owner.action).toHaveBeenLastCalledWith(expect.objectContaining({ action: "steer", commandId: "first" }))
  })

  it("edits a queued message in place and saves on Enter", async () => {
    withCommands([command({ id: "first" })])
    render(<QueuedTurns sessionId="s1" turns={[]} pendingMessages={[]} canManage isMobile={false} />)

    await userEvent.click(screen.getByRole("button", { name: "Edit" }))
    const editor = screen.getByRole("textbox", { name: "Edit queued message" })
    await userEvent.clear(editor)
    await userEvent.type(editor, "changed{Enter}")
    expect(owner.action).toHaveBeenCalledWith(expect.objectContaining({ action: "edit", commandId: "first", message: "changed", sessionId: "s1" }))
  })

  it("offers to resume a paused queue", async () => {
    withCommands([command({ state: "held", error: "Agent is busy; review and resume the queue." })])
    render(<QueuedTurns sessionId="s1" turns={[]} pendingMessages={[]} canManage isMobile={false} />)

    expect(screen.getByText("Queue paused")).toBeInTheDocument()
    expect(screen.getByText("Agent is busy; review and resume the queue.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Resume" }))
    expect(owner.action).toHaveBeenCalledWith({ action: "resume", sessionId: "s1" })
  })

  it("shows messages still being sent, and no controls or queue reads without send access", () => {
    withCommands([command({})])
    render(<QueuedTurns sessionId="s1" turns={[]} pendingMessages={["sending"]} canManage={false} isMobile={false} />)

    expect(screen.getByText("sending")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(owner.subscribed).toBe(0)
  })

  it("renders nothing when nothing is waiting", () => {
    const { container } = render(<QueuedTurns sessionId="s1" turns={[]} pendingMessages={[]} canManage isMobile={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
