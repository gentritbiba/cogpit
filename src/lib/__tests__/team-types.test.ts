import { describe, it, expect } from "vitest"
import {
  getMemberColorClass,
  getMemberTextColorClass,
  getMemberBorderClass,
} from "../team-types"

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

describe("getMemberTextColorClass", () => {
  it("returns correct class for blue", () => {
    expect(getMemberTextColorClass("blue")).toBe("text-blue-400")
  })

  it("returns correct class for green", () => {
    expect(getMemberTextColorClass("green")).toBe("text-green-400")
  })

  it("returns correct class for yellow", () => {
    expect(getMemberTextColorClass("yellow")).toBe("text-yellow-400")
  })

  it("returns correct class for purple", () => {
    expect(getMemberTextColorClass("purple")).toBe("text-purple-400")
  })

  it("returns correct class for orange", () => {
    expect(getMemberTextColorClass("orange")).toBe("text-orange-400")
  })

  it("returns fallback for undefined color", () => {
    expect(getMemberTextColorClass(undefined)).toBe("text-zinc-400")
  })

  it("returns fallback for unknown color", () => {
    expect(getMemberTextColorClass("pink")).toBe("text-zinc-400")
  })
})

describe("getMemberBorderClass", () => {
  it("returns correct class for blue", () => {
    expect(getMemberBorderClass("blue")).toBe("border-blue-500/30")
  })

  it("returns correct class for green", () => {
    expect(getMemberBorderClass("green")).toBe("border-green-500/30")
  })

  it("returns correct class for yellow", () => {
    expect(getMemberBorderClass("yellow")).toBe("border-yellow-500/30")
  })

  it("returns correct class for purple", () => {
    expect(getMemberBorderClass("purple")).toBe("border-purple-500/30")
  })

  it("returns correct class for orange", () => {
    expect(getMemberBorderClass("orange")).toBe("border-orange-500/30")
  })

  it("returns fallback for undefined color", () => {
    expect(getMemberBorderClass(undefined)).toBe("border-border")
  })

  it("returns fallback for unknown color", () => {
    expect(getMemberBorderClass("cyan")).toBe("border-border")
  })
})
