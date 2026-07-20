import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MobileNav } from "../MobileNav"

const mocks = vi.hoisted(() => ({
  session: null as object | null,
  isLive: false,
  hapticLight: vi.fn(),
}))

vi.mock("@/contexts/SessionContext", () => ({
  useSessionContext: () => ({ session: mocks.session, isLive: mocks.isLive }),
}))

vi.mock("@/lib/haptics", () => ({
  hapticLight: mocks.hapticLight,
}))

beforeEach(() => {
  mocks.session = {}
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
        hasTeam={false}
      />,
    )

    const sessionsTab = screen.getByRole("button", { name: "Sessions" })
    const chatTab = screen.getByRole("button", { name: "Chat" })
    const statsTab = screen.getByRole("button", { name: "Stats" })

    expect(sessionsTab).not.toHaveAttribute("aria-current")
    expect(chatTab).toHaveAttribute("aria-current", "page")
    expect(statsTab).not.toHaveAttribute("aria-current")
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument()
    expect(screen.queryByText("Chat")).not.toBeInTheDocument()
    expect(screen.queryByText("Stats")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Teams" })).not.toBeInTheDocument()

    fireEvent.click(statsTab)

    expect(mocks.hapticLight).toHaveBeenCalledOnce()
    expect(onTabChange).toHaveBeenCalledWith("stats")
  })

  it("only exposes tabs that are available for the current view", () => {
    mocks.session = null

    render(
      <MobileNav
        activeTab="sessions"
        onTabChange={vi.fn()}
        hasTeam
      />,
    )

    expect(screen.getByRole("button", { name: "Sessions" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Teams" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Stats" })).not.toBeInTheDocument()
  })
})
