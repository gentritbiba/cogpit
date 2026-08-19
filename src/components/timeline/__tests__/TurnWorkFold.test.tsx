import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TurnWorkFold } from "../TurnWorkFold"

describe("TurnWorkFold", () => {
  it("shows the label and reports the collapsed state to assistive tech", () => {
    render(<TurnWorkFold label="Worked for 47s" expanded={false} onToggle={() => {}} />)

    const control = screen.getByRole("button", { name: /worked for 47s/i })
    expect(control).toHaveAttribute("aria-expanded", "false")
  })

  it("reports the expanded state once the work is open", () => {
    render(<TurnWorkFold label="Worked for 47s" expanded onToggle={() => {}} />)

    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true")
  })

  it("toggles on click", () => {
    const onToggle = vi.fn()
    render(<TurnWorkFold label="Worked for 12s" expanded={false} onToggle={onToggle} />)

    fireEvent.click(screen.getByRole("button"))

    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
