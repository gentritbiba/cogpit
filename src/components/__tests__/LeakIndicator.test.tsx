import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { LeakIndicator } from "@/components/LeakIndicator"
import type { SystemProcessMetric } from "@/lib/performanceTypes"

const mocks = vi.hoisted(() => ({ useLeakMonitor: vi.fn() }))

vi.mock("@/hooks/useLeakMonitor", () => ({ useLeakMonitor: mocks.useLeakMonitor }))

const LEAK: SystemProcessMetric = {
  pid: 42,
  kind: "claude",
  label: "claude",
  command: "claude --resume",
  cpuPercent: 30,
  memoryMb: 120,
  ageSeconds: 900,
  orphaned: true,
  suspectedLeak: true,
}

function hookValue(overrides: Record<string, unknown> = {}) {
  return {
    leaks: [] as SystemProcessMetric[],
    killing: false,
    killLeaks: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe("LeakIndicator", () => {
  beforeEach(() => {
    mocks.useLeakMonitor.mockReset()
    mocks.useLeakMonitor.mockReturnValue(hookValue())
  })

  afterEach(() => vi.useRealTimers())

  it("renders nothing while no leaks are flagged, but keeps the monitor running", () => {
    const { container } = render(<LeakIndicator />)

    expect(container).toBeEmptyDOMElement()
    expect(mocks.useLeakMonitor).toHaveBeenCalled()
  })

  it("appears with the leak count and kills every leaked pid on click", async () => {
    const value = hookValue({ leaks: [LEAK, { ...LEAK, pid: 43 }] })
    mocks.useLeakMonitor.mockReturnValue(value)
    const user = userEvent.setup()

    render(<LeakIndicator />)
    const button = screen.getByRole("button", { name: "Kill 2 leaked agent processes" })
    expect(button).toHaveTextContent("2")

    await user.click(button)
    expect(value.killLeaks).toHaveBeenCalledWith([42, 43])
  })

  it("stays pinned at zero for a cool-down after the last leak clears", () => {
    vi.useFakeTimers()
    mocks.useLeakMonitor.mockReturnValue(hookValue({ leaks: [LEAK] }))
    const { container, rerender } = render(<LeakIndicator />)

    mocks.useLeakMonitor.mockReturnValue(hookValue())
    rerender(<LeakIndicator />)

    expect(screen.getByRole("button", { name: /Leak monitor/ })).toHaveTextContent("0")

    act(() => void vi.advanceTimersByTime(60_000))

    expect(container).toBeEmptyDOMElement()
  })
})
