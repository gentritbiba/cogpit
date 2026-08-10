import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, act, waitFor } from "@testing-library/react"
import { DeviceRoot } from "@/components/DeviceRoot"
import { deviceScopedKey, setActiveIdentity, __resetIdentityForTest } from "@/lib/device"

const mocks = vi.hoisted(() => ({
  getActiveDeviceId: vi.fn(() => "dev_1"),
  switchDevice: vi.fn(),
  testDevice: vi.fn(),
  matchDeviceSwitchIndex: vi.fn(() => null),
  matchDeviceCycle: vi.fn(() => false),
  onAppMount: vi.fn(),
}))

// The stub App mirrors the real one's storage pattern: a useState initializer
// reads localStorage through deviceScopedKey exactly once per MOUNT, so the
// identity-keyed remount is observable through the rendered value.
vi.mock("@/App", async () => {
  const { useState } = await import("react")
  const { deviceScopedKey: scopedKey } = await import("@/lib/device")
  return {
    default: function AppStub() {
      const [bootValue] = useState(() => {
        mocks.onAppMount()
        return localStorage.getItem(scopedKey("cogpit:test-pref"))
      })
      return <div data-testid="app">{bootValue ?? "empty"}</div>
    },
  }
})
// These tests cover the offline banner, not the inventory; a pass-through
// provider keeps them from fetching sessions.
vi.mock("@/contexts/SessionInventoryContext", () => ({
  SessionInventoryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
// Partial mock: device routing is faked, the identity cell stays real so the
// remount tests exercise the actual setActiveIdentity → event → key path.
vi.mock("@/lib/device", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/device")>()
  return {
    ...actual,
    getActiveDeviceId: mocks.getActiveDeviceId,
    switchDevice: mocks.switchDevice,
  }
})
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

describe("DeviceRoot identity-keyed remount", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveDeviceId.mockReturnValue("local")
    localStorage.clear()
    __resetIdentityForTest()
  })
  afterEach(() => {
    __resetIdentityForTest()
    localStorage.clear()
  })

  it("mounts App immediately without waiting for an identity (personal parity, no hold)", () => {
    localStorage.setItem("cogpit:test-pref", "unscoped")
    render(<DeviceRoot />)
    expect(screen.getByTestId("app")).toHaveTextContent("unscoped")
    expect(mocks.onAppMount).toHaveBeenCalledTimes(1)
  })

  it("remounts the App subtree when a team identity resolves so store reads re-run scoped", () => {
    localStorage.setItem("cogpit:test-pref", "stale-shared")
    localStorage.setItem("cogpit:test-pref::local::u_1", "scoped")
    render(<DeviceRoot />)
    expect(screen.getByTestId("app")).toHaveTextContent("stale-shared")

    act(() => setActiveIdentity("u_1"))

    expect(screen.getByTestId("app")).toHaveTextContent("scoped")
    expect(mocks.onAppMount).toHaveBeenCalledTimes(2)
  })

  it("does not remount when the resolved identity is unchanged", () => {
    render(<DeviceRoot />)
    act(() => setActiveIdentity("u_1"))
    expect(mocks.onAppMount).toHaveBeenCalledTimes(2)

    act(() => setActiveIdentity("u_1"))
    expect(mocks.onAppMount).toHaveBeenCalledTimes(2)
  })

  it("reads a scoped write back after a simulated reload once the same identity resolves", () => {
    // Session 1: identity resolves, a store persists through the scoped key.
    const first = render(<DeviceRoot />)
    act(() => setActiveIdentity("u_1"))
    localStorage.setItem(deviceScopedKey("cogpit:test-pref"), "written-by-u1")
    first.unmount()

    // Simulated reload: the identity cell resets, then /api/me resolves the
    // same user — the remounted App must read the value written last session.
    __resetIdentityForTest()
    render(<DeviceRoot />)
    expect(screen.getByTestId("app")).toHaveTextContent("empty")
    act(() => setActiveIdentity("u_1"))
    expect(screen.getByTestId("app")).toHaveTextContent("written-by-u1")
  })
})
