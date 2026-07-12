import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SetupScreen } from "../SetupScreen"

const validation = vi.hoisted(() => ({
  status: "idle" as "idle" | "valid",
  error: null as string | null,
  debouncedValidate: vi.fn(),
  save: vi.fn(),
}))

vi.mock("@/hooks/useConfigValidation", () => ({
  useConfigValidation: () => validation,
}))

describe("SetupScreen", () => {
  beforeEach(() => {
    validation.status = "idle"
    validation.error = null
    validation.debouncedValidate.mockReset()
    validation.save.mockReset()
  })

  it("explains that Codex is detected automatically", () => {
    render(<SetupScreen onConfigured={vi.fn()} />)

    expect(screen.getByText(/connects to Codex automatically/i)).toBeInTheDocument()
    expect(screen.getByText("~/.codex")).toBeInTheDocument()
  })

  it("keeps the explicit Claude Code connection path", async () => {
    validation.status = "valid"
    validation.save.mockResolvedValueOnce({
      success: true,
      claudeDir: "/home/test/.claude",
    })
    const onConfigured = vi.fn()
    render(<SetupScreen onConfigured={onConfigured} />)

    fireEvent.change(screen.getByPlaceholderText("/Users/you/.claude"), {
      target: { value: "/home/test/.claude" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude Code" }))

    await waitFor(() => {
      expect(validation.save).toHaveBeenCalledWith("/home/test/.claude")
      expect(onConfigured).toHaveBeenCalledWith("/home/test/.claude")
    })
  })
})
