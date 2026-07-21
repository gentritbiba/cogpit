import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { NetworkAccessSection } from "../NetworkAccessSection"

function renderSection(networkAccess = true) {
  const setNetworkAccess = vi.fn()
  render(
    <NetworkAccessSection
      networkAccess={networkAccess}
      setNetworkAccess={setNetworkAccess}
      networkPassword=""
      setNetworkPassword={vi.fn()}
      showNetworkPassword={false}
      setShowNetworkPassword={vi.fn()}
      hasExistingPassword={false}
      initialNetworkAccess={networkAccess}
      connectedDevices={[]}
      minPasswordLength={12}
    />,
  )
  return { setNetworkAccess }
}

describe("NetworkAccessSection", () => {
  it("explains the HTTPS browser boundary when network access is enabled", () => {
    renderSection()

    expect(screen.getByText(/remote browsers need an HTTPS reverse proxy/i)).toBeInTheDocument()
    expect(screen.getByText(/port 19384 remains available to Cogpit hubs/i)).toBeInTheDocument()
  })

  it("delegates switch changes to the settings owner", async () => {
    const user = userEvent.setup()
    const { setNetworkAccess } = renderSection()

    await user.click(screen.getByRole("switch", { name: "Network Access" }))

    expect(setNetworkAccess).toHaveBeenCalledWith(false)
  })
})
