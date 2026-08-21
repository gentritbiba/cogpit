import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { SidebarHeader } from "@/components/SidebarHeader"

describe("SidebarHeader", () => {
  it("exposes home, search, and collapse with their shortcuts", () => {
    const onToggleSidebar = vi.fn()
    const onGoHome = vi.fn()
    const onOpenCommandPalette = vi.fn()
    const { container } = render(
      <SidebarHeader
        onToggleSidebar={onToggleSidebar}
        onGoHome={onGoHome}
        onOpenCommandPalette={onOpenCommandPalette}
        sidebarShortcut="⌘B"
        commandPaletteShortcut="⌘K"
      />,
    )

    expect(container.firstElementChild).toHaveClass("electron-drag", "window-inset-start")

    fireEvent.click(screen.getByRole("button", { name: "Home" }))
    fireEvent.click(screen.getByRole("button", { name: "Search (⌘K)" }))
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar (⌘B)" }))

    expect(onGoHome).toHaveBeenCalledOnce()
    expect(onOpenCommandPalette).toHaveBeenCalledOnce()
    expect(onToggleSidebar).toHaveBeenCalledOnce()
  })
})
