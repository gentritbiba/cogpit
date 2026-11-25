import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { makeProviderUpdateInfo } from "@/__tests__/fixtures"

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  turnError: null as string | null,
  signInEndsAt: null as string | null,
  pendingInteraction: null as unknown,
  submitUserQuestionAnswers: vi.fn(),
  startAgentSignIn: vi.fn(),
  fetchProviderUpdates: vi.fn(),
}))

vi.mock("@/contexts/SessionContext", async () => (await import("@/__tests__/sessionContextMock")).withSessionHooks({
  useSessionContextOptional: () => null,
  useSessionChatContextOptional: () => null,
  useSessionContext: () => ({
    isLive: false,
    actions: { handleEditConfig: vi.fn() },
    pendingInteraction: mocks.pendingInteraction,
    permissionRequests: [],
    permissionResponding: new Set(),
    respondPermission: vi.fn(),
    respondAllPermissions: vi.fn(),
    slashSuggestions: [],
    slashSuggestionsLoading: false,
    turnError: mocks.turnError,
    promptSuggestion: null,
    signInEndsAt: mocks.signInEndsAt,
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
vi.mock("@/lib/askUserApi", () => ({ submitUserQuestionAnswers: mocks.submitUserQuestionAnswers }))
vi.mock("@/lib/providerUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providerUpdates")>()),
  fetchProviderUpdates: mocks.fetchProviderUpdates,
}))

import { ChatInput } from "../index"
import { resetUnsentRecoveriesForTest } from "../unsentRecovery"
import { _resetAgentAvailabilityForTests } from "@/lib/agents/availability"
import { showSession } from "@/__tests__/sessionContextMock"
import { setCodeModeEnabled, registerCodeModeRunner, rememberCodeModeSession } from "@/lib/agents/codeMode"
import { agentCodeModeOnlyMessage } from "../../../../shared/session/agentFailures"

const message = () => screen.getByRole("combobox", { name: "Message" })
const send = (text: string) => {
  fireEvent.change(message(), { target: { value: text } })
  fireEvent.keyDown(message(), { key: "Enter" })
}

beforeEach(() => {
  showSession({ sessionId: "s1" })
  localStorage.clear()
  resetUnsentRecoveriesForTest()
  _resetAgentAvailabilityForTests()
  vi.clearAllMocks()
  mocks.turnError = null
  mocks.signInEndsAt = null
  mocks.pendingInteraction = null
  mocks.fetchProviderUpdates.mockResolvedValue([makeProviderUpdateInfo()])
})

describe("ChatInput agent setup", () => {
  it("runs the agent's own sign-in for /login instead of sending it", () => {
    mocks.startAgentSignIn.mockReturnValue(true)
    render(<ChatInput agentKind="codex" />)
    send("/login")
    expect(mocks.startAgentSignIn).toHaveBeenCalledExactlyOnceWith({ kind: "codex", instanceId: null })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(message()).toHaveValue("")
  })

  it("signs in the account instance a new session will run under", () => {
    mocks.startAgentSignIn.mockReturnValue(true)
    render(<ChatInput agentKind="claude" composerIdentity="instance__work__-workspace" />)
    send("/login")
    expect(mocks.startAgentSignIn).toHaveBeenCalledExactlyOnceWith({ kind: "claude", instanceId: "work" })
  })

  it("shows the command to copy when there is no terminal for /login", async () => {
    mocks.startAgentSignIn.mockReturnValue(false)
    render(<ChatInput agentKind="claude" />)
    send("/login")
    expect(screen.getByRole("alert")).toHaveTextContent("Claude Code isn't signed in.")
    expect(await screen.findByTitle("/usr/local/bin/claude auth login")).toBeInTheDocument()
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

  it("warns quietly before the sign-in ends, offers to sign in again, and can be dismissed", () => {
    mocks.signInEndsAt = "2026-12-11T00:25:04.187Z"
    mocks.startAgentSignIn.mockReturnValue(true)
    render(<ChatInput agentKind="claude" />)
    const notice = screen.getByText(/Claude Code's sign-in ends around/)
    expect(notice).toHaveTextContent("Sign in again to keep sessions running.")
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText(/sign-in ends around/)).not.toBeInTheDocument()
  })

  it("answers a waiting question with a message typed in the composer as a chat reply", async () => {
    mocks.pendingInteraction = { type: "question", toolUseId: "toolu_1", questions: [{ question: "Pick a color?", options: [] }] }
    mocks.submitUserQuestionAnswers.mockResolvedValue({ ok: true, gone: false })
    render(<ChatInput agentKind="claude" />)
    send("make it teal")
    await waitFor(() => expect(mocks.submitUserQuestionAnswers).toHaveBeenCalledWith("s1", "toolu_1", "make it teal", "replied_in_chat"))
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it("answers the first question with the typed text for an agent that cannot take a chat reply", async () => {
    mocks.pendingInteraction = { type: "question", toolUseId: "q-1", questions: [{ question: "Pick a color?", options: [] }] }
    mocks.submitUserQuestionAnswers.mockResolvedValue({ ok: true, gone: false })
    render(<ChatInput agentKind="codex" />)
    send("Blue")
    await waitFor(() => expect(mocks.submitUserQuestionAnswers).toHaveBeenCalledWith("s1", "q-1", { "Pick a color?": "Blue" }))
  })

  it("explains a missing agent before anything is sent", async () => {
    mocks.fetchProviderUpdates.mockResolvedValue([makeProviderUpdateInfo(), makeProviderUpdateInfo({ provider: "codex", installed: false, binaryPath: null, status: "not-installed" })])
    render(<ChatInput agentKind="codex" />)
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Codex isn't installed on this computer."))
  })

  describe("a session in Code Mode", () => {
    const runner = { ready: true, start: vi.fn(), show: vi.fn(), status: vi.fn(() => null) }
    // The server has said it knows Code Mode; the setting itself can be off.
    beforeEach(() => setCodeModeEnabled("local", false))

    it("hands the composer to the terminal for a session started in Code Mode", () => {
      const unregister = registerCodeModeRunner("local", runner)
      showSession({ sessionId: "code-mode-1", cwd: "/project" })
      rememberCodeModeSession("code-mode-1")
      render(<ChatInput agentKind="claude" />)

      expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull()
      fireEvent.click(screen.getByRole("button", { name: "Continue in terminal" }))
      expect(runner.start).toHaveBeenCalledWith({ kind: "claude", sessionId: "code-mode-1", resume: true, cwd: "/project" })
      unregister()
    })

    it("offers the terminal panel when the agent refuses to continue a Code Mode session here", () => {
      const unregister = registerCodeModeRunner("local", runner)
      showSession({ sessionId: "elsewhere-1", cwd: "/project" })
      mocks.turnError = agentCodeModeOnlyMessage("claude", "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume elsewhere-1", "Failed to resume session")
      render(<ChatInput agentKind="claude" />)

      // The composer stays, so whatever was typed is not lost.
      expect(message()).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Continue in terminal" }))
      expect(runner.start).toHaveBeenCalledWith({ kind: "claude", sessionId: "elsewhere-1", resume: true, cwd: "/project" })
      unregister()
    })
  })
})
