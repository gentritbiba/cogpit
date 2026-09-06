import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { cn } from "@/lib/utils"
import { releaseFrame, type BrowserFrame } from "@/hooks/useBrowserSocket"
import type { BrowserClientMessage } from "../../../shared/browser/protocol"
import { cdpButton, cdpModifiers, fitRect, toDevicePoint, type DevicePoint } from "./pointerMath"

/**
 * The live surface: it paints each screencast frame once, on receipt, and maps
 * every pointer and key back into the page's own coordinates. A frame the
 * socket hands over belongs here until it is replaced, because the paint
 * happens an effect later than the hand-over and a closed bitmap throws.
 */

type KeyMessage = Extract<BrowserClientMessage, { type: "key" }>

interface BrowserViewportProps {
  frame: BrowserFrame | null
  send: (message: BrowserClientMessage) => void
  onSizeChange: (width: number, height: number, dpr: number) => void
  className?: string
}

interface Size {
  width: number
  height: number
  dpr: number
}

interface PendingMove {
  clientX: number
  clientY: number
  modifiers: number
}

/** Pointer events always report `detail: 0`, so the page's click count is counted here. */
interface ClickRun {
  count: number
  at: number
  x: number
  y: number
  button: number
}

const RESIZE_DEBOUNCE_MS = 150
const RIGHT_BUTTON = 2
const CLICK_INTERVAL_MS = 500
const CLICK_SLOP_PX = 5
const DELTA_LINE = 1
const DELTA_PAGE = 2
const LINE_HEIGHT_PX = 16
const KEYBOARD_HINT = "Keyboard captured · Esc to release"

/** Left to the host so the panel can never trap the user inside the page. */
const HOST_KEYS = new Set(["F5", "F11", "F12"])
const DEVTOOLS_KEYS = new Set(["i", "j", "c"])

function isHostShortcut(event: ReactKeyboardEvent): boolean {
  if (HOST_KEYS.has(event.key)) return true
  if (event.metaKey) return true
  return event.ctrlKey && event.shiftKey && DEVTOOLS_KEYS.has(event.key.toLowerCase())
}

/** Blink inserts text from `text`, and submits a form on the carriage return. */
function keyText(event: ReactKeyboardEvent): string | undefined {
  if (event.ctrlKey || event.metaKey) return undefined
  if (event.key.length === 1) return event.key
  return event.key === "Enter" ? "\r" : undefined
}

function wheelPixels(delta: number, mode: number, pageSize: number): number {
  if (mode === DELTA_LINE) return delta * LINE_HEIGHT_PX
  if (mode === DELTA_PAGE) return delta * pageSize
  return delta
}

/** A frame closed by another path would throw here and take the panel down with it. */
function paint(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  fit: { x: number; y: number; width: number; height: number },
): void {
  try {
    context.drawImage(image, fit.x, fit.y, fit.width, fit.height)
  } catch {
    // A closed bitmap costs one frame; the next one paints.
  }
}

export function BrowserViewport({ frame, send, onSizeChange, className }: BrowserViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pendingMove = useRef<PendingMove | null>(null)
  const moveFrame = useRef<number | null>(null)
  const dragging = useRef(false)
  const clickRun = useRef<ClickRun>({ count: 0, at: 0, x: 0, y: 0, button: -1 })
  /** Codes currently down in the page, so nothing stays held once focus leaves. */
  const heldKeys = useRef(new Map<string, string>())
  const [size, setSize] = useState<Size>({ width: 0, height: 0, dpr: 1 })
  const [focused, setFocused] = useState(false)

  const deviceWidth = frame ? frame.header.deviceWidth : 0
  const deviceHeight = frame ? frame.header.deviceHeight : 0
  const fit = useMemo(
    () => fitRect(size, { width: deviceWidth, height: deviceHeight }),
    [size, deviceWidth, deviceHeight],
  )

  const onSizeChangeRef = useRef(onSizeChange)
  useEffect(() => {
    onSizeChangeRef.current = onSizeChange
  }, [onSizeChange])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let timer: ReturnType<typeof setTimeout> | null = null

    const measure = () => {
      const rect = container.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      const dpr = window.devicePixelRatio || 1
      setSize((previous) => (
        previous.width === width && previous.height === height && previous.dpr === dpr
          ? previous
          : { width, height, dpr }
      ))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (width > 0 && height > 0) onSizeChangeRef.current(width, height, dpr)
      }, RESIZE_DEBOUNCE_MS)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return

    const backingWidth = Math.round(size.width * size.dpr)
    const backingHeight = Math.round(size.height * size.dpr)
    if (canvas.width !== backingWidth) canvas.width = backingWidth
    if (canvas.height !== backingHeight) canvas.height = backingHeight
    context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
    context.clearRect(0, 0, size.width, size.height)

    if (!frame || fit.width <= 0 || fit.height <= 0) return
    if (frame.bitmap) {
      paint(context, frame.bitmap, fit)
      return
    }
    if (!frame.blobUrl) return
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled) paint(context, image, fit)
    }
    image.src = frame.blobUrl
    return () => {
      cancelled = true
    }
  }, [frame, fit, size])

  // The hook stops owning a frame the moment it hands it over, so the frame on
  // screen is freed here — after the paint above, and never while one pends.
  useEffect(() => () => releaseFrame(frame), [frame])

  function pointAt(clientX: number, clientY: number, clamp: boolean): DevicePoint | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    return toDevicePoint(clientX, clientY, canvas.getBoundingClientRect(), fit, { clamp })
  }

  function sendMouse(
    event: "move" | "down" | "up",
    point: DevicePoint,
    button: "left" | "middle" | "right" | "none",
    clickCount: number,
    modifiers: number,
  ): void {
    send({ type: "mouse", event, x: point.x, y: point.y, button, clickCount, modifiers })
  }

  function nextClickCount(event: ReactPointerEvent<HTMLCanvasElement>): number {
    const run = clickRun.current
    const now = Date.now()
    const repeated = event.button === run.button
      && now - run.at < CLICK_INTERVAL_MS
      && Math.abs(event.clientX - run.x) <= CLICK_SLOP_PX
      && Math.abs(event.clientY - run.y) <= CLICK_SLOP_PX
    clickRun.current = {
      count: repeated ? run.count + 1 : 1,
      at: now,
      x: event.clientX,
      y: event.clientY,
      button: event.button,
    }
    return clickRun.current.count
  }

  function emitMove(): void {
    const pending = pendingMove.current
    pendingMove.current = null
    if (!pending) return
    const point = pointAt(pending.clientX, pending.clientY, dragging.current)
    if (point) sendMouse("move", point, "none", 0, pending.modifiers)
  }

  function flushMove(): void {
    if (moveFrame.current !== null) {
      cancelAnimationFrame(moveFrame.current)
      moveFrame.current = null
    }
    emitMove()
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    event.currentTarget.focus()
    // The context menu event owns the right button, so it is not doubled here.
    if (event.button === RIGHT_BUTTON) return
    const point = pointAt(event.clientX, event.clientY, false)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = true
    sendMouse("down", point, cdpButton(event.button), nextClickCount(event), cdpModifiers(event))
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    pendingMove.current = { clientX: event.clientX, clientY: event.clientY, modifiers: cdpModifiers(event) }
    if (moveFrame.current !== null) return
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null
      emitMove()
    })
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    flushMove()
    const wasDragging = dragging.current
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (event.button === RIGHT_BUTTON) return
    const point = pointAt(event.clientX, event.clientY, wasDragging)
    if (point) sendMouse("up", point, cdpButton(event.button), clickRun.current.count, cdpModifiers(event))
  }

  function handleContextMenu(event: ReactMouseEvent<HTMLCanvasElement>): void {
    event.preventDefault()
    const point = pointAt(event.clientX, event.clientY, false)
    if (!point) return
    const modifiers = cdpModifiers(event)
    sendMouse("down", point, "right", 1, modifiers)
    sendMouse("up", point, "right", 1, modifiers)
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>): void {
    if (event.key === "Escape") {
      // Blurring runs the release below, so nothing stays down in the page.
      event.currentTarget.blur()
      return
    }
    if (!isHostShortcut(event)) event.preventDefault()
    const message: KeyMessage = {
      type: "key",
      event: "down",
      key: event.key,
      code: event.code,
      modifiers: cdpModifiers(event),
    }
    const text = keyText(event)
    if (text !== undefined) message.text = text
    heldKeys.current.set(event.code, event.key)
    send(message)
  }

  function handleKeyUp(event: ReactKeyboardEvent<HTMLCanvasElement>): void {
    if (event.key === "Escape") return
    if (!isHostShortcut(event)) event.preventDefault()
    heldKeys.current.delete(event.code)
    send({ type: "key", event: "up", key: event.key, code: event.code, modifiers: cdpModifiers(event) })
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // React attaches wheel passively at the root, so preventDefault needs a listener of our own.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = toDevicePoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), fit)
      if (!point) return
      send({
        type: "wheel",
        x: point.x,
        y: point.y,
        deltaX: wheelPixels(event.deltaX, event.deltaMode, deviceWidth),
        deltaY: wheelPixels(event.deltaY, event.deltaMode, deviceHeight),
        modifiers: cdpModifiers(event),
      })
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [send, fit, deviceWidth, deviceHeight])

  useEffect(() => () => {
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current)
  }, [])

  // A host shortcut and Escape both leave without a `key up`, and the page's own
  // JS would go on believing the modifier is down, so every release ends here.
  const releaseHeldKeys = useCallback(() => {
    for (const [code, key] of heldKeys.current) {
      send({ type: "key", event: "up", key, code, modifiers: 0 })
    }
    heldKeys.current.clear()
  }, [send])

  useEffect(() => releaseHeldKeys, [releaseHeldKeys])

  return (
    <div
      ref={containerRef}
      className={cn("relative min-h-0 min-w-0 overflow-hidden bg-muted/30", className)}
    >
      <canvas
        ref={canvasRef}
        role="application"
        aria-label="Browser viewport"
        tabIndex={0}
        className={cn(
          "block size-full cursor-default touch-none select-none outline-none",
          focused && "ring-2 ring-ring ring-inset",
        )}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          releaseHeldKeys()
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      />
      {focused && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <span className="rounded-full bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground shadow-xs backdrop-blur-sm">
            {KEYBOARD_HINT}
          </span>
        </div>
      )}
    </div>
  )
}
