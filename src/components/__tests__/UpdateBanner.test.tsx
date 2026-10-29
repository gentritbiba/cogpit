import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { UpdateBanner } from "@/components/UpdateBanner"

function installApi(initial: ElectronUpdateState) {
  let push: (state: ElectronUpdateState) => void = () => {}
  const api = {
    getState: vi.fn().mockResolvedValue(initial),
    onState: vi.fn((cb: (state: ElectronUpdateState) => void) => {
      push = cb
      return vi.fn()
    }),
    install: vi.fn().mockResolvedValue(undefined),
    dismissVersion: vi.fn(),
  }
  window.electronUpdater = api
  return { api, push: (state: ElectronUpdateState) => act(() => push(state)) }
}

afterEach(() => {
  delete window.electronUpdater
})

describe("UpdateBanner", () => {
  it("renders nothing outside the desktop app or without an update", async () => {
    const { container, rerender } = render(<UpdateBanner />)
    expect(container).toBeEmptyDOMElement()
    installApi({ status: "idle" })
    rerender(<UpdateBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a downloaded update from the initial state and restarts into it", async () => {
    const { api } = installApi({ status: "ready", version: "3.5.0", asksForPassword: false })
    render(<UpdateBanner />)
    expect(await screen.findByText("Cogpit v3.5.0 is ready")).toBeInTheDocument()
    expect(screen.getByText(/installs the next time you quit/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /restart now/i }))
    expect(api.install).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: /restart now/i })).toBeDisabled()
  })

  it("warns that a package install asks for a password", async () => {
    installApi({ status: "ready", version: "3.5.0", asksForPassword: true })
    render(<UpdateBanner />)
    expect(await screen.findByText(/enter your password/)).toBeInTheDocument()
  })

  it("follows pushed states and offers the release when an install fails", async () => {
    const { push } = installApi({ status: "idle" })
    render(<UpdateBanner />)
    push({ status: "failed", version: "3.5.0", message: "pkexec was dismissed", url: "https://github.com/gentritbiba/cogpit/releases/tag/v3.5.0" })
    expect(screen.getByText("Cogpit v3.5.0 could not be installed")).toBeInTheDocument()
    expect(screen.getByText("pkexec was dismissed")).toBeInTheDocument()
    expect(screen.getByText("Download").closest("a")).toHaveAttribute("href", "https://github.com/gentritbiba/cogpit/releases/tag/v3.5.0")
  })

  it("remembers a dismissed release that must be installed by hand", async () => {
    const { api } = installApi({ status: "available", version: "3.5.0", url: "https://github.com/gentritbiba/cogpit/releases/tag/v3.5.0", via: "package-manager" })
    render(<UpdateBanner />)
    expect(await screen.findByText("Update through your package manager.")).toBeInTheDocument()
    expect(screen.queryByText("Download")).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: /don't show again/i }))
    expect(api.dismissVersion).toHaveBeenCalledWith("3.5.0")
    expect(screen.queryByText("Cogpit v3.5.0 is available")).toBeNull()
  })

  it("hides a dismissed banner until a different state arrives", async () => {
    const { push } = installApi({ status: "ready", version: "3.5.0", asksForPassword: false })
    render(<UpdateBanner />)
    await userEvent.click(await screen.findByRole("button", { name: /dismiss update/i }))
    expect(screen.queryByText("Cogpit v3.5.0 is ready")).toBeNull()
    push({ status: "ready", version: "3.6.0", asksForPassword: false })
    expect(screen.getByText("Cogpit v3.6.0 is ready")).toBeInTheDocument()
  })
})
