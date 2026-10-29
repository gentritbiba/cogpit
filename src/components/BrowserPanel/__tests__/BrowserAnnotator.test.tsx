import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BrowserAnnotator, cropRegion, type FrozenFrame } from "../BrowserAnnotator"

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() { this.callback([{ contentRect: { width: 400, height: 300 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
  disconnect() {}
  unobserve() {}
}

const drawImage = vi.fn()
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver)
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,Q1JPUA==")
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) })
  drawImage.mockClear()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function frame(): FrozenFrame {
  const canvas = document.createElement("canvas")
  canvas.width = 1600
  canvas.height = 1200
  return { canvas, deviceWidth: 800, deviceHeight: 600, url: "https://example.test/settings", title: "Settings", browser: "default", tab: "Settings", capturedAt: "2026-10-29T12:00:00.000Z" }
}

describe("BrowserAnnotator", () => {
  it("adds the whole page with its note and saved image when no region is drawn", () => {
    const onAdd = vi.fn((_item: unknown, _image: unknown) => null)
    const onCancel = vi.fn()
    render(<BrowserAnnotator frame={frame()} onAdd={onAdd} onCancel={onCancel} />)
    expect(screen.getByRole("status")).toHaveTextContent("Whole page selected")
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation note" }), { target: { value: "  Header overlaps  " } })
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }))
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "browser", note: "Header overlaps", url: "https://example.test/settings", title: "Settings", tab: "Settings", browser: "default", viewport: { width: 800, height: 600 }, region: { x: 0, y: 0, width: 800, height: 600 }, image: 1 }),
      { id: expect.any(String), mediaType: "image/jpeg", data: "Q1JPUA==" },
    )
    expect(onCancel).toHaveBeenCalled()
  })

  it("maps a drawn rectangle through the letterboxed frame to page pixels, and shows a refusal", () => {
    const onAdd = vi.fn((_item: unknown, _image: unknown) => "The selected model does not accept images")
    render(<BrowserAnnotator frame={frame()} onAdd={onAdd} onCancel={vi.fn()} />)
    const surface = screen.getByRole("img", { name: /Frozen frame of Settings/ })
    // 800×600 fits 400×300 at half scale with no letterbox offset.
    fireEvent.pointerDown(surface, { clientX: 50, clientY: 40, pointerId: 1 })
    fireEvent.pointerMove(surface, { clientX: 150, clientY: 90, pointerId: 1 })
    fireEvent.pointerUp(surface, { clientX: 150, clientY: 90, pointerId: 1 })
    expect(screen.getByRole("status")).toHaveTextContent("Region 200×100 at 100,80")
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }))
    expect(onAdd.mock.calls[0]![0]).toMatchObject({ region: { x: 100, y: 80, width: 200, height: 100 } })
    expect(screen.getByRole("alert")).toHaveTextContent("does not accept images")
    fireEvent.click(screen.getByRole("button", { name: "Use whole page" }))
    expect(screen.getByRole("status")).toHaveTextContent("Whole page selected")
  })

  it("cancels on Escape", () => {
    const onCancel = vi.fn()
    render(<BrowserAnnotator frame={frame()} onAdd={vi.fn(() => null)} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Annotation note" }), { key: "Escape" })
    expect(onCancel).toHaveBeenCalled()
  })

  it("crops the region at the frame's own resolution, bounded in size", () => {
    cropRegion(frame(), { x: 100, y: 80, width: 200, height: 100 })
    expect(drawImage).toHaveBeenLastCalledWith(expect.any(HTMLCanvasElement), 200, 160, 400, 200, 0, 0, 400, 200)
    cropRegion(frame(), { x: 0, y: 0, width: 800, height: 600 }, 400)
    expect(drawImage).toHaveBeenLastCalledWith(expect.any(HTMLCanvasElement), 0, 0, 1600, 1200, 0, 0, 400, 300)
  })
})
