import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDeviceSwipe } from "../useDeviceSwipe"

function Surface({ onStart = () => {}, onMove, onRelease, enabled = true }: {
  onStart?: () => void
  onMove: (offset: number) => void
  onRelease: (offset: number, velocity: number, projected: number) => void
  enabled?: boolean
}) {
  useDeviceSwipe(enabled, {
    surface: () => document.querySelector<HTMLElement>("[data-testid=surface]"),
    onStart,
    onMove,
    onRelease,
  })
  return (
    <div data-testid="surface">
      <p data-testid="text">Mission Control</p>
      <pre data-testid="code" style={{ overflowX: "auto" }}>a long line of code</pre>
    </div>
  )
}

/** One wheel event per display frame (8 ms), the way a trackpad sends them. */
function wheel(target: Element, deltas: number[], { dy = 0, ctrlKey = false } = {}) {
  for (const deltaX of deltas) {
    target.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY: dy, deltaMode: 0, ctrlKey, bubbles: true }))
    vi.advanceTimersByTime(8)
  }
}

const fingers = (count: number, delta = 12) => Array.from({ length: count }, () => delta)
/** What a trackpad sends after the fingers lift: the same way, a little less each frame. */
const momentum = (from: number, count: number) => Array.from({ length: count }, (_, i) => Math.round(from * 0.92 ** (i + 1)))

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.documentElement.style.overscrollBehaviorX = ""
})

describe("useDeviceSwipe", () => {
  it("moves the machine with a sideways swipe, and lets go as soon as the fingers go still", () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    wheel(getByTestId("text"), fingers(20))
    // Fingers moving right to left bring in the machine on the right: the pane moves left.
    expect(onMove.mock.calls.at(-1)![0]).toBeLessThan(-200)
    expect(onRelease).not.toHaveBeenCalled()
    vi.advanceTimersByTime(70)
    expect(onRelease).toHaveBeenCalledOnce()
    const [offset, velocity] = onRelease.mock.calls[0]
    expect(offset).toBeLessThan(-200)
    // Fingers that stopped are not throwing anything.
    expect(velocity).toBe(0)
  })

  it("lets go the moment momentum shows, at the speed the fingers lifted, and ignores the rest of it", () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 24))
    wheel(text, momentum(24, 4))
    expect(onRelease).toHaveBeenCalledOnce()
    const [offset, velocity, projected] = onRelease.mock.calls[0]
    expect(velocity).toBeLessThan(-1.5)
    expect(projected).toBeLessThan(offset)
    const moves = onMove.mock.calls.length
    wheel(text, momentum(24, 40).slice(4))
    vi.advanceTimersByTime(200)
    expect(onMove.mock.calls.length).toBe(moves)
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it("starts the next swipe at once when the fingers come back during momentum", () => {
    const onStart = vi.fn()
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={onMove} onRelease={onRelease} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 24))
    wheel(text, momentum(24, 6))
    expect(onRelease).toHaveBeenCalledOnce()
    // Speeding up is fingers, not momentum.
    wheel(text, [6, 10, 14, 18])
    expect(onStart).toHaveBeenCalledTimes(2)
    expect(onMove.mock.calls.at(-1)![0]).toBeLessThan(-8)
  })

  it("starts the next swipe after a pause, wherever the last one was", () => {
    const onStart = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={vi.fn()} onRelease={onRelease} />)
    const text = getByTestId("text")
    wheel(text, fingers(6))
    vi.advanceTimersByTime(100)
    wheel(text, fingers(6, -12))
    expect(onStart).toHaveBeenCalledTimes(2)
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it("leaves the wheel to content that scrolls sideways", () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    const code = getByTestId("code")
    Object.defineProperty(code, "scrollWidth", { value: 800 })
    Object.defineProperty(code, "clientWidth", { value: 200 })
    wheel(code, fingers(20))
    vi.advanceTimersByTime(200)
    expect(onMove).not.toHaveBeenCalled()
    expect(onRelease).not.toHaveBeenCalled()
  })

  it("ignores scrolling up and down, pinch zoom, and anything outside the machine on screen", () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    wheel(getByTestId("text"), fingers(20, 2), { dy: 20 })
    vi.advanceTimersByTime(200)
    wheel(getByTestId("text"), fingers(20), { ctrlKey: true })
    vi.advanceTimersByTime(200)
    wheel(document.body, fingers(20))
    vi.advanceTimersByTime(200)
    expect(onMove).not.toHaveBeenCalled()
    expect(onRelease).not.toHaveBeenCalled()
  })

  it("keeps a browser tab from reading the swipe as Back or Forward only while it listens", () => {
    const { unmount } = render(<Surface onMove={vi.fn()} onRelease={vi.fn()} />)
    expect(document.documentElement.style.overscrollBehaviorX).toBe("none")
    unmount()
    expect(document.documentElement.style.overscrollBehaviorX).toBe("")
  })
})
