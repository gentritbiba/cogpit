import { describe, it, expect } from "vitest"
import { absorb, isClamp, normalizeTop, slackForTarget, trimBottomSlack } from "../slack"

describe("absorb", () => {
  it("takes a shift above the anchor out of the top slack without a scroll write", () => {
    expect(absorb({ topPad: 800, contentShift: 120, scrollTop: 2000 })).toEqual({ topPad: 680, scrollTop: 2000 })
  })

  it("grows the top slack when content above the anchor shrinks", () => {
    expect(absorb({ topPad: 0, contentShift: -50, scrollTop: 10 })).toEqual({ topPad: 50, scrollTop: 10 })
  })

  it("scrolls only by what the slack cannot hold", () => {
    expect(absorb({ topPad: 30, contentShift: 100, scrollTop: 500 })).toEqual({ topPad: 0, scrollTop: 570 })
  })

  // Root cause 1 (virtua compensated a row starting above the viewport only
  // while scrolling down): the engine keeps the anchor whatever the direction.
  it("keeps the anchor fixed for growth inside a visible row that starts above the viewport", () => {
    const anchorBefore = 1200 // content offset of a block inside the row
    const grownAbove = 340
    const { topPad, scrollTop } = absorb({ topPad: 1000, contentShift: grownAbove, scrollTop: 900 })
    const anchorAfter = anchorBefore + grownAbove - (1000 - topPad)
    expect(anchorAfter - scrollTop).toBe(anchorBefore - 900)
  })
})

describe("slackForTarget", () => {
  it("adds bottom slack so a shrink below the viewport cannot clamp the reader", () => {
    expect(slackForTarget({ target: 1500, scrollHeight: 1800, clientHeight: 500, bottomSlack: 0 })).toBe(200)
  })
  it("leaves slack alone when the target fits", () => {
    expect(slackForTarget({ target: 1000, scrollHeight: 1800, clientHeight: 500, bottomSlack: 40 })).toBe(40)
  })
})

describe("isClamp", () => {
  it("is a decrease that leaves the view at the bottom", () => {
    expect(isClamp({ previous: 900, current: 800, maxScrollTop: 800 })).toBe(true)
  })
  it("is not a decrease that leaves room below", () => {
    expect(isClamp({ previous: 900, current: 700, maxScrollTop: 800 })).toBe(false)
  })
  it("is not an increase", () => {
    expect(isClamp({ previous: 700, current: 800, maxScrollTop: 800 })).toBe(false)
  })
})

describe("normalizeTop", () => {
  it("moves the top slack to its target with one matching scroll write", () => {
    expect(normalizeTop({ topPad: 100, target: 400, scrollTop: 1000 })).toEqual({ topPad: 400, scrollTop: 1300 })
    expect(normalizeTop({ topPad: 400, target: 100, scrollTop: 1000 })).toEqual({ topPad: 100, scrollTop: 700 })
  })
  it("collapses a pad the reader can see instead of leaving it blank", () => {
    expect(normalizeTop({ topPad: 400, target: 100, scrollTop: 120 })).toEqual({ topPad: 100, scrollTop: 0 })
  })
})

describe("trimBottomSlack", () => {
  it("drops the slack below the viewport", () => {
    expect(trimBottomSlack({ bottomSlack: 300, scrollHeight: 3000, scrollTop: 2000, clientHeight: 500 })).toBe(0)
  })
  it("keeps the slack the reader is looking at", () => {
    expect(trimBottomSlack({ bottomSlack: 300, scrollHeight: 3000, scrollTop: 2400, clientHeight: 500 })).toBe(200)
  })
})
