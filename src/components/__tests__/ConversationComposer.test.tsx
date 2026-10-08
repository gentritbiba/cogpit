import { describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { ConversationComposer } from "../ConversationComposer"

vi.mock("@/lib/auth", () => ({ authFetch: async () => ({ ok: true, json: async () => ({ instances: [], tasks: [] }) }) }))
vi.mock("@/lib/conversationState", () => {
  const state = { conversation: null, commands: [], cursor: 0, freshness: "current" }
  return { EMPTY_CONVERSATION: state, conversationStateFor: () => ({ subscribe: () => () => {}, snapshot: () => state }) }
})

describe("conversation composer ownership", () => {
  it("replaces controls once across repeated session handoffs and clears the old dialog", async () => {
    const onOpen = vi.fn()
    const composer = (sessionId: string, handoffOpen = false) => <ConversationComposer sessionId={sessionId} readOnly={false} onOpen={onOpen} handoffOpen={handoffOpen} onHandoffOpenChange={vi.fn()}><textarea aria-label="Composer" /></ConversationComposer>
    const { rerender, unmount } = render(composer("source"))
    expect(screen.queryByRole("button", { name: "Continue with another provider" })).not.toBeInTheDocument()
    await act(async () => rerender(composer("source", true)))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    for (const sessionId of ["target", "another", "source"]) {
      await act(async () => rerender(composer(sessionId)))
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Continue with another provider" })).not.toBeInTheDocument()
      expect(screen.getAllByRole("textbox", { name: "Composer" })).toHaveLength(1)
    }
    await act(async () => unmount())
    expect(screen.queryByRole("button", { name: "Continue with another provider" })).not.toBeInTheDocument()
  })
})
