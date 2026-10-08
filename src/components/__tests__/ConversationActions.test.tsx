import { startTransition, useState, type ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ConversationActions } from "../ConversationActions"
import type { ConversationState } from "@/lib/conversationState"

const animationsDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations")
const mocks = vi.hoisted(() => ({ events: [] as string[], navigationPopups: [] as boolean[], fetch: vi.fn(), navigate: vi.fn(), state: null as ConversationState | null }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch }))
vi.mock("@/lib/conversationState", () => {
  const state: ConversationState = {
    conversation: { id: "conversation", revision: 1, createdAt: 1, updatedAt: 1, binding: { hostId: "local", agent: "acp", instanceId: "account", sessionId: "source", cwd: "/workspace", filePath: "/workspace/source.jsonl", nativeSessionId: "native" } },
    commands: [], cursor: 0, freshness: "current",
  }
  mocks.state = state
  const owner = { subscribe: () => () => {}, snapshot: () => mocks.state! }
  return { conversationStateFor: () => owner }
})
vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>()
  return { ...actual, Dialog: (props: ComponentProps<typeof actual.Dialog>) => <actual.Dialog {...props} onOpenChangeComplete={(open) => {
    mocks.events.push(open ? "opened" : "closed")
    props.onOpenChangeComplete?.(open)
  }} /> }
})

function HandoffActions(props: Omit<ComponentProps<typeof ConversationActions>, "open" | "onOpenChange">) {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>Open provider handoff</button><ConversationActions {...props} open={open} onOpenChange={setOpen} /></>
}

beforeEach(() => {
  mocks.events.length = 0
  mocks.navigationPopups.length = 0
  mocks.navigate.mockReset()
  mocks.state!.pendingTransition = null
  mocks.fetch.mockReset().mockImplementation(async (url: string) => ({ ok: true, json: async () => url === "/api/provider-instances" ? { instances: [] } : { dirName: "target", fileName: "target.jsonl" } }))
})

afterEach(() => {
  if (animationsDescriptor) Object.defineProperty(HTMLElement.prototype, "getAnimations", animationsDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations")
})

describe("conversation handoff navigation", () => {
  it.each([false, true])("finishes closing the dialog before navigating and replacing its session (browser animations: %s)", async (browserAnimations) => {
    if (browserAnimations) {
      Object.defineProperty(HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [] })
    }
    function Host() {
      const [sessionId, setSessionId] = useState("source")
      return <HandoffActions key={sessionId} sessionId={sessionId} onOpen={async (dirName, fileName) => {
        mocks.events.push("navigate")
        mocks.navigationPopups.push(Boolean(document.querySelector('[data-slot="dialog-content"]')))
        mocks.navigate(dirName, fileName)
        await Promise.resolve()
        startTransition(() => setSessionId("target"))
      }} />
    }
    render(<Host />)
    fireEvent.click(screen.getByRole("button", { name: "Open provider handoff" }))
    await screen.findByRole("button", { name: "Start context handoff" })
    mocks.events.length = 0
    fireEvent.click(screen.getByRole("button", { name: "Start context handoff" }))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce())
    expect(mocks.events.indexOf("closed")).toBeLessThan(mocks.events.indexOf("navigate"))
    expect(mocks.navigate).toHaveBeenCalledWith("target", "target.jsonl")
    expect(mocks.navigationPopups).toEqual([false])
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getAllByRole("button", { name: "Open provider handoff" })).toHaveLength(1)
  })

  it("does not navigate or create a session when the user closes the dialog", async () => {
    render(<HandoffActions sessionId="source" onOpen={mocks.navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Open provider handoff" }))
    fireEvent.click(await screen.findByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.fetch.mock.calls.some(([url]) => url === "/api/conversation-transition")).toBe(false)
  })

  it("navigates once if the dialog closes before the handoff response arrives", async () => {
    const originalFetch = mocks.fetch.getMockImplementation()!
    let completeRequest!: () => void
    mocks.fetch.mockImplementation((url: string) => url === "/api/conversation-transition" ? new Promise((resolve) => {
      completeRequest = () => resolve({ ok: true, json: async () => ({ dirName: "target", fileName: "target.jsonl" }) })
    }) : originalFetch(url))
    render(<HandoffActions sessionId="source" onOpen={mocks.navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Open provider handoff" }))
    fireEvent.click(await screen.findByRole("button", { name: "Start context handoff" }))
    await waitFor(() => expect(completeRequest).toBeTypeOf("function"))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    completeRequest()
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce())
    expect(mocks.navigate).toHaveBeenCalledWith("target", "target.jsonl")
  })

  it.each([false, true])("does not navigate from an old owner after switching sessions (replace: %s)", async (replace) => {
    const originalFetch = mocks.fetch.getMockImplementation()!
    let completeRequest!: () => void
    mocks.fetch.mockImplementation((url: string) => url === "/api/conversation-transition" ? new Promise((resolve) => {
      completeRequest = () => resolve({ ok: true, json: async () => ({ dirName: "target", fileName: "target.jsonl" }) })
    }) : originalFetch(url))
    const { rerender } = render(<HandoffActions key="source" sessionId="source" onOpen={mocks.navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Open provider handoff" }))
    fireEvent.click(await screen.findByRole("button", { name: "Start context handoff" }))
    await waitFor(() => expect(completeRequest).toBeTypeOf("function"))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    rerender(<HandoffActions key={replace ? "another" : "source"} sessionId="another-session" onOpen={mocks.navigate} />)
    await act(async () => completeRequest())
    await waitFor(() => expect(mocks.fetch.mock.calls.filter(([url]) => url === "/api/provider-instances")).toHaveLength(2))
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it.each([false, true])("does not redirect from late handoff reconciliation (unmount: %s)", async (unmountOwner) => {
    mocks.state!.pendingTransition = { id: "recover-command", sessionId: "recover-native" }
    const originalFetch = mocks.fetch.getMockImplementation()!
    let completeRequest!: () => void
    mocks.fetch.mockImplementation((url: string) => url === "/api/conversation-transition" ? new Promise((resolve) => {
      completeRequest = () => resolve({ ok: true, json: async () => ({ dirName: "target", fileName: "target.jsonl" }) })
    }) : originalFetch(url))
    const { rerender, unmount } = render(<HandoffActions sessionId="source" onOpen={mocks.navigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Attach recovered session" }))
    await waitFor(() => expect(completeRequest).toBeTypeOf("function"))
    if (unmountOwner) unmount()
    else rerender(<HandoffActions sessionId="another-session" onOpen={mocks.navigate} />)
    await act(async () => completeRequest())
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
