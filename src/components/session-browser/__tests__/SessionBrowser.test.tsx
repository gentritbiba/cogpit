import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { SessionBrowser } from "../SessionBrowser"

vi.mock("@/components/LiveSessions", () => ({
  LiveSessions: ({
    onSelectSession,
    headerActions,
  }: {
    onSelectSession: (dirName: string, fileName: string) => void
    headerActions?: React.ReactNode
  }) => (
    <div data-testid="live-sessions">
      <button type="button" onClick={() => onSelectSession("project", "session.jsonl")}>
        Live sessions
      </button>
      {headerActions}
    </div>
  ),
}))

afterEach(cleanup)

describe("SessionBrowser", () => {
  it("renders a compact live-session sidebar without panel navigation", () => {
    const onSelectSession = vi.fn()
    const { container } = render(
      <SessionBrowser
        activeSessionKey={null}
        onSelectSession={onSelectSession}
      />,
    )

    expect(container.firstElementChild).toHaveClass("w-80")
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(screen.queryByText("Browse")).not.toBeInTheDocument()
    expect(screen.queryByText("Teams")).not.toBeInTheDocument()
    expect(screen.queryByText("Scripts")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Live sessions" }))
    expect(onSelectSession).toHaveBeenCalledWith("project", "session.jsonl")
  })

  it("uses the full width on mobile", () => {
    const { container } = render(
      <SessionBrowser
        activeSessionKey={null}
        onSelectSession={vi.fn()}
        isMobile
      />,
    )

    expect(container.firstElementChild).toHaveClass("w-full")
    expect(container.firstElementChild).not.toHaveClass("w-80")
  })

  it("hands header actions to the session list's header row instead of stacking a row above it", () => {
    const { container } = render(
      <SessionBrowser
        activeSessionKey={null}
        onSelectSession={vi.fn()}
        headerActions={<button type="button">Hide sidebar</button>}
      />,
    )

    const aside = container.firstElementChild
    const list = screen.getByTestId("live-sessions")
    expect(aside?.children).toHaveLength(1)
    expect(aside?.firstElementChild).toBe(list)
    expect(list).toContainElement(screen.getByRole("button", { name: "Hide sidebar" }))
  })
})
