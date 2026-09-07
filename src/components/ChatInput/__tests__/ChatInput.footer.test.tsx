import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({
    session: null,
    isLive: false,
    actions: { handleEditConfig: vi.fn() },
    pendingInteraction: null,
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
    chat: { status: "idle", error: null, isConnected: true, sendMessage: vi.fn(), interrupt: vi.fn() },
  }),
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

describe("ChatInput footer", () => {
  it("stacks the message above a control row that ends with Send", () => {
    render(<ChatInput footer={<span>session controls</span>} />)

    const controls = screen.getByText("session controls")
    const send = screen.getByRole("button", { name: "Send message" })
    const message = screen.getByRole("combobox", { name: "Message" })

    // The control row holds the footer and, via the action group, Send.
    const row = controls.parentElement
    expect(row).toContainElement(send)
    expect(row).not.toContainElement(message)
    expect(message.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row?.parentElement).toHaveClass("flex-col")
  })

  it("keeps the inline single-row layout without a footer", () => {
    render(<ChatInput />)

    const message = screen.getByRole("combobox", { name: "Message" })

    expect(message.parentElement).toHaveClass("grid")
    expect(message.parentElement).not.toHaveClass("flex-col")
  })
})
