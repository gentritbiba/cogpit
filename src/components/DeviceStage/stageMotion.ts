import { releaseDirection, rubberBand, springAt, springFrames } from "./motion"

/**
 * A released swipe switches machines this long after the fingers let go,
 * unless they come back first. The slide finishes on its own meanwhile.
 */
const COMMIT_AFTER_RELEASE_MS = 90
/** An explicit switch commits once its slide runs on the compositor, about two frames in. */
const COMMIT_AFTER_START_MS = 34

/** What the stage gives the motion to work with. */
export interface StageParts {
  stage: () => HTMLElement | null
  track: () => HTMLElement | null
  pager: () => HTMLElement | null
  /** A mounted machine's pane. */
  pane: (id: string) => HTMLElement | null
  poster: () => HTMLElement | null
  /** The machine the poster stands in for, if it is up. */
  posterFor: () => string | null
  mounted: (id: string) => boolean
  /** Every machine, left to right. */
  order: () => readonly string[]
  /** The machine React shows. */
  active: () => string
  reducedMotion: () => boolean
  showPoster: (id: string | null, connecting: boolean) => void
  showPager: (from: string, to: string) => void
  settlePager: (at: string) => void
  commit: (id: string) => void
}

interface Settle {
  /** Slot it comes to rest on, and the machine there when it began. */
  target: number
  destination: string | null
  /** px from the target when it began, and how fast that changed (px/ms). */
  distance: number
  velocity: number
  animations: Animation[]
}

interface Motion {
  /** The slot everything is laid out from: the machine on screen when the move (re)based. */
  origin: number
  originId: string
  /** Where the view is, in slots: `origin` at rest, `origin + 1` on the next machine. */
  pos: number
  /** Where the swipe under the fingers began. */
  swipeFrom: number
  /** An explicit switch to a machine further away draws it beside the origin, in this slot. */
  standIn: { id: string; slot: number } | null
  /** The slots last drawn. */
  range: readonly [number, number]
  /** Elements placed this move: machines' panes and the poster, each with its machine. */
  drawn: Map<HTMLElement, string>
  /** Machines whose hidden frame this move uncovered. */
  uncovered: Set<string>
  settle: Settle | null
  /** The slide ended, waiting for React to show the machine it switched to. */
  arrived: boolean
  /** Machines this move switched to that React has not shown yet, oldest first. */
  pending: string[]
  commitTimer: ReturnType<typeof setTimeout> | null
}

/**
 * The machine's content under its pane: hidden by its Activity while the
 * machine is off screen. Showing it uncovers the last frame without waking
 * the machine; hiding puts back exactly what React put there.
 */
function frameOf(pane: HTMLElement): HTMLElement | null {
  return pane.firstElementChild instanceof HTMLElement ? pane.firstElementChild : null
}

function showFrame(pane: HTMLElement): void {
  frameOf(pane)?.style.removeProperty("display")
}

function hideFrame(pane: HTMLElement): void {
  frameOf(pane)?.style.setProperty("display", "none", "important")
}

function translate(x: number): string {
  return `translate3d(${x}px, 0, 0)`
}

function place(element: HTMLElement, x: number | null): void {
  element.style.transform = x === null ? "" : translate(x)
}

/**
 * Moves between machines. They sit side by side in slots, in switcher order,
 * on a track: a swipe drags the track, and the slide that ends a move is a
 * Web Animation, which the compositor plays even while React wakes the
 * machine coming in. The switch commits early in that slide, so the new
 * machine answers before the slide is over, and a swipe can catch a sliding
 * track wherever it is. At rest nothing is transformed, so fixed-position UI
 * inside a machine stays where it belongs.
 */
export class StageMotion {
  private motion: Motion | null = null
  private guard: MutationObserver | null = null
  private pagerTo: string | null = null

  constructor(private readonly parts: StageParts) {}

  /** The machine on screen, counting a switch React has not caught up with. */
  current(): string {
    return this.motion?.pending.at(-1) ?? this.parts.active()
  }

  /** A machine's element came or went: a move in progress places it. */
  registered(): void {
    if (this.motion) this.draw(this.motion.range)
  }

  /** The fingers began a sideways swipe. */
  swipeStart(): void {
    const motion = this.begin()
    motion.swipeFrom = motion.pos
  }

  /** The fingers moved the view `moved` px since the swipe began. */
  swipeMove(moved: number): void {
    const motion = this.motion ?? this.begin()
    const width = this.width()
    const last = this.parts.order().length - 1
    const pos = Math.min(motion.origin + 1, Math.max(motion.origin - 1, motion.swipeFrom - moved / width))
    // Past the first or last machine the view gives a little and stiffens.
    motion.pos = pos < 0 ? rubberBand(pos * width, width) / width
      : pos > last ? last + rubberBand((pos - last) * width, width) / width
      : pos
    this.draw([motion.pos, motion.pos])
    this.paint()
  }

  /** The fingers let go: land on the next machine or back where the swipe began. */
  swipeRelease(moved: number, velocity: number, projected: number): void {
    const motion = this.motion
    if (!motion || motion.settle) return
    const width = this.width()
    const last = this.parts.order().length - 1
    const offset = (motion.origin - motion.pos) * width
    const reach = offset + (projected - moved)
    const direction = releaseDirection(offset, velocity, width, { previous: motion.origin > 0, next: motion.origin < last }, reach)
    const pulledPast = motion.pos < 0 || motion.pos > last
    this.settle(motion.origin + direction, pulledPast ? 0 : -velocity / width, COMMIT_AFTER_RELEASE_MS)
  }

  /** Slide to `target` for a switch from the menu or a shortcut; at once for less motion. */
  switchTo(target: string): void {
    this.finish()
    if (target === this.current()) return
    const order = this.parts.order()
    if (this.parts.reducedMotion() || !order.includes(target)) {
      this.rest()
      this.parts.commit(target)
      this.parts.settlePager(target)
      return
    }
    const motion = this.begin()
    const slot = order.indexOf(target)
    if (Math.abs(slot - motion.origin) > 1) motion.standIn = { id: target, slot: motion.origin + Math.sign(slot - motion.origin) }
    this.settle(this.slotOf(target), 0, COMMIT_AFTER_START_MS)
  }

  /** React now shows `id`: a switch this move made, or one Back, Forward or a link made. */
  activeChanged(id: string): void {
    const motion = this.motion
    if (!motion) {
      // A poster waiting on a machine first opened must not cover the one navigated to.
      const poster = this.parts.posterFor()
      if (poster && poster !== id) this.parts.showPoster(null, false)
      return
    }
    const caughtUp = motion.pending.indexOf(id)
    if (caughtUp >= 0) {
      motion.pending.splice(0, caughtUp + 1)
      if (motion.pending.length) return
      if (motion.arrived) this.rest()
      // React hid the machine we left; it stays drawn while it slides out.
      else this.draw(motion.range)
      return
    }
    // Back or Forward got to the slide's destination first: let the slide finish without committing again.
    if (motion.settle?.destination === id) {
      this.cancelCommit(motion)
      motion.pending = []
      return
    }
    // Navigation went elsewhere, back to where the move began included: drop the move where React is.
    this.rest()
  }

  /** The machines changed order: land any slide on the machine it was going to, then lay out afresh. */
  orderChanged(): void {
    if (this.motion) this.finish()
  }

  dispose(): void {
    if (this.motion) {
      this.stopSettle(this.motion)
      this.cancelCommit(this.motion)
    }
    this.motion = null
    this.guard?.disconnect()
  }

  private width(): number {
    return this.parts.stage()?.clientWidth || window.innerWidth
  }

  private slotOf(id: string): number {
    const standIn = this.motion?.standIn
    return standIn?.id === id ? standIn.slot : this.parts.order().indexOf(id)
  }

  private idAt(slot: number): string | null {
    const standIn = this.motion?.standIn
    if (standIn?.slot === slot) return standIn.id
    const id = this.parts.order()[slot] ?? null
    return id === standIn?.id ? null : id
  }

  /** Start a move from wherever the view is: at rest, or caught mid-slide. */
  private begin(): Motion {
    let motion = this.motion
    if (motion?.standIn) {
      // A long jump does not stop halfway: it lands, and the move starts from there.
      this.finish()
      motion = this.motion
    }
    if (!motion) {
      const id = this.current()
      const origin = this.slotOf(id)
      motion = {
        origin, originId: id, pos: origin, swipeFrom: origin, standIn: null, range: [origin, origin],
        drawn: new Map(), uncovered: new Set(), settle: null, arrived: false, pending: [], commitTimer: null,
      }
      this.motion = motion
      this.draw(motion.range)
      return motion
    }
    if (motion.settle) motion.pos = this.stopSettle(motion)
    motion.arrived = false
    // Not committed yet: the fingers came back before the release counted.
    this.cancelCommit(motion)
    const id = this.current()
    if (id !== motion.originId) {
      motion.origin = this.slotOf(id)
      motion.originId = id
    }
    this.draw([motion.pos, motion.pos])
    this.paint()
    return motion
  }

  /**
   * Jump a move to its end: a slide lands where it was going (committing it),
   * a drag under the fingers goes back. Then lay out from the machine on screen.
   */
  private finish(): void {
    const motion = this.motion
    if (!motion) return
    const settle = motion.settle
    if (settle) {
      this.stopSettle(motion)
      this.commitIfNeeded(settle.destination)
    }
    motion.standIn = null
    motion.origin = this.slotOf(this.current())
    motion.originId = this.current()
    motion.pos = motion.origin
    motion.arrived = true
    if (this.parts.active() === this.current()) this.rest()
    else {
      this.draw([motion.pos, motion.pos])
      this.paint()
    }
  }

  /**
   * Spring the view to slot `target`, starting at `velocity` slots/ms. The
   * track holds the end position inline and the animation plays over it, so
   * a main thread too busy to hear the end still shows the right place.
   */
  private settle(target: number, velocity: number, commitAfter: number): void {
    const motion = this.motion
    if (!motion) return
    const width = this.width()
    const from = motion.pos
    this.draw([Math.min(from, target), Math.max(from, target)])
    const { duration, distances } = this.parts.reducedMotion()
      ? { duration: 0, distances: [0] }
      : springFrames((from - target) * width, velocity * width)
    const destination = this.idAt(target)
    const settle: Settle = { target, destination, distance: (from - target) * width, velocity: velocity * width, animations: [] }
    motion.settle = settle
    motion.pos = target
    this.paint()
    const track = this.parts.track()
    if (duration === 0 || !track || typeof track.animate !== "function") return this.arrive(settle)

    if (destination && destination !== this.current()) {
      motion.commitTimer = setTimeout(() => {
        motion.commitTimer = null
        this.commitIfNeeded(destination)
      }, commitAfter)
    }
    const base = (motion.origin - target) * width
    const timing = { duration, easing: "linear" }
    const slide = track.animate(distances.map((distance) => ({ transform: translate(base - distance) })), timing)
    slide.onfinish = () => this.arrive(settle)
    settle.animations.push(slide)
    const pager = this.parts.pager()
    if (pager && this.pagerTo) {
      const progress = (distance: number) => String(Math.min(1, Math.abs(target + distance / width - motion.origin)))
      settle.animations.push(pager.animate(distances.map((distance) => ({ "--pager-to": progress(distance) })), timing))
    }
  }

  /** The slide is over. */
  private arrive(settle: Settle): void {
    const motion = this.motion
    if (!motion || motion.settle !== settle) return
    motion.settle = null
    motion.arrived = true
    this.commitIfNeeded(settle.destination)
    // The machine switched to may still be on its way through React; rest once it shows.
    if (this.parts.active() === this.current()) this.rest()
  }

  /** Switch to `id` unless the view is on it already, or it has left the switcher. */
  private commitIfNeeded(id: string | null): void {
    if (id && id !== this.current() && this.parts.order().includes(id)) this.commit(id)
  }

  private commit(id: string): void {
    const motion = this.motion
    if (!motion) return
    this.cancelCommit(motion)
    motion.pending.push(id)
    // The poster stays over a machine opened for the first time until it has drawn itself.
    if (!this.parts.mounted(id)) this.parts.showPoster(id, true)
    this.parts.commit(id)
  }

  private cancelCommit(motion: Motion): void {
    if (motion.commitTimer) clearTimeout(motion.commitTimer)
    motion.commitTimer = null
  }

  /** Stop a running slide where it is, and say where that is, in slots. */
  private stopSettle(motion: Motion): number {
    const settle = motion.settle
    if (!settle) return motion.pos
    const elapsed = Number(settle.animations[0]?.currentTime ?? 0)
    for (const animation of settle.animations) animation.cancel()
    motion.settle = null
    return settle.target + springAt(settle.distance, settle.velocity, elapsed).distance / this.width()
  }

  /**
   * Place the machines in slots `range`, and the one on screen, with their
   * frames uncovered; put back anything placed before and not needed now.
   */
  private draw(range: readonly [number, number]): void {
    const motion = this.motion
    if (!motion) return
    motion.range = range
    const current = this.current()
    const wanted = new Set([current])
    for (let slot = Math.floor(range[0]); slot <= Math.ceil(range[1]); slot++) {
      const id = this.idAt(slot)
      if (id) wanted.add(id)
    }
    // One poster: for a machine not opened yet, or over one still drawing itself for the first time.
    const cold = [...wanted].find((id) => !this.parts.mounted(id)) ?? null
    const poster = this.parts.posterFor()
    if (cold && cold !== poster) this.parts.showPoster(cold, cold === current)
    else if (!cold && poster && poster !== current) this.parts.showPoster(null, false)

    const placements = new Map<HTMLElement, string>()
    for (const id of wanted) {
      const pane = this.parts.mounted(id) ? this.parts.pane(id) : null
      if (pane) placements.set(pane, id)
      const posterElement = this.parts.posterFor() === id ? this.parts.poster() : null
      if (posterElement) placements.set(posterElement, id)
    }
    for (const [element, id] of motion.drawn) {
      if (placements.get(element) === id) continue
      motion.drawn.delete(element)
      place(element, null)
      if (element.dataset.devicePane === id && motion.uncovered.delete(id) && id !== current) hideFrame(element)
    }
    const width = this.width()
    for (const [element, id] of placements) {
      motion.drawn.set(element, id)
      place(element, (this.slotOf(id) - motion.origin) * width)
      if (element.dataset.devicePane !== id) continue
      const frame = frameOf(element)
      if (frame) this.watch(frame)
      if (id === current) motion.uncovered.delete(id)
      else {
        showFrame(element)
        motion.uncovered.add(id)
      }
    }
  }

  /** Move the track to the view's position, and the page dots with it. */
  private paint(): void {
    const motion = this.motion
    const track = this.parts.track()
    if (!motion || !track) return
    track.style.transform = translate((motion.origin - motion.pos) * this.width())
    track.style.willChange = "transform"
    const side = Math.sign(motion.pos - motion.origin)
    const to = side === 0 ? null : this.idAt(motion.origin + side)
    if (to && to !== this.pagerTo) {
      this.pagerTo = to
      this.parts.showPager(motion.originId, to)
    }
    const progress = to ? Math.min(1, Math.abs(motion.pos - motion.origin)) : 0
    this.parts.pager()?.style.setProperty("--pager-to", String(progress))
  }

  /**
   * React hides a hidden machine's content again whenever it renders inside;
   * while a frame slides on screen, show it again before the browser paints.
   */
  private watch(frame: HTMLElement): void {
    this.guard ??= new MutationObserver((records) => {
      const motion = this.motion
      if (!motion) return
      for (const { target } of records) {
        const frame = target as HTMLElement
        const pane = frame.parentElement
        const id = pane?.dataset.devicePane
        if (!pane || !id || id === this.current() || motion.drawn.get(pane) !== id) continue
        if (frame.style.display === "none") {
          showFrame(pane)
          motion.uncovered.add(id)
        }
      }
    })
    this.guard.observe(frame, { attributes: true, attributeFilter: ["style"] })
  }

  /** Back to rest on the machine React shows: nothing transformed, no other frame showing. */
  private rest(): void {
    const motion = this.motion
    if (!motion) return
    this.stopSettle(motion)
    this.cancelCommit(motion)
    this.motion = null
    this.guard?.disconnect()
    const active = this.parts.active()
    for (const [element, id] of motion.drawn) {
      place(element, null)
      if (element.dataset.devicePane === id && id !== active && motion.uncovered.has(id)) hideFrame(element)
    }
    const track = this.parts.track()
    if (track) {
      track.style.transform = ""
      track.style.willChange = ""
    }
    // A machine opened for the first time keeps its poster until it has drawn itself.
    const poster = this.parts.posterFor()
    if (poster === active) this.parts.showPoster(active, true)
    else if (poster) this.parts.showPoster(null, false)
    this.pagerTo = null
    this.parts.settlePager(active)
  }
}
