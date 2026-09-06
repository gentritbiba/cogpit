/**
 * Geometry between the panel's canvas and the page the screencast shows.
 * Everything here is pure so the viewport component only has to decide *when*
 * to map a point, never *how*.
 */

export interface FitRect {
  /** Offset of the image inside the canvas, in CSS pixels. */
  x: number
  y: number
  width: number
  height: number
  /** CSS pixels drawn per page pixel; 0 when there is nothing to draw. */
  scale: number
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface DevicePoint {
  x: number
  y: number
}

export interface DevicePointOptions {
  /** Keep points outside the image by pinning them to its edge. */
  clamp?: boolean
}

const EMPTY_FIT: FitRect = { x: 0, y: 0, width: 0, height: 0, scale: 0 }

/**
 * Letterbox the page inside the container: aspect ratio preserved, centred,
 * and never blown up past 1:1 — a small page renders crisp rather than blurry.
 * Offsets are whole pixels so a 1:1 image lands on the pixel grid.
 */
export function fitRect(
  container: { width: number; height: number },
  device: { width: number; height: number },
): FitRect {
  if (container.width <= 0 || container.height <= 0 || device.width <= 0 || device.height <= 0) {
    return EMPTY_FIT
  }
  const scale = Math.min(1, container.width / device.width, container.height / device.height)
  const width = device.width * scale
  const height = device.height * scale
  return {
    x: Math.round((container.width - width) / 2),
    y: Math.round((container.height - height) / 2),
    width,
    height,
    scale,
  }
}

/**
 * Client coordinates to the page's own CSS pixels, which is what
 * `Input.dispatchMouseEvent` takes. Outside the image the answer is `null`, so
 * a click the page could never have received is never sent; a drag passes
 * `clamp` instead, so leaving the image pins the pointer to the edge rather
 * than dropping the gesture.
 */
export function toDevicePoint(
  clientX: number,
  clientY: number,
  canvasRect: Rect,
  fit: FitRect,
  options: DevicePointOptions = {},
): DevicePoint | null {
  if (fit.scale <= 0 || fit.width <= 0 || fit.height <= 0) return null
  const x = clientX - canvasRect.left - fit.x
  const y = clientY - canvasRect.top - fit.y
  const inside = x >= 0 && y >= 0 && x <= fit.width && y <= fit.height
  if (!inside && !options.clamp) return null
  return {
    x: clampTo(x / fit.scale, fit.width / fit.scale),
    y: clampTo(y / fit.scale, fit.height / fit.scale),
  }
}

function clampTo(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max)
}

const ALT = 1
const CTRL = 2
const META = 4
const SHIFT = 8

/** CDP's modifier bits, which are not the order the DOM lists them in. */
export function cdpModifiers(event: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): number {
  return (event.altKey ? ALT : 0)
    | (event.ctrlKey ? CTRL : 0)
    | (event.metaKey ? META : 0)
    | (event.shiftKey ? SHIFT : 0)
}

const BUTTON_NAMES = ["left", "middle", "right"] as const

/** `PointerEvent.button` to the protocol's name; anything else reads as left. */
export function cdpButton(button: number): "left" | "middle" | "right" {
  return BUTTON_NAMES[button] ?? "left"
}
