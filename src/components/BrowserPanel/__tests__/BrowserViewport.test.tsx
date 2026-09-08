import { useLayoutEffect, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { BrowserViewport } from "@/components/BrowserPanel/BrowserViewport"
import type { BrowserFrame } from "@/hooks/useBrowserSocket"
import type { BrowserClientMessage } from "../../../../shared/browser/protocol"

const CONTAINER = { left: 50, top: 20, width: 800, height: 600 }

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this)
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  emit(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

/** A stand-in bitmap that remembers being closed, the way a real one refuses to paint. */
function bitmapOf(width = 1600, height = 1200) {
  const bitmap = { width, height, closed: false, close: vi.fn(() => { bitmap.closed = true }) }
  return bitmap
}

type FakeBitmap = ReturnType<typeof bitmapOf>

/** Device pixels are twice the canvas, so a mapped point is never accidentally 1:1. */
function frameOf(deviceWidth = 1600, deviceHeight = 1200, bitmap: ImageBitmap | null = null): BrowserFrame {
  return {
    bitmap,
    blobUrl: bitmap ? null : "blob:frame",
    header: {
      deviceWidth,
      deviceHeight,
      pageScaleFactor: 1,
      offsetTop: 0,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      targetId: "target-1",
      ts: 1,
    },
  }
}

/** Every image the canvas was asked to paint, and whether it was already closed. */
const painted: { image: unknown; closed: boolean }[] = []

/** jsdom has no 2d context, so the paint tests watch these calls instead of pixels. */
function stubDrawContext() {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn((image: unknown) => {
      painted.push({ image, closed: (image as FakeBitmap | null)?.closed === true })
    }),
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D)
  return context
}

function setup(props: Partial<Parameters<typeof BrowserViewport>[0]> = {}) {
  const send = vi.fn<(message: BrowserClientMessage) => void>()
  const onSizeChange = vi.fn()
  const { unmount } = render(
    <BrowserViewport
      frame={props.frame === undefined ? frameOf() : props.frame}
      send={props.send ?? send}
      onSizeChange={props.onSizeChange ?? onSizeChange}
    />,
  )
  const canvas = screen.getByRole("application", { name: "Browser viewport" }) as HTMLCanvasElement
  return { canvas, send, onSizeChange, unmount }
}

/**
 * Frames arrive faster than React paints them: this swaps to `frames[2]` from a
 * layout effect, so `frames[1]` is committed with its draw effect still pending
 * — where a screencast message falls when the paint is scheduled but not run.
 */
function SwapDuringCommit({ frames, next }: { frames: BrowserFrame[]; next: boolean }) {
  const [swapped, setSwapped] = useState(false)
  useLayoutEffect(() => {
    if (next && !swapped) setSwapped(true)
  }, [next, swapped])
  return (
    <BrowserViewport
      frame={frames[swapped ? 2 : next ? 1 : 0]}
      send={vi.fn()}
      onSizeChange={vi.fn()}
    />
  )
}

/** jsdom builds no clipboard data of its own, so the paste carries its own. */
function pasteEvent(text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } })
  return event
}

function settle(ms = 200): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe("BrowserViewport", () => {
  let context: ReturnType<typeof stubDrawContext>

  beforeEach(() => {
    vi.useFakeTimers()
    painted.length = 0
    context = stubDrawContext()
    MockResizeObserver.instances = []
    vi.stubGlobal("ResizeObserver", MockResizeObserver)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ ...CONTAINER, right: 850, bottom: 620, x: 50, y: 20, toJSON: () => ({}) })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("reports its size once on mount", () => {
    const { onSizeChange } = setup()
    expect(onSizeChange).not.toHaveBeenCalled()
    settle()
    expect(onSizeChange).toHaveBeenCalledTimes(1)
    expect(onSizeChange).toHaveBeenCalledWith(800, 600, 1)
  })

  it("coalesces a burst of resizes into one report", () => {
    const { onSizeChange } = setup()
    act(() => {
      vi.advanceTimersByTime(100)
      MockResizeObserver.instances[0].emit()
      vi.advanceTimersByTime(100)
      MockResizeObserver.instances[0].emit()
    })
    expect(onSizeChange).not.toHaveBeenCalled()
    settle()
    expect(onSizeChange).toHaveBeenCalledTimes(1)
  })

  it("passes the device pixel ratio through to the screencast size", () => {
    const original = window.devicePixelRatio
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true })
    const { onSizeChange } = setup()
    settle()
    expect(onSizeChange).toHaveBeenCalledWith(800, 600, 2)
    Object.defineProperty(window, "devicePixelRatio", { value: original, configurable: true })
  })

  it("focuses the canvas and sends a scaled mouse down", () => {
    const { canvas, send } = setup()
    const capture = vi.spyOn(canvas, "setPointerCapture")

    fireEvent.pointerDown(canvas, { clientX: 450, clientY: 320, button: 0, pointerId: 3 })

    expect(canvas).toHaveFocus()
    expect(capture).toHaveBeenCalledWith(3)
    expect(send).toHaveBeenCalledWith({
      type: "mouse",
      event: "down",
      x: 800,
      y: 600,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    })
  })

  it("counts a rapid second click as a double click", () => {
    const { canvas, send } = setup()
    fireEvent.pointerDown(canvas, { clientX: 450, clientY: 320, button: 0, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 450, clientY: 320, button: 0, pointerId: 1 })
    send.mockClear()

    fireEvent.pointerDown(canvas, { clientX: 452, clientY: 321, button: 0, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 452, clientY: 321, button: 0, pointerId: 1 })

    expect(send.mock.calls.map(([message]) => (message as { clickCount: number }).clickCount)).toEqual([2, 2])
  })

  it("starts a new click run after a pause or a move away", () => {
    const { canvas, send } = setup()
    fireEvent.pointerDown(canvas, { clientX: 450, clientY: 320, button: 0, pointerId: 1 })
    settle(600)
    send.mockClear()
    fireEvent.pointerDown(canvas, { clientX: 450, clientY: 320, button: 0, pointerId: 1 })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ clickCount: 1 }))

    send.mockClear()
    fireEvent.pointerDown(canvas, { clientX: 250, clientY: 320, button: 0, pointerId: 1 })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ clickCount: 1 }))
  })

  it("throttles a drag to one move per frame and clamps past the edge", () => {
    const { canvas, send } = setup()
    fireEvent.pointerDown(canvas, { clientX: 450, clientY: 320, button: 0, pointerId: 3 })
    send.mockClear()

    fireEvent.pointerMove(canvas, { clientX: 250, clientY: 120, pointerId: 3 })
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 120, pointerId: 3 })
    expect(send).not.toHaveBeenCalled()

    settle(20)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: "mouse",
      event: "move",
      x: 200,
      y: 200,
      button: "none",
      clickCount: 0,
      modifiers: 0,
    })

    send.mockClear()
    fireEvent.pointerMove(canvas, { clientX: -500, clientY: 320, pointerId: 3 })
    settle(20)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ event: "move", x: 0, y: 600 }))
  })

  it("flushes a pending move before the mouse up so the page sees them in order", () => {
    const { canvas, send } = setup()
    const release = vi.spyOn(canvas, "releasePointerCapture")
    fireEvent.pointerDown(canvas, { clientX: 450, clientY: 320, button: 0, pointerId: 3 })
    send.mockClear()

    fireEvent.pointerMove(canvas, { clientX: 250, clientY: 120, pointerId: 3 })
    fireEvent.pointerUp(canvas, { clientX: 250, clientY: 120, button: 0, pointerId: 3 })

    expect(send.mock.calls.map(([message]) => (message as { event: string }).event)).toEqual(["move", "up"])
    expect(release).toHaveBeenCalledWith(3)
    settle(20)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("drops a hover outside the image instead of clamping it", () => {
    const { canvas, send } = setup()
    fireEvent.pointerMove(canvas, { clientX: 10, clientY: 10, pointerId: 3 })
    settle(20)
    expect(send).not.toHaveBeenCalled()
  })

  it("keeps the page scrolling instead of the panel", () => {
    const { canvas, send } = setup()
    const wheel = createEvent.wheel(canvas, { clientX: 450, clientY: 320, deltaX: 12, deltaY: -48 })
    fireEvent(canvas, wheel)

    expect(wheel.defaultPrevented).toBe(true)
    expect(send).toHaveBeenCalledWith({
      type: "wheel",
      x: 800,
      y: 600,
      deltaX: 12,
      deltaY: -48,
      modifiers: 0,
    })
  })

  it("converts line-mode wheel deltas to pixels", () => {
    const { canvas, send } = setup()
    fireEvent.wheel(canvas, { clientX: 450, clientY: 320, deltaX: 0, deltaY: 3, deltaMode: 1 })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "wheel", deltaY: 48 }))
  })

  it("sends a right click pair instead of opening the panel's own menu", () => {
    const { canvas, send } = setup()
    fireEvent.pointerDown(canvas, { clientX: 450, clientY: 320, button: 2, pointerId: 3 })
    expect(send).not.toHaveBeenCalled()

    const menu = createEvent.contextMenu(canvas, { clientX: 450, clientY: 320 })
    fireEvent(canvas, menu)

    expect(menu.defaultPrevented).toBe(true)
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "mouse", event: "down", x: 800, y: 600, button: "right", clickCount: 1, modifiers: 0 },
      { type: "mouse", event: "up", x: 800, y: 600, button: "right", clickCount: 1, modifiers: 0 },
    ])
  })

  it("types a printable character with its text", () => {
    const { canvas, send } = setup()
    act(() => canvas.focus())
    const down = createEvent.keyDown(canvas, { key: "a", code: "KeyA" })
    fireEvent(canvas, down)
    fireEvent.keyUp(canvas, { key: "a", code: "KeyA" })

    expect(down.defaultPrevented).toBe(true)
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "key", event: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 },
      { type: "key", event: "up", key: "a", code: "KeyA", modifiers: 0 },
    ])
  })

  it("sends Enter as a carriage return so forms submit", () => {
    const { canvas, send } = setup()
    fireEvent.keyDown(canvas, { key: "Enter", code: "Enter" })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter", text: "\r" }))
  })

  it("sends a shortcut as modifiers without text", () => {
    const { canvas, send } = setup()
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA", ctrlKey: true })
    expect(send).toHaveBeenCalledWith({
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      modifiers: 2,
    })
  })

  it("carries a paste across as text while the canvas has focus", () => {
    const { canvas, send } = setup()
    act(() => canvas.focus())
    const paste = pasteEvent("from the clipboard")
    act(() => { document.dispatchEvent(paste) })

    expect(paste.defaultPrevented).toBe(true)
    expect(send).toHaveBeenCalledWith({ type: "paste", text: "from the clipboard" })
  })

  it("leaves a paste alone once the canvas is blurred, or when it carries no text", () => {
    const { canvas, send } = setup()
    act(() => canvas.focus())
    const empty = pasteEvent("")
    act(() => { document.dispatchEvent(empty) })
    act(() => canvas.blur())
    const blurred = pasteEvent("for something else")
    act(() => { document.dispatchEvent(blurred) })

    expect(empty.defaultPrevented).toBe(false)
    expect(blurred.defaultPrevented).toBe(false)
    expect(send.mock.calls.filter(([message]) => message.type === "paste")).toEqual([])
  })

  it("keeps Tab inside the page", () => {
    const { canvas, send } = setup()
    const tab = createEvent.keyDown(canvas, { key: "Tab", code: "Tab" })
    fireEvent(canvas, tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: "Tab" }))
  })

  it("lets the host keep its own reload and devtools shortcuts", () => {
    const { canvas } = setup()
    const reload = createEvent.keyDown(canvas, { key: "r", code: "KeyR", metaKey: true })
    fireEvent(canvas, reload)
    const devtools = createEvent.keyDown(canvas, { key: "F12", code: "F12" })
    fireEvent(canvas, devtools)

    expect(reload.defaultPrevented).toBe(false)
    expect(devtools.defaultPrevented).toBe(false)
  })

  it("releases the keyboard on Escape without sending it", () => {
    const { canvas, send } = setup()
    act(() => canvas.focus())
    expect(screen.getByText("Keyboard captured · Esc to release")).toBeInTheDocument()

    fireEvent.keyDown(canvas, { key: "Escape", code: "Escape" })

    expect(canvas).not.toHaveFocus()
    expect(send).not.toHaveBeenCalled()
    expect(screen.queryByText("Keyboard captured · Esc to release")).not.toBeInTheDocument()
  })

  it("hides the keyboard hint until the viewport is focused", () => {
    setup()
    expect(screen.queryByText("Keyboard captured · Esc to release")).not.toBeInTheDocument()
  })

  it("ignores keys pressed elsewhere in the app", () => {
    const { send } = setup()
    fireEvent.keyDown(document.body, { key: "a", code: "KeyA" })
    expect(send).not.toHaveBeenCalled()
  })

  it("releases every key still down when focus leaves the page", () => {
    const { canvas, send } = setup()
    act(() => canvas.focus())
    fireEvent.keyDown(canvas, { key: "Meta", code: "MetaLeft", metaKey: true })
    fireEvent.keyDown(canvas, { key: "r", code: "KeyR", metaKey: true })
    send.mockClear()

    act(() => canvas.blur())

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "key", event: "up", key: "Meta", code: "MetaLeft", modifiers: 0 },
      { type: "key", event: "up", key: "r", code: "KeyR", modifiers: 0 },
    ])
  })

  it("hands the keyboard back on Escape without leaving a modifier down", () => {
    const { canvas, send } = setup()
    act(() => canvas.focus())
    fireEvent.keyDown(canvas, { key: "Control", code: "ControlLeft", ctrlKey: true })
    send.mockClear()

    fireEvent.keyDown(canvas, { key: "Escape", code: "Escape" })

    expect(canvas).not.toHaveFocus()
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: "key", event: "up", key: "Control", code: "ControlLeft", modifiers: 0 },
    ])
  })

  it("releases a key the page saw go up only once", () => {
    const { canvas, send } = setup()
    act(() => canvas.focus())
    fireEvent.keyDown(canvas, { key: "Shift", code: "ShiftLeft", shiftKey: true })
    fireEvent.keyUp(canvas, { key: "Shift", code: "ShiftLeft" })
    send.mockClear()

    act(() => canvas.blur())

    expect(send).not.toHaveBeenCalled()
  })

  it("releases what is still held when the viewport goes away", () => {
    const { canvas, send, unmount } = setup()
    act(() => canvas.focus())
    fireEvent.keyDown(canvas, { key: "Meta", code: "MetaLeft", metaKey: true })
    send.mockClear()

    unmount()

    expect(send).toHaveBeenCalledWith({
      type: "key", event: "up", key: "Meta", code: "MetaLeft", modifiers: 0,
    })
  })

  it("paints the frame letterboxed after clearing the surface", () => {
    const bitmap = bitmapOf()
    setup({ frame: frameOf(1600, 1200, bitmap as unknown as ImageBitmap) })

    expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 800, 600)
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 800, 600)
  })

  it("centres a page smaller than the panel at 1:1", () => {
    const bitmap = bitmapOf(400, 300)
    setup({ frame: frameOf(400, 300, bitmap as unknown as ImageBitmap) })
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 200, 150, 400, 300)
  })

  it("clears the surface rather than leaving the last session's pixels", () => {
    setup({ frame: null })
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 800, 600)
    expect(context.drawImage).not.toHaveBeenCalled()
  })

  it("frees a frame once it is off screen, and never before", () => {
    const first = bitmapOf()
    const second = bitmapOf()
    const send = vi.fn()
    const onSizeChange = vi.fn()
    const view = (bitmap: FakeBitmap) => (
      <BrowserViewport
        frame={frameOf(1600, 1200, bitmap as unknown as ImageBitmap)}
        send={send}
        onSizeChange={onSizeChange}
      />
    )
    const { rerender, unmount } = render(view(first))
    expect(first.close).not.toHaveBeenCalled()

    rerender(view(second))
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()

    unmount()
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it("keeps the pending frame open when the next one lands before its paint", () => {
    const [shown, pending, next] = [bitmapOf(), bitmapOf(), bitmapOf()]
    const frames = [shown, pending, next].map(
      (bitmap) => frameOf(1600, 1200, bitmap as unknown as ImageBitmap),
    )
    const { rerender } = render(<SwapDuringCommit frames={frames} next={false} />)

    expect(() => {
      act(() => rerender(<SwapDuringCommit frames={frames} next />))
    }).not.toThrow()

    expect(painted.map((call) => call.image)).toEqual([shown, pending, next])
    expect(painted.filter((call) => call.closed)).toEqual([])
    expect(pending.close).toHaveBeenCalledTimes(1)
    expect(next.close).not.toHaveBeenCalled()
  })

  it("skips a frame closed by another path instead of taking the panel down", () => {
    const bitmap = bitmapOf()
    bitmap.close()
    context.drawImage.mockImplementationOnce(() => {
      throw new DOMException("The ImageBitmap has been detached", "InvalidStateError")
    })

    expect(() => setup({ frame: frameOf(1600, 1200, bitmap as unknown as ImageBitmap) })).not.toThrow()
  })
})
