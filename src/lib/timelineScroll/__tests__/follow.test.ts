import { describe, it, expect } from "vitest"
import { followReducer, type FollowState } from "../follow"

const following: FollowState = { following: true, userInput: false }
const anchored: FollowState = { following: false, userInput: false }

describe("followReducer", () => {
  it.each([
    [{ type: "wheel", deltaY: -4 }],
    [{ type: "touchmove", dy: 6 }],
    [{ type: "key", key: "ArrowUp", shiftKey: false }],
    [{ type: "key", key: "PageUp", shiftKey: false }],
    [{ type: "key", key: "Home", shiftKey: false }],
    [{ type: "key", key: " ", shiftKey: true }],
    [{ type: "scrollbar" }],
    [{ type: "activate" }],
    [{ type: "navigate" }],
  ] as const)("releases following on upward intent %j", (event) => {
    expect(followReducer(following, event).following).toBe(false)
  })

  it.each([
    [{ type: "wheel", deltaY: 4 }],
    [{ type: "touchmove", dy: -6 }],
    [{ type: "key", key: "ArrowDown", shiftKey: false }],
    [{ type: "key", key: " ", shiftKey: false }],
  ] as const)("keeps following on downward input %j", (event) => {
    expect(followReducer(following, event)).toEqual({ following: true, userInput: true })
  })

  // Root cause 2: a scroll-up with no wheel, touch or key event (a scrollbar
  // drag, find, the banner) left following on during streaming.
  it("releases on a scroll-up the engine did not write, even while content grows", () => {
    const next = followReducer(following, { type: "scroll", previous: 900, current: 700, maxScrollTop: 1100, own: false, distanceToBottom: 400 })
    expect(next.following).toBe(false)
  })

  it("does not treat a clamp as intent", () => {
    const next = followReducer(following, { type: "scroll", previous: 900, current: 800, maxScrollTop: 800, own: false, distanceToBottom: 0 })
    expect(next.following).toBe(true)
  })

  it("ignores the engine's own writes", () => {
    const next = followReducer(following, { type: "scroll", previous: 900, current: 100, maxScrollTop: 1100, own: true, distanceToBottom: 1000 })
    expect(next.following).toBe(true)
  })

  it("resumes when user input brings the bottom within 4px", () => {
    const scrolling = followReducer(anchored, { type: "wheel", deltaY: 30 })
    expect(followReducer(scrolling, { type: "scroll", previous: 790, current: 797, maxScrollTop: 800, own: false, distanceToBottom: 3 }).following).toBe(true)
  })

  it("does not resume when the content, not the reader, reaches the bottom", () => {
    expect(followReducer(anchored, { type: "scroll", previous: 900, current: 800, maxScrollTop: 800, own: false, distanceToBottom: 0 }).following).toBe(false)
  })

  it("resumes on End, the button or sending", () => {
    expect(followReducer(anchored, { type: "key", key: "End", shiftKey: false }).following).toBe(true)
    expect(followReducer(anchored, { type: "resume" }).following).toBe(true)
  })

  // Review finding 2: PageDown or End with focus on the body sends no key event to the timeline.
  it("resumes when a scroll down it did not write reaches the bottom, with no input seen", () => {
    expect(followReducer(anchored, { type: "scroll", previous: 700, current: 800, maxScrollTop: 800, own: false, distanceToBottom: 0 }).following).toBe(true)
    expect(followReducer(anchored, { type: "scroll", previous: 600, current: 700, maxScrollTop: 800, own: false, distanceToBottom: 100 }).following).toBe(false)
  })

  it("forgets user input at idle", () => {
    expect(followReducer({ following: false, userInput: true }, { type: "idle", distanceToBottom: 500, anchored: false }).userInput).toBe(false)
  })

  // Review finding 1: a release with no scroll (a wheel or a swipe at the bottom) must not stick.
  it("resumes at idle when the reader rests at the bottom and nothing is held there", () => {
    expect(followReducer(anchored, { type: "idle", distanceToBottom: 2, anchored: false }).following).toBe(true)
    expect(followReducer(anchored, { type: "idle", distanceToBottom: 2, anchored: true }).following).toBe(false)
    expect(followReducer(anchored, { type: "idle", distanceToBottom: 40, anchored: false }).following).toBe(false)
  })

  it("returns the same state when nothing changes", () => {
    expect(followReducer(anchored, { type: "idle", distanceToBottom: 500, anchored: false })).toBe(anchored)
  })
})
