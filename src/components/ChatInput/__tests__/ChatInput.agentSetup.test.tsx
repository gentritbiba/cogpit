import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { makeProviderUpdateInfo } from "@/__tests__/fixtures"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  turnError: null as string | null,
  startAgentSignIn: vi.fn(),
  fetchProviderUpdates: vi.fn(),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContextOptional: () => null,
  useSessionChatContextOptional: () => null,
  useSessionContext: () => ({
    session: { sessionId: "s1" },
    isLive: false,
    actions: { handleEditConfig: vi.fn() },
    pendingInteraction: null,
    permissionRequests: [],
    permissionResponding: new Set(),
    respondPermission: vi.fn(),
    respondAllPermissions: vi.fn(),
    slashSuggestions: [],
    slashSuggestionsLoading: false,
    turnError: mocks.turnError,
    promptSuggestion: null,
  }),
  useSessionChatContext: () => ({
    chat: { status: "idle", error: null, isConnected: false, sendMessage: mocks.sendMessage, interrupt: vi.fn() },
  }),
}))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => true }))
vi.mock("@/hooks/useElapsedTimer", () => ({ useElapsedTimer: () => 0 }))
vi.mock("@/hooks/useProjectFileSuggestions", () => ({ useProjectFileSuggestions: () => ({ files: [], loading: false }) }))
vi.mock("@/components/SlashSuggestions", () => ({ SlashSuggestions: () => null }))
vi.mock("@/components/FileSuggestions", () => ({ FileSuggestions: () => null }))
vi.mock("@/lib/agents/signIn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/signIn")>()),
  startAgentSignIn: mocks.startAgentSignIn,
}))
vi.mock("@/lib/providerUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providerUpdates")>()),
  fetchProviderUpdates: mocks.fetchProviderUpdates,
}))

import { ChatInput } from "../index"
import { resetUnsentRecoveriesForTest } from "../unsentRecovery"
import { _resetAgentAvailabilityForTests } from "@/lib/agents/availability"

const message = () => screen.getByRole("combobox", { name: "Message" })
const send = (text: string) => {
  fireEvent.change(message(), { target: { value: text } })
  fireEvent.keyDown(message(), { key: "Enter" })
}

beforeEach(() => {
  localStorage.clear()
  resetUnsentRecoveriesForTest()
  _resetAgentAvailabilityForTests()
  vi.clearAllMocks()
  mocks.turnError = null
  mocks.fetchProviderUpdates.mockResolvedValue([makeProviderUpdateInfo()])
})

describe("ChatInput agent setup", () => {
  it("runs the agent's own sign-in for /login instead of sending it", () => {
    mocks.startAgentSignIn.mockReturnValue(true)
    render(<ChatInput agentKind="codex" />)
    send("/login")
    expect(mocks.startAgentSignIn).toHaveBeenCalledExactlyOnceWith("codex")
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(message()).toHaveValue("")
  })

  it("shows the command to copy when there is no terminal for /login", () => {
    mocks.startAgentSignIn.mockReturnValue(false)
    render(<ChatInput agentKind="claude" />)
    send("/login")
    expect(screen.getByRole("alert")).toHaveTextContent("Claude Code isn't signed in.")
    expect(screen.getByTitle("claude auth login")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("still sends a message that only starts with /login", () => {
    mocks.sendMessage.mockResolvedValue(true)
    render(<ChatInput agentKind="claude" />)
    send("/login please")
    expect(mocks.startAgentSignIn).not.toHaveBeenCalled()
    expect(mocks.sendMessage).toHaveBeenCalled()
  })

  it("says a missing login in plain words, whatever the CLI wrote", () => {
    mocks.turnError = "Invalid API key · Fix external API key"
    render(<ChatInput agentKind="claude" />)
    expect(screen.getByRole("button", { name: "Claude Code isn't signed in.(details)" })).toBeInTheDocument()
  })

  it("explains a missing agent before anything is sent", async () => {
    mocks.fetchProviderUpdates.mockResolvedValue([makeProviderUpdateInfo(), makeProviderUpdateInfo({ provider: "codex", installed: false, binaryPath: null, status: "not-installed" })])
    render(<ChatInput agentKind="codex" />)
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Codex isn't installed on this computer."))
  })
})
