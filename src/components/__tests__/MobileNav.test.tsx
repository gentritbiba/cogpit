import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MobileNav } from "../MobileNav"
import { showSession } from "@/__tests__/sessionContextMock"

const mocks = vi.hoisted(() => ({
  isLive: false,
  hapticLight: vi.fn(),
}))

vi.mock("@/contexts/SessionContext", async () => (await import("@/__tests__/sessionContextMock")).withSessionHooks({
  useSessionContext: () => ({ isLive: mocks.isLive }),
}))

vi.mock("@/lib/haptics", () => ({
  hapticLight: mocks.hapticLight,
}))

beforeEach(() => {
  showSession({})
  mocks.isLive = false
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("MobileNav", () => {
  it("renders icon-only navigation as accessible buttons and changes views", () => {
    const onTabChange = vi.fn()

    render(
      <MobileNav
        activeTab="chat"
        onTabChange={onTabChange}
      />,
    )

    const sessionsTab = screen.getByRole("button", { name: "Sessions" })
    const chatTab = screen.getByRole("button", { name: "Chat" })
    const statsTab = screen.getByRole("button", { name: "Workspace" })

    expect(sessionsTab).not.toHaveAttribute("aria-current")
    expect(chatTab).toHaveAttribute("aria-current", "page")
    expect(statsTab).not.toHaveAttribute("aria-current")
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument()
    expect(screen.queryByText("Chat")).not.toBeInTheDocument()
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument()

    fireEvent.click(statsTab)

    expect(mocks.hapticLight).toHaveBeenCalledOnce()
    expect(onTabChange).toHaveBeenCalledWith("workspace")
  })

  it("marks a live chat only from the other tabs, since the chat header shows it", () => {
    mocks.isLive = true
    const { rerender } = render(<MobileNav activeTab="sessions" onTabChange={vi.fn()} />)
    expect(screen.getByLabelText("Session is live")).toBeInTheDocument()

    rerender(<MobileNav activeTab="chat" onTabChange={vi.fn()} />)
    expect(screen.queryByLabelText("Session is live")).not.toBeInTheDocument()
  })

  it("keeps workspace tools reachable without a session", () => {
    showSession(null)

    render(
      <MobileNav
        activeTab="sessions"
        onTabChange={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: "Sessions" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument()
  })
})
