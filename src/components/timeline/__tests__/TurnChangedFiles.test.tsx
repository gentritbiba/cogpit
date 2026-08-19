import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { makeEditToolCall, makeTurn } from "@/__tests__/fixtures"
import { TurnChangedFiles } from "../TurnChangedFiles"

describe("TurnChangedFiles", () => {
  it("starts as a compact collapsed summary and reveals the tree on click", () => {
    const turn = makeTurn({
      toolCalls: [
        makeEditToolCall(
          "/project/src/App.tsx",
          "const oldValue = true",
          "const newValue = false\nconst secondValue = true",
        ),
      ],
    })

    const { container } = render(
      <TurnChangedFiles turn={turn} turnIndex={0} cwd="/project" />,
    )

    const trigger = screen.getByRole("button", { name: /1 file/i })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("src")).not.toBeInTheDocument()
    expect(container.querySelector('[data-slot="collapsible-content"]')).toBeNull()
    expect(screen.queryByText("changed")).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("src")).toBeVisible()
    expect(container.querySelector('[data-slot="collapsible-content"]')).toBeInTheDocument()
  })
})
