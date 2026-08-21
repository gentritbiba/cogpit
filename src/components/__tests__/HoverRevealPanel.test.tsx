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

    expect(screen.getByText("Sidebar action")).toBeInTheDocument()
    expect(panel).toHaveAttribute("aria-hidden", "true")
    expect(panel).toHaveAttribute("inert")

    act(() => {
      vi.runAllTimers()
    })

    expect(screen.queryByText("Sidebar action")).not.toBeInTheDocument()
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
    const panel = action.parentElement!
    fireEvent.mouseLeave(panel)
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(screen.getByText("Sidebar action")).toBeInTheDocument()
    expect(panel).toHaveClass("animate-out", "fade-out-0", "slide-out-to-right-3")

    act(() => {
      vi.advanceTimersByTime(149)
    })
    expect(screen.getByText("Sidebar action")).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText("Sidebar action")).not.toBeInTheDocument()
  })

  it("cancels a pending exit when the trigger reopens the panel", () => {
    render(
      <HoverRevealPanel side="left" visible={false}>
        <button type="button">Sidebar action</button>
      </HoverRevealPanel>,
    )

    const trigger = screen.getByRole("button", { name: "Reveal left sidebar" })
    fireEvent.focus(trigger)

    const panel = screen.getByRole("button", { name: "Sidebar action" }).parentElement!
    fireEvent.keyDown(panel, { key: "Escape" })
    expect(panel).toHaveAttribute("aria-hidden", "true")
    fireEvent.click(trigger)

    act(() => {
      vi.advanceTimersByTime(150)
    })

    expect(screen.getByRole("button", { name: "Sidebar action" })).toBeInTheDocument()
    expect(panel).toHaveAttribute("aria-hidden", "false")
  })

  it("skips the exit animation when reduced motion is requested", () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia")
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    })

    try {
      render(
        <HoverRevealPanel side="left" visible={false}>
          <button type="button">Sidebar action</button>
        </HoverRevealPanel>,
      )

      const trigger = screen.getByRole("button", { name: "Reveal left sidebar" })
      fireEvent.focus(trigger)
      fireEvent.keyDown(screen.getByRole("button", { name: "Sidebar action" }), { key: "Escape" })

      expect(screen.queryByText("Sidebar action")).not.toBeInTheDocument()
    } finally {
      if (originalMatchMedia) {
        Object.defineProperty(window, "matchMedia", originalMatchMedia)
      } else {
        Reflect.deleteProperty(window, "matchMedia")
      }
    }
  })
})
