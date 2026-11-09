import { isAnimatingSize } from "./animation"
import { INNER_BAND, OUTER_BAND, layoutTops, mergeSegments, planRange, sameKeys, sumHeights, toExtent, toKeyRange, type Extent, type KeyRange } from "./layout"

/**
 * Virtualization inside one row. A turn with hundreds of blocks, or a tool
 * group with hundreds of calls, mounts only the items near the viewport; the
 * rest are spacers sized from measured or estimated heights. The scroll
 * controller drives every window from its own scroll, commit and idle passes,
 * and keeps the reader's anchor in place when a window's range changes, so a
 * window never writes `scrollTop` itself.
 */

/** Where the scroller's viewport is, in client coordinates. */
export interface WindowViewport {
  top: number
  height: number
}

export interface BlockWindowHost {
  /** Starts driving `window`; returns the detach. */
  attachWindow(window: BlockWindow): () => void
  /** A window rendered a new range: keep the anchor where it was. */
  windowCommitted(): void
  /**
   * The viewport's top relative to a row's top before the row is laid out:
   * -Infinity to start at its head, Infinity to start at its tail.
   */
  viewOffsetInRow(rowKey: string): number
  viewportHeight(): number
  /** Changes when measured heights stop applying: another width bucket, or expand-all toggled. */
  layoutKey(): string
  blockHeight(key: string): number | undefined
  setBlockHeight(key: string, height: number): void
}

/** What a window renders: runs of items with a spacer before each and one after. */
export interface WindowPlan {
  runs: readonly Extent[]
  /** Spacer before each run; 0 renders none. */
  before: readonly number[]
  after: number
}

/** Below this many items a window renders everything. */
export const WINDOW_MIN_ITEMS = 16
const DEFAULT_ITEM_HEIGHT = 64

/**
 * Height of a spacer standing in for items `[start, end)` of a list laid out
 * with `gap` between items. The spacer takes one gap slot itself, so it covers
 * the items plus the gaps between them.
 */
export function spacerHeight(heights: ArrayLike<number>, gap: number, start: number, end: number): number {
  return end <= start ? 0 : sumHeights(heights, start, end) + (end - start - 1) * gap
}

export function buildWindowPlan(range: Extent, pinned: Iterable<number>, heights: ArrayLike<number>, gap: number): WindowPlan {
  const n = heights.length
  const runs = mergeSegments(range, pinned, n)
  const before = runs.map((run, i) => spacerHeight(heights, gap, i === 0 ? 0 : runs[i - 1].end, run.start))
  const last = runs[runs.length - 1]
  return { runs, before, after: last ? spacerHeight(heights, gap, last.end, n) : spacerHeight(heights, gap, 0, n) }
}

interface PlanInput {
  heights: ArrayLike<number>
  gap: number
  /** Measured tops of mounted items, relative to the window's top. */
  known: ReadonlyMap<number, number>
  current: Extent | null
  /** The viewport's top relative to the window's top. */
  viewTop: number
  viewport: number
}

/** The items to mount: the viewport plus overscan, kept while scrolling stays inside its band. */
export function planWindowRange({ heights, gap, known, current, viewTop, viewport }: PlanInput): Extent {
  const n = heights.length
  if (n === 0) return { start: 0, end: 0 }
  const pitch = Float64Array.from(heights, (height) => height + gap)
  const tops = layoutTops(pitch, known)
  const total = tops[n - 1] + pitch[n - 1]
  const top = Math.max(tops[0], Math.min(viewTop, total - viewport))
  return planRange({ tops, heights: pitch, current, viewTop: top, viewport, follow: false })
}

function samePlan(a: WindowPlan, b: WindowPlan): boolean {
  return a.runs.length === b.runs.length
    && a.runs.every((run, i) => run.start === b.runs[i].start && run.end === b.runs[i].end)
    && a.before.every((height, i) => Math.abs(height - b.before[i]) < 1)
    && Math.abs(a.after - b.after) < 1
}

const EMPTY_PLAN: WindowPlan = { runs: [], before: [], after: 0 }

export class BlockWindow {
  private keys: readonly string[] = []
  private readonly indexOf = new Map<string, number>()
  private heights = new Float64Array(0)
  private readonly measured = new Map<string, number>()
  private measuredLayout = ""
  private pinnedKeys: readonly string[] = []
  /** Items holding focus or the selection, which unmounting would lose. */
  private heldKeys: readonly string[] = []
  private range: KeyRange | null = null
  private plan: WindowPlan = EMPTY_PLAN
  /** The last plan `update` published: a range the window moved itself, which no commit of its row accounts for. */
  private publishedPlan: WindowPlan | null = null
  private renderedPlan: WindowPlan | null = null
  private container: HTMLElement | null = null
  private gap = 0
  private readonly items = new Map<string, HTMLElement>()
  private readonly itemRefs = new Map<string, (el: HTMLElement | null) => () => void>()
  private readonly listeners = new Set<() => void>()

  /**
   * `id` prefixes the height cache keys; `rowKey` is the row the window sits
   * in. `carried` are the items the list had mounted before a window took it
   * over (it grew past the threshold, or a fold opened): they stay mounted
   * until the first measured pass, so nothing under the reader is swapped for
   * a guess.
   */
  constructor(
    private readonly host: BlockWindowHost,
    private readonly id: string,
    private readonly rowKey: string,
    private carried: readonly string[] = [],
  ) {}

  /**
   * The items, in order, and the ones that must stay mounted (a navigation
   * target). Called while rendering, so it never notifies; a range that ended
   * at the last item keeps following the items appended after it.
   */
  setItems(keys: readonly string[], pinned: readonly string[]): void {
    const keysChanged = !sameKeys(keys, this.keys)
    if (!keysChanged && sameKeys(pinned, this.pinnedKeys)) return
    const previous = this.keys
    this.pinnedKeys = pinned
    if (keysChanged) {
      this.syncLayout()
      this.keys = keys
      this.indexOf.clear()
      keys.forEach((key, index) => this.indexOf.set(key, index))
      this.rebuildHeights()
      const range = this.range
      if (range && range.last === previous[previous.length - 1] && keys.length > 0) range.last = keys[keys.length - 1]
      if (range && (!this.indexOf.has(range.first) || !this.indexOf.has(range.last))) this.range = null
    }
    if (!this.range) this.range = toKeyRange(this.keys, this.initialRange())
    const plan = this.buildPlan()
    if (!samePlan(plan, this.plan)) this.plan = plan
  }

  getPlan = (): WindowPlan => this.plan

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Attaches the element holding the items and starts being driven by the host. */
  attach(container: HTMLElement): () => void {
    this.container = container
    this.gap = parseFloat(getComputedStyle(container).rowGap) || 0
    const detach = this.host.attachWindow(this)
    return () => {
      detach()
      if (this.container === container) this.container = null
    }
  }

  /** Stable ref callback for one item. */
  itemRef(key: string): (el: HTMLElement | null) => () => void {
    let ref = this.itemRefs.get(key)
    if (!ref) {
      ref = (el) => {
        if (el) this.items.set(key, el)
        return () => {
          if (el && this.items.get(key) === el) this.items.delete(key)
        }
      }
      this.itemRefs.set(key, ref)
    }
    return ref
  }

  /** After a commit that rendered `plan`: tell the host when the window moved its own range under the anchor. */
  rendered(plan: WindowPlan): void {
    if (this.renderedPlan === plan) return
    this.renderedPlan = plan
    if (plan === this.publishedPlan) this.host.windowCommitted()
  }

  /**
   * Re-plans the range for the viewport. A scroll (`measure` false) costs a
   * few rect reads while the mounted range still covers its band, and does no
   * React work; a commit or idle pass also measures the mounted items.
   */
  update(viewport: WindowViewport, measure: boolean): void {
    const container = this.container
    if (!container || this.keys.length === 0) return
    if (!measure && this.coversBand(viewport)) return
    if (this.syncLayout()) this.rebuildHeights()
    const containerTop = container.getBoundingClientRect().top
    const known = new Map<number, number>()
    for (const [key, el] of this.items) {
      const index = this.indexOf.get(key)
      if (index === undefined) continue
      const rect = el.getBoundingClientRect()
      known.set(index, rect.top - containerTop)
      if (this.measured.get(key) === rect.height) continue
      this.measured.set(key, rect.height)
      this.heights[index] = rect.height
      if (!isAnimatingSize(el)) this.host.setBlockHeight(this.cacheKey(key), rect.height)
    }
    const range = planWindowRange({
      heights: this.heights,
      gap: this.gap,
      known,
      current: this.currentRange(),
      viewTop: viewport.top - containerTop,
      viewport: viewport.height,
    })
    const next = toKeyRange(this.keys, range)
    const carried = this.carried.length > 0
    this.carried = []
    if (!carried && next?.first === this.range?.first && next?.last === this.range?.last) return
    this.range = next
    this.heldKeys = this.findHeldKeys()
    this.publish(this.buildPlan())
  }

  /** Forgets heights measured for another layout; true when it did. */
  private syncLayout(): boolean {
    const layout = this.host.layoutKey()
    if (layout === this.measuredLayout) return false
    this.measuredLayout = layout
    this.measured.clear()
    return true
  }

  /** The mounted range still covers the viewport's inner band and reaches no further than its outer band. */
  private coversBand(viewport: WindowViewport): boolean {
    const range = this.currentRange()
    if (!range) return false
    const first = this.items.get(this.keys[range.start])
    const last = this.items.get(this.keys[range.end - 1])
    if (!first || !last) return false
    const firstRect = first.getBoundingClientRect()
    const lastRect = last.getBoundingClientRect()
    const top = range.start === 0 ? -Infinity : firstRect.top
    const bottom = range.end === this.keys.length ? Infinity : lastRect.bottom
    const viewBottom = viewport.top + viewport.height
    return top <= viewport.top - viewport.height * INNER_BAND
      && bottom >= viewBottom + viewport.height * INNER_BAND
      && firstRect.bottom >= viewport.top - viewport.height * OUTER_BAND
      && lastRect.top <= viewBottom + viewport.height * OUTER_BAND
  }

  /** Mounted items holding the focused element or an end of the selection. */
  private findHeldKeys(): string[] {
    const selection = document.getSelection()
    const nodes: Array<Node | null> = [document.activeElement, selection?.anchorNode ?? null, selection?.focusNode ?? null]
    const held: string[] = []
    for (const [key, el] of this.items) {
      if (nodes.some((node) => node !== null && node !== document.body && el.contains(node))) held.push(key)
    }
    return held
  }

  private publish(plan: WindowPlan): void {
    if (samePlan(plan, this.plan)) return
    this.plan = plan
    this.publishedPlan = plan
    for (const listener of this.listeners) listener()
  }

  private cacheKey(key: string): string {
    return `${this.id}:${key}`
  }

  private rebuildHeights(): void {
    let sum = 0
    let count = 0
    for (const height of this.measured.values()) {
      sum += height
      count++
    }
    const fallback = count > 0 ? sum / count : DEFAULT_ITEM_HEIGHT
    this.heights = Float64Array.from(this.keys, (key) => this.measured.get(key) ?? this.host.blockHeight(this.cacheKey(key)) ?? fallback)
  }

  private currentRange(): Extent | null {
    return toExtent(this.indexOf, this.range)
  }

  /** Before the window is laid out: start where the host says the viewport will be. */
  private initialRange(): Extent {
    const n = this.keys.length
    if (n === 0) return { start: 0, end: 0 }
    const offset = this.host.viewOffsetInRow(this.rowKey)
    const viewport = this.host.viewportHeight()
    const total = spacerHeight(this.heights, this.gap, 0, n)
    const viewTop = offset === Infinity ? total : offset === -Infinity ? 0 : offset
    return planWindowRange({ heights: this.heights, gap: this.gap, known: new Map(), current: null, viewTop, viewport })
  }

  private buildPlan(): WindowPlan {
    const range = this.currentRange() ?? { start: 0, end: 0 }
    const pinned: number[] = []
    for (const key of [...this.pinnedKeys, ...this.heldKeys, ...this.carried]) {
      const index = this.indexOf.get(key)
      if (index !== undefined) pinned.push(index)
    }
    return buildWindowPlan(range, pinned, this.heights, this.gap)
  }
}
