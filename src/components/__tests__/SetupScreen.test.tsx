import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentCheck } from "../../../shared/contracts/agentCheck"
import {
  BUNDLED_SIGNED_OUT,
  MISSING_CLAUDE,
  MISSING_CODEX,
  MISSING_COPILOT,
} from "../AgentCheck/__tests__/fixtures"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

const validation = vi.hoisted(() => ({
  status: "idle" as "idle" | "valid",
  error: null as string | null,
  debouncedValidate: vi.fn(),
  save: vi.fn(),
}))
vi.mock("@/hooks/useConfigValidation", () => ({
  useConfigValidation: () => validation,
}))

import { SetupScreen } from "../SetupScreen"

function respond(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body })
}

/** A server whose agent check answers `checks` in turn, the last one repeating. */
function serve(checks: AgentCheck[][], detect: { status: number; body: unknown } = { status: 200, body: { success: true } }) {
  let call = 0
  mocks.authFetch.mockImplementation((url: string) => {
    if (url === "/api/agent-check") {
      const agents = checks[Math.min(call++, checks.length - 1)]
      return respond({ agents, checkedAt: "2026-11-04T00:00:00.000Z" })
    }
    if (url === "/api/config/detect") return respond(detect.body, detect.status)
    throw new Error(`Unexpected request: ${url}`)
  })
}

const NOTHING = [MISSING_CLAUDE, MISSING_CODEX, MISSING_COPILOT]
const BUNDLED_ONLY = [BUNDLED_SIGNED_OUT, MISSING_CODEX, MISSING_COPILOT]

describe("SetupScreen", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset()
    validation.status = "idle"
    validation.error = null
    validation.debouncedValidate.mockReset()
    validation.save.mockReset()
  })

  it("lists every agent with how to install it, and holds Continue until one is installed", async () => {
    serve([NOTHING])
    render(<SetupScreen onConfigured={vi.fn()} />)

    expect(await screen.findAllByText("Not installed")).toHaveLength(3)
    expect(screen.getByText("npm install -g @openai/codex")).toBeInTheDocument()
    expect(screen.getAllByRole("link", { name: /Install guide/ })[1]).toHaveAttribute("href", MISSING_CODEX.install.page)
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled()
    expect(screen.getByText("Install one of these, then select Check again.")).toBeInTheDocument()
  })

  it("lets a person with only the bundled copy continue, and tells them how to sign in", async () => {
    serve([BUNDLED_ONLY])
    const onConfigured = vi.fn()
    render(<SetupScreen onConfigured={onConfigured} />)

    const row = (await screen.findByText("Claude Code")).closest("li")!
    expect(within(row).getByText("Not signed in")).toBeInTheDocument()
    expect(within(row).getByText("Version 2.1.306 · Included with Cogpit")).toBeInTheDocument()
    expect(within(row).getByText(BUNDLED_SIGNED_OUT.signIn!.command)).toBeInTheDocument()
    expect(screen.getByText("You can sign in now, or after you continue.")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(onConfigured).toHaveBeenCalled())
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/config/detect", { method: "POST" })
  })

  it("checks again on request, so an agent installed meanwhile shows up", async () => {
    serve([NOTHING, BUNDLED_ONLY])
    render(<SetupScreen onConfigured={vi.fn()} />)
    await screen.findAllByText("Not installed")

    fireEvent.click(screen.getByRole("button", { name: "Check again" }))

    expect(await screen.findByText("Not signed in")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled()
  })

  it("shows the server's words when nothing can be adopted after all", async () => {
    serve([BUNDLED_ONLY], { status: 409, body: { error: "No coding agent was found on this computer yet." } })
    const onConfigured = vi.fn()
    render(<SetupScreen onConfigured={onConfigured} />)
    await screen.findByText("Not signed in")

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("No coding agent was found on this computer yet.")
    expect(onConfigured).not.toHaveBeenCalled()
  })

  it("keeps a custom folder for a moved Claude Code history under Advanced", async () => {
    serve([NOTHING])
    validation.status = "valid"
    validation.save.mockResolvedValueOnce({ success: true, claudeDir: "/data/claude" })
    const onConfigured = vi.fn()
    render(<SetupScreen onConfigured={onConfigured} />)

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }))
    fireEvent.change(screen.getByLabelText("Claude Code folder"), { target: { value: "/data/claude" } })
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }))

    await waitFor(() => expect(onConfigured).toHaveBeenCalled())
    expect(validation.save).toHaveBeenCalledWith("/data/claude")
    expect(validation.debouncedValidate).toHaveBeenCalledWith("/data/claude")
  })
})
