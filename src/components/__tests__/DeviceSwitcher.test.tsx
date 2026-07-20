import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"

const mocks = vi.hoisted(() => ({ switchDevice: vi.fn(), useDevices: vi.fn() }))

vi.mock("@/lib/device", () => ({
  LOCAL_DEVICE_ID: "local",
  switchDevice: mocks.switchDevice,
}))
vi.mock("@/hooks/useDevices", () => ({
  useDevices: mocks.useDevices,
  deviceVersion: (device: { runtime?: { lastHello?: { version?: string } } }) =>
    device.runtime?.lastHello?.version,
}))
vi.mock("@/components/DevicesDialog", () => ({ DevicesDialog: () => null }))

const DEVICE = {
  id: "dev_1",
  name: "Studio",
  host: "10.0.0.5",
  port: 19384,
  auth: "password" as const,
  addedAt: 1,
  runtime: { authState: "ok" as const, lastHello: { version: "1.0.1" } },
}

function hookValue(overrides: Record<string, unknown> = {}) {
  return {
    devices: [DEVICE],
    activeDeviceId: "local",
    activeDevice: undefined,
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    probe: vi.fn(),
    addDevice: vi.fn(),
    updateDevice: vi.fn(),
    removeDevice: vi.fn(),
    testDevice: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
}

describe("DeviceSwitcher", () => {
  beforeEach(() => {
    mocks.switchDevice.mockReset()
    mocks.useDevices.mockReturnValue(hookValue())
  })

  it("shows the local device name on the trigger", () => {
    render(<DeviceSwitcher />)
    expect(screen.getByRole("button", { name: "Switch device" })).toHaveTextContent("This machine")
  })

  it("switches to a device chosen from the dropdown", async () => {
    const user = userEvent.setup()
    render(<DeviceSwitcher />)

    await user.click(screen.getByRole("button", { name: "Switch device" }))
    await user.click(await screen.findByText("Studio"))

    expect(mocks.switchDevice).toHaveBeenCalledWith("dev_1")
  })

  it("probes every device when the dropdown opens", async () => {
    const value = hookValue()
    mocks.useDevices.mockReturnValue(value)
    const user = userEvent.setup()
    render(<DeviceSwitcher />)

    await user.click(screen.getByRole("button", { name: "Switch device" }))

    await waitFor(() => expect(value.testDevice).toHaveBeenCalledWith("dev_1"))
    await waitFor(() => expect(value.refresh).toHaveBeenCalled())
  })

  it("marks the active remote device with a check and reflects its name", () => {
    mocks.useDevices.mockReturnValue(
      hookValue({ activeDeviceId: "dev_1", activeDevice: DEVICE }),
    )
    render(<DeviceSwitcher />)
    expect(screen.getByRole("button", { name: "Switch device" })).toHaveTextContent("Studio")
  })
})
