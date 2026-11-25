import { useEffect, useRef } from "react"
import { WheelGestures, type WheelEventState } from "wheel-gestures"

export interface SwipeHandlers {
  /** The element a swipe has to start in: the machine on screen. */
  surface: () => HTMLElement | null
  /** A sideways swipe began; offsets that follow count from here. */
  onStart: () => void
  /** The fingers have moved the pane `offset` px since the swipe began (negative: left). */
  onMove: (offset: number) => void
  /** The fingers left the trackpad, moving at `velocity` px/ms, headed for `projected`. */
  onRelease: (offset: number, velocity: number, projected: number) => void
}

/** Movement before a gesture is read as sideways or not. */
const INTENT_DISTANCE = 8
/** How much more sideways than vertical a gesture has to be. */
const SIDEWAYS_RATIO = 1.5
/** After a release, the wheel stays this long quiet before a new swipe can start: momentum is not a swipe. */
const QUIET_AFTER_RELEASE_MS = 300

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

/** "quiet": a gesture that began while a released swipe's momentum still ran. */
type Phase = "idle" | "deciding" | "swiping" | "released" | "ignored" | "quiet"

/**
 * A two-finger sideways swipe (or any horizontal scroll) that starts where
 * nothing scrolls sideways moves the machine on screen with the fingers; the
 * release decides where it lands. wheel-gestures tells the fingers lifting
 * from the trackpad's momentum that follows, so one swipe is one move.
 */
export function useDeviceSwipe(enabled: boolean, handlers: SwipeHandlers): void {
  const latest = useRef(handlers)
  latest.current = handlers

  useEffect(() => {
    if (!enabled) return
    const gestures = WheelGestures({ preventWheelAction: false, reverseSign: [true, true, false] })
    let phase: Phase = "idle"
    let startTarget: Element | null = null
    let quietUntil = 0

    const off = gestures.on("wheel", (state: WheelEventState) => {
      if (state.isStart) {
        // The library may end a swipe on a gap in its momentum and start the
        // next gesture with the same event, so the quiet window is checked here too.
        phase = performance.now() < quietUntil ? "quiet" : "deciding"
      }
      if (phase === "deciding") {
        const [x, y] = state.axisMovement
        if (Math.abs(x) + Math.abs(y) < INTENT_DISTANCE) return
        const surface = latest.current.surface()
        const sideways = Math.abs(x) > Math.abs(y) * SIDEWAYS_RATIO
        phase = sideways && surface && startTarget && surface.contains(startTarget) && !claimsSidewaysWheel(startTarget, surface)
          ? "swiping"
          : "ignored"
        if (phase === "swiping") latest.current.onStart()
      }
      if (phase === "swiping") {
        // wheel-gestures reverses the deltas' sign, so movement already follows the content.
        const offset = state.axisMovement[0]
        if (state.isMomentum || state.isEnding) {
          phase = "released"
          latest.current.onRelease(offset, state.axisVelocity[0], state.axisMovementProjection[0])
        } else {
          latest.current.onMove(offset)
        }
      }
      if (state.isEnding) {
        if (phase === "released" || phase === "quiet") quietUntil = performance.now() + QUIET_AFTER_RELEASE_MS
        phase = "idle"
      }
    })

    const onWheel = (event: WheelEvent) => {
      // Pinch-zoom arrives as ctrl+wheel and a mouse's sideways scroll as
      // shift+wheel; neither is a swipe between machines.
      if (event.ctrlKey || event.shiftKey || event.metaKey) return
      // The tail of a released swipe's momentum, after the library ended it on a gap.
      const now = performance.now()
      if (phase === "idle" && now < quietUntil) {
        quietUntil = now + QUIET_AFTER_RELEASE_MS
        return
      }
      if (phase === "idle") startTarget = event.target instanceof Element ? event.target : null
      gestures.feedWheel(event)
    }
    window.addEventListener("wheel", onWheel, { passive: true })
    // Without this a browser tab reads the same swipe as Back or Forward.
    const root = document.documentElement
    const overscroll = root.style.overscrollBehaviorX
    root.style.overscrollBehaviorX = "none"
    return () => {
      window.removeEventListener("wheel", onWheel)
      root.style.overscrollBehaviorX = overscroll
      off()
      gestures.disconnect()
    }
  }, [enabled])
}
