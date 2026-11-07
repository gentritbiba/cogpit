import { useLayoutEffect, useState, type RefObject } from "react"

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
 * of its scroller, which may scroll other content too. The row height is
 * measured from a rendered row. Short lists, and lists that cannot be
 * measured, render whole.
 */
export function useRowWindow(list: RefObject<HTMLElement | null>, count: number): RowWindow {
  const [range, setRange] = useState<RowWindow>(() => ALL(Math.min(count, WINDOW_MIN)))

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
      if (row && row.offsetHeight > 0) rowHeight = row.offsetHeight
      if (rowHeight === 0 || scroller.clientHeight === 0) {
        setRange(keep(ALL(count)))
        return
      }
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const start = Math.max(0, Math.floor(-top / rowHeight) - OVERSCAN)
      const end = Math.max(start, Math.min(count, Math.ceil((scroller.clientHeight - top) / rowHeight) + OVERSCAN))
      setRange(keep({ start, end, before: start * rowHeight, after: (count - end) * rowHeight }))
    }
    update()
    scroller.addEventListener("scroll", update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [count, list])

  return range.end > count ? ALL(count) : range
}
