import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DevicesDialog, parseHostPort, probeMessage } from "@/components/DevicesDialog"

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn(), switchDevice: vi.fn() }))

vi.mock("@/lib/auth", () => ({ hubFetch: mocks.hubFetch }))
vi.mock("@/lib/device", () => ({
  LOCAL_DEVICE_ID: "local",
  getActiveDeviceId: () => "local",
  switchDevice: mocks.switchDevice,
}))

/** Route hub requests by URL + method. `probe`/`add` are overridable per test. */
function routeHub(options: {
  devices?: unknown[]
  probe?: unknown
  add?: { body: unknown; ok?: boolean; status?: number }
}) {
  const { devices = [], probe, add } = options
  mocks.hubFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/hub/devices" && init?.method === "POST") {
      return Promise.resolve({
        ok: add?.ok ?? true,
        status: add?.status ?? 201,
        json: async () => add?.body ?? { device: { id: "dev_new" } },
      })
    }
    if (url === "/api/hub/devices/probe") {
      return Promise.resolve({ ok: true, status: 200, json: async () => probe })
    }
    if (url === "/api/hub/devices") {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ devices }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

describe("parseHostPort", () => {
  it("splits host and port, tolerating a pasted scheme", () => {
    expect(parseHostPort("10.0.0.5:1234")).toEqual({ host: "10.0.0.5", port: 1234 })
    expect(parseHostPort("http://my-mac.local/")).toEqual({ host: "my-mac.local" })
    expect(parseHostPort("  box  ")).toEqual({ host: "box" })
  })
})

describe("probeMessage", () => {
  it("maps each probe outcome to actionable copy", () => {
    expect(probeMessage({ ok: false, code: "UNREACHABLE" }, "box", 19384).text)
      .toMatch(/Can't reach box:19384/)
    expect(probeMessage({ ok: false, code: "LEGACY_NO_HELLO" }, "box", 19384).text)
      .toMatch(/too old for multi-device/)
    expect(probeMessage({ ok: false, code: "NOT_COGPIT" }, "box", 19384).text)
      .toMatch(/isn't Cogpit/)
    expect(probeMessage({ ok: false, code: "SELF_ADD" }, "box", 19384).text)
      .toMatch(/this machine/)
    expect(probeMessage({ ok: true, hello: { networkAccess: false } }, "box", 19384).text)
      .toMatch(/network access is disabled/)
    expect(probeMessage({ ok: true, hello: { configured: false } }, "box", 19384).text)
      .toMatch(/setup screen/)
    expect(probeMessage({ ok: true, hello: { name: "Studio", version: "1.0.1" } }, "box", 19384))
      .toEqual({ tone: "ok", text: 'Found Cogpit "Studio" (v1.0.1).' })
  })
})

describe("DevicesDialog", () => {
  beforeEach(() => {
    mocks.hubFetch.mockReset()
    mocks.switchDevice.mockReset()
  })

  it("shows unreachable copy from a live probe", async () => {
    routeHub({ probe: { ok: false, code: "UNREACHABLE", error: "x" } })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.type(screen.getByLabelText("Host"), "192.168.1.9")
    await user.tab() // blur → immediate probe

    expect(await screen.findByText(/Can't reach 192\.168\.1\.9:19384/)).toBeInTheDocument()
  })

  it("adds a device, then switches to it and closes", async () => {
    routeHub({
      probe: { ok: true, hello: { name: "Studio", version: "1.0.1", networkAccess: true, configured: true } },
      add: { body: { device: { id: "dev_new" } }, status: 201 },
    })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={onClose} />)

    await user.type(screen.getByLabelText("Host"), "10.0.0.5")
    await user.tab()
    expect(await screen.findByText(/Found Cogpit "Studio"/)).toBeInTheDocument()

    await user.type(screen.getByLabelText("Password"), "hunter2hunter2")
    await user.click(screen.getByRole("button", { name: "Add device" }))

    await waitFor(() => expect(mocks.switchDevice).toHaveBeenCalledWith("dev_new"))
    expect(onClose).toHaveBeenCalled()
  })

  it("maps a rejected password to an inline field error", async () => {
    routeHub({
      probe: { ok: true, hello: { name: "Studio", networkAccess: true, configured: true } },
      add: { body: { error: "The password was rejected by the device.", code: "BAD_PASSWORD" }, ok: false, status: 400 },
    })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.type(screen.getByLabelText("Host"), "10.0.0.5")
    await user.tab()
    await screen.findByText(/Found Cogpit/)
    await user.type(screen.getByLabelText("Password"), "wrong-pass-1")
    await user.click(screen.getByRole("button", { name: "Add device" }))

    expect(await screen.findByText(/password was rejected/)).toBeInTheDocument()
    expect(mocks.switchDevice).not.toHaveBeenCalled()
  })

  it("reveals the tunnel warning and hides the password field", async () => {
    routeHub({})
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.click(screen.getByRole("checkbox", { name: /local tunnel/ }))

    expect(screen.getByText(/forwarded/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
  })
})
