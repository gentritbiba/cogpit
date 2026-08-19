import { describe, it, expect } from "vitest"
import { getMemberColorClass } from "../team-types"

describe("getMemberColorClass", () => {
  it("returns correct class for blue", () => {
    expect(getMemberColorClass("blue")).toBe("bg-blue-500")
  })

  it("returns correct class for green", () => {
    expect(getMemberColorClass("green")).toBe("bg-green-500")
  })

  it("returns correct class for yellow", () => {
    expect(getMemberColorClass("yellow")).toBe("bg-yellow-500")
  })

  it("returns correct class for purple", () => {
    expect(getMemberColorClass("purple")).toBe("bg-purple-500")
  })

  it("returns correct class for orange", () => {
    expect(getMemberColorClass("orange")).toBe("bg-orange-500")
  })

  it("returns fallback for undefined color", () => {
    expect(getMemberColorClass(undefined)).toBe("bg-zinc-400")
  })

  it("returns fallback for unknown color", () => {
    expect(getMemberColorClass("red")).toBe("bg-zinc-400")
  })
})
