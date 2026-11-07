import { isClamp } from "./slack"

/** Whether the view sticks to the bottom, and whether the reader is scrolling by hand right now. */
export interface FollowState {
  following: boolean
  userInput: boolean
}

export type FollowEvent =
  | { type: "wheel"; deltaY: number }
  /** Finger movement since the last touch event; positive is downward, which scrolls up. */
  | { type: "touchmove"; dy: number }
  | { type: "key"; key: string; shiftKey: boolean }
  /** A pointer pressed on the scroller itself, which is its scrollbar. */
  | { type: "scrollbar" }
  /** A click or key activation inside the timeline. */
  | { type: "activate" }
  | { type: "navigate" }
  | {
      type: "scroll"
      previous: number
      current: number
      maxScrollTop: number
      /** The engine wrote this position itself. */
      own: boolean
      distanceToBottom: number
    }
  /** The jump-to-bottom button, End, or sending a message. */
  | { type: "resume" }
  | { type: "idle" }

/** How close to the bottom a reader's own scroll must land to resume following. */
export const RESUME_DISTANCE = 4

const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"])
const DOWN_KEYS = new Set(["ArrowDown", "PageDown", " "])

function next(state: FollowState, following: boolean, userInput: boolean): FollowState {
  return state.following === following && state.userInput === userInput ? state : { following, userInput }
}

export function followReducer(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case "wheel":
      return next(state, event.deltaY < 0 ? false : state.following, true)
    case "touchmove":
      return next(state, event.dy > 0 ? false : state.following, true)
    case "key":
      if (event.key === "End") return next(state, true, true)
      if (UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) return next(state, false, true)
      return DOWN_KEYS.has(event.key) ? next(state, state.following, true) : state
    case "scrollbar":
      return next(state, false, true)
    case "activate":
    case "navigate":
      return next(state, false, state.userInput)
    case "scroll": {
      if (event.own) return state
      const up = event.current < event.previous - 0.5
      if (up && !isClamp(event)) return next(state, false, state.userInput)
      if (state.userInput && event.distanceToBottom <= RESUME_DISTANCE) return next(state, true, true)
      return state
    }
    case "resume":
      return next(state, true, state.userInput)
    case "idle":
      return next(state, state.following, false)
  }
}
