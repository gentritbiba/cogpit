import { describe, expect, it } from "vitest"
import { releaseDirection } from "../motion"
import { WheelSwipe, type WheelInput } from "../wheelSwipe"
import { trackpadRecordings } from "./fixtures/trackpadRecordings"

type Row = [time: number, deltaX: number, deltaY: number]
type Event = Row | [time: number, deltaX: number, deltaY: number, momentum: boolean]

const WIDTH = 1280

/** Play wheel events through a WheelSwipe on a virtual clock; report where each release lands. */
function play(events: Event[]) {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const starts: number[] = []
  const releases: { at: number; offset: number; direction: number }[] = []
  const swipe = new WheelSwipe(
    {
      accepts: () => true,
      start: () => starts.push(now),
      move: () => {},
      release: (offset, velocity, projected) =>
        releases.push({ at: now, offset, direction: releaseDirection(offset, velocity, WIDTH, { previous: true, next: true }, projected) }),
    },
    {
      set: (run, ms) => {
        timers.set(++id, { at: now + ms, run })
        return id
      },
      clear: (handle) => timers.delete(handle as number),
    },
  )
  const runUntil = (time: number) => {
    for (;;) {
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!due || due[1].at > time) break
      timers.delete(due[0])
      now = due[1].at
      due[1].run()
    }
    now = time
  }
  for (const [time, deltaX, deltaY, momentum] of events) {
    runUntil(time)
    const input: WheelInput = { x: -deltaX, y: -deltaY, time, target: null, momentum }
    swipe.wheel(input)
  }
  runUntil(now + 1000)
  return { starts, releases, decisive: releases.filter((release) => release.direction !== 0).map((release) => release.direction) }
}

/** What a busy page in Chrome delivers: `count` pairs of events from `from` on merged, each at its later time. */
function coalesce(rows: Row[], from: number, count = 6): Row[] {
  const out = rows.slice(0, from)
  let i = from
  for (let k = 0; k < count && i + 1 < rows.length; k++, i += 2) out.push([rows[i + 1][0], rows[i][1] + rows[i + 1][1], rows[i][2] + rows[i + 1][2]])
  return [...out, ...rows.slice(i)]
}

const after = (rows: Row[], start: number): Row[] => rows.map(([time, x, y]) => [start + time - rows[0][0], x, y])

describe("WheelSwipe on recorded trackpad gestures", () => {
  // Fingers moving right (negative deltaX) bring in the machine on the left: direction -1.
  const expected: Record<string, number[]> = {
    "swipe-left": [1],
    "swipe-left-fast": [1],
    "swipe-right": [-1],
    "swipe-right-fast": [-1],
    "double-swipe-right": [-1, -1],
    "slow-drag-right": [-1],
    "swipe-up": [],
    "swipe-down-fast": [],
  }

  for (const [name, directions] of Object.entries(expected)) {
    it(`reads ${name} as ${directions.length || "no"} swipe${directions.length === 1 ? "" : "s"}, however Chrome batches it`, () => {
      const rows = trackpadRecordings[name]
      expect(play(rows).decisive).toEqual(directions)
      for (const from of [10, 20, 30]) expect(play(coalesce(rows, from)).decisive).toEqual(directions)
    })
  }

  it("never starts swiping on a vertical scroll", () => {
    expect(play(trackpadRecordings["swipe-up"]).starts).toEqual([])
    expect(play(trackpadRecordings["swipe-down-fast"]).starts).toEqual([])
  })

  it("lets a sideways swipe cut a vertical scroll's momentum short", () => {
    const up = trackpadRecordings["swipe-up"]
    const rows = [...up, ...after(trackpadRecordings["swipe-left"], up[up.length - 1][0] + 39)]
    expect(play(rows).decisive).toEqual([1])
  })

  it("keeps the first, merged frames of a flick thrown a second after the last swipe", () => {
    const first = trackpadRecordings["swipe-right"]
    const end = first[first.length - 1][0]
    const flick: Row[] = [[end + 1000, -50, 0]]
    for (const [i, delta] of [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].entries()) flick.push([end + 1016 + i * 16, -delta, 0])
    const { starts, releases } = play([...first, ...flick])
    expect(starts).toHaveLength(2)
    expect(releases[1].offset).toBeGreaterThanOrEqual(50 + 12 + 11 + 10)
  })

  it("gives a big event after a long pause in momentum to the fingers that follow it", () => {
    const fingers = Array.from({ length: 10 }, (_, i): Row => [i * 8, 24, 0])
    const momentum = Array.from({ length: 6 }, (_, i): Row => [80 + i * 8, Math.round(24 * 0.92 ** (i + 1)), 0])
    const pause: Row = [120 + 340, 60, 0]
    const more = [20, 24, 28, 32, 36].map((delta, i): Row => [468 + i * 8, delta, 0])
    const { starts, releases } = play([...fingers, ...momentum, pause, ...more])
    expect(starts).toHaveLength(2)
    expect(releases[1].offset).toBe(-(60 + 28 + 32 + 36))
  })
})

describe("WheelSwipe with the browser's momentum flag", () => {
  const steady = (from: number, count: number, delta: number, momentum: boolean): Event[] =>
    Array.from({ length: count }, (_, i) => [from + i * 8, delta, 0, momentum])

  it("lets go on the first momentum event and ignores the rest", () => {
    const { starts, releases } = play([...steady(0, 10, 24, false), ...steady(80, 40, 20, true)])
    expect(starts).toEqual([0])
    expect(releases).toHaveLength(1)
    expect(releases[0].at).toBe(80)
  })

  it("keeps a swipe while the browser says the fingers are on, however it slows", () => {
    const slowing: Event[] = [20, 19, 18, 17, 16].map((delta, i) => [i * 16, delta, 0, false])
    const { releases } = play([...slowing, ...steady(80, 40, 10, false)])
    expect(releases).toHaveLength(1)
    expect(releases[0].offset).toBe(-490)
  })

  it("starts the next swipe on the first finger event after momentum", () => {
    const { starts } = play([...steady(0, 10, 24, false), ...steady(80, 6, 20, true), ...steady(128, 6, 20, false)])
    expect(starts).toEqual([0, 128])
  })

  it("lets a sideways swipe interrupt a vertical scroll's momentum at once", () => {
    const vertical: Event[] = [
      ...Array.from({ length: 8 }, (_, i): Event => [i * 8, 0, 30, false]),
      ...Array.from({ length: 10 }, (_, i): Event => [64 + i * 8, 0, 28 - i, true]),
    ]
    const { starts } = play([...vertical, ...steady(150, 10, 24, false)])
    expect(starts).toHaveLength(1)
  })
})
