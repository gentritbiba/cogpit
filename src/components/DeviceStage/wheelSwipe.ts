/** One wheel event, content-wise: fingers moving left give a negative x. */
export interface WheelInput {
  x: number
  y: number
  /** Event time, ms. */
  time: number
  target: unknown
  /** The browser's own word on momentum (Chrome 151 and later), when it gives one. */
  momentum?: boolean
}

export interface WheelSwipeEvents {
  /** Whether a swipe between machines may start on this target. */
  accepts: (target: unknown) => boolean
  /** A sideways swipe began; offsets that follow count from here. */
  start: () => void
  /** The fingers have moved the view `offset` px since the swipe began (negative: left). */
  move: (offset: number) => void
  /** The fingers let go, moving at `velocity` px/ms, headed for `projected`. */
  release: (offset: number, velocity: number, projected: number) => void
}

export interface Timers {
  set: (run: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
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
 * Where the browser does not say, momentum is read from the movement: it
 * slows down every frame, so this many slowdowns in a row, losing at least
 * MOMENTUM_DECAY overall, mean the fingers are off. Fingers that slow down
 * look the same, and are about to stop anyway.
 */
const MOMENTUM_EVENTS = 4
const MOMENTUM_DECAY = 0.9
/**
 * Speed is measured over at least this much of the latest movement, so one
 * event early and the next late average out, and over no gap longer than
 * CONTINUOUS_GAP_MS, which is a pause, or a busy page that merged events.
 */
const SPEED_WINDOW_MS = 24
const CONTINUOUS_GAP_MS = 34
/** Momentum never pauses this long. */
const MOMENTUM_GAP_MS = 300
/** Momentum this slow (px/ms) has run out: after a pause, what comes next is fingers. */
const SPENT_SPEED = 0.15
/**
 * Momentum never goes faster than the slowest it has been again. This many
 * events in a row clearly faster than that floor are fingers on the trackpad.
 */
const RENEWED_EVENTS = 3
const RENEWED_RATIO = 1.15
const RENEWED_MARGIN = 0.02
/** Before the first gap is known, an event is taken to span this long. */
const DEFAULT_GAP_MS = 16
/**
 * After a long pause in live momentum, an event moving more than this may be
 * momentum a busy page merged. It waits this many events for fingers to
 * claim it before it is dropped.
 */
const MERGED_MOMENTUM = 40
const MERGED_WAIT_EVENTS = 4
/** Velocity is measured over the latest movement this long. */
const VELOCITY_WINDOW_MS = 50
/** Where a release is headed: on at its velocity for this long. */
const PROJECTION_MS = 160

/**
 * idle: no wheel. deciding: a gesture too short to read yet. swiping: the
 * machine follows the fingers. coasting: what follows a gesture (momentum,
 * or fingers gone still), which moves nothing. ignored: a gesture that is not
 * a swipe between machines.
 */
type Phase = "idle" | "deciding" | "swiping" | "coasting" | "ignored"

function median(values: number[]): number {
  return values.length ? [...values].sort((a, b) => a - b)[values.length >> 1] : DEFAULT_GAP_MS
}

/**
 * Reads two-finger sideways swipes out of wheel events. The browser does not
 * say when fingers leave a trackpad (until Chrome 151, which flags momentum),
 * so a release is the fingers going still or the momentum that follows a
 * lift. Momentum only ever slows down: going faster than its slowest again,
 * holding speed longer than rounding explains, or turning around is fingers
 * back on the trackpad, and starts the next swipe at once. Speeds are
 * measured over a few events' time, because a busy page merges events and
 * the trackpad's events and momentum come at different rates.
 */
export class WheelSwipe {
  private phase: Phase = "idle"
  /** Coasting on momentum, rather than after fingers that went still. */
  private momentum = false
  private startTarget: unknown = null
  private moved: [number, number] = [0, 0]
  private lastTime = -Infinity
  private lastX = 0
  private lastNative: boolean | undefined
  /** Recent events, for speed, and the gaps between continuous ones. */
  private recent: { gap: number; size: number }[] = []
  private gaps: number[] = []
  private lastSpeed = 0
  private slowing = 0
  private slowingFrom = 0
  /** While coasting: the slowest momentum has been (px/ms), and events since that did not lower it. */
  private floor = 0
  private above = 0
  private stalled = 0
  /** Movement of a big event after a long pause, kept until fingers claim it or it turns out to be momentum. */
  private held: { x: number; y: number; events: number } | null = null
  private samples: { time: number; x: number }[] = []
  private releaseTimer: unknown = null

  constructor(
    private readonly events: WheelSwipeEvents,
    private readonly timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  ) {}

  dispose(): void {
    this.clearTimer()
  }

  wheel(input: WheelInput): void {
    const { x, y, time } = input
    const size = Math.abs(x) + Math.abs(y)
    const gap = time - this.lastTime
    this.lastTime = time
    const continuous = gap <= CONTINUOUS_GAP_MS
    if (continuous) this.gaps = [...this.gaps.slice(-15), gap]
    this.recent = [...this.recent.slice(-11), { gap, size }]
    // Null after a pause or a merge: nothing to compare yet.
    const speed = continuous ? this.speed() : null
    const native = typeof input.momentum === "boolean" ? input.momentum : undefined

    const fresh = this.startsGesture(x, y, speed, gap, native)
    this.lastX = x
    this.lastNative = native
    if (fresh) this.begin(input)
    // The first event of a gesture is taken to span one usual gap.
    const thisSpeed = speed ?? size / median(this.gaps)
    if (!fresh) {
      if (thisSpeed < this.lastSpeed) {
        if (this.slowing === 0) this.slowingFrom = this.lastSpeed
        this.slowing++
      } else if (thisSpeed > this.lastSpeed) this.slowing = 0
    }
    this.lastSpeed = thisSpeed
    const lifted = native ?? (this.slowing >= MOMENTUM_EVENTS && thisSpeed <= this.slowingFrom * MOMENTUM_DECAY)

    if (this.phase === "coasting") return
    if (this.phase === "ignored") {
      // Its momentum is read too, so fingers starting a swipe can cut it short.
      if (lifted) this.coast(true)
      return
    }

    this.moved = [this.moved[0] + x, this.moved[1] + y]
    this.samples.push({ time, x })
    while (this.samples.length > 2 && time - this.samples[0].time > VELOCITY_WINDOW_MS) this.samples.shift()

    if (this.phase === "deciding") {
      if (native) return this.coast(true)
      if (Math.abs(this.moved[0]) + Math.abs(this.moved[1]) < INTENT_DISTANCE) return
      const sideways = Math.abs(this.moved[0]) > Math.abs(this.moved[1]) * SIDEWAYS_RATIO
      if (!sideways || !this.events.accepts(this.startTarget)) {
        this.phase = "ignored"
        return
      }
      this.phase = "swiping"
      this.events.start()
    }

    this.events.move(this.moved[0])
    if (lifted) return this.release(true)
    this.clearTimer()
    this.releaseTimer = this.timers.set(() => this.release(false), RELEASE_AFTER_MS)
  }

  /** Whether this event starts a new gesture rather than continuing the last. */
  private startsGesture(x: number, y: number, speed: number | null, gap: number, native: boolean | undefined): boolean {
    switch (this.phase) {
      case "idle":
        return true
      // A swipe ends by its release, never by a late event: a busy page can delay the timer.
      case "swiping":
        return false
      case "deciding":
        return gap > RELEASE_AFTER_MS
      case "ignored":
        return gap > RELEASE_AFTER_MS || (native === false && this.lastNative === true)
      case "coasting":
        return !this.momentum || this.fingersAgain(x, y, speed, gap, native)
    }
  }

  /** Whether momentum this event would continue is fingers instead. */
  private fingersAgain(x: number, y: number, speed: number | null, gap: number, native: boolean | undefined): boolean {
    if (native !== undefined) return !native
    if (x !== 0 && this.lastX !== 0 && Math.sign(x) !== Math.sign(this.lastX)) return true
    if (gap > RELEASE_AFTER_MS && this.floor <= SPENT_SPEED) return true
    if (gap > MOMENTUM_GAP_MS) {
      if (Math.abs(x) + Math.abs(y) <= MERGED_MOMENTUM) return true
      this.held = { x, y, events: MERGED_WAIT_EVENTS }
      return false
    }
    if (this.held && --this.held.events <= 0) this.held = null
    if (speed === null) return false
    if (speed < this.floor) {
      this.floor = speed
      this.above = 0
      this.stalled = 0
      this.held = null
      return false
    }
    this.above = speed > this.floor * RENEWED_RATIO + RENEWED_MARGIN ? this.above + 1 : 0
    // Rounding can hold momentum at one size for about 1 / (size x 0.5%) events, never longer.
    const size = this.floor * median(this.gaps)
    return this.above >= RENEWED_EVENTS || ++this.stalled > 200 / Math.max(size, 1) + MOMENTUM_EVENTS
  }

  /** px/ms over the latest SPEED_WINDOW_MS of continuous movement. */
  private speed(): number {
    let moved = 0
    let span = 0
    for (let i = this.recent.length - 1; i >= 0 && span < SPEED_WINDOW_MS; i--) {
      const { gap, size } = this.recent[i]
      if (gap > CONTINUOUS_GAP_MS) break
      moved += size
      span += gap
    }
    return span > 0 ? moved / span : 0
  }

  private begin(input: WheelInput): void {
    this.phase = "deciding"
    this.startTarget = input.target
    // Fingers going the same way claimed the big event that came after a pause: it was theirs.
    const held = this.held && Math.sign(this.held.x) === Math.sign(input.x) ? this.held : null
    this.moved = held ? [held.x, held.y] : [0, 0]
    this.held = null
    this.slowing = 0
    this.samples = []
  }

  /** Coast on what follows a gesture: momentum, or fingers gone still. */
  private coast(onMomentum: boolean): void {
    this.phase = "coasting"
    this.momentum = onMomentum
    this.floor = this.lastSpeed
    this.above = 0
    this.stalled = 0
    this.held = null
  }

  private release(onMomentum: boolean): void {
    this.clearTimer()
    this.coast(onMomentum)
    // Fingers that went still are not moving; momentum carries the speed they lifted at.
    const speed = onMomentum ? this.velocity() : 0
    this.events.release(this.moved[0], speed, this.moved[0] + speed * PROJECTION_MS)
  }

  private velocity(): number {
    const { samples } = this
    if (samples.length < 2) return 0
    const span = samples[samples.length - 1].time - samples[0].time
    if (span <= 0) return 0
    return samples.slice(1).reduce((sum, sample) => sum + sample.x, 0) / span
  }

  private clearTimer(): void {
    if (this.releaseTimer !== null) this.timers.clear(this.releaseTimer)
    this.releaseTimer = null
  }
}
