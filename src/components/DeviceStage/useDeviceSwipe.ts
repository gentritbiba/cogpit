import { useEffect, useRef } from "react"
import { WheelSwipe } from "./wheelSwipe"

export interface SwipeHandlers {
  /** The element a swipe has to start in: where the machines are, not a dialog over them. */
  surface: () => HTMLElement | null
  /** A sideways swipe began; offsets that follow count from here. */
  onStart: () => void
  /** The fingers have moved the pane `offset` px since the swipe began (negative: left). */
  onMove: (offset: number) => void
  /** The fingers let go, moving at `velocity` px/ms, headed for `projected`. */
  onRelease: (offset: number, velocity: number, projected: number) => void
}

/** Content that scrolls, draws or edits under the pointer keeps the wheel for itself. */
const KEEPS_WHEEL = ".xterm, .monaco-editor, .cm-editor, canvas, input[type=range], [data-device-swipe=off]"

/** Whether anything between `node` and `surface` can scroll sideways, or claims the wheel. */
function claimsSidewaysWheel(node: Element | null, surface: Element): boolean {
  for (let element = node; element && element !== surface; element = element.parentElement) {
    if (element.matches(KEEPS_WHEEL)) return true
    if (element.scrollWidth <= element.clientWidth + 1) continue
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true
    const overflowX = getComputedStyle(element).overflowX
    if (overflowX === "auto" || overflowX === "scroll") return true
  }
  return false
}

/** A wheel event's movement in px, content-wise: fingers moving left give a negative x. */
function movement(event: WheelEvent): [number, number] {
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerWidth : 1
  return [-event.deltaX * scale, -event.deltaY * scale]
}

/**
 * A two-finger sideways swipe (or any horizontal scroll) that starts where
 * nothing scrolls sideways moves the machine on screen with the fingers, and
 * the release decides where it lands. WheelSwipe reads the gesture.
 */
export function useDeviceSwipe(enabled: boolean, handlers: SwipeHandlers): void {
  const latest = useRef(handlers)
  latest.current = handlers

  useEffect(() => {
    if (!enabled) return
    const swipe = new WheelSwipe({
      accepts: (target) => {
        const surface = latest.current.surface()
        return target instanceof Element && !!surface && surface.contains(target) && !claimsSidewaysWheel(target, surface)
      },
      start: () => latest.current.onStart(),
      move: (offset) => latest.current.onMove(offset),
      release: (offset, velocity, projected) => latest.current.onRelease(offset, velocity, projected),
    })
    const onWheel = (event: WheelEvent) => {
      // Pinch-zoom arrives as ctrl+wheel and a mouse's sideways scroll as
      // shift+wheel; neither is a swipe between machines.
      if (event.ctrlKey || event.shiftKey || event.metaKey) return
      const [x, y] = movement(event)
      const { momentum } = event as WheelEvent & { momentum?: unknown }
      swipe.wheel({ x, y, time: event.timeStamp, target: event.target, momentum: typeof momentum === "boolean" ? momentum : undefined })
    }
    window.addEventListener("wheel", onWheel, { passive: true })
    // Without this a browser tab reads the same swipe as Back or Forward.
    const root = document.documentElement
    const overscroll = root.style.overscrollBehaviorX
    root.style.overscrollBehaviorX = "none"
    return () => {
      window.removeEventListener("wheel", onWheel)
      root.style.overscrollBehaviorX = overscroll
      swipe.dispose()
    }
  }, [enabled])
}
