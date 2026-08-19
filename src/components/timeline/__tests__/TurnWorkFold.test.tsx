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

  it("uses the full rule as part of the click target", () => {
    const onToggle = vi.fn()
    const { container } = render(
      <TurnWorkFold label="Working for 8s" expanded={false} onToggle={onToggle} />,
    )

    fireEvent.click(container.querySelector("[aria-hidden]")!)

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("updates from working to worked without replacing the disclosure", () => {
    const { rerender } = render(
      <TurnWorkFold label="Working for 8s" expanded={false} onToggle={() => {}} />,
    )
    const control = screen.getByRole("button")

    rerender(
      <TurnWorkFold label="Worked for 9s" expanded={false} onToggle={() => {}} />,
    )

    expect(screen.getByRole("button", { name: /worked for 9s/i })).toBe(control)
  })
})
