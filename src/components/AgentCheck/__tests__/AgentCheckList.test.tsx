import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ copyToClipboard: vi.fn(async () => true), authFetch: vi.fn() }))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyToClipboard: mocks.copyToClipboard,
}))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { AgentCheckList } from "../AgentCheckList"
import { AgentCheckDialog } from "../AgentCheckDialog"
import { BUNDLED_SIGNED_OUT, MISSING_CODEX, agentCheck } from "./fixtures"

function row(name: string): HTMLElement {
  return screen.getByText(name).closest("li")!
}

describe("AgentCheckList", () => {
  beforeEach(() => {
    mocks.copyToClipboard.mockClear()
    mocks.authFetch.mockReset()
  })

  it("marks a signed-in agent ready and asks nothing more of it", () => {
    render(<AgentCheckList agents={[agentCheck()]} />)

    expect(within(row("Claude Code")).getByText("Ready")).toBeInTheDocument()
    expect(within(row("Claude Code")).getByText("Version 2.1.318")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("copies the install command of a missing agent", async () => {
    render(<AgentCheckList agents={[MISSING_CODEX]} />)

    fireEvent.click(screen.getByRole("button", { name: "Copy the Codex install command" }))

    await waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("npm install -g @openai/codex"))
  })

  it("says plainly when sign-in cannot be told, and still offers the command", () => {
    render(<AgentCheckList agents={[agentCheck({ kind: "copilot", displayName: "GitHub Copilot CLI", signedIn: "unknown" })]} />)

    const copilot = row("GitHub Copilot CLI")
    expect(within(copilot).getByText("Unknown")).toBeInTheDocument()
    expect(within(copilot).getByText(/can't tell if you're signed in/)).toBeInTheDocument()
  })

  it("hands sign-in to the caller when it can start one, keeping the command beside it", () => {
    const onSignIn = vi.fn()
    render(<AgentCheckList agents={[BUNDLED_SIGNED_OUT]} onSignIn={onSignIn} />)

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(onSignIn).toHaveBeenCalledWith(BUNDLED_SIGNED_OUT)
    expect(screen.getByText(BUNDLED_SIGNED_OUT.signIn!.command)).toBeInTheDocument()
  })

  it("offers no Sign in button without a caller to start one", () => {
    render(<AgentCheckList agents={[BUNDLED_SIGNED_OUT]} />)

    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument()
  })
})

describe("AgentCheckDialog", () => {
  it("checks only while open", async () => {
    mocks.authFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [agentCheck()], checkedAt: "" }) })
    const { rerender } = render(<AgentCheckDialog open={false} onOpenChange={vi.fn()} />)
    expect(mocks.authFetch).not.toHaveBeenCalled()

    rerender(<AgentCheckDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByText("Ready")).toBeInTheDocument()
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/agent-check", expect.anything())
  })
})
