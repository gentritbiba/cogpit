import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ThemeSelectorModal } from "@/components/ThemeSelectorModal"
import { DevicePaneProvider, MachinesProvider } from "@/contexts/DevicePaneContext"

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

describe("ThemeSelectorModal with other machines", () => {
  const machines = [{ id: "local", name: "This machine" }, { id: "dev_1", name: "Studio" }]

  function renderFor(deviceId: string) {
    return render(
      <MachinesProvider value={machines}>
        <DevicePaneProvider value={deviceId}>
          <ThemeSelectorModal open onClose={vi.fn()} currentTheme="dark" onSelectTheme={vi.fn()} onPreviewTheme={vi.fn()} />
        </DevicePaneProvider>
      </MachinesProvider>,
    )
  }

  it("says whose theme it is", () => {
    renderFor("dev_1")
    expect(screen.getByText(/The theme belongs to Studio/)).toBeInTheDocument()
  })

  it("turns swiping between machines off and on", async () => {
    const user = userEvent.setup()
    localStorage.removeItem("cogpit-machine-swipe")
    renderFor("local")
    expect(screen.getByText(/The theme belongs to this machine/)).toBeInTheDocument()
    const toggle = screen.getByRole("switch")
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(localStorage.getItem("cogpit-machine-swipe")).toBe("off")
    await user.click(toggle)
    expect(localStorage.getItem("cogpit-machine-swipe")).toBeNull()
  })
})
