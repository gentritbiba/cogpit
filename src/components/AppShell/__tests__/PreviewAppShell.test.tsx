import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PreviewAppShell } from "../PreviewAppShell"

const mockUseSessionContext = vi.fn()

vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({
    theme: { themeClasses: "dark" },
    isMobile: false,
  }),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => mockUseSessionContext(),
}))

vi.mock("@/components/ChatArea", () => ({
  ChatArea: () => <div>Conversation timeline</div>,
}))

const commonProps = {
  sessionId: "session-123",
  loadError: null,
  searchInputRef: { current: null },
  activeComposer: <div>Composer settings</div>,
  hasMoreTurns: false,
  isLoadingOlderTurns: false,
  onLoadMoreTurns: vi.fn(),
}

describe("PreviewAppShell", () => {
  beforeEach(() => {
    mockUseSessionContext.mockReturnValue({ session: null })
  })

  it("shows the local session lookup state", () => {
    render(<PreviewAppShell {...commonProps} />)

    expect(screen.getByText("Opening session")).toBeInTheDocument()
    expect(screen.getByText(/session-123/)).toBeInTheDocument()
  })

  it("shows a focused lookup error", () => {
    render(<PreviewAppShell {...commonProps} loadError="Session was not found." />)

    expect(screen.getByText("Unable to open session")).toBeInTheDocument()
    expect(screen.getByText("Session was not found.")).toBeInTheDocument()
  })

  it("renders only the conversation and composer after loading", () => {
    mockUseSessionContext.mockReturnValue({ session: { sessionId: "session-123" } })

    render(<PreviewAppShell {...commonProps} />)

    expect(screen.getByText("Conversation timeline")).toBeInTheDocument()
    expect(screen.getByText("Composer settings")).toBeInTheDocument()
    expect(screen.queryByText("Opening session")).not.toBeInTheDocument()
  })
})
