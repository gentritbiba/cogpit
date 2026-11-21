import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { LeakIndicator } from "@/components/LeakIndicator"
import type { SystemProcessMetric } from "../../../shared/contracts/performance"

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
    const { container } = render(<LeakIndicator onReview={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
    expect(mocks.useLeakMonitor).toHaveBeenCalled()
  })

  it("opens process review without killing flagged processes", async () => {
    const value = hookValue({ leaks: [LEAK, { ...LEAK, pid: 43 }] })
    mocks.useLeakMonitor.mockReturnValue(value)
    const user = userEvent.setup()

    const review = vi.fn()
    render(<LeakIndicator onReview={review} />)
    const button = screen.getByRole("button", { name: "Review 2 flagged processes" })
    expect(button).toHaveTextContent("2")

    await user.click(button)
    expect(review).toHaveBeenCalledOnce()
  })

  it("stays as a quiet icon without a count for a cool-down after the last leak clears", () => {
    vi.useFakeTimers()
    mocks.useLeakMonitor.mockReturnValue(hookValue({ leaks: [LEAK] }))
    const { container, rerender } = render(<LeakIndicator onReview={vi.fn()} />)

    mocks.useLeakMonitor.mockReturnValue(hookValue())
    rerender(<LeakIndicator onReview={vi.fn()} />)

    expect(screen.getByRole("button", { name: /Leak monitor/ })).toHaveTextContent("")

    act(() => void vi.advanceTimersByTime(60_000))

    expect(container).toBeEmptyDOMElement()
  })
})
