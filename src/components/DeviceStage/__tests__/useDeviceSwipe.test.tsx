import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useDeviceSwipe } from "../useDeviceSwipe"

function Surface({ onMove, onRelease, enabled = true }: { onMove: (offset: number) => void; onRelease: (offset: number, velocity: number) => void; enabled?: boolean }) {
  useDeviceSwipe(enabled, {
    surface: () => document.querySelector<HTMLElement>("[data-testid=surface]"),
    onStart: () => {},
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function swipe(target: Element, { dx = 12, dy = 0, steps = 20 } = {}) {
  for (let i = 0; i < steps; i++) {
    target.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, bubbles: true }))
    await wait(8)
  }
  await wait(700)
}

afterEach(() => {
  cleanup()
  document.documentElement.style.overscrollBehaviorX = ""
})

describe("useDeviceSwipe", () => {
  it("moves the machine with a sideways swipe where nothing scrolls sideways, then releases it", async () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    await swipe(getByTestId("text"))
    expect(onMove).toHaveBeenCalled()
    // Fingers moving right to left bring in the machine on the right: the pane moves left.
    expect(onMove.mock.calls.at(-1)![0]).toBeLessThan(0)
    expect(onRelease).toHaveBeenCalledOnce()
    expect(onRelease.mock.calls[0][0]).toBeLessThan(-100)
  })

  it("reads the momentum trailing a released swipe as part of it, not a new swipe", async () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    const text = getByTestId("text")
    for (let i = 0; i < 20; i++) {
      text.dispatchEvent(new WheelEvent("wheel", { deltaX: 12, bubbles: true }))
      await wait(8)
    }
    await vi.waitFor(() => expect(onRelease).toHaveBeenCalledOnce(), { interval: 5 })
    await wait(150)
    const moves = onMove.mock.calls.length
    // Momentum keeps arriving after the library ended the gesture on a gap.
    for (let i = 0; i < 10; i++) {
      text.dispatchEvent(new WheelEvent("wheel", { deltaX: 6, bubbles: true }))
      await wait(8)
    }
    await wait(500)
    expect(onMove.mock.calls.length).toBe(moves)
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it("leaves the wheel to content that scrolls sideways", async () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    const code = getByTestId("code")
    Object.defineProperty(code, "scrollWidth", { value: 800 })
    Object.defineProperty(code, "clientWidth", { value: 200 })
    await swipe(code)
    expect(onMove).not.toHaveBeenCalled()
    expect(onRelease).not.toHaveBeenCalled()
  })

  it("ignores scrolling up and down, pinch zoom, and anything outside the machine on screen", async () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    await swipe(getByTestId("text"), { dx: 2, dy: 20 })
    for (let i = 0; i < 20; i++) {
      getByTestId("text").dispatchEvent(new WheelEvent("wheel", { deltaX: 12, ctrlKey: true, bubbles: true }))
    }
    await wait(700)
    await swipe(document.body)
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
