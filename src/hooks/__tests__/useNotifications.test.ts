import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { useNotifications } from "../useNotifications"

// Mock Notification
class MockNotification {
  static permission: NotificationPermission = "granted"
  static instances: MockNotification[] = []
  static requestPermission = vi.fn(() => Promise.resolve("granted" as NotificationPermission))

  title: string
  options?: NotificationOptions

  constructor(title: string, options?: NotificationOptions) {
    this.title = title
    this.options = options
    MockNotification.instances.push(this)
  }
}

// Mock AudioContext
class MockAudioContext {
  static instances: MockAudioContext[] = []
  currentTime = 0
  destination = {}

  createOscillator() {
    return {
      connect: vi.fn(),
      frequency: { value: 0 },
      type: "sine",
      start: vi.fn(),
      stop: vi.fn(),
    }
  }

  createGain() {
    return {
      connect: vi.fn(),
      gain: {
        value: 0,
        exponentialRampToValueAtTime: vi.fn(),
      },
    }
  }

  constructor() {
    MockAudioContext.instances.push(this)
  }
}

describe("useNotifications", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    MockNotification.instances = []
    MockNotification.permission = "granted"
    MockAudioContext.instances = []
    vi.stubGlobal("Notification", MockNotification)
    vi.stubGlobal("AudioContext", MockAudioContext)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const defaults = {
    isLive: false,
    sessionLabel: null,
    backgroundAgents: null,
    pendingInteraction: null,
    soundEnabled: false,
  }

  it("requests notification permission on mount when permission is default", () => {
    MockNotification.permission = "default"
    renderHook(() => useNotifications(defaults))
    expect(MockNotification.requestPermission).toHaveBeenCalled()
  })

  it("does not request permission when already granted", () => {
    MockNotification.permission = "granted"
    renderHook(() => useNotifications(defaults))
    expect(MockNotification.requestPermission).not.toHaveBeenCalled()
  })

  it("does NOT fire notification on initial false isLive (no false positive)", () => {
    renderHook(() => useNotifications({ ...defaults, isLive: false }))
    expect(MockNotification.instances).toHaveLength(0)
  })

  it("fires notification when isLive goes true → false", () => {
    const { rerender } = renderHook(
      (props) => useNotifications(props),
      { initialProps: { ...defaults, isLive: true, sessionLabel: "my-session" } }
    )

    expect(MockNotification.instances).toHaveLength(0)

    rerender({ ...defaults, isLive: false, sessionLabel: "my-session" })

    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe("Session idle")
    expect(MockNotification.instances[0].options?.body).toContain("my-session")
  })

  it("fires notification when background agent isActive goes true → false", () => {
    const activeAgents = [
      { agentId: "agent-1", isActive: true, preview: "Running tests" },
    ]
    const doneAgents = [
      { agentId: "agent-1", isActive: false, preview: "Running tests" },
    ]

    const { rerender } = renderHook(
      (props) => useNotifications(props),
      { initialProps: { ...defaults, backgroundAgents: activeAgents } }
    )

    expect(MockNotification.instances).toHaveLength(0)

    rerender({ ...defaults, backgroundAgents: doneAgents })

    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe("Agent finished")
    expect(MockNotification.instances[0].options?.body).toContain("Running tests")
  })

  it("fires notification when pendingInteraction appears", () => {
    const { rerender } = renderHook(
      (props) => useNotifications(props),
      { initialProps: defaults }
    )

    expect(MockNotification.instances).toHaveLength(0)

    rerender({
      ...defaults,
      pendingInteraction: { type: "tool_use", toolName: "Bash" },
    })

    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe("Permission required")
    expect(MockNotification.instances[0].options?.body).toContain("Bash")
  })

  it("plays sound when soundEnabled is true", () => {
    const { rerender } = renderHook(
      (props) => useNotifications(props),
      { initialProps: { ...defaults, isLive: true, soundEnabled: true } }
    )

    rerender({ ...defaults, isLive: false, soundEnabled: true })

    expect(MockAudioContext.instances).toHaveLength(1)
  })

  it("does NOT play sound when soundEnabled is false", () => {
    const { rerender } = renderHook(
      (props) => useNotifications(props),
      { initialProps: { ...defaults, isLive: true, soundEnabled: false } }
    )

    rerender({ ...defaults, isLive: false, soundEnabled: false })

    expect(MockAudioContext.instances).toHaveLength(0)
  })

  it("does NOT fire notification when permission is denied", () => {
    MockNotification.permission = "denied"

    const { rerender } = renderHook(
      (props) => useNotifications(props),
      { initialProps: { ...defaults, isLive: true } }
    )

    rerender({ ...defaults, isLive: false })

    expect(MockNotification.instances).toHaveLength(0)
  })
})
