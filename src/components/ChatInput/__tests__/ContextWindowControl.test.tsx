import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ContextWindowControl } from "../settings/ContextWindowControl"

describe("context window limit", () => {
  it("cycles through all three limits and wraps around on click", () => {
    const onChange = vi.fn()
    function Control() {
      const [value, setValue] = useState(270000)
      return <ContextWindowControl value={value} onChange={(next) => { onChange(next); setValue(next!) }} />
    }
    render(<Control />)
    for (const [label, next] of [["270k", 500000], ["500k", 1000000], ["1M", 270000]] as const) {
      const button = screen.getByRole("button", { name: `Context window: ${label}` })
      expect(button).toHaveTextContent(label)
      fireEvent.click(button)
      expect(onChange).toHaveBeenLastCalledWith(next)
    }
    expect(screen.getByRole("button", { name: "Context window: 270k" })).toBeInTheDocument()
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.queryByRole("slider")).not.toBeInTheDocument()
  })

  it.each([null, 200000, 272001])("preserves %s until clicked, then selects 270k", (value) => {
    const onChange = vi.fn()
    render(<ContextWindowControl value={value} onChange={onChange} />)
    const label = value === null ? "Default" : value.toLocaleString("en-US")
    const button = screen.getByRole("button", { name: `Context window: ${label}` })
    expect(onChange).not.toHaveBeenCalled()
    expect(button).toHaveAttribute("title", expect.stringContaining("270k next turn"))
    fireEvent.click(button)
    expect(onChange).toHaveBeenCalledWith(270000)
  })

  it("supports keyboard activation and explains the next value and pricing", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ContextWindowControl value={270000} onChange={onChange} />)
    const button = screen.getByRole("button", { name: "Context window: 270k" })
    expect(button).toHaveAttribute("title", expect.stringContaining("500k next turn"))
    expect(button).toHaveAttribute("title", expect.stringContaining("higher rates above 272k"))
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(onChange).toHaveBeenCalledWith(500000)
  })
})
