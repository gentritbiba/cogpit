import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PublicDevice } from "@/hooks/useDevices"
import { DefaultGateScreen } from "../DefaultGateScreen"

const BUILD_BOX: PublicDevice = {
  id: "dev_build",
  name: "Build box",
  host: "build.local",
  port: 19384,
  auth: "password",
  username: "alice",
  addedAt: 1,
  runtime: { authState: "ok" },
}

function renderGate() {
  const onRestored = vi.fn()
  const onLogout = vi.fn()
  render(<DefaultGateScreen gate="closed" onRestored={onRestored} onLogout={onLogout} />)
  return { onRestored, onLogout }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ devices: [BUILD_BOX] }), {
    headers: { "Content-Type": "application/json" },
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("DefaultGateScreen on this machine", () => {
  it("says the server keeps the caller out, and checks again through the app", async () => {
    const user = userEvent.setup()
    const { onRestored, onLogout } = renderGate()

    expect(screen.getByText("This server isn’t available to your account right now")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Check again" }))

    expect(onRestored).toHaveBeenCalledOnce()
    expect(onLogout).not.toHaveBeenCalled()
  })

  it("signs out", async () => {
    const user = userEvent.setup()
    const { onLogout } = renderGate()

    await user.click(screen.getByRole("button", { name: "Sign out" }))

    expect(onLogout).toHaveBeenCalledOnce()
  })
})

describe("DefaultGateScreen on a remote device", () => {
  beforeEach(() => window.history.replaceState(null, "", "/d/dev_build/"))
  afterEach(() => window.history.replaceState(null, "", "/"))

  it("names the device and offers the way back to this machine instead of signing out", async () => {
    const user = userEvent.setup()
    const { onLogout } = renderGate()
    const switched = vi.fn()
    window.addEventListener("cogpit-device-changed", switched)

    expect(await screen.findByText("Build box isn’t available to your account right now")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Switch to this machine" }))

    expect(switched).toHaveBeenCalledOnce()
    expect(window.location.pathname).toBe("/")
    expect(onLogout).not.toHaveBeenCalled()
    window.removeEventListener("cogpit-device-changed", switched)
  })
})
