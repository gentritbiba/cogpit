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

  it("paints the last movement before letting go", () => {
    const onMove = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={onMove} onRelease={onRelease} />)
    wheel(getByTestId("text"), [20, 19, 18, 17, 16, 15])
    expect(onRelease).toHaveBeenCalledOnce()
    expect(onMove.mock.calls.at(-1)![0]).toBe(onRelease.mock.calls[0][0])
  })

  it("keeps a steady drag under the fingers", () => {
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={vi.fn()} onRelease={onRelease} />)
    wheel(getByTestId("text"), [12, ...fingers(40, 10)])
    expect(onRelease).not.toHaveBeenCalled()
    vi.advanceTimersByTime(70)
    expect(onRelease.mock.calls[0][0]).toBe(-412)
  })

  it("reads momentum merged into one event by a busy page as momentum, not as a new swipe", () => {
    const onStart = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={vi.fn()} onRelease={vi.fn()} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 27))
    const tail = momentum(27, 30)
    wheel(text, tail.slice(0, 4))
    // Two frames' momentum in one event, then a page busy long enough to merge a dozen more.
    text.dispatchEvent(new WheelEvent("wheel", { deltaX: tail[4] + tail[5], bubbles: true }))
    vi.setSystemTime(Date.now() + 16)
    wheel(text, tail.slice(6, 8))
    vi.setSystemTime(Date.now() + 100)
    text.dispatchEvent(new WheelEvent("wheel", { deltaX: tail.slice(8, 20).reduce((sum, d) => sum + d, 0), bubbles: true }))
    vi.advanceTimersByTime(8)
    wheel(text, tail.slice(20))
    expect(onStart).toHaveBeenCalledOnce()
  })

  it("reads momentum a long-busy page merged into one big event as momentum", () => {
    const onStart = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={vi.fn()} onRelease={vi.fn()} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 24))
    const tail = momentum(24, 60).filter((delta) => delta > 0)
    wheel(text, tail.slice(0, 6))
    // A third of a second blocked: everything momentum moved meanwhile arrives as one event.
    vi.setSystemTime(Date.now() + 340)
    wheel(text, [tail.slice(6, 46).reduce((sum, d) => sum + d, 0)])
    wheel(text, tail.slice(46))
    expect(onStart).toHaveBeenCalledOnce()
  })

  it("keeps a swipe whose events a busy page delayed", () => {
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={vi.fn()} onRelease={onRelease} />)
    const text = getByTestId("text")
    wheel(text, fingers(6))
    // The page was busy: the next event arrives late, before the release timer could run.
    vi.setSystemTime(Date.now() + 100)
    wheel(text, fingers(6))
    vi.advanceTimersByTime(70)
    expect(onRelease).toHaveBeenCalledOnce()
    expect(onRelease.mock.calls[0][0]).toBe(-144)
  })

  it("takes fingers clearly faster than momentum's slowest frame for a new swipe", () => {
    const onStart = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={vi.fn()} onRelease={vi.fn()} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 24))
    wheel(text, momentum(24, 4))
    wheel(text, fingers(4, 24))
    expect(onStart).toHaveBeenCalledTimes(2)
  })

  it("takes momentum that stops shrinking for longer than rounding explains for fingers", () => {
    const onStart = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={vi.fn()} onRelease={vi.fn()} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 24))
    wheel(text, momentum(24, 4))
    wheel(text, fingers(30, 17))
    expect(onStart).toHaveBeenCalledTimes(2)
  })

  it("reads a slow, rounded momentum tail as one swipe from start to finish", () => {
    const onStart = vi.fn()
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={vi.fn()} onRelease={onRelease} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 24))
    const tail: number[] = []
    for (let n = 1, d = 24; d > 0; n++) tail.push(d = Math.round(24 * 0.99 ** n))
    wheel(text, tail)
    vi.advanceTimersByTime(400)
    expect(onStart).toHaveBeenCalledOnce()
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it("lets go of a short flick on momentum from its first frame, at the speed it was thrown", () => {
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={vi.fn()} onRelease={onRelease} />)
    const text = getByTestId("text")
    for (const deltaX of [20, 19, 18, 17, 16]) {
      text.dispatchEvent(new WheelEvent("wheel", { deltaX, bubbles: true }))
      vi.advanceTimersByTime(16)
    }
    expect(onRelease).toHaveBeenCalledOnce()
    const [offset, velocity] = onRelease.mock.calls[0]
    expect(offset).toBe(-90)
    expect(velocity).toBeLessThan(-0.9)
  })

  it("starts a slow second swipe once momentum has died out", () => {
    const onStart = vi.fn()
    const onMove = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={onMove} onRelease={vi.fn()} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 24))
    wheel(text, momentum(24, 60).filter((delta) => delta > 0))
    vi.advanceTimersByTime(150)
    wheel(text, fingers(100, 4))
    expect(onStart).toHaveBeenCalledTimes(2)
    expect(onMove.mock.calls.at(-1)![0]).toBeLessThan(-350)
  })

  it("keeps reading a momentum tail as momentum when one frame arrives early and the next late", () => {
    const onStart = vi.fn()
    const { getByTestId } = render(<Surface onStart={onStart} onMove={vi.fn()} onRelease={vi.fn()} />)
    const text = getByTestId("text")
    wheel(text, fingers(10, 24))
    const tail: number[] = []
    for (let n = 1, d = 24; d > 0; n++) tail.push(d = Math.round(24 * 0.98 ** n))
    tail.forEach((deltaX, i) => {
      text.dispatchEvent(new WheelEvent("wheel", { deltaX, bubbles: true }))
      vi.advanceTimersByTime(i === 12 ? 6 : i === 13 ? 10 : 8)
    })
    expect(onStart).toHaveBeenCalledOnce()
  })

  it("starts a very slow second swipe once momentum has died out, with or without a pause", () => {
    for (const pause of [150, 0]) {
      const onStart = vi.fn()
      const onMove = vi.fn()
      const { getByTestId, unmount } = render(<Surface onStart={onStart} onMove={onMove} onRelease={vi.fn()} />)
      const text = getByTestId("text")
      wheel(text, fingers(10, 24))
      wheel(text, momentum(24, 60).filter((delta) => delta > 0))
      vi.advanceTimersByTime(pause)
      wheel(text, fingers(200, 2))
      expect(onStart).toHaveBeenCalledTimes(2)
      expect(onMove.mock.calls.at(-1)![0]).toBeLessThan(-380)
      unmount()
    }
  })

  it("counts the first frame of a flick thrown a second after the last one", () => {
    const onRelease = vi.fn()
    const { getByTestId } = render(<Surface onMove={vi.fn()} onRelease={onRelease} />)
    const text = getByTestId("text")
    const flick = () => {
      for (const deltaX of [20, 19, 18, 17, 16]) {
        text.dispatchEvent(new WheelEvent("wheel", { deltaX, bubbles: true }))
        vi.advanceTimersByTime(16)
      }
    }
    flick()
    vi.advanceTimersByTime(1000)
    flick()
    expect(onRelease).toHaveBeenCalledTimes(2)
    expect(onRelease.mock.calls[1][0]).toBe(-90)
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
