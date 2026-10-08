import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"
import { AGENT_KINDS } from "../../../shared/session/agent-descriptors"
import type { ConversationState } from "@/lib/conversationState"
import { __resetIdentityForTest, setActiveIdentity } from "@/lib/device"

const owner = vi.hoisted(() => ({ state: {} as ConversationState, action: vi.fn(), listeners: new Set<() => void>() }))
vi.mock("@/lib/conversationState", () => ({
  EMPTY_CONVERSATION: { conversation: null, commands: [], cursor: 0, freshness: "waiting" },
  conversationStateFor: () => ({ snapshot: () => owner.state, subscribe: (listener: () => void) => { owner.listeners.add(listener); return () => owner.listeners.delete(listener) }, action: owner.action }),
}))
vi.mock("@/hooks/useSessionNamer", () => ({ useSessionNamer: () => () => undefined }))
import { ConversationQueue } from "../ConversationQueue"

const diagnostic = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"
function failure(id: string): CommandReceipt {
  return { id, conversationId: "conversation", sessionId: "session", bindingRevision: 1, state: "failed", intent: "queue", message: `Request ${id}`, error: diagnostic, position: 1, createdAt: 1, updatedAt: 1 }
}
function update(commands: CommandReceipt[], conversationId = "conversation") {
  owner.state = { conversation: { id: conversationId, revision: 1, binding: { hostId: "local", agent: AGENT_KINDS[0], instanceId: "default", sessionId: "session" }, createdAt: 1, updatedAt: 1 }, commands, cursor: 1, freshness: "current" }
  for (const listener of owner.listeners) listener()
}
beforeEach(() => { localStorage.clear(); owner.action.mockReset(); owner.listeners.clear(); __resetIdentityForTest(); window.history.replaceState(null, "", "/"); update([failure("one"), failure("two")]) })
afterEach(() => { __resetIdentityForTest(); window.history.replaceState(null, "", "/") })

describe("message delivery problems", () => {
  it("dismisses failures immediately and keeps them dismissed through polling and remounting", async () => {
    const commands = owner.state.commands
    const view = render(<ConversationQueue sessionId="session" />)
    await userEvent.click(screen.getAllByRole("button", { name: "Dismiss failed message" })[0]!)
    expect(screen.queryByText("Request one")).not.toBeInTheDocument()
    act(() => update([...commands]))
    expect(screen.queryByText("Request one")).not.toBeInTheDocument()
    view.unmount()
    render(<ConversationQueue sessionId="session" />)
    expect(screen.queryByText("Request one")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Dismiss failed message" }))
    expect(screen.queryByRole("region", { name: "Message delivery problems" })).not.toBeInTheDocument()
    expect(commands).toHaveLength(2)
    expect(commands.every((command) => command.state === "failed")).toBe(true)
    expect(owner.action).not.toHaveBeenCalled()
    act(() => update([...commands, failure("three")]))
    expect(screen.getByText("Request three")).toBeInTheDocument()
  })

  it("lets read-only viewers dismiss their notices without changing delivery state", async () => {
    update([failure("one")])
    render(<ConversationQueue sessionId="session" readOnly />)
    await userEvent.click(screen.getByRole("button", { name: "Dismiss failed message" }))
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
    expect(owner.action).not.toHaveBeenCalled()
  })

  it("restores dismissals after the conversation loads asynchronously", async () => {
    update([failure("one")])
    const view = render(<ConversationQueue sessionId="session" />)
    await userEvent.click(screen.getByRole("button", { name: "Dismiss failed message" }))
    view.unmount()
    owner.state = { conversation: null, commands: [], cursor: 0, freshness: "waiting" }
    render(<ConversationQueue sessionId="session" />)
    act(() => update([failure("one")]))
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
  })

  it("scopes dismissals to the conversation, account, and device", async () => {
    setActiveIdentity("alice")
    update([failure("one")])
    let view = render(<ConversationQueue sessionId="session" />)
    await userEvent.click(screen.getByRole("button", { name: "Dismiss failed message" }))
    view.unmount()
    setActiveIdentity("bob")
    view = render(<ConversationQueue sessionId="session" />)
    expect(screen.getByText("Request one")).toBeInTheDocument()
    view.unmount()
    setActiveIdentity("alice")
    window.history.replaceState(null, "", "/d/another-device/")
    view = render(<ConversationQueue sessionId="session" />)
    expect(screen.getByText("Request one")).toBeInTheDocument()
    view.unmount()
    window.history.replaceState(null, "", "/")
    update([failure("one")], "another-conversation")
    view = render(<ConversationQueue sessionId="session" />)
    expect(screen.getByText("Request one")).toBeInTheDocument()
    view.unmount()
    update([failure("one")])
    render(<ConversationQueue sessionId="session" />)
    expect(screen.queryByText("Request one")).not.toBeInTheDocument()
  })

  it("shows a readable explanation for legacy SDK diagnostics and preserves useful errors", () => {
    update([failure("one"), { ...failure("two"), error: `Rate limit exceeded.\n${diagnostic}` }])
    render(<ConversationQueue sessionId="session" />)
    expect(screen.queryByText(/ede_diagnostic/)).not.toBeInTheDocument()
    expect(screen.getByText("The agent stopped before completing this turn. You can continue the conversation.")).toBeInTheDocument()
    expect(screen.getByText("Rate limit exceeded.")).toBeInTheDocument()
  })

  it("keeps uncertain deliveries recoverable and makes failed recovery alerts dismissible", async () => {
    update([{ ...failure("uncertain"), state: "unknown" }])
    owner.action.mockRejectedValue(new Error("Unable to update this delivery"))
    render(<ConversationQueue sessionId="session" />)
    expect(screen.queryByRole("button", { name: "Dismiss failed message" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "History confirms failure" }))
    expect(await screen.findByText("Unable to update this delivery")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Dismiss queue error" }))
    expect(screen.queryByText("Unable to update this delivery")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Resend…" })).toBeInTheDocument()
  })
})
