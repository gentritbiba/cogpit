import { act, cleanup, render } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useRowWindow, WINDOW_MIN } from "../useRowWindow"

const ROW = 40
const VIEW = 400

function List({ count }: { count: number }) {
  const list = useRef<HTMLUListElement>(null)
  const range = useRowWindow(list, count)
  return (
    <div data-slot="scroll-area-viewport" data-testid="scroller">
      <ul ref={list} data-before={range.before} data-after={range.after}>
        {Array.from({ length: range.end - range.start }, (_, index) => <li key={range.start + index}>{range.start + index}</li>)}
      </ul>
    </div>
  )
}

/** Lays the list out as a browser would: rows ROW tall, the scroller VIEW tall and scrolled by `scrollTop`. */
function layout(scrollTop: () => number) {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.tagName === "LI" ? ROW : 0 })
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.slot === "scroll-area-viewport" ? VIEW : 0 })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { top: this.tagName === "UL" ? -scrollTop() : 0 } as DOMRect
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const shown = (container: HTMLElement) => [...container.querySelectorAll("li")].map((item) => Number(item.textContent))

describe("useRowWindow", () => {
  it("renders a short list whole", () => {
    layout(() => 0)
    const { container } = render(<List count={WINDOW_MIN} />)
    expect(shown(container)).toHaveLength(WINDOW_MIN)
  })

  it("renders only the rows near the visible part of a long list, with room for the rest", () => {
    let top = 0
    layout(() => top)
    const { container, getByTestId } = render(<List count={600} />)
    expect(shown(container)).toEqual(Array.from({ length: VIEW / ROW + 12 }, (_, index) => index))
    expect(container.querySelector("ul")).toHaveAttribute("data-after", String((600 - 22) * ROW))

    top = 10_000
    act(() => { getByTestId("scroller").dispatchEvent(new Event("scroll")) })
    const rows = shown(container)
    expect(rows[0]).toBe(250 - 12)
    expect(rows.at(-1)).toBe(250 + VIEW / ROW + 12 - 1)
    expect(container.querySelector("ul")).toHaveAttribute("data-before", String((250 - 12) * ROW))
  })

  it("follows the list when content above it in the scroller changes height", () => {
    let top = 0
    layout(() => top)
    const { container, rerender } = render(<List count={600} />)
    expect(shown(container)[0]).toBe(0)
    top = 4_000
    rerender(<List count={600} />)
    expect(shown(container)[0]).toBe(100 - 12)
  })

  it("renders everything when nothing can be measured", () => {
    const { container } = render(<List count={300} />)
    expect(shown(container)).toHaveLength(300)
  })
})
