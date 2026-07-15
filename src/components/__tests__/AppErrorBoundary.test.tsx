import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AppErrorBoundary } from "@/components/AppErrorBoundary"

function BrokenComponent(): never {
  throw new Error("render exploded")
}

describe("AppErrorBoundary", () => {
  it("shows a recoverable fallback instead of blanking the app", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    render(
      <AppErrorBoundary>
        <BrokenComponent />
      </AppErrorBoundary>,
    )

    expect(screen.getByRole("heading", { name: "Cogpit hit a render error" })).toBeInTheDocument()
    expect(screen.getByText("render exploded")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload Cogpit" })).toBeInTheDocument()
    consoleError.mockRestore()
  })
})
