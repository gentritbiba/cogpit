import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SlashSuggestions } from "../SlashSuggestions"

describe("SlashSuggestions", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("selects a pointer choice once", () => {
    const onSelect = vi.fn()
    render(
      <SlashSuggestions
        suggestions={[{
          name: "review",
          description: "Review the current changes",
          type: "command",
          source: "project",
          filePath: "/tmp/review.md",
        }]}
        filter=""
        loading={false}
        selectedIndex={0}
        onSelect={onSelect}
        onHover={() => undefined}
      />,
    )

    const option = screen.getByRole("option", { name: /review/i })
    fireEvent.mouseDown(option)
    fireEvent.click(option)

    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("edits a custom suggestion without selecting it", () => {
    const onEdit = vi.fn()
    const onSelect = vi.fn()
    render(
      <SlashSuggestions
        suggestions={[{
          name: "review",
          description: "Review the current changes",
          type: "command",
          source: "project",
          filePath: "/tmp/review.md",
        }]}
        filter=""
        loading={false}
        selectedIndex={0}
        onSelect={onSelect}
        onHover={() => undefined}
        onEdit={onEdit}
      />,
    )

    const edit = screen.getByRole("button", { name: "Edit review" })
    fireEvent.mouseDown(edit)
    fireEvent.click(edit)

    expect(onEdit).toHaveBeenCalledOnce()
    expect(onEdit).toHaveBeenCalledWith("/tmp/review.md")
    expect(onSelect).not.toHaveBeenCalled()
  })
})
