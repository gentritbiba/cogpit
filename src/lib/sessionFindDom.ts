import { foldCase, occurrencesIn } from "@/lib/sessionFind"

export const ROW_SELECTOR = "[data-row-key]"
export const TOOL_SELECTOR = "[data-tool-call-id]"

export function rowSelector(turnKey: string): string {
  return `[data-row-key="${CSS.escape(turnKey)}"]`
}

export function toolSelector(callId: string): string {
  return `[data-tool-call-id="${CSS.escape(callId)}"]`
}

/**
 * The occurrences of `query` in the text `scope` renders, as Ranges, in
 * document order. Text is read across element boundaries, so a match split
 * by highlighting spans is still found. Subtrees matching `skip` are left out.
 * Reads the DOM only.
 */
export function occurrenceRanges(scope: Element, query: string, skip?: string): Range[] {
  const q = foldCase(query)
  if (!q) return []
  const doc = scope.ownerDocument
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
      return skip && node !== scope && (node as Element).matches(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
    },
  })
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ""
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue) continue
    nodes.push(node as Text)
    starts.push(text.length)
    text += node.nodeValue
  }
  if (nodes.length === 0) return []

  // The last node starting at or before `offset`; `end` prefers the node the offset closes.
  const locate = (offset: number, end: boolean): [Text, number] => {
    let lo = 0
    let hi = nodes.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (end ? starts[mid] < offset : starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return [nodes[lo], offset - starts[lo]]
  }

  return occurrencesIn(foldCase(text), q).map((at) => {
    const range = doc.createRange()
    range.setStart(...locate(at, false))
    range.setEnd(...locate(at + q.length, true))
    return range
  })
}

/** The element a Range starts in, for navigation to land on. */
export function rangeElement(range: Range): Element | null {
  const node = range.startContainer
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

export function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function"
}

/** The match find is on: the `nth` occurrence inside its turn's row, or inside one tool call of it. */
export interface ActiveMatch {
  turnKey: string
  callId: string | null
  nth: number
}

/** The occurrences that stand for `active` in its mounted row, in the order the model counted them. */
export function activeScopeRanges(row: Element, query: string, callId: string | null): { scope: Element; ranges: Range[] } | null {
  const scope = callId === null ? row : row.querySelector(toolSelector(callId))
  if (!scope) return null
  return { scope, ranges: occurrenceRanges(scope, query, callId === null ? TOOL_SELECTOR : undefined) }
}

const MATCH_HIGHLIGHT = "find-match"
const ACTIVE_HIGHLIGHT = "find-active"

/**
 * Paints find's matches in the mounted rows with the CSS Custom Highlight API,
 * which styles Ranges without touching the DOM. Rows are re-read when they
 * mount or their content changes. Where the API is missing, or the active
 * match is not in the row's text, it reports the active row so find can draw
 * a ring over it instead.
 */
export class FindPainter {
  private scroller: HTMLElement | null = null
  private query = ""
  private active: ActiveMatch | null = null
  private readonly rows = new Map<Element, Range[]>()
  private activeRanges: { row: Element; ranges: Range[] | null } | null = null
  private observer: MutationObserver | null = null
  private frame: number | null = null
  private readonly highlights = supportsHighlights()

  constructor(private readonly onRing: (row: Element | null) => void) {}

  update(scroller: HTMLElement | null, query: string, active: ActiveMatch | null): void {
    const sameActive = active?.turnKey === this.active?.turnKey && active?.callId === this.active?.callId && active?.nth === this.active?.nth
    if (scroller === this.scroller && query === this.query && sameActive) return
    if (scroller !== this.scroller || query !== this.query) {
      this.rows.clear()
      this.observer?.disconnect()
      this.observer = null
    }
    this.scroller = scroller
    this.query = query
    this.active = active
    this.activeRanges = null
    if (scroller && query && !this.observer && typeof MutationObserver === "function") {
      this.observer = new MutationObserver((records) => this.invalidate(records))
      this.observer.observe(scroller, { childList: true, subtree: true, characterData: true })
    }
    this.schedule()
  }

  /** Repaint on the next frame; also the hook for scroll, which moves the ring. */
  schedule = (): void => {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.paint()
    })
  }

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.observer?.disconnect()
    this.observer = null
    this.rows.clear()
    this.scroller = null
    this.clearHighlights()
    this.onRing(null)
  }

  private invalidate(records: MutationRecord[]): void {
    for (const record of records) {
      const target = record.target
      const el = target.nodeType === Node.ELEMENT_NODE ? target as Element : target.parentElement
      const row = el?.closest(ROW_SELECTOR)
      if (!row) continue
      this.rows.delete(row)
      if (this.activeRanges?.row === row) this.activeRanges = null
    }
    this.schedule()
  }

  private clearHighlights(): void {
    if (!this.highlights) return
    CSS.highlights.delete(MATCH_HIGHLIGHT)
    CSS.highlights.delete(ACTIVE_HIGHLIGHT)
  }

  /** Paints now; exposed so tests and a landed navigation need not wait a frame. */
  paint(): void {
    const scroller = this.scroller
    if (!scroller || !this.query) {
      this.clearHighlights()
      this.onRing(null)
      return
    }
    for (const row of this.rows.keys()) if (!row.isConnected) this.rows.delete(row)

    let activeRange: Range | null = null
    let activeRow: Element | null = null
    if (this.active) {
      activeRow = scroller.querySelector(rowSelector(this.active.turnKey))
      if (activeRow && this.activeRanges?.row !== activeRow) {
        this.activeRanges = { row: activeRow, ranges: activeScopeRanges(activeRow, this.query, this.active.callId)?.ranges ?? null }
      }
      const ranges = activeRow ? this.activeRanges?.ranges : null
      if (ranges && ranges.length > 0) activeRange = ranges[Math.min(this.active.nth, ranges.length - 1)]
    }

    if (this.highlights) {
      const all = new Highlight()
      for (const row of scroller.querySelectorAll(ROW_SELECTOR)) {
        let ranges = this.rows.get(row)
        if (!ranges) this.rows.set(row, ranges = occurrenceRanges(row, this.query))
        for (const range of ranges) all.add(range)
      }
      CSS.highlights.set(MATCH_HIGHLIGHT, all)
      if (activeRange) {
        const current = new Highlight(activeRange)
        current.priority = 1
        CSS.highlights.set(ACTIVE_HIGHLIGHT, current)
      } else {
        CSS.highlights.delete(ACTIVE_HIGHLIGHT)
      }
    }
    this.onRing(activeRow && (!this.highlights || !activeRange) ? activeRow : null)
  }
}
