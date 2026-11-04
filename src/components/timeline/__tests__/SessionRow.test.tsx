import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { clockLabel, SessionRow } from "../SessionRow"

describe("SessionRow", () => {
  it("unfolds its detail in place and opens the session from its own button", () => {
    const onOpen = vi.fn()
    const { container } = render(
      <SessionRow
        kind="claude"
        state="finished"
        title="pricing-copy"
        preview="Pricing copy fixed."
        onOpen={onOpen}
        detail={<p>The full reply</p>}
      />,
    )

    const row = screen.getByRole("button", { name: "pricing-copy, Finished: Pricing copy fixed." })
    expect(row).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("The full reply")).toBeNull()
    expect(container.querySelector("[data-session-row]")).toHaveAttribute("data-session-row", "finished")

    fireEvent.click(row)

    expect(row).toHaveAttribute("aria-expanded", "true")
    expect(document.getElementById(row.getAttribute("aria-controls")!)).toHaveTextContent("The full reply")
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Open pricing-copy" }))
    expect(onOpen).toHaveBeenCalledTimes(1)

    fireEvent.click(row)
    expect(row).toHaveAttribute("aria-expanded", "false")
  })

  it("opens the session when clicked if it has nothing to unfold", () => {
    const onOpen = vi.fn()
    render(<SessionRow kind="codex" state="finished" title="audit" preview="All routes checked" onOpen={onOpen} />)

    const row = screen.getByRole("button", { name: "Open audit, Finished" })
    expect(row).not.toHaveAttribute("aria-expanded")
    expect(screen.getAllByRole("button")).toHaveLength(1)

    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("is not a control when it can neither unfold nor open", () => {
    render(<SessionRow kind={null} state="started" title="New session" />)

    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("New session")).toBeInTheDocument()
    expect(screen.getByText("Started")).toBeInTheDocument()
  })

  it("starts unfolded when asked, such as for an agent still working", () => {
    render(<SessionRow kind="claude" state="working" title="Explore" detail={<p>Live transcript</p>} defaultOpen />)

    expect(screen.getByRole("button", { name: "Explore, Working" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Live transcript")).toBeInTheDocument()
  })

  it("lets a live status replace the state's own word", () => {
    render(<SessionRow kind="claude" state="working" statusLabel="Using Bash" title="lane-a" />)

    expect(screen.getByText("Using Bash")).toBeInTheDocument()
    expect(screen.queryByText("Working")).toBeNull()
  })

  it("marks sessions that are working, waiting or failed with a dot, and leaves settled ones plain", () => {
    const { container, rerender } = render(<SessionRow kind="claude" state="needs-you" title="lane-a" />)
    expect(container.querySelector("[data-session-dot]")).toHaveAttribute("data-session-dot", "needs-you")
    expect(screen.getByText("Needs you")).toHaveClass("text-warning")

    rerender(<SessionRow kind="claude" state="failed" title="lane-a" />)
    expect(container.querySelector("[data-session-dot]")).toHaveAttribute("data-session-dot", "failed")

    rerender(<SessionRow kind="claude" state="finished" title="lane-a" />)
    expect(container.querySelector("[data-session-dot]")).toBeNull()
  })
})

describe("clockLabel", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows only the time for today and adds the date for an earlier day", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 4, 15, 0))
    const today = new Date(2026, 10, 4, 1, 54)
    const earlier = new Date(2026, 9, 6, 22, 43)
    const time = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

    expect(clockLabel(today.toISOString())).toBe(time(today))
    expect(clockLabel(earlier.getTime())).toBe(`${earlier.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time(earlier)}`)
  })

  it("is empty for a time it cannot read", () => {
    expect(clockLabel("not a date")).toBe("")
  })
})
