import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog"
import { getKeybinding, resetAllKeybindings } from "@/lib/keybindings"

describe("KeyboardShortcutsDialog", () => {
  beforeEach(() => {
    resetAllKeybindings()
  })

  it("records and persists a custom shortcut", async () => {
    const user = userEvent.setup()
    render(<KeyboardShortcutsDialog open onOpenChange={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Change shortcut for Open command palette" }))
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true })

    expect(getKeybinding("commandPalette")).toEqual({
      key: "p",
      metaKey: undefined,
      ctrlKey: true,
      shiftKey: true,
      altKey: undefined,
    })
    expect(screen.getByRole("button", { name: "Change shortcut for Open command palette" }))
      .toHaveTextContent("Ctrl+Shift+P")
  })

  it("blocks a shortcut already used by another command", async () => {
    const user = userEvent.setup()
    render(<KeyboardShortcutsDialog open onOpenChange={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Change shortcut for Open command palette" }))
    fireEvent.keyDown(window, { key: "j", ctrlKey: true })

    expect(screen.getByRole("alert")).toHaveTextContent("Toggle integrated terminal")
    expect(getKeybinding("commandPalette")).toMatchObject({ key: "k", modKey: true })
  })
})
