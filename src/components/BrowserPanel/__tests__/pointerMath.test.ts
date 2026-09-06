import { describe, expect, it } from "vitest"
import {
  cdpButton,
  cdpModifiers,
  fitRect,
  toDevicePoint,
  type FitRect,
} from "@/components/BrowserPanel/pointerMath"

const NO_MODIFIERS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

describe("fitRect", () => {
  it("fills the container when the aspect ratios match", () => {
    expect(fitRect({ width: 800, height: 600 }, { width: 800, height: 600 }))
      .toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 })
  })

  it("centres horizontally when the container is wider", () => {
    expect(fitRect({ width: 1000, height: 600 }, { width: 800, height: 600 }))
      .toEqual({ x: 100, y: 0, width: 800, height: 600, scale: 1 })
  })

  it("centres vertically when the container is taller", () => {
    expect(fitRect({ width: 800, height: 1000 }, { width: 800, height: 600 }))
      .toEqual({ x: 0, y: 200, width: 800, height: 600, scale: 1 })
  })

  it("scales down to the width when the container is narrow", () => {
    expect(fitRect({ width: 400, height: 600 }, { width: 800, height: 600 }))
      .toEqual({ x: 0, y: 150, width: 400, height: 300, scale: 0.5 })
  })

  it("scales down to the height when the container is short", () => {
    expect(fitRect({ width: 800, height: 300 }, { width: 800, height: 600 }))
      .toEqual({ x: 200, y: 0, width: 400, height: 300, scale: 0.5 })
  })

  it("never upscales past 1x, it centres instead", () => {
    expect(fitRect({ width: 1600, height: 1200 }, { width: 800, height: 600 }))
      .toEqual({ x: 400, y: 300, width: 800, height: 600, scale: 1 })
  })

  it("rounds the offsets so a 1:1 image lands on whole pixels", () => {
    const fit = fitRect({ width: 801, height: 601 }, { width: 800, height: 600 })
    expect(fit).toEqual({ x: 1, y: 1, width: 800, height: 600, scale: 1 })
  })

  it("collapses to nothing for a zero-sized container or device", () => {
    const empty = { x: 0, y: 0, width: 0, height: 0, scale: 0 }
    expect(fitRect({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual(empty)
    expect(fitRect({ width: 800, height: 600 }, { width: 0, height: 600 })).toEqual(empty)
    expect(fitRect({ width: -10, height: 600 }, { width: 800, height: 600 })).toEqual(empty)
  })
})

describe("toDevicePoint", () => {
  const rect = { left: 50, top: 20, width: 800, height: 600 }
  const halfScale: FitRect = fitRect({ width: 800, height: 600 }, { width: 1600, height: 1200 })

  it("maps a point in the middle of the image to device pixels", () => {
    expect(toDevicePoint(450, 320, rect, halfScale)).toEqual({ x: 800, y: 600 })
  })

  it("includes both edges of the image", () => {
    expect(toDevicePoint(50, 20, rect, halfScale)).toEqual({ x: 0, y: 0 })
    expect(toDevicePoint(850, 620, rect, halfScale)).toEqual({ x: 1600, y: 1200 })
  })

  it("returns null just outside the image", () => {
    expect(toDevicePoint(49, 320, rect, halfScale)).toBeNull()
    expect(toDevicePoint(450, 19, rect, halfScale)).toBeNull()
    expect(toDevicePoint(851, 320, rect, halfScale)).toBeNull()
    expect(toDevicePoint(450, 621, rect, halfScale)).toBeNull()
  })

  it("clamps to the device rect instead of dropping the point when asked", () => {
    expect(toDevicePoint(49, 320, rect, halfScale, { clamp: true })).toEqual({ x: 0, y: 600 })
    expect(toDevicePoint(2000, 2000, rect, halfScale, { clamp: true })).toEqual({ x: 1600, y: 1200 })
  })

  it("treats the letterbox bars as outside the image", () => {
    const pillarboxed = fitRect({ width: 1000, height: 600 }, { width: 800, height: 600 })
    const bar = { left: 0, top: 0, width: 1000, height: 600 }
    expect(toDevicePoint(150, 10, bar, pillarboxed)).toEqual({ x: 50, y: 10 })
    expect(toDevicePoint(50, 10, bar, pillarboxed)).toBeNull()
    expect(toDevicePoint(50, 10, bar, pillarboxed, { clamp: true })).toEqual({ x: 0, y: 10 })
  })

  it("has no point to map when nothing is drawn", () => {
    const nothing = fitRect({ width: 0, height: 0 }, { width: 800, height: 600 })
    expect(toDevicePoint(10, 10, rect, nothing)).toBeNull()
    expect(toDevicePoint(10, 10, rect, nothing, { clamp: true })).toBeNull()
  })
})

describe("cdpModifiers", () => {
  it("uses CDP's bits, not the DOM's order", () => {
    expect(cdpModifiers(NO_MODIFIERS)).toBe(0)
    expect(cdpModifiers({ ...NO_MODIFIERS, altKey: true })).toBe(1)
    expect(cdpModifiers({ ...NO_MODIFIERS, ctrlKey: true })).toBe(2)
    expect(cdpModifiers({ ...NO_MODIFIERS, metaKey: true })).toBe(4)
    expect(cdpModifiers({ ...NO_MODIFIERS, shiftKey: true })).toBe(8)
  })

  it("adds the bits of every held modifier", () => {
    expect(cdpModifiers({ ...NO_MODIFIERS, ctrlKey: true, shiftKey: true })).toBe(10)
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15)
  })
})

describe("cdpButton", () => {
  it("names the three buttons a page can receive", () => {
    expect(cdpButton(0)).toBe("left")
    expect(cdpButton(1)).toBe("middle")
    expect(cdpButton(2)).toBe("right")
  })

  it("falls back to left for buttons the protocol has no name for", () => {
    expect(cdpButton(3)).toBe("left")
    expect(cdpButton(-1)).toBe("left")
  })
})
