import { useLayoutEffect, useRef, useState, type RefObject } from "react"

/** Lists this long or shorter render every row. */
export const WINDOW_MIN = 80
const OVERSCAN = 12

export interface RowWindow {
  start: number
  end: number
  /** Room the rows outside the window take, above and below it. */
  before: number
  after: number
}

const ALL = (count: number): RowWindow => ({ start: 0, end: count, before: 0, after: 0 })
const same = (a: RowWindow, b: RowWindow) => a.start === b.start && a.end === b.end && a.before === b.before && a.after === b.after
const keep = (next: RowWindow) => (current: RowWindow) => (same(current, next) ? current : next)

/** Keeps the current window while it still holds rows `first` to `last` at this row height. */
const cover = (next: RowWindow, first: number, last: number, count: number, rowHeight: number) => (current: RowWindow) =>
  current.start <= first && current.end >= last
    && current.before === current.start * rowHeight && current.after === (count - current.end) * rowHeight
    ? current
    : next

function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (at.dataset.slot === "scroll-area-viewport") return at
    const { overflowY } = getComputedStyle(at)
    if (overflowY === "auto" || overflowY === "scroll") return at
  }
  return null
}

/**
 * The rows of a long list of equal-height rows that sit near the visible part
 * of its scroller, which may scroll other content too. The row height is the
 * tallest rendered row seen so far, so rows of slightly different heights
 * cannot make the window flip between two positions. Short lists, and lists
 * that cannot be measured, render whole.
 */
export function useRowWindow(list: RefObject<HTMLElement | null>, count: number): RowWindow {
  const [range, setRange] = useState<RowWindow>(() => ALL(Math.min(count, WINDOW_MIN)))
  const follow = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    const element = list.current
    const scroller = element && count > WINDOW_MIN ? scrollerOf(element) : null
    if (!element || !scroller) {
      setRange(keep(ALL(count)))
      return
    }
    let rowHeight = 0
    const update = () => {
      const row = element.firstElementChild as HTMLElement | null
      if (row) rowHeight = Math.max(rowHeight, row.offsetHeight)
      if (rowHeight === 0 || scroller.clientHeight === 0) {
        setRange(keep(ALL(count)))
        return
      }
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const first = Math.max(0, Math.floor(-top / rowHeight))
      const last = Math.max(first, Math.min(count, Math.ceil((scroller.clientHeight - top) / rowHeight)))
      const start = Math.max(0, first - OVERSCAN)
      const end = Math.min(count, last + OVERSCAN)
      setRange(cover({ start, end, before: start * rowHeight, after: (count - end) * rowHeight }, first, last, count, rowHeight))
    }
    follow.current = update
    update()
    scroller.addEventListener("scroll", update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    return () => {
      follow.current = () => {}
      scroller.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [count, list])

  // Content above the list in the same scroller can grow or shrink without a scroll or resize.
  useLayoutEffect(() => { follow.current() })

  return range.end > count ? ALL(count) : range
}
