import { useEffect, useRef } from "react"

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

/** Movement before a gesture is read as sideways or not. */
const INTENT_DISTANCE = 8
/** How much more sideways than vertical a gesture has to be. */
const SIDEWAYS_RATIO = 1.5
/**
 * Fingers that send nothing for this long have stopped or lifted: the swipe
 * is released. A wheel that pauses this long also ends a gesture.
 */
const RELEASE_AFTER_MS = 70
/**
 * The trackpad's momentum after the fingers lift shrinks every event; this
 * many shrinking events in a row, losing at least MOMENTUM_DECAY overall,
 * mean the fingers are off. Fingers that slow down look the same, and are
 * about to stop anyway; if they speed up again, that is a new swipe.
 */
const MOMENTUM_EVENTS = 4
const MOMENTUM_DECAY = 0.95
/** Velocity is measured over the latest movement this long. */
const VELOCITY_WINDOW_MS = 50
/** Where a release is headed: on at its velocity for this long. */
const PROJECTION_MS = 160

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
 * idle: no wheel. deciding: a gesture too short to read yet. swiping: the
 * machine follows the fingers. coasting: the momentum after a release, which
 * moves nothing. ignored: a gesture that is not a swipe between machines.
 */
type Phase = "idle" | "deciding" | "swiping" | "coasting" | "ignored"

/**
 * A two-finger sideways swipe (or any horizontal scroll) that starts where
 * nothing scrolls sideways moves the machine on screen with the fingers, and
 * the release decides where it lands. The browser does not say when fingers
 * leave a trackpad, so a release is the fingers going still or the momentum
 * that follows a lift. Momentum only ever slows down: anything that speeds up
 * again is fingers back on the trackpad, and starts the next swipe at once.
 */
export function useDeviceSwipe(enabled: boolean, handlers: SwipeHandlers): void {
  const latest = useRef(handlers)
  latest.current = handlers

  useEffect(() => {
    if (!enabled) return
    let phase: Phase = "idle"
    let startTarget: Element | null = null
    let moved: [number, number] = [0, 0]
    let lastTime = 0
    let lastSize = 0
    let lastX = 0
    let shrinking = 0
    let shrinkFrom = 0
    let samples: { time: number; x: number }[] = []
    let releaseTimer: ReturnType<typeof setTimeout> | null = null

    const velocity = () => {
      if (samples.length < 2) return 0
      const span = samples[samples.length - 1].time - samples[0].time
      if (span <= 0) return 0
      return samples.slice(1).reduce((sum, sample) => sum + sample.x, 0) / span
    }

    const release = (moving: boolean) => {
      if (releaseTimer) clearTimeout(releaseTimer)
      releaseTimer = null
      phase = "coasting"
      // Fingers that went still are not moving; momentum carries the speed they lifted at.
      const speed = moving ? velocity() : 0
      latest.current.onRelease(moved[0], speed, moved[0] + speed * PROJECTION_MS)
    }

    const begin = (event: WheelEvent) => {
      // A paused swipe whose release timer ran late still lets go first.
      if (phase === "swiping") release(false)
      phase = "deciding"
      startTarget = event.target instanceof Element ? event.target : null
      moved = [0, 0]
      shrinking = 0
      samples = []
    }

    const onWheel = (event: WheelEvent) => {
      // Pinch-zoom arrives as ctrl+wheel and a mouse's sideways scroll as
      // shift+wheel; neither is a swipe between machines.
      if (event.ctrlKey || event.shiftKey || event.metaKey) return
      const [x, y] = movement(event)
      const size = Math.abs(x) + Math.abs(y)
      const gap = event.timeStamp - lastTime
      const fresh = phase === "idle" || gap > RELEASE_AFTER_MS
        // Momentum never speeds up or turns around: that is fingers again.
        || (phase === "coasting" && (size > lastSize + 1 || (x !== 0 && Math.sign(x) === -Math.sign(lastX))))
      lastTime = event.timeStamp
      if (fresh) begin(event)
      else shrinking = size < lastSize || (size === lastSize && shrinking > 0) ? shrinking + 1 : 0
      if (shrinking === 1) shrinkFrom = lastSize
      lastSize = size
      lastX = x
      if (phase === "coasting" || phase === "ignored") return

      moved = [moved[0] + x, moved[1] + y]
      samples.push({ time: event.timeStamp, x })
      while (samples.length > 2 && event.timeStamp - samples[0].time > VELOCITY_WINDOW_MS) samples.shift()

      if (phase === "deciding") {
        if (Math.abs(moved[0]) + Math.abs(moved[1]) < INTENT_DISTANCE) return
        const surface = latest.current.surface()
        const sideways = Math.abs(moved[0]) > Math.abs(moved[1]) * SIDEWAYS_RATIO
        phase = sideways && surface && startTarget && surface.contains(startTarget) && !claimsSidewaysWheel(startTarget, surface)
          ? "swiping"
          : "ignored"
        if (phase === "ignored") return
        latest.current.onStart()
      }

      if (shrinking >= MOMENTUM_EVENTS && size <= shrinkFrom * MOMENTUM_DECAY) return release(true)
      latest.current.onMove(moved[0])
      if (releaseTimer) clearTimeout(releaseTimer)
      releaseTimer = setTimeout(() => release(false), RELEASE_AFTER_MS)
    }

    window.addEventListener("wheel", onWheel, { passive: true })
    // Without this a browser tab reads the same swipe as Back or Forward.
    const root = document.documentElement
    const overscroll = root.style.overscrollBehaviorX
    root.style.overscrollBehaviorX = "none"
    return () => {
      window.removeEventListener("wheel", onWheel)
      root.style.overscrollBehaviorX = overscroll
      if (releaseTimer) clearTimeout(releaseTimer)
    }
  }, [enabled])
}
