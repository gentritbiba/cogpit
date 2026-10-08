import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { SessionInputFooter } from "../SessionInputFooter"

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("floating conversation footer", () => {
  it("reserves space for changing controls and restores the container when it stops floating", () => {
    let height = 140
    let resize!: ResizeObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe() {}
      disconnect = disconnect
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ height }) as DOMRect)
    const { container, rerender } = render(<div style={{ "--session-footer-height": "90px" } as React.CSSProperties}><SessionInputFooter floating>Composer</SessionInputFooter></div>)
    const column = container.firstElementChild as HTMLElement
    expect(column.style.getPropertyValue("--session-footer-height")).toBe("140px")
    height = 300
    act(() => resize([], {} as ResizeObserver))
    expect(column.style.getPropertyValue("--session-footer-height")).toBe("300px")
    rerender(<div style={{ "--session-footer-height": "90px" } as React.CSSProperties}><SessionInputFooter>Composer</SessionInputFooter></div>)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(column.style.getPropertyValue("--session-footer-height")).toBe("90px")
  })

  it("removes its measurement on unmount so it cannot affect another session", () => {
    const disconnect = vi.fn()
    vi.stubGlobal("ResizeObserver", class { observe() {}; disconnect = disconnect })
    const { container, unmount } = render(<div><SessionInputFooter floating>Composer</SessionInputFooter></div>)
    const column = container.firstElementChild as HTMLElement
    expect(column.style.getPropertyValue("--session-footer-height")).toBe("0px")
    unmount()
    expect(column.style.getPropertyValue("--session-footer-height")).toBe("")
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
