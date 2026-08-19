import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { DisabledHint } from "../disabled-hint"
import { TooltipProvider } from "../tooltip"

function renderHint(reason?: string) {
  return render(
    <TooltipProvider>
      <DisabledHint reason={reason}>
        <button type="button" disabled={Boolean(reason)}>
          Terminal
        </button>
      </DisabledHint>
    </TooltipProvider>,
  )
}

describe("DisabledHint", () => {
  it("keeps the control on screen when it is unavailable", () => {
    renderHint("Only on the machine running this session.")

    expect(screen.getByRole("button", { name: "Terminal" })).toBeDisabled()
  })

  it("exposes the reason to assistive tech without a hover", () => {
    renderHint("Only on the machine running this session.")

    expect(
      screen.getByLabelText("Only on the machine running this session."),
    ).toBeInTheDocument()
  })

  it("adds no wrapper at all when the control is available", () => {
    const { container } = renderHint(undefined)

    expect(screen.getByRole("button", { name: "Terminal" })).toBeEnabled()
    expect(container.querySelector("span")).toBeNull()
  })
})
