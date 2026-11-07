import { followReducer, RESUME_DISTANCE, type FollowEvent, type FollowState } from "./follow"
import { timelineHeights, widthBucket, type SessionHeights } from "./heightCache"
import { reserveHeight, shouldLoadOlder } from "./history"
import { layoutTops, mergeSegments, planRange, rowsOverlapping, sumHeights, type Extent } from "./layout"
import { absorb, normalizeTop, slackForTarget, trimBottomSlack } from "./slack"
import type { ScrollToTurnOptions, TimelineHandle, TimelineViewport } from "./types"

/**
 * The timeline's scroll engine: the only code that writes the timeline's
 * `scrollTop`. It virtualizes the rows, keeps what the reader is looking at in
 * place while layout changes, follows the bottom, triggers history paging and
 * lands navigation. Decisions run in ResizeObserver callbacks, layout effects
 * and scroll events, so they land before paint; the only timer is the
 * scroll-idle detector.
 */

/** Rows to render, addressed by key so a prepend does not invalidate it. */
export interface RenderPlan {
  segments: ReadonlyArray<{ first: string; last: string }>
  /** Spacer height before each segment; the first is always 0 (the top pad precedes it). */
  gaps: readonly number[]
  bottomPad: number
}

export interface TimelineIndicators {
  canScrollDown: boolean
  /** The open placement for the current session has landed. */
  placed: boolean
}

export interface TimelineRowsInput {
  keys: readonly string[]
  /** Identifies the session for the height cache. */
  sessionKey: string
  /** Changes on every session (re)load; a new value starts a new placement. */
  sessionChangeKey: number
  expandAll: boolean
  hasMore: boolean
  isLoadingOlder: boolean
  onLoadMore?: () => void
}

export interface HistoryBytes {
  remaining: number
  loaded: number
}

type AnchorKind = "default" | "activation" | "navigation"

interface Anchor {
  /** Candidates in priority order; the first still connected is used. */
  elements: Element[]
  /** Distance from the viewport top when recorded. */
  offset: number
  scrollTop: number
  kind: AnchorKind
}

interface Navigation {
  key: string
  align: "start" | "center"
  target?: (row: HTMLElement) => Element | null
  resolve: (landed: boolean) => void
  /** Frames left to wait for `target` to appear, e.g. inside a group the navigation just opened. */
  framesLeft: number
  retry: number | null
}

const ROW_SELECTOR = "[data-row-key]"
const ANCHOR_SELECTOR = "[data-scroll-anchor]"
const DEFAULT_ROW_HEIGHT = 240
const IDLE_MS = 150
/** A navigation anchor gives way to the default anchor after this long without layout movement. */
const NAVIGATION_HOLD_MS = 1500
const TARGET_RETRY_FRAMES = 10
const EMPTY_PLAN: RenderPlan = { segments: [], gaps: [], bottomPad: 0 }
const PLAN_TOLERANCE = 2
const SIZE_PROPERTIES = new Set(["height", "maxHeight", "minHeight", "blockSize", "gridTemplateRows"])

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** How deep below a row the default anchor may sit. */
const MAX_ANCHOR_DEPTH = 12

/**
 * From `row` down to the deepest element crossing the viewport line `y`, or
 * the first one starting below it, deepest first. Content inserted inside the
 * row above the line moves that element, so keeping it in place keeps what the
 * reader sees; its ancestors stand in if a re-render replaces it.
 */
function anchorPath(row: Element, y: number): Element[] {
  const path: Element[] = [row]
  let node: Element = row
  for (let depth = 0; depth < MAX_ANCHOR_DEPTH && node.getBoundingClientRect().top <= y; depth++) {
    let next: Element | null = null
    for (const child of node.children) {
      const rect = child.getBoundingClientRect()
      if (rect.height === 0) continue
      if (rect.top > y || rect.bottom > y) {
        next = child
        break
      }
    }
    if (!next) break
    path.push(next)
    node = next
  }
  return path.reverse()
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable=true]") !== null
}

function isActivatable(target: EventTarget | null): target is Element {
  return target instanceof Element && target.closest("button, a[href], summary, [role=button], [aria-expanded]") !== null
}

/** A height animation is running somewhere in the row, so its size is not final. */
function isAnimatingSize(element: Element): boolean {
  if (typeof element.getAnimations !== "function") return false
  return element.getAnimations({ subtree: true }).some((animation) => {
    if (animation.playState !== "running") return false
    const effect = animation.effect
    if (!(effect instanceof KeyframeEffect)) return false
    return effect.getKeyframes().some((frame) => Object.keys(frame).some((property) => SIZE_PROPERTIES.has(property)))
  })
}

export class TimelineScrollController implements TimelineHandle {
  readonly scrollerRef: { current: HTMLDivElement | null } = { current: null }

  private scroller: HTMLDivElement | null = null
  private list: HTMLElement | null = null
  private topPadEl: HTMLElement | null = null
  private bottomSlackEl: HTMLElement | null = null
  private readonly rowEls = new Map<string, HTMLElement>()
  private readonly rowRefs = new Map<string, (el: HTMLElement | null) => (() => void)>()
  private readonly footers = new Set<Element>()
  private observer: ResizeObserver | null = null

  private input: TimelineRowsInput | null = null
  private history: HistoryBytes = { remaining: 0, loaded: 0 }
  private heightStore: SessionHeights | null = null
  private bucket = 0
  private keys: readonly string[] = []
  private indexOf = new Map<string, number>()
  private heights = new Float64Array(0)
  private readonly liveHeights = new Map<string, number>()
  private renderedTops = new Map<number, number>()

  private plan: RenderPlan = EMPTY_PLAN
  private range: { first: string; last: string } | null = null
  private planVersion = 0
  private appliedPlanVersion = 0
  private plannedFirstTop: number | null = null
  private replanPending = false
  private readonly planListeners = new Set<() => void>()

  private topPad = 0
  private bottomSlack = 0
  private follow: FollowState = { following: true, userInput: false }
  private anchor: Anchor | null = null
  private navigation: Navigation | null = null
  private navigationMovedAt = 0
  private readonly pins = new Map<"navigation" | "activation" | "focus" | "selection", Set<string>>()

  private sessionChangeKey: number | null = null
  private topOnNextSession = false
  private placement: "top" | "bottom" | null = null
  private lastScrollTop = 0
  private ownScrollTop: number | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private touching = false
  private scrollbarHeld = false
  private touchY = 0

  private indicators: TimelineIndicators = { canScrollDown: false, placed: false }
  private readonly indicatorListeners = new Set<() => void>()
  private readonly viewportListeners = new Set<() => void>()
  private notifyFrame: number | null = null
  private detachScroller: (() => void) | null = null

  // ── DOM attachment ─────────────────────────────────────────────────────────

  setScroller = (el: HTMLDivElement | null): void => {
    if (el === this.scroller) return
    this.detachScroller?.()
    this.detachScroller = null
    this.scroller = el
    this.scrollerRef.current = el
    if (!el) return
    this.lastScrollTop = el.scrollTop
    this.ensureObserver()?.observe(el)
    this.detachScroller = this.listen(el)
    // The scroller wraps the list, so React attaches it after the list's first commit.
    if (this.input) this.layoutPass(true)
  }

  setList = (el: HTMLElement | null): void => {
    this.list = el
    if (!el) this.detachList()
  }

  setTopPad = (el: HTMLElement | null): void => {
    this.topPadEl = el
    if (el) el.style.height = `${this.topPad}px`
  }

  setBottomSlack = (el: HTMLElement | null): void => {
    this.bottomSlackEl = el
    if (el) el.style.height = `${this.bottomSlack}px`
  }

  /** Ref for content below the rows (the live overlay, queued turns, redo ghosts). */
  observeFooter = (el: HTMLElement | null): (() => void) | void => {
    if (!el) return
    this.footers.add(el)
    this.ensureObserver()?.observe(el)
    return () => {
      this.footers.delete(el)
      this.observer?.unobserve(el)
    }
  }

  /** Stable ref callback for one row. */
  rowRef(key: string): (el: HTMLElement | null) => (() => void) {
    let ref = this.rowRefs.get(key)
    if (!ref) {
      ref = (el) => {
        if (el) {
          this.rowEls.set(key, el)
          this.ensureObserver()?.observe(el)
        }
        return () => {
          if (el && this.rowEls.get(key) === el) this.rowEls.delete(key)
          if (el) this.observer?.unobserve(el)
        }
      }
      this.rowRefs.set(key, ref)
    }
    return ref
  }

  private ensureObserver(): ResizeObserver | null {
    if (this.observer || typeof ResizeObserver === "undefined") return this.observer
    this.observer = new ResizeObserver(() => this.layoutPass(false))
    return this.observer
  }

  private listen(el: HTMLDivElement): () => void {
    const onScroll = () => this.onScroll()
    const onWheel = (event: WheelEvent) => {
      this.clearUserAnchors()
      this.dispatch({ type: "wheel", deltaY: event.deltaY })
    }
    const onTouchStart = (event: TouchEvent) => {
      this.touching = true
      this.touchY = event.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? this.touchY
      this.clearUserAnchors()
      this.dispatch({ type: "touchmove", dy: y - this.touchY })
      this.touchY = y
    }
    const onTouchEnd = () => {
      this.touching = false
      this.scheduleIdle()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return
      if ((event.key === "Enter" || event.key === " ") && isActivatable(event.target) && event.target !== el) {
        this.activate(event.target)
        return
      }
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) this.clearUserAnchors()
      this.dispatch({ type: "key", key: event.key, shiftKey: event.shiftKey })
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === el) {
        this.scrollbarHeld = true
        this.clearUserAnchors()
        this.dispatch({ type: "scrollbar" })
      } else if (event.button === 0 && event.target instanceof Element) {
        this.activate(event.target)
      }
    }
    const onPointerUp = () => {
      if (!this.scrollbarHeld) return
      this.scrollbarHeld = false
      this.scheduleIdle()
    }
    const onFocusIn = (event: FocusEvent) => this.setPins("focus", this.rowKeysOf([event.target]))
    const onFocusOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !el.contains(event.relatedTarget)) this.setPins("focus", [])
    }
    const onSelectionChange = () => {
      const selection = document.getSelection()
      this.setPins("selection", selection && selection.rangeCount > 0 ? this.rowKeysOf([selection.anchorNode, selection.focusNode]) : [])
    }

    el.addEventListener("scroll", onScroll, { passive: true })
    el.addEventListener("wheel", onWheel, { passive: true })
    el.addEventListener("touchstart", onTouchStart, { passive: true })
    el.addEventListener("touchmove", onTouchMove, { passive: true })
    el.addEventListener("touchend", onTouchEnd)
    el.addEventListener("touchcancel", onTouchEnd)
    el.addEventListener("keydown", onKeyDown)
    el.addEventListener("pointerdown", onPointerDown)
    el.addEventListener("focusin", onFocusIn)
    el.addEventListener("focusout", onFocusOut)
    document.addEventListener("pointerup", onPointerUp)
    document.addEventListener("pointercancel", onPointerUp)
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      el.removeEventListener("scroll", onScroll)
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("touchend", onTouchEnd)
      el.removeEventListener("touchcancel", onTouchEnd)
      el.removeEventListener("keydown", onKeyDown)
      el.removeEventListener("pointerdown", onPointerDown)
      el.removeEventListener("focusin", onFocusIn)
      el.removeEventListener("focusout", onFocusOut)
      document.removeEventListener("pointerup", onPointerUp)
      document.removeEventListener("pointercancel", onPointerUp)
      document.removeEventListener("selectionchange", onSelectionChange)
      this.observer?.unobserve(el)
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private detachList(): void {
    this.endNavigation(false)
    this.anchor = null
    this.renderedTops = new Map()
    this.pins.clear()
    this.range = null
    this.setPlan(EMPTY_PLAN, null)
  }

  // ── Stores for React ───────────────────────────────────────────────────────

  subscribePlan = (listener: () => void): (() => void) => {
    this.planListeners.add(listener)
    return () => this.planListeners.delete(listener)
  }

  getPlan = (): RenderPlan => this.plan

  subscribeIndicators = (listener: () => void): (() => void) => {
    this.indicatorListeners.add(listener)
    return () => this.indicatorListeners.delete(listener)
  }

  getIndicators = (): TimelineIndicators => this.indicators

  // ── Inputs ─────────────────────────────────────────────────────────────────

  /** The next session opens at its top instead of following the bottom (sub-agent views). */
  requestTopOnNextSession(): void {
    this.topOnNextSession = true
  }

  setHistoryBytes(history: HistoryBytes): void {
    this.history = history
  }

  /** Called from the list's layout effect after every commit. */
  commit(input: TimelineRowsInput): void {
    this.applyInput(input)
    this.layoutPass(true)
  }

  private applyInput(input: TimelineRowsInput): void {
    const previous = this.input
    this.input = input
    if (input.sessionChangeKey !== this.sessionChangeKey) this.startSession(input.sessionChangeKey)
    if (!this.heightStore || previous?.sessionKey !== input.sessionKey) this.heightStore = timelineHeights.forSession(input.sessionKey)
    if (previous?.expandAll !== input.expandAll || !sameKeys(input.keys, this.keys)) {
      this.keys = input.keys
      this.indexOf = new Map(input.keys.map((key, index) => [key, index]))
      this.rebuildHeights()
    }
  }

  private startSession(sessionChangeKey: number): void {
    this.sessionChangeKey = sessionChangeKey
    this.placement = this.topOnNextSession ? "top" : "bottom"
    this.topOnNextSession = false
    this.endNavigation(false)
    this.anchor = null
    this.liveHeights.clear()
    this.renderedTops = new Map()
    this.pins.clear()
    this.follow = { following: this.placement === "bottom", userInput: false }
    this.writeTopPad(0)
    this.writeBottomSlack(0)
    this.setIndicators({ canScrollDown: false, placed: false })
  }

  private rebuildHeights(): void {
    const store = this.heightStore
    const expandAll = this.input?.expandAll ?? false
    const average = store?.average(this.bucket, expandAll) ?? DEFAULT_ROW_HEIGHT
    this.heights = Float64Array.from(this.keys, (key) => this.liveHeights.get(key) ?? store?.get(key, this.bucket, expandAll) ?? average)
  }

  // ── Layout pass ────────────────────────────────────────────────────────────

  /**
   * Runs after every commit and resize: measure, keep the anchor (or the
   * bottom) in place, then re-plan the range. A resize re-plans at once only
   * when the viewport is no longer covered; otherwise the next scroll, commit
   * or idle does it, so a resize callback rarely mounts rows.
   */
  private layoutPass(fromCommit: boolean): void {
    const scroller = this.scroller
    if (!scroller || !this.input) return
    const newPlan = this.appliedPlanVersion !== this.planVersion
    this.appliedPlanVersion = this.planVersion

    if (this.placement === "top") {
      this.measureRows()
      this.placeTop()
    } else if (this.follow.following) {
      if (newPlan) this.placeFirstRow()
      this.measureRows()
      this.pinToBottom()
    } else {
      const navigating = this.navigation !== null
      if (navigating) this.landNavigation()
      else if (!this.keepAnchor() && newPlan) this.placeFirstRow()
      this.measureRows()
    }

    if (fromCommit || this.replanPending || !this.viewportCovered()) this.replan()
    else this.replanPending = true
    this.recordAnchor()
    this.updateIndicators()
    this.maybeLoadOlder()
    this.notifyViewport()
  }

  private measureRows(): void {
    const scroller = this.scroller!
    const list = this.list
    const expandAll = this.input?.expandAll ?? false
    if (list) {
      const bucket = widthBucket(list.clientWidth)
      if (bucket !== this.bucket) {
        this.bucket = bucket
        this.liveHeights.clear()
        this.rebuildHeights()
      }
    }
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop
    const tops = new Map<number, number>()
    for (const [key, el] of this.rowEls) {
      const index = this.indexOf.get(key)
      if (index === undefined) continue
      const rect = el.getBoundingClientRect()
      tops.set(index, rect.top - origin)
      if (this.liveHeights.get(key) === rect.height) continue
      this.liveHeights.set(key, rect.height)
      this.heights[index] = rect.height
      if (!isAnimatingSize(el)) this.heightStore?.set(key, this.bucket, expandAll, rect.height)
    }
    this.renderedTops = tops
  }

  private viewTopOffset(): number {
    const scroller = this.scroller!
    return parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0
  }

  /** Viewport y of the line the reader reads from: the scroller top below its scroll padding. */
  private viewTop(): number {
    return this.scroller!.getBoundingClientRect().top + this.viewTopOffset()
  }

  private maxScrollTop(): number {
    const scroller = this.scroller!
    return scroller.scrollHeight - scroller.clientHeight
  }

  private distanceToBottom(): number {
    return this.maxScrollTop() - this.bottomSlack - this.scroller!.scrollTop
  }

  private writeScrollTop(value: number): void {
    const scroller = this.scroller!
    scroller.scrollTop = Math.max(0, value)
    this.ownScrollTop = scroller.scrollTop
    this.lastScrollTop = scroller.scrollTop
  }

  private writeTopPad(value: number): void {
    this.topPad = Math.max(0, value)
    if (this.topPadEl) this.topPadEl.style.height = `${this.topPad}px`
  }

  private writeBottomSlack(value: number): void {
    this.bottomSlack = Math.max(0, value)
    if (this.bottomSlackEl) this.bottomSlackEl.style.height = `${this.bottomSlack}px`
  }

  private firstRendered(): { index: number; el: HTMLElement } | null {
    let best: { index: number; el: HTMLElement } | null = null
    for (const [key, el] of this.rowEls) {
      const index = this.indexOf.get(key)
      if (index !== undefined && (!best || index < best.index)) best = { index, el }
    }
    return best
  }

  /** Content offset of an element. */
  private contentTop(el: Element): number {
    const scroller = this.scroller!
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  }

  /** Puts a newly planned first row where the plan estimated it, when no anchor can say better. */
  private placeFirstRow(): void {
    const first = this.firstRendered()
    if (!first || this.plannedFirstTop === null) {
      if (!first) this.writeTopPad(this.topPadTarget())
      return
    }
    this.writeTopPad(this.topPad + this.plannedFirstTop - this.contentTop(first.el))
  }

  private topPadTarget(): number {
    const first = this.firstRendered()
    return this.reserve() + (first ? sumHeights(this.heights, 0, first.index) : 0)
  }

  private reserve(): number {
    const input = this.input
    if (!input || !this.scroller) return 0
    return reserveHeight({
      hasMore: input.hasMore,
      viewport: this.scroller.clientHeight,
      remainingBytes: this.history.remaining,
      loadedBytes: this.history.loaded,
      loadedHeight: sumHeights(this.heights, 0, this.heights.length),
    })
  }

  private pinToBottom(): void {
    if (this.bottomSlack !== 0) this.writeBottomSlack(0)
    const target = this.maxScrollTop()
    if (Math.abs(this.scroller!.scrollTop - target) >= 0.5) this.writeScrollTop(target)
    const last = this.keys[this.keys.length - 1]
    if (this.placement === "bottom" && (last === undefined || this.rowEls.has(last))) this.markPlaced()
  }

  private placeTop(): void {
    const first = this.firstRendered()
    if (!first && this.keys.length > 0) return
    this.writeTopPad(this.topPadTarget())
    this.writeScrollTop(first && this.list ? this.contentTop(first.el) - this.contentTop(this.list) : 0)
    this.markPlaced()
  }

  private markPlaced(): void {
    this.placement = null
    this.setIndicators({ ...this.indicators, placed: true })
  }

  /** Cancels any movement of the anchor; false when there is no anchor to keep. */
  private keepAnchor(): boolean {
    const scroller = this.scroller!
    const anchor = this.anchor
    const el = anchor?.elements.find((candidate) => candidate.isConnected)
    if (!anchor || !el) return false
    const offset = el.getBoundingClientRect().top - this.viewTop()
    const scrollTop = scroller.scrollTop
    const contentShift = offset + scrollTop - (anchor.offset + anchor.scrollTop)
    const clamped = scrollTop < anchor.scrollTop - 0.5 && scrollTop >= this.maxScrollTop() - 1
    if (Math.abs(contentShift) < 0.5 && !clamped) return true
    if (anchor.kind === "navigation") this.navigationMovedAt = performance.now()

    const next = absorb({ topPad: this.topPad, contentShift, scrollTop: clamped ? anchor.scrollTop : scrollTop })
    this.writeTopPad(next.topPad)
    const slack = slackForTarget({
      target: next.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      bottomSlack: this.bottomSlack,
    })
    if (slack !== this.bottomSlack) this.writeBottomSlack(slack)
    if (Math.abs(scroller.scrollTop - next.scrollTop) >= 0.5) this.writeScrollTop(next.scrollTop)
    return true
  }

  private landNavigation(): void {
    const navigation = this.navigation!
    if (!this.indexOf.has(navigation.key)) {
      this.endNavigation(false)
      this.setPins("navigation", [])
      return
    }
    const row = this.rowEls.get(navigation.key)
    if (!row) return
    const found = navigation.target?.(row) ?? null
    const waiting = navigation.target !== undefined && !found && navigation.framesLeft > 0
    const target = found ?? row
    const scroller = this.scroller!
    const rect = target.getBoundingClientRect()
    const visible = scroller.clientHeight - this.viewTopOffset()
    const desired = navigation.align === "center" && rect.height < visible ? (visible - rect.height) / 2 : 0
    const scrollTop = Math.min(this.maxScrollTop() - this.bottomSlack, scroller.scrollTop + rect.top - this.viewTop() - desired)
    this.writeScrollTop(scrollTop)
    this.anchor = {
      elements: target === row ? [row] : [target, row],
      offset: target.getBoundingClientRect().top - this.viewTop(),
      scrollTop: scroller.scrollTop,
      kind: "navigation",
    }
    this.navigationMovedAt = performance.now()
    if (waiting) {
      // The row is in place; every layout pass (a resize when the group
      // opens) tries the target again, and a frame tick covers a quiet one.
      navigation.framesLeft--
      navigation.retry ??= requestAnimationFrame(() => {
        navigation.retry = null
        if (this.navigation === navigation && this.scroller) this.landNavigation()
      })
      return
    }
    this.endNavigation(true)
  }

  private endNavigation(landed: boolean): void {
    const navigation = this.navigation
    if (!navigation) return
    if (navigation.retry !== null) cancelAnimationFrame(navigation.retry)
    this.navigation = null
    navigation.resolve(landed)
  }

  /** Re-records where the anchor is now, picking a fresh default anchor when there is none to keep. */
  private recordAnchor(): void {
    if (this.follow.following || this.placement !== null) {
      this.anchor = null
      return
    }
    const anchor = this.anchor
    if (anchor?.kind === "navigation" && performance.now() - this.navigationMovedAt > NAVIGATION_HOLD_MS) {
      this.setPins("navigation", [])
      this.anchor = null
    }
    const kept = this.anchor && this.anchor.kind !== "default" ? this.anchor.elements.find((el) => el.isConnected) : undefined
    if (kept && this.anchor) {
      this.anchor = { ...this.anchor, offset: kept.getBoundingClientRect().top - this.viewTop(), scrollTop: this.scroller!.scrollTop }
      return
    }
    this.anchor = this.pickDefaultAnchor()
  }

  /**
   * The deepest element crossing the viewport top (or just below it), with
   * its ancestors up to the row as fallbacks. Null when no rendered row is on
   * screen: a row off screen says nothing about what the reader sees.
   */
  private pickDefaultAnchor(): Anchor | null {
    const scroller = this.scroller!
    const viewTop = this.viewTop()
    const lineContent = viewTop - scroller.getBoundingClientRect().top + scroller.scrollTop
    const viewBottom = scroller.scrollTop + scroller.clientHeight
    let row: HTMLElement | null = null
    let rowIndex = Infinity
    for (const [index, top] of this.renderedTops) {
      const key = this.keys[index]
      const el = key === undefined ? undefined : this.rowEls.get(key)
      if (!el) continue
      if (top <= lineContent && top + this.heights[index] > lineContent) {
        row = el
        break
      }
      if (top > lineContent && top < viewBottom && index < rowIndex) {
        row = el
        rowIndex = index
      }
    }
    if (!row) return null
    const elements = anchorPath(row, viewTop)
    return {
      elements,
      offset: elements[0].getBoundingClientRect().top - viewTop,
      scrollTop: scroller.scrollTop,
      kind: "default",
    }
  }

  // ── Range planning ─────────────────────────────────────────────────────────

  /** The committed range without its pinned islands. */
  private currentRange(): Extent | null {
    const range = this.range
    if (!range) return null
    const start = this.indexOf.get(range.first)
    const last = this.indexOf.get(range.last)
    return start === undefined || last === undefined || last < start ? null : { start, end: last + 1 }
  }

  /** Row tops in content coordinates, from the rendered rows or, before any render, from where the first would go. */
  private geometry(): Float64Array {
    let known = this.renderedTops
    if (known.size === 0) {
      const firstSlot = this.topPadEl ? this.contentTop(this.topPadEl) + this.reserve() : this.list ? this.contentTop(this.list) : 0
      known = new Map([[0, firstSlot]])
    }
    return layoutTops(this.heights, known)
  }

  private viewportCovered(): boolean {
    const scroller = this.scroller!
    const range = this.currentRange()
    const n = this.keys.length
    if (n === 0) return true
    if (!range) return false
    const tops = this.geometry()
    const viewTop = scroller.scrollTop
    const top = range.start === 0 ? -Infinity : tops[range.start]
    const bottom = range.end >= n ? Infinity : tops[range.end - 1] + this.heights[range.end - 1]
    return top <= viewTop && bottom >= viewTop + scroller.clientHeight
  }

  private replan(): void {
    this.replanPending = false
    const scroller = this.scroller
    if (!scroller) return
    const n = this.keys.length
    if (n === 0) {
      this.range = null
      this.setPlan(EMPTY_PLAN, null)
      return
    }
    const tops = this.geometry()
    const viewport = scroller.clientHeight
    const lastBottom = tops[n - 1] + this.heights[n - 1]
    const viewTop = this.placement === "top"
      ? tops[0]
      : this.follow.following ? Math.max(tops[0], lastBottom - viewport) : scroller.scrollTop
    const range = planRange({
      tops,
      heights: this.heights,
      current: this.currentRange(),
      viewTop,
      viewport,
      follow: this.follow.following && this.placement !== "top",
    })
    const pinned: number[] = []
    for (const keys of this.pins.values()) {
      for (const key of keys) {
        const index = this.indexOf.get(key)
        if (index !== undefined) pinned.push(index)
      }
    }
    this.range = range.end > range.start ? { first: this.keys[range.start], last: this.keys[range.end - 1] } : null
    const segments = mergeSegments(range, pinned, n)
    const gaps = segments.map((segment, i) => i === 0 ? 0 : sumHeights(this.heights, segments[i - 1].end, segment.start))
    const last = segments[segments.length - 1]
    const plan: RenderPlan = {
      segments: segments.map((segment) => ({ first: this.keys[segment.start], last: this.keys[segment.end - 1] })),
      gaps,
      bottomPad: last ? sumHeights(this.heights, last.end, n) : 0,
    }
    this.setPlan(plan, segments[0] ? tops[segments[0].start] : null)
  }

  private setPlan(plan: RenderPlan, firstTop: number | null): void {
    const current = this.plan
    const same = current.segments.length === plan.segments.length
      && current.segments.every((segment, i) => segment.first === plan.segments[i].first && segment.last === plan.segments[i].last)
      && current.gaps.every((gap, i) => Math.abs(gap - plan.gaps[i]) < PLAN_TOLERANCE)
      && Math.abs(current.bottomPad - plan.bottomPad) < PLAN_TOLERANCE
    if (same) return
    this.plan = plan
    this.plannedFirstTop = firstTop
    this.planVersion++
    for (const listener of this.planListeners) listener()
  }

  private setPins(reason: "navigation" | "activation" | "focus" | "selection", keys: Iterable<string>): void {
    const next = new Set(keys)
    const current = this.pins.get(reason)
    if (current && current.size === next.size && [...next].every((key) => current.has(key))) return
    if (!current && next.size === 0) return
    this.pins.set(reason, next)
    if (this.scroller && this.input) this.replan()
  }

  private rowKeysOf(nodes: Array<EventTarget | Node | null>): string[] {
    const keys: string[] = []
    for (const node of nodes) {
      const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null
      const row = element?.closest<HTMLElement>(ROW_SELECTOR)
      const key = row?.dataset.rowKey
      if (key && this.scroller?.contains(row)) keys.push(key)
    }
    return keys
  }

  // ── Scrolling and input ────────────────────────────────────────────────────

  private onScroll(): void {
    const scroller = this.scroller
    if (!scroller) return
    const current = scroller.scrollTop
    const own = this.ownScrollTop !== null && Math.abs(current - this.ownScrollTop) < 1
    this.ownScrollTop = null
    this.dispatch({
      type: "scroll",
      previous: this.lastScrollTop,
      current,
      maxScrollTop: this.maxScrollTop(),
      own,
      distanceToBottom: this.distanceToBottom(),
    })
    this.lastScrollTop = current
    if (this.input) {
      this.recordAnchor()
      this.replan()
      this.maybeLoadOlder()
    }
    this.updateIndicators()
    this.scheduleIdle()
    this.notifyViewport()
  }

  private dispatch(event: FollowEvent): void {
    const previous = this.follow
    this.follow = followReducer(previous, event)
    if (previous.following && !this.follow.following) {
      // The reader took over before the open placement landed.
      if (this.placement === "bottom") this.markPlaced()
      if (this.scroller && this.input) this.recordAnchor()
    } else if (!previous.following && this.follow.following) {
      this.anchor = null
      this.setPins("activation", [])
      if (this.scroller && this.input) {
        this.pinToBottom()
        this.replan()
      }
    }
    if (event.type !== "scroll" && event.type !== "idle") this.scheduleIdle()
    this.updateIndicators()
  }

  /** Scroll input ends the activation and navigation anchors. */
  private clearUserAnchors(): void {
    this.endNavigation(false)
    if (this.anchor && this.anchor.kind !== "default") this.anchor = null
    this.setPins("activation", [])
    this.setPins("navigation", [])
  }

  /** Keeps the activated control under the pointer while what it toggles resizes. */
  private activate(target: Element): void {
    const scroller = this.scroller
    if (!scroller) return
    this.dispatch({ type: "activate" })
    const block = target.closest(ANCHOR_SELECTOR)
    const row = target.closest<HTMLElement>(ROW_SELECTOR)
    const elements = [target, block, row].filter((el, i, all): el is Element => el !== null && all.indexOf(el) === i)
    this.anchor = {
      elements,
      offset: target.getBoundingClientRect().top - this.viewTop(),
      scrollTop: scroller.scrollTop,
      kind: "activation",
    }
    this.setPins("activation", row?.dataset.rowKey ? [row.dataset.rowKey] : [])
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.touching || this.scrollbarHeld) return
      this.onIdle()
    }, IDLE_MS)
  }

  /** Puts the slack back to its estimate where nobody can see it move. */
  private onIdle(): void {
    const scroller = this.scroller
    this.dispatch({ type: "idle" })
    if (!scroller || !this.input || this.placement !== null) return
    const next = normalizeTop({ topPad: this.topPad, target: this.topPadTarget(), scrollTop: scroller.scrollTop })
    if (Math.abs(next.topPad - this.topPad) >= 1) {
      this.writeTopPad(next.topPad)
      this.writeScrollTop(next.scrollTop)
    }
    if (this.follow.following) {
      this.pinToBottom()
    } else if (this.bottomSlack > 0) {
      this.writeBottomSlack(trimBottomSlack({
        bottomSlack: this.bottomSlack,
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
        clientHeight: scroller.clientHeight,
      }))
    }
    this.measureRows()
    this.replan()
    this.recordAnchor()
    this.updateIndicators()
    this.maybeLoadOlder()
  }

  private maybeLoadOlder(): void {
    const input = this.input
    const scroller = this.scroller
    if (!input?.onLoadMore || !scroller) return
    const firstRowTop = this.keys.length > 0 ? this.geometry()[0] : 0
    if (shouldLoadOlder({
      hasMore: input.hasMore,
      loading: input.isLoadingOlder,
      placed: this.indicators.placed,
      viewport: scroller.clientHeight,
      viewTop: scroller.scrollTop,
      firstRowTop,
    })) input.onLoadMore()
  }

  private updateIndicators(): void {
    if (!this.scroller) return
    const canScrollDown = !this.follow.following && this.distanceToBottom() > 10
    if (canScrollDown !== this.indicators.canScrollDown) this.setIndicators({ ...this.indicators, canScrollDown })
  }

  private setIndicators(next: TimelineIndicators): void {
    if (next.canScrollDown === this.indicators.canScrollDown && next.placed === this.indicators.placed) return
    this.indicators = next
    for (const listener of this.indicatorListeners) listener()
  }

  private notifyViewport(): void {
    if (this.viewportListeners.size === 0 || this.notifyFrame !== null) return
    this.notifyFrame = requestAnimationFrame(() => {
      this.notifyFrame = null
      for (const listener of this.viewportListeners) listener()
    })
  }

  // ── TimelineHandle ─────────────────────────────────────────────────────────

  scrollToTurn = (turnKey: string, opts: ScrollToTurnOptions = {}): Promise<boolean> => {
    if (!this.scroller || !this.input || !this.indexOf.has(turnKey)) return Promise.resolve(false)
    this.endNavigation(false)
    return new Promise<boolean>((resolve) => {
      this.dispatch({ type: "navigate" })
      this.placement = null
      this.navigation = { key: turnKey, align: opts.align ?? "start", target: opts.target, resolve, framesLeft: TARGET_RETRY_FRAMES, retry: null }
      this.setPins("navigation", [turnKey])
      if (this.rowEls.has(turnKey)) {
        this.landNavigation()
        this.measureRows()
        this.replan()
        this.recordAnchor()
        this.updateIndicators()
      }
    })
  }

  scrollToBottom = (): void => {
    this.clearUserAnchors()
    this.dispatch({ type: "resume" })
    if (this.scroller && this.input) this.pinToBottom()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.viewportListeners.add(listener)
    return () => this.viewportListeners.delete(listener)
  }

  getViewport = (): TimelineViewport => {
    const scroller = this.scroller
    if (!scroller) return { firstVisibleKey: null, atBottom: true }
    const line = scroller.scrollTop + this.viewTopOffset()
    let firstVisibleKey: string | null = null
    if (this.keys.length > 0) {
      const tops = this.geometry()
      const { start } = rowsOverlapping(tops, this.heights, line, line + 1)
      firstVisibleKey = this.keys[start] ?? null
    }
    return { firstVisibleKey, atBottom: this.follow.following || this.distanceToBottom() <= RESUME_DISTANCE }
  }
}
