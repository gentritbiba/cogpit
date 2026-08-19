import { describe, it, expect } from "vitest"
import { planWorkLogTail, workLogTailLabel, MAX_LIVE_WORK_ENTRIES } from "@/lib/workLogTail"

describe("planWorkLogTail", () => {
  it("shows only the newest entry while work is in flight", () => {
    const plan = planWorkLogTail(["a", "b", "c", "d"], true)

    expect(plan.visible).toEqual(["d"])
    expect(plan.hidden).toBe(3)
  })

  it("shows everything once the group is not tailing", () => {
    const plan = planWorkLogTail(["a", "b", "c"], false)

    expect(plan.visible).toEqual(["a", "b", "c"])
    expect(plan.hidden).toBe(0)
  })

  it("hides nothing when the group already fits", () => {
    const plan = planWorkLogTail(["only"], true)

    expect(plan.visible).toEqual(["only"])
    expect(plan.hidden).toBe(0)
  })

  it("keeps chronological order in the tail", () => {
    // The newest entry is last, so the hidden ones are the older head.
    const plan = planWorkLogTail([1, 2, 3], true)

    expect(plan.visible).toEqual([3])
  })

  it("copes with an empty group", () => {
    expect(planWorkLogTail([], true)).toEqual({ visible: [], hidden: 0 })
  })

  it("keeps the live view down to a single entry", () => {
    expect(MAX_LIVE_WORK_ENTRIES).toBe(1)
  })
})

describe("workLogTailLabel", () => {
  it("counts the hidden steps", () => {
    expect(workLogTailLabel(7)).toBe("7 earlier steps")
  })

  it("stays singular for one", () => {
    expect(workLogTailLabel(1)).toBe("1 earlier step")
  })
})
