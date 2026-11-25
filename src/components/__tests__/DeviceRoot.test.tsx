import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, act, waitFor } from "@testing-library/react"
import { DeviceRoot, nextPanes } from "@/components/DeviceRoot"
import {
  __resetDeviceRevisionsForTest,
  __resetIdentityForTest,
  deviceScopedKey,
  recordDeviceConnectionRevision,
  setActiveIdentity,
} from "@/lib/device"
import { __resetDeviceThemesForTest, rememberDeviceTheme, savedDeviceTheme } from "@/lib/deviceThemes"

const DEFAULT_DEVICES = vi.hoisted(() => [{ id: "dev_1", name: "Studio", host: "10.0.0.5", port: 19384, auth: "password", addedAt: 1, runtime: { authState: "ok" } as { authState: string; lastHello?: unknown } }])
const mocks = vi.hoisted(() => ({
  devices: DEFAULT_DEVICES as unknown[],
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
vi.mock("@/hooks/useDevices", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/useDevices")>(),
  useDevices: () => ({
    devices: mocks.devices,
    loading: false,
    testDevice: mocks.testDevice,
  }),
}))

function fireUnreachable(deviceId = "dev_1", reason = "DEVICE_UNREACHABLE") {
  act(() => {
    window.dispatchEvent(new CustomEvent("cogpit-device-unreachable", { detail: { deviceId, reason } }))
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
    window.history.replaceState(null, "", "/")
  })

  it("shows the retrying banner when the active device is unreachable", () => {
    render(<DeviceRoot />)
    fireUnreachable()
    expect(screen.getByText(/Can’t reach Studio/)).toBeInTheDocument()
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

  it("names the credential as the problem when the hub says the device rejected it", async () => {
    render(<DeviceRoot />)
    fireUnreachable("dev_1", "DEVICE_AUTH_FAILED")

    // A rejected credential cannot self-heal, so the message is immediate and
    // no retry loop runs at all.
    expect(screen.getByText(/rejected the stored password/i)).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(mocks.testDevice).not.toHaveBeenCalled()
  })

  it("asks the device for its reason as soon as it refuses, then keeps retrying until it admits the account", async () => {
    mocks.testDevice
      .mockResolvedValueOnce({ ok: false, reachable: true, authState: "unknown", code: "DEVICE_REFUSED", error: "Studio: Only admins can sign in for now." })
      .mockResolvedValue({ ok: true, reachable: true, authState: "ok" })
    render(<DeviceRoot />)
    fireUnreachable("dev_1", "DEVICE_REFUSED")

    // Until the device answers, the banner says what the hub knows.
    expect(screen.getByText("Studio is not admitting this account right now. Cogpit will keep retrying.")).toBeInTheDocument()
    expect(screen.queryByText(/rejected the stored password/i)).not.toBeInTheDocument()
    expect(mocks.testDevice).toHaveBeenCalledExactlyOnceWith("dev_1")

    // No poll has run yet: the device's own text arrives with the first answer.
    await act(async () => {})
    expect(screen.getByText("Studio: Only admins can sign in for now. Cogpit will keep retrying.")).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await waitFor(() => expect(screen.queryByText(/Only admins can sign in/)).not.toBeInTheDocument())
    expect(mocks.testDevice).toHaveBeenCalledTimes(2)
  })

  it("keeps the device's reason when the hub repeats its refusal", async () => {
    mocks.testDevice.mockResolvedValue({ ok: false, reachable: true, authState: "unknown", code: "DEVICE_REFUSED", error: "Studio: Only admins can sign in for now." })
    render(<DeviceRoot />)
    fireUnreachable("dev_1", "DEVICE_REFUSED")
    await act(async () => {})

    fireUnreachable("dev_1", "DEVICE_REFUSED")
    await act(async () => {})

    expect(screen.getByText("Studio: Only admins can sign in for now. Cogpit will keep retrying.")).toBeInTheDocument()
    expect(mocks.testDevice).toHaveBeenCalledOnce()
  })

  it("names the refusal when a retry finds it on a device that looked unreachable", async () => {
    mocks.testDevice.mockResolvedValue({ ok: false, reachable: true, authState: "unknown", code: "DEVICE_REFUSED" })
    render(<DeviceRoot />)
    fireUnreachable()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(screen.getByText("Studio is not admitting this account right now. Cogpit will keep retrying.")).toBeInTheDocument()
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

  describe("a retry still in flight when the target changes", () => {
    /** Point both the URL, which scopes async work, and DeviceRoot's own read at `deviceId`. */
    function routeTo(deviceId: string) {
      window.history.replaceState(null, "", `/d/${deviceId}/`)
      mocks.getActiveDeviceId.mockReturnValue(deviceId)
    }

    afterEach(() => {
      __resetDeviceRevisionsForTest()
    })

    it.each([
      ["another device becomes active", () => {
        routeTo("dev_2")
        window.dispatchEvent(new Event("cogpit-device-changed"))
      }],
      ["the device's credentials change", () => {
        recordDeviceConnectionRevision("dev_1", 1)
      }],
    ])("drops the retry's answer once %s", async (_change, changeTarget) => {
      let answerRetry: (result: unknown) => void = () => undefined
      mocks.testDevice.mockReturnValueOnce(new Promise((resolve) => { answerRetry = resolve }))
      routeTo("dev_1")
      render(<DeviceRoot />)
      fireUnreachable()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(mocks.testDevice).toHaveBeenCalledExactlyOnceWith("dev_1")

      act(changeTarget)
      await act(async () => {
        answerRetry({ ok: false, reachable: false, authState: "unknown", code: "UNREACHABLE" })
      })

      expect(screen.queryByRole("status")).not.toBeInTheDocument()
      expect(mocks.onAppMount).toHaveBeenCalledTimes(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(mocks.testDevice).toHaveBeenCalledOnce()
    })
  })
})

describe("DeviceRoot identity-keyed remount", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveDeviceId.mockReturnValue("local")
    localStorage.clear()
    __resetDeviceRevisionsForTest()
    __resetIdentityForTest()
  })
  afterEach(() => {
    __resetIdentityForTest()
    __resetDeviceRevisionsForTest()
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

  it("remounts a same-id remote on a sensitive revision change but not a rename notification", () => {
    window.history.replaceState(null, "", "/d/dev_1/")
    mocks.getActiveDeviceId.mockReturnValue("dev_1")
    recordDeviceConnectionRevision("dev_1", 4)
    localStorage.setItem("cogpit:test-pref::dev_1@4", "old-target")
    localStorage.setItem("cogpit:test-pref::dev_1@5", "new-target")

    render(<DeviceRoot />)
    expect(screen.getByTestId("app")).toHaveTextContent("old-target")

    act(() => { recordDeviceConnectionRevision("dev_1", 5) })
    expect(screen.getByTestId("app")).toHaveTextContent("new-target")
    expect(mocks.onAppMount).toHaveBeenCalledTimes(2)

    // A rename response repeats the same server revision and must stay warm.
    act(() => { recordDeviceConnectionRevision("dev_1", 5) })
    expect(mocks.onAppMount).toHaveBeenCalledTimes(2)
  })
})

describe("DeviceRoot keeps machines alive", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    __resetDeviceRevisionsForTest()
    __resetIdentityForTest()
    mocks.getActiveDeviceId.mockReturnValue("local")
  })
  afterEach(() => {
    window.history.replaceState(null, "", "/")
  })

  function showDevice(id: string) {
    mocks.getActiveDeviceId.mockReturnValue(id)
    act(() => { window.dispatchEvent(new Event("cogpit-device-changed")) })
  }

  function frameOf(deviceId: string): HTMLElement {
    const pane = document.querySelector(`[data-device-pane="${deviceId}"]`)
    if (!(pane?.firstElementChild instanceof HTMLElement)) throw new Error(`no pane for ${deviceId}`)
    return pane.firstElementChild
  }

  it("hides a machine left for another instead of unmounting it, and shows it again as it was", () => {
    render(<DeviceRoot />)
    expect(mocks.onAppMount).toHaveBeenCalledTimes(1)

    showDevice("dev_1")
    expect(mocks.onAppMount).toHaveBeenCalledTimes(2)
    expect(frameOf("local").style.display).toBe("none")
    expect(frameOf("dev_1").style.display).toBe("")

    showDevice("local")
    expect(mocks.onAppMount).toHaveBeenCalledTimes(2)
    expect(frameOf("local").style.display).toBe("")
    expect(frameOf("dev_1").style.display).toBe("none")
  })

  it("dresses each pane, and the page, in its own machine's theme", () => {
    localStorage.setItem("cogpit-device-themes", JSON.stringify({ local: { theme: "light" }, dev_1: { theme: "oled" } }))
    __resetDeviceThemesForTest()
    render(<DeviceRoot />)
    showDevice("dev_1")
    expect(document.querySelector('[data-device-pane="local"]')).toHaveClass("theme-scope")
    expect(document.querySelector('[data-device-pane="local"]')).not.toHaveClass("dark")
    expect(document.querySelector('[data-device-pane="dev_1"]')).toHaveClass("theme-scope", "dark", "theme-oled")
    expect(document.documentElement).toHaveClass("dark", "theme-oled")
    showDevice("local")
    expect(document.documentElement).not.toHaveClass("dark")
  })
})

describe("DeviceRoot and the themes the hub heard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    __resetDeviceThemesForTest()
    mocks.getActiveDeviceId.mockReturnValue("local")
  })

  it("takes a machine's reported theme only for a machine this browser has not met", () => {
    mocks.devices = [{ id: "dev_1", name: "Studio", host: "10.0.0.5", port: 19384, auth: "password", addedAt: 1, runtime: { authState: "ok", lastHello: { theme: "light" } } }]
    const { rerender } = render(<DeviceRoot />)
    expect(savedDeviceTheme("dev_1")).toBe("light")

    // A pick made since; a later registry read still carries the old hello.
    rememberDeviceTheme("dev_1", "oled", "host")
    mocks.devices = [...mocks.devices]
    rerender(<DeviceRoot />)
    expect(savedDeviceTheme("dev_1")).toBe("oled")
    mocks.devices = DEFAULT_DEVICES
  })
})

describe("nextPanes", () => {
  const options = (activeDeviceId: string, extra: Partial<Parameters<typeof nextPanes>[1]> = {}) => ({
    activeDeviceId,
    identityKey: null,
    retries: {},
    listedIds: ["a", "b", "c", "d", "e", "f"],
    ...extra,
  })

  it("adds the machine shown, keeps the order, and marks it most recently used", () => {
    let panes = nextPanes([], options("local"))
    panes = nextPanes(panes, options("a"))
    panes = nextPanes(panes, options("local"))
    expect(panes.map((pane) => pane.deviceId)).toEqual(["local", "a"])
    expect(panes[0].lastUsed).toBeGreaterThan(panes[1].lastUsed)
  })

  it("lets the least recently used machine go past five", () => {
    let panes = nextPanes([], options("local"))
    for (const id of ["a", "b", "c", "d"]) panes = nextPanes(panes, options(id))
    panes = nextPanes(panes, options("local"))
    panes = nextPanes(panes, options("e"))
    expect(panes.map((pane) => pane.deviceId)).toEqual(["local", "b", "c", "d", "e"])
  })

  it("remounts the machine shown after a retry, and drops a background one whose key went stale", () => {
    let panes = nextPanes([], options("local"))
    panes = nextPanes(panes, options("a"))
    const before = panes.find((pane) => pane.deviceId === "a")!.key
    panes = nextPanes(panes, options("a", { retries: { a: 1 } }))
    expect(panes.find((pane) => pane.deviceId === "a")!.key).not.toBe(before)
    panes = nextPanes(panes, options("a", { identityKey: "u_1", retries: { a: 1 } }))
    expect(panes.map((pane) => pane.deviceId)).toEqual(["a"])
  })

  it("drops a machine the registry no longer lists, but not while it loads", () => {
    let panes = nextPanes([], options("a"))
    panes = nextPanes(panes, options("local", { listedIds: null }))
    expect(panes.map((pane) => pane.deviceId)).toEqual(["a", "local"])
    panes = nextPanes(panes, options("local", { listedIds: ["b"] }))
    expect(panes.map((pane) => pane.deviceId)).toEqual(["local"])
  })
})
