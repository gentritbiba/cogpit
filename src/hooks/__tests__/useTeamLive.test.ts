import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authUrl: vi.fn((url: string) => url),
}))

import { useTeamLive } from "../useTeamLive"

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  close() {
    this.closed = true
  }

  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }))
    }
  }

  simulateError() {
    if (this.onerror) {
      this.onerror()
    }
  }
}

describe("useTeamLive", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    MockEventSource.instances = []
    vi.stubGlobal("EventSource", MockEventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("returns isLive=false when teamName is null", () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useTeamLive(null, onUpdate))
    expect(result.current.isLive).toBe(false)
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it("creates an EventSource when teamName is provided", () => {
    const onUpdate = vi.fn()
    renderHook(() => useTeamLive("my-team", onUpdate))

    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toBe(
      "/api/team-watch/my-team"
    )
  })

  it("encodes teamName in the URL", () => {
    const onUpdate = vi.fn()
    renderHook(() => useTeamLive("team with spaces", onUpdate))

    expect(MockEventSource.instances[0].url).toBe(
      "/api/team-watch/team%20with%20spaces"
    )
  })

  it("sets isLive=true on update message", () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useTeamLive("my-team", onUpdate))

    const es = MockEventSource.instances[0]

    act(() => {
      es.simulateMessage({ type: "update" })
    })

    expect(result.current.isLive).toBe(true)
  })

  it("calls onUpdate when update message is received", () => {
    const onUpdate = vi.fn()
    renderHook(() => useTeamLive("my-team", onUpdate))

    const es = MockEventSource.instances[0]

    act(() => {
      es.simulateMessage({ type: "update" })
    })

    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it("does not call onUpdate on init message", () => {
    const onUpdate = vi.fn()
    renderHook(() => useTeamLive("my-team", onUpdate))

    const es = MockEventSource.instances[0]

    act(() => {
      es.simulateMessage({ type: "init" })
    })

    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("sets isLive=false on error", () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useTeamLive("my-team", onUpdate))

    const es = MockEventSource.instances[0]

    // First set to live
    act(() => {
      es.simulateMessage({ type: "update" })
    })
    expect(result.current.isLive).toBe(true)

    // Then trigger error
    act(() => {
      es.simulateError()
    })
    expect(result.current.isLive).toBe(false)
  })

  it("sets isLive=false after 30s stale timeout", () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useTeamLive("my-team", onUpdate))

    const es = MockEventSource.instances[0]

    act(() => {
      es.simulateMessage({ type: "update" })
    })
    expect(result.current.isLive).toBe(true)

    act(() => {
      vi.advanceTimersByTime(30000)
    })

    expect(result.current.isLive).toBe(false)
  })

  it("resets stale timer on each update message", () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useTeamLive("my-team", onUpdate))

    const es = MockEventSource.instances[0]

    act(() => {
      es.simulateMessage({ type: "update" })
    })

    // Advance 20s (not yet stale)
    act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(result.current.isLive).toBe(true)

    // Another update resets the timer
    act(() => {
      es.simulateMessage({ type: "update" })
    })

    // Advance another 20s (should not be stale since timer was reset)
    act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(result.current.isLive).toBe(true)

    // Advance remaining 10s (now 30s from last update)
    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(result.current.isLive).toBe(false)
  })

  it("closes EventSource on unmount", () => {
    const onUpdate = vi.fn()
    const { unmount } = renderHook(() => useTeamLive("my-team", onUpdate))

    const es = MockEventSource.instances[0]
    expect(es.closed).toBe(false)

    unmount()
    expect(es.closed).toBe(true)
  })

  it("closes old EventSource when teamName changes", () => {
    const onUpdate = vi.fn()
    const { rerender } = renderHook(
      (props: { teamName: string | null }) =>
        useTeamLive(props.teamName, onUpdate),
      { initialProps: { teamName: "team-a" as string | null } }
    )

    const es1 = MockEventSource.instances[0]
    expect(es1.closed).toBe(false)

    rerender({ teamName: "team-b" })

    expect(es1.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(2)
    expect(MockEventSource.instances[1].url).toBe("/api/team-watch/team-b")
  })

  it("closes EventSource when teamName becomes null", () => {
    const onUpdate = vi.fn()
    const { result, rerender } = renderHook(
      (props: { teamName: string | null }) =>
        useTeamLive(props.teamName, onUpdate),
      { initialProps: { teamName: "team-a" as string | null } }
    )

    const es = MockEventSource.instances[0]

    rerender({ teamName: null })

    expect(es.closed).toBe(true)
    expect(result.current.isLive).toBe(false)
  })

  it("ignores invalid JSON in messages", () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useTeamLive("my-team", onUpdate))

    const es = MockEventSource.instances[0]

    // Send invalid JSON
    act(() => {
      if (es.onmessage) {
        es.onmessage(new MessageEvent("message", { data: "not-json" }))
      }
    })

    // Should not crash and isLive remains false
    expect(result.current.isLive).toBe(false)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("uses latest onUpdate callback via ref", () => {
    const onUpdate1 = vi.fn()
    const onUpdate2 = vi.fn()

    const { rerender } = renderHook(
      (props: { onUpdate: () => void }) =>
        useTeamLive("my-team", props.onUpdate),
      { initialProps: { onUpdate: onUpdate1 } }
    )

    rerender({ onUpdate: onUpdate2 })

    const es = MockEventSource.instances[0]

    act(() => {
      es.simulateMessage({ type: "update" })
    })

    // Should call the new callback, not the old one
    expect(onUpdate1).not.toHaveBeenCalled()
    expect(onUpdate2).toHaveBeenCalledTimes(1)
  })
})
