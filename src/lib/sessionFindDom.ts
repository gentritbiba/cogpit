import { occurrencesIn, queryPattern } from "@/lib/sessionFind"

const ROW_SELECTOR = "[data-row-key]"
const TOOL_SELECTOR = "[data-tool-call-id]"

function rowSelector(turnKey: string): string {
  return `[data-row-key="${CSS.escape(turnKey)}"]`
}

export function toolSelector(callId: string): string {
  return `[data-tool-call-id="${CSS.escape(callId)}"]`
}

/** Where one occurrence sits in the DOM; turned into a Range or StaticRange as needed. */
export interface Span {
  startContainer: Text
  startOffset: number
  endContainer: Text
  endOffset: number
}

/**
 * The occurrences of `query` in the text `scope` renders, in document order.
 * Text is read across element boundaries, so a match split by highlighting
 * spans is still found. Subtrees matching `skip` are left out. Reads the DOM
 * only.
 */
export function occurrenceSpans(scope: Element, query: string, skip?: string): Span[] {
  const pattern = queryPattern(query)
  if (!pattern) return []
  const walker = scope.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
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

  return occurrencesIn(text, pattern).map(([from, to]) => {
    const [startContainer, startOffset] = locate(from, false)
    const [endContainer, endOffset] = locate(to, true)
    return { startContainer, startOffset, endContainer, endOffset }
  })
}

export function toRange(span: Span): Range {
  const range = span.startContainer.ownerDocument.createRange()
  range.setStart(span.startContainer, span.startOffset)
  range.setEnd(span.endContainer, span.endOffset)
  return range
}

/** The element a match starts in, for navigation to land on. */
export function spanElement(span: Span): Element | null {
  return span.startContainer.parentElement
}

/** The match find is on, inside its turn's row or inside one tool call of it. */
export interface ActiveMatch {
  turnKey: string
  callId: string | null
  /** Which occurrence in that scope, counted from the start, or from the end when `fromEnd`. */
  nth: number
  fromEnd: boolean
}

/** The occurrences that stand for an active match in its mounted row: the tool card's own, or the row's outside tool cards. */
export function scopeSpans(row: Element, query: string, callId: string | null): { scope: Element; spans: Span[] } | null {
  const scope = callId === null ? row : row.querySelector(toolSelector(callId))
  if (!scope) return null
  return { scope, spans: occurrenceSpans(scope, query, callId === null ? TOOL_SELECTOR : undefined) }
}

/** The occurrence an active match stands for; the nearest one when the DOM shows fewer. */
export function pickSpan(spans: readonly Span[], nth: number, fromEnd: boolean): Span | null {
  if (spans.length === 0) return null
  const index = Math.min(nth, spans.length - 1)
  return spans[fromEnd ? spans.length - 1 - index : index]
}

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function"
}

function staticRange(span: Span): AbstractRange {
  return typeof StaticRange === "function" ? new StaticRange(span) : toRange(span)
}

const MATCH_HIGHLIGHT = "find-match"
const ACTIVE_HIGHLIGHT = "find-active"

/**
 * Paints find's matches in the mounted rows with the CSS Custom Highlight API,
 * which styles ranges without touching the DOM. A row is re-read when it
 * mounts or its content changes. Where the API is missing, or the active match
 * is not in its row's text, it reports the active row so find can draw a ring
 * over it instead.
 */
export class FindPainter {
  private scroller: HTMLElement | null = null
  private query = ""
  private active: ActiveMatch | null = null
  private readonly rows = new Map<Element, AbstractRange[]>()
  private activeSpan: { row: Element; span: Span | null } | null = null
  private ringRow: Element | null = null
  private observer: MutationObserver | null = null
  private frame: number | null = null
  private ringOnly = true

  constructor(private readonly onRing: (row: Element | null) => void) {}

  update(scroller: HTMLElement | null, query: string, active: ActiveMatch | null): void {
    const sameActive = active?.turnKey === this.active?.turnKey && active?.callId === this.active?.callId
      && active?.nth === this.active?.nth && active?.fromEnd === this.active?.fromEnd
    if (scroller === this.scroller && query === this.query && sameActive) return
    if (scroller !== this.scroller || query !== this.query) {
      this.rows.clear()
      this.observer?.disconnect()
      this.observer = null
    }
    this.scroller = scroller
    this.query = query
    this.active = active
    this.activeSpan = null
    if (scroller && query && !this.observer && typeof MutationObserver === "function") {
      this.observer = new MutationObserver((records) => this.invalidate(records))
      this.observer.observe(scroller, { childList: true, subtree: true, characterData: true })
    }
    this.schedule()
  }

  /** Repaint everything on the next frame. */
  schedule = (): void => {
    this.ringOnly = false
    this.request()
  }

  /** Scrolling moves only the ring; highlights follow their text by themselves. */
  scheduleRing = (): void => {
    if (this.ringRow) this.request()
  }

  private request(): void {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      if (this.ringOnly) {
        this.onRing(this.ringRow?.isConnected ? this.ringRow : null)
        return
      }
      this.ringOnly = true
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
    this.ringRow = null
    this.clearHighlights()
    this.onRing(null)
  }

  private invalidate(records: MutationRecord[]): void {
    let touched = false
    for (const record of records) {
      const target = record.target
      const el = target.nodeType === Node.ELEMENT_NODE ? target as Element : target.parentElement
      const row = el?.closest(ROW_SELECTOR)
      if (row) {
        this.rows.delete(row)
        if (this.activeSpan?.row === row) this.activeSpan = null
        touched = true
      } else if (record.type === "childList") {
        // Rows mounted or unmounted.
        touched = true
      }
    }
    if (touched) this.schedule()
  }

  private clearHighlights(): void {
    if (!supportsHighlights()) return
    CSS.highlights.delete(MATCH_HIGHLIGHT)
    CSS.highlights.delete(ACTIVE_HIGHLIGHT)
  }

  private paint(): void {
    const scroller = this.scroller
    if (!scroller || !this.query) {
      this.clearHighlights()
      this.ringRow = null
      this.onRing(null)
      return
    }
    for (const row of this.rows.keys()) if (!row.isConnected) this.rows.delete(row)

    let activeRow: Element | null = null
    let activeSpan: Span | null = null
    if (this.active) {
      activeRow = scroller.querySelector(rowSelector(this.active.turnKey))
      if (activeRow && this.activeSpan?.row !== activeRow) {
        const found = scopeSpans(activeRow, this.query, this.active.callId)
        this.activeSpan = { row: activeRow, span: found ? pickSpan(found.spans, this.active.nth, this.active.fromEnd) : null }
      }
      activeSpan = activeRow ? this.activeSpan?.span ?? null : null
    }

    const highlights = supportsHighlights()
    if (highlights) {
      const all = new Highlight()
      for (const row of scroller.querySelectorAll(ROW_SELECTOR)) {
        let ranges = this.rows.get(row)
        if (!ranges) this.rows.set(row, ranges = occurrenceSpans(row, this.query).map(staticRange))
        for (const range of ranges) all.add(range)
      }
      CSS.highlights.set(MATCH_HIGHLIGHT, all)
      if (activeSpan) {
        const current = new Highlight(staticRange(activeSpan))
        current.priority = 1
        CSS.highlights.set(ACTIVE_HIGHLIGHT, current)
      } else {
        CSS.highlights.delete(ACTIVE_HIGHLIGHT)
      }
    }
    this.ringRow = activeRow && (!highlights || !activeSpan) ? activeRow : null
    this.onRing(this.ringRow)
  }
}
