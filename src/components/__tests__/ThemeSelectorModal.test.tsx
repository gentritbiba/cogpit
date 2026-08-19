import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ThemeSelectorModal } from "@/components/ThemeSelectorModal"

describe("ThemeSelectorModal", () => {
  it("previews focused themes and applies the selected theme", async () => {
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

    const lightTheme = screen.getByRole("button", { name: /Light/ })
    lightTheme.focus()

    await waitFor(() => {
      expect(onPreviewTheme).toHaveBeenLastCalledWith("light")
    })

    await user.click(lightTheme)
    expect(onSelectTheme).toHaveBeenCalledWith("light")
    expect(onClose).toHaveBeenCalledOnce()
  })
})
