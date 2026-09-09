import { describe, it, expect } from "vitest"
import { getMemberColorClass } from "../team-types"

describe("getMemberColorClass", () => {
  it.each<[string | undefined, string]>([
    ["blue", "bg-blue-500"],
    ["green", "bg-green-500"],
    ["yellow", "bg-yellow-500"],
    ["purple", "bg-purple-500"],
    ["orange", "bg-orange-500"],
    [undefined, "bg-zinc-400"],
    ["red", "bg-zinc-400"],
  ])("maps %s to %s", (color, expected) => {
    expect(getMemberColorClass(color)).toBe(expected)
  })
})
