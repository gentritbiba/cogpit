import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, act, waitFor } from "@testing-library/react"
import { DeviceRoot } from "@/components/DeviceRoot"

const mocks = vi.hoisted(() => ({
  getActiveDeviceId: vi.fn(() => "dev_1"),
  switchDevice: vi.fn(),
  testDevice: vi.fn(),
  matchDeviceSwitchIndex: vi.fn(() => null),
  matchDeviceCycle: vi.fn(() => false),
}))

vi.mock("@/App", () => ({ default: () => <div data-testid="app" /> }))
vi.mock("@/lib/device", () => ({
  LOCAL_DEVICE_ID: "local",
  getActiveDeviceId: mocks.getActiveDeviceId,
  switchDevice: mocks.switchDevice,
}))
vi.mock("@/lib/keybindings", () => ({
  matchDeviceSwitchIndex: mocks.matchDeviceSwitchIndex,
  matchDeviceCycle: mocks.matchDeviceCycle,
}))
vi.mock("@/hooks/useDevices", () => ({
  useDevices: () => ({
    devices: [{ id: "dev_1", name: "Studio", host: "10.0.0.5", port: 19384, auth: "password", addedAt: 1, runtime: { authState: "ok" } }],
    testDevice: mocks.testDevice,
  }),
}))

function fireUnreachable(deviceId = "dev_1") {
  act(() => {
    window.dispatchEvent(new CustomEvent("cogpit-device-unreachable", { detail: { deviceId } }))
  })
}

describe("DeviceRoot offline banner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveDeviceId.mockReturnValue("dev_1")
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows the retrying banner when the active device is unreachable", () => {
    render(<DeviceRoot />)
    fireUnreachable()
    expect(screen.getByText(/Studio/)).toBeInTheDocument()
    expect(screen.getByText(/retrying/i)).toBeInTheDocument()
  })

  it("does NOT show a banner for a background device that is not active", () => {
    render(<DeviceRoot />)
    fireUnreachable("dev_other")
    expect(screen.queryByText(/retrying/i)).not.toBeInTheDocument()
  })

  it("stops the retry loop and shows a stale-password message when the device rejects the stored password", async () => {
    mocks.testDevice.mockResolvedValue({ ok: false, reachable: true, authState: "bad-password" })
    render(<DeviceRoot />)
    fireUnreachable()

    // First auto-retry tick surfaces the bad-password state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(screen.getByText(/rejected the stored password/i)).toBeInTheDocument()

    // Once bad-password is known, the interval is cleared — no further testDevice calls.
    const callsAfterFirst = mocks.testDevice.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(mocks.testDevice.mock.calls.length).toBe(callsAfterFirst)
  })

  it("clears the banner when a retry reports the device is healthy again", async () => {
    mocks.testDevice.mockResolvedValue({ ok: true, reachable: true, authState: "ok" })
    render(<DeviceRoot />)
    fireUnreachable()
    expect(screen.getByText(/retrying/i)).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await waitFor(() => expect(screen.queryByText(/retrying/i)).not.toBeInTheDocument())
  })
})
