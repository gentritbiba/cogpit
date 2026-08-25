import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PromptSuggestionBar } from "../PromptSuggestionBar"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("PromptSuggestionBar", () => {
  it("renders nothing without a suggestion, which is the normal case", () => {
    // Suppressed on the first turn, in plan mode, after an error and by two
    // separate settings — the composer must not reserve space for it.
    const { container } = render(
      <PromptSuggestionBar suggestion={null} onAccept={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("fills the composer instead of sending when the suggestion is clicked", () => {
    const onAccept = vi.fn()
    render(<PromptSuggestionBar suggestion="Run the tests" onAccept={onAccept} />)

    fireEvent.click(screen.getByRole("button", { name: /Run the tests/ }))
    expect(onAccept).toHaveBeenCalledWith("Run the tests")
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it("stays dismissed for that suggestion once dismissed", () => {
    render(<PromptSuggestionBar suggestion="Run the tests" onAccept={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }))
    expect(screen.queryByText("Run the tests")).toBeNull()
  })

  it("shows the next turn's suggestion after the previous one was dismissed", () => {
    const { rerender } = render(
      <PromptSuggestionBar suggestion="Run the tests" onAccept={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }))

    rerender(<PromptSuggestionBar suggestion="Commit the change" onAccept={vi.fn()} />)
    expect(screen.getByRole("button", { name: /Commit the change/ })).toBeInTheDocument()
  })

  it("hides itself again after accepting, so the filled prompt is not offered twice", () => {
    render(<PromptSuggestionBar suggestion="Run the tests" onAccept={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: /Run the tests/ }))
    expect(screen.queryByText("Run the tests")).toBeNull()
  })
})
