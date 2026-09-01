import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  submitPlanResponse: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: { sessionId: "copilot-session" },
    isLive: false,
    actions: { handleEditConfig: vi.fn() },
    pendingInteraction: {
      type: "plan",
      provider: "copilot",
      requestId: "plan-request",
      actions: [],
    },
    permissionRequests: [],
    permissionResponding: new Set(),
    respondPermission: vi.fn(),
    respondAllPermissions: vi.fn(),
    slashSuggestions: [],
    slashSuggestionsLoading: false,
    turnError: null,
    promptSuggestion: null,
  }),
  useSessionChatContext: () => ({
    chat: {
      status: "idle",
      error: null,
      isConnected: false,
      sendMessage: mocks.sendMessage,
      interrupt: vi.fn(),
    },
  }),
}))

vi.mock("@/lib/copilotPlanApi", () => ({
  submitCopilotPlanResponse: mocks.submitPlanResponse,
}))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => true }))
vi.mock("@/hooks/useElapsedTimer", () => ({ useElapsedTimer: () => 0 }))
vi.mock("@/hooks/useProjectFileSuggestions", () => ({
  useProjectFileSuggestions: () => ({ files: [], loading: false }),
}))
vi.mock("../useImageUpload", () => ({
  useImageUpload: () => ({
    images: [],
    isDragOver: false,
    imageError: null,
    hasUnsupportedAttachments: false,
    dismissImageError: vi.fn(),
    removeImage: vi.fn(),
    clearImages: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    handlePaste: vi.fn(),
  }),
}))
vi.mock("@/components/SlashSuggestions", () => ({ SlashSuggestions: () => null }))
vi.mock("@/components/FileSuggestions", () => ({ FileSuggestions: () => null }))

import { ChatInput } from "../index"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ChatInput Copilot plan responses", () => {
  it("keeps feedback and shows an error when submission fails", async () => {
    mocks.submitPlanResponse.mockResolvedValue(false)
    render(<ChatInput agentKind="copilot" />)

    const input = screen.getByRole("combobox", { name: "Message" })
    fireEvent.change(input, { target: { value: "Please simplify step two" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => {
      expect(screen.getByText("Couldn't send the plan response. Try again.")).toBeInTheDocument()
    })
    expect(input).toHaveValue("Please simplify step two")
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it("clears feedback only after a successful submission", async () => {
    mocks.submitPlanResponse.mockResolvedValue(true)
    render(<ChatInput agentKind="copilot" />)

    const input = screen.getByRole("combobox", { name: "Message" })
    fireEvent.change(input, { target: { value: "Use the smaller API" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(input).toHaveValue(""))
  })

  it("disables plan actions while a response is pending", async () => {
    let resolveResponse: (value: boolean) => void = () => undefined
    mocks.submitPlanResponse.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveResponse = resolve
    }))
    render(<ChatInput agentKind="copilot" />)

    fireEvent.click(screen.getByRole("button", { name: "Approve" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled()
      expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled()
    })
    fireEvent.click(screen.getByRole("button", { name: "Sending..." }))
    expect(mocks.submitPlanResponse).toHaveBeenCalledTimes(1)

    await act(async () => resolveResponse(true))
  })
})
