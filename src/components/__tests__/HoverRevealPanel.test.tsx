import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HoverRevealPanel } from "@/components/HoverRevealPanel"

describe("HoverRevealPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("reveals from keyboard focus and returns focus after Escape", () => {
    render(
      <HoverRevealPanel side="left" visible={false}>
        <button type="button">Sidebar action</button>
      </HoverRevealPanel>,
    )

    const trigger = screen.getByRole("button", { name: "Reveal left sidebar" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    fireEvent.focus(trigger)

    const action = screen.getByRole("button", { name: "Sidebar action" })
    const panel = action.parentElement
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(trigger).toHaveAttribute("aria-controls", panel?.id)

    fireEvent.keyDown(action, { key: "Escape" })
    act(() => {
      vi.runAllTimers()
    })

    expect(screen.queryByRole("button", { name: "Sidebar action" })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("keeps the existing hover delays", () => {
    render(
      <HoverRevealPanel side="right" visible={false}>
        <button type="button">Sidebar action</button>
      </HoverRevealPanel>,
    )

    const trigger = screen.getByRole("button", { name: "Reveal right sidebar" })
    fireEvent.mouseEnter(trigger)
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(screen.queryByRole("button", { name: "Sidebar action" })).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    const action = screen.getByRole("button", { name: "Sidebar action" })
    fireEvent.mouseLeave(action.parentElement!)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.queryByRole("button", { name: "Sidebar action" })).not.toBeInTheDocument()
  })
})
