import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TurnContextMenu } from "../TurnContextMenu"

describe("TurnContextMenu", () => {
  it("leaves the wrapped turn selectable so chat text can be copied", () => {
    render(
      <TurnContextMenu
        turnIndex={0}
        branches={[]}
        onRestoreToHere={vi.fn()}
        onOpenBranches={vi.fn()}
      >
        <p>Assistant said something worth copying.</p>
      </TurnContextMenu>
    )

    const trigger = screen
      .getByText("Assistant said something worth copying.")
      .closest("[data-slot='context-menu-trigger']")

    expect(trigger).not.toHaveClass("select-none")
  })
})
