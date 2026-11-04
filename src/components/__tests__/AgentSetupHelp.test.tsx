import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { makeProviderUpdateInfo } from "@/__tests__/fixtures"

const mocks = vi.hoisted(() => ({ fetchProviderUpdates: vi.fn() }))
vi.mock("@/lib/providerUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providerUpdates")>()),
  fetchProviderUpdates: mocks.fetchProviderUpdates,
}))

import { AgentFailureNotice, AgentInstallHelp, AgentSignInCard } from "@/components/AgentSetupHelp"
import { _resetAgentAvailabilityForTests, refreshAgentAvailability } from "@/lib/agents/availability"
import { registerSignInRunner } from "@/lib/agents/signIn"

const BUNDLED = "/Users/me/.npm/_npx/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"

beforeEach(() => {
  _resetAgentAvailabilityForTests()
  mocks.fetchProviderUpdates.mockResolvedValue([
    makeProviderUpdateInfo({ provider: "claude", binaryPath: BUNDLED, installMethod: "bundled", status: "unknown", updateCommand: null }),
    makeProviderUpdateInfo({ provider: "codex", displayName: "Codex", installed: false, installCommand: "npm install -g @openai/codex", binaryPath: null, status: "not-installed" }),
  ])
})

afterEach(() => vi.clearAllMocks())

describe("AgentSignInCard", () => {
  it("opens the terminal on the binary Cogpit runs, even one no shell can find by name", async () => {
    const runner = vi.fn()
    const unregister = registerSignInRunner(runner)
    await act(() => refreshAgentAvailability())
    render(<AgentSignInCard kind="claude" detail="Invalid API key · Fix external API key" />)

    expect(screen.getByRole("alert")).toHaveTextContent("Claude Code isn't signed in.")
    expect(screen.getByText("It said: Invalid API key · Fix external API key")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(runner).toHaveBeenCalledExactlyOnceWith({
      kind: "claude", name: "Sign in to Claude Code", command: BUNDLED, args: ["auth", "login"],
    })
    expect(screen.getByText("Finish signing in in the terminal below, then send your message again.")).toBeInTheDocument()
    unregister()
  })

  it("shows the command to copy where there is no terminal to open", async () => {
    render(<AgentSignInCard kind="claude" />)
    await waitFor(() => expect(screen.getByTitle(`${BUNDLED} auth login`)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument()
    expect(screen.getByText("Run this on the computer running Cogpit:")).toBeInTheDocument()
  })
})

describe("AgentInstallHelp", () => {
  it("links the agent's install page and offers the command the server gave for its platform", async () => {
    render(<AgentInstallHelp kind="codex" />)
    expect(screen.getByRole("status")).toHaveTextContent("Codex isn't installed on this computer.")
    expect(screen.getByText("How to install").closest("a")).toHaveAttribute("href", "https://developers.openai.com/codex/cli")
    expect(await screen.findByTitle("npm install -g @openai/codex")).toBeInTheDocument()
  })
})

describe("AgentFailureNotice", () => {
  it("shows any other failure as a red line with the agent's words", () => {
    render(<AgentFailureNotice kind="claude" failure={{ reason: "http_status", httpStatus: 529, message: "API Error: Overloaded" }} />)
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code stopped with an error.API Error: Overloaded")
  })

  it("asks to sign in when that is the problem", () => {
    render(<AgentFailureNotice kind="codex" failure={{ reason: "not_signed_in", message: "401 Unauthorized" }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Codex isn't signed in.")
  })
})
