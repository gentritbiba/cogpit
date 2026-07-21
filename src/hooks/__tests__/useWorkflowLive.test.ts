import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ authUrl: vi.fn((url: string) => url) }))

import { useWorkflowLive } from "../useWorkflowLive"

class MockEventSource {
  static instances: MockEventSource[] = []
  readonly url: string
  closed = false
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  update(): void {
    this.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ type: "update" }),
    }))
  }
}

describe("useWorkflowLive", () => {
  beforeEach(() => {
    MockEventSource.instances = []
    vi.stubGlobal("EventSource", MockEventSource)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("does not subscribe until both project and session are known", () => {
    const { result } = renderHook(() => useWorkflowLive("project", null, null, vi.fn()))
    expect(result.current.isLive).toBe(false)
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it("encodes the project, session, and optional run in the watch URL", () => {
    renderHook(() => useWorkflowLive("project one", "session/two", "run three", vi.fn()))
    expect(MockEventSource.instances[0].url).toBe(
      "/api/workflow-watch/project%20one/session%2Ftwo/run%20three",
    )
  })

  it("reports updates through the shared live state machine", () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() => useWorkflowLive("project", "session", null, onUpdate))

    act(() => MockEventSource.instances[0].update())

    expect(result.current.isLive).toBe(true)
    expect(onUpdate).toHaveBeenCalledOnce()
  })

  it("closes the previous subscription when its scope changes", () => {
    const { rerender } = renderHook(
      ({ runId }) => useWorkflowLive("project", "session", runId, vi.fn()),
      { initialProps: { runId: "one" as string | null } },
    )
    const first = MockEventSource.instances[0]

    rerender({ runId: "two" })

    expect(first.closed).toBe(true)
    expect(MockEventSource.instances[1].url).toBe("/api/workflow-watch/project/session/two")
  })
})
