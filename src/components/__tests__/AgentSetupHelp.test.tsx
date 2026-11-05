import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { makeProviderUpdateInfo } from "@/__tests__/fixtures"

const mocks = vi.hoisted(() => ({ fetchProviderUpdates: vi.fn(), authFetch: vi.fn() }))
vi.mock("@/lib/providerUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providerUpdates")>()),
  fetchProviderUpdates: mocks.fetchProviderUpdates,
}))
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  authFetch: mocks.authFetch,
}))

import { AgentFailureNotice, AgentInstallHelp, AgentSignInCard } from "@/components/AgentSetupHelp"
import { _resetAgentAvailabilityForTests } from "@/lib/agents/availability"
import { registerSignInRunner } from "@/lib/agents/signIn"

const BUNDLED = "/Users/me/.npm/_npx/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
const DEFAULT_CLAUDE = { kind: "claude" as const, instanceId: null }
const WORK_CLAUDE = { kind: "claude" as const, instanceId: "work" }

function instancesAnswer(instances: object[]) {
  return { ok: true, json: async () => ({ instances }) }
}

beforeEach(() => {
  _resetAgentAvailabilityForTests()
  mocks.fetchProviderUpdates.mockResolvedValue([
    makeProviderUpdateInfo({ provider: "claude", binaryPath: BUNDLED, installMethod: "bundled", status: "unknown", updateCommand: null, signInCommand: `${BUNDLED} auth login` }),
    makeProviderUpdateInfo({ provider: "codex", displayName: "Codex", installed: false, installCommand: "npm install -g @openai/codex", binaryPath: null, status: "not-installed" }),
  ])
  mocks.authFetch.mockResolvedValue(instancesAnswer([]))
})

afterEach(() => vi.clearAllMocks())

describe("AgentSignInCard", () => {
  it("asks the terminal panel to sign in the session's account", () => {
    const runner = vi.fn()
    const unregister = registerSignInRunner(runner)
    render(<AgentSignInCard target={WORK_CLAUDE} detail="Invalid API key · Fix external API key" />)

    expect(screen.getByRole("alert")).toHaveTextContent("Claude Code isn't signed in.")
    expect(screen.getByText("It said: Invalid API key · Fix external API key")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(runner).toHaveBeenCalledExactlyOnceWith({ target: WORK_CLAUDE, name: "Sign in to Claude Code" })
    expect(screen.getByText("Finish signing in in the terminal below, then send your message again.")).toBeInTheDocument()
    unregister()
  })

  it("shows the server's command for the default account where there is no terminal", async () => {
    render(<AgentSignInCard target={DEFAULT_CLAUDE} />)
    await waitFor(() => expect(screen.getByTitle(`${BUNDLED} auth login`)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument()
    expect(screen.getByText("Run this on the computer running Cogpit:")).toBeInTheDocument()
  })

  it("shows an account instance's own command, which points at its home", async () => {
    const command = "env HOME='/data/provider-instances/work/user' CLAUDE_CONFIG_DIR='/data/provider-instances/work' claude auth login"
    mocks.authFetch.mockResolvedValue(instancesAnswer([{ id: "other", setupCommand: "nope" }, { id: "work", setupCommand: command }]))
    render(<AgentSignInCard target={WORK_CLAUDE} />)
    await waitFor(() => expect(screen.getByTitle(command)).toBeInTheDocument())
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/provider-instances")
  })

  it("sends someone who may not see an instance's command to whoever runs Cogpit", async () => {
    mocks.authFetch.mockResolvedValue(instancesAnswer([{ id: "work", agent: "claude", label: "Work" }]))
    render(<AgentSignInCard target={WORK_CLAUDE} />)
    expect(await screen.findByText("Ask the person who runs Cogpit to sign this account in.")).toBeInTheDocument()
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
    render(<AgentFailureNotice target={DEFAULT_CLAUDE} failure={{ reason: "http_status", httpStatus: 529, message: "API Error: Overloaded" }} />)
    expect(screen.getByRole("status")).toHaveTextContent("Claude Code stopped with an error.API Error: Overloaded")
  })

  it("asks to sign in when that is the problem", () => {
    render(<AgentFailureNotice target={{ kind: "codex", instanceId: null }} failure={{ reason: "not_signed_in", message: "401 Unauthorized" }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Codex isn't signed in.")
  })
})
