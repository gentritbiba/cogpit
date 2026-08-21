import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { SessionBrowser } from "../SessionBrowser"

vi.mock("@/components/LiveSessions", () => ({
  LiveSessions: ({
    onSelectSession,
  }: {
    onSelectSession: (dirName: string, fileName: string) => void
  }) => (
    <button type="button" onClick={() => onSelectSession("project", "session.jsonl")}>
      Live sessions
    </button>
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

  it("renders the header slot above the sessions list", () => {
    const { container } = render(
      <SessionBrowser
        activeSessionKey={null}
        onSelectSession={vi.fn()}
        header={<div data-testid="sidebar-header" />}
      />,
    )

    const aside = container.firstElementChild
    expect(aside?.firstElementChild).toBe(screen.getByTestId("sidebar-header"))
  })
})
