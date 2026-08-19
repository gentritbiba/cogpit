import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileSuggestions } from "../FileSuggestions"

describe("FileSuggestions", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("exposes a linked listbox and selects a pointer choice once", () => {
    const onSelect = vi.fn()
    render(
      <FileSuggestions
        files={["src/App.tsx"]}
        query="App"
        loading={false}
        selectedIndex={0}
        onSelect={onSelect}
        onHover={() => undefined}
      />,
    )

    const listbox = screen.getByRole("listbox")
    const option = screen.getByRole("option", { name: /src\/App\.tsx/i })
    expect(document.getElementById("file-suggestions")).toContainElement(listbox)
    expect(option).toHaveAttribute("id", "file-suggestion-0")

    fireEvent.mouseDown(option)
    fireEvent.click(option)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
