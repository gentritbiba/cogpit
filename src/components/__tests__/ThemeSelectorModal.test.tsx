import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ThemeSelectorModal } from "@/components/ThemeSelectorModal"

describe("ThemeSelectorModal", () => {
  it.each([
    ["light", "Light"],
    ["layered-light", "Layered Light"],
  ] as const)("previews and selects %s", async (id, name) => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSelectTheme = vi.fn()
    const onPreviewTheme = vi.fn()

    render(
      <ThemeSelectorModal
        open
        onClose={onClose}
        currentTheme="dark"
        onSelectTheme={onSelectTheme}
        onPreviewTheme={onPreviewTheme}
      />,
    )

    const lightTheme = screen.getByRole("button", { name })
    lightTheme.focus()

    await waitFor(() => {
      expect(onPreviewTheme).toHaveBeenLastCalledWith(id)
    })

    await user.click(lightTheme)
    expect(onSelectTheme).toHaveBeenCalledWith(id)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
