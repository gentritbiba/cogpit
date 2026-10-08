import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConversationComposer } from "../ConversationComposer"
import { MobileSessionInfoBar } from "../SessionInfoBar.mobile"
import type { ParsedSession } from "../../../shared/session/types"

vi.mock("../DeviceSwitcher", () => ({ DeviceSwitcher: () => null }))
vi.mock("../header-shared", () => ({ ContextBadge: () => null }))
vi.mock("@/hooks/useSessionArchive", () => ({ useSessionArchiveToggle: () => null }))
vi.mock("@/lib/auth", () => ({ authFetch: async () => ({ ok: true, json: async () => ({ instances: [], tasks: [] }) }) }))
vi.mock("@/lib/conversationState", () => {
  const state = { conversation: null, commands: [], cursor: 0, freshness: "current" }
  return { EMPTY_CONVERSATION: state, conversationStateFor: () => ({ subscribe: () => () => {}, snapshot: () => state }) }
})

function Host({ sessionId, readOnly = false }: { sessionId: string; readOnly?: boolean }) {
  const [open, setOpen] = useState(false)
  return <>
    <MobileSessionInfoBar session={{ sessionId, cwd: "/workspace" } as ParsedSession} sessionSource={null} isSubAgentView={false} isLive={false} canArchive={false} claudeRawMessages={[]} creatingSession={false} onNewSession={vi.fn()} onProviderHandoff={readOnly ? undefined : () => setOpen(true)} />
    <ConversationComposer sessionId={sessionId} readOnly={readOnly} onOpen={vi.fn()} handoffOpen={open} onHandoffOpenChange={setOpen}><textarea aria-label="Composer" /></ConversationComposer>
  </>
}

describe("provider handoff menu", () => {
  it("opens from the mobile menu, closes without losing the composer, and replaces its owner", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Host key="source" sessionId="source" />)
    expect(screen.queryByText("Continue with another provider…")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Session actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Continue with another provider…" }))
    expect(await screen.findByRole("dialog", { name: "Continue this conversation" })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("textbox", { name: "Composer" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Session actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Continue with another provider…" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    rerender(<Host key="target" sessionId="target" />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getAllByRole("textbox", { name: "Composer" })).toHaveLength(1)
    expect(screen.queryByRole("button", { name: /Continue with another provider/ })).not.toBeInTheDocument()
  })

  it("has no handoff option for a read-only mobile session", async () => {
    const user = userEvent.setup()
    render(<Host sessionId="source" readOnly />)
    await user.click(screen.getByRole("button", { name: "Session actions" }))
    expect(screen.queryByRole("menuitem", { name: "Continue with another provider…" })).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
