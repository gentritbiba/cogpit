import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { handleSearchKeyDown } from "../searchKeyboard"

describe("session search keyboard", () => {
  it("moves from the search input through list rows and content hits and activates with Enter", () => {
    const select = vi.fn()
    render(<div onKeyDown={handleSearchKeyDown}>
      <input type="search" aria-label="Search" />
      <button data-session-search-item>Metadata match</button>
      <button data-session-search-item onClick={select}>Content match</button>
      <button>Other action</button>
    </div>)
    const input = screen.getByRole("searchbox")
    input.focus()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(screen.getByText("Metadata match")).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    expect(screen.getByText("Content match")).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: "Enter" })
    expect(select).toHaveBeenCalledOnce()
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" })
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" })
    expect(input).toHaveFocus()
  })

  it("selects the first result with Enter and the last with ArrowUp from the input", () => {
    const select = vi.fn()
    render(<div onKeyDown={handleSearchKeyDown}><input type="search" /><button data-session-search-item onClick={select}>First</button><button data-session-search-item>Last</button></div>)
    const input = screen.getByRole("searchbox")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(select).toHaveBeenCalledOnce()
    fireEvent.keyDown(input, { key: "ArrowUp" })
    expect(screen.getByText("Last")).toHaveFocus()
  })
})
